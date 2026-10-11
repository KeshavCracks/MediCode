import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  authorizationHeader, buildPrepareKernel, buildServeKernel, clampPlan, CloudController, formatStatus, groqPlan, heuristicPlan,
  KaggleClient, logLines, parseLogLine, scrubLogTail, serveSettings, Config, type CloudSession, type ControllerDeps, type Knobs,
  type ServeSettings,
} from '../src/index.ts'
import type { Config as CloudConfig } from '../src/index.ts'

const config = Config({} as Partial<CloudConfig> as CloudConfig)
const SETTINGS: ServeSettings = serveSettings(config)
const KNOBS: Knobs = { mode: 'auto', maxModelLen: 16384, gpuMemUtil: 0.92, maxNumSeqs: 8, visionCtx: 8192, enforceEager: false }
const HAS_PYTHON = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

function decodeKernel(source: string): { files: Record<string, string>; env: Record<string, string> } {
  const files: Record<string, string> = {}
  for (const m of source.matchAll(/^ {4}"([^"]+)": "([A-Za-z0-9+/=]+)",$/gm)) files[m[1] as string] = Buffer.from(m[2] as string, 'base64').toString('utf8')
  const env = JSON.parse(Buffer.from(/b64decode\("([A-Za-z0-9+/=]+)"\)\.decode/.exec(source)?.[1] ?? '', 'base64').toString('utf8')) as Record<string, string>
  return { files, env }
}

describe('kernels', () => {
  it('serve kernel embeds bootstrap + router and the session settings', () => {
    const source = buildServeKernel({ ...SETTINGS, mode: 'single', enforceEager: true }, 'tok-123')
    const { files, env } = decodeKernel(source)
    expect(Object.keys(files)).toEqual(['cloud_bootstrap.sh', 'router.py'])
    expect(files['cloud_bootstrap.sh']).toContain('--enable-prefix-caching')
    expect(files['cloud_bootstrap.sh']).toContain('--reasoning-parser qwen3')
    expect(files['cloud_bootstrap.sh']).toContain('--dtype float16')
    expect(files['cloud_bootstrap.sh']).not.toMatch(/--quantization (awq|fp8)/)
    expect(files['router.py']).toContain('hmac.compare_digest')
    expect(env).toMatchObject({ SESSION_BEARER_TOKEN: 'tok-123', MEDHARNESS_MODE: 'single', ENFORCE_EAGER: '1', REASONER_NAME: 'ii-medical-8b', VLLM_VERSION: '0.31.0' })
    expect(source).toContain('PRIVATE')
  })

  it('prepare kernel quantizes W4A16 with GPTQ and builds llama.cpp for SM75', () => {
    const { files, env } = decodeKernel(buildPrepareKernel({ reasonerHf: 'Intelligent-Internet/II-Medical-8B', llamaCppRef: 'v0.6.0', visionGgufUrl: 'u', visionMmprojUrl: 'm', calibrationSamples: 128 }))
    expect(files['prepare.py']).toContain('scheme="W4A16"')
    expect(files['prepare.py']).toContain('GPTQModifier')
    expect(files['prepare.py']).toContain('-DCMAKE_CUDA_ARCHITECTURES=75')
    expect(env).toMatchObject({ REASONER_HF: 'Intelligent-Internet/II-Medical-8B', CALIB_SAMPLES: '128' })
  })

  it.skipIf(!HAS_PYTHON)('generated kernel sources are valid Python', () => {
    for (const source of [buildServeKernel(SETTINGS, 't'), buildPrepareKernel({ reasonerHf: 'a', llamaCppRef: 'b', visionGgufUrl: 'c', visionMmprojUrl: 'd', calibrationSamples: 1 })]) {
      const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source })
      expect(r.status, r.stderr.toString()).toBe(0)
    }
  })

  it('bootstrap passes bash -n', () => {
    const { files } = decodeKernel(buildServeKernel(SETTINGS, 't'))
    const r = spawnSync('bash', ['-n'], { input: files['cloud_bootstrap.sh'] })
    expect(r.status, r.stderr.toString()).toBe(0)
  })

  it('parses the log protocol and distrusts non-quick-tunnel URLs', () => {
    expect(parseLogLine('MEDHARNESS_STAGE name=reasoner t=40')).toEqual({ kind: 'stage', name: 'reasoner' })
    expect(parseLogLine('MEDHARNESS_READY url=https://calm-river-12.trycloudflare.com mode=dual reasoner=x')).toEqual({ kind: 'ready', url: 'https://calm-river-12.trycloudflare.com', mode: 'dual' })
    expect(parseLogLine('MEDHARNESS_READY url=https://evil.example.com')).toMatchObject({ kind: 'failed', stage: 'tunnel' })
    expect(parseLogLine('MEDHARNESS_FAILED stage=reasoner reason=vLLM not healthy after 2400s')).toEqual({ kind: 'failed', stage: 'reasoner', reason: 'vLLM not healthy after 2400s' })
    expect(parseLogLine('MEDHARNESS_PREPARED seconds=5000')).toEqual({ kind: 'prepared' })
    expect(parseLogLine('INFO: loading weights')).toBeUndefined()
  })
})

describe('remediation (Groq is clamped to allowlisted knobs)', () => {
  it('drops unknown keys and clamps values', () => {
    const plan = clampPlan({ action: 'retry', reason: 'oom', changes: { maxModelLen: 999999, gpuMemUtil: 2, maxNumSeqs: 0, model: 'evil/model', command: 'rm -rf /', mode: 'triple' } }, KNOBS)
    expect(plan).toEqual({ action: 'retry', reason: 'oom', changes: { gpuMemUtil: 0.95, maxNumSeqs: 1 }, source: 'groq' })
  })

  it('a retry with no effective change becomes abort unless the failure is transient', () => {
    expect(clampPlan({ action: 'retry', reason: 'try again', changes: {} }, KNOBS).action).toBe('abort')
    expect(clampPlan({ action: 'retry', reason: 'transient network timeout', changes: {} }, KNOBS).action).toBe('retry')
  })

  it('heuristics: OOM shrinks, one GPU → single, missing artifacts → abort', () => {
    const oom = heuristicPlan({ stage: 'reasoner', reason: 'vLLM process exited', logTail: ['torch.OutOfMemoryError: CUDA out of memory'] }, KNOBS)
    expect(oom).toMatchObject({ action: 'retry', changes: { maxModelLen: 8192, maxNumSeqs: 4, visionCtx: 4096 } })
    expect(heuristicPlan({ stage: 'gpu', reason: 'dual mode needs 2 GPUs, found 1', logTail: [] }, { ...KNOBS, mode: 'dual' })).toMatchObject({ action: 'retry', changes: { mode: 'single' } })
    expect(heuristicPlan({ stage: 'artifacts', reason: 'prepared artifacts not attached — run /cloud prepare once', logTail: [] }, KNOBS).action).toBe('abort')
  })

  it('Groq receives only boot metadata, and cannot force a retry of a fatal failure', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[]; response_format: unknown }
      expect(body.response_format).toEqual({ type: 'json_object' })
      const user = JSON.parse(body.messages[1]?.content ?? '{}') as Record<string, unknown>
      expect(Object.keys(user).sort()).toEqual(['currentKnobs', 'failedStage', 'logTail', 'reason'])
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'retry', reason: 'just retry', changes: { maxModelLen: 4096 } }) } }] })
    })
    const fatal = await groqPlan({ stage: 'artifacts', reason: 'prepared artifacts not attached', logTail: [] }, KNOBS, { apiKey: 'k', model: 'openai/gpt-oss-120b', fetch: fetch as never })
    expect(fatal.action).toBe('abort')
    const ok = await groqPlan({ stage: 'reasoner', reason: 'vLLM not healthy', logTail: ['KV cache too small'] }, KNOBS, { apiKey: 'k', model: 'm', fetch: fetch as never })
    expect(ok).toMatchObject({ action: 'retry', source: 'groq', changes: { maxModelLen: 4096 } })
    const broken = await groqPlan({ stage: 'reasoner', reason: 'x', logTail: ['CUDA out of memory'] }, KNOBS, { apiKey: 'k', model: 'm', fetch: (async () => Response.json({ choices: [{ message: { content: 'not json' } }] })) as never })
    expect(broken.source).toBe('heuristic')
  })

  it('scrubs tokens, tunnel URLs and anything message-shaped from log tails', () => {
    const out = scrubLogTail(['token tok-SECRET used', 'url https://a-b.trycloudflare.com', '{"messages": [{"content": "patient"}]}', 'api_key=abc'], 'tok-SECRET')
    expect(out.join('\n')).not.toMatch(/tok-SECRET|trycloudflare|patient|abc/)
  })
})

describe('KaggleClient', () => {
  it('uses Bearer for KGAT tokens and Basic for legacy keys', () => {
    expect(authorizationHeader({ username: 'u', key: 'KGAT_abc' })).toBe('Bearer KGAT_abc')
    expect(authorizationHeader({ username: 'u', key: 'k' })).toBe(`Basic ${Buffer.from('u:k').toString('base64')}`)
  })

  it('pushes a private GPU + internet script kernel', async () => {
    const fetch = vi.fn(async () => Response.json({ ref: 'u/medharness-serve', versionNumber: 3 }))
    await new KaggleClient({ username: 'u', key: 'KGAT_x' }, fetch as never).saveKernel({ slug: 'medharness-serve', title: 't', text: 'print(1)', machineShape: 'NvidiaTeslaT4', kernelDataSources: ['u/medharness-prepare'] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.kaggle.com/v1/kernels.KernelsApiService/SaveKernel')
    expect(JSON.parse(init.body as string)).toMatchObject({ slug: 'u/medharness-serve', isPrivate: true, enableGpu: true, enableInternet: true, machineShape: 'NvidiaTeslaT4', kernelType: 'script', language: 'python', kernelDataSources: ['u/medharness-prepare'] })
  })

  it('explains the phone-verification requirement', async () => {
    const fetch = async () => Response.json({ error: 'Internet access requires phone verification' })
    await expect(new KaggleClient({ username: 'u', key: 'k' }, fetch as never).saveKernel({ slug: 's', title: 't', text: '', machineShape: 'NvidiaTeslaT4' })).rejects.toThrow(/phone-verified/)
  })

  it('follows the SSE log stream until END_OF_LOG', async () => {
    const sse = 'data: {"data":"MEDHARNESS_STAGE name=gpu\\n"}\n\ndata: plain line\n\ndata: END_OF_LOG\n\ndata: never\n\n'
    const fetch = async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    const lines: string[] = []
    for await (const l of new KaggleClient({ username: 'u', key: 'k' }, fetch as never).follow('s', new AbortController().signal)) lines.push(l)
    expect(lines).toEqual(['MEDHARNESS_STAGE name=gpu', 'plain line'])
  })

  it('normalises legacy JSON log arrays', () => {
    expect(logLines('[{"stream_name":"stdout","time":1,"data":"a\\nb\\n"},{"data":"c"}]')).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Script { status: string[]; lines: string[][] }

function harness(scripts: Script[], health: (url: string) => Response | Promise<Response>) {
  let run = -1
  let statusCalls = 0
  const saved: { slug: string; text: string; kernelDataSources?: string[] | undefined }[] = []
  const store = { data: undefined as CloudSession | undefined, load: vi.fn(async () => store.data), save: vi.fn(async (s: CloudSession) => { store.data = s }), clear: vi.fn(async () => { store.data = undefined }) }
  const kaggle = {
    username: 'drkaggle',
    saveKernel: vi.fn(async (req: { slug: string; text: string; kernelDataSources?: string[] | undefined }) => { run++; statusCalls = 0; saved.push(req); return {} }),
    status: vi.fn(async () => {
      const s = scripts[run]?.status ?? ['RUNNING']
      return { status: (s[Math.min(statusCalls++, s.length - 1)] ?? 'RUNNING') as never }
    }),
    logs: vi.fn(async () => scripts[run]?.lines.flat() ?? []),
    cancel: vi.fn(async () => undefined),
    async *follow() { for (const l of scripts[run]?.lines[0] ?? []) yield l },
  }
  const fetch = vi.fn(async (url: string) => health(url))
  const plan = vi.fn(async (failure, knobs: Knobs) => heuristicPlan(failure, knobs))
  let tokens = 0
  const deps: ControllerDeps = {
    kaggle: async () => kaggle as never,
    serveSettings: () => SETTINGS,
    prepareSettings: () => ({ reasonerHf: 'a', llamaCppRef: 'b', visionGgufUrl: 'c', visionMmprojUrl: 'd', calibrationSamples: 1 }),
    slugs: { serve: 'medharness-serve', prepare: 'medharness-prepare' },
    machineShape: 'NvidiaTeslaT4',
    plan,
    store,
    token: () => `token-${++tokens}`,
    fetch: fetch as never,
    sleep: async () => undefined,
    pollMs: 1,
    verifyAttempts: 3,
    serveSource: (s, t) => JSON.stringify({ knobs: { maxModelLen: s.maxModelLen, maxNumSeqs: s.maxNumSeqs }, t }),
    prepareSource: () => 'prepare',
  }
  return { controller: new CloudController(deps), kaggle, store, fetch, plan, saved }
}

const healthy = () => Response.json({ ok: true })
const READY = ['MEDHARNESS_STAGE name=gpu', 'MEDHARNESS_STAGE name=reasoner', 'MEDHARNESS_READY url=https://calm-river-12.trycloudflare.com mode=dual']

describe('CloudController', () => {
  it('provisions → boots → verifies with the session token → ready', async () => {
    const h = harness([{ status: ['QUEUED', 'RUNNING'], lines: [READY] }], healthy)
    expect(h.controller.start()).toMatch(/Provisioning/)
    await h.controller.pending
    expect(h.controller.state).toBe('ready')
    expect(h.controller.upstream()).toEqual({ url: 'https://calm-river-12.trycloudflare.com', token: 'token-1' })
    expect(h.saved[0]?.kernelDataSources).toEqual(['drkaggle/medharness-prepare'])
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://calm-river-12.trycloudflare.com/healthz')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('curl/8.0.0')
    expect(h.store.save).toHaveBeenCalledOnce()
    expect(formatStatus(h.controller.snapshot(), config)).toMatch(/READY — https:\/\/calm-river-12/)
  })

  it('remediates an OOM boot failure with smaller knobs and a fresh token', async () => {
    const h = harness([
      { status: ['RUNNING'], lines: [['MEDHARNESS_STAGE name=reasoner', 'torch.OutOfMemoryError: CUDA out of memory', 'MEDHARNESS_FAILED stage=reasoner reason=vLLM process exited during start-up']] },
      { status: ['RUNNING'], lines: [READY] },
    ], healthy)
    h.controller.start()
    await h.controller.pending
    expect(h.controller.state).toBe('ready')
    expect(h.plan).toHaveBeenCalledOnce()
    expect(h.plan.mock.calls[0]?.[0].logTail.join('\n')).toContain('OutOfMemoryError')
    expect(JSON.parse(h.saved[1]?.text ?? '{}')).toEqual({ knobs: { maxModelLen: 8192, maxNumSeqs: 4 }, t: 'token-2' })
    expect(h.kaggle.cancel).toHaveBeenCalledOnce()
  })

  it('aborts without retrying when artifacts were never prepared', async () => {
    const h = harness([{ status: ['RUNNING'], lines: [['MEDHARNESS_FAILED stage=artifacts reason=prepared artifacts not attached — run /cloud prepare once, then /cloud start']] }], healthy)
    h.controller.start()
    await h.controller.pending
    expect(h.controller.state).toBe('error')
    expect(h.controller.lastError).toMatch(/run \/cloud prepare/)
    expect(h.saved).toHaveLength(1)
  })

  it('a kernel that ends without READY is a failure (reads the completed log)', async () => {
    const h = harness([{ status: ['RUNNING', 'ERROR'], lines: [[]] }, { status: ['ERROR'], lines: [[]] }, { status: ['ERROR'], lines: [[]] }], healthy)
    h.controller.start()
    await h.controller.pending
    expect(h.controller.state).toBe('error')
    expect(h.kaggle.logs).toHaveBeenCalled()
  })

  it('heartbeat: 3 misses → degraded, recovery → ready, ended kernel → stopped', async () => {
    let up = true
    const h = harness([{ status: ['RUNNING'], lines: [READY] }], () => (up ? healthy() : new Response('bad gateway', { status: 502 })))
    h.controller.start()
    await h.controller.pending
    up = false
    for (let i = 0; i < 3; i++) await h.controller.heartbeat()
    expect(h.controller.state).toBe('degraded')
    expect(h.controller.upstream()).toBeDefined() // still try requests while degraded
    up = true
    await h.controller.heartbeat()
    expect(h.controller.state).toBe('ready')
    up = false
    h.kaggle.status.mockResolvedValue({ status: 'COMPLETE' as never })
    for (let i = 0; i < 3; i++) await h.controller.heartbeat()
    expect(h.controller.state).toBe('stopped')
    expect(h.controller.upstream()).toBeUndefined()
    expect(h.store.clear).toHaveBeenCalled()
  })

  it('treats an interstitial HTML page as an unhealthy heartbeat', async () => {
    let html = false
    const h = harness([{ status: ['RUNNING'], lines: [READY] }], () => (html ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : healthy()))
    h.controller.start()
    await h.controller.pending
    html = true
    await h.controller.heartbeat()
    expect(h.controller.heartbeatFailures).toBe(1)
  })

  it('stop shuts the router down and cancels the Kaggle session', async () => {
    const h = harness([{ status: ['RUNNING'], lines: [READY] }], healthy)
    h.controller.start()
    await h.controller.pending
    const message = await h.controller.stop()
    expect(message).toMatch(/router shut down; Kaggle session cancelled/)
    expect(h.fetch.mock.calls.some(([u]) => String(u).endsWith('/admin/shutdown'))).toBe(true)
    expect(h.controller.state).toBe('stopped')
  })

  it('resumes a persisted live session and drops a dead one', async () => {
    const h = harness([], healthy)
    h.store.data = { slug: 's', url: 'https://calm-river-12.trycloudflare.com', token: 't', startedAt: 0, knobs: KNOBS }
    expect(await h.controller.resume()).toBe(true)
    expect(h.controller.state).toBe('ready')
    const dead = harness([], () => new Response('', { status: 530 }))
    dead.store.data = { slug: 's', url: 'https://gone-1.trycloudflare.com', token: 't', startedAt: 0, knobs: KNOBS }
    expect(await dead.controller.resume()).toBe(false)
    expect(dead.store.clear).toHaveBeenCalled()
  })

  it('prepare runs in the background and reports completion', async () => {
    const h = harness([{ status: ['RUNNING'], lines: [['MEDHARNESS_STAGE name=quantize', 'MEDHARNESS_PREPARED seconds=4000']] }], healthy)
    expect(h.controller.prepare()).toMatch(/One-time preparation/)
    await h.controller.preparing
    expect(h.controller.prepareState).toBe('done')
    expect(h.saved[0]?.slug).toBe('medharness-prepare')
  })
})
