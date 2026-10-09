import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, gaDailyTotals, migrate } from '@ainyc/canonry-db'
import { gaMeasurementAnalysisDtoSchema } from '@ainyc/canonry-contracts'
import * as gaModule from '@ainyc/canonry-integration-google-analytics'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'

/**
 * GA4 engagement rate + returning users, from the sync write through to the
 * measurement-analysis DTO.
 *
 * The load-bearing property throughout is that an UNAVAILABLE reading is never
 * reported as zero. Rows written before the metrics existed carry NULL, and the
 * DTO says so explicitly rather than emitting a 0 a client report would draw as
 * a flat line across the whole pre-migration period.
 */

const ANCHOR = '2026-07-22'
const NOW = '2026-07-23T12:00:00.000Z'

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-engagement-'))
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

async function seedProject(ctx: ReturnType<typeof buildApp>): Promise<string> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/projects/engagement',
    payload: {
      displayName: 'Engagement',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })
  expect(response.statusCode).toBe(201)
  ctx.credentials.set('engagement', {
    projectName: 'engagement',
    propertyId: '123456',
    clientEmail: 'engagement@test.iam.gserviceaccount.com',
    privateKey: 'fake-key',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return (JSON.parse(response.body) as { id: string }).id
}

function insertDailyTotal(
  ctx: Context,
  input: {
    daysAgo: number
    sessions: number
    users: number
    engagementRate?: number | null
    newUsers?: number | null
  },
) {
  ctx.db.insert(gaDailyTotals).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(ANCHOR, input.daysAgo),
    sessions: input.sessions,
    users: input.users,
    engagementRate: input.engagementRate ?? null,
    newUsers: input.newUsers ?? null,
    syncedAt: NOW,
    createdAt: NOW,
  }).run()
}

async function analysis(ctx: Context, query = '?window=90d') {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/projects/engagement/ga/measurement-analysis${query}`,
  })
  expect(response.statusCode).toBe(200)
  return gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
}

describe('GA4 engagement metrics', () => {
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

  it('persists engagementRate and newUsers from the GA4 sync', async () => {
    vi.spyOn(gaModule, 'getAccessToken').mockResolvedValue('fake-token')
    vi.spyOn(gaModule, 'fetchAggregateSummary').mockResolvedValue({
      periodStart: '2026-06-22',
      periodEnd: ANCHOR,
      totalSessions: 400,
      totalOrganicSessions: 150,
      totalUsers: 280,
    })
    vi.spyOn(gaModule, 'fetchWindowSummary').mockImplementation(async (_t, _p, windowKey) => ({
      windowKey,
      periodStart: '2026-06-22',
      periodEnd: ANCHOR,
      totalSessions: 400,
      totalOrganicSessions: 150,
      totalDirectSessions: 40,
      totalUsers: 280,
    }))
    vi.spyOn(gaModule, 'fetchTrafficByLandingPage').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchAiReferrals').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchSocialReferrals').mockResolvedValue([])
    vi.spyOn(gaModule, 'fetchSearchLandingPages').mockResolvedValue({ status: 'ready', windows: [] })
    vi.spyOn(gaModule, 'fetchAcquisitionByChannel').mockResolvedValue({
      startDate: '2026-06-22', endDate: ANCHOR, rows: [],
    })
    vi.spyOn(gaModule, 'fetchLeadEvents').mockResolvedValue({
      startDate: '2026-06-22', endDate: ANCHOR, attributionScope: 'landing-page', rows: [],
    })
    vi.spyOn(gaModule, 'fetchDailyTotals').mockResolvedValue([
      { date: '2026-07-21', sessions: 100, users: 80, engagementRate: 0.6, newUsers: 50},
      { date: ANCHOR, sessions: 300, users: 200, engagementRate: null, newUsers: null},
    ])

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/engagement/ga/sync',
      payload: { days: 30 },
    })
    expect(response.statusCode).toBe(200)

    const rows = ctx.db.select().from(gaDailyTotals)
      .where(eq(gaDailyTotals.projectId, ctx.projectId))
      .all()
      .sort((left, right) => left.date.localeCompare(right.date))

    expect(rows.map(row => [row.date, row.engagementRate, row.newUsers])).toEqual([
      ['2026-07-21', 0.6, 50],
      [ANCHOR, null, null],
    ])
  })

  it('reports engagement per period with a sessions-weighted rate', async () => {
    // Latest period. The weighted rate is the only correct aggregation: a rate
    // is not additive, but sessions are, and engagementRate = engagedSessions
    // / sessions, so weighting by sessions reconstructs the period rate exactly.
    insertDailyTotal(ctx, { daysAgo: 1, sessions: 100, users: 80, engagementRate: 0.6, newUsers: 50 })
    insertDailyTotal(ctx, { daysAgo: 0, sessions: 300, users: 200, engagementRate: 0.7, newUsers: 120 })
    // Earliest period: a day written before the metrics existed.
    insertDailyTotal(ctx, { daysAgo: 70, sessions: 90, users: 40 })

    const dto = await analysis(ctx)
    const byLabel = Object.fromEntries(dto.engagement.periods.map(period => [period.label, period]))

    expect(dto.engagement.status).toBe('ready')
    expect(dto.engagement.latestDate).toBe(ANCHOR)

    const latest = byLabel.latest!
    expect(latest.sessions).toBe(400)
    // (0.6 * 100 + 0.7 * 300) / 400
    expect(latest.engagementRate).toBeCloseTo(0.675, 10)
    expect(latest.dailyTotalUsers).toBe(280)
    expect(latest.dailyNewUsers).toBe(170)
    expect(latest.metricsAvailable).toBe(true)
    expect(latest.daysInPeriod).toBe(2)
    expect(latest.daysWithEngagementRate).toBe(2)
    expect(latest.daysWithUserSplit).toBe(2)

    // No returning-users invariant to assert: the figure is deliberately not
    // derived here, because a visitor can be first-seen and return inside the
    // same range, so new + returning does not reconcile to the total.
    expect(latest).not.toHaveProperty('dailyReturningUsers')
  })

  it('marks pre-migration periods unavailable instead of reporting zero', async () => {
    insertDailyTotal(ctx, { daysAgo: 1, sessions: 100, users: 80, engagementRate: 0.6, newUsers: 50 })
    insertDailyTotal(ctx, { daysAgo: 0, sessions: 300, users: 200, engagementRate: 0.7, newUsers: 120 })
    insertDailyTotal(ctx, { daysAgo: 70, sessions: 90, users: 40 })

    const dto = await analysis(ctx)
    const byLabel = Object.fromEntries(dto.engagement.periods.map(period => [period.label, period]))

    // A period whose days predate the metric: sessions are real, the engagement
    // metrics are absent. Absent must NOT read as 0.
    const earliest = byLabel.earliest!
    expect(earliest.sessions).toBe(90)
    expect(earliest.daysInPeriod).toBe(1)
    expect(earliest.metricsAvailable).toBe(false)
    expect(earliest.engagementRate).toBeNull()
    expect(earliest.dailyTotalUsers).toBeNull()
    expect(earliest.dailyNewUsers).toBeNull()
    expect(earliest.daysWithEngagementRate).toBe(0)
    expect(earliest.daysWithUserSplit).toBe(0)

    // A period with no rows at all is equally explicit.
    const middle = byLabel.middle!
    expect(middle.sessions).toBe(0)
    expect(middle.daysInPeriod).toBe(0)
    expect(middle.metricsAvailable).toBe(false)
    expect(middle.engagementRate).toBeNull()

    // And the DTO states the boundary outright, so a client report can label
    // the pre-migration span rather than plotting it as a zero line.
    expect(dto.engagement.availableFromDate).toBe('2026-07-21')
  })

  it('distinguishes a real zero engagement rate from an unavailable one', async () => {
    insertDailyTotal(ctx, { daysAgo: 0, sessions: 50, users: 20, engagementRate: 0, newUsers: 20 })

    const dto = await analysis(ctx, '?window=30d')
    const latest = dto.engagement.periods[0]!

    expect(latest.metricsAvailable).toBe(true)
    expect(latest.engagementRate).toBe(0)
    expect(latest.engagementRate).not.toBeNull()
    // Every user that day was new, so returning is a real 0 too.
  })

  it('is unavailable, not empty-with-zeros, when the project has no daily totals', async () => {
    const dto = await analysis(ctx)

    expect(dto.engagement.status).toBe('unavailable')
    expect(dto.engagement.latestDate).toBeNull()
    expect(dto.engagement.availableFromDate).toBeNull()
    expect(dto.engagement.periods).toEqual([])
  })
})
