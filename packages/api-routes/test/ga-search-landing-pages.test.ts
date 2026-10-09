import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { gaSearchLandingPagesResponseSchema, ga4SyncResponseDtoSchema, RunStatuses } from '@ainyc/canonry-contracts'
import {
  createClient,
  gaAcquisitionDaily,
  gaMeasurementSyncStates,
  gaSearchLandingPages,
  gaSearchLandingWindows,
  migrate,
  runs,
} from '@ainyc/canonry-db'
import { GA4ApiError } from '@ainyc/canonry-integration-google-analytics'
import type { GA4SearchLandingReport, GA4SearchLandingWindowReport } from '@ainyc/canonry-integration-google-analytics'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

const PROJECT = 'search-landing'

function dateDaysAgo(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-search-landing-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const credentials = new Map<string, Ga4CredentialRecord>()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: projectName => credentials.get(projectName),
    upsertConnection: connection => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: projectName => credentials.delete(projectName),
  }
  // The domain's OAuth connections, keyed `${domain}:${type}` like the real store.
  const googleConnections = new Map<string, GoogleConnectionRecord>()
  const googleConnectionStore: GoogleConnectionStore = {
    listConnections: domain => [...googleConnections.values()].filter(connection => connection.domain === domain),
    getConnection: (domain, type) => googleConnections.get(`${domain}:${type}`),
    upsertConnection: connection => {
      googleConnections.set(`${connection.domain}:${connection.connectionType}`, connection)
      return connection
    },
    updateConnection: (domain, type, patch) => {
      const existing = googleConnections.get(`${domain}:${type}`)
      if (!existing) return undefined
      const updated = { ...existing, ...patch }
      googleConnections.set(`${domain}:${type}`, updated)
      return updated
    },
    deleteConnection: (domain, type) => googleConnections.delete(`${domain}:${type}`),
  }
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    ga4CredentialStore,
    googleConnectionStore,
    getGoogleAuthConfig: () => ({ clientId: 'test-client-id', clientSecret: 'test-client-secret' }),
  })
  return { app, db, credentials, googleConnections, tmpDir }
}

/** A live (unexpired) OAuth `ga4` connection for example.com on `propertyId`. */
function oauthConnection(propertyId: string | null): GoogleConnectionRecord {
  const now = new Date().toISOString()
  return {
    domain: 'example.com',
    connectionType: 'ga4',
    propertyId,
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  }
}

type Context = ReturnType<typeof buildApp> & { projectId: string }

async function seedProject(ctx: ReturnType<typeof buildApp>, name = PROJECT, connect = true): Promise<string> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${name}`,
    payload: { displayName: 'Search Landing', canonicalDomain: 'example.com', country: 'US', language: 'en' },
  })
  expect(response.statusCode).toBe(201)
  if (connect) {
    const now = new Date().toISOString()
    ctx.credentials.set(name, {
      projectName: name,
      propertyId: '123456',
      clientEmail: 'ga@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })
  }
  return (JSON.parse(response.body) as { id: string }).id
}

/**
 * Three windows whose rows deliberately do NOT add up to their Total, as in
 * GA4's report (only the top pages are listed, the Total covers every page): a
 * read that summed rows would disagree with every expectation here. All values
 * are synthetic.
 */
function readyReport(variant: 'first' | 'second' = 'first'): GA4SearchLandingReport {
  const window = (key: '7d' | '28d' | '90d', periodStart: string): GA4SearchLandingWindowReport => ({
    window: key,
    periodStart,
    periodEnd: '2026-10-07',
    timeZone: 'America/Los_Angeles',
    total: { clicks: 837, impressions: 41422, ctr: 0.020206653469170971, averagePosition: 7.31567765921491, activeUsers: 1093 },
    rows: variant === 'first'
      ? [
          { landingPage: '/contact', clicks: 21, impressions: 1190, ctr: 0.017647058823529412, averagePosition: 6.469747899159664, activeUsers: 18 },
          { landingPage: '/', clicks: 612, impressions: 13940, ctr: 0.043902439024390241, averagePosition: 7.2103299856527974, activeUsers: 734 },
          // Ties on clicks: impressions break them, then the landing page.
          { landingPage: '/guides/page-1', clicks: 31, impressions: 4875, ctr: 0.0063589743589743588, averagePosition: 8.3099487179487177, activeUsers: 40 },
          { landingPage: '/about', clicks: 31, impressions: 2430, ctr: 0.012757201646090535, averagePosition: 4.9201646090534981, activeUsers: 28 },
          { landingPage: '/b-tied', clicks: 2, impressions: 26, ctr: 0.076923076923076927, averagePosition: 6.1923076923076925, activeUsers: 2 },
          { landingPage: '/a-tied', clicks: 2, impressions: 26, ctr: 0.076923076923076927, averagePosition: 6.1923076923076925, activeUsers: 0 },
          { landingPage: '/members?ref=newsletter', clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 4 },
        ]
      : [
          { landingPage: '/pricing', clicks: 57, impressions: 3120, ctr: 0.01826923076923077, averagePosition: 5.1301282051282051, activeUsers: 71 },
        ],
    reportRowCount: variant === 'first' ? 87 : 1,
    rowsCapped: variant === 'first' && key === '90d',
    subjectToThresholding: key === '7d',
    dataLossFromOtherRow: false,
  })
  return {
    status: 'ready',
    windows: [window('7d', '2026-10-01'), window('28d', '2026-09-10'), window('90d', '2026-07-10')],
  }
}

async function mockGa(searchLanding: () => Promise<GA4SearchLandingReport>) {
  const ga = await import('@ainyc/canonry-integration-google-analytics')
  vi.spyOn(ga, 'getAccessToken').mockResolvedValue('fake-token')
  vi.spyOn(ga, 'fetchAggregateSummary').mockResolvedValue({
    periodStart: dateDaysAgo(29), periodEnd: dateDaysAgo(0), totalSessions: 10, totalOrganicSessions: 4, totalUsers: 8,
  })
  vi.spyOn(ga, 'fetchWindowSummary').mockImplementation(async (_token, _property, windowKey) => ({
    windowKey, periodStart: dateDaysAgo(29), periodEnd: dateDaysAgo(0), totalSessions: 10, totalOrganicSessions: 4, totalDirectSessions: 2, totalUsers: 8,
  }))
  vi.spyOn(ga, 'fetchDailyTotals').mockResolvedValue([])
  vi.spyOn(ga, 'fetchTrafficByLandingPage').mockResolvedValue([])
  const ai = vi.spyOn(ga, 'fetchAiReferrals').mockResolvedValue([])
  const social = vi.spyOn(ga, 'fetchSocialReferrals').mockResolvedValue([])
  vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
    startDate: dateDaysAgo(90),
    endDate: dateDaysAgo(0),
    rows: [{ date: dateDaysAgo(1), channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: 'example.com', landingPage: '/', sessions: 3 }],
  })
  vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({ startDate: dateDaysAgo(90), endDate: dateDaysAgo(0), attributionScope: 'landing-page', rows: [] })
  const searchLandingSpy = vi.spyOn(ga, 'fetchSearchLandingPages').mockImplementation(searchLanding)
  return { searchLandingSpy, ai, social }
}

async function sync(ctx: Context, payload: Record<string, unknown> = { days: 30 }) {
  const response = await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT}/ga/sync`, payload })
  return response
}

async function read(ctx: Context, query = '', project = PROJECT) {
  const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/${project}/ga/search-landing-pages${query}` })
  return response
}

function stateOf(ctx: Context) {
  return ctx.db.select().from(gaMeasurementSyncStates).where(eq(gaMeasurementSyncStates.projectId, ctx.projectId)).get()
}

describe('GA4 Search Console landing pages', () => {
  let ctx: Context

  beforeEach(async () => {
    const base = buildApp()
    await base.app.ready()
    ctx = { ...base, projectId: await seedProject(base) }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('stores every window from a sync and reads GA4\'s Total, never the row sum', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())

    const response = await sync(ctx)

    expect(response.statusCode).toBe(200)
    expect(searchLandingSpy).toHaveBeenCalledWith('fake-token', '123456')
    const syncBody = ga4SyncResponseDtoSchema.parse(JSON.parse(response.body))
    expect(syncBody.measurement.searchLandingPages).toEqual({
      status: 'ready',
      windows: [
        { window: '7d', rowCount: 7, reportRowCount: 87, rowsCapped: false },
        { window: '28d', rowCount: 7, reportRowCount: 87, rowsCapped: false },
        { window: '90d', rowCount: 7, reportRowCount: 87, rowsCapped: true },
      ],
      rowCount: 21,
    })
    expect(syncBody.syncedComponents).toBeUndefined()
    const storedWindows = ctx.db.select().from(gaSearchLandingWindows).all()
    expect(storedWindows).toHaveLength(3)
    // Each window names the GA4 property it was read from.
    expect(storedWindows.map(window => window.propertyId)).toEqual(['123456', '123456', '123456'])
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toHaveLength(21)
    const state = stateOf(ctx)
    expect(state).toMatchObject({ searchLandingStatus: 'ready', searchLandingError: null })
    expect(state?.searchLandingSyncedAt).toBe(state?.searchLandingAttemptedAt)

    // Default window is 28d, GA4's own default "Last 28 days".
    const readResponse = await read(ctx)
    expect(readResponse.statusCode).toBe(200)
    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse(readResponse.body))
    expect(body).toMatchObject({
      source: 'ga4-search-console-link',
      status: 'ready',
      error: null,
      window: '28d',
      windowStart: '2026-09-10',
      windowEnd: '2026-10-07',
      windowDays: 28,
      timeZone: 'America/Los_Angeles',
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
      reportRowCount: 87,
      rowsCapped: false,
      totalRows: 7,
      limit: 50,
      offset: 0,
    })
    expect(body.syncedAt).toBe(state?.searchLandingSyncedAt)
    // GA4's Total, with CTR at fraction wire precision (8 decimals).
    expect(body.total).toEqual({
      organicGoogleSearchClicks: 837,
      organicGoogleSearchImpressions: 41422,
      organicGoogleSearchClickThroughRate: 0.02020665,
      organicGoogleSearchAveragePosition: 7.31567765921491,
      activeUsers: 1093,
    })
    // The stored rows sum to 699 clicks and 826 active users: not the Total.
    expect(body.rows.reduce((sum, row) => sum + row.organicGoogleSearchClicks, 0)).toBe(699)
    expect(body.rows.reduce((sum, row) => sum + row.activeUsers, 0)).toBe(826)

    // Clicks, then impressions (both descending), then landing page.
    expect(body.rows.map(row => row.landingPage)).toEqual(['/', '/guides/page-1', '/about', '/contact', '/a-tied', '/b-tied', '/members?ref=newsletter'])
    expect(body.rows[0]).toEqual({
      landingPage: '/',
      organicGoogleSearchClicks: 612,
      organicGoogleSearchImpressions: 13940,
      organicGoogleSearchClickThroughRate: 0.04390244,
      organicGoogleSearchAveragePosition: 7.2103299856527974,
      activeUsers: 734,
    })
    // No impressions: undefined ratios stay null on the wire, never 0.
    expect(body.rows.at(-1)).toEqual({
      landingPage: '/members?ref=newsletter',
      organicGoogleSearchClicks: 0,
      organicGoogleSearchImpressions: 0,
      organicGoogleSearchClickThroughRate: null,
      organicGoogleSearchAveragePosition: null,
      activeUsers: 4,
    })

    const sevenDay = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, '?window=7d')).body))
    expect(sevenDay).toMatchObject({ window: '7d', windowStart: '2026-10-01', windowDays: 7, subjectToThresholding: true })
    const ninetyDay = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, '?window=90d')).body))
    expect(ninetyDay).toMatchObject({ window: '90d', windowStart: '2026-07-10', windowDays: 90, rowsCapped: true, reportRowCount: 87, totalRows: 7 })
  })

  it('pages rows with limit and offset while totalRows counts the whole window', async () => {
    await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)

    const first = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, '?window=28d&limit=2')).body))
    expect(first).toMatchObject({ totalRows: 7, limit: 2, offset: 0 })
    expect(first.rows.map(row => row.landingPage)).toEqual(['/', '/guides/page-1'])

    const later = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, '?limit=2&offset=4')).body))
    expect(later).toMatchObject({ totalRows: 7, limit: 2, offset: 4 })
    expect(later.rows.map(row => row.landingPage)).toEqual(['/a-tied', '/b-tied'])
    // The Total never depends on the page.
    expect(later.total?.organicGoogleSearchClicks).toBe(837)

    const past = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, '?offset=50')).body))
    expect(past).toMatchObject({ totalRows: 7, rows: [] })
  })

  it('replaces the whole snapshot on the next sync', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)
    searchLandingSpy.mockImplementation(async () => readyReport('second'))

    expect((await sync(ctx)).statusCode).toBe(200)

    expect(ctx.db.select().from(gaSearchLandingPages).all().map(row => row.landingPage)).toEqual(['/pricing', '/pricing', '/pricing'])
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toHaveLength(3)
    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(body).toMatchObject({ totalRows: 1, reportRowCount: 1, rowsCapped: false })
  })

  it('records an error, keeps the last good snapshot and still completes the sync and the other components', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)
    const before = stateOf(ctx)
    searchLandingSpy.mockRejectedValue(new GA4ApiError('GA4 API error (500): backend error', 500))

    const response = await sync(ctx)

    expect(response.statusCode).toBe(200)
    const syncBody = ga4SyncResponseDtoSchema.parse(JSON.parse(response.body))
    expect(syncBody.measurement.searchLandingPages).toEqual({
      status: 'error',
      windows: [],
      rowCount: 0,
      error: 'GA4 API error (500): backend error',
    })
    expect(syncBody.measurement.acquisition).toMatchObject({ status: 'ready', rowCount: 1 })
    expect(ctx.db.select().from(gaAcquisitionDaily).where(eq(gaAcquisitionDaily.projectId, ctx.projectId)).all()).toHaveLength(1)
    const syncRuns = ctx.db.select().from(runs).where(eq(runs.projectId, ctx.projectId)).all()
    expect(syncRuns.map(run => run.status)).toEqual([RunStatuses.completed, RunStatuses.completed])

    const state = stateOf(ctx)
    expect(state).toMatchObject({ searchLandingStatus: 'error', searchLandingError: 'GA4 API error (500): backend error' })
    // The snapshot's own time is unchanged; only the attempt moved.
    expect(state?.searchLandingSyncedAt).toBe(before?.searchLandingSyncedAt)
    expect(state?.searchLandingAttemptedAt).not.toBe(before?.searchLandingAttemptedAt)

    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(body).toMatchObject({
      status: 'error',
      error: 'GA4 API error (500): backend error',
      syncedAt: before?.searchLandingSyncedAt,
      attemptedAt: state?.searchLandingAttemptedAt,
      windowStart: '2026-09-10',
      totalRows: 7,
    })
    expect(body.total?.organicGoogleSearchClicks).toBe(837)
  })

  it('records unavailable with Google\'s message and keeps the previous snapshot', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)
    const reason = 'GA4 API error (400): Field organicGoogleSearchClicks is not available for this property.'
    searchLandingSpy.mockResolvedValue({ status: 'unavailable', reason })

    const response = await sync(ctx)

    expect(response.statusCode).toBe(200)
    expect(ga4SyncResponseDtoSchema.parse(JSON.parse(response.body)).measurement.searchLandingPages)
      .toEqual({ status: 'unavailable', windows: [], rowCount: 0, error: reason })
    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(body).toMatchObject({ status: 'unavailable', error: reason, totalRows: 7 })
    expect(body.total?.organicGoogleSearchClicks).toBe(837)
  })

  it('drops the snapshot of a previous property instead of keeping it as the last good one', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)
    // The project is pointed at another GA4 property, one with no Search Console link.
    const connection = ctx.credentials.get(PROJECT)!
    ctx.credentials.set(PROJECT, { ...connection, propertyId: '654321' })
    const reason = 'GA4 returned no Search Console rows (NO_LINK)'
    searchLandingSpy.mockResolvedValue({ status: 'unavailable', reason })

    expect((await sync(ctx)).statusCode).toBe(200)

    expect(searchLandingSpy).toHaveBeenLastCalledWith('fake-token', '654321')
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toEqual([])
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toEqual([])
    expect(stateOf(ctx)).toMatchObject({ searchLandingStatus: 'unavailable', searchLandingError: reason, searchLandingSyncedAt: null })
    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(body).toMatchObject({ status: 'unavailable', error: reason, syncedAt: null, total: null, totalRows: 0, rows: [] })
  })

  it('reads another property\'s snapshot as never-synced, without writing, until the project points back at it', async () => {
    await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)
    const before = stateOf(ctx)
    // Pointed at another property outside the connect route (config edit),
    // and not synced since.
    const connection = ctx.credentials.get(PROJECT)!
    ctx.credentials.set(PROJECT, { ...connection, propertyId: '654321' })

    for (const window of ['7d', '28d', '90d']) {
      const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx, `?window=${window}`)).body))
      expect(body).toEqual({
        source: 'ga4-search-console-link',
        status: 'never-synced',
        error: null,
        syncedAt: null,
        attemptedAt: null,
        window,
        windowStart: null,
        windowEnd: null,
        windowDays: null,
        timeZone: null,
        subjectToThresholding: false,
        dataLossFromOtherRow: false,
        total: null,
        reportRowCount: null,
        rowsCapped: false,
        totalRows: 0,
        limit: 50,
        offset: 0,
        rows: [],
      })
    }

    // The GET wrote nothing: the snapshot and its state are untouched.
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toHaveLength(3)
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toHaveLength(21)
    expect(stateOf(ctx)).toEqual(before)

    // Pointed back at the property it was read from, it is current again.
    ctx.credentials.set(PROJECT, connection)
    const current = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(current).toMatchObject({ status: 'ready', totalRows: 7, reportRowCount: 87 })
    expect(current.total?.organicGoogleSearchClicks).toBe(837)
  })

  it('resolves the current property like the sync: service account first, then OAuth', async () => {
    await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)

    // The service account names the snapshot's property, so a different OAuth
    // property does not make the snapshot stale.
    ctx.googleConnections.set('example.com:ga4', oauthConnection('777777'))
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'ready', totalRows: 7 })

    // Without the service account the OAuth connection decides.
    ctx.credentials.delete(PROJECT)
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'never-synced', total: null, totalRows: 0, rows: [] })
    ctx.googleConnections.set('example.com:ga4', oauthConnection('123456'))
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'ready', totalRows: 7 })

    // With no connection at all, no property is current.
    ctx.googleConnections.clear()
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'never-synced', total: null, totalRows: 0, rows: [] })
  })

  it('clears the snapshot when a service-account connect points the project at another property, and keeps it for the same one', async () => {
    await mockGa(async () => readyReport())
    const ga = await import('@ainyc/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnection').mockResolvedValue(true)
    expect((await sync(ctx)).statusCode).toBe(200)
    const connect = (propertyId: string) => ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT}/ga/connect`,
      payload: { propertyId, keyJson: JSON.stringify({ client_email: 'ga@test.iam.gserviceaccount.com', private_key: 'fake-key' }) },
    })

    // A reconnect to the same property (a rotated key) keeps the snapshot.
    expect((await connect('123456')).statusCode).toBe(200)
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toHaveLength(3)
    expect(stateOf(ctx)).toMatchObject({ searchLandingStatus: 'ready' })

    expect((await connect('654321')).statusCode).toBe(200)

    expect(verify).toHaveBeenLastCalledWith('ga@test.iam.gserviceaccount.com', 'fake-key', '654321')
    expect(ctx.credentials.get(PROJECT)?.propertyId).toBe('654321')
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toEqual([])
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toEqual([])
    expect(stateOf(ctx)).toMatchObject({
      searchLandingStatus: 'never-synced',
      searchLandingError: null,
      searchLandingSyncedAt: null,
      searchLandingAttemptedAt: null,
    })
  })

  it('clears the snapshot when an OAuth connect changes the property the project resolves to', async () => {
    await mockGa(async () => readyReport())
    const ga = await import('@ainyc/canonry-integration-google-analytics')
    const verify = vi.spyOn(ga, 'verifyConnectionWithToken').mockResolvedValue(true)
    // OAuth only: no service account for this project.
    ctx.credentials.delete(PROJECT)
    ctx.googleConnections.set('example.com:ga4', oauthConnection('123456'))
    expect((await sync(ctx)).statusCode).toBe(200)
    expect(ctx.db.select().from(gaSearchLandingWindows).all().map(window => window.propertyId)).toEqual(['123456', '123456', '123456'])
    const connect = (propertyId: string) => ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT}/ga/connect`,
      payload: { propertyId },
    })

    expect((await connect('123456')).statusCode).toBe(200)
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toHaveLength(3)

    expect((await connect('654321')).statusCode).toBe(200)

    expect(verify).toHaveBeenLastCalledWith('fake-access-token', '654321')
    expect(ctx.googleConnections.get('example.com:ga4')?.propertyId).toBe('654321')
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toEqual([])
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toEqual([])
    expect(stateOf(ctx)).toMatchObject({ searchLandingStatus: 'never-synced', searchLandingSyncedAt: null })
  })

  it('keeps the snapshot when an OAuth connect changes a property the service account overrides', async () => {
    await mockGa(async () => readyReport())
    const ga = await import('@ainyc/canonry-integration-google-analytics')
    vi.spyOn(ga, 'verifyConnectionWithToken').mockResolvedValue(true)
    ctx.googleConnections.set('example.com:ga4', oauthConnection('777777'))
    expect((await sync(ctx)).statusCode).toBe(200)

    const response = await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT}/ga/connect`, payload: { propertyId: '888888' } })

    expect(response.statusCode).toBe(200)
    // The project still resolves to the service account's property.
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toHaveLength(3)
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'ready', totalRows: 7 })
  })

  it('starts unavailable without a snapshot when the first attempt is refused', async () => {
    await mockGa(async () => ({ status: 'unavailable', reason: 'GA4 returned no Search Console rows (NO_LINK)' }))

    expect((await sync(ctx)).statusCode).toBe(200)

    const body = gaSearchLandingPagesResponseSchema.parse(JSON.parse((await read(ctx)).body))
    expect(body).toMatchObject({
      status: 'unavailable',
      error: 'GA4 returned no Search Console rows (NO_LINK)',
      syncedAt: null,
      total: null,
      rows: [],
      totalRows: 0,
      windowStart: null,
      windowDays: null,
    })
    expect(body.attemptedAt).not.toBeNull()
  })

  it('refreshes only the snapshot slice with only=search-landing and skips it for other slices', async () => {
    const { searchLandingSpy, ai, social } = await mockGa(async () => readyReport())

    const scoped = await sync(ctx, { days: 30, only: 'search-landing' })
    expect(scoped.statusCode).toBe(200)
    const scopedBody = ga4SyncResponseDtoSchema.parse(JSON.parse(scoped.body))
    expect(scopedBody.syncedComponents).toEqual(['traffic', 'summary', 'search-landing'])
    expect(scopedBody.measurement.searchLandingPages?.status).toBe('ready')
    expect(searchLandingSpy).toHaveBeenCalledTimes(1)
    expect(ai).not.toHaveBeenCalled()
    expect(social).not.toHaveBeenCalled()

    const attempted = stateOf(ctx)?.searchLandingAttemptedAt
    const other = await sync(ctx, { days: 30, only: 'social' })
    expect(other.statusCode).toBe(200)
    const otherBody = ga4SyncResponseDtoSchema.parse(JSON.parse(other.body))
    expect(otherBody.syncedComponents).toEqual(['traffic', 'summary', 'social'])
    expect(otherBody.measurement.searchLandingPages).toBeUndefined()
    expect(searchLandingSpy).toHaveBeenCalledTimes(1)
    expect(stateOf(ctx)?.searchLandingAttemptedAt).toBe(attempted)

    const invalid = await sync(ctx, { only: 'landing' })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.body).toContain('traffic, ai, social, search-landing')
  })

  it('leaves search-landing out of syncedComponents when only=search-landing did not store a snapshot', async () => {
    const { searchLandingSpy } = await mockGa(async () => readyReport())
    searchLandingSpy.mockRejectedValue(new GA4ApiError('GA4 API error (500): backend error', 500))

    const failed = await sync(ctx, { days: 30, only: 'search-landing' })

    expect(failed.statusCode).toBe(200)
    const failedBody = ga4SyncResponseDtoSchema.parse(JSON.parse(failed.body))
    expect(failedBody.syncedComponents).toEqual(['traffic', 'summary'])
    expect(failedBody.measurement.searchLandingPages).toMatchObject({ status: 'error', error: 'GA4 API error (500): backend error' })

    searchLandingSpy.mockResolvedValue({ status: 'unavailable', reason: 'GA4 returned no Search Console rows (NO_LINK)' })
    const refused = ga4SyncResponseDtoSchema.parse(JSON.parse((await sync(ctx, { days: 30, only: 'search-landing' })).body))
    expect(refused.syncedComponents).toEqual(['traffic', 'summary'])
    expect(refused.measurement.searchLandingPages?.status).toBe('unavailable')
  })

  it('reads never-synced with no Total and no rows, without a GA connection', async () => {
    await seedProject(ctx, 'unconnected', false)

    const response = await read(ctx, '', 'unconnected')

    expect(response.statusCode).toBe(200)
    expect(gaSearchLandingPagesResponseSchema.parse(JSON.parse(response.body))).toEqual({
      source: 'ga4-search-console-link',
      status: 'never-synced',
      error: null,
      syncedAt: null,
      attemptedAt: null,
      window: '28d',
      windowStart: null,
      windowEnd: null,
      windowDays: null,
      timeZone: null,
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
      total: null,
      reportRowCount: null,
      rowsCapped: false,
      totalRows: 0,
      limit: 50,
      offset: 0,
      rows: [],
    })
  })

  it.each([
    ['?window=30d', '"window" must be one of: 7d, 28d, 90d'],
    ['?limit=0', '"limit" must be an integer between 1 and 1000'],
    ['?limit=1001', '"limit" must be an integer between 1 and 1000'],
    ['?limit=2.5', '"limit" must be an integer between 1 and 1000'],
    ['?offset=-1', '"offset" must be a non-negative integer'],
  ])('rejects %s', async (query, message) => {
    const response = await read(ctx, query)
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR', message } })
  })

  it('404s an unknown project', async () => {
    expect((await read(ctx, '', 'missing')).statusCode).toBe(404)
  })

  it('clears the snapshot and resets its state on disconnect', async () => {
    await mockGa(async () => readyReport())
    expect((await sync(ctx)).statusCode).toBe(200)

    const response = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT}/ga/disconnect` })

    expect(response.statusCode).toBe(204)
    expect(ctx.db.select().from(gaSearchLandingWindows).all()).toEqual([])
    expect(ctx.db.select().from(gaSearchLandingPages).all()).toEqual([])
    expect(stateOf(ctx)).toMatchObject({
      searchLandingStatus: 'never-synced',
      searchLandingError: null,
      searchLandingSyncedAt: null,
      searchLandingAttemptedAt: null,
    })
    expect(JSON.parse((await read(ctx)).body)).toMatchObject({ status: 'never-synced', total: null, totalRows: 0 })
  })

  it('publishes the read with its typed response schema in the OpenAPI document', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(response.statusCode).toBe(200)
    const spec = JSON.parse(response.body) as {
      paths: Record<string, { get?: { parameters?: Array<{ name: string; schema?: Record<string, unknown> }>; responses: Record<string, unknown> } }>
    }
    const operation = spec.paths['/api/v1/projects/{name}/ga/search-landing-pages']?.get
    expect(operation?.parameters?.map(parameter => parameter.name)).toEqual(['name', 'window', 'limit', 'offset'])
    expect(operation?.parameters?.find(parameter => parameter.name === 'window')?.schema).toMatchObject({ enum: ['7d', '28d', '90d'], default: '28d' })
    expect(operation?.responses['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/GaSearchLandingPagesResponse' } } },
    })
    // The sync body's `only` carries the contract enum, so the generated SDK types it.
    const syncSpec = (spec.paths['/api/v1/projects/{name}/ga/sync'] as unknown as {
      post: { requestBody: { content: { 'application/json': { schema: { properties: { only: Record<string, unknown> } } } } } }
    }).post
    expect(syncSpec.requestBody.content['application/json'].schema.properties.only)
      .toMatchObject({ type: 'string', enum: ['traffic', 'ai', 'social', 'search-landing'] })
  })
})
