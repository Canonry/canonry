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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcript-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts } satisfies ApiRoutesOptions)

  return { app, tmpDir }
}

describe('GET /agent/transcript', () => {
  it('returns 404 when agent is not configured', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/transcript' })
    expect(res.statusCode).toBe(404)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway token is missing', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19993,
      // no agentGatewayToken
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/transcript' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway is unreachable', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19993,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/transcript' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty messages when session not found (404)', async () => {
    const mockGateway = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'session not found' }))
    })
    await new Promise<void>((resolve) => mockGateway.listen(19992, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19992,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/transcript' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.messages).toEqual([])

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('maps OpenClaw transcript messages to canonry DTOs', async () => {
    const mockHistory = {
      sessionKey: 'agent:aero:main',
      items: [
        {
          role: 'user',
          content: 'Hello',
          timestamp: 1713200000,
          __openclaw: { id: 'entry-1', seq: 1 },
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there! How can I help?' }],
          timestamp: 1713200010,
          __openclaw: { id: 'entry-2', seq: 2 },
        },
        {
          role: 'user',
          content: 'Run a sweep',
          timestamp: 1713200020,
          __openclaw: { id: 'entry-3', seq: 3 },
        },
      ],
      messages: [], // alias — items takes precedence
      hasMore: false,
    }

    let receivedUrl = ''
    const mockGateway = http.createServer((req, res) => {
      receivedUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mockHistory))
    })
    await new Promise<void>((resolve) => mockGateway.listen(19991, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19991,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/transcript?limit=10',
    })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.messages).toHaveLength(3)

    // Verify roles come from the message itself (not index-based)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[1].role).toBe('assistant')
    expect(body.messages[2].role).toBe('user')

    // Verify content mapping — including content-block extraction
    expect(body.messages[0].content).toBe('Hello')
    expect(body.messages[0].id).toBe('entry-1')
    expect(body.messages[0].seq).toBe(1)

    expect(body.messages[1].content).toBe('Hi there! How can I help?')
    expect(body.messages[1].id).toBe('entry-2')

    // Verify lastMessageId
    expect(body.lastMessageId).toBe('entry-3')

    // Verify limit was passed through to gateway
    expect(receivedUrl).toContain('limit=10')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes cursor through to gateway and returns nextCursor', async () => {
    let receivedUrl = ''
    const mockGateway = http.createServer((req, res) => {
      receivedUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sessionKey: 'agent:aero:main',
        items: [
          {
            role: 'user',
            content: 'Earlier message',
            timestamp: 1713100000,
            __openclaw: { id: 'entry-old', seq: 1 },
          },
        ],
        hasMore: true,
        nextCursor: '5',
      }))
    })
    await new Promise<void>((resolve) => mockGateway.listen(19990, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19990,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/transcript?cursor=abc123&limit=25',
    })

    expect(receivedUrl).toContain('cursor=abc123')
    expect(receivedUrl).toContain('limit=25')

    const body = res.json()
    expect(body.cursor).toBe('5')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generates fallback IDs when __openclaw metadata is missing', async () => {
    const mockHistory = {
      sessionKey: 'agent:aero:main',
      items: [
        { role: 'user', content: 'Hello' },
      ],
    }

    const mockGateway = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mockHistory))
    })
    await new Promise<void>((resolve) => mockGateway.listen(19989, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19989,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/transcript' })
    const body = res.json()
    expect(body.messages[0].id).toBe('seq-0')
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toBe('Hello')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
