/**
 * medCloud lifecycle: idle → provisioning → booting → ready ⇄ degraded → stopped,
 * with `error` reachable from any boot step.
 *
 * - **start**: push the private serve kernel (fresh per-session bearer token),
 *   follow its live log for the bootstrap protocol lines, verify `/healthz`
 *   through the tunnel with the token, then serve. Boot failures go to the
 *   remediation planner (Groq or heuristic) which may only change allowlisted
 *   knobs; at most `maxRetries` re-pushes.
 * - **heartbeat** (every 3 min): authenticated `/healthz` through the tunnel —
 *   also the activity signal that keeps the remote idle watchdog from firing.
 *   Three consecutive misses → `degraded`; a kernel that has ended → `stopped`.
 * - **stop**: ask the router to shut down, then cancel the Kaggle session so
 *   GPU quota stops burning even if the tunnel is already gone.
 *
 * @module @deepseek-ai/dsh-medical-cloud/controller
 */

import type { KaggleClient, KernelStatus } from './kaggle.ts'
import { buildPrepareKernel, buildServeKernel, parseLogLine, type Knobs, type LogEvent, type PrepareSettings, type ServeSettings } from './kernels.ts'
import { TUNNEL_HEADERS, type Upstream } from './gateway.ts'
import { scrubLogTail, type BootFailure, type Remediation } from './remediation.ts'

export type CloudState = 'idle' | 'provisioning' | 'booting' | 'ready' | 'degraded' | 'stopped' | 'error'
export type PrepareState = 'unknown' | 'running' | 'done' | 'error'

export interface CloudSession {
  slug: string
  url?: string | undefined
  token: string
  startedAt: number
  mode?: string | undefined
  knobs: Knobs
}

export interface SessionStore {
  load(): Promise<CloudSession | undefined>
  save(session: CloudSession): Promise<void>
  clear(): Promise<void>
}

/** Live log source: yields lines as the kernel prints them. */
export interface LogFollower {
  follow(slug: string, signal: AbortSignal): AsyncIterable<string>
}

export interface ControllerDeps {
  kaggle: () => Promise<Pick<KaggleClient, 'username' | 'saveKernel' | 'status' | 'logs' | 'cancel'> & LogFollower>
  serveSettings: () => ServeSettings
  prepareSettings: () => PrepareSettings
  slugs: { serve: string; prepare: string }
  machineShape: string
  plan: (failure: BootFailure, knobs: Knobs) => Promise<Remediation>
  store: SessionStore
  token: () => string
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  pollMs?: number
  verifyAttempts?: number
  maxRetries?: number
  serveSource?: (settings: ServeSettings, token: string) => string
  prepareSource?: (settings: PrepareSettings) => string
}

export interface CloudSnapshot {
  state: CloudState
  stage?: string | undefined
  url?: string | undefined
  mode?: string | undefined
  startedAt?: number | undefined
  heartbeatFailures: number
  lastHeartbeat?: number | undefined
  lastError?: string | undefined
  prepare: PrepareState
  remediations: Remediation[]
  events: string[]
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
})

const ENDED: readonly KernelStatus[] = ['COMPLETE', 'ERROR', 'CANCEL_REQUESTED', 'CANCEL_ACKNOWLEDGED']

type Terminal =
  | { kind: 'ready'; url: string; mode?: string | undefined }
  | { kind: 'prepared' }
  | { kind: 'failed'; failure: BootFailure }

export class CloudController {
  state: CloudState = 'idle'
  stage: string | undefined
  session: CloudSession | undefined
  lastError: string | undefined
  heartbeatFailures = 0
  lastHeartbeat: number | undefined
  prepareState: PrepareState = 'unknown'
  readonly remediations: Remediation[] = []
  private readonly events: string[] = []
  private boot: AbortController | undefined
  private prep: AbortController | undefined
  /** Settles when the current background boot/prepare finishes (tests await it). */
  pending: Promise<void> = Promise.resolve()
  preparing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ControllerDeps) {}

  private get now(): number { return (this.deps.now ?? Date.now)() }
  private get sleep(): (ms: number, signal: AbortSignal) => Promise<void> { return this.deps.sleep ?? defaultSleep }
  private get fetch(): typeof globalThis.fetch { return this.deps.fetch ?? globalThis.fetch }

  private record(message: string): void {
    this.events.push(`${new Date(this.now).toISOString().slice(11, 19)} ${message}`)
    if (this.events.length > 50) this.events.shift()
  }

  private set(state: CloudState, message?: string): void {
    if (this.state !== state) this.record(`${this.state} → ${state}${message ? `: ${message}` : ''}`)
    else if (message) this.record(message)
    this.state = state
  }

  upstream(): Upstream | undefined {
    return (this.state === 'ready' || this.state === 'degraded') && this.session?.url ? { url: this.session.url, token: this.session.token } : undefined
  }

  snapshot(): CloudSnapshot {
    return {
      state: this.state,
      stage: this.stage,
      url: this.session?.url,
      mode: this.session?.mode,
      startedAt: this.session?.startedAt,
      heartbeatFailures: this.heartbeatFailures,
      lastHeartbeat: this.lastHeartbeat,
      lastError: this.lastError,
      prepare: this.prepareState,
      remediations: [...this.remediations],
      events: [...this.events],
    }
  }

  get busy(): boolean {
    return this.state === 'provisioning' || this.state === 'booting'
  }

  /** Begin provisioning in the background; returns immediately. */
  start(): string {
    if (this.busy) return `Already starting (${this.stage ?? this.state}).`
    if (this.state === 'ready' || this.state === 'degraded') return `Already running at ${this.session?.url ?? '?'}.`
    this.boot?.abort()
    const controller = new AbortController()
    this.boot = controller
    this.lastError = undefined
    this.remediations.length = 0
    this.set('provisioning', 'pushing serve kernel')
    this.pending = this.runBoot(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return
      this.lastError = (error as Error).message
      this.set('error', this.lastError)
    })
    return 'Provisioning the Kaggle GPU node (typically 6–15 minutes). Check progress with /cloud status.'
  }

  private async runBoot(signal: AbortSignal): Promise<void> {
    const kaggle = await this.deps.kaggle()
    let knobs: Knobs = { ...pickKnobs(this.deps.serveSettings()) }
    const maxRetries = this.deps.maxRetries ?? 2
    for (let attempt = 0; ; attempt++) {
      const token = this.deps.token()
      const settings = { ...this.deps.serveSettings(), ...knobs }
      const source = (this.deps.serveSource ?? buildServeKernel)(settings, token)
      this.session = { slug: this.deps.slugs.serve, token, startedAt: this.now, knobs }
      this.stage = 'queued'
      await kaggle.saveKernel({
        slug: this.deps.slugs.serve,
        title: 'medharness serve',
        text: source,
        kernelDataSources: [`${kaggle.username}/${this.deps.slugs.prepare}`],
        machineShape: this.deps.machineShape,
        sessionTimeoutSeconds: settings.maxSessionSeconds + 600,
      }, signal)
      this.set('provisioning', attempt ? `retry ${attempt}/${maxRetries}` : 'kernel queued')
      const result = await this.follow(this.deps.slugs.serve, signal, settings.bootTimeoutSeconds * 1000 + 30 * 60_000, token)
      let failure: BootFailure | undefined
      if (result.kind === 'ready') {
        this.session = { ...this.session, url: result.url, mode: result.mode }
        this.stage = 'verify'
        if (await this.verify(signal)) {
          this.heartbeatFailures = 0
          this.lastHeartbeat = this.now
          await this.deps.store.save(this.session)
          this.set('ready', `${result.url} (${result.mode ?? 'dual'} GPU)`)
          this.stage = 'ready'
          return
        }
        failure = { stage: 'verify', reason: 'tunnel URL announced but /healthz never answered through it', logTail: [] }
      } else if (result.kind === 'failed') {
        failure = result.failure
      } else {
        failure = { stage: 'protocol', reason: 'unexpected prepare marker in serve kernel', logTail: [] }
      }
      await kaggle.cancel(this.deps.slugs.serve).catch(() => undefined)
      if (attempt >= maxRetries) throw new Error(`boot failed at ${failure.stage}: ${failure.reason}`)
      const plan = await this.deps.plan(failure, knobs)
      this.remediations.push(plan)
      this.record(`remediation (${plan.source}): ${plan.action} — ${plan.reason}${Object.keys(plan.changes).length ? ` ${JSON.stringify(plan.changes)}` : ''}`)
      if (plan.action === 'abort') throw new Error(`boot failed at ${failure.stage}: ${failure.reason}`)
      knobs = { ...knobs, ...plan.changes }
    }
  }

  /** Follow a kernel run until a terminal protocol event, the kernel ending, or timeout. */
  private async follow(slug: string, signal: AbortSignal, timeoutMs: number, token?: string): Promise<Terminal> {
    const kaggle = await this.deps.kaggle()
    const tail: string[] = []
    let terminal: Terminal | undefined
    const local = new AbortController()
    const linked = AbortSignal.any([signal, local.signal])
    const onLine = (line: string): void => {
      tail.push(line)
      if (tail.length > 200) tail.shift()
      const event: LogEvent | undefined = parseLogLine(line)
      if (!event || terminal) return
      if (event.kind === 'stage') {
        this.stage = event.name
        if (this.state === 'provisioning' || this.state === 'booting') this.set('booting', `stage ${event.name}`)
      } else if (event.kind === 'ready') terminal = { kind: 'ready', url: event.url, mode: event.mode }
      else if (event.kind === 'prepared') terminal = { kind: 'prepared' }
      else if (event.kind === 'failed') terminal = { kind: 'failed', failure: { stage: event.stage, reason: event.reason, logTail: [] } }
    }
    // Background live-log reader; reconnects until done.
    const reader = (async () => {
      while (!linked.aborted && !terminal) {
        try {
          for await (const line of kaggle.follow(slug, linked)) {
            onLine(line)
            if (terminal) break
          }
        } catch { /* stream dropped; reconnect after a pause */ }
        if (!terminal) await this.sleep(this.deps.pollMs ?? 15_000, linked).catch(() => undefined)
      }
    })()
    const deadline = this.now + timeoutMs
    try {
      while (!terminal) {
        if (this.now > deadline) {
          terminal = { kind: 'failed', failure: { stage: this.stage ?? 'boot', reason: `timed out after ${Math.round(timeoutMs / 60_000)} min`, logTail: [] } }
          break
        }
        const { status, failureMessage } = await kaggle.status(slug, signal).catch(() => ({ status: 'UNKNOWN' as KernelStatus, failureMessage: undefined }))
        if (status === 'RUNNING' && this.state === 'provisioning') this.set('booting', 'kernel running')
        if (ENDED.includes(status)) {
          // The run is over: the completed log is authoritative.
          for (const line of await kaggle.logs(slug, signal).catch(() => [])) onLine(line)
          terminal ??= { kind: 'failed', failure: { stage: this.stage ?? 'kernel', reason: failureMessage ?? `kernel ended (${status})`, logTail: [] } }
          break
        }
        if (terminal) break
        await this.sleep(this.deps.pollMs ?? 15_000, signal)
      }
    } finally {
      local.abort()
      await reader.catch(() => undefined)
    }
    if (terminal.kind === 'failed') terminal.failure.logTail = scrubLogTail(tail, token)
    return terminal
  }

  private async healthz(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const session = this.session
    if (!session?.url) return { ok: false, detail: 'no tunnel URL' }
    try {
      const res = await this.fetch(`${session.url}/healthz`, {
        headers: { ...TUNNEL_HEADERS, authorization: `Bearer ${session.token}`, accept: 'application/json' },
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      })
      const type = res.headers.get('content-type') ?? ''
      if (/text\/html/i.test(type)) { await res.body?.cancel(); return { ok: false, detail: `interstitial page (HTTP ${res.status})` } }
      const body = await res.json().catch(() => ({})) as { ok?: boolean }
      return { ok: res.status === 200 && body.ok === true, detail: `HTTP ${res.status}` }
    } catch (error) {
      return { ok: false, detail: (error as Error).message }
    }
  }

  private async verify(signal: AbortSignal): Promise<boolean> {
    // Fresh quick tunnels can take a few seconds to propagate in DNS.
    for (let i = 0; i < (this.deps.verifyAttempts ?? 12); i++) {
      if ((await this.healthz(signal)).ok) return true
      await this.sleep(5_000, signal)
    }
    return false
  }

  /** One heartbeat; schedule every 180 s while ready/degraded. */
  async heartbeat(signal?: AbortSignal): Promise<CloudSnapshot> {
    if (this.state !== 'ready' && this.state !== 'degraded') return this.snapshot()
    const { ok, detail } = await this.healthz(signal)
    this.lastHeartbeat = this.now
    if (ok) {
      this.heartbeatFailures = 0
      if (this.state === 'degraded') this.set('ready', 'heartbeat recovered')
      return this.snapshot()
    }
    this.heartbeatFailures++
    this.record(`heartbeat failed (${this.heartbeatFailures}): ${detail}`)
    if (this.heartbeatFailures >= 3) {
      const status = await (await this.deps.kaggle()).status(this.deps.slugs.serve, signal).then(s => s.status).catch(() => 'UNKNOWN' as KernelStatus)
      if (ENDED.includes(status)) {
        await this.deps.store.clear()
        this.lastError = `remote session ended (${status}) — idle timeout, 12 h limit, or quota`
        this.set('stopped', this.lastError)
      } else if (this.state !== 'degraded') {
        this.set('degraded', `3 missed heartbeats (${detail})`)
      }
    }
    return this.snapshot()
  }

  /** Re-attach to a session persisted by a previous app run, if it is still alive. */
  async resume(): Promise<boolean> {
    const saved = await this.deps.store.load()
    if (!saved?.url) return false
    this.session = saved
    this.state = 'ready'
    if ((await this.healthz()).ok) {
      this.record(`resumed ${saved.url}`)
      return true
    }
    this.session = undefined
    this.state = 'idle'
    await this.deps.store.clear()
    return false
  }

  /** Attach to a node started some other way (e.g. manually from the Kaggle UI). */
  async attach(url: string, token: string): Promise<boolean> {
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/.test(url)) throw new Error('expected a https://<name>.trycloudflare.com URL')
    this.boot?.abort()
    this.session = { slug: this.deps.slugs.serve, url: url.replace(/\/$/, ''), token, startedAt: this.now, knobs: pickKnobs(this.deps.serveSettings()) }
    this.state = 'ready'
    if ((await this.healthz()).ok) {
      this.heartbeatFailures = 0
      await this.deps.store.save(this.session)
      this.record(`attached ${this.session.url}`)
      return true
    }
    this.session = undefined
    this.state = 'idle'
    return false
  }

  async stop(): Promise<string> {
    this.boot?.abort()
    const session = this.session
    let remote = 'no remote session'
    if (session?.url) {
      remote = await this.fetch(`${session.url}/admin/shutdown`, {
        method: 'POST',
        headers: { ...TUNNEL_HEADERS, authorization: `Bearer ${session.token}` },
        signal: AbortSignal.timeout(10_000),
      }).then(r => (r.ok ? 'router shut down' : `router answered HTTP ${r.status}`), () => 'router unreachable')
    }
    const cancelled = await (await this.deps.kaggle()).cancel(this.deps.slugs.serve).then(() => 'Kaggle session cancelled', (e: Error) => `Kaggle cancel: ${e.message}`)
    await this.deps.store.clear()
    this.session = undefined
    this.stage = undefined
    this.set('stopped', 'stopped by user')
    return `Stopped (${remote}; ${cancelled}).`
  }

  /** Launch the one-time prepare kernel in the background. */
  prepare(): string {
    if (this.prepareState === 'running') return 'Preparation is already running.'
    this.prep?.abort()
    const controller = new AbortController()
    this.prep = controller
    this.prepareState = 'running'
    this.record('prepare: pushing kernel')
    this.preparing = (async () => {
      const kaggle = await this.deps.kaggle()
      await kaggle.saveKernel({
        slug: this.deps.slugs.prepare,
        title: 'medharness prepare',
        text: (this.deps.prepareSource ?? buildPrepareKernel)(this.deps.prepareSettings()),
        machineShape: this.deps.machineShape,
        sessionTimeoutSeconds: 12 * 3600,
      }, controller.signal)
      const result = await this.follow(this.deps.slugs.prepare, controller.signal, 12 * 3600_000)
      if (result.kind === 'prepared') {
        this.prepareState = 'done'
        this.record('prepare: artifacts ready — /cloud start')
      } else {
        this.prepareState = 'error'
        this.lastError = result.kind === 'failed' ? `prepare failed at ${result.failure.stage}: ${result.failure.reason}` : 'prepare: unexpected result'
        this.record(this.lastError)
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return
      this.prepareState = 'error'
      this.lastError = `prepare: ${(error as Error).message}`
      this.record(this.lastError)
    })
    return 'One-time preparation started on Kaggle (quantize II-Medical-8B to W4A16, build llama.cpp for T4, cache MedGemma). It takes about 1.5–3 hours; you can keep working. Check with /cloud status.'
  }

  dispose(): void {
    this.boot?.abort()
    this.prep?.abort()
  }
}

export function pickKnobs(s: Knobs): Knobs {
  return { mode: s.mode, maxModelLen: s.maxModelLen, gpuMemUtil: s.gpuMemUtil, maxNumSeqs: s.maxNumSeqs, visionCtx: s.visionCtx, enforceEager: s.enforceEager }
}
