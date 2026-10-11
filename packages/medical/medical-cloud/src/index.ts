/**
 * medCloud — zero-setup remote GPU for the medical harness.
 *
 * The clinician types `/cloud setup <kaggle-username> <kaggle-api-token>` once,
 * `/cloud prepare` once, then `/cloud start` per working session. Everything
 * else — pushing private Kaggle kernels, booting vLLM + llama.cpp on 2× T4,
 * the Cloudflare quick tunnel, per-session bearer tokens, heartbeats, idle
 * shutdown, boot remediation — is automatic. No Docker, no terminal.
 *
 * The harness's `llm-pi-ai` provider `medcloud` talks to the loopback
 * {@link Gateway} (`http://127.0.0.1:47800/v1`, key `MEDCLOUD_GATEWAY_KEY`),
 * which forwards to the tunnel with the session token. Groq (optional,
 * `GROQ_API_KEY`) only ever plans boot remediations from boot logs.
 *
 * @module @deepseek-ai/dsh-medical-cloud
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands'

import { CloudController, type CloudSession, type CloudSnapshot, type SessionStore } from './controller.ts'
import { Gateway } from './gateway.ts'
import { KaggleClient } from './kaggle.ts'
import type { Knobs, PrepareSettings, ServeSettings } from './kernels.ts'
import { groqPlan, heuristicPlan } from './remediation.ts'

export * from './controller.ts'
export * from './gateway.ts'
export * from './kaggle.ts'
export * from './kernels.ts'
export * from './remediation.ts'

export const name = 'medical-cloud'
export const inject = ['credentials']

export const REFS = {
  kaggleUsername: credentialRef('KAGGLE_USERNAME'),
  kaggleKey: credentialRef('KAGGLE_KEY'),
  groq: credentialRef('GROQ_API_KEY'),
  gateway: credentialRef('MEDCLOUD_GATEWAY_KEY'),
  session: credentialRef('MEDCLOUD_SESSION_TOKEN'),
} as const

export interface Config {
  kaggleUsername: string
  machineShape: string
  serveSlug: string
  prepareSlug: string
  reasonerHf: string
  reasonerName: string
  visionName: string
  visionGgufUrl: string
  visionMmprojUrl: string
  vllmVersion: string
  llamaCppRef: string
  cloudflaredVersion: string
  cloudflaredSha256: string
  mode: 'auto' | 'dual' | 'single'
  maxModelLen: number
  gpuMemUtil: number
  maxNumSeqs: number
  visionCtx: number
  enforceEager: boolean
  calibrationSamples: number
  idleTimeoutMinutes: number
  maxSessionHours: number
  bootTimeoutMinutes: number
  heartbeatSeconds: number
  gatewayPort: number
  remediation: boolean
  groqModel: string
  maxRetries: number
  sessionFile: string
  autoResume: boolean
}

export const Config: z<Config> = z.object({
  kaggleUsername: z.string().default('').description('Kaggle username (or store KAGGLE_USERNAME via /cloud setup).'),
  machineShape: z.string().default('NvidiaTeslaT4').description('Kaggle accelerator (NvidiaTeslaT4 = GPU T4 x2).'),
  serveSlug: z.string().default('medharness-serve'),
  prepareSlug: z.string().default('medharness-prepare'),
  reasonerHf: z.string().default('Intelligent-Internet/II-Medical-8B').description('Hugging Face id of the reasoning model quantized by /cloud prepare.'),
  reasonerName: z.string().default('ii-medical-8b').description('Served model name of the reasoner (must match the llm-pi-ai model id).'),
  visionName: z.string().default('medgemma-1.5-4b').description('Served model name of the vision/structuring model.'),
  visionGgufUrl: z.string().default('https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/medgemma-1.5-4b-it-Q8_0.gguf'),
  visionMmprojUrl: z.string().default('https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/mmproj-F16.gguf'),
  vllmVersion: z.string().default('0.31.0'),
  llamaCppRef: z.string().default('v0.6.0'),
  cloudflaredVersion: z.string().default('2026.10.0'),
  cloudflaredSha256: z.string().default('d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'),
  mode: z.union(['auto', 'dual', 'single'] as const).default('auto'),
  maxModelLen: z.number().default(16384),
  gpuMemUtil: z.number().default(0.92),
  maxNumSeqs: z.number().default(8),
  visionCtx: z.number().default(8192),
  enforceEager: z.boolean().default(false),
  calibrationSamples: z.number().default(256),
  idleTimeoutMinutes: z.number().default(20).description('Remote shuts itself down after this long without any request or heartbeat.'),
  maxSessionHours: z.number().default(11.5).description('Hard cap below Kaggle\'s 12 h session limit.'),
  bootTimeoutMinutes: z.number().default(40),
  heartbeatSeconds: z.number().default(180),
  gatewayPort: z.number().default(47800),
  remediation: z.boolean().default(true).description('Plan boot-failure retries (Groq when GROQ_API_KEY is set, otherwise deterministic heuristics).'),
  groqModel: z.string().default('openai/gpt-oss-120b'),
  maxRetries: z.number().default(2),
  sessionFile: z.string().default(join(homedir(), '.dsh', 'medical', 'cloud-session.json')),
  autoResume: z.boolean().default(true),
})

const DEFINITION_ID = brandString<CommandDefinitionId>('@deepseek-ai/dsh-medical-cloud')

export function serveSettings(config: Config): ServeSettings {
  return {
    reasonerName: config.reasonerName,
    visionName: config.visionName,
    vllmVersion: config.vllmVersion,
    cloudflaredVersion: config.cloudflaredVersion,
    cloudflaredSha256: config.cloudflaredSha256,
    visionGgufUrl: config.visionGgufUrl,
    visionMmprojUrl: config.visionMmprojUrl,
    mode: config.mode,
    maxModelLen: config.maxModelLen,
    gpuMemUtil: config.gpuMemUtil,
    maxNumSeqs: config.maxNumSeqs,
    visionCtx: config.visionCtx,
    enforceEager: config.enforceEager,
    idleTimeoutSeconds: Math.round(config.idleTimeoutMinutes * 60),
    maxSessionSeconds: Math.round(config.maxSessionHours * 3600),
    bootTimeoutSeconds: Math.round(config.bootTimeoutMinutes * 60),
  }
}

export function prepareSettings(config: Config): PrepareSettings {
  return {
    reasonerHf: config.reasonerHf,
    llamaCppRef: config.llamaCppRef,
    visionGgufUrl: config.visionGgufUrl,
    visionMmprojUrl: config.visionMmprojUrl,
    calibrationSamples: config.calibrationSamples,
  }
}

const newSecret = (): string => randomBytes(32).toString('base64url')

/** Resolve the loopback gateway key, generating and storing one on first run. Never touches process.env. */
export async function ensureGatewayKey(ctx: Context): Promise<string> {
  const existing = await ctx.credentials.resolve(REFS.gateway)
  if (existing) return existing.value
  const key = newSecret()
  await ctx.credentials.set(REFS.gateway, key)
  return key
}

/** Session metadata in a 0600 JSON file; the token prefers the credential store. */
export function fileSessionStore(ctx: Context, path: string): SessionStore {
  return {
    async load() {
      try {
        const saved = JSON.parse(await readFile(path, 'utf8')) as Omit<CloudSession, 'token'> & { token?: string }
        const token = saved.token ?? (await ctx.credentials.resolve(REFS.session))?.value
        return token ? { ...saved, token } : undefined
      } catch {
        return undefined
      }
    },
    async save(session) {
      let inline: string | undefined
      try { await ctx.credentials.set(REFS.session, session.token) } catch { inline = session.token }
      const { token: _token, ...rest } = session
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ ...rest, ...(inline ? { token: inline } : {}) }, null, 2), { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, path)
    },
    async clear() {
      await rm(path, { force: true })
      await ctx.credentials.unset(REFS.session).catch(() => undefined)
    },
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`
}

export function formatStatus(snap: CloudSnapshot, config: Config, now = Date.now()): string {
  const lines = [`medCloud: ${snap.state.toUpperCase()}${snap.stage && snap.state !== 'ready' ? ` (stage: ${snap.stage})` : ''}${snap.url ? ` — ${snap.url}` : ''}`]
  if (snap.state === 'ready' || snap.state === 'degraded') {
    lines.push(`Reasoner ${config.reasonerName} (vLLM · GPTQ W4A16/Marlin) · Vision ${config.visionName} (llama.cpp) · ${snap.mode ?? 'dual'} GPU`)
    if (snap.startedAt) lines.push(`Up ${ago(now - snap.startedAt)} of ${config.maxSessionHours} h · auto-shutdown after ${config.idleTimeoutMinutes} min idle`)
    lines.push(`Heartbeat: ${snap.lastHeartbeat ? `${ago(now - snap.lastHeartbeat)} ago` : 'pending'}${snap.heartbeatFailures ? ` · ${snap.heartbeatFailures} missed` : ' · OK'}`)
  }
  lines.push(`Preparation: ${snap.prepare === 'unknown' ? 'not run from this app (run /cloud prepare once if /cloud start reports missing artifacts)' : snap.prepare}`)
  if (snap.lastError) lines.push(`Last error: ${snap.lastError}`)
  for (const r of snap.remediations) lines.push(`Remediation (${r.source}): ${r.action} — ${r.reason}`)
  if (snap.state === 'idle' || snap.state === 'stopped' || snap.state === 'error') lines.push('Start with /cloud start.')
  return lines.join('\n')
}

export const HELP = [
  '/cloud setup <kaggle-username> <kaggle-api-token> — store Kaggle credentials (kaggle.com → Settings → API → Create New Token). Account must be phone-verified for GPU + internet.',
  '/cloud setup groq <groq-api-key> — optional: lets Groq plan automatic boot fixes (never sees clinical content).',
  '/cloud prepare — one-time (≈1.5–3 h): quantize the reasoner, build llama.cpp, cache MedGemma on Kaggle.',
  '/cloud start — boot the 2× T4 node (≈6–15 min). /cloud status · /cloud logs · /cloud stop',
  '/cloud attach <https://….trycloudflare.com> <token> — use a node started outside the app.',
].join('\n')

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolve = async (ref: (typeof REFS)[keyof typeof REFS]): Promise<string | undefined> => (await ctx.credentials.resolve(ref))?.value

  const kaggleAuth = async (): Promise<{ username: string; key: string } | undefined> => {
    const username = config.kaggleUsername || await resolve(REFS.kaggleUsername)
    const key = await resolve(REFS.kaggleKey)
    return username && key ? { username, key } : undefined
  }

  const controller = new CloudController({
    kaggle: async () => {
      const auth = await kaggleAuth()
      if (!auth) throw new Error('Kaggle credentials missing — run /cloud setup <kaggle-username> <kaggle-api-token>.')
      return new KaggleClient(auth)
    },
    serveSettings: () => serveSettings(config),
    prepareSettings: () => prepareSettings(config),
    slugs: { serve: config.serveSlug, prepare: config.prepareSlug },
    machineShape: config.machineShape,
    maxRetries: config.remediation ? config.maxRetries : 0,
    store: fileSessionStore(ctx, config.sessionFile),
    token: newSecret,
    plan: async (failure, knobs: Knobs) => {
      const apiKey = await resolve(REFS.groq)
      return apiKey ? groqPlan(failure, knobs, { apiKey, model: config.groqModel }) : heuristicPlan(failure, knobs)
    },
  })

  const gateway = new Gateway({
    port: config.gatewayPort,
    upstream: () => controller.upstream(),
    localKey: () => resolve(REFS.gateway),
    onResult: (ok) => { if (!ok && controller.state === 'ready') void controller.heartbeat() },
    notReadyMessage: () => controller.busy
      ? `The medical cloud is still starting (${controller.stage ?? controller.state}) — check /cloud status.`
      : 'The medical cloud is not running. Type /cloud start (first time: /cloud setup, then /cloud prepare).',
  })

  await ensureGatewayKey(ctx)

  ctx.effect(() => {
    void gateway.listen().catch((error: Error) => {
      controller.lastError = `local gateway could not listen on 127.0.0.1:${config.gatewayPort} (${error.message})`
    })
    const timer = setInterval(() => { void controller.heartbeat() }, Math.max(30, config.heartbeatSeconds) * 1000)
    timer.unref?.()
    if (config.autoResume) void controller.resume().catch(() => undefined)
    return () => {
      clearInterval(timer)
      controller.dispose()
      void gateway.close()
    }
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: DEFINITION_ID,
      name: 'cloud',
      description: 'Medical GPU node on Kaggle: setup · prepare · start · status · stop · logs',
      input: { hint: 'start | status | stop | prepare | logs | setup <user> <token> | help' },
      // Setup carries secrets: never record the raw input in the session log.
      recordInput: false,
      async handler({ rawInput }) {
        const [sub = 'status', ...args] = rawInput.trim().split(/\s+/).filter(Boolean)
        switch (sub.toLowerCase()) {
          case 'help':
            return { kind: 'success', text: HELP }
          case 'status':
            return { kind: 'success', text: formatStatus(controller.snapshot(), config) }
          case 'setup': {
            if (args[0]?.toLowerCase() === 'groq') {
              if (!args[1]) return { kind: 'error', text: 'Usage: /cloud setup groq <groq-api-key>' }
              await ctx.credentials.set(REFS.groq, args[1])
              return { kind: 'success', text: 'Groq key saved. It is used only to plan boot fixes from boot logs — never for clinical questions.' }
            }
            const [username, key] = args
            if (!username || !key) return { kind: 'error', text: HELP }
            if (!/^[A-Za-z0-9_-]{3,64}$/.test(username)) return { kind: 'error', text: 'That does not look like a Kaggle username.' }
            await ctx.credentials.set(REFS.kaggleUsername, username)
            await ctx.credentials.set(REFS.kaggleKey, key)
            return { kind: 'success', text: `Kaggle credentials saved for ${username}. Next: /cloud prepare (one time), then /cloud start.` }
          }
          case 'prepare':
            if (!await kaggleAuth()) return { kind: 'error', text: 'Run /cloud setup <kaggle-username> <kaggle-api-token> first.' }
            return { kind: 'success', text: controller.prepare() }
          case 'start':
            if (!await kaggleAuth()) return { kind: 'error', text: 'Run /cloud setup <kaggle-username> <kaggle-api-token> first.' }
            return { kind: 'success', text: controller.start() }
          case 'stop':
            return { kind: 'success', text: await controller.stop() }
          case 'logs': {
            const snap = controller.snapshot()
            return { kind: 'success', text: snap.events.length ? snap.events.join('\n') : 'No events yet.' }
          }
          case 'attach': {
            const [url, token] = args
            if (!url || !token) return { kind: 'error', text: 'Usage: /cloud attach <https://….trycloudflare.com> <token>' }
            try {
              return await controller.attach(url, token)
                ? { kind: 'success', text: `Attached to ${url}.` }
                : { kind: 'error', text: 'The node did not answer /healthz with that token.' }
            } catch (error) {
              return { kind: 'error', text: (error as Error).message }
            }
          }
          default:
            return { kind: 'error', text: `Unknown subcommand "${sub}".\n${HELP}` }
        }
      },
    })
  })
}
