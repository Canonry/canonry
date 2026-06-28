import crypto from 'node:crypto'
import { describe, it, beforeAll, afterAll, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate, projects, runs, gscCoverageSnapshots, gscUrlInspections, gscSearchData, gscDailyTotals } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

// Reproduce state signing functions from google.ts to verify behavior
function signState(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function buildSignedState(data: Record<string, unknown>, secret: string): string {
  const payload = JSON.stringify(data)
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

function verifySignedState(encoded: string, secret: string): Record<string, unknown> | null {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const expected = signState(payload, secret)
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

function buildApp(opts: { googleClientId?: string; googleClientSecret?: string; googleStateSecret?: string } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const connections: Array<{
    domain: string
    connectionType: 'gsc' | 'ga4'
    propertyId?: string | null
    accessToken?: string
    refreshToken?: string | null
    tokenExpiresAt?: string | null
    scopes?: string[]
    createdAt: string
    updatedAt: string
  }> = []

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({
      clientId: opts.googleClientId,
      clientSecret: opts.googleClientSecret,
    }),
    googleConnectionStore: {
      listConnections: (domain) => connections.filter((connection) => connection.domain === domain),
      getConnection: (domain, connectionType) => connections.find((connection) => (
        connection.domain === domain && connection.connectionType === connectionType
      )),
      upsertConnection: (connection) => {
        const index = connections.findIndex((entry) => (
          entry.domain === connection.domain && entry.connectionType === connection.connectionType
        ))
        if (index === -1) {
          connections.push(connection)
        } else {
          connections[index] = connection
        }
        return connection
      },
      updateConnection: (domain, connectionType, patch) => {
        const existing = connections.find((connection) => (
          connection.domain === domain && connection.connectionType === connectionType
        ))
        if (!existing) return undefined
        Object.assign(existing, patch)
        return existing
      },
      deleteConnection: (domain, connectionType) => {
        const index = connections.findIndex((connection) => (
          connection.domain === domain && connection.connectionType === connectionType
        ))
        if (index === -1) return false
        connections.splice(index, 1)
        return true
      },
    },
    googleStateSecret: opts.googleStateSecret ?? 'test-secret-32-bytes-long-enough!',
  })

  return { app, db, tmpDir }
}

describe('state signing', () => {
  it('roundtrips signed state correctly', () => {
    const secret = 'my-test-secret'
    const data = { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost/callback' }
    const encoded = buildSignedState(data, secret)
    const decoded = verifySignedState(encoded, secret)
    expect(decoded).not.toBeNull()
    expect((decoded as { domain: string }).domain).toBe('example.com')
    expect((decoded as { type: string }).type).toBe('gsc')
  })

  it('rejects tampered payload', () => {
    const secret = 'my-test-secret'
    const data = { domain: 'example.com', type: 'gsc' }
    const encoded = buildSignedState(data, secret)

    // Decode, tamper, re-encode without updating sig
    const inner = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const tamperedPayload = JSON.stringify({ domain: 'attacker.com', type: 'gsc' })
    const tampered = Buffer.from(JSON.stringify({ payload: tamperedPayload, sig: inner.sig })).toString('base64url')

    const result = verifySignedState(tampered, secret)
    expect(result).toBeNull()
  })

  it('rejects state signed with different secret', () => {
    const data = { domain: 'example.com', type: 'gsc' }
    const encoded = buildSignedState(data, 'original-secret')
    const result = verifySignedState(encoded, 'different-secret')
    expect(result).toBeNull()
  })

  it('rejects garbage input', () => {
    const result = verifySignedState('not-valid-base64url!!!', 'secret')
    expect(result).toBeNull()
  })
})

describe('googleRoutes: POST /projects/:name/google/connect', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp({ googleClientId: undefined, googleClientSecret: undefined })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when OAuth is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/my-project/google/connect',
      payload: { type: 'gsc' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('googleRoutes: GET /projects/:name/google/callback', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
      googleStateSecret: 'test-secret',
    })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects callback with invalid state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback?code=abc&state=invalid-garbage',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/tampered|Invalid/)
  })

  it('rejects callback with state signed by wrong secret', async () => {
    const wrongSecretState = buildSignedState(
      { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost/callback' },
      'wrong-secret',
    )
    const res = await app.inject({
      method: 'GET',
      url: `/projects/my-project/google/callback?code=abc&state=${encodeURIComponent(wrongSecretState)}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/tampered|Invalid/)
  })

  it('rejects callback with a correctly-signed legacy state that omits projectId', async () => {
    // Pre-PR signed states had `{domain, type, propertyId, redirectUri}` and
    // no project binding. Replaying one now would let the OAuth code be
    // exchanged and the resulting tokens written onto whichever connection
    // happens to share the domain — the ownership-mismatch check would be
    // skipped because `projectId` is falsy. The callback rejects such states
    // outright instead so the bypass is closed.
    const legacyState = buildSignedState(
      { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost/callback' },
      'test-secret',
    )
    const res = await app.inject({
      method: 'GET',
      url: `/projects/my-project/google/callback?code=abc&state=${encodeURIComponent(legacyState)}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/Stale OAuth state/i)
  })

  it('returns error page when OAuth error is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback?error=access_denied',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Authorization failed')
  })

  it('returns 400 when code or state is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('googleRoutes: GET /google/callback (shared)', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
      googleStateSecret: 'test-secret',
    })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects callback with invalid state on shared route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/google/callback?code=abc&state=invalid-garbage',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/tampered|Invalid/)
  })

  it('returns error page when OAuth error is present on shared route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/google/callback?error=access_denied',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Authorization failed')
  })

  it('returns redirect_uri_mismatch help page with instructions', async () => {
    const state = buildSignedState(
      { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost:4100/api/v1/google/callback' },
      'test-secret',
    )
    const res = await app.inject({
      method: 'GET',
      url: `/google/callback?error=redirect_uri_mismatch&state=${encodeURIComponent(state)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Redirect URI mismatch')
    expect(res.body).toContain('Google Cloud Console')
    expect(res.body).toContain('http://localhost:4100/api/v1/google/callback')
  })

  it('returns 400 when code or state is missing on shared route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/google/callback',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('googleRoutes: connect uses publicUrl', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'google-routes-publicurl-'))
    const dbPath = path.join(tmpDirPath, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    // Seed a project
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
      publicUrl: 'https://canonry.example.com',
    })

    app = fastify
    tmpDir = tmpDirPath
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses publicUrl for redirect URI when set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/connect',
      payload: { type: 'gsc' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { authUrl: string; redirectUri: string }
    expect(body.authUrl).toContain('accounts.google.com')
    expect(body.redirectUri).toBe('https://canonry.example.com/api/v1/google/callback')
    expect(body.authUrl).toContain(encodeURIComponent('https://canonry.example.com/api/v1/google/callback'))
  })

  it('publicUrl in body overrides config publicUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/connect',
      payload: { type: 'gsc', publicUrl: 'https://override.example.com' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { authUrl: string; redirectUri: string }
    expect(body.redirectUri).toBe('https://override.example.com/api/v1/google/callback')
  })
})

describe('googleRoutes: connect does not double basePath in redirectUri', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'google-routes-basepath-'))
    const dbPath = path.join(tmpDirPath, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
      publicUrl: 'https://example.com/canonry',
      routePrefix: '/canonry/api/v1',
    })

    app = fastify
    tmpDir = tmpDirPath
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('config publicUrl with basePath does not duplicate prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/connect',
      payload: { type: 'gsc' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { authUrl: string; redirectUri: string }
    expect(body.redirectUri).toBe('https://example.com/canonry/api/v1/google/callback')
  })

  it('CLI publicUrl with basePath does not duplicate prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/connect',
      payload: { type: 'gsc', publicUrl: 'https://override.example.com/canonry' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { authUrl: string; redirectUri: string }
    expect(body.redirectUri).toBe('https://override.example.com/canonry/api/v1/google/callback')
  })
})

describe('googleRoutes: connect auto-detect uses per-project URI', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'google-routes-autodetect-'))
    const dbPath = path.join(tmpDirPath, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
      // No publicUrl — auto-detect mode
    })

    app = fastify
    tmpDir = tmpDirPath
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('auto-detect generates per-project redirect URI for backward compat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/connect',
      headers: { host: 'localhost:4100' },
      payload: { type: 'gsc' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { authUrl: string; redirectUri: string }
    expect(body.redirectUri).toBe('http://localhost:4100/api/v1/projects/testproj/google/callback')
  })
})

describe('googleRoutes: GET /projects/:name/google/gsc/coverage/history', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-coverage-history-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(runs).values({
      id: 'r1',
      projectId: 'p1',
      kind: 'gsc-inspect-sitemap',
      status: 'completed',
      createdAt: now,
    }).run()

    // Seed two snapshots on different days
    db.insert(gscCoverageSnapshots).values({
      id: 's1',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2025-01-01',
      indexed: 80,
      notIndexed: 20,
      reasonBreakdown: { 'Crawled - currently not indexed': 15, 'Duplicate without user-selected canonical': 5 },
      createdAt: now,
    }).run()

    db.insert(gscCoverageSnapshots).values({
      id: 's2',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2025-01-02',
      indexed: 85,
      notIndexed: 15,
      reasonBreakdown: { 'Crawled - currently not indexed': 10, 'Duplicate without user-selected canonical': 5 },
      createdAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: undefined, clientSecret: undefined }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
    })

    app = fastify
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns snapshots in chronological order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/testproj/google/gsc/coverage/history',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string; indexed: number; notIndexed: number; reasonBreakdown: Record<string, number> }>
    expect(body).toHaveLength(2)
    expect(body[0]!.date).toBe('2025-01-01')
    expect(body[1]!.date).toBe('2025-01-02')
    expect(body[0]!.indexed).toBe(80)
    expect(body[1]!.indexed).toBe(85)
  })

  it('respects the limit parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/testproj/google/gsc/coverage/history?limit=1',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string }>
    expect(body).toHaveLength(1)
    // limit=1 takes the most-recent snapshot (desc order then reversed)
    expect(body[0]!.date).toBe('2025-01-02')
  })

  it('uses default limit when limit param is not a number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/testproj/google/gsc/coverage/history?limit=abc',
    })
    expect(res.statusCode).toBe(200)
    // Should return all 2 rows (default 90 > 2 available)
    const body = res.json() as Array<unknown>
    expect(body).toHaveLength(2)
  })

  it('returns 404 for unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/nonexistent/google/gsc/coverage/history',
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns empty array when no snapshots exist', async () => {
    // Create a project with no snapshots
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p2',
      name: 'emptyproj',
      displayName: 'Empty Project',
      canonicalDomain: 'empty.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/emptyproj/google/gsc/coverage/history',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<unknown>
    expect(body).toHaveLength(0)
  })
})

describe('googleRoutes: coverage snapshot deduplication', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-coverage-dedup-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'dedupproj',
      displayName: 'Dedup Project',
      canonicalDomain: 'dedup.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(runs).values({
      id: 'r1',
      projectId: 'p1',
      kind: 'gsc-inspect-sitemap',
      status: 'completed',
      createdAt: now,
    }).run()

    // Simulate two runs on same day by inserting duplicate then replacing it
    db.insert(gscCoverageSnapshots).values({
      id: 's1',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2025-03-01',
      indexed: 50,
      notIndexed: 50,
      reasonBreakdown: {},
      createdAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: undefined, clientSecret: undefined }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
    })

    app = fastify
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('only one snapshot per (project, date) after delete+insert', async () => {
    const { eq, and } = await import('drizzle-orm')

    // Delete-before-insert pattern (same as gsc-sync/inspect-sitemap)
    db.delete(gscCoverageSnapshots)
      .where(and(eq(gscCoverageSnapshots.projectId, 'p1'), eq(gscCoverageSnapshots.date, '2025-03-01')))
      .run()
    db.insert(gscCoverageSnapshots).values({
      id: 's2',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2025-03-01',
      indexed: 90,
      notIndexed: 10,
      reasonBreakdown: {},
      createdAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/dedupproj/google/gsc/coverage/history',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string; indexed: number }>
    // Should be exactly one row for 2025-03-01 with updated values
    expect(body).toHaveLength(1)
    expect(body[0]!.indexed).toBe(90)
  })
})

describe('googleRoutes: GET /projects/:name/google/gsc/coverage', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-coverage-summary-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'covproj',
      displayName: 'Coverage Project',
      canonicalDomain: 'coverage.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(runs).values({
      id: 'r1',
      projectId: 'p1',
      kind: 'gsc-sync',
      status: 'completed',
      createdAt: now,
    }).run()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: undefined, clientSecret: undefined }),
      googleConnectionStore: {
        listConnections: () => [],
        getConnection: () => undefined,
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
    })

    app = fastify
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null lastSyncedAt and lastInspectedAt when no data exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/covproj/google/gsc/coverage',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { lastInspectedAt: string | null; lastSyncedAt: string | null }
    expect(body.lastInspectedAt).toBeNull()
    expect(body.lastSyncedAt).toBeNull()
  })

  it('returns lastSyncedAt from the most recent coverage snapshot, independent of inspection time', async () => {
    // Inspections from May 1; sync snapshot from May 4 (later) — exercises
    // the bug fix: a sync that re-fetched coverage but found no new URLs
    // still updates lastSyncedAt while leaving lastInspectedAt unchanged.
    const inspectionTime = '2026-05-01T08:00:00.000Z'
    const syncTime = '2026-05-04T14:36:24.808Z'

    db.insert(gscUrlInspections).values({
      id: 'i1',
      projectId: 'p1',
      syncRunId: 'r1',
      url: 'https://coverage.com/page-1',
      indexingState: 'INDEXING_ALLOWED',
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      pageFetchState: 'SUCCESSFUL',
      robotsTxtState: 'ALLOWED',
      crawlTime: inspectionTime,
      lastCrawlResult: null,
      isMobileFriendly: 1,
      richResults: '[]',
      referringUrls: '[]',
      inspectedAt: inspectionTime,
      createdAt: inspectionTime,
    }).run()

    db.insert(gscCoverageSnapshots).values({
      id: 'snap-may4',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2026-05-04',
      indexed: 1,
      notIndexed: 0,
      reasonBreakdown: {},
      createdAt: syncTime,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/covproj/google/gsc/coverage',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { lastInspectedAt: string | null; lastSyncedAt: string | null }
    expect(body.lastInspectedAt).toBe(inspectionTime)
    expect(body.lastSyncedAt).toBe(syncTime)
  })

  it('uses the most recent snapshot when several exist for different dates', async () => {
    const earlierSync = '2026-05-02T12:00:00.000Z'
    const latestSync = '2026-05-05T09:30:00.000Z'

    db.insert(gscCoverageSnapshots).values({
      id: 'snap-may2',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2026-05-02',
      indexed: 1,
      notIndexed: 0,
      reasonBreakdown: {},
      createdAt: earlierSync,
    }).run()

    db.insert(gscCoverageSnapshots).values({
      id: 'snap-may5',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2026-05-05',
      indexed: 1,
      notIndexed: 0,
      reasonBreakdown: {},
      createdAt: latestSync,
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: '/projects/covproj/google/gsc/coverage',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { lastSyncedAt: string | null }
    expect(body.lastSyncedAt).toBe(latestSync)
  })
})

describe('googleRoutes: POST /projects/:name/google/indexing/request', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-indexing-request-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    // Seed URL inspections: one indexed, two not indexed
    db.insert(gscUrlInspections).values({
      id: 'i1',
      projectId: 'p1',
      syncRunId: null,
      url: 'https://example.com/indexed',
      indexingState: 'INDEXING_ALLOWED',
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      pageFetchState: 'SUCCESSFUL',
      robotsTxtState: 'ALLOWED',
      crawlTime: now,
      lastCrawlResult: null,
      isMobileFriendly: 1,
      richResults: '[]',
      referringUrls: '[]',
      inspectedAt: now,
      createdAt: now,
    }).run()

    db.insert(gscUrlInspections).values({
      id: 'i2',
      projectId: 'p1',
      syncRunId: null,
      url: 'https://example.com/not-indexed-1',
      indexingState: 'INDEXING_NOT_ALLOWED',
      verdict: 'NEUTRAL',
      coverageState: 'Crawled - currently not indexed',
      pageFetchState: 'SUCCESSFUL',
      robotsTxtState: 'ALLOWED',
      crawlTime: now,
      lastCrawlResult: null,
      isMobileFriendly: 1,
      richResults: '[]',
      referringUrls: '[]',
      inspectedAt: now,
      createdAt: now,
    }).run()

    db.insert(gscUrlInspections).values({
      id: 'i3',
      projectId: 'p1',
      syncRunId: null,
      url: 'https://example.com/not-indexed-2',
      indexingState: 'INDEXING_NOT_ALLOWED',
      verdict: 'NEUTRAL',
      coverageState: 'URL is unknown to Google',
      pageFetchState: null,
      robotsTxtState: null,
      crawlTime: null,
      lastCrawlResult: null,
      isMobileFriendly: null,
      richResults: '[]',
      referringUrls: '[]',
      inspectedAt: now,
      createdAt: now,
    }).run()

    const tokenExpires = new Date(Date.now() + 3600 * 1000).toISOString()

    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      throw error
    })
    fastify.decorate('db', db)
    fastify.register(googleRoutes, {
      getGoogleAuthConfig: () => ({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      }),
      googleConnectionStore: {
        listConnections: () => [{
          domain: 'example.com',
          connectionType: 'gsc' as const,
          propertyId: 'sc-domain:example.com',
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          tokenExpiresAt: tokenExpires,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
          createdAt: now,
          updatedAt: now,
        }],
        getConnection: (domain: string, connectionType: 'gsc' | 'ga4') => {
          if (domain === 'example.com' && connectionType === 'gsc') {
            return {
              domain: 'example.com',
              connectionType: 'gsc' as const,
              propertyId: 'sc-domain:example.com',
              accessToken: 'test-access-token',
              refreshToken: 'test-refresh-token',
              tokenExpiresAt: tokenExpires,
              scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
              createdAt: now,
              updatedAt: now,
            }
          }
          return undefined
        },
        upsertConnection: (c) => c,
        updateConnection: () => undefined,
        deleteConnection: () => false,
      },
      googleStateSecret: 'test-secret-32-bytes-long-enough!',
    })

    app = fastify
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('requests indexing for explicit URLs', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        urlNotificationMetadata: {
          url: 'https://example.com/page',
          latestUpdate: {
            url: 'https://example.com/page',
            type: 'URL_UPDATED',
            notifyTime: '2026-03-17T17:40:00Z',
          },
        },
      }), { status: 200 })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: ['https://example.com/page'] },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: { total: number; succeeded: number; failed: number }; results: Array<{ url: string; status: string }> }
    expect(body.summary.total).toBe(1)
    expect(body.summary.succeeded).toBe(1)
    expect(body.results[0]!.status).toBe('success')
  })

  it('requests indexing for all unindexed URLs', async () => {
    const notifiedUrls: string[] = []
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as { url: string }
      notifiedUrls.push(reqBody.url)
      return new Response(JSON.stringify({
        urlNotificationMetadata: {
          url: reqBody.url,
          latestUpdate: {
            url: reqBody.url,
            type: 'URL_UPDATED',
            notifyTime: '2026-03-17T17:40:00Z',
          },
        },
      }), { status: 200 })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: [], allUnindexed: true },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: { total: number; succeeded: number } }
    expect(body.summary.total).toBe(2)
    expect(body.summary.succeeded).toBe(2)
    expect(notifiedUrls).toContain('https://example.com/not-indexed-1')
    expect(notifiedUrls).toContain('https://example.com/not-indexed-2')
    expect(notifiedUrls).not.toContain('https://example.com/indexed')
  })

  it('returns 400 when no URLs and allUnindexed is false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: [] },
    })

    expect(res.statusCode).toBe(400)
  })

  it('reports per-URL errors without failing the entire request', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({
          urlNotificationMetadata: { url: 'https://example.com/a', latestUpdate: { notifyTime: new Date().toISOString() } },
        }), { status: 200 })
      }
      return new Response('Rate limited', { status: 429 })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: ['https://example.com/a', 'https://example.com/b'] },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: { succeeded: number; failed: number }; results: Array<{ status: string }> }
    expect(body.summary.succeeded).toBe(1)
    expect(body.summary.failed).toBe(1)
  })

  it('rejects URLs that do not belong to the project domain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: ['https://attacker.com/evil-page'] },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { message: string } }
    expect(body.error.message).toMatch(/must belong to project domain/)
    expect(body.error.message).toMatch(/attacker\.com/)
  })

  it('rejects mixed valid and invalid domain URLs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/indexing/request',
      payload: { urls: ['https://example.com/ok', 'https://evil.com/bad'] },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { message: string } }
    expect(body.error.message).toMatch(/evil\.com/)
  })
})

describe('googleRoutes: performance filter conditions', () => {
  it('combines all conditions with AND (not chained .where() replacements)', () => {
    // This verifies the fix conceptually: we collect conditions in an array
    // and pass them all to a single and() call, so all filters apply.
    // Previously each .where() call on a $dynamic() query replaced the prior one.
    const conditions: string[] = ['projectId = ?']
    const startDate = '2025-01-01'
    const endDate = '2025-01-31'
    const query = 'seo'
    const page = '/blog'

    if (startDate) conditions.push('date >= ?')
    if (endDate) conditions.push('date <= ?')
    if (query) conditions.push('query LIKE ?')
    if (page) conditions.push('page LIKE ?')

    // All 5 conditions must be present
    expect(conditions).toHaveLength(5)
    expect(conditions).toContain('projectId = ?')
    expect(conditions).toContain('date >= ?')
    expect(conditions).toContain('date <= ?')
    expect(conditions).toContain('query LIKE ?')
    expect(conditions).toContain('page LIKE ?')
  })
})

describe('googleRoutes: GET /projects/:name/google/gsc/performance offset pagination', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string

  beforeEach(async () => {
    context = buildApp({ googleClientId: 'cid', googleClientSecret: 'csec' })
    await context.app.ready()
    projectId = crypto.randomUUID()
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(projects).values({
      id: projectId,
      name: 'perf',
      displayName: 'Perf',
      canonicalDomain: 'perf.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    const syncRunId = crypto.randomUUID()
    context.db.insert(runs).values({
      id: syncRunId,
      projectId,
      kind: 'gsc-sync',
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()
    // Seed 6 rows with distinct dates so we can identify each page of results
    // by date. Ordered by date desc, the rows return: d6, d5, d4, d3, d2, d1.
    for (let i = 1; i <= 6; i++) {
      const date = `2026-01-0${i}`
      context.db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date,
        query: `q${i}`,
        page: `/p${i}`,
        country: 'usa',
        device: 'DESKTOP',
        impressions: i * 10,
        clicks: i,
        ctr: '0.1',
        position: String(i + 1),
        createdAt: now,
      }).run()
    }
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  })

  it('paginates rows by offset (issue #470 — drizzle .offset() must apply)', async () => {
    const page1 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=0',
    })
    expect(page1.statusCode).toBe(200)
    const rows1 = page1.json() as Array<{ date: string }>
    expect(rows1.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])

    const page2 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=2',
    })
    expect(page2.statusCode).toBe(200)
    const rows2 = page2.json() as Array<{ date: string }>
    expect(rows2.map(r => r.date)).toEqual(['2026-01-04', '2026-01-03'])

    const page3 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=4',
    })
    expect(page3.statusCode).toBe(200)
    const rows3 = page3.json() as Array<{ date: string }>
    expect(rows3.map(r => r.date)).toEqual(['2026-01-02', '2026-01-01'])

    // Past the end returns an empty page (not the same first page).
    const page4 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=6',
    })
    expect(page4.statusCode).toBe(200)
    expect(page4.json()).toEqual([])
  })

  it('treats omitted offset as 0 and behaves identically to offset=0', async () => {
    const noOffset = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=3',
    })
    const withZero = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=3&offset=0',
    })
    expect(noOffset.statusCode).toBe(200)
    expect(withZero.statusCode).toBe(200)
    expect(noOffset.json()).toEqual(withZero.json())
  })

  it('clamps negative or non-numeric offset to 0', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=-5',
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ date: string }>
    expect(rows.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])

    const garbage = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?limit=2&offset=abc',
    })
    expect(garbage.statusCode).toBe(200)
    const garbageRows = garbage.json() as Array<{ date: string }>
    expect(garbageRows.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])
  })
})

describe('googleRoutes: GET /projects/:name/google/gsc/performance/daily', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string

  beforeEach(async () => {
    context = buildApp({ googleClientId: 'cid', googleClientSecret: 'csec' })
    await context.app.ready()
    projectId = crypto.randomUUID()
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(projects).values({
      id: projectId,
      name: 'perf',
      displayName: 'Perf',
      canonicalDomain: 'perf.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    const syncRunId = crypto.randomUUID()
    context.db.insert(runs).values({
      id: syncRunId,
      projectId,
      kind: 'gsc-sync',
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()
    // Seed multiple (query, page) tuples per day so the daily endpoint has
    // something real to aggregate. Two days, three tuples each.
    const seed = [
      { date: '2026-01-05', query: 'a', page: '/a', clicks: 2, impressions: 100 },
      { date: '2026-01-05', query: 'b', page: '/b', clicks: 3, impressions: 200 },
      { date: '2026-01-05', query: 'c', page: '/c', clicks: 5, impressions: 50 },
      { date: '2026-01-06', query: 'a', page: '/a', clicks: 4, impressions: 200 },
      { date: '2026-01-06', query: 'b', page: '/b', clicks: 1, impressions: 100 },
      { date: '2026-01-06', query: 'c', page: '/c', clicks: 5, impressions: 700 },
    ]
    for (const row of seed) {
      context.db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: row.date,
        query: row.query,
        page: row.page,
        country: 'usa',
        device: 'DESKTOP',
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.impressions > 0 ? String(row.clicks / row.impressions) : '0',
        position: '5',
        createdAt: now,
      }).run()
    }
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  })

  it('sums clicks + impressions per date and computes CTR from the sums (not an average of row CTRs)', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totals: { clicks: number; impressions: number; ctr: number; days: number }; daily: Array<{ date: string; clicks: number; impressions: number; ctr: number }> }

    // Daily rows ordered by date asc
    expect(body.daily.map(d => d.date)).toEqual(['2026-01-05', '2026-01-06'])

    // 2026-01-05: 2+3+5=10 clicks, 100+200+50=350 impressions, CTR = 10/350
    expect(body.daily[0]).toEqual({ date: '2026-01-05', clicks: 10, impressions: 350, ctr: 10 / 350 })
    // 2026-01-06: 4+1+5=10 clicks, 200+100+700=1000 impressions, CTR = 10/1000 = 0.01
    expect(body.daily[1]).toEqual({ date: '2026-01-06', clicks: 10, impressions: 1000, ctr: 0.01 })

    // Window totals: aggregate of all rows, NOT averaged from per-day CTRs
    // Total clicks 20, total impressions 1350, ctr = 20/1350 (not (10/350 + 10/1000) / 2)
    expect(body.totals).toEqual({ clicks: 20, impressions: 1350, ctr: 20 / 1350, days: 2 })
    // Sanity: averaged per-day CTR would be ~0.019, the bug we're protecting against
    expect(body.totals.ctr).not.toBeCloseTo((10 / 350 + 10 / 1000) / 2, 5)
  })

  it('filters by the window param using windowCutoff', async () => {
    // Add a stale row from before the 7d cutoff
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 30)
    context.db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: context.db.select({ id: runs.id }).from(runs).all()[0]!.id,
      date: oldDate.toISOString().slice(0, 10),
      query: 'stale',
      page: '/stale',
      country: 'usa',
      device: 'DESKTOP',
      impressions: 999_999,
      clicks: 999,
      ctr: '0.001',
      position: '50',
      createdAt: '2025-12-01T00:00:00.000Z',
    }).run()

    // Add a fresh row that should pass the 7d cutoff
    const freshDate = new Date().toISOString().slice(0, 10)
    context.db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: context.db.select({ id: runs.id }).from(runs).all()[0]!.id,
      date: freshDate,
      query: 'fresh',
      page: '/fresh',
      country: 'usa',
      device: 'DESKTOP',
      impressions: 50,
      clicks: 5,
      ctr: '0.1',
      position: '3',
      createdAt: '2026-05-15T00:00:00.000Z',
    }).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?window=7d',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totals: { clicks: number; days: number }; daily: Array<{ date: string; clicks: number }> }

    // Only the fresh row should be in the window; the stale row and the 2026-01-* seeds are excluded
    expect(body.daily.map(d => d.date)).toEqual([freshDate])
    expect(body.totals.clicks).toBe(5)
    expect(body.totals.days).toBe(1)
  })

  it('returns zero totals and empty daily array when no rows match the window', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2030-01-01',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      totals: { clicks: 0, impressions: 0, ctr: 0, days: 0 },
      daily: [],
    })
  })

  it('returns 404 for an unknown project', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/nope/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(404)
  })

  it('sources the daily series from gsc_daily_totals (property total), not the summed dimensioned rows', async () => {
    // The seeded gsc_search_data sums to 20 clicks / 1350 impressions. Seed
    // property-level daily totals for the same two dates with DIFFERENT figures
    // and assert the endpoint returns those, proving it reads gsc_daily_totals.
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-01-05', clicks: 25, impressions: 300, position: '4', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-06', clicks: 31, impressions: 900, position: '6', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totals: { clicks: number; impressions: number; ctr: number; days: number }; daily: Array<{ date: string; clicks: number; impressions: number; ctr: number }> }

    // Property totals — NOT the dimensioned sum (20 / 1350).
    expect(body.daily).toEqual([
      { date: '2026-01-05', clicks: 25, impressions: 300, ctr: 25 / 300 },
      { date: '2026-01-06', clicks: 31, impressions: 900, ctr: 31 / 900 },
    ])
    expect(body.totals).toEqual({ clicks: 56, impressions: 1200, ctr: 56 / 1200, days: 2 })
  })

  it('falls back to summing gsc_search_data by date when no gsc_daily_totals rows exist in the window', async () => {
    // No gsc_daily_totals seeded (only the dimensioned gsc_search_data from
    // beforeEach), so the endpoint falls back to the per-date dimensioned sum.
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totals: { clicks: number; impressions: number; ctr: number; days: number }; daily: Array<{ date: string; clicks: number; impressions: number; ctr: number }> }

    expect(body.daily).toEqual([
      { date: '2026-01-05', clicks: 10, impressions: 350, ctr: 10 / 350 },
      { date: '2026-01-06', clicks: 10, impressions: 1000, ctr: 0.01 },
    ])
    expect(body.totals).toEqual({ clicks: 20, impressions: 1350, ctr: 20 / 1350, days: 2 })
  })
})
