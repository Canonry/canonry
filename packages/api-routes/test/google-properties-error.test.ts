import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
// `GoogleApiError` / `GoogleAuthError` are spread through from the real module
// by the mock below, so these are the same class identities google.ts checks
// `instanceof` against.
import { GoogleApiError, GoogleAuthError } from '@ainyc/canonry-integration-google'
import { googleRoutes } from '../src/google.js'

// Make the live GSC calls throwable on demand without touching the network.
// `state.listError` / `state.refreshError` are read inside the hoisted mock
// factory, so a test can set the next thrown error before injecting a request.
// `importActual` keeps the real error classes so `instanceof` in google.ts
// still matches what we throw.
const state = vi.hoisted(() => ({ listError: null as Error | null, refreshError: null as Error | null }))

vi.mock('@ainyc/canonry-integration-google', async (importActual) => {
  const actual = await importActual<typeof import('@ainyc/canonry-integration-google')>()
  return {
    ...actual,
    listSites: vi.fn(async () => {
      if (state.listError) throw state.listError
      return []
    }),
    // Exercised only when the connection token is expired (see buildApp opts),
    // which forces getValidToken down the refresh path.
    refreshAccessToken: vi.fn(async () => {
      if (state.refreshError) throw state.refreshError
      return { access_token: 'refreshed-token', expires_in: 3600, token_type: 'Bearer', scope: '' }
    }),
  }
})

function buildApp(opts: { tokenExpiresAt?: string } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-properties-error-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_1',
    name: 'proxter',
    displayName: 'Proxter',
    canonicalDomain: 'proxter.com',
    ownedDomains: '[]',
    country: 'US',
    language: 'en',
    tags: '[]',
    labels: '{}',
    providers: '["gemini"]',
    locations: '[]',
    defaultLocation: null,
    configSource: 'api',
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
  }).run()

  // A connection whose access token is comfortably unexpired by default, so
  // getValidToken returns it directly and never hits the (mocked-out) refresh
  // path. Pass `tokenExpiresAt` in the past to force the refresh path instead.
  const connection = {
    domain: 'proxter.com',
    connectionType: 'gsc' as const,
    propertyId: 'sc-domain:proxter.com',
    accessToken: 'fresh-access-token',
    refreshToken: 'refresh-token',
    tokenExpiresAt: opts.tokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    createdAt: now,
    updatedAt: now,
  }

  const app = Fastify()
  app.decorate('db', db)
  // Mirror the production global handler: AppError → its own status + envelope.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })

  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
    googleConnectionStore: {
      listConnections: (domain: string) => (domain === connection.domain ? [connection] : []),
      getConnection: (domain: string, type: string) =>
        domain === connection.domain && type === connection.connectionType ? connection : undefined,
      upsertConnection: (c: typeof connection) => c,
      updateConnection: (_d: string, _t: string, patch: Partial<typeof connection>) => {
        Object.assign(connection, patch)
        return connection
      },
      deleteConnection: () => true,
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
  })
  return { app, tmpDir }
}

describe('GET /projects/:name/google/properties — upstream Google failure mapping', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app']
  let tmpDir: string

  beforeEach(async () => {
    state.listError = null
    state.refreshError = null
    const built = await buildApp()
    app = built.app
    tmpDir = built.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function getProperties() {
    return app.inject({ method: 'GET', url: '/projects/proxter/google/properties' })
  }

  // The bug: a Google 403 (API not enabled) reached the dashboard, whose
  // response interceptor treated ANY 403 as session expiry → the operator was
  // booted the instant they connected Search Console. The backend half of the
  // fix keeps it a FORBIDDEN (correct + non-retryable) but lifts the GCP project
  // number + enable link into structured `details` so the UI can remediate; the
  // frontend half (separate) stops logging out on a 403. The invariant enforced
  // here is that this is NEVER a 401 (the only status that means "session
  // invalid, re-login") and that config errors are non-retryable 403s.
  it('maps a Google 403 (API not enabled) to 403 FORBIDDEN with structured remediation', async () => {
    state.listError = new GoogleApiError(
      'GSC API error (403): {"error":{"status":"PERMISSION_DENIED","message":"Google Search Console API has not been used in project 729411988784 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=729411988784 then retry.","errors":[{"reason":"accessNotConfigured"}]}}',
      403,
    )
    const res = await getProperties()
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/not enabled/i)
    // The dashboard reads these to render the one-click "Action needed" banner.
    expect(body.error.details).toMatchObject({
      reason: 'gsc-api-disabled',
      projectNumber: '729411988784',
      enableUrl: 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=729411988784',
      indexingApiUrl: 'https://console.developers.google.com/apis/api/indexing.googleapis.com/overview?project=729411988784',
    })
  })

  it('maps a Google 403 (no property access) to 403 FORBIDDEN with a reconnect hint', async () => {
    state.listError = new GoogleApiError('GSC API error (403): {"error":{"message":"User does not have sufficient permission"}}', 403)
    const res = await getProperties()
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/does not have access/i)
    expect(body.error.details).toMatchObject({ reason: 'gsc-no-property-access' })
  })

  it('maps a Google 401 (token revoked) to 403 FORBIDDEN, never 401', async () => {
    state.listError = new GoogleApiError('Access token expired or revoked', 401)
    const res = await getProperties()
    // The critical invariant: NOT 401, so the dashboard never reads this as a
    // canonry session expiry and never boots the operator.
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/expired or was revoked/i)
    expect(body.error.details).toMatchObject({ reason: 'gsc-reconnect' })
  })

  it('maps a Google 429 to 429 QUOTA_EXCEEDED (retryable)', async () => {
    state.listError = new GoogleApiError('Google API rate limit exceeded', 429)
    const res = await getProperties()
    expect(res.statusCode).toBe(429)
    const body = res.json() as { error: { code: string } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
  })

  it('maps a transient Google 5xx to 502 PROVIDER_ERROR (retryable)', async () => {
    state.listError = new GoogleApiError('GSC API error (503): backend unavailable', 503)
    const res = await getProperties()
    expect(res.statusCode).toBe(502)
    expect((res.json() as { error: { code: string } }).error.code).toBe('PROVIDER_ERROR')
  })

  it('returns the property list unchanged on success', async () => {
    state.listError = null
    const res = await getProperties()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sites: [] })
  })

  it('never responds 401 for any upstream Google status (would falsely boot the operator)', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      state.listError = new GoogleApiError(`GSC API error (${status}): upstream`, status)
      const res = await getProperties()
      expect(res.statusCode).not.toBe(401)
    }
  })
})

describe('GET /projects/:name/google/properties — credential refresh failure mapping', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app']
  let tmpDir: string

  beforeEach(async () => {
    state.listError = null
    state.refreshError = null
    // An already-expired token forces getValidToken down the refresh path, so
    // whatever `state.refreshError` holds is what the route has to map.
    const built = await buildApp({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() })
    app = built.app
    tmpDir = built.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function getProperties() {
    return app.inject({ method: 'GET', url: '/projects/proxter/google/properties' })
  }

  // Regression guard: a revoked refresh token comes back as 400 invalid_grant.
  // refreshAccessToken throws a GoogleAuthError WITHOUT a statusCode for that
  // case (it only sets one for 429) — exactly as the real module does — so the
  // mapper must recover 400 from the message and classify it as a non-retryable
  // reconnect (403 gsc-reconnect) rather than a retryable 502, and never a 401.
  it('maps a revoked refresh token (GoogleAuthError 400, no statusCode) to 403 FORBIDDEN gsc-reconnect', async () => {
    state.refreshError = new GoogleAuthError('Token refresh failed (400): invalid_grant')
    const res = await getProperties()
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/no longer valid/i)
    expect(body.error.details).toMatchObject({ reason: 'gsc-reconnect', upstreamStatus: 400 })
  })

  it('maps an OAuth 429 refresh rate-limit to 429 QUOTA_EXCEEDED (retryable)', async () => {
    state.refreshError = new GoogleAuthError('Google OAuth rate limit exceeded', 429)
    const res = await getProperties()
    expect(res.statusCode).toBe(429)
    expect((res.json() as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED')
  })

  it('maps a transient OAuth 5xx refresh failure (no statusCode) to 502 PROVIDER_ERROR (retryable)', async () => {
    state.refreshError = new GoogleAuthError('Token refresh failed (503): backend error')
    const res = await getProperties()
    expect(res.statusCode).toBe(502)
    expect((res.json() as { error: { code: string } }).error.code).toBe('PROVIDER_ERROR')
  })
})
