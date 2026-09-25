import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, trafficSources, aiReferralEventsHourly, gaAiReferrals, measurementPlans, measurementPlanVersions } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const date = '2026-08-01T00:00:00.000Z'
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
    db.insert(gaAiReferrals).values({ id: 'ga', projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sessions: 10, users: 1, syncedAt: date }).run()
    const missing = (await app.inject({ method: 'GET', url })).json()
    expect(missing.comparison).toMatchObject({ serverObservation: 'missing', gaSessions: 10, observedRatio: null })
    row({ sessionsOrHits: 0, paidSessionsOrHits: 0, organicSessionsOrHits: 0 })
    const zero = (await app.inject({ method: 'GET', url })).json()
    expect(zero.comparison).toMatchObject({ serverObservation: 'observed-zero', gaSessions: 10, observedRatio: 0, status: 'unavailable' })
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
