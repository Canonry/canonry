import http from 'node:http'
import type net from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
  /** Which TCP connection, numbered from 1 in the order clients opened them, carried the request. */
  connection: number
}

export interface RecordingSite {
  port: number
  /** Every request the site received, in arrival order. */
  requests: RecordedRequest[]
  close: () => Promise<void>
}

/**
 * A real HTTP site on 127.0.0.1 that records each request before `respond`
 * answers it, so a test can prove that a refused hop never reached it.
 * `http://0.0.0.0:<port>` reaches the same socket, which makes that spelling an
 * internal redirect target a test can observe even while loopback is admitted.
 */
export async function startRecordingSite(
  respond: (request: RecordedRequest, response: http.ServerResponse, port: number) => void,
): Promise<RecordingSite> {
  const requests: RecordedRequest[] = []
  const connections = new WeakMap<net.Socket, number>()
  let opened = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const request: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        connection: connections.get(req.socket)!,
      }
      requests.push(request)
      respond(request, res, port)
    })
  })
  server.on('connection', (socket) => {
    opened += 1
    connections.set(socket, opened)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
