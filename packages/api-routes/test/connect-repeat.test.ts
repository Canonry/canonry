import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditLog, createClient, migrate } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import type { BingConnectionRecord, BingConnectionStore } from '../src/bing.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

// A client that re-sends the same connect in a loop: in October 2026 one
// install re-sent a GA4 connect Google refused about 680 times a day, and an
// unchanged Bing connect alongside it. Each test builds its own app, so check
// memory never leaks between tests.

const KEY_JSON = JSON.stringify({ client_email: 'sa@demo.iam.gserviceaccount.com', private_key: 'fake-key' })

async function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-repeat-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const credentials = new Map<string, Ga4CredentialRecord>()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: (projectName) => credentials.get(projectName),
    upsertConnection: (connection) => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: (projectName) => credentials.delete(projectName),
  }

  const google = new Map<string, GoogleConnectionRecord>()
  const googleConnectionStore: GoogleConnectionStore = {
    listConnections: (domain) => [...google.values()].filter((c) => c.domain === domain),
    getConnection: (domain, type) => google.get(`${domain}:${type}`),
    upsertConnection: (connection) => {
      google.set(`${connection.domain}:${connection.connectionType}`, connection)
      return connection
    },
    updateConnection: (domain, type, patch) => {
      const existing = google.get(`${domain}:${type}`)
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      google.set(`${domain}:${type}`, next)
      return next
    },
    deleteConnection: (domain, type) => google.delete(`${domain}:${type}`),
  }

  const bing = new Map<string, BingConnectionRecord>()
  const bingConnectionStore: BingConnectionStore = {
    getConnection: (domain) => bing.get(domain),
    upsertConnection: (connection) => {
      bing.set(connection.domain, connection)
      return connection
    },
    updateConnection: (domain, patch) => {
      const existing = bing.get(domain)
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      bing.set(domain, next)
      return next
    },
    deleteConnection: (domain) => bing.delete(domain),
  }

  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    ga4CredentialStore,
    googleConnectionStore,
    getGoogleAuthConfig: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
    bingConnectionStore,
  })
  await app.ready()

  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/test-project',
    payload: { displayName: 'Test Project', canonicalDomain: 'example.com', country: 'US', language: 'en' },
  })
  const projectId = JSON.parse(res.payload).id as string

  const audits = (action: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all().length

  return { app, tmpDir, projectId, credentials, google, bing, audits }
}

let ctx: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  ctx = await buildApp()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

// `inject` sends no canonry user agent, so by default these calls are an API client.
function gaConnect(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/ga/connect', payload, headers })
}

function bingConnect(apiKey: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/bing/connect', payload: { apiKey }, headers })
}

describe('GA4 connect, repeated', () => {
  it('answers a property Google refuses with a 403 a client can stop on, and stops asking Google after three refusals', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockRejectedValue(new ga.GA4ApiError('The caller does not have permission', 403))

    const first = await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(first.statusCode).toBe(403)
    const body = JSON.parse(first.payload)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details).toMatchObject({ reason: 'ga4-permission-missing', propertyId: '123', retryable: false })
    expect(body.error.message).toContain('sa@demo.iam.gserviceaccount.com')
    expect(body.error.message).toContain('Property access management')

    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(3)

    const replayed = await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(replayed.statusCode).toBe(403)
    const replayedBody = JSON.parse(replayed.payload)
    expect(replayedBody.error.message).toBe(body.error.message)
    expect(replayedBody.error.details.nextCheckAt).toEqual(expect.any(String))
    expect(verify).toHaveBeenCalledTimes(3)

    // Another property is a new question for Google.
    await gaConnect({ propertyId: '456', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(4)
    expect(ctx.credentials.size).toBe(0)
  })

  it('asks Google again when the backoff runs out, and waits longer each time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockRejectedValue(new ga.GA4ApiError('The caller does not have permission', 403))
    const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60 * 1000)

    for (let i = 0; i < 4; i++) await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(3)
    minutes(5)
    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(4)
    minutes(5)
    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(4)
    minutes(5)
    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(5)
  })

  it('checks again straight away when an operator grants access and retries', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection')
      .mockRejectedValueOnce(new ga.GA4ApiError('The caller does not have permission', 403))
      .mockRejectedValueOnce(new ga.GA4ApiError('The caller does not have permission', 403))
      .mockResolvedValue(true)

    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect((await gaConnect({ propertyId: '123', keyJson: KEY_JSON })).statusCode).toBe(200)
    expect(verify).toHaveBeenCalledTimes(3)
    expect(ctx.credentials.get('test-project')?.propertyId).toBe('123')
  })

  it('always checks again for the CLI and the dashboard, while an API client waits', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockRejectedValue(new ga.GA4ApiError('The caller does not have permission', 403))
    const body = { propertyId: '123', keyJson: KEY_JSON }

    for (let i = 0; i < 4; i++) await gaConnect(body)
    expect(verify).toHaveBeenCalledTimes(3)
    await gaConnect(body, { 'user-agent': 'canonry-cli/7.45.2' })
    expect(verify).toHaveBeenCalledTimes(4)
    await gaConnect(body, { 'user-agent': 'Mozilla/5.0 (Macintosh)' })
    expect(verify).toHaveBeenCalledTimes(5)
    await gaConnect(body, { 'x-canonry-surface': 'cli' })
    expect(verify).toHaveBeenCalledTimes(6)
    // A valid label wins over the user agent, as it does for usage telemetry.
    await gaConnect(body, { 'x-canonry-surface': 'api', 'user-agent': 'Mozilla/5.0 (Macintosh)' })
    expect(verify).toHaveBeenCalledTimes(6)
  })

  it('checks a new key file straight away, even while backing off', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockRejectedValue(new ga.GA4ApiError('The caller does not have permission', 403))

    for (let i = 0; i < 4; i++) await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(3)
    const rotatedKey = JSON.stringify({ client_email: 'sa@demo.iam.gserviceaccount.com', private_key: 'rotated-key' })
    await gaConnect({ propertyId: '123', keyJson: rotatedKey })
    expect(verify).toHaveBeenCalledTimes(4)
    const otherAccount = JSON.stringify({ client_email: 'other@demo.iam.gserviceaccount.com', private_key: 'fake-key' })
    await gaConnect({ propertyId: '123', keyJson: otherAccount })
    expect(verify).toHaveBeenCalledTimes(5)
  })

  it('keeps other verification failures a 400 and checks them again every time', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockRejectedValue(new ga.GA4ApiError('Invalid property', 400))

    const first = await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(first.statusCode).toBe(400)
    expect(JSON.parse(first.payload).error.code).toBe('VALIDATION_ERROR')
    for (let i = 0; i < 4; i++) await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(verify).toHaveBeenCalledTimes(5)
  })

  it('treats an unchanged repeat of a working connection as a no-op', async () => {
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockResolvedValue(true)

    expect((await gaConnect({ propertyId: '123', keyJson: KEY_JSON })).statusCode).toBe(200)
    const stored = ctx.credentials.get('test-project')
    expect(ctx.audits('ga4.connected')).toBe(1)

    const repeat = await gaConnect({ propertyId: '123', keyJson: KEY_JSON })
    expect(repeat.statusCode).toBe(200)
    expect(JSON.parse(repeat.payload)).toMatchObject({ connected: true, propertyId: '123', authMethod: 'service-account' })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(ctx.credentials.get('test-project')).toBe(stored)
    expect(ctx.audits('ga4.connected')).toBe(1)
  })

  it('backs off an OAuth refusal without refreshing the token or calling Google', async () => {
    const now = new Date().toISOString()
    ctx.google.set('example.com:ga4', {
      domain: 'example.com',
      connectionType: 'ga4',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAt: now,
      updatedAt: now,
    })
    const ga = await import('@canonry/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnectionWithToken').mockRejectedValue(new ga.GA4ApiError('The caller does not have permission', 403))

    const first = await gaConnect({ propertyId: '123' })
    expect(first.statusCode).toBe(403)
    expect(JSON.parse(first.payload).error.message).toContain('the connected Google account')
    for (let i = 0; i < 3; i++) expect((await gaConnect({ propertyId: '123' })).statusCode).toBe(403)
    expect(verify).toHaveBeenCalledTimes(3)
    expect(ctx.google.get('example.com:ga4')?.propertyId).toBeUndefined()

    // A new grant (`canonry google connect` again) is a new refresh token: checked straight away.
    ctx.google.set('example.com:ga4', { ...ctx.google.get('example.com:ga4')!, refreshToken: 'refresh-token-2' })
    await gaConnect({ propertyId: '123' })
    expect(verify).toHaveBeenCalledTimes(4)
  })
})

describe('Bing connect, repeated', () => {
  it('treats the stored key re-sent as a no-op and lists its sites without calling Bing again', async () => {
    const now = new Date().toISOString()
    ctx.bing.set('example.com', {
      domain: 'example.com',
      apiKey: 'key-1',
      siteUrl: 'https://example.com/',
      createdByProjectId: ctx.projectId,
      createdAt: now,
      updatedAt: now,
    })
    const stored = ctx.bing.get('example.com')
    const bingModule = await import('@canonry/canonry-integration-bing')
    const getSites = vi.spyOn(bingModule, 'getSites').mockResolvedValue([{ Url: 'https://example.com/', IsVerified: true }])

    for (let i = 0; i < 2; i++) {
      const res = await bingConnect('key-1')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({
        connected: true,
        domain: 'example.com',
        siteUrl: 'https://example.com/',
        availableSites: [{ url: 'https://example.com/', verified: true }],
      })
    }
    expect(getSites).toHaveBeenCalledTimes(1)
    expect(ctx.bing.get('example.com')).toBe(stored)
    expect(ctx.audits('bing.connected')).toBe(0)

    // The dashboard always gets a fresh site list.
    expect((await bingConnect('key-1', { 'user-agent': 'Mozilla/5.0 (Macintosh)' })).statusCode).toBe(200)
    expect(getSites).toHaveBeenCalledTimes(2)
    expect(ctx.audits('bing.connected')).toBe(0)

    // A new key is checked and stored.
    expect((await bingConnect('key-2')).statusCode).toBe(200)
    expect(getSites).toHaveBeenCalledTimes(3)
    expect(ctx.bing.get('example.com')?.apiKey).toBe('key-2')
    expect(ctx.audits('bing.connected')).toBe(1)
  })
})
