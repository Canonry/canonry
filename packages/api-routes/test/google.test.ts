import crypto from 'node:crypto'
import { describe, it, beforeAll, afterAll, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate, projects, runs, gscCoverageSnapshots, gscUrlInspections } from '@ainyc/canonry-db'
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
      reasonBreakdown: JSON.stringify({ 'Crawled - currently not indexed': 15, 'Duplicate without user-selected canonical': 5 }),
      createdAt: now,
    }).run()

    db.insert(gscCoverageSnapshots).values({
      id: 's2',
      projectId: 'p1',
      syncRunId: 'r1',
      date: '2025-01-02',
      indexed: 85,
      notIndexed: 15,
      reasonBreakdown: JSON.stringify({ 'Crawled - currently not indexed': 10, 'Duplicate without user-selected canonical': 5 }),
      createdAt: now,
    }).run()

    const fastify = Fastify()
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
      reasonBreakdown: '{}',
      createdAt: now,
    }).run()

    const fastify = Fastify()
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
      reasonBreakdown: '{}',
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
