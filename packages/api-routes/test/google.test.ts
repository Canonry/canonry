import crypto from 'node:crypto'
import { describe, it, beforeAll, afterAll, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs, auditLog, gscCoverageSnapshots, gscUrlInspections, gscSearchData, gscDailyTotals, gscDataWatermarks } from '@ainyc/canonry-db'
import { AppError, formatPercent, gscCoverageSummaryDtoSchema, type GscCoverageSummaryDto, type GscPerformanceDailyDto } from '@ainyc/canonry-contracts'
import { googleOAuthSuccessHtml, googleRoutes } from '../src/google.js'

// Reproduce state signing functions from google.ts to verify behavior.
// Kept in sync with `OAUTH_STATE_MAX_AGE_MS` / `buildSignedState` /
// `verifySignedState` there — `buildSignedState` stamps `issuedAt` by
// default (matching production), and tests that need to emulate a
// pre-TTL "legacy" state or an expired one pass `issuedAt` explicitly.
const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000

function signState(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function buildSignedState(data: Record<string, unknown>, secret: string): string {
  const payload = JSON.stringify({ issuedAt: Date.now(), ...data })
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

/** Build a state payload with no `issuedAt` at all — emulates a state minted before the TTL field existed. */
function buildSignedStateWithoutIssuedAt(data: Record<string, unknown>, secret: string): string {
  const payload = JSON.stringify(data)
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

function verifySignedState(encoded: string, secret: string): Record<string, unknown> | null {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const expected = signState(payload, secret)
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const issuedAt = typeof parsed.issuedAt === 'number' ? parsed.issuedAt : null
    if (issuedAt === null || Date.now() - issuedAt > OAUTH_STATE_MAX_AGE_MS) return null
    return parsed
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

  it('rejects a state older than the TTL — closes the indefinite-replay window', () => {
    const secret = 'my-test-secret'
    const staleIssuedAt = Date.now() - OAUTH_STATE_MAX_AGE_MS - 1000
    const encoded = buildSignedState({ domain: 'example.com', type: 'gsc', issuedAt: staleIssuedAt }, secret)
    const result = verifySignedState(encoded, secret)
    expect(result).toBeNull()
  })

  it('accepts a state right at the edge of the TTL window', () => {
    const secret = 'my-test-secret'
    const freshIssuedAt = Date.now() - OAUTH_STATE_MAX_AGE_MS + 5000
    const encoded = buildSignedState({ domain: 'example.com', type: 'gsc', issuedAt: freshIssuedAt }, secret)
    const result = verifySignedState(encoded, secret)
    expect(result).not.toBeNull()
  })

  it('rejects a correctly-signed state with no issuedAt at all (pre-TTL-migration state)', () => {
    const secret = 'my-test-secret'
    const encoded = buildSignedStateWithoutIssuedAt({ domain: 'example.com', type: 'gsc' }, secret)
    const result = verifySignedState(encoded, secret)
    expect(result).toBeNull()
  })
})

describe('Google OAuth success page', () => {
  it('notifies and closes an OAuth popup without exposing token data', () => {
    const html = googleOAuthSuccessHtml('gsc')

    expect(html).toContain('canonry:google-oauth-complete')
    expect(html).toContain('"connectionType":"gsc"')
    expect(html).toContain('window.opener.postMessage')
    expect(html).toContain('window.close()')
    expect(html).not.toMatch(/accessToken|refreshToken/)
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

describe('googleRoutes: GSC coverage shares', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-coverage-shares-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const fastify = Fastify()
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
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

  function seedProject(name: string): string {
    const id = crypto.randomUUID()
    const now = '2026-05-01T00:00:00.000Z'
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    return id
  }

  function inspect(projectId: string, url: string, indexingState: string, inspectedAt: string) {
    return { id: crypto.randomUUID(), projectId, url, indexingState, inspectedAt, createdAt: inspectedAt }
  }

  async function coverage(name: string): Promise<GscCoverageSummaryDto> {
    const res = await app.inject({ method: 'GET', url: `/projects/${name}/google/gsc/coverage` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscCoverageSummaryDto
    expect(() => gscCoverageSummaryDtoSchema.parse(body)).not.toThrow()
    return body
  }

  it('shares each latest inspection between indexed and not indexed, summing to 1', async () => {
    const projectId = seedProject('sharesplit')
    db.insert(gscUrlInspections).values([
      inspect(projectId, 'https://sharesplit.example/a', 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'),
      inspect(projectId, 'https://sharesplit.example/b', 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'),
      // http and https of one page collapse into one inspected page.
      inspect(projectId, 'http://sharesplit.example/c', 'INDEXING_ALLOWED', '2026-05-01T00:00:00.000Z'),
      inspect(projectId, 'https://sharesplit.example/c', 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'),
      // Indexed before, not now: counted once, as not indexed (and deindexed).
      inspect(projectId, 'https://sharesplit.example/d', 'INDEXING_ALLOWED', '2026-05-01T00:00:00.000Z'),
      inspect(projectId, 'https://sharesplit.example/d', 'BLOCKED', '2026-05-02T00:00:00.000Z'),
    ]).run()

    const { summary } = await coverage('sharesplit')
    expect(summary).toEqual({
      total: 4,
      indexed: 3,
      notIndexed: 1,
      deindexed: 1,
      percentage: 75,
      indexedShare: 0.75,
      notIndexedShare: 0.25,
    })
    expect(summary.indexed + summary.notIndexed).toBe(summary.total)
    expect(summary.indexedShare! + summary.notIndexedShare!).toBe(1)
    expect(formatPercent(summary.indexedShare)).toBe('75.0%')
    expect(formatPercent(summary.notIndexedShare)).toBe('25.0%')
  })

  it('keeps the shares unrounded where the rounded percentage claims a false 100', async () => {
    const projectId = seedProject('sharesliver')
    const rows = Array.from({ length: 2000 }, (_, i) =>
      inspect(projectId, `https://sharesliver.example/p${i}`, 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'))
    rows.push(inspect(projectId, 'https://sharesliver.example/missing', 'NEUTRAL', '2026-05-02T00:00:00.000Z'))
    db.insert(gscUrlInspections).values(rows).run()

    const { summary } = await coverage('sharesliver')
    expect(summary.total).toBe(2001)
    expect(summary.indexedShare).toBe(2000 / 2001)
    expect(summary.notIndexedShare).toBe(1 / 2001)
    expect(summary.indexedShare! + summary.notIndexedShare!).toBeCloseTo(1, 12)
    // The one-decimal `percentage` rounds 99.95% up to 100; the share does not.
    expect(summary.percentage).toBe(100)
    expect(formatPercent(summary.indexedShare)).toBe('>99.9%')
    expect(formatPercent(summary.notIndexedShare)).toBe('<0.1%')
  })

  it('reports no share, not 0%, before any page has been inspected', async () => {
    seedProject('shareempty')
    const { summary } = await coverage('shareempty')
    expect(summary.total).toBe(0)
    expect(summary.indexedShare).toBeNull()
    expect(summary.notIndexedShare).toBeNull()
    expect(formatPercent(summary.indexedShare)).toBe('—')
  })

  it('reads exact 0 and 1 when every page is on one side', async () => {
    const allIndexed = seedProject('shareall')
    db.insert(gscUrlInspections).values([
      inspect(allIndexed, 'https://shareall.example/a', 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'),
      inspect(allIndexed, 'https://shareall.example/b', 'INDEXING_ALLOWED', '2026-05-02T00:00:00.000Z'),
    ]).run()
    const full = (await coverage('shareall')).summary
    expect(full.indexedShare).toBe(1)
    expect(full.notIndexedShare).toBe(0)
    expect(formatPercent(full.indexedShare)).toBe('100%')
    expect(formatPercent(full.notIndexedShare)).toBe('0%')
  })
})

describe('googleRoutes: POST /projects/:name/google/indexing/request', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let originalFetch: typeof globalThis.fetch
  let gscScopes: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  beforeAll(async () => {
    gscScopes = ['https://www.googleapis.com/auth/webmasters.readonly']
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
          scopes: gscScopes,
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
              scopes: gscScopes,
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

  it('returns top-level sitemap summary and prefers sitemap indexes for submission', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      sitemap: [
        { path: 'https://example.com/sitemap.xml', isSitemapsIndex: false },
        { path: 'https://example.com/sitemap-index.xml', isSitemapsIndex: true },
      ],
    }), { status: 200 })
    const res = await app.inject({ method: 'GET', url: '/projects/testproj/google/gsc/sitemaps' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: { total: number; indexes: number; files: number }; preferredSubmissionUrls: string[] }
    expect(body.summary).toEqual({ total: 2, indexes: 1, files: 1 })
    expect(body.preferredSubmissionUrls).toEqual(['https://example.com/sitemap-index.xml'])
  })

  it('lists an owned sitemap index\'s children with their parent URL', async () => {
    const sitemapIndex = 'https://example.com/sitemap-index.xml'
    let requestUrl = ''
    globalThis.fetch = async (url: string | URL | Request) => {
      requestUrl = String(url)
      return new Response(JSON.stringify({ sitemap: [{ path: 'https://example.com/child.xml' }] }), { status: 200 })
    }
    const res = await app.inject({ method: 'GET', url: `/projects/testproj/google/gsc/sitemaps?sitemapIndex=${encodeURIComponent(sitemapIndex)}` })
    expect(res.statusCode).toBe(200)
    expect(requestUrl).toContain(`sitemapIndex=${encodeURIComponent(sitemapIndex)}`)
    expect(res.json().sitemaps[0]).toMatchObject({ path: 'https://example.com/child.xml', parentSitemapUrl: sitemapIndex })
  })

  it('rejects an unowned sitemapIndex before the Google request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const res = await app.inject({
      method: 'GET',
      url: `/projects/testproj/google/gsc/sitemaps?sitemapIndex=${encodeURIComponent('https://attacker.example/sitemap.xml')}`,
    })
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits deduplicated owned sitemap URLs sequentially and audits accepted requests', async () => {
    gscScopes = ['https://www.googleapis.com/auth/webmasters']
    const requested: string[] = []
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requested.push(String(url))
      expect(init?.method).toBe('PUT')
      return new Response(null, { status: 204 })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/gsc/sitemaps/submit',
      payload: { sitemapUrls: ['https://example.com/sitemap.xml', 'https://example.com/sitemap.xml', 'https://blog.example.com/sitemap.xml'] },
    })

    expect(res.statusCode).toBe(200)
    expect(requested).toHaveLength(2)
    const body = res.json() as { summary: { total: number; accepted: number; failed: number }; results: Array<{ sitemapUrl: string; status: string }> }
    expect(body.summary).toEqual({ total: 2, accepted: 2, failed: 0 })
    expect(body.results.map((result) => result.sitemapUrl)).toEqual(['https://example.com/sitemap.xml', 'https://blog.example.com/sitemap.xml'])
    expect(body.results.every((result) => result.status === 'accepted')).toBe(true)
    const audits = db.select().from(auditLog).where(eq(auditLog.action, 'google.sitemap.submitted')).all()
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ action: 'google.sitemap.submitted', entityType: 'sitemap', projectId: 'p1' })
  })

  it('collects per-sitemap failures without stopping later submissions', async () => {
    gscScopes = ['https://www.googleapis.com/auth/webmasters']
    const requested: string[] = []
    globalThis.fetch = async (url: string | URL | Request) => {
      requested.push(String(url))
      return requested.length === 2
        ? new Response('Google rejected sitemap', { status: 400 })
        : new Response(null, { status: 204 })
    }
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/gsc/sitemaps/submit',
      payload: { sitemapUrls: ['https://example.com/one.xml', 'https://example.com/two.xml', 'https://example.com/three.xml'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: { total: number; accepted: number; failed: number }; results: Array<{ status: string; error?: string }> }
    expect(requested).toHaveLength(3)
    expect(body.summary).toEqual({ total: 3, accepted: 2, failed: 1 })
    expect(body.results.map((result) => result.status)).toEqual(['accepted', 'error', 'accepted'])
    expect(body.results[1]!.error).toMatch(/Google rejected sitemap/)
  })

  it('rejects sitemap URLs outside the configured property before making a network request', async () => {
    gscScopes = ['https://www.googleapis.com/auth/webmasters']
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/gsc/sitemaps/submit',
      payload: { sitemapUrls: ['https://attacker.example/sitemap.xml'] },
    })
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks legacy read-only connections before making a network request', async () => {
    gscScopes = ['https://www.googleapis.com/auth/webmasters.readonly']
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const res = await app.inject({
      method: 'POST',
      url: '/projects/testproj/google/gsc/sitemaps/submit',
      payload: { sitemapUrls: ['https://example.com/sitemap.xml'] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/read-only webmasters scope/)
    expect(fetchMock).not.toHaveBeenCalled()
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

  // These page through an explicit `orderBy=date` so the assertions stay about
  // offset, not about which ordering the route defaults to.
  it('paginates rows by offset (issue #470 — drizzle .offset() must apply)', async () => {
    const page1 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=0',
    })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json() as { rows: Array<{ date: string }>; totalMatching: number; truncated: boolean }
    expect(body1.rows.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])
    expect(body1.totalMatching).toBe(6)
    expect(body1.truncated).toBe(true)

    const page2 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=2',
    })
    expect(page2.statusCode).toBe(200)
    const rows2 = (page2.json() as { rows: Array<{ date: string }> }).rows
    expect(rows2.map(r => r.date)).toEqual(['2026-01-04', '2026-01-03'])

    const page3 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=4',
    })
    expect(page3.statusCode).toBe(200)
    const rows3 = (page3.json() as { rows: Array<{ date: string }> }).rows
    expect(rows3.map(r => r.date)).toEqual(['2026-01-02', '2026-01-01'])

    // Past the end returns an empty page (not the same first page).
    const page4 = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=6',
    })
    expect(page4.statusCode).toBe(200)
    expect((page4.json() as { rows: unknown[] }).rows).toEqual([])
  })

  it('treats omitted offset as 0 and behaves identically to offset=0', async () => {
    const noOffset = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=3',
    })
    const withZero = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=3&offset=0',
    })
    expect(noOffset.statusCode).toBe(200)
    expect(withZero.statusCode).toBe(200)
    expect(noOffset.json()).toEqual(withZero.json())
  })

  it('clamps negative or non-numeric offset to 0', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=-5',
    })
    expect(res.statusCode).toBe(200)
    const rows = (res.json() as { rows: Array<{ date: string }> }).rows
    expect(rows.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])

    const garbage = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance?orderBy=date&limit=2&offset=abc',
    })
    expect(garbage.statusCode).toBe(200)
    const garbageRows = (garbage.json() as { rows: Array<{ date: string }> }).rows
    expect(garbageRows.map(r => r.date)).toEqual(['2026-01-06', '2026-01-05'])
  })
})

/** `YYYY-MM-DD` for N days back on GSC's Pacific reporting calendar. */
function pacificDayIso(daysAgo: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * 86_400_000)
    .toISOString().slice(0, 10)
}

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
    expect(body.daily[0]).toEqual({ date: '2026-01-05', clicks: 10, impressions: 350, ctr: 10 / 350, position: null })
    // 2026-01-06: 4+1+5=10 clicks, 200+100+700=1000 impressions, CTR = 10/1000 = 0.01
    expect(body.daily[1]).toEqual({ date: '2026-01-06', clicks: 10, impressions: 1000, ctr: 0.01, position: null })

    // Window totals: aggregate of all rows, NOT averaged from per-day CTRs
    // Total clicks 20, total impressions 1350, ctr = 20/1350 (not (10/350 + 10/1000) / 2)
    expect(body.totals).toEqual({ clicks: 20, impressions: 1350, ctr: 20 / 1350, position: null, positionDays: 0, days: 2 })
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
    const body = res.json() as GscPerformanceDailyDto
    expect(body.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: null, positionDays: 0, days: 0 })
    expect(body.daily).toEqual([])
    // A window with no days has no series to fit.
    expect(body.trends).toEqual({ clicks: null, impressions: null, ctr: null, position: null })
    // An explicit startDate wins over the label, and the upper bound is the
    // last published day, so the caller can label the period it actually got.
    expect(body.window!.startDate).toBe('2030-01-01')
    expect(body.window!.latestDataDate).toBe('2026-01-06')
  })

  it('returns 404 for an unknown project', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/nope/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a caller range that runs backwards instead of answering it empty', async () => {
    // Both bounds are the caller's own, so the REQUEST is impossible. An empty
    // 200 would be technically true and useless.
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2030-01-01&endDate=2026-01-06',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/is after endDate/)
  })

  it.each(['2026-02-30', '2026-2-03'])('refuses invalid calendar boundary %s', async (startDate) => {
    const res = await context.app.inject({
      method: 'GET',
      url: `/projects/perf/google/gsc/performance/daily?startDate=${startDate}&endDate=2026-03-05`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/Expected a calendar date as YYYY-MM-DD/)
  })

  it('anchors a labelled window on the last published day, not on today', async () => {
    // The canonry.ai case: Google published through 3 days ago, so a
    // now-anchored 30d spent 3 of its days on dates that cannot hold data and
    // returned 27. Anchored on the last published day it returns all 30.
    // Seed on GSC's PACIFIC reporting calendar, which is what the route now
    // measures against. A UTC-seeded fixture drifts by a day between 00:00 and
    // 08:00 UTC — the same off-by-one the Pacific fix exists to remove.
    const dayIso = (daysAgo: number) => pacificDayIso(daysAgo)
    const LAG = 3
    const now = '2026-01-01T00:00:00.000Z'
    // 30 consecutive published days ending at the lag boundary, plus two older
    // days that a correct 30d window must EXCLUDE.
    for (let i = 0; i < 32; i += 1) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(), projectId, date: dayIso(LAG + i),
        clicks: 1, impressions: 10, position: '5', createdAt: now,
      }).run()
    }

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?window=30d',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    expect(body.window.latestDataDate).toBe(dayIso(LAG))
    expect(body.window.daysSinceLatestData).toBe(LAG)
    expect(body.window.endDate).toBe(dayIso(LAG))
    expect(body.window.startDate).toBe(dayIso(LAG + 29))

    // The label is honoured exactly: 30 days, not 27.
    expect(body.daily).toHaveLength(30)
    expect(body.totals.days).toBe(30)
    expect(body.totals.impressions).toBe(300)
    // And it stops: the two older seeded days are outside the window.
    expect(body.daily[0]!.date).toBe(dayIso(LAG + 29))
    expect(body.daily.at(-1)!.date).toBe(dayIso(LAG))
  })

  it('keeps a wider label a superset of a narrower one under reporting lag', () => {
    // The anomaly that started this: a 30d window reported FEWER impressions
    // than a 28d one because the two ranges only overlapped. Whatever the lag,
    // the wider window must contain the narrower.
    const dayIso = (daysAgo: number) => pacificDayIso(daysAgo)
    const now = '2026-01-01T00:00:00.000Z'
    for (let i = 0; i < 95; i += 1) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(), projectId, date: dayIso(2 + i),
        clicks: 1, impressions: 10, position: '5', createdAt: now,
      }).run()
    }
    return Promise.all(['7d', '30d', '90d'].map(async (w) => {
      const res = await context.app.inject({
        method: 'GET', url: `/projects/perf/google/gsc/performance/daily?window=${w}`,
      })
      return (res.json() as GscPerformanceDailyDto)
    })).then(([week, month, quarter]) => {
      expect(week!.totals.impressions).toBe(70)
      expect(month!.totals.impressions).toBe(300)
      expect(quarter!.totals.impressions).toBe(900)
      expect(month!.totals.impressions).toBeGreaterThan(week!.totals.impressions)
      expect(quarter!.totals.impressions).toBeGreaterThan(month!.totals.impressions)
    })
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
      { date: '2026-01-05', clicks: 25, impressions: 300, ctr: 25 / 300, position: 4 },
      { date: '2026-01-06', clicks: 31, impressions: 900, ctr: 31 / 900, position: 6 },
    ])
    // Position is impression-WEIGHTED: (4*300 + 6*900) / 1200 = 5.5. An
    // unweighted mean of the two days would read 5.0.
    expect(body.totals).toEqual({ clicks: 56, impressions: 1200, ctr: 56 / 1200, position: 5.5, positionDays: 2, days: 2 })
  })

  it('carries a period comparison, and never leaks the internal source tag onto the wire', async () => {
    // Four property-daily dates so the window splits into two 2-day periods.
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-01-05', clicks: 5, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-06', clicks: 5, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-07', clicks: 20, impressions: 200, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-08', clicks: 20, impressions: 200, position: '8', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      daily: Array<Record<string, unknown>>
      periodComparison: {
        days: number
        comparable: boolean
        prior: { clicks: number; source: string }
        trailing: { clicks: number; source: string }
        change: { clicks: number | null }
      }
    }

    expect(body.periodComparison.days).toBe(2)
    expect(body.periodComparison.comparable).toBe(true)
    expect(body.periodComparison.prior.clicks).toBe(10)
    expect(body.periodComparison.trailing.clicks).toBe(40)
    expect(body.periodComparison.change.clicks).toBe(3)
    expect(body.periodComparison.prior.source).toBe('property-daily')

    // `fromPropertyTotals` is the comparison module's INPUT, tagged at the call
    // site. It must never appear on a daily row: the row shape is the DTO's
    // contract, and an undeclared field would ship to every SDK consumer.
    for (const row of body.daily) {
      expect(Object.keys(row).sort()).toEqual(['clicks', 'ctr', 'date', 'impressions', 'position'])
    }
  })

  it('compares the requested window against the period before it when that period has no returned rows', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-09', clicks: 5, impressions: 50, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-10', clicks: 5, impressions: 50, position: '8', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-01&endDate=2026-03-10',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      daily: Array<{ date: string }>
      periodComparison: {
        days: number
        basis: string
        comparable: boolean
        prior: { startDate: string; endDate: string; clicks: number; source: string }
        trailing: { startDate: string; endDate: string; clicks: number; source: string }
        change: { clicks: number | null }
      }
    }

    expect(body.daily.map(row => row.date)).toEqual(['2026-03-09', '2026-03-10'])
    // The requested window is 10 days, so the comparison is 10 days against the
    // 10 before it — NOT the window's own two 5-day halves. The `beforeEach`
    // dimensioned rows put the data frontier back at 2026-01-05, so February is
    // inside it and its absent rows are measured zeroes.
    expect(body.periodComparison.basis).toBe('prior-window')
    expect(body.periodComparison.days).toBe(10)
    expect(body.periodComparison.trailing).toMatchObject({
      startDate: '2026-03-01', endDate: '2026-03-10', clicks: 10, source: 'property-daily',
    })
    expect(body.periodComparison.prior).toMatchObject({
      startDate: '2026-02-19', endDate: '2026-02-28', clicks: 0, source: 'empty',
    })
    // An empty period is a real zero, so it is comparable — but zero is not a
    // baseline a percentage can divide by.
    expect(body.periodComparison.comparable).toBe(true)
    expect(body.periodComparison.change.clicks).toBeNull()
  })

  it('does not treat trailing dates beyond the known frontier as measured zero', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-01', clicks: 5, impressions: 50, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-02', clicks: 5, impressions: 50, position: '8', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-01&endDate=2026-03-10',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto
    expect(body.window).toMatchObject({
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      latestDataDate: '2026-03-02',
    })
    expect(body.daily.map(row => row.date)).toEqual(['2026-03-01', '2026-03-02'])
    expect(body.totals.clicks).toBe(10)
    // March 3-10 are beyond the observed frontier, so their state is ambiguous
    // rather than proven zero. Before this guard the request split into an
    // active prior and an empty trailing half and falsely reported -100%.
    expect(body.periodComparison).toBeNull()
  })

  it('does compare a quiet trailing half inside the known data frontier', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    // This property's data starts on March 1: drop the `beforeEach` January
    // rows so the EARLIEST frontier is honest. February was never synced, so
    // there is no prior 10-day window to compare against and the window splits
    // — which is the arrangement this test is about.
    context.db.delete(gscSearchData).run()
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-01', clicks: 5, impressions: 50, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-02', clicks: 5, impressions: 50, position: '8', createdAt: now },
    ]).run()
    // The monotonic watermark can stay at March 10 after a later sync returns
    // no rows for the quiet tail. That makes March 3-10 known zeroes rather
    // than dates beyond the project's observed frontier.
    context.db.insert(gscDataWatermarks).values({
      projectId,
      dataThroughDate: '2026-03-10',
      syncedThroughDate: '2026-03-10',
      updatedAt: now,
    }).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-01&endDate=2026-03-10',
    })
    expect(res.statusCode).toBe(200)
    const comparison = (res.json() as GscPerformanceDailyDto).periodComparison
    expect(comparison?.basis).toBe('split-window')
    expect(comparison?.prior.source).toBe('property-daily')
    expect(comparison?.trailing.source).toBe('empty')
    expect(comparison?.change.clicks).toBe(-1)
  })

  /**
   * The defect a reader reported: pressing `90d` and reading "vs prior 45d".
   *
   * The number was never wrong — it named the period it measured, and that
   * period was half the window, because the window's own rows were the only
   * evidence on hand. Reading one window further back makes the percentage
   * answer the question the control asked.
   */
  it('compares the selected window against the equal-length period before it', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    // Eight property-daily days. The last four are the selected window; the
    // four before them are the prior period, and both are fully synced.
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-01', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-02', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-03', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-04', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-05', clicks: 30, impressions: 100, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-06', clicks: 30, impressions: 100, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-07', clicks: 30, impressions: 100, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-08', clicks: 30, impressions: 100, position: '8', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-05&endDate=2026-03-08',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // Four days selected, so the comparison is four days against four — NOT
    // the two-and-two the window's own halves would have given.
    expect(body.periodComparison?.basis).toBe('prior-window')
    expect(body.periodComparison?.days).toBe(4)
    expect(body.periodComparison?.trailing).toMatchObject({
      startDate: '2026-03-05', endDate: '2026-03-08', clicks: 120,
    })
    expect(body.periodComparison?.prior).toMatchObject({
      startDate: '2026-03-01', endDate: '2026-03-04', clicks: 40,
    })
    // 120 vs 40 is +200%. Split down the middle the same rows read 0% — both
    // periods sit inside the flat trailing stretch — so this is not a cosmetic
    // relabel of the same figure.
    expect(body.periodComparison?.change.clicks).toBe(2)
  })

  /**
   * The prior period is EVIDENCE, not extra days of chart. Widening the
   * returned series would move the totals and the fitted trend with it, and the
   * window label printed above them would then name a shorter range than the
   * data underneath.
   */
  it('reads the prior period without reporting it as part of the window', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-01', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-02', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-03', clicks: 30, impressions: 300, position: '6', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-04', clicks: 30, impressions: 300, position: '6', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-03&endDate=2026-03-04',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // The prior period was read — the comparison names it.
    expect(body.periodComparison?.prior).toMatchObject({
      startDate: '2026-03-01', endDate: '2026-03-02', clicks: 20,
    })
    // And it appears nowhere else. Series, totals, position weighting, and the
    // reported window all stop at the selection.
    expect(body.daily.map(row => row.date)).toEqual(['2026-03-03', '2026-03-04'])
    expect(body.totals).toEqual({
      clicks: 60, impressions: 600, ctr: 0.1, position: 6, positionDays: 2, days: 2,
    })
    expect(body.window).toMatchObject({ startDate: '2026-03-03', endDate: '2026-03-04' })
  })

  /**
   * The mirror of the trailing-frontier guard, and the reason it is needed:
   * days the sync never reached are not days of zero traffic. Counting them as
   * zero halves the baseline and prints a rise that never happened.
   */
  it('will not build a prior period out of days that were never synced', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    // This property's data starts 2026-03-05 — drop the `beforeEach` January
    // rows so the earliest frontier says so.
    context.db.delete(gscSearchData).run()
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-05', clicks: 90, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-06', clicks: 90, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-07', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-08', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-09', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-10', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-11', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-12', clicks: 10, impressions: 100, position: '10', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-07&endDate=2026-03-12',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // A prior six days would run 2026-03-01..2026-03-06, of which only the last
    // two were ever synced. Aggregated, that reads 180 clicks where the real
    // six days are unknown — and 60 trailing against a baseline built from a
    // partial period is a number about the backfill, not the property.
    expect(body.periodComparison?.basis).toBe('split-window')
    expect(body.periodComparison?.days).toBe(3)
    expect(body.periodComparison?.prior).toMatchObject({
      startDate: '2026-03-07', endDate: '2026-03-09', clicks: 30,
    })
    expect(body.periodComparison?.trailing).toMatchObject({
      startDate: '2026-03-10', endDate: '2026-03-12', clicks: 30,
    })
    // Both halves sit inside the synced span, so this is a real 0%.
    expect(body.periodComparison?.change.clicks).toBe(0)
  })

  /**
   * A prior period that reaches back only into dimensioned-only history is not
   * a synced prior window: `SUM(gsc_search_data)` is invalid for property
   * totals, so the comparison marks it not comparable. The observed frontier
   * (`readEarliestGscDataDate`) spans both tables and cannot see that, so it
   * would commit to `prior-window` and drop the tile percentage entirely — even
   * though the fully-property-daily selection still compares cleanly when split.
   * The split-window fallback is what preserves that number.
   */
  it('falls back to split-window when the prior period is dimensioned-only', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    // The selected window is fully property-daily.
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-05', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-06', clicks: 10, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-07', clicks: 30, impressions: 100, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-08', clicks: 30, impressions: 100, position: '8', createdAt: now },
    ]).run()
    // The prior period 2026-03-01..2026-03-04 has ONLY dimensioned rows, and the
    // `beforeEach` January rows put the earliest frontier back at 2026-01-05, so
    // the reach test treats the prior period as synced.
    const syncRunId = crypto.randomUUID()
    context.db.insert(runs).values({
      id: syncRunId, projectId, kind: 'gsc-sync', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
    for (const date of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']) {
      context.db.insert(gscSearchData).values({
        id: crypto.randomUUID(), projectId, syncRunId, date, query: 'q', page: '/p',
        country: 'usa', device: 'DESKTOP', impressions: 100, clicks: 5, ctr: '0.05', position: '5', createdAt: now,
      }).run()
    }

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-05&endDate=2026-03-08',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // The dimensioned-only prior period cannot support the ratio, so rather than
    // dropping the number the selection is split into its own two halves — both
    // property-daily, both comparable.
    expect(body.periodComparison?.basis).toBe('split-window')
    expect(body.periodComparison?.days).toBe(2)
    expect(body.periodComparison?.comparable).toBe(true)
    expect(body.periodComparison?.prior).toMatchObject({
      startDate: '2026-03-05', endDate: '2026-03-06', clicks: 20, source: 'property-daily',
    })
    expect(body.periodComparison?.trailing).toMatchObject({
      startDate: '2026-03-07', endDate: '2026-03-08', clicks: 60, source: 'property-daily',
    })
    // 60 vs 20 is +200%, a real comparison that the prior-window path would have
    // blanked. And the dimensioned prior days never enter the reported series.
    expect(body.periodComparison?.change.clicks).toBe(2)
    expect(body.daily.map(row => row.date)).toEqual(['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'])
  })

  /**
   * `window=all` has no lower bound, so there is no period before it to fetch.
   * The split is not a fallback there, it is the only thing that exists.
   */
  it('splits an unbounded window, which has nothing before it to compare with', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-01-05', clicks: 5, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-06', clicks: 5, impressions: 100, position: '10', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-07', clicks: 20, impressions: 200, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-01-08', clicks: 20, impressions: 200, position: '8', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?window=all',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto
    expect(body.periodComparison?.basis).toBe('split-window')
    expect(body.periodComparison?.days).toBe(2)
  })

  it('returns no comparison for an explicitly empty requested window', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2030-03-01&endDate=2030-03-10',
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { periodComparison: unknown }).periodComparison).toBeNull()
  })

  it('falls back to summing gsc_search_data by date when no gsc_daily_totals rows exist in the window', async () => {
    // No gsc_daily_totals seeded (only the dimensioned gsc_search_data from
    // beforeEach), so the endpoint falls back to the per-date dimensioned sum.
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      totals: { clicks: number; impressions: number; ctr: number; days: number }
      daily: Array<{ date: string; clicks: number; impressions: number; ctr: number }>
      periodComparison: {
        comparable: boolean
        prior: { source: string }
        trailing: { source: string }
        change: { clicks: number | null }
      }
    }

    // The dimensioned sum cannot produce a property position, so every date
    // reports `null` rather than the `0` the merge helper carries internally.
    expect(body.daily).toEqual([
      { date: '2026-01-05', clicks: 10, impressions: 350, ctr: 10 / 350, position: null },
      { date: '2026-01-06', clicks: 10, impressions: 1000, ctr: 0.01, position: null },
    ])
    expect(body.totals).toEqual({ clicks: 20, impressions: 1350, ctr: 20 / 1350, position: null, positionDays: 0, days: 2 })
    expect(body.periodComparison.prior.source).toBe('dimensioned')
    expect(body.periodComparison.trailing.source).toBe('dimensioned')
    expect(body.periodComparison.comparable).toBe(false)
    expect(body.periodComparison.change.clicks).toBeNull()
  })

  it('uses daily totals per date without dropping dimensioned fallback dates from the same window', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-01-06',
      clicks: 31,
      impressions: 900,
      position: '6',
      createdAt: now,
    }).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totals: { clicks: number; impressions: number; ctr: number; days: number }; daily: Array<{ date: string; clicks: number; impressions: number; ctr: number }> }

    // Only 2026-01-06 came from the property table, so only it carries a
    // position — and it alone weights the window mean.
    expect(body.daily).toEqual([
      { date: '2026-01-05', clicks: 10, impressions: 350, ctr: 10 / 350, position: null },
      { date: '2026-01-06', clicks: 31, impressions: 900, ctr: 31 / 900, position: 6 },
    ])
    expect(body.totals).toEqual({ clicks: 41, impressions: 1250, ctr: 41 / 1250, position: 6, positionDays: 1, days: 2 })
  })

  it('fits over the CALENDAR, so a quiet gap does not overstate the slope', async () => {
    // Search Analytics omits zero-data days, so `daily` holds only dates with
    // rows. Fitting the array index compresses a gap into one step: these four
    // observations read -10/day compressed and -2.8/day on the real calendar.
    const now = '2026-01-01T00:00:00.000Z'
    for (const [date, impressions] of [
      ['2026-04-01', 100], ['2026-04-02', 90], ['2026-04-03', 80], ['2026-04-10', 70],
    ] as const) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(), projectId, date, clicks: 1, impressions,
        position: '5', createdAt: now,
      }).run()
    }

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-04-01&endDate=2026-04-10',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // Only 4 dates carry rows...
    expect(body.daily).toHaveLength(4)
    // ...but the fit spans the 10-day calendar between them.
    expect(body.trends!.impressions!.slope).toBeCloseTo(-2.8, 6)
    expect(body.trends!.impressions!.slope).not.toBe(-10)
    expect(body.trends!.impressions!.startIndex).toBe(0)
    expect(body.trends!.impressions!.endIndex).toBe(9)
  })

  it('reports how much of the window the position figure covers', async () => {
    // A position averaged over 2 of 4 days is not the window's average, and the
    // response has to say which it is.
    const now = '2026-01-01T00:00:00.000Z'
    for (const [date, position] of [
      ['2026-05-01', '4'], ['2026-05-02', '6'],
    ] as const) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 10,
        position, createdAt: now,
      }).run()
    }
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-05-01&endDate=2026-05-02',
    })
    const body = res.json() as GscPerformanceDailyDto
    expect(body.totals.days).toBe(2)
    expect(body.totals.positionDays).toBe(2)
    expect(body.totals.position).toBe(5)
  })

  it('fits a least-squares trend per metric over the window', async () => {
    // Property rows over four days. Clicks 10 -> 40 (+10/day exactly),
    // impressions flat at 100, position 8 -> 5 (improving by 1/day).
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values([
      { id: crypto.randomUUID(), projectId, date: '2026-03-01', clicks: 10, impressions: 100, position: '8', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-02', clicks: 20, impressions: 100, position: '7', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-03', clicks: 30, impressions: 100, position: '6', createdAt: now },
      { id: crypto.randomUUID(), projectId, date: '2026-03-04', clicks: 40, impressions: 100, position: '5', createdAt: now },
    ]).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-03-01&endDate=2026-03-04',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto

    // Slope is PER DAY, and start/end are the endpoints a chart draws between.
    expect(body.trends!.clicks).toEqual({ slope: 10, intercept: 10, r2: 1, start: 10, end: 40, n: 4, startIndex: 0, endIndex: 3 })
    // A flat series is a perfect flat fit, not an undefined one.
    expect(body.trends!.impressions).toEqual({ slope: 0, intercept: 100, r2: 1, start: 100, end: 100, n: 4, startIndex: 0, endIndex: 3 })
    // Position falls as ranking IMPROVES, so the slope is negative.
    expect(body.trends!.position).toEqual({ slope: -1, intercept: 8, r2: 1, start: 8, end: 5, n: 4, startIndex: 0, endIndex: 3 })
    // CTR rises with clicks against constant impressions: 0.1 -> 0.4.
    expect(body.trends!.ctr!.slope).toBeCloseTo(0.1, 6)

    // The fitted endpoints span the window, so the whole-window change is
    // slope * (days - 1) — the figure the tile and the CLI both report.
    expect(body.trends!.clicks!.end - body.trends!.clicks!.start).toBe(10 * (body.totals.days - 1))
  })

  it('reports no position trend when every date came from the dimensioned fallback', async () => {
    // beforeEach seeds only gsc_search_data, so position is null on every date
    // and there is nothing to fit — while clicks and impressions still fit.
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto
    expect(body.trends!.position).toBeNull()
    expect(body.trends!.impressions).toEqual({ slope: 650, intercept: 350, r2: 1, start: 350, end: 1000, n: 2, startIndex: 0, endIndex: 1 })
  })

  it('can return date-only daily totals when no dimensioned rows exist for the window', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-02-01',
      clicks: 12,
      impressions: 500,
      position: '9',
      createdAt: now,
    }).run()

    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/perf/google/gsc/performance/daily?startDate=2026-02-01&endDate=2026-02-01',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as GscPerformanceDailyDto
    expect(body.totals).toEqual({ clicks: 12, impressions: 500, ctr: 12 / 500, position: 9, positionDays: 1, days: 1 })
    expect(body.daily).toEqual([{ date: '2026-02-01', clicks: 12, impressions: 500, ctr: 12 / 500, position: 9 }])
    // One day is not a line.
    expect(body.trends).toEqual({ clicks: null, impressions: null, ctr: null, position: null })
    expect(body.window!.startDate).toBe('2026-02-01')
    expect(body.window!.endDate).toBe('2026-02-01')
    // MAX across BOTH tables: the property row here is later than the
    // dimensioned rows the surrounding fixture seeds.
    expect(body.window!.latestDataDate).toBe('2026-02-01')
  })
})
