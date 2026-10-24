import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  ga4StatusDtoSchema,
  gaAcquisitionResponseSchema,
  gaMeasurementAnalysisDtoSchema,
  gaOverviewResponseSchema,
  gaSearchLandingPagesResponseSchema,
  gaTrafficResponseSchema,
} from '@canonry/canonry-contracts'
import type { GaOverviewWindow } from '@canonry/canonry-contracts'
import { auditLog, createClient, migrate } from '@canonry/canonry-db'
import type { GA4WindowMetrics, GA4WindowMetricsPeriod } from '@canonry/canonry-integration-google-analytics'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'
import { dailyTotals } from './ga-sync-fixtures.js'

// GA4 rows carry no property, so a project's GA data is only ever one
// property's: every write that moves a project to another property, or to
// none, clears it. These tests sync one property into every GA table, make
// each such write, and read everything back.

const PROJECT = 'switching'
const BYSTANDER = 'bystander'
const DOMAIN = 'example.com'
const OLD_PROPERTY = '111111'
const NEW_PROPERTY = '222222'
const CLIENT_EMAIL = 'ga@test.iam.gserviceaccount.com'

function daysAgo(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-property-data-'))
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
  // One OAuth connection per domain and type, keyed like the real store.
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
    // The Google routes register only with a state secret.
    googleStateSecret: 'test-state-secret',
  })
  return { app, db, credentials, googleConnections, tmpDir }
}

type Context = ReturnType<typeof buildApp> & { projectId: string; bystanderId: string }

async function createProject(app: ReturnType<typeof buildApp>['app'], name: string, canonicalDomain = DOMAIN): Promise<string> {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${name}`,
    // A lead event, so the sync fills the lead table too.
    payload: {
      displayName: name,
      canonicalDomain,
      country: 'US',
      language: 'en',
      measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
    },
  })
  expect(response.statusCode, response.body).toBe(201)
  return (JSON.parse(response.body) as { id: string }).id
}

function connectServiceAccount(ctx: Context, project: string, propertyId: string): void {
  const now = new Date().toISOString()
  ctx.credentials.set(project, { projectName: project, propertyId, clientEmail: CLIENT_EMAIL, privateKey: 'fake-key', createdAt: now, updatedAt: now })
}

/** The domain's OAuth `ga4` connection, live (unexpired) and on `propertyId`. */
function connectOAuth(ctx: Context, propertyId: string): void {
  const now = new Date().toISOString()
  ctx.googleConnections.set(`${DOMAIN}:ga4`, {
    domain: DOMAIN,
    connectionType: 'ga4',
    propertyId,
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  })
}

/** GA4's totals for a window and the period before it, both ending inside the synced days. */
function windowMetrics(windowKey: GaOverviewWindow): GA4WindowMetrics {
  const days = windowKey === '7d' ? 7 : windowKey === '30d' ? 30 : 90
  const period = (start: number, end: number): GA4WindowMetricsPeriod => ({
    startDate: daysAgo(start),
    endDate: daysAgo(end),
    activeUsers: 9,
    newUsers: 4,
    totalUsers: 9,
    sessions: 12,
    organicSessions: 5,
    views: 20,
    eventCount: 40,
    keyEvents: 1,
    engagementRate: 0.6,
    bounceRate: 0.4,
    engagementSeconds: 300,
  })
  return { windowKey, current: period(days, 1), previous: period(2 * days, days + 1) }
}

/** Every GA4 request a sync makes, each answered with a row, so a sync fills every GA table. */
async function mockGa4() {
  const ga = await import('@canonry/canonry-integration-google-analytics')
  vi.spyOn(ga, 'getAccessToken').mockResolvedValue('fake-token')
  vi.spyOn(ga, 'fetchAggregateSummary').mockResolvedValue({
    periodStart: daysAgo(30), periodEnd: daysAgo(1), totalSessions: 12, totalOrganicSessions: 5, totalUsers: 9,
  })
  vi.spyOn(ga, 'fetchWindowSummary').mockImplementation(async (_token, _property, windowKey) => ({
    windowKey, periodStart: daysAgo(30), periodEnd: daysAgo(1), totalSessions: 12, totalOrganicSessions: 5, totalDirectSessions: 3, totalUsers: 9,
  }))
  vi.spyOn(ga, 'fetchDailyTotals').mockResolvedValue(dailyTotals([
    { date: daysAgo(1), sessions: 12, users: 9, engagementRate: 0.6, newUsers: 4 },
  ]))
  vi.spyOn(ga, 'fetchWindowMetrics').mockImplementation(async (_token, _property, windowKey) => windowMetrics(windowKey))
  vi.spyOn(ga, 'fetchTrafficByLandingPage').mockResolvedValue([
    { date: daysAgo(1), landingPage: '/', sessions: 12, organicSessions: 5, directSessions: 3, users: 9 },
  ])
  vi.spyOn(ga, 'fetchAiReferrals').mockResolvedValue([
    { date: daysAgo(1), source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', channelGroup: 'Referral', landingPage: '/', sessions: 2, users: 2, sourceDimension: 'session' },
  ])
  vi.spyOn(ga, 'fetchSocialReferrals').mockResolvedValue([
    { date: daysAgo(1), source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 1, users: 1 },
  ])
  vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
    startDate: daysAgo(90),
    endDate: daysAgo(1),
    rows: [{ date: daysAgo(1), channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: DOMAIN, landingPage: '/', sessions: 5 }],
  })
  vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({
    startDate: daysAgo(90),
    endDate: daysAgo(1),
    attributionScope: 'landing-page',
    rows: [{ date: daysAgo(1), eventName: 'generate_lead', channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: DOMAIN, landingPage: '/', eventCount: 1 }],
  })
  vi.spyOn(ga, 'fetchSearchLandingPages').mockResolvedValue({
    status: 'ready',
    windows: [{
      window: '28d',
      periodStart: daysAgo(28),
      periodEnd: daysAgo(1),
      timeZone: 'America/New_York',
      total: { clicks: 9, impressions: 300, ctr: 0.03, averagePosition: 4.2, activeUsers: 7 },
      rows: [{ landingPage: '/', clicks: 9, impressions: 300, ctr: 0.03, averagePosition: 4.2, activeUsers: 7 }],
      reportRowCount: 1,
      rowsCapped: false,
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
    }],
  })
  vi.spyOn(ga, 'verifyConnection').mockResolvedValue(true)
  vi.spyOn(ga, 'verifyConnectionWithToken').mockResolvedValue(true)
}

async function sync(ctx: Context, project: string): Promise<void> {
  const response = await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${project}/ga/sync`, payload: { days: 30 } })
  expect(response.statusCode).toBe(200)
}

/**
 * The rows each `ga_*` table holds for the project. The tables come from the
 * schema itself, so a GA table added later is checked too. `ga_connections`
 * is left out: a legacy connection record that no sync writes.
 */
function gaRowCounts(ctx: Context, projectId: string): Record<string, number> {
  const tables = ctx.db.$client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ga_*' AND name <> 'ga_connections' ORDER BY name`)
    .all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => {
    const row = ctx.db.$client.prepare(`SELECT count(*) AS count FROM "${name}" WHERE project_id = ?`).get(projectId) as { count: number }
    return [name, row.count]
  }))
}

/** Row counts after a sync, which filled every GA table, so a later 0 proves a clear. */
function syncedRowCounts(ctx: Context, projectId: string): Record<string, number> {
  const counts = gaRowCounts(ctx, projectId)
  expect(Object.keys(counts)).toEqual(expect.arrayContaining([
    'ga_acquisition_daily', 'ga_daily_totals', 'ga_lead_events_daily', 'ga_measurement_sync_state', 'ga_traffic_window_summaries', 'ga_window_metrics',
  ]))
  expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual([])
  return counts
}

function emptied(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(counts).map(table => [table, 0]))
}

/**
 * What the project's GA reads report: the stored-data reads always, and the
 * reads that need a connection while it has one.
 */
async function gaReads(ctx: Context, project: string) {
  const get = async (url: string): Promise<unknown> => {
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/${project}/ga/${url}` })
    expect(response.statusCode, url).toBe(200)
    return JSON.parse(response.body)
  }
  const status = ga4StatusDtoSchema.parse(await get('status'))
  const acquisition = gaAcquisitionResponseSchema.parse(await get('acquisition'))
  const analysis = gaMeasurementAnalysisDtoSchema.parse(await get('measurement-analysis'))
  const landing = gaSearchLandingPagesResponseSchema.parse(await get('search-landing-pages'))
  const stored = {
    // The property the project resolves to; null without a GA connection.
    propertyId: status.propertyId,
    lastSyncedAt: status.lastSyncedAt,
    acquisition: { status: acquisition.status, sessions: acquisition.totalSessions },
    leads: analysis.leads.status,
    engagement: analysis.engagement.status,
    searchLanding: { status: landing.status, clicks: landing.total?.organicGoogleSearchClicks ?? null },
  }
  if (!status.connected) return stored
  const traffic = gaTrafficResponseSchema.parse(await get('traffic'))
  const overview = gaOverviewResponseSchema.parse(await get('overview?window=30d'))
  return {
    ...stored,
    trafficSessions: traffic.totalSessions,
    overview: {
      syncedAt: overview.syncedAt,
      sessions: overview.totals.sessions,
      daysWithSessions: overview.days.filter(day => (day.values.sessions ?? 0) > 0).length,
    },
  }
}

/** The reads of a project on `OLD_PROPERTY` after one sync. */
const SYNCED = {
  propertyId: OLD_PROPERTY,
  lastSyncedAt: expect.any(String),
  acquisition: { status: 'ready', sessions: 5 },
  leads: 'ready',
  engagement: 'ready',
  searchLanding: { status: 'ready', clicks: 9 },
  trafficSessions: 12,
  overview: { syncedAt: expect.any(String), sessions: 12, daysWithSessions: 1 },
}

/** The reads of a project with no GA data, on `propertyId` or with no GA connection. */
function neverSynced(propertyId: string | null) {
  const stored = {
    propertyId,
    lastSyncedAt: null,
    acquisition: { status: 'never-synced', sessions: 0 },
    leads: 'never-synced',
    engagement: 'unavailable',
    searchLanding: { status: 'never-synced', clicks: null },
  }
  if (propertyId === null) return stored
  return { ...stored, trafficSessions: 0, overview: { syncedAt: null, sessions: null, daysWithSessions: 0 } }
}

function dataClearedAudits(ctx: Context, projectId: string) {
  return ctx.db.select({ actor: auditLog.actor, entityId: auditLog.entityId, diff: auditLog.diff })
    .from(auditLog)
    .where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, 'ga4.data-cleared')))
    .all()
    .map(entry => ({ ...entry, diff: JSON.parse(entry.diff ?? 'null') as unknown }))
}

function serviceAccountKey(privateKey = 'fake-key'): string {
  return JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privateKey })
}

async function gaConnect(ctx: Context, project: string, payload: Record<string, unknown>): Promise<number> {
  return (await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${project}/ga/connect`, payload })).statusCode
}

async function googleDisconnectGa4(ctx: Context): Promise<number> {
  return (await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT}/google/connections/ga4` })).statusCode
}

/** Google's OAuth flow as the browser completes it: start it, then return to the callback with its signed state. */
async function googleOAuthCallback(ctx: Context, payload: { type: string; propertyId: string }): Promise<number> {
  const google = await import('@canonry/canonry-integration-google')
  vi.spyOn(google, 'exchangeCode').mockResolvedValue({
    access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600, token_type: 'Bearer',
  })
  const started = await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT}/google/connect`, payload })
  expect(started.statusCode).toBe(200)
  const state = new URL((JSON.parse(started.body) as { authUrl: string }).authUrl).searchParams.get('state') ?? ''
  return (await ctx.app.inject({ method: 'GET', url: `/api/v1/google/callback?code=test-code&state=${encodeURIComponent(state)}` })).statusCode
}

describe('GA4 data belongs to one property', () => {
  let ctx: Context

  beforeEach(async () => {
    const base = buildApp()
    await base.app.ready()
    const projectId = await createProject(base.app, PROJECT)
    // On another domain, with its own service account: no write below concerns it.
    const bystanderId = await createProject(base.app, BYSTANDER, 'example.org')
    ctx = { ...base, projectId, bystanderId }
    connectServiceAccount(ctx, BYSTANDER, OLD_PROPERTY)
    await mockGa4()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('deletes every row the syncs stored on ga disconnect, and every read shows the project as never synced', async () => {
    connectServiceAccount(ctx, PROJECT, OLD_PROPERTY)
    connectOAuth(ctx, OLD_PROPERTY)
    await sync(ctx, PROJECT)
    await sync(ctx, BYSTANDER)
    const before = syncedRowCounts(ctx, ctx.projectId)
    const bystander = syncedRowCounts(ctx, ctx.bystanderId)
    expect(await gaReads(ctx, PROJECT)).toEqual(SYNCED)

    const response = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT}/ga/disconnect` })

    expect(response.statusCode).toBe(204)
    expect(gaRowCounts(ctx, ctx.projectId)).toEqual(emptied(before))
    expect(await gaReads(ctx, PROJECT)).toEqual(neverSynced(null))
    expect(gaRowCounts(ctx, ctx.bystanderId)).toEqual(bystander)
  })

  it.each([
    {
      name: 'a service-account connect to another property',
      connect: (c: Context) => connectServiceAccount(c, PROJECT, OLD_PROPERTY),
      write: (c: Context) => gaConnect(c, PROJECT, { propertyId: NEW_PROPERTY, keyJson: serviceAccountKey() }),
      status: 200,
      propertyId: NEW_PROPERTY,
      actor: 'api',
    },
    {
      name: 'an OAuth property selection (ga connect)',
      connect: (c: Context) => connectOAuth(c, OLD_PROPERTY),
      write: (c: Context) => gaConnect(c, PROJECT, { propertyId: NEW_PROPERTY }),
      status: 200,
      propertyId: NEW_PROPERTY,
      actor: 'api',
    },
    {
      name: 'a property set on the OAuth connection',
      connect: (c: Context) => connectOAuth(c, OLD_PROPERTY),
      write: async (c: Context) => (await c.app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${PROJECT}/google/connections/ga4/property`,
        payload: { propertyId: NEW_PROPERTY },
      })).statusCode,
      status: 200,
      propertyId: NEW_PROPERTY,
      actor: 'api',
    },
    {
      name: 'an OAuth callback that names another property',
      connect: (c: Context) => connectOAuth(c, OLD_PROPERTY),
      write: (c: Context) => googleOAuthCallback(c, { type: 'ga4', propertyId: NEW_PROPERTY }),
      status: 200,
      propertyId: NEW_PROPERTY,
      actor: 'oauth',
    },
    {
      name: 'removing the OAuth connection (google disconnect --type ga4)',
      connect: (c: Context) => connectOAuth(c, OLD_PROPERTY),
      write: googleDisconnectGa4,
      status: 204,
      propertyId: null,
      actor: 'api',
    },
  ])('clears the old property\'s rows after $name, and every read shows the project as never synced', async (move) => {
    move.connect(ctx)
    await sync(ctx, PROJECT)
    await sync(ctx, BYSTANDER)
    const before = syncedRowCounts(ctx, ctx.projectId)
    const bystander = syncedRowCounts(ctx, ctx.bystanderId)
    expect(await gaReads(ctx, PROJECT)).toEqual(SYNCED)

    expect(await move.write(ctx)).toBe(move.status)

    expect(gaRowCounts(ctx, ctx.projectId)).toEqual(emptied(before))
    expect(await gaReads(ctx, PROJECT)).toEqual(neverSynced(move.propertyId))
    expect(dataClearedAudits(ctx, ctx.projectId)).toEqual([{
      actor: move.actor,
      entityId: move.propertyId,
      diff: { previousPropertyId: OLD_PROPERTY, propertyId: move.propertyId },
    }])
    expect(gaRowCounts(ctx, ctx.bystanderId)).toEqual(bystander)
  })

  it.each([
    {
      name: 'a service-account reconnect to the same property with a rotated key',
      connect: (c: Context) => connectServiceAccount(c, PROJECT, OLD_PROPERTY),
      write: (c: Context) => gaConnect(c, PROJECT, { propertyId: OLD_PROPERTY, keyJson: serviceAccountKey('rotated-key') }),
      status: 200,
    },
    {
      name: 'an OAuth property change the project\'s service account overrides',
      connect: (c: Context) => {
        connectServiceAccount(c, PROJECT, OLD_PROPERTY)
        connectOAuth(c, OLD_PROPERTY)
      },
      write: (c: Context) => gaConnect(c, PROJECT, { propertyId: NEW_PROPERTY }),
      status: 200,
    },
    {
      name: 'removing the OAuth connection the project\'s service account overrides',
      connect: (c: Context) => {
        connectServiceAccount(c, PROJECT, OLD_PROPERTY)
        connectOAuth(c, OLD_PROPERTY)
      },
      write: googleDisconnectGa4,
      status: 204,
    },
  ])('keeps the rows after $name', async (stay) => {
    stay.connect(ctx)
    await sync(ctx, PROJECT)
    const before = syncedRowCounts(ctx, ctx.projectId)

    expect(await stay.write(ctx)).toBe(stay.status)

    expect(gaRowCounts(ctx, ctx.projectId)).toEqual(before)
    expect(await gaReads(ctx, PROJECT)).toEqual(SYNCED)
    expect(dataClearedAudits(ctx, ctx.projectId)).toEqual([])
  })

  it.each([
    {
      name: 'an OAuth property selection',
      write: (c: Context) => gaConnect(c, PROJECT, { propertyId: NEW_PROPERTY }),
      status: 200,
      propertyId: NEW_PROPERTY,
    },
    {
      name: 'ga disconnect',
      write: async (c: Context) => (await c.app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT}/ga/disconnect` })).statusCode,
      status: 204,
      propertyId: null,
    },
  ])('clears another project on the same domain that $name moves, and keeps one its service account pins', async (write) => {
    // All three share the domain's OAuth connection with PROJECT. Only `pinned`
    // has its own service account, and `unsynced` never synced.
    const siblingId = await createProject(ctx.app, 'sibling')
    const pinnedId = await createProject(ctx.app, 'pinned')
    const unsyncedId = await createProject(ctx.app, 'unsynced')
    connectOAuth(ctx, OLD_PROPERTY)
    connectServiceAccount(ctx, 'pinned', OLD_PROPERTY)
    for (const project of [PROJECT, 'sibling', 'pinned']) await sync(ctx, project)
    const sibling = syncedRowCounts(ctx, siblingId)
    const pinned = syncedRowCounts(ctx, pinnedId)

    expect(await write.write(ctx)).toBe(write.status)

    expect(gaRowCounts(ctx, siblingId)).toEqual(emptied(sibling))
    expect(dataClearedAudits(ctx, siblingId)).toEqual([{
      actor: 'api',
      entityId: write.propertyId,
      diff: { previousPropertyId: OLD_PROPERTY, propertyId: write.propertyId },
    }])
    expect(gaRowCounts(ctx, pinnedId)).toEqual(pinned)
    expect(dataClearedAudits(ctx, pinnedId)).toEqual([])
    // Its property moved too, but it had no rows to lose.
    expect(dataClearedAudits(ctx, unsyncedId)).toEqual([])
  })
})
