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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts } satisfies ApiRoutesOptions)

  return { app, tmpDir }
}

describe('GET /agent/status', () => {
  it('returns configured: false when no agent config', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.configured).toBe(false)
    expect(body.gatewayState).toBe('unknown')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns needs-setup when port set but no token', async () => {
    const { app, tmpDir } = buildApp({ agentGatewayPort: 19999 })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.configured).toBe(true)
    expect(body.gatewayState).toBe('needs-setup')
    expect(body.port).toBe(19999)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns stopped when gateway is unreachable', async () => {
    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19998,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.configured).toBe(true)
    expect(body.gatewayState).toBe('stopped')
    expect(body.port).toBe(19998)
    expect(body.sessionKey).toBe('agent:aero:main')

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns running when gateway responds', async () => {
    // Spin up a tiny HTTP server to mock the gateway health endpoint
    const mockGateway = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((resolve) => mockGateway.listen(19997, resolve))

    const { app, tmpDir } = buildApp({
      agentGatewayPort: 19997,
      agentGatewayToken: 'test-token',
      agentSessionKey: 'agent:aero:main',
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/agent/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.configured).toBe(true)
    expect(body.gatewayState).toBe('running')

    await app.close()
    await new Promise<void>((resolve) => mockGateway.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
