/**
 * Tunnel authentication, end to end, with the real remote router:
 *
 *   test client ──(local gateway key)──▶ Gateway (127.0.0.1)
 *        ──(SESSION_BEARER_TOKEN + curl UA + bypass headers)──▶ router.py
 *        ──(token)──▶ fake vLLM / fake llama-server
 *
 * The router test is skipped automatically where python3 + aiohttp are absent.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Gateway, hostAllowed, keyMatches, TUNNEL_HEADERS } from '../src/gateway.ts'

const TOKEN = 'session-token-0123456789abcdef0123456789abcdef'
const LOCAL_KEY = 'local-gateway-key-abcdef'
const ROUTER = fileURLToPath(new URL('../remote/router.py', import.meta.url))
const HAS_ROUTER_DEPS = spawnSync('python3', ['-c', 'import aiohttp'], { stdio: 'ignore' }).status === 0

interface Seen { path: string; headers: IncomingHttpHeaders; body: string }

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const s = createServer()
  const port = await listen(s)
  await new Promise<void>(resolve => s.close(() => resolve()))
  return port
}

/** Fake model server: checks the bearer, streams reasoning + content deltas. */
function fakeModel(name: string, seen: Seen[]): Server {
  return createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      if (req.url === '/health') { res.writeHead(200).end('ok'); return }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = [
        { choices: [{ delta: { reasoning_content: 'eGFR from the deterministic engine…' } }] },
        { choices: [{ delta: { content: `answer from ${name}` } }] },
      ]
      let i = 0
      const timer = setInterval(() => {
        if (i < chunks.length) res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`)
        else { res.end('data: [DONE]\n\n'); clearInterval(timer) }
      }, 20)
    })
  })
}

function rawRequest(port: number, opts: { host?: string; auth?: string; path?: string; method?: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: opts.path ?? '/v1/chat/completions', method: opts.method ?? 'POST',
      headers: { host: opts.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json', ...(opts.auth ? { authorization: opts.auth } : {}) },
    }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(opts.body ?? '{"model":"ii-medical-8b","messages":[]}')
  })
}

describe('gateway guards (unit)', () => {
  it('compares keys in constant time and rejects blanks', () => {
    expect(keyMatches('abc', 'abc')).toBe(true)
    expect(keyMatches('abc', 'abd')).toBe(false)
    expect(keyMatches(undefined, 'abc')).toBe(false)
    expect(keyMatches('abc', undefined)).toBe(false)
  })

  it('only accepts loopback Host headers on its own port (DNS-rebinding defence)', () => {
    expect(hostAllowed('127.0.0.1:47800', 47800)).toBe(true)
    expect(hostAllowed('localhost:47800', 47800)).toBe(true)
    expect(hostAllowed('evil.example:47800', 47800)).toBe(false)
    expect(hostAllowed('127.0.0.1:1234', 47800)).toBe(false)
    expect(hostAllowed(undefined, 47800)).toBe(false)
  })

  it('sends the Cloudflare/ngrok interstitial bypass headers', () => {
    expect(TUNNEL_HEADERS['user-agent']).toBe('curl/8.0.0')
    expect(TUNNEL_HEADERS['ngrok-skip-browser-warning']).toBe('true')
  })
})

describe('gateway without a running node', () => {
  let gateway: Gateway
  let port: number
  beforeAll(async () => {
    gateway = new Gateway({ port: 0, upstream: () => undefined, localKey: async () => LOCAL_KEY, notReadyMessage: () => 'not running' })
    port = await gateway.listen()
  })
  afterAll(async () => { await gateway.close() })

  it('401 without the local key, 421 for a foreign Host, 503 while not ready', async () => {
    expect((await rawRequest(port, {})).status).toBe(401)
    expect((await rawRequest(port, { auth: 'Bearer wrong' })).status).toBe(401)
    expect((await rawRequest(port, { auth: `Bearer ${LOCAL_KEY}`, host: 'attacker.example' })).status).toBe(421)
    const res = await rawRequest(port, { auth: `Bearer ${LOCAL_KEY}` })
    expect(res.status).toBe(503)
    expect(res.body).toContain('not running')
  })

  it('exposes only the OpenAI inference paths', async () => {
    expect((await rawRequest(port, { auth: `Bearer ${LOCAL_KEY}`, path: '/admin/shutdown' })).status).toBe(404)
    expect((await rawRequest(port, { auth: `Bearer ${LOCAL_KEY}`, path: '/v1/models', method: 'POST' })).status).toBe(405)
  })
})

describe('gateway → interstitial page', () => {
  it('turns an HTML answer into a 503 instead of streaming garbage', async () => {
    const html = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Just a moment...</html>') })
    const htmlPort = await listen(html)
    const results: string[] = []
    const gateway = new Gateway({ port: 0, upstream: () => ({ url: `http://127.0.0.1:${htmlPort}`, token: TOKEN }), localKey: async () => LOCAL_KEY, onResult: (_ok, d) => results.push(d) })
    const port = await gateway.listen()
    try {
      const res = await rawRequest(port, { auth: `Bearer ${LOCAL_KEY}` })
      expect(res.status).toBe(503)
      expect(res.body).toMatch(/web page instead of the model API/)
      expect(results[0]).toMatch(/interstitial/)
    } finally {
      await gateway.close()
      html.close()
    }
  })
})

describe.skipIf(!HAS_ROUTER_DEPS)('router.py + gateway end to end', () => {
  const reasonerSeen: Seen[] = []
  const visionSeen: Seen[] = []
  const reasoner = fakeModel('reasoner', reasonerSeen)
  const vision = fakeModel('vision', visionSeen)
  let router: ChildProcess
  let routerPort: number
  let gateway: Gateway
  let gatewayPort: number
  let routerLog = ''

  beforeAll(async () => {
    const [rp, vp] = [await listen(reasoner), await listen(vision)]
    routerPort = await freePort()
    router = spawn('python3', [ROUTER], {
      env: {
        ...process.env, SESSION_BEARER_TOKEN: TOKEN, ROUTER_PORT: String(routerPort),
        REASONER_URL: `http://127.0.0.1:${rp}`, VISION_URL: `http://127.0.0.1:${vp}`,
        REASONER_NAME: 'ii-medical-8b', VISION_NAME: 'medgemma-1.5-4b',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`router did not start:\n${routerLog}`)), 15_000)
      const onData = (c: Buffer): void => {
        routerLog += c.toString()
        if (routerLog.includes('"listening"')) { clearTimeout(timer); resolve() }
      }
      router.stdout?.on('data', onData)
      router.stderr?.on('data', onData)
    })
    gateway = new Gateway({ port: 0, upstream: () => ({ url: `http://127.0.0.1:${routerPort}`, token: TOKEN }), localKey: async () => LOCAL_KEY })
    gatewayPort = await gateway.listen()
  }, 30_000)

  afterAll(async () => {
    await gateway?.close()
    router?.kill('SIGTERM')
    reasoner.close()
    vision.close()
  })

  it('router refuses every request without the exact session token — health included', async () => {
    const base = `http://127.0.0.1:${routerPort}`
    expect((await fetch(`${base}/healthz`)).status).toBe(401)
    expect((await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401)
    expect((await fetch(`${base}/healthz`, { headers: { authorization: TOKEN } })).status).toBe(401)
    expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(401)
    const ok = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, models: { 'ii-medical-8b': true, 'medgemma-1.5-4b': true } })
  })

  it('streams reasoning deltas through gateway → router → reasoner with the session token injected', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'ii-medical-8b', stream: true, messages: [{ role: 'user', content: 'test' }] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('reasoning_content')
    expect(text).toContain('answer from reasoner')
    expect(text).toContain('[DONE]')
    const call = reasonerSeen.find(s => s.path === '/v1/chat/completions')
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call?.headers['user-agent']).toBe('curl/8.0.0')
    expect(call?.headers['ngrok-skip-browser-warning']).toBe('true')
    // The local gateway key never leaves the machine.
    expect(JSON.stringify(reasonerSeen)).not.toContain(LOCAL_KEY)
  })

  it('routes by model name and rejects unknown models', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'medgemma-1.5-4b', messages: [] }),
    })
    expect(await res.text()).toContain('answer from vision')
    const unknown = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    })
    expect(unknown.status).toBe(404)
  })

  it('never logs request bodies or the token', () => {
    expect(routerLog).not.toContain(TOKEN)
    expect(routerLog).not.toContain('"content"')
  })
})

describe.skipIf(!HAS_ROUTER_DEPS)('router.py lifecycle', () => {
  async function startRouter(extra: Record<string, string>): Promise<{ proc: ChildProcess; port: number; exited: Promise<number | null> }> {
    const port = await freePort()
    const proc = spawn('python3', [ROUTER], { env: { ...process.env, SESSION_BEARER_TOKEN: TOKEN, ROUTER_PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number | null>(resolve => proc.on('exit', code => resolve(code)))
    let log = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log)), 15_000)
      proc.stdout?.on('data', (c: Buffer) => { log += c.toString(); if (log.includes('"listening"')) { clearTimeout(timer); resolve() } })
    })
    return { proc, port, exited }
  }

  it('/admin/shutdown (authenticated) stops the router cleanly', async () => {
    const { port, exited } = await startRouter({})
    expect((await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    expect(await exited).toBe(0)
  }, 20_000)

  it('idle watchdog stops a forgotten session (no GPU quota burned)', async () => {
    const { exited } = await startRouter({ IDLE_TIMEOUT: '0.5', WATCHDOG_INTERVAL: '0.2' })
    expect(await exited).toBe(0)
  }, 20_000)
})
