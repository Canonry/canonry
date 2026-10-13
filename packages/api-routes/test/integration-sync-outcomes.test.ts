import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { BingApiError } from '@ainyc/canonry-integration-bing'
import { GA4ApiError } from '@ainyc/canonry-integration-google-analytics'
import { GoogleAuthError } from '@ainyc/canonry-integration-google'
import { apiRoutes, credentialFailure, type OutcomeTelemetryEvent } from '../src/index.js'
import type { BingConnectionRecord } from '../src/bing.js'
import type { Ga4CredentialRecord } from '../src/ga.js'
import type { GoogleConnectionRecord } from '../src/google.js'

const NOW = '2026-10-09T12:00:00.000Z'
const CLI = { 'user-agent': 'canonry-cli/7.19.0', 'x-canonry-surface': 'cli', 'x-canonry-agent': 'none' }
const CLI_ATTRIBUTION = { userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'cli', agentLabel: 'none' }
const SCHEDULER = { 'user-agent': 'canonry-cli/7.19.0', 'x-canonry-surface': 'system', 'x-canonry-agent': 'none' }

async function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-sync-outcomes-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const outcomes: OutcomeTelemetryEvent[] = []
  const googleConnections: GoogleConnectionRecord[] = []
  const bingConnections = new Map<string, BingConnectionRecord>()
  const gaCredentials = new Map<string, Ga4CredentialRecord>()

  const app = Fastify()
  await app.register(apiRoutes, {
    db,
    skipAuth: true,
    onOutcome: (event) => outcomes.push(event),
    getGoogleAuthConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
    googleConnectionStore: {
      listConnections: (domain) => googleConnections.filter((c) => c.domain === domain),
      getConnection: (domain, type) => googleConnections.find((c) => c.domain === domain && c.connectionType === type),
      upsertConnection: (connection) => {
        googleConnections.push(connection)
        return connection
      },
      updateConnection: (domain, type, patch) => {
        const existing = googleConnections.find((c) => c.domain === domain && c.connectionType === type)
        if (existing) Object.assign(existing, patch)
        return existing
      },
      deleteConnection: () => false,
    },
    bingConnectionStore: {
      getConnection: (domain) => bingConnections.get(domain),
      upsertConnection: (connection) => {
        bingConnections.set(connection.domain, connection)
        return connection
      },
      updateConnection: () => undefined,
      deleteConnection: (domain) => bingConnections.delete(domain),
    },
    ga4CredentialStore: {
      getConnection: (name) => gaCredentials.get(name),
      upsertConnection: (record) => {
        gaCredentials.set(record.projectName, record)
        return record
      },
      deleteConnection: (name) => gaCredentials.delete(name),
    },
  })
  await app.ready()
  await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/harborline',
    payload: { displayName: 'Harborline', canonicalDomain: 'example.com', country: 'US', language: 'en' },
  })
  // The project PUT reports nothing; start each test from an empty sink.
  outcomes.length = 0
  return { app, db, tmpDir, outcomes, googleConnections, bingConnections, gaCredentials }
}

let ctx: Awaited<ReturnType<typeof buildApp>>
const originalFetch = globalThis.fetch

beforeEach(async () => {
  ctx = await buildApp()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

function gscConnection(scopes: string[], propertyId: string | null = 'sc-domain:example.com'): GoogleConnectionRecord {
  return {
    domain: 'example.com', connectionType: 'gsc', propertyId, accessToken: 'tok', refreshToken: 'rt',
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes, createdAt: NOW, updatedAt: NOW,
  }
}

const FULL_SCOPE = 'https://www.googleapis.com/auth/webmasters'

describe('credential exchange failures', () => {
  it('reads a rejected exchange as invalid credentials unless it was throttled or never answered', () => {
    expect(credentialFailure(new GoogleAuthError('Token refresh failed (400): invalid_grant'))).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'GoogleAuthError' })
    expect(credentialFailure(new GA4ApiError('Failed to get access token', 401))).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'GA4ApiError' })
    expect(credentialFailure(new GoogleAuthError('Google OAuth rate limit exceeded', 429))).toEqual({ reasonCode: 'RATE_LIMITED', errorName: 'GoogleAuthError' })
    expect(credentialFailure(new TypeError('fetch failed'))).toEqual({ reasonCode: 'NETWORK', errorName: 'TypeError' })
    expect(credentialFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toEqual({ reasonCode: 'TIMEOUT', errorName: 'TimeoutError' })
  })
})

describe('search_console sitemap_submit outcome', () => {
  it('reports accepted and failed sitemaps, with a partial batch classified by the refusal', async () => {
    ctx.googleConnections.push(gscConnection([FULL_SCOPE]))
    let call = 0
    globalThis.fetch = async () => (++call === 2 ? new Response('forbidden', { status: 403 }) : new Response(null, { status: 204 }))

    const ok = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/sitemaps/submit', headers: CLI,
      payload: { sitemapUrls: ['https://example.com/sitemap.xml'] },
    })
    const partial = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/sitemaps/submit', headers: CLI,
      payload: { sitemapUrls: ['https://example.com/a.xml', 'https://example.com/b.xml'] },
    })

    expect(ok.statusCode).toBe(200)
    expect(partial.json().summary).toEqual({ total: 2, accepted: 1, failed: 1 })
    expect(ctx.outcomes).toEqual([
      {
        event: 'feature.completed',
        properties: { feature: 'search_console', operation: 'sitemap_submit', status: 'succeeded', durationBucket: 'under_1s', counts: { urls: 1, failures: 0 } },
        attribution: CLI_ATTRIBUTION,
      },
      {
        event: 'feature.completed',
        properties: {
          feature: 'search_console', operation: 'sitemap_submit', status: 'partial', reasonCode: 'PERMISSION_MISSING',
          errorName: 'GoogleApiError', durationBucket: 'under_1s', counts: { urls: 1, failures: 1 },
        },
        attribution: CLI_ATTRIBUTION,
      },
    ])
  })

  it('reports a refused submission by its reason: read-only scope, no connection', async () => {
    ctx.googleConnections.push(gscConnection(['https://www.googleapis.com/auth/webmasters.readonly']))
    const readOnly = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/sitemaps/submit', headers: CLI,
      payload: { sitemapUrls: ['https://example.com/sitemap.xml'] },
    })
    ctx.googleConnections.length = 0
    const notConnected = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/sitemaps/submit', headers: CLI,
      payload: { sitemapUrls: ['https://example.com/sitemap.xml'] },
    })

    expect([readOnly.statusCode, notConnected.statusCode]).toEqual([400, 400])
    expect(ctx.outcomes.map((event) => event.properties)).toEqual([
      { feature: 'search_console', operation: 'sitemap_submit', status: 'failed', reasonCode: 'PERMISSION_MISSING', durationBucket: 'under_1s' },
      { feature: 'search_console', operation: 'sitemap_submit', status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s' },
    ])
  })
})

describe('search_console inspect outcome', () => {
  it('reports a single inspection, an expired token and an unselected property', async () => {
    ctx.googleConnections.push(gscConnection([FULL_SCOPE]))
    globalThis.fetch = async () => new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }), { status: 200 })
    const inspected = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/inspect', headers: CLI, payload: { url: 'https://example.com/a' },
    })
    globalThis.fetch = async () => new Response('', { status: 401 })
    const expired = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/inspect', headers: CLI, payload: { url: 'https://example.com/a' },
    })
    ctx.googleConnections[0]!.propertyId = null
    const unselected = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/harborline/google/gsc/inspect', headers: CLI, payload: { url: 'https://example.com/a' },
    })

    expect([inspected.statusCode, expired.statusCode, unselected.statusCode]).toEqual([200, 403, 400])
    expect(ctx.outcomes.map((event) => event.properties)).toEqual([
      { feature: 'search_console', operation: 'inspect', status: 'succeeded', durationBucket: 'under_1s', counts: { urls: 1 } },
      { feature: 'search_console', operation: 'inspect', status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'GoogleApiError', durationBucket: 'under_1s' },
      { feature: 'search_console', operation: 'inspect', status: 'failed', reasonCode: 'PROPERTY_NOT_FOUND', durationBucket: 'under_1s' },
    ])
  })
})

describe('bing inspect outcome', () => {
  function connectBing(siteUrl: string | null = 'https://example.com/') {
    ctx.bingConnections.set('example.com', { domain: 'example.com', apiKey: 'bing-key', siteUrl, createdAt: NOW, updatedAt: NOW })
  }

  it('reports a single inspection and a throttled one as rate limited', async () => {
    connectBing()
    const bing = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bing, 'getCrawlIssues').mockResolvedValue([])
    const getUrlInfo = vi.spyOn(bing, 'getUrlInfo').mockResolvedValue({ Url: 'https://example.com/a', HttpStatus: 200, DocumentSize: 1024 })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/bing/inspect-url', headers: CLI, payload: { url: 'https://example.com/a' } })
    getUrlInfo.mockRejectedValue(new BingApiError('Bing API error (400): {"ErrorCode":5}', 400, 5))
    const throttled = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/bing/inspect-url', headers: CLI, payload: { url: 'https://example.com/a' } })

    expect(throttled.statusCode).toBeGreaterThanOrEqual(400)
    expect(ctx.outcomes).toEqual([
      {
        event: 'feature.completed',
        properties: { feature: 'bing', operation: 'inspect', status: 'succeeded', durationBucket: 'under_1s', counts: { urls: 1 } },
        attribution: CLI_ATTRIBUTION,
      },
      {
        event: 'feature.completed',
        properties: { feature: 'bing', operation: 'inspect', status: 'failed', reasonCode: 'RATE_LIMITED', errorName: 'BingApiError', durationBucket: 'under_1s' },
        attribution: CLI_ATTRIBUTION,
      },
    ])
  })

  it('reports a missing connection and a missing site by reason', async () => {
    const notConnected = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/bing/inspect-url', headers: CLI, payload: { url: 'https://example.com/a' } })
    connectBing(null)
    const noSite = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/bing/inspect-url', headers: CLI, payload: { url: 'https://example.com/a' } })

    expect([notConnected.statusCode, noSite.statusCode]).toEqual([400, 400])
    expect(ctx.outcomes.map((event) => event.properties)).toEqual([
      { feature: 'bing', operation: 'inspect', status: 'failed', reasonCode: 'NOT_CONNECTED', errorName: 'AppError', durationBucket: 'under_1s' },
      { feature: 'bing', operation: 'inspect', status: 'failed', reasonCode: 'PROPERTY_NOT_FOUND', durationBucket: 'under_1s' },
    ])
  })
})

describe('ga4 sync outcome', () => {
  function dateDaysAgo(days: number): string {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
  }

  async function mockGa(options: { rows?: boolean; acquisition?: Error } = {}) {
    const ga = await import('@ainyc/canonry-integration-google-analytics')
    const withData = options.rows ?? true
    vi.spyOn(ga, 'getAccessToken').mockResolvedValue('ga-token')
    vi.spyOn(ga, 'fetchAggregateSummary').mockResolvedValue({
      periodStart: dateDaysAgo(30), periodEnd: dateDaysAgo(1), totalSessions: 80, totalOrganicSessions: 30, totalUsers: 55,
    })
    vi.spyOn(ga, 'fetchWindowSummary').mockImplementation(async (_token, _property, windowKey) => ({
      windowKey, periodStart: dateDaysAgo(30), periodEnd: dateDaysAgo(1), totalSessions: 1, totalOrganicSessions: 0, totalDirectSessions: 0, totalUsers: 1,
    }))
    vi.spyOn(ga, 'fetchDailyTotals').mockResolvedValue(withData
      ? [{ date: dateDaysAgo(2), sessions: 50, users: 33, engagementRate: 0.6, newUsers: 20 }]
      : [])
    vi.spyOn(ga, 'fetchTrafficByLandingPage').mockResolvedValue(withData
      ? [
          { date: dateDaysAgo(2), landingPage: '/a', sessions: 30, organicSessions: 10, users: 20 },
          { date: dateDaysAgo(2), landingPage: '/b', sessions: 20, organicSessions: 5, users: 13 },
        ]
      : [])
    vi.spyOn(ga, 'fetchAiReferrals').mockResolvedValue([])
    vi.spyOn(ga, 'fetchSocialReferrals').mockResolvedValue(withData
      ? [{ date: dateDaysAgo(2), source: 'facebook.com', medium: 'social', sessions: 4, users: 3, channelGroup: 'Organic Social' }]
      : [])
    vi.spyOn(ga, 'fetchSearchLandingPages').mockResolvedValue({ status: 'ready', windows: [] })
    vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({ startDate: dateDaysAgo(90), endDate: dateDaysAgo(0), attributionScope: 'landing-page', rows: [] })
    const acquisition = vi.spyOn(ga, 'fetchAcquisitionByChannel')
    if (options.acquisition) acquisition.mockRejectedValue(options.acquisition)
    else acquisition.mockResolvedValue({ startDate: dateDaysAgo(90), endDate: dateDaysAgo(0), rows: [] })
  }

  function connectGa() {
    ctx.gaCredentials.set('harborline', {
      projectName: 'harborline', propertyId: '999888', clientEmail: 'sa@example.iam.gserviceaccount.com', privateKey: 'k', createdAt: NOW, updatedAt: NOW,
    })
  }

  it('reports every stored row, and a data-refresh request with the scheduler label', async () => {
    connectGa()
    await mockGa()

    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: SCHEDULER, payload: { days: 30 } })

    expect(res.statusCode).toBe(200)
    expect(ctx.outcomes).toEqual([{
      event: 'feature.completed',
      // Landing-page rows, daily totals and social referrals.
      properties: { feature: 'ga4', operation: 'sync', status: 'succeeded', durationBucket: 'under_1s', counts: { rows: 4 } },
      attribution: { userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'system', agentLabel: 'none' },
    }])
  })

  it('reports a property without traffic as skipped and a failed measurement component as partial', async () => {
    connectGa()
    await mockGa({ rows: false })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: CLI, payload: {} })
    vi.restoreAllMocks()
    await mockGa({ acquisition: new GA4ApiError('GA4 API error (403)', 403) })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: CLI, payload: {} })

    expect(ctx.outcomes.map((event) => event.properties)).toEqual([
      { feature: 'ga4', operation: 'sync', status: 'skipped', reasonCode: 'NO_DATA', durationBucket: 'under_1s', counts: { rows: 0 } },
      {
        feature: 'ga4', operation: 'sync', status: 'partial', reasonCode: 'PERMISSION_MISSING', errorName: 'GA4ApiError',
        durationBucket: 'under_1s', counts: { rows: 4 },
      },
    ])
  })

  it('reports a missing connection, an unselected property and a property Google no longer knows', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: CLI, payload: {} })
    ctx.googleConnections.push({
      domain: 'example.com', connectionType: 'ga4', propertyId: null, accessToken: 'tok', refreshToken: 'rt',
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], createdAt: NOW, updatedAt: NOW,
    })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: CLI, payload: {} })
    connectGa()
    await mockGa()
    const ga = await import('@ainyc/canonry-integration-google-analytics')
    vi.spyOn(ga, 'fetchAggregateSummary').mockRejectedValue(new GA4ApiError('GA4 API error (404)', 404))
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborline/ga/sync', headers: CLI, payload: {} })

    expect(ctx.outcomes.map((event) => event.properties)).toEqual([
      { feature: 'ga4', operation: 'sync', status: 'failed', reasonCode: 'NOT_CONNECTED', errorName: 'AppError', durationBucket: 'under_1s' },
      { feature: 'ga4', operation: 'sync', status: 'failed', reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'AppError', durationBucket: 'under_1s' },
      { feature: 'ga4', operation: 'sync', status: 'failed', reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'GA4ApiError', durationBucket: 'under_1s' },
    ])
  })
})
