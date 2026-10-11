/**
 * Boot-failure remediation for the remote node.
 *
 * Groq is used strictly as a headless DevOps assistant: it receives the failed
 * stage, the current serve knobs and a scrubbed tail of *boot* logs (no traffic
 * has been served at that point) and proposes a JSON plan. Its output is never
 * executed — {@link clampPlan} keeps only allowlisted knob changes inside safe
 * ranges, and the controller applies them by re-pushing the kernel. No
 * clinical content ever reaches Groq, and Groq never answers clinical queries.
 *
 * @module @deepseek-ai/dsh-medical-cloud/remediation
 */

import type { Knobs } from './kernels.ts'

export interface BootFailure {
  stage: string
  reason: string
  logTail: string[]
}

export interface Remediation {
  action: 'retry' | 'abort'
  reason: string
  changes: Partial<Knobs>
  source: 'groq' | 'heuristic'
}

export const KNOB_LIMITS = {
  maxModelLen: [2048, 16384],
  gpuMemUtil: [0.5, 0.95],
  maxNumSeqs: [1, 16],
  visionCtx: [2048, 8192],
} as const

const NON_RETRYABLE = /artifacts not attached|quantized reasoner missing|llama-server binary missing|no NVIDIA driver|checksum mismatch|unauthori[sz]ed|phone/i

function clampNumber(value: unknown, [min, max]: readonly [number, number], integer: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const v = Math.min(max, Math.max(min, value))
  return integer ? Math.round(v) : Math.round(v * 100) / 100
}

/** Validate an untrusted plan: unknown keys dropped, numbers clamped, no-op changes removed. */
export function clampPlan(raw: unknown, current: Knobs, source: Remediation['source'] = 'groq'): Remediation {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawChanges = (obj.changes && typeof obj.changes === 'object' ? obj.changes : {}) as Record<string, unknown>
  const changes: Partial<Knobs> = {}
  if (rawChanges.mode === 'dual' || rawChanges.mode === 'single') changes.mode = rawChanges.mode
  const len = clampNumber(rawChanges.maxModelLen, KNOB_LIMITS.maxModelLen, true)
  if (len !== undefined) changes.maxModelLen = len
  const mem = clampNumber(rawChanges.gpuMemUtil, KNOB_LIMITS.gpuMemUtil, false)
  if (mem !== undefined) changes.gpuMemUtil = mem
  const seqs = clampNumber(rawChanges.maxNumSeqs, KNOB_LIMITS.maxNumSeqs, true)
  if (seqs !== undefined) changes.maxNumSeqs = seqs
  const vctx = clampNumber(rawChanges.visionCtx, KNOB_LIMITS.visionCtx, true)
  if (vctx !== undefined) changes.visionCtx = vctx
  if (typeof rawChanges.enforceEager === 'boolean') changes.enforceEager = rawChanges.enforceEager
  for (const key of Object.keys(changes) as (keyof Knobs)[]) {
    if (changes[key] === current[key]) delete changes[key]
  }
  const reason = typeof obj.reason === 'string' ? obj.reason.replace(/\s+/g, ' ').slice(0, 300) : 'no reason given'
  const wantsRetry = obj.action === 'retry'
  // A "retry" with nothing to change would repeat the failure exactly; only a transient-looking reason may retry as-is.
  const action = wantsRetry && (Object.keys(changes).length > 0 || /transient|network|timeout|queue|429|503|rate/i.test(reason)) ? 'retry' : 'abort'
  return { action, reason, changes: action === 'retry' ? changes : {}, source }
}

/** Deterministic plan used when Groq is not configured or unavailable. */
export function heuristicPlan(failure: BootFailure, current: Knobs): Remediation {
  const text = `${failure.reason}\n${failure.logTail.join('\n')}`
  const plan = (action: 'retry' | 'abort', reason: string, changes: Partial<Knobs> = {}): Remediation => clampPlan({ action, reason, changes }, current, 'heuristic')
  if (NON_RETRYABLE.test(text)) return plan('abort', failure.reason)
  if (/dual mode needs 2 GPUs/i.test(text)) return plan('retry', 'only one GPU attached; sharing it', { mode: 'single' })
  if (/out of memory|CUDA error: out of memory|OutOfMemoryError|insufficient memory|KV cache|max_model_len|larger than the maximum number of tokens/i.test(text)) {
    return plan('retry', 'GPU memory exhausted; shrinking context and batch', {
      maxModelLen: Math.max(4096, Math.floor(current.maxModelLen / 2)),
      maxNumSeqs: Math.max(2, Math.floor(current.maxNumSeqs / 2)),
      gpuMemUtil: Math.min(0.92, current.gpuMemUtil),
      visionCtx: Math.max(2048, Math.floor(current.visionCtx / 2)),
    })
  }
  if (/cuda ?graph|capture|torch\.compile|inductor|triton/i.test(text) && !current.enforceEager) {
    return plan('retry', 'graph capture/compile failure; retrying in eager mode', { enforceEager: true })
  }
  if (/not healthy after|timed out|timeout|connection reset|temporar|could not resolve|network|HTTP Error 5\d\d|429/i.test(text)) {
    return plan('retry', 'transient network or start-up timeout')
  }
  return plan('abort', failure.reason)
}

/** Remove anything that could be sensitive before logs leave for Groq. */
export function scrubLogTail(lines: readonly string[], token?: string): string[] {
  return lines
    .slice(-80)
    .map(l => (token ? l.split(token).join('[token]') : l))
    .map(l => l.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi, '[tunnel-url]').replace(/(Bearer|api[_-]?key|token)[=: ]+\S+/gi, '$1 [redacted]'))
    .filter(l => !/"(messages|prompt|content)"\s*:/.test(l))
    .map(l => l.slice(0, 400))
}

export const GROQ_SYSTEM_PROMPT = [
  'You are a DevOps assistant for a remote inference node (Kaggle, 2x NVIDIA T4 16 GB, SM75, no bf16).',
  'GPU0 runs vLLM serving a GPTQ W4A16 8B model; GPU1 runs llama.cpp serving a 4B GGUF vision model; a router and a Cloudflare quick tunnel front them.',
  'Given a boot failure, reply with ONE JSON object only: {"action":"retry"|"abort","reason":string,"changes":{...}}.',
  'Allowed change keys: mode ("dual"|"single"), maxModelLen (2048-16384), gpuMemUtil (0.5-0.95), maxNumSeqs (1-16), visionCtx (2048-8192), enforceEager (boolean).',
  'You cannot run commands, install packages, change models, or change any other setting. Choose "abort" when no allowed change can plausibly fix the failure.',
].join('\n')

export interface GroqOptions {
  apiKey: string
  model: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal | undefined
  endpoint?: string
}

/** Ask Groq for a plan; any error or malformed output falls back to the heuristic. */
export async function groqPlan(failure: BootFailure, current: Knobs, options: GroqOptions): Promise<Remediation> {
  const doFetch = options.fetch ?? globalThis.fetch
  try {
    const res = await doFetch(options.endpoint ?? 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GROQ_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ failedStage: failure.stage, reason: failure.reason, currentKnobs: current, logTail: failure.logTail }) },
        ],
      }),
      signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
    })
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`)
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content ?? ''
    const plan = clampPlan(JSON.parse(content), current, 'groq')
    // Never let the model talk us out of a known-fatal condition or into retrying one.
    return NON_RETRYABLE.test(`${failure.reason}\n${failure.logTail.join('\n')}`) ? heuristicPlan(failure, current) : plan
  } catch {
    return heuristicPlan(failure, current)
  }
}
