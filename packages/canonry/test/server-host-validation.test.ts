import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

describe('server request Host and Origin validation', () => {
  let tmpDir: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  let db: DatabaseClient | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-host-validation-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_DASHBOARD_REQUIRE_PASSWORD', '1')
    vi.stubEnv('DO_NOT_TRACK', '1')
    for (const key of ['CANONRY_BASE_PATH', 'CANONRY_TRUST_PROXY', 'CANONRY_EMBED',
      'CANONRY_EMBED_ORIGINS', 'CANONRY_EMBED_VIEWS', 'CANONRY_EMBED_PROJECT_TABS']) {
      vi.stubEnv(key, undefined)
    }
  })

  afterEach(async () => {
    await app?.close()
    db?.$client.close()
    app = undefined
    db = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  async function buildServer(host?: string, configPatch: Partial<CanonryConfig> = {}) {
    const database = path.join(tmpDir, 'test.db')
    db = createClient(database)
    migrate(db)
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(), name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
    }).run()
    const config: CanonryConfig = {
      apiUrl: 'http://localhost:4100', database, apiKey, telemetry: false, updateCheck: false,
      ...configPatch,
    }
    app = await createServer({ config, db, host, logger: false, assetsDir: path.join(tmpDir, 'assets') })
    return { app, config, authorization: `Bearer ${apiKey}` }
  }

  it.each([
    { name: 'default localhost', requestHost: 'localhost:4100' },
    { name: 'localhost with a remote API URL', requestHost: 'localhost:4100', config: { apiUrl: 'https://api.example' } },
    { name: 'loopback address', requestHost: '127.5.6.7:4100' },
    { name: 'LAN address on an IPv4 wildcard bind', host: '0.0.0.0', requestHost: '192.168.1.10:4100' },
    { name: 'public IPv4 literal', requestHost: '203.0.113.15:4100' },
    {
      name: 'bracketed IPv6 public URL on an IPv6 wildcard bind', host: '::',
      requestHost: '[2001:db8::1]:4100', config: { publicUrl: 'http://[2001:db8::1]:4100' },
    },
    { name: 'configured DNS bind', host: 'canonry.internal', requestHost: 'canonry.internal:4100' },
    {
      name: 'configured API hostname including www', requestHost: 'www.canonry.example:4100',
      config: { apiUrl: 'http://www.canonry.example:4100' },
    },
    {
      name: 'TLS proxy with a base path', requestHost: 'canonry.example', origin: 'https://canonry.example',
      config: { publicUrl: 'https://canonry.example/canonry/', basePath: '/canonry/' },
    },
  ])('serves authenticated API reads through $name', async ({ host, requestHost, origin, config: patch }) => {
    const { app: server, config, authorization } = await buildServer(host, patch)
    const response = await server.inject({
      method: 'GET', url: `${config.basePath ?? '/'}api/v1/projects`,
      headers: { host: requestHost, authorization, ...(origin ? { origin } : {}) },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it.each([
    { requestHost: 'attacker.example:4100', config: {} },
    { requestHost: 'localhost.attacker.example:4100', config: {} },
    { requestHost: 'canonry.example:4100', config: { apiUrl: 'http://www.canonry.example:4100' } },
  ])('rejects unconfigured DNS Host $requestHost despite valid credentials', async ({ requestHost, config }) => {
    const { app: server, authorization } = await buildServer(undefined, config)
    const response = await server.inject({
      method: 'GET', url: '/api/v1/projects', headers: { host: requestHost, authorization },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Unexpected Host header' } })
  })

  it('blocks first-run password setup through a rebound Host even when Origin matches it', async () => {
    const { app: server, config } = await buildServer()
    const response = await server.inject({
      method: 'POST', url: '/api/v1/session/setup', payload: { password: 'attacker-password' },
      headers: { host: 'attacker.example:4100', origin: 'http://attacker.example:4100' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Unexpected Host header' } })
    expect(response.cookies).toEqual([])
    expect(config.dashboardPasswordHash).toBeUndefined()
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
  })

  it.each([
    { origin: 'https://attacker.example', message: 'Cross-origin request refused' },
    { origin: 'null', message: 'Invalid Origin header' },
  ])('rejects Origin $origin on an allowed Host', async ({ origin, message }) => {
    const { app: server, authorization } = await buildServer()
    const response = await server.inject({
      method: 'GET', url: '/api/v1/projects',
      headers: { host: 'localhost:4100', origin, authorization },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'FORBIDDEN', message } })
  })

  it('allows only the configured full embed Origin, preserving its scheme and port', async () => {
    const { app: server, authorization } = await buildServer(undefined, {
      embed: { enabled: true, allowOrigins: ['https://portal.example:8443'] },
    })
    const allowed = await server.inject({
      method: 'GET', url: '/api/v1/projects',
      headers: { host: 'localhost:4100', origin: 'https://portal.example:8443', authorization },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toEqual([])
    for (const origin of ['http://portal.example:8443', 'https://portal.example:9443']) {
      const refused = await server.inject({
        method: 'GET', url: '/api/v1/projects', headers: { host: 'localhost:4100', origin, authorization },
      })
      expect(refused.statusCode, origin).toBe(403)
      expect(refused.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } })
    }
  })
})
