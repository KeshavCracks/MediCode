/**
 * Local loopback gateway between the harness's OpenAI-compatible provider
 * (`llm-pi-ai`, baseURL `http://127.0.0.1:<port>/v1`) and the remote tunnel.
 *
 * - Binds 127.0.0.1 only; rejects foreign `Host` headers (DNS-rebinding) and
 *   requests without the local gateway key (constant-time compare).
 * - Injects the remote `SESSION_BEARER_TOKEN`, `User-Agent: curl/8.0.0` and
 *   tunnel interstitial-bypass headers; the provider never sees the token or URL.
 * - Streams responses through unbuffered (SSE `reasoning_content` deltas reach
 *   the UI's thinking accordion live); client disconnect aborts upstream.
 * - An HTML answer where JSON/SSE was expected (Cloudflare/ngrok interstitial,
 *   error page) becomes a 503 with a clear message instead of garbage tokens.
 *
 * @module @deepseek-ai/dsh-medical-cloud/gateway
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export interface Upstream {
  url: string
  token: string
}

export interface GatewayOptions {
  port: number
  /** Current tunnel target, or `undefined` while the node is not ready. */
  upstream: () => Upstream | undefined
  /** Local key the provider must present (MEDCLOUD_GATEWAY_KEY); re-resolved per request. */
  localKey: () => Promise<string | undefined>
  /** Called with the outcome of each proxied request (feeds the controller's health view). */
  onResult?: (ok: boolean, detail: string) => void
  /** Message used while not ready (evaluated per request). */
  notReadyMessage?: (() => string) | undefined
  fetch?: typeof globalThis.fetch
  maxBodyBytes?: number
}

/** Headers added to every upstream request. */
export const TUNNEL_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'curl/8.0.0',
  'ngrok-skip-browser-warning': 'true',
  'bypass-tunnel-reminder': 'true',
}

const ALLOWED = new Map<string, readonly string[]>([
  ['/v1/chat/completions', ['POST']],
  ['/v1/completions', ['POST']],
  ['/v1/models', ['GET']],
])

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

export function keyMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  return timingSafeEqual(digest(presented), digest(expected))
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

function sendError(res: ServerResponse, status: number, message: string, type = 'medcloud'): void {
  if (res.headersSent) { res.destroy(); return }
  const body = JSON.stringify({ error: { message, type, code: status } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > max) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export class Gateway {
  private server: Server | undefined

  constructor(private readonly options: GatewayOptions) {}

  get port(): number | undefined {
    return (this.server?.address() as AddressInfo | null)?.port
  }

  async listen(): Promise<number> {
    const server = createServer((req, res) => { void this.handle(req, res) })
    server.keepAliveTimeout = 65_000
    server.requestTimeout = 0 // long generations
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    this.server = server
    return this.port as number
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.port ?? this.options.port
    if (!hostAllowed(req.headers.host, port)) return sendError(res, 421, 'misdirected request')
    const auth = req.headers.authorization
    const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
    if (!keyMatches(presented, await this.options.localKey())) return sendError(res, 401, 'unauthorized', 'auth')
    const path = (req.url ?? '/').split('?')[0] as string
    const methods = ALLOWED.get(path)
    if (!methods) return sendError(res, 404, `unsupported path ${path}`)
    if (!methods.includes(req.method ?? '')) return sendError(res, 405, 'method not allowed')
    const upstream = this.options.upstream()
    if (!upstream) return sendError(res, 503, this.options.notReadyMessage?.() ?? 'The medical cloud is not running. Type /cloud start, then retry.')

    let body: Buffer | undefined
    try {
      body = req.method === 'POST' ? await readBody(req, this.options.maxBodyBytes ?? 32 * 1024 * 1024) : undefined
    } catch (error) {
      return sendError(res, (error as { status?: number }).status ?? 400, (error as Error).message)
    }

    const controller = new AbortController()
    const abort = (): void => controller.abort()
    res.on('close', abort)
    try {
      const upstreamRes = await (this.options.fetch ?? globalThis.fetch)(`${upstream.url.replace(/\/+$/, '')}${req.url}`, {
        method: req.method as string,
        headers: {
          ...TUNNEL_HEADERS,
          'authorization': `Bearer ${upstream.token}`,
          'accept': req.headers.accept ?? 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
      })
      const type = upstreamRes.headers.get('content-type') ?? ''
      if (/text\/html/i.test(type)) {
        await upstreamRes.body?.cancel()
        this.options.onResult?.(false, `interstitial/HTML page (HTTP ${upstreamRes.status})`)
        return sendError(res, 503, 'The tunnel returned a web page instead of the model API (interstitial or tunnel down). The node may be restarting — check /cloud status.')
      }
      if (upstreamRes.status === 401) {
        await upstreamRes.body?.cancel()
        this.options.onResult?.(false, 'remote rejected the session token')
        return sendError(res, 502, 'The remote node rejected this session token; restart with /cloud start.')
      }
      this.options.onResult?.(upstreamRes.status < 500, `HTTP ${upstreamRes.status}`)
      res.writeHead(upstreamRes.status, {
        'content-type': type || 'application/json',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders()
      if (!upstreamRes.body) { res.end(); return }
      const stream = Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream<Uint8Array>)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch (error) {
      if (controller.signal.aborted) return
      this.options.onResult?.(false, (error as Error).message)
      sendError(res, 502, `Could not reach the medical cloud (${(error as Error).message}). Check /cloud status.`)
    }
    // The 'close' listener stays attached for the life of the piped stream: a
    // client disconnect mid-generation aborts the upstream request (frees the GPU).
  }
}
