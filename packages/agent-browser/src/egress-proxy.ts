// The check browser's only way out. Chrome is launched with this proxy for every connection,
// loopback included (see launchChrome), so the host's egress policy applies to everything the
// browser sends: pages, iframes, workers, service workers, WebSockets and beacons alike, whether
// or not DevTools can see the request. The proxy dials the address the policy vetted, never a
// second DNS answer, so a name cannot pass the check and then resolve somewhere internal.

import http from 'node:http'
import net from 'node:net'
import { describeError } from '@canonry/canonry-contracts'

/** Where the policy lets the browser connect for one host and port: the vetted address to dial, or why not. */
export type EgressVerdict = { ok: true; address: string } | { ok: false; reason: string }

/** The host's outbound address policy for one host and port. */
export type EgressCheck = (host: string, port: number) => Promise<EgressVerdict>

/** Asks the policy once per host and port for one agent run; a check that throws is a refusal. */
export type EgressGate = (host: string, port: number) => Promise<EgressVerdict>

export function createEgressGate(check: EgressCheck): EgressGate {
  const verdicts = new Map<string, Promise<EgressVerdict>>()
  return (host, port) => {
    const key = `${host.toLowerCase()}:${port}`
    let verdict = verdicts.get(key)
    if (!verdict) {
      verdict = check(host, port).catch((err: unknown): EgressVerdict => ({ ok: false, reason: `the address check failed: ${describeError(err)}` }))
      verdicts.set(key, verdict)
    }
    return verdict
  }
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for Chrome's `--proxy-server`. */
  url: string
  close(): Promise<void>
}

const stripBrackets = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)

/** `host:port` of a CONNECT request, or null when it cannot be read. */
function connectTarget(authority: string | undefined): { host: string; port: number } | null {
  if (!authority) return null
  try {
    const url = new URL(`http://${authority}`)
    const port = Number(url.port)
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return null
    return { host: stripBrackets(url.hostname), port }
  } catch {
    return null
  }
}

const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

/**
 * Starts the proxy on a free loopback port. `onRefused` hears about every connection the
 * policy refused, for the run's evidence.
 */
export async function startEgressProxy(gate: EgressGate, onRefused: (target: string, reason: string) => void = () => undefined): Promise<EgressProxy> {
  const sockets = new Set<net.Socket>()
  const server = http.createServer()
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  // HTTPS and WebSockets arrive as CONNECT tunnels.
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy())
    const target = connectTarget(req.url)
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
      return
    }
    void gate(target.host, target.port).then((verdict) => {
      if (!verdict.ok) {
        onRefused(`${target.host}:${target.port}`, verdict.reason)
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const upstream = net.connect({ host: verdict.address, port: target.port })
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      })
      client.once('close', () => upstream.destroy())
    })
  })

  // A plain-HTTP upgrade outside a tunnel is never let through.
  server.on('upgrade', (req: http.IncomingMessage, client: net.Socket) => {
    onRefused(req.url ?? '', 'upgrades outside a tunnel are refused')
    client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
  })

  // Plain HTTP arrives in absolute form: GET http://host/path.
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    const host = stripBrackets(url.hostname)
    const port = url.port ? Number(url.port) : 80
    void gate(host, port).then((verdict) => {
      if (!verdict.ok) {
        onRefused(`${host}:${port}`, verdict.reason)
        res.writeHead(403).end()
        return
      }
      const headers: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value
      headers.host = url.host
      const upstream = http.request({ host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
