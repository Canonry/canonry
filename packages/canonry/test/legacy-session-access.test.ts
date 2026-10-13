import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, auditLog, createClient, dashboardSessions, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { hashSessionToken } from '@ainyc/canonry-api-routes'
import { createServer } from '../src/server.js'
import { operationAccess } from '@ainyc/canonry-contracts'

describe('legacy dashboard session operation boundary', () => {
  let dir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let rawKey: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-session-access-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', dir)
    const database = path.join(dir, 'test.db')
    db = createClient(database)
    migrate(db)
    rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'root',
      keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    app = await createServer({
      config: { apiUrl: 'http://localhost:4100', basePath: '/canonry', database, apiKey: rawKey, providers: {} },
      db,
      logger: false,
    })
  })

  afterEach(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('classifies and labels every root session route as a write under a base path', async () => {
    expect(operationAccess('GET', '/api/v1/session')).toBe('write')

    const requests = [
      { method: 'GET' as const, url: '/canonry/api/v1/session' },
      { method: 'POST' as const, url: '/canonry/api/v1/session/setup', payload: {} },
      { method: 'POST' as const, url: '/canonry/api/v1/session', payload: {} },
      { method: 'DELETE' as const, url: '/canonry/api/v1/session' },
    ]
    for (const request of requests) {
      const response = await app.inject(request)
      expect(response.headers['x-canonry-access'], `${request.method} ${request.url}`).toBe('write')
    }
  })

  it.each(['1', 'true'] as const)('refuses stored-only session setup, login, logout, and expired-session reads before any state change for header %s', async (storedOnlyValue) => {
    const sessionToken = 'expired-session-fixture'
    db.insert(dashboardSessions).values({
      tokenHash: hashSessionToken(sessionToken),
      apiKeyId: db.select({ id: apiKeys.id }).from(apiKeys).get()!.id,
      apiKeyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      passwordFingerprint: null,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).run()
    const beforeSessions = db.select().from(dashboardSessions).all()
    const beforeKeys = db.select().from(apiKeys).all()
    const beforeAudit = db.select().from(auditLog).all()
    const beforeConfig = fs.existsSync(path.join(dir, 'config.yaml'))
      ? fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
      : null
    const storedOnly = { 'x-canonry-stored-only': storedOnlyValue, authorization: `Bearer ${rawKey}` }

    const refused = [
      await app.inject({ method: 'GET', url: '/canonry/api/v1/session', headers: { ...storedOnly, cookie: `canonry_session=${sessionToken}` } }),
      await app.inject({ method: 'POST', url: '/canonry/api/v1/session/setup', headers: storedOnly, payload: { password: 'operator-password' } }),
      await app.inject({ method: 'POST', url: '/canonry/api/v1/session', headers: storedOnly, payload: { apiKey: rawKey } }),
      await app.inject({ method: 'DELETE', url: '/canonry/api/v1/session', headers: { ...storedOnly, cookie: `canonry_session=${sessionToken}` } }),
    ]
    for (const response of refused) {
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('STORED_ONLY_REFUSED')
      expect(response.headers['x-canonry-access']).toBe('write')
    }
    expect(db.select().from(dashboardSessions).all()).toEqual(beforeSessions)
    expect(db.select().from(apiKeys).all()).toEqual(beforeKeys)
    expect(db.select().from(auditLog).all()).toEqual(beforeAudit)
    expect(fs.existsSync(path.join(dir, 'config.yaml'))
      ? fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
      : null).toBe(beforeConfig)
  })

  it('keeps ordinary unflagged session authentication working', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/canonry/api/v1/session',
      payload: { apiKey: rawKey },
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies.find(entry => entry.name === 'canonry_session')
    expect(cookie).toBeDefined()
    const status = await app.inject({ method: 'GET', url: '/canonry/api/v1/session', headers: { cookie: `canonry_session=${cookie!.value}` } })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ authenticated: true })
  })
})
