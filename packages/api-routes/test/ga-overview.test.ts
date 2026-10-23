import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, gaDailyTotals, gaWindowMetrics, migrate } from '@canonry/canonry-db'
import { gaOverviewResponseSchema, GaOverviewPeriods, type GaOverviewWindow } from '@canonry/canonry-contracts'
import * as gaModule from '@canonry/canonry-integration-google-analytics'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import { buildGaOverview, type GaOverviewDailyRow, type GaOverviewPeriodRow } from '../src/ga-overview.js'
import { dailyTotals } from './ga-sync-fixtures.js'

/**
 * The GA4 overview: GA4's own totals for a window and the period before it,
 * their change, and both periods by day, read from stored rows only.
 */

const CURRENT = { startDate: '2026-10-16', endDate: '2026-10-22' }
const PREVIOUS = { startDate: '2026-10-09', endDate: '2026-10-15' }
const SYNCED_AT = '2026-10-23T04:00:00.000Z'

function period(range: { startDate: string; endDate: string }, values: Partial<GaOverviewPeriodRow> = {}): GaOverviewPeriodRow {
  return {
    ...range,
    activeUsers: 1000,
    newUsers: 400,
    totalUsers: 1030,
    sessions: 1600,
    organicSessions: 900,
    views: 3200,
    eventCount: 12000,
    keyEvents: 40,
    engagementRate: 0.6,
    bounceRate: 0.4,
    engagementSeconds: 90000,
    syncedAt: SYNCED_AT,
    ...values,
  }
}

function day(date: string, values: Partial<GaOverviewDailyRow> = {}): GaOverviewDailyRow {
  return {
    date,
    sessions: 200,
    users: 150,
    activeUsers: 140,
    newUsers: 60,
    organicSessions: 110,
    views: 410,
    eventCount: 1500,
    keyEvents: 5,
    engagementRate: 0.62,
    bounceRate: 0.38,
    engagementSeconds: 12600,
    ...values,
  }
}

describe('buildGaOverview', () => {
  const fallback = { current: CURRENT, previous: PREVIOUS }

  it('takes GA4 totals for each period and the change between them', () => {
    const overview = buildGaOverview({
      window: '7d',
      current: period(CURRENT),
      previous: period(PREVIOUS, { activeUsers: 800, sessions: 1280, engagementRate: 0.5, bounceRate: 0.5, engagementSeconds: 64000, keyEvents: 50 }),
      daily: [],
      fallback,
    })

    expect(overview.totals).toMatchObject({ activeUsers: 1000, sessions: 1600, engagementRate: 0.6, averageEngagementTimeSeconds: 90 })
    expect(overview.previousTotals).toMatchObject({ activeUsers: 800, sessions: 1280, averageEngagementTimeSeconds: 80 })
    // (1000 - 800) / 800 = +25%; (1600 - 1280) / 1280 = +25%
    expect(overview.changePct.activeUsers).toBe(25)
    expect(overview.changePct.sessions).toBe(25)
    // Rates change relatively, as GA4 shows them: 0.5 to 0.6 reads +20%, not +10 points.
    expect(overview.changePct.engagementRate).toBe(20)
    expect(overview.changePct.bounceRate).toBe(-20)
    // 90 s against 80 s
    expect(overview.changePct.averageEngagementTimeSeconds).toBe(12.5)
    // 40 against 50
    expect(overview.changePct.keyEvents).toBe(-20)
    expect(overview.changePct.views).toBe(0)
    expect(overview.syncedAt).toBe(SYNCED_AT)
    expect(gaOverviewResponseSchema.parse(overview)).toEqual(overview)
  })

  it('has no change where either total is missing or the previous one is zero', () => {
    const overview = buildGaOverview({
      window: '7d',
      current: period(CURRENT),
      previous: period(PREVIOUS, { keyEvents: 0, views: null, activeUsers: 0 }),
      daily: [],
      fallback,
    })

    expect(overview.changePct.keyEvents).toBeNull()
    expect(overview.changePct.views).toBeNull()
    expect(overview.changePct.activeUsers).toBeNull()
    // No active users to divide by: the previous average is unknown, so is its change.
    expect(overview.previousTotals.averageEngagementTimeSeconds).toBeNull()
    expect(overview.changePct.averageEngagementTimeSeconds).toBeNull()
  })

  it('lines each day up with the day in the same position of the previous period', () => {
    const overview = buildGaOverview({
      window: '7d',
      current: period(CURRENT),
      previous: period(PREVIOUS),
      daily: [day('2026-10-16', { sessions: 210 }), day('2026-10-09', { sessions: 170 }), day('2026-10-22', { sessions: 230, activeUsers: 150, engagementSeconds: 13500 })],
      fallback,
    })

    expect(overview.days).toHaveLength(7)
    expect(overview.days.map(entry => [entry.date, entry.previousDate])).toEqual([
      ['2026-10-16', '2026-10-09'],
      ['2026-10-17', '2026-10-10'],
      ['2026-10-18', '2026-10-11'],
      ['2026-10-19', '2026-10-12'],
      ['2026-10-20', '2026-10-13'],
      ['2026-10-21', '2026-10-14'],
      ['2026-10-22', '2026-10-15'],
    ])
    expect(overview.days[0]!.values.sessions).toBe(210)
    expect(overview.days[0]!.previousValues.sessions).toBe(170)
    // A day's average is that day's engaged seconds over its own active users.
    expect(overview.days[6]!.values.averageEngagementTimeSeconds).toBe(90)
    // `users` is GA4's totalUsers for the day.
    expect(overview.days[0]!.values.totalUsers).toBe(150)
  })

  it('reads a day GA4 sent no row for, inside a synced period, as no traffic: zero counts, no rates', () => {
    const overview = buildGaOverview({ window: '7d', current: period(CURRENT), previous: period(PREVIOUS), daily: [], fallback })

    expect(overview.days[2]!.values).toEqual({
      activeUsers: 0,
      newUsers: 0,
      totalUsers: 0,
      sessions: 0,
      organicSessions: 0,
      views: 0,
      eventCount: 0,
      keyEvents: 0,
      engagementRate: null,
      bounceRate: null,
      averageEngagementTimeSeconds: null,
    })
  })

  it('without window rows, keeps every total unknown and shows only what older days hold', () => {
    // Synced before the overview existed: daily rows without the new figures.
    const legacy = day('2026-10-20', { activeUsers: null, organicSessions: null, views: null, eventCount: null, keyEvents: null, bounceRate: null, engagementSeconds: null })
    const overview = buildGaOverview({ window: '7d', current: null, previous: null, daily: [legacy], fallback })

    expect(overview.current).toEqual(CURRENT)
    expect(overview.previous).toEqual(PREVIOUS)
    expect(overview.syncedAt).toBeNull()
    expect(Object.values(overview.totals).every(value => value === null)).toBe(true)
    expect(Object.values(overview.changePct).every(value => value === null)).toBe(true)
    // An unsynced day is unknown, not a day without traffic.
    expect(overview.days[0]!.values.sessions).toBeNull()
    expect(overview.days[4]!.values).toMatchObject({ sessions: 200, totalUsers: 150, activeUsers: null, views: null, averageEngagementTimeSeconds: null })
  })
})

// ---------------------------------------------------------------------------
// The route and the sync, end to end over a real database.
// ---------------------------------------------------------------------------

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-overview-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const credentials = new Map<string, Ga4CredentialRecord>()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: projectName => credentials.get(projectName),
    upsertConnection: (connection) => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: projectName => credentials.delete(projectName),
  }
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })
  return { app, db, credentials, tmpDir }
}

type Context = ReturnType<typeof buildApp> & { projectId: string }

async function seedProject(ctx: ReturnType<typeof buildApp>, connected = true): Promise<string> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/projects/overview',
    payload: { displayName: 'Overview', canonicalDomain: 'example.com', country: 'US', language: 'en' },
  })
  expect(response.statusCode).toBe(201)
  if (connected) {
    ctx.credentials.set('overview', {
      projectName: 'overview',
      propertyId: '123456',
      clientEmail: 'overview@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: SYNCED_AT,
      updatedAt: SYNCED_AT,
    })
  }
  return (JSON.parse(response.body) as { id: string }).id
}

function insertPeriod(ctx: Context, windowKey: GaOverviewWindow, which: typeof GaOverviewPeriods[keyof typeof GaOverviewPeriods], row: GaOverviewPeriodRow) {
  ctx.db.insert(gaWindowMetrics).values({ id: crypto.randomUUID(), projectId: ctx.projectId, windowKey, period: which, ...row }).run()
}

function insertDay(ctx: Context, row: GaOverviewDailyRow) {
  ctx.db.insert(gaDailyTotals).values({ id: crypto.randomUUID(), projectId: ctx.projectId, ...row, syncedAt: SYNCED_AT, createdAt: SYNCED_AT }).run()
}

describe('GET /projects/:name/ga/overview', () => {
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

  it('returns the stored window: its totals, the change, and both periods by day', async () => {
    insertPeriod(ctx, '7d', GaOverviewPeriods.current, period(CURRENT))
    insertPeriod(ctx, '7d', GaOverviewPeriods.previous, period(PREVIOUS, { sessions: 1280 }))
    insertDay(ctx, day('2026-10-22', { sessions: 230 }))
    insertDay(ctx, day('2026-10-15', { sessions: 190 }))
    // Outside both periods: never read.
    insertDay(ctx, day('2026-10-08', { sessions: 9999 }))

    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/overview/ga/overview?window=7d' })

    expect(response.statusCode).toBe(200)
    const overview = gaOverviewResponseSchema.parse(JSON.parse(response.body))
    expect(overview.window).toBe('7d')
    expect(overview.current).toEqual(CURRENT)
    expect(overview.totals.sessions).toBe(1600)
    expect(overview.changePct.sessions).toBe(25)
    expect(overview.days.at(-1)).toMatchObject({ date: '2026-10-22', previousDate: '2026-10-15' })
    expect(overview.days.at(-1)!.values.sessions).toBe(230)
    expect(overview.days.at(-1)!.previousValues.sessions).toBe(190)
    expect(overview.days.some(entry => entry.values.sessions === 9999 || entry.previousValues.sessions === 9999)).toBe(false)
  })

  it('answers 30d by default and refuses a window GA4 comparisons do not exist for', async () => {
    const byDefault = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/overview/ga/overview' })
    expect(byDefault.statusCode).toBe(200)
    expect(JSON.parse(byDefault.body).window).toBe('30d')

    for (const window of ['all', '60d']) {
      const refused = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/overview/ga/overview?window=${window}` })
      expect(refused.statusCode).toBe(400)
    }
  })

  it('refuses a project with no GA4 connection', async () => {
    ctx.credentials.delete('overview')
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/overview/ga/overview' })
    expect(response.statusCode).toBe(400)
  })
})

describe('GA4 sync stores the overview', () => {
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

  function stubSync(windowSessions: Record<GaOverviewWindow, number>) {
    vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('fake-token')
    vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({ periodStart: '2026-09-23', periodEnd: '2026-10-23', totalSessions: 1, totalOrganicSessions: 0, totalUsers: 1 })
    vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_token, _property, windowKey) => ({
      windowKey, periodStart: '2026-09-23', periodEnd: '2026-10-23', totalSessions: 1, totalOrganicSessions: 0, totalDirectSessions: 0, totalUsers: 1,
    }))
    vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchSearchLandingPages').mockResolvedValue({ status: 'ready', windows: [] })
    vi.spyOn(gaModule, 'fetchAcquisitionByChannel').mockResolvedValue({ startDate: '2026-09-23', endDate: '2026-10-23', rows: [] })
    vi.spyOn(gaModule, 'fetchLeadEvents').mockResolvedValue({ startDate: '2026-09-23', endDate: '2026-10-23', attributionScope: 'landing-page', rows: [] })
    vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue(dailyTotals([
      { date: '2026-10-21', sessions: 200, users: 150, engagementRate: 0.6, newUsers: 60, activeUsers: 140, organicSessions: 110, views: 410, eventCount: 1500, keyEvents: 5, engagementSeconds: 12600, bounceRate: 0.4 },
      { date: '2026-10-22', sessions: 180, users: 130, engagementRate: null, newUsers: null },
    ]))
    vi.spyOn(gaModule, 'fetchWindowMetrics').mockImplementation(async (_token, _property, windowKey) => ({
      windowKey,
      current: { ...period(CURRENT, { sessions: windowSessions[windowKey] }) },
      previous: { ...period(PREVIOUS, { sessions: windowSessions[windowKey] - 100, engagementSeconds: null }) },
    }))
  }

  it('stores every daily figure, nulls kept, and both periods of each window', async () => {
    stubSync({ '7d': 1600, '30d': 6400, '90d': 19000 })

    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/overview/ga/sync', payload: { days: 30 } })
    expect(response.statusCode).toBe(200)

    const days = ctx.db.select().from(gaDailyTotals).where(eq(gaDailyTotals.projectId, ctx.projectId)).all()
      .sort((left, right) => left.date.localeCompare(right.date))
    expect(days.map(row => [row.date, row.activeUsers, row.organicSessions, row.views, row.eventCount, row.keyEvents, row.engagementSeconds, row.bounceRate])).toEqual([
      ['2026-10-21', 140, 110, 410, 1500, 5, 12600, 0.4],
      ['2026-10-22', null, null, null, null, null, null, null],
    ])

    const periods = ctx.db.select().from(gaWindowMetrics).where(eq(gaWindowMetrics.projectId, ctx.projectId)).all()
    expect(periods.map(row => [row.windowKey, row.period, row.sessions, row.engagementSeconds]).sort()).toEqual([
      ['30d', 'current', 6400, 90000],
      ['30d', 'previous', 6300, null],
      ['7d', 'current', 1600, 90000],
      ['7d', 'previous', 1500, null],
      ['90d', 'current', 19000, 90000],
      ['90d', 'previous', 18900, null],
    ])
  })

  it('replaces the window rows on the next sync instead of adding to them', async () => {
    stubSync({ '7d': 1600, '30d': 6400, '90d': 19000 })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/overview/ga/sync', payload: { days: 30 } })
    vi.restoreAllMocks()
    stubSync({ '7d': 1700, '30d': 6500, '90d': 19100 })
    await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/overview/ga/sync', payload: { days: 30 } })

    const periods = ctx.db.select().from(gaWindowMetrics).where(eq(gaWindowMetrics.projectId, ctx.projectId)).all()
    expect(periods).toHaveLength(6)
    expect(periods.filter(row => row.period === GaOverviewPeriods.current).map(row => row.sessions).sort()).toEqual([1700, 19100, 6500])
  })
})
