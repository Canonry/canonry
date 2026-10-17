import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, runs, gscSearchData, gscDailyTotals } from '@canonry/canonry-db'
import { AppError } from '@canonry/canonry-contracts'
import { googleRoutes } from '../src/google.js'

/**
 * The dimensioned `gsc_search_data` table is valid for RANKING and invalid for
 * TOTALS. Google withholds rare/anonymised queries (so the sum UNDER-counts
 * clicks) and fans one impression across every query x page x country x device
 * combination (so the sum OVER-counts impressions). Measured on a real property
 * for one month: 792 summed clicks vs 1,142 property-level actual, and 45,266
 * summed impressions vs 34,916 actual.
 *
 * The fixture below reproduces exactly that disagreement so any endpoint that
 * "simplifies" a total back into a SUM() over the dimensioned table fails loudly.
 */
const DIMENSIONED_SUM = { clicks: 792, impressions: 45_266 }
const PROPERTY_ACTUAL = { clicks: 1_142, impressions: 34_916 }

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-top-pages-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => undefined,
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
  })

  return { app, db, tmpDir }
}

/**
 * Eight dimensioned rows over four distinct pages and four dates. Every page is
 * split across two (date, query) rows so a JS-side aggregation and a SQL-side
 * `GROUP BY page` are distinguishable: correct output is 4 rows, not 8.
 */
const DIMENSIONED_ROWS = [
  { page: '/a', date: '2026-06-01', query: 'q1', clicks: 250, impressions: 12_000 },
  { page: '/a', date: '2026-06-15', query: 'q2', clicks: 150, impressions: 8_000 },
  { page: '/b', date: '2026-06-01', query: 'q1', clicks: 110, impressions: 9_000 },
  { page: '/b', date: '2026-06-15', query: 'q3', clicks: 140, impressions: 6_000 },
  { page: '/c', date: '2026-06-02', query: 'q4', clicks: 60, impressions: 5_000 },
  { page: '/c', date: '2026-06-16', query: 'q5', clicks: 40, impressions: 3_000 },
  { page: '/d', date: '2026-06-02', query: 'q6', clicks: 22, impressions: 1_266 },
  { page: '/d', date: '2026-06-16', query: 'q7', clicks: 20, impressions: 1_000 },
]

/** Property-level daily totals for the same window. Deliberately disagree. */
const PROPERTY_DAILY_ROWS = [
  { date: '2026-06-01', clicks: 300, impressions: 9_000 },
  { date: '2026-06-02', clicks: 280, impressions: 8_000 },
  { date: '2026-06-15', clicks: 312, impressions: 9_916 },
  { date: '2026-06-16', clicks: 250, impressions: 8_000 },
]

interface TopPagesBody {
  rankedFrom: string | null
  rankedThrough: string | null
  rows: Array<{ page: string; clicks: number; impressions: number; ctr: number }>
  totals: { clicks: number; impressions: number; ctr: number; days: number } | null
  totalsSource: 'property-daily'
}

describe('googleRoutes: GET /projects/:name/google/gsc/top-pages', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string

  beforeEach(async () => {
    context = buildApp()
    await context.app.ready()
    projectId = crypto.randomUUID()
    const now = '2026-07-01T00:00:00.000Z'
    context.db.insert(projects).values({
      id: projectId,
      name: 'pages',
      displayName: 'Pages',
      canonicalDomain: 'pages.example.com',
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
    for (const row of DIMENSIONED_ROWS) {
      context.db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: row.date,
        query: row.query,
        page: row.page,
        country: 'usa',
        device: 'DESKTOP',
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: '0.1',
        position: '3',
        createdAt: now,
      }).run()
    }
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  })

  function seedPropertyDaily() {
    const now = '2026-07-01T00:00:00.000Z'
    for (const row of PROPERTY_DAILY_ROWS) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date: row.date,
        clicks: row.clicks,
        impressions: row.impressions,
        position: '5',
        createdAt: now,
      }).run()
    }
  }

  it('confirms the fixture reproduces the real dimensioned-vs-property disagreement', () => {
    const summedClicks = DIMENSIONED_ROWS.reduce((n, r) => n + r.clicks, 0)
    const summedImpressions = DIMENSIONED_ROWS.reduce((n, r) => n + r.impressions, 0)
    expect({ clicks: summedClicks, impressions: summedImpressions }).toEqual(DIMENSIONED_SUM)

    const propertyClicks = PROPERTY_DAILY_ROWS.reduce((n, r) => n + r.clicks, 0)
    const propertyImpressions = PROPERTY_DAILY_ROWS.reduce((n, r) => n + r.impressions, 0)
    expect({ clicks: propertyClicks, impressions: propertyImpressions }).toEqual(PROPERTY_ACTUAL)
  })

  it('ranks pages by summed clicks descending', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as TopPagesBody
    expect(body.rows.map((r) => r.page)).toEqual(['/a', '/b', '/c', '/d'])
    expect(body.rows.map((r) => r.clicks)).toEqual([400, 250, 100, 42])
    expect(body.rows.map((r) => r.impressions)).toEqual([20_000, 15_000, 8_000, 2_266])
    expect(body.rows[0]!.ctr).toBe(400 / 20_000)
  })

  it('aggregates in SQL: never returns more rows than there are distinct pages', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    const body = res.json() as TopPagesBody
    const distinctPages = new Set(DIMENSIONED_ROWS.map((r) => r.page)).size
    expect(distinctPages).toBe(4)
    expect(DIMENSIONED_ROWS.length).toBe(8)
    expect(body.rows.length).toBe(distinctPages)
    expect(new Set(body.rows.map((r) => r.page)).size).toBe(body.rows.length)
  })

  it('respects startDate and endDate', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/pages/google/gsc/top-pages?startDate=2026-06-15&endDate=2026-06-30',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as TopPagesBody
    expect(body.rows.map((r) => r.page)).toEqual(['/a', '/b', '/c', '/d'])
    expect(body.rows.map((r) => r.clicks)).toEqual([150, 140, 40, 20])
    expect(body.rows.map((r) => r.impressions)).toEqual([8_000, 6_000, 3_000, 1_000])
  })

  it('respects limit while still ranking over the whole window', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages?limit=2' })
    const body = res.json() as TopPagesBody
    expect(body.rows.map((r) => r.page)).toEqual(['/a', '/b'])
  })

  it('sources totals from the property-level daily table, NEVER from the dimensioned sum', async () => {
    seedPropertyDaily()
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as TopPagesBody

    expect(body.totalsSource).toBe('property-daily')
    expect(body.totals).toEqual({
      clicks: PROPERTY_ACTUAL.clicks,
      impressions: PROPERTY_ACTUAL.impressions,
      ctr: PROPERTY_ACTUAL.clicks / PROPERTY_ACTUAL.impressions,
      days: PROPERTY_DAILY_ROWS.length,
      coveredFrom: '2026-06-01',
      coveredThrough: '2026-06-16',
      complete: true,
    })

    // The regression guard: the dimensioned sum is 31% under on clicks and 30%
    // over on impressions. Neither figure may appear as a total.
    expect(body.totals!.clicks).not.toBe(DIMENSIONED_SUM.clicks)
    expect(body.totals!.impressions).not.toBe(DIMENSIONED_SUM.impressions)
    const rankedClicks = body.rows.reduce((n, r) => n + r.clicks, 0)
    const rankedImpressions = body.rows.reduce((n, r) => n + r.impressions, 0)
    expect(rankedClicks).toBe(DIMENSIONED_SUM.clicks)
    expect(rankedImpressions).toBe(DIMENSIONED_SUM.impressions)
    expect(body.totals!.clicks).not.toBe(rankedClicks)
    expect(body.totals!.impressions).not.toBe(rankedImpressions)
  })

  it('returns null totals rather than falling back to the dimensioned sum', async () => {
    // No gsc_daily_totals rows at all. The honest answer is "no property-level
    // total available", not the plausible-but-wrong dimensioned sum.
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    const body = res.json() as TopPagesBody
    expect(body.rows.length).toBe(4)
    expect(body.totals).toBeNull()
  })

  it('scopes totals to the requested window', async () => {
    seedPropertyDaily()
    const res = await context.app.inject({
      method: 'GET',
      url: '/projects/pages/google/gsc/top-pages?startDate=2026-06-15&endDate=2026-06-30',
    })
    const body = res.json() as TopPagesBody
    expect(body.totals).toEqual({
      clicks: 562,
      impressions: 17_916,
      ctr: 562 / 17_916,
      days: 2,
      coveredFrom: '2026-06-15',
      coveredThrough: '2026-06-16',
      complete: true,
    })
  })

  it('flags totals as incomplete when they cover less than the ranked rows', async () => {
    // The real shape of this: a routine 30-day totals sync sitting next to
    // months of dimensioned rows. Ranking spans the longer period, totals span
    // the shorter one, and printing both as one period misstates the window.
    const now = '2026-07-01T00:00:00.000Z'
    context.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-06-16',
      clicks: 250,
      impressions: 8_000,
      position: '5',
      createdAt: now,
    }).run()

    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    const body = res.json() as TopPagesBody
    expect(body.rankedFrom).toBe('2026-06-01')
    expect(body.rankedThrough).toBe('2026-06-16')
    expect(body.totals!.coveredFrom).toBe('2026-06-16')
    expect(body.totals!.coveredThrough).toBe('2026-06-16')
    expect(body.totals!.complete).toBe(false)
  })

  it('returns 404 for an unknown project', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/nope/google/gsc/top-pages' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GSC read paths never report a dimensioned sum as a total', () => {
  let context: ReturnType<typeof buildApp>
  let projectId: string

  beforeEach(async () => {
    context = buildApp()
    await context.app.ready()
    projectId = crypto.randomUUID()
    const now = '2026-07-01T00:00:00.000Z'
    context.db.insert(projects).values({
      id: projectId,
      name: 'pages',
      displayName: 'Pages',
      canonicalDomain: 'pages.example.com',
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
    for (const row of DIMENSIONED_ROWS) {
      context.db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId,
        date: row.date,
        query: row.query,
        page: row.page,
        country: 'usa',
        device: 'DESKTOP',
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: '0.1',
        position: '3',
        createdAt: now,
      }).run()
    }
    for (const row of PROPERTY_DAILY_ROWS) {
      context.db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date: row.date,
        clicks: row.clicks,
        impressions: row.impressions,
        position: '5',
        createdAt: now,
      }).run()
    }
  })

  afterEach(async () => {
    await context.app.close()
    fs.rmSync(context.tmpDir, { recursive: true, force: true })
  })

  it('performance/daily reports the property-level total', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/performance/daily' })
    const body = res.json() as { totals: { clicks: number; impressions: number } }
    expect(body.totals.clicks).toBe(PROPERTY_ACTUAL.clicks)
    expect(body.totals.impressions).toBe(PROPERTY_ACTUAL.impressions)
    expect(body.totals.clicks).not.toBe(DIMENSIONED_SUM.clicks)
    expect(body.totals.impressions).not.toBe(DIMENSIONED_SUM.impressions)
  })

  it('top-pages reports the property-level total', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/top-pages' })
    const body = res.json() as TopPagesBody
    expect(body.totals!.clicks).toBe(PROPERTY_ACTUAL.clicks)
    expect(body.totals!.impressions).toBe(PROPERTY_ACTUAL.impressions)
  })

  it('performance reports a row count but never a clicks or impressions total', async () => {
    // The paged row endpoint must not grow a METRIC totals block: it only ever
    // covers one page of the dimensioned table, so any clicks/impressions total
    // it computed would be wrong twice over (under on clicks, over on
    // impressions). `totalMatching` is a ROW COUNT, not a metric, and is the
    // whole point of the envelope, so it is expected here.
    const res = await context.app.inject({ method: 'GET', url: '/projects/pages/google/gsc/performance' })
    const body = res.json() as Record<string, unknown>
    expect(Array.isArray(body.rows)).toBe(true)
    expect(typeof body.totalMatching).toBe('number')
    expect(body).not.toHaveProperty('totals')
    // Belt and braces: nothing in the envelope may equal the dimensioned sum.
    const values = Object.values(body).filter((v) => typeof v === 'number')
    expect(values).not.toContain(DIMENSIONED_SUM.clicks)
    expect(values).not.toContain(DIMENSIONED_SUM.impressions)
  })
})
