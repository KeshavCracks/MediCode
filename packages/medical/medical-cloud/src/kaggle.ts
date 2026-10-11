/**
 * Minimal Kaggle public-API client (the RPC surface used by `kagglesdk`):
 * `POST https://api.kaggle.com/v1/kernels.KernelsApiService/<Method>`.
 *
 * Auth: new-style API tokens (`KGAT_…`) as Bearer; legacy `kaggle.json`
 * keys as HTTP Basic `username:key`.
 *
 * @module @deepseek-ai/dsh-medical-cloud/kaggle
 */

export type KernelStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'ERROR' | 'CANCEL_REQUESTED' | 'CANCEL_ACKNOWLEDGED' | 'NEW_SCRIPT' | 'UNKNOWN'

export interface KaggleAuth {
  username: string
  key: string
}

export interface SaveKernelRequest {
  slug: string
  title: string
  text: string
  kernelDataSources?: string[] | undefined
  machineShape: string
  sessionTimeoutSeconds?: number | undefined
}

export interface SaveKernelResponse {
  ref?: string
  url?: string
  versionNumber?: number
  error?: string
}

export class KaggleError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'KaggleError'
  }
}

export const KAGGLE_API = 'https://api.kaggle.com/v1'

export function authorizationHeader(auth: KaggleAuth): string {
  return auth.key.startsWith('KGAT_')
    ? `Bearer ${auth.key}`
    : `Basic ${Buffer.from(`${auth.username}:${auth.key}`, 'utf8').toString('base64')}`
}

/** Normalise free-form Kaggle log payloads into text lines. */
export function logLines(payload: string): string[] {
  const trimmed = payload.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    return entries.flatMap((e) => {
      if (typeof e === 'string') return e.split('\n')
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>
        const text = o.data ?? o.text ?? o.line ?? o.message ?? o.log
        return typeof text === 'string' ? text.replace(/\n$/, '').split('\n') : []
      }
      return []
    })
  } catch {
    return trimmed.split('\n')
  }
}

export class KaggleClient {
  constructor(
    private readonly auth: KaggleAuth,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly base = KAGGLE_API,
  ) {}

  get username(): string {
    return this.auth.username
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/kernels.KernelsApiService/${method}`, {
      method: 'POST',
      headers: { 'authorization': authorizationHeader(this.auth), 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dsh-medical-cloud/0.1' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' — check the Kaggle username/API token (/cloud setup)' : ''
      throw new KaggleError(`Kaggle ${method} failed: HTTP ${res.status}${hint}${text ? ` (${text.slice(0, 200)})` : ''}`, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Create or update a private GPU+internet script kernel and start a run. */
  async saveKernel(req: SaveKernelRequest, signal?: AbortSignal): Promise<SaveKernelResponse> {
    const res = await this.call<SaveKernelResponse>('SaveKernel', {
      slug: `${this.auth.username}/${req.slug}`,
      newTitle: req.title,
      text: req.text,
      language: 'python',
      kernelType: 'script',
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
      machineShape: req.machineShape,
      kernelDataSources: req.kernelDataSources ?? [],
      datasetDataSources: [],
      competitionDataSources: [],
      modelDataSources: [],
      ...(req.sessionTimeoutSeconds ? { sessionTimeoutSeconds: req.sessionTimeoutSeconds } : {}),
    }, signal)
    if (res.error) {
      const phone = /internet|phone|verif/i.test(res.error) ? ' — internet-enabled GPU kernels need a phone-verified Kaggle account (kaggle.com/settings)' : ''
      throw new KaggleError(`Kaggle refused the kernel: ${res.error}${phone}`)
    }
    return res
  }

  async status(slug: string, signal?: AbortSignal): Promise<{ status: KernelStatus; failureMessage?: string | undefined }> {
    const res = await this.call<{ status?: string; failureMessage?: string }>('GetKernelSessionStatus', { userName: this.auth.username, kernelSlug: slug }, signal)
    const status = (res.status ?? 'UNKNOWN').toUpperCase().replace(/^KERNEL_WORKER_STATUS_/, '') as KernelStatus
    return { status, failureMessage: res.failureMessage || undefined }
  }

  /** Full log of the latest session so far, as text lines. */
  async logs(slug: string, signal?: AbortSignal): Promise<string[]> {
    const res = await this.call<{ log?: string }>('ListKernelSessionOutput', { userName: this.auth.username, kernelSlug: slug }, signal)
    return logLines(res.log ?? '')
  }

  /**
   * Live log of the running session (`GetKernelSessionLogsStream`, server-sent
   * events terminated by `END_OF_LOG`). Yields text lines as they arrive.
   */
  async *follow(slug: string, signal: AbortSignal): AsyncGenerator<string> {
    const res = await this.fetchImpl(`${this.base}/kernels.KernelsApiService/GetKernelSessionLogsStream`, {
      method: 'POST',
      headers: { 'authorization': authorizationHeader(this.auth), 'content-type': 'application/json', 'accept': 'text/event-stream', 'user-agent': 'dsh-medical-cloud/0.1' },
      body: JSON.stringify({ userName: this.auth.username, kernelSlug: slug }),
      signal,
    })
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw new KaggleError(`Kaggle log stream failed: HTTP ${res.status}`, res.status)
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let data: string[] = []
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          if (raw.startsWith('data:')) { data.push(raw.slice(5).replace(/^ /, '')); continue }
          if (raw !== '' || data.length === 0) continue
          const payload = data.join('\n')
          data = []
          if (payload.trim() === 'END_OF_LOG') return
          for (const line of logLines(payload)) {
            if (line.trim() === 'END_OF_LOG') return
            yield line
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  async cancel(slug: string, signal?: AbortSignal): Promise<void> {
    await this.call('CancelKernelSession', { userName: this.auth.username, kernelSlug: slug }, signal)
  }
}
