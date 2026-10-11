/**
 * Read-only, allowlisted HTTP GET for public medical sources.
 *
 * - HTTPS only, GET only, no cookies, no credentials forwarded.
 * - Every hop (including redirects, followed manually) must match the host
 *   allowlist — an open redirect cannot walk the agent off the allowlist.
 * - Bodies are capped; requests time out; each host is throttled.
 *
 * @module @deepseek-ai/dsh-medical-agent-reach/net
 */

export class ReachError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReachError'
  }
}

export interface FetcherOptions {
  /** Exact host names, or `.example.org` to allow the domain and its subdomains. */
  allowHosts: readonly string[]
  userAgent: string
  timeoutMs: number
  maxBytes: number
  /** Minimum spacing between requests to the same host (NCBI asks for ≤ 3 req/s without a key). */
  minIntervalMs: number
  maxRedirects?: number
  fetch?: typeof globalThis.fetch
}

export interface FetchedText {
  url: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allow.some((a) => {
    const rule = a.toLowerCase()
    return rule.startsWith('.') ? h === rule.slice(1) || h.endsWith(rule) : h === rule
  })
}

function checkUrl(raw: string, allow: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ReachError(`invalid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') throw new ReachError(`only https:// URLs are allowed (got ${url.protocol}).`)
  if (url.username || url.password) throw new ReachError('URLs with embedded credentials are not allowed.')
  if (url.port && url.port !== '443') throw new ReachError('non-standard ports are not allowed.')
  if (!hostAllowed(url.hostname, allow)) throw new ReachError(`host "${url.hostname}" is not on the read-only allowlist.`)
  return url
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (ms <= 0) { resolve(); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
})

export class Fetcher {
  private readonly nextSlot = new Map<string, number>()

  constructor(private readonly options: FetcherOptions) {}

  private async throttle(host: string, signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0)
    this.nextSlot.set(host, slot + this.options.minIntervalMs)
    await sleep(slot - now, signal)
  }

  async get(raw: string, signal: AbortSignal, accept = '*/*'): Promise<FetchedText> {
    const doFetch = this.options.fetch ?? globalThis.fetch
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
    let url = checkUrl(raw, this.options.allowHosts)
    for (let hop = 0; ; hop++) {
      await this.throttle(url.hostname, combined)
      const res = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: combined,
        headers: { 'user-agent': this.options.userAgent, accept, 'accept-language': 'en' },
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel()
        if (hop >= (this.options.maxRedirects ?? 3)) throw new ReachError('too many redirects.')
        url = checkUrl(new URL(res.headers.get('location') as string, url).toString(), this.options.allowHosts)
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new ReachError(`${url.hostname} answered HTTP ${res.status}.`)
      }
      const { text, truncated } = await readCapped(res, this.options.maxBytes)
      return { url: url.toString(), status: res.status, contentType: res.headers.get('content-type') ?? '', text, truncated }
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, ''), truncated }
}

// ---------------------------------------------------------------------------
// Tiny XML/HTML helpers (regex-based; inputs are well-formed feeds/E-utilities XML)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Text of an XML element whose markup is real XML (E-utilities): strip tags, then decode once. */
export function xmlText(s: string): string {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Text of a feed field that may carry entity-encoded HTML: unwrap CDATA, decode, strip tags, decode again. */
export function plainText(s: string): string {
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // Feeds often entity-encode their HTML: decode once, strip tags, decode again.
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** All inner contents of `<tag …>…</tag>` (non-nested). */
export function tagAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(re)].map(m => m[1] ?? '')
}

export function tagFirst(xml: string, tag: string): string | undefined {
  return tagAll(xml, tag)[0]
}

export function attr(xml: string, tag: string, name: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml)
  return m?.[1] === undefined ? undefined : decodeEntities(m[1])
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`
}
