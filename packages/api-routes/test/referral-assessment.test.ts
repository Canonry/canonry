import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, trafficSources, aiReferralEventsHourly, gaAiReferrals, gaTrafficSummaries, measurementPlans, measurementPlanVersions } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const date = '2026-08-01T00:00:00.000Z'
const gaSyncedAt = '2026-09-02T06:00:00.000Z'
const url = '/api/v1/projects/example/traffic/referral-assessment?startDate=2026-08-01&endDate=2026-08-31'

describe('stored referral assessment', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  const row = (overrides: Partial<typeof aiReferralEventsHourly.$inferInsert> = {}) => {
    db.insert(aiReferralEventsHourly).values({
      projectId: 'project', sourceId: 'source', tsHour: date, product: 'ChatGPT', operator: 'OpenAI',
      sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: '/collection/:id',
      status: 200, sessionsOrHits: 70, paidSessionsOrHits: 20, organicSessionsOrHits: 40,
      createdAt: date, updatedAt: date, ...overrides,
    }).run()
  }
  // GA rows as the GA sync writes them: GA4 omits all-zero rows, and one sync
  // stamps its summary window and its AI rows with one `syncedAt`.
  const gaRow = (id: string, overrides: Partial<typeof gaAiReferrals.$inferInsert> = {}) => {
    db.insert(gaAiReferrals).values({ id, projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', channelGroup: 'Referral', landingPage: '/', sessions: 10, users: 1, trafficClass: 'organic', syncedAt: gaSyncedAt, ...overrides }).run()
  }
  const gaSummary = (periodStart: string, periodEnd: string, syncedAt = gaSyncedAt) => {
    db.insert(gaTrafficSummaries).values({ id: `summary-${syncedAt}`, projectId: 'project', periodStart, periodEnd, totalSessions: 420, totalOrganicSessions: 200, totalUsers: 300, syncedAt }).run()
  }
  const comparison = async (query = '') => (await app.inject({ method: 'GET', url: `${url}${query}` })).json().comparison
  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://EXAMPLE.com', country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: date, updatedAt: date }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('conserves raw, redirect, subresource, suspicious and adjusted classes across split dimensions', async () => {
    row()
    row({ evidenceType: 'utm', sourceDomain: 'chatgpt', status: 304, sessionsOrHits: 30, paidSessionsOrHits: 10, organicSessionsOrHits: 15 })
    row({ landingPathNormalized: '/ordinary', sessionsOrHits: 9, paidSessionsOrHits: 1, organicSessionsOrHits: 6 })
    row({ status: 302, sessionsOrHits: 7, paidSessionsOrHits: 0, organicSessionsOrHits: 7 })
    row({ landingPathNormalized: '/assets/app.js', sessionsOrHits: 5, paidSessionsOrHits: 0, organicSessionsOrHits: 5 })
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(result.totals).toEqual({
      raw: { total: 121, paid: 31, organic: 73, unknown: 17 },
      redirects: { total: 7, paid: 0, organic: 7, unknown: 0 },
      subresources: { total: 5, paid: 0, organic: 5, unknown: 0 },
      countable: { total: 109, paid: 31, organic: 61, unknown: 17 },
      suspected: { total: 100, paid: 30, organic: 55, unknown: 15 },
      adjustedEstimate: { total: 9, paid: 1, organic: 6, unknown: 2 },
    })
    expect(result.bursts).toEqual([{ sourceId: 'source', product: 'ChatGPT', landingPathNormalized: '/collection/:id', tsHour: date, counts: { total: 100, paid: 30, organic: 55, unknown: 15 } }])
    expect(result.rule).toMatchObject({ version: 'hourly-normalized-path-v1', burstThreshold: 100, calibration: 'uncalibrated-default', confirmsAutomation: false })
    expect(result.caveats.join(' ')).toContain('Legitimate')
    expect(result.caveats.join(' ')).toContain('normalized')
    // Existing API headlines and redirects must remain unchanged.
    const existing = (await app.inject({ method: 'GET', url: '/api/v1/projects/example/traffic/events?since=2026-08-01&until=2026-08-31&kind=ai-referral' })).json()
    expect(existing.totals.aiReferralLandedHits).toBe(109)
    expect(existing.totals.aiReferralRedirectedHits).toBe(7)
  })

  it('re-evaluates late updates and threshold changes without persisting a classification', async () => {
    row({ sessionsOrHits: 99, paidSessionsOrHits: 0, organicSessionsOrHits: 99 })
    expect((await app.inject({ method: 'GET', url })).json().totals.suspected.total).toBe(0)
    db.update(aiReferralEventsHourly).set({ sessionsOrHits: 100, organicSessionsOrHits: 100 }).where(eq(aiReferralEventsHourly.projectId, 'project')).run()
    expect((await app.inject({ method: 'GET', url })).json().totals.suspected.total).toBe(100)
    const changed = (await app.inject({ method: 'GET', url: `${url}&burstThreshold=101` })).json()
    expect(changed.totals.adjustedEstimate.total).toBe(100)
    expect(changed.rule.calibration).toBe('request-override')
    expect(db.select().from(aiReferralEventsHourly).all()[0]?.sessionsOrHits).toBe(100)
  })

  it('does not combine sources, products or hours, and counts full totals before evidence truncation', async () => {
    db.insert(trafficSources).values({ id: 'other', projectId: 'project', sourceType: 'vercel', displayName: 'Origin', status: 'connected', createdAt: date, updatedAt: date }).run()
    row({ sessionsOrHits: 60, paidSessionsOrHits: 0, organicSessionsOrHits: 60 })
    row({ sourceId: 'other', sessionsOrHits: 60, paidSessionsOrHits: 0, organicSessionsOrHits: 60 })
    row({ product: 'Claude', sessionsOrHits: 60, paidSessionsOrHits: 0, organicSessionsOrHits: 60 })
    row({ tsHour: '2026-08-01T01:00:00.000Z', sessionsOrHits: 60, paidSessionsOrHits: 0, organicSessionsOrHits: 60 })
    expect((await app.inject({ method: 'GET', url })).json().totals.suspected.total).toBe(0)
    const capped = (await app.inject({ method: 'GET', url: `${url}&burstThreshold=50&limit=1` })).json()
    expect(capped.totals.suspected.total).toBe(240)
    expect(capped.evidence).toEqual({ total: 4, returned: 1, truncated: true })
    const selected = (await app.inject({ method: 'GET', url: `${url}&sourceId=other&burstThreshold=50` })).json()
    expect(selected.totals.raw.total).toBe(60)
    expect(selected.scope).toMatchObject({ project: 'example', sourceId: 'other', attribution: 'project-source-only' })
  })

  it('deduplicates GA attribution lenses but leaves coverage and missing GA unknown', async () => {
    row()
    const absent = (await app.inject({ method: 'GET', url })).json().comparison
    expect(absent.gaSessions).toBeNull()
    expect(absent.status).toBe('unavailable')
    for (const [dimension, sessions] of [['session', 10], ['first_user', 8], ['manual_utm', 9]] as const) {
      db.insert(gaAiReferrals).values({ id: dimension, projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sourceDimension: dimension, channelGroup: 'Referral', landingPage: '/', sessions, users: 1, trafficClass: 'organic', syncedAt: date }).run()
    }
    const result = (await app.inject({ method: 'GET', url })).json()
    expect(result.comparison).toMatchObject({ status: 'unavailable', gaSessions: 10, observedRatio: 7, observedRatioAboveThreshold: true, ratio: null, reasons: expect.arrayContaining(['server-coverage-unproven', 'ga-time-zone-unknown']) })
    const tuned = (await app.inject({ method: 'GET', url: `${url}&ratioThreshold=7` })).json()
    expect(tuned.comparison.observedRatioAboveThreshold).toBe(false)
  })

  it('returns the same project evidence for an Advanced portfolio without invented scope attribution', async () => {
    row()
    const simple = (await app.inject({ method: 'GET', url })).json()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'version', projectId: 'project', revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: date }).run()
    db.insert(measurementPlans).values({ projectId: 'project', activeVersionId: 'version', createdAt: date, updatedAt: date }).run()
    const advanced = (await app.inject({ method: 'GET', url })).json()
    expect(advanced).toEqual(simple)
    expect(advanced.scope.unavailableDimensions).toEqual(['property', 'target', 'market'])
  })

  it('keeps missing status, error arrivals, legacy unknown and exact date boundaries', async () => {
    row({ status: 0, sessionsOrHits: 100, paidSessionsOrHits: 0, organicSessionsOrHits: 0 })
    row({ tsHour: '2026-08-31T23:00:00.000Z', status: 500, sessionsOrHits: 3, paidSessionsOrHits: 0, organicSessionsOrHits: 3 })
    row({ tsHour: '2026-09-01T00:00:00.000Z', sessionsOrHits: 999, paidSessionsOrHits: 0, organicSessionsOrHits: 999 })
    row({ landingPathNormalized: '/assets/app.js', status: 302, sessionsOrHits: 2, paidSessionsOrHits: 0, organicSessionsOrHits: 2 })
    const result = (await app.inject({ method: 'GET', url })).json()
    expect(result.totals.raw.total).toBe(105)
    expect(result.totals.suspected).toEqual({ total: 100, paid: 0, organic: 0, unknown: 100 })
    expect(result.totals.adjustedEstimate).toEqual({ total: 3, paid: 0, organic: 3, unknown: 0 })
    expect(result.totals.redirects.total).toBe(2)
    expect(result.totals.subresources.total).toBe(0)
  })

  it('returns explicit empty observations and refuses another project source', async () => {
    const empty = (await app.inject({ method: 'GET', url })).json()
    expect(empty.totals.adjustedEstimate).toEqual({ total: 0, paid: 0, organic: 0, unknown: 0 })
    expect(empty.bursts).toEqual([])
    expect(empty.comparison).toMatchObject({ status: 'unavailable', gaSessions: null, observedRatio: null })
    db.insert(projects).values({ id: 'other-project', name: 'other-project', displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    db.insert(trafficSources).values({ id: 'not-owned', projectId: 'other-project', sourceType: 'vercel', displayName: 'Other', status: 'connected', createdAt: date, updatedAt: date }).run()
    expect((await app.inject({ method: 'GET', url: `${url}&sourceId=not-owned` })).statusCode).toBe(404)
  })

  it('does not turn absent server evidence into a measured zero quotient', async () => {
    gaRow('ga')
    const missing = (await app.inject({ method: 'GET', url })).json()
    expect(missing.comparison).toMatchObject({ serverObservation: 'missing', serverCountable: 0, gaSessions: 10, observedRatio: null, observedRatioAboveThreshold: null })
    expect(missing.comparison.reasons).toContain('server-data-missing')
    // Stored rows that are all redirect hops or subresources: observed, none countable.
    row({ status: 302, sessionsOrHits: 4, paidSessionsOrHits: 0, organicSessionsOrHits: 4 })
    row({ landingPathNormalized: '/assets/app.js', sessionsOrHits: 3, paidSessionsOrHits: 0, organicSessionsOrHits: 3 })
    const zero = (await app.inject({ method: 'GET', url })).json()
    expect(zero.totals.raw.total).toBe(7)
    expect(zero.totals.redirects.total).toBe(4)
    expect(zero.totals.subresources.total).toBe(3)
    expect(zero.totals.countable).toEqual({ total: 0, paid: 0, organic: 0, unknown: 0 })
    expect(zero.comparison).toMatchObject({ serverObservation: 'observed-zero', serverCountable: 0, gaSessions: 10, gaObservation: 'observed-positive', observedRatio: 0, observedRatioAboveThreshold: false, status: 'unavailable' })
    expect(zero.comparison.reasons).not.toContain('server-data-missing')
  })

  it('reads a window inside the latest GA sync window with no AI rows as observed zero', async () => {
    row()
    gaSummary('2026-07-15', '2026-09-01')
    const zero = await comparison()
    expect(zero).toMatchObject({ gaSessions: 0, gaObservation: 'observed-zero', serverObservation: 'observed-positive', observedRatio: null, observedRatioAboveThreshold: null, status: 'unavailable', ratio: null })
    expect(zero.reasons).toEqual(expect.arrayContaining(['ga-observed-zero', 'ga-coverage-unproven', 'ga-time-zone-unknown']))
    expect(zero.reasons).not.toContain('ga-data-missing')
    // The same sync stored AI rows outside the requested window: it did query
    // the AI breakdown, so the empty window is still a measured zero.
    gaRow('ga-july', { date: '2026-07-20', sessions: 6 })
    gaRow('ga-september', { date: '2026-09-01', sessions: 4 })
    expect(await comparison()).toMatchObject({ gaSessions: 0, gaObservation: 'observed-zero' })
  })

  it.each([
    ['equal to the request', '2026-08-01', '2026-08-31', 'observed-zero'],
    ['one day short at the start', '2026-08-02', '2026-08-31', 'missing'],
    ['one day short at the end', '2026-08-01', '2026-08-30', 'missing'],
    ['overlapping only the end of the request', '2026-08-05', '2026-09-03', 'missing'],
    ['entirely after the request', '2026-09-01', '2026-09-30', 'missing'],
  ] as const)('keeps GA missing unless the latest sync window covers the request (summary %s)', async (_label, periodStart, periodEnd, observation) => {
    gaSummary(periodStart, periodEnd)
    const result = await comparison()
    expect(result.gaObservation).toBe(observation)
    expect(result.gaSessions).toBe(observation === 'observed-zero' ? 0 : null)
    expect(result.reasons).toContain(observation === 'observed-zero' ? 'ga-observed-zero' : 'ga-data-missing')
    expect(result.reasons).toContain('ga-coverage-unproven')
  })

  it('keeps GA missing when the latest sync skipped the AI breakdown', async () => {
    // `ga sync --only traffic` moved the summary window without rewriting AI
    // rows, so the rows in it came from an earlier sync.
    gaRow('ga-earlier', { date: '2026-07-20', sessions: 6, syncedAt: '2026-08-15T06:00:00.000Z' })
    gaSummary('2026-07-15', '2026-09-01')
    expect(await comparison()).toMatchObject({ gaSessions: null, gaObservation: 'missing' })
  })

  it('bounds GA rows to the inclusive window dates', async () => {
    row({ sessionsOrHits: 90, paidSessionsOrHits: 0, organicSessionsOrHits: 90 })
    gaRow('before-start', { date: '2026-07-31', sessions: 500 })
    gaRow('start', { date: '2026-08-01', sessions: 20 })
    gaRow('end', { date: '2026-08-31', sessions: 10 })
    gaRow('after-end', { date: '2026-09-01', sessions: 700 })
    expect(await comparison()).toMatchObject({ gaSessions: 30, gaObservation: 'observed-positive', observedRatio: 3 })
  })

  it.each([
    [100, 30, 3.33],
    [100, 40, 2.5],
    [1, 8, 0.13],
    [2, 3, 0.67],
    // Below 0.005 the published figure rounds to 0; the observation state
    // and both operands still show server hits were observed.
    [1, 300, 0],
  ] as const)('rounds the observed quotient %s / %s to %s', async (serverHits, gaSessions, expected) => {
    row({ sessionsOrHits: serverHits, paidSessionsOrHits: 0, organicSessionsOrHits: serverHits })
    gaRow('ga', { sessions: gaSessions })
    const result = await comparison('&burstThreshold=1000')
    expect(result).toMatchObject({ serverCountable: serverHits, serverObservation: 'observed-positive', gaSessions, gaObservation: 'observed-positive', observedRatio: expected })
  })

  it('tests the published rounded quotient against the ratio threshold', async () => {
    row({ sessionsOrHits: 100, paidSessionsOrHits: 0, organicSessionsOrHits: 100 })
    gaRow('ga', { sessions: 30 })
    expect(await comparison('&ratioThreshold=3.32')).toMatchObject({ observedRatio: 3.33, observedRatioAboveThreshold: true })
    expect(await comparison('&ratioThreshold=3.33')).toMatchObject({ observedRatio: 3.33, observedRatioAboveThreshold: false })
    expect(await comparison('&ratioThreshold=3.333')).toMatchObject({ observedRatio: 3.33, observedRatioAboveThreshold: false })
  })

  it('returns the largest bursts first and keeps them when the detail limit truncates', async () => {
    const hour = (h: number) => `2026-08-01T${String(h).padStart(2, '0')}:00:00.000Z`
    row({ landingPathNormalized: '/a', tsHour: hour(0), sessionsOrHits: 150, paidSessionsOrHits: 0, organicSessionsOrHits: 150 })
    row({ landingPathNormalized: '/b', tsHour: hour(2), sessionsOrHits: 300, paidSessionsOrHits: 0, organicSessionsOrHits: 300 })
    row({ landingPathNormalized: '/c', tsHour: hour(1), sessionsOrHits: 120, paidSessionsOrHits: 0, organicSessionsOrHits: 120 })
    row({ landingPathNormalized: '/d', tsHour: hour(1), sessionsOrHits: 300, paidSessionsOrHits: 0, organicSessionsOrHits: 300 })
    row({ landingPathNormalized: '/a2', tsHour: hour(1), sessionsOrHits: 300, paidSessionsOrHits: 0, organicSessionsOrHits: 300 })
    row({ landingPathNormalized: '/small', tsHour: hour(3), sessionsOrHits: 99, paidSessionsOrHits: 0, organicSessionsOrHits: 99 })
    // Total descending, then the hour, then source, product and path ascending.
    const order = ['/a2', '/d', '/b', '/a', '/c']
    const full = (await app.inject({ method: 'GET', url })).json()
    expect(full.bursts.map((burst: { landingPathNormalized: string }) => burst.landingPathNormalized)).toEqual(order)
    expect(full.bursts.map((burst: { counts: { total: number } }) => burst.counts.total)).toEqual([300, 300, 300, 150, 120])
    expect(full.evidence).toEqual({ total: 5, returned: 5, truncated: false })
    for (const limit of [1, 3]) {
      const capped = (await app.inject({ method: 'GET', url: `${url}&limit=${limit}` })).json()
      expect(capped.bursts.map((burst: { landingPathNormalized: string }) => burst.landingPathNormalized)).toEqual(order.slice(0, limit))
      expect(capped.evidence).toEqual({ total: 5, returned: limit, truncated: true })
      // Totals are never truncated with the details.
      expect(capped.totals.suspected.total).toBe(1170)
      expect(capped.totals.adjustedEstimate.total).toBe(99)
    }
    expect((await app.inject({ method: 'GET', url: `${url}&limit=1` })).json().bursts[0]).toEqual({ sourceId: 'source', product: 'ChatGPT', landingPathNormalized: '/a2', tsHour: hour(1), counts: { total: 300, paid: 0, organic: 300, unknown: 0 } })
  })

  it('includes the first UTC hour of startDate and excludes the hour before it', async () => {
    row({ tsHour: '2026-07-31T23:00:00.000Z', sessionsOrHits: 500, paidSessionsOrHits: 0, organicSessionsOrHits: 500 })
    row({ tsHour: '2026-08-01T00:00:00.000Z', sessionsOrHits: 7, paidSessionsOrHits: 0, organicSessionsOrHits: 7 })
    const result = (await app.inject({ method: 'GET', url })).json()
    expect(result.totals.raw).toEqual({ total: 7, paid: 0, organic: 7, unknown: 0 })
    expect(result.totals.suspected.total).toBe(0)
    expect(result.bursts).toEqual([])
  })

  it('accepts a 366-day window and rejects a 367-day window', async () => {
    const base = '/api/v1/projects/example/traffic/referral-assessment'
    const accepted = await app.inject({ method: 'GET', url: `${base}?startDate=2025-09-01&endDate=2026-09-01` })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().window).toEqual({ startDate: '2025-09-01', endDate: '2026-09-01', timeZone: 'UTC' })
    const rejected = await app.inject({ method: 'GET', url: `${base}?startDate=2025-08-31&endDate=2026-09-01` })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })

  it.each(['burstThreshold=0', 'burstThreshold=1.5', 'ratioThreshold=0', 'limit=0', 'propertyId=property', 'targetId=target', 'marketKey=market'])('rejects unsupported or invalid selection %s', async (query) => {
    expect((await app.inject({ method: 'GET', url: `${url}&${query}` })).statusCode).toBe(400)
  })

  it.each([
    'startDate=2026-02-30&endDate=2026-03-01',
    'startDate=2026-08-02&endDate=2026-08-01',
    'startDate=2024-01-01&endDate=2026-01-01',
  ])('rejects invalid date windows %s', async (query) => {
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/example/traffic/referral-assessment?${query}` })).statusCode).toBe(400)
  })
})
