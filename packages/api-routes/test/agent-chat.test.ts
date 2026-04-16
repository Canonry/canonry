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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts } satisfies ApiRoutesOptions)

  return { app, tmpDir }
}

describe('POST /agent/chat', () => {
  it('returns 404 when agent is not configured', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { message: 'hello' },
    })
    // Route not registered — Fastify returns 404
    expect(res.statusCode).toBe(404)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects empty message', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19996,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { message: '' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects missing message field', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19996,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { context: { page: '/dashboard' } },
    })
    expect(res.statusCode).toBe(400)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway token is missing', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19996,
      // no agentGatewayToken
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { message: 'hello' },
    })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')
    expect(body.error.message).toContain('canonry agent setup')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 503 when gateway is unreachable', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19996,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { message: 'hello', stream: false },
    })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error.code).toBe('AGENT_UNAVAILABLE')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns non-streaming response from gateway', async () => {
    const mockGateway = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          const parsed = JSON.parse(body)
          // Verify headers
          expect(req.headers['authorization']).toBe('Bearer test-token')
          expect(req.headers['x-openclaw-session-key']).toBe('agent:aero:main')
          expect(req.headers['x-openclaw-message-channel']).toBe('webchat')
          expect(parsed.stream).toBe(false)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg-123',
            choices: [{ message: { content: 'Hello from Aero!' } }],
          }))
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => mockGateway.listen(19995, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19995,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: { message: 'hello', stream: false },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.content).toBe('Hello from Aero!')
    expect(body.messageId).toBe('msg-123')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('builds system message from context', async () => {
    let receivedMessages: Array<{ role: string; content: string }> = []

    const mockGateway = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        receivedMessages = parsed.messages
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg-456',
          choices: [{ message: { content: 'Got it' } }],
        }))
      })
    })
    await new Promise<void>((resolve) => mockGateway.listen(19994, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19994,
      agentGatewayToken: 'test-token',
    })
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/chat',
      payload: {
        message: 'analyze this',
        context: {
          page: '/projects/mysite',
          projectName: 'mysite',
          insightId: 'ins-1',
        },
        stream: false,
      },
    })

    expect(receivedMessages).toHaveLength(2)
    expect(receivedMessages[0].role).toBe('system')
    expect(receivedMessages[0].content).toContain('mysite')
    expect(receivedMessages[0].content).toContain('ins-1')
    expect(receivedMessages[1].role).toBe('user')
    expect(receivedMessages[1].content).toBe('analyze this')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
