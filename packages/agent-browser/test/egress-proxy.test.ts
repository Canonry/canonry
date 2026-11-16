import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createEgressGate, startEgressProxy } from '../src/index.js'
import type { EgressProxy, EgressVerdict } from '../src/index.js'

// Every connection the check browser makes goes through this proxy, so it is the egress
// boundary: it must refuse what the policy refuses, reach nothing when it does, and dial only
// the address the policy vetted (the hosts below do not resolve, so a pass proves the pin).
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const listen = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
const closing = (server: net.Server) => () => new Promise<void>((resolve) => server.close(() => resolve()))

async function httpUpstream() {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.headers.host} ${req.url}`)
    res.end('from upstream')
  })
  const port = await listen(server)
  closers.push(closing(server))
  return { port, seen }
}

async function echoUpstream() {
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    socket.pipe(socket)
  })
  const port = await listen(server)
  closers.push(closing(server))
  return { port, connections: () => connections }
}

async function proxyWith(policy: (host: string, port: number) => EgressVerdict | Promise<EgressVerdict>) {
  const asked: string[] = []
  const refused: string[] = []
  const gate = createEgressGate(async (host, port) => {
    asked.push(`${host}:${port}`)
    return policy(host, port)
  })
  const proxy = await startEgressProxy(gate, (target, reason) => refused.push(`${target}: ${reason}`))
  closers.push(() => proxy.close())
  return { proxy, asked, refused }
}

/** A plain-HTTP request in absolute form, the way a browser sends one to its proxy. */
function getVia(proxy: EgressProxy, url: string, headers: Record<string, string> = {}) {
  const at = new URL(proxy.url)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: at.hostname, port: Number(at.port), method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Opens a CONNECT tunnel, sends `payload` through it, and returns the proxy's status line and what came back. */
function tunnelVia(proxy: EgressProxy, authority: string, payload: string) {
  const at = new URL(proxy.url)
  return new Promise<{ status: string; echoed: string }>((resolve, reject) => {
    const socket = net.connect(Number(at.port), at.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    let buffer = ''
    let status = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (!status && buffer.includes('\r\n\r\n')) {
        status = buffer.slice(0, buffer.indexOf('\r\n'))
        buffer = buffer.slice(buffer.indexOf('\r\n\r\n') + 4)
        if (status.includes(' 200 ')) socket.write(payload)
      }
      if (status.includes(' 200 ') && buffer === payload) socket.end()
    })
    socket.on('close', () => resolve({ status, echoed: buffer }))
    socket.on('error', reject)
  })
}

describe('startEgressProxy', () => {
  it('forwards plain HTTP to the vetted address with the original Host header', async () => {
    const upstream = await httpUpstream()
    const { proxy } = await proxyWith((host, port) => (host === 'site.invalid' && port === upstream.port ? { ok: true, address: '127.0.0.1' } : { ok: false, reason: 'not vetted' }))
    expect(await getVia(proxy, `http://site.invalid:${upstream.port}/page?q=1`)).toEqual({ status: 200, body: 'from upstream' })
    expect(upstream.seen).toEqual([`GET site.invalid:${upstream.port} /page?q=1`])
  })

  it('refuses plain HTTP the policy refuses, and the request reaches nothing', async () => {
    const upstream = await httpUpstream()
    const { proxy, refused } = await proxyWith(() => ({ ok: false, reason: 'which is loopback' }))
    expect((await getVia(proxy, `http://127.0.0.1:${upstream.port}/admin`)).status).toBe(403)
    expect(upstream.seen).toEqual([])
    expect(refused).toEqual([`127.0.0.1:${upstream.port}: which is loopback`])
  })

  it('tunnels CONNECT (HTTPS and WebSockets) only to a vetted address', async () => {
    const upstream = await echoUpstream()
    const { proxy, refused } = await proxyWith((host) => (host === 'tunnel.invalid' ? { ok: true, address: '127.0.0.1' } : { ok: false, reason: 'which is loopback' }))
    expect(await tunnelVia(proxy, `tunnel.invalid:${upstream.port}`, 'ping')).toEqual({ status: 'HTTP/1.1 200 Connection Established', echoed: 'ping' })
    expect(await tunnelVia(proxy, `127.0.0.1:${upstream.port}`, 'ping')).toEqual({ status: 'HTTP/1.1 403 Forbidden', echoed: '' })
    expect(upstream.connections()).toBe(1)
    expect(refused).toEqual([`127.0.0.1:${upstream.port}: which is loopback`])
  })

  it('refuses a WebSocket upgrade sent outside a tunnel', async () => {
    const upstream = await httpUpstream()
    const { proxy } = await proxyWith(() => ({ ok: true, address: '127.0.0.1' }))
    const answer = await getVia(proxy, `http://site.invalid:${upstream.port}/socket`, { connection: 'Upgrade', upgrade: 'websocket' })
    expect(answer.status).toBe(403)
    expect(upstream.seen).toEqual([])
  })

  it('asks the policy once per host and port in a run, and refuses when the check itself fails', async () => {
    const upstream = await httpUpstream()
    const { proxy, asked } = await proxyWith(() => ({ ok: true, address: '127.0.0.1' }))
    await getVia(proxy, `http://site.invalid:${upstream.port}/a`)
    await getVia(proxy, `http://site.invalid:${upstream.port}/b`)
    expect(asked).toEqual([`site.invalid:${upstream.port}`])

    const broken = await proxyWith(() => Promise.reject(new Error('resolver down')))
    expect((await getVia(broken.proxy, `http://site.invalid:${upstream.port}/a`)).status).toBe(403)
    expect(broken.refused).toEqual([`site.invalid:${upstream.port}: the address check failed: resolver down`])
  })
})
