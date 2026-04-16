import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-events-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts } satisfies ApiRoutesOptions)

  return { app, tmpDir }
}

describe('GET /agent/events', () => {
  it('returns 404 when agent is not configured', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/events' })
    expect(res.statusCode).toBe(404)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway token is missing', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19984,
      // no agentGatewayToken
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/events' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway is unreachable', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19984,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/events' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('pipes SSE events from gateway', async () => {
    const mockGateway = http.createServer((req, res) => {
      // Verify headers
      expect(req.headers['accept']).toBe('text/event-stream')
      expect(req.headers['authorization']).toBe('Bearer test-token')
      expect(req.url).toContain('/sessions/agent%3Aaero%3Amain/history')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      // Send initial history event (OpenClaw 2026.4.x+ shape)
      res.write('event: history\ndata: {"sessionKey":"agent:aero:main","items":[{"role":"user","content":"Hello","timestamp":1713200000,"__openclaw":{"id":"entry-1","seq":1}}],"hasMore":false}\n\n')
      // Send a live message event (OpenClaw 2026.4.x+ shape)
      res.write('event: message\ndata: {"sessionKey":"agent:aero:main","message":{"role":"assistant","content":"Hi there!","timestamp":1713200010,"__openclaw":{"id":"msg-1","seq":2}},"messageId":"msg-1","messageSeq":2}\n\n')
      // Close the stream
      res.end()
    })
    await new Promise<void>((resolve) => mockGateway.listen(19983, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19983,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/events' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.headers['cache-control']).toBe('no-cache')

    // Verify SSE content was piped through
    const body = res.body
    expect(body).toContain('event: history')
    expect(body).toContain('"sessionKey":"agent:aero:main"')
    expect(body).toContain('event: message')
    expect(body).toContain('"messageId":"msg-1"')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('aborts upstream fetch when client disconnects', async () => {
    let requestAborted = false

    const mockGateway = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      res.write('event: history\ndata: {"sessionKey":"test","items":[],"hasMore":false}\n\n')

      // Keep connection open, detect abort
      req.on('close', () => {
        requestAborted = true
      })
    })
    await new Promise<void>((resolve) => mockGateway.listen(19982, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19982,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    // Use a raw HTTP request so we can abort it
    await app.listen({ port: 0 })
    const actualPort = (app.server.address() as { port: number }).port

    const controller = new AbortController()
    const fetchPromise = fetch(`http://localhost:${actualPort}/api/v1/agent/events`, {
      signal: controller.signal,
    })

    // Wait a bit for the connection to establish, then abort
    await new Promise((resolve) => setTimeout(resolve, 200))
    controller.abort()

    try {
      await fetchPromise
    } catch {
      // Expected — fetch was aborted
    }

    // Give the server a moment to process the disconnect
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(requestAborted).toBe(true)

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
