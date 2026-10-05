import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  VerificationStatuses,
  trafficAnalyticsResponseSchema,
  type TrafficAnalyticsResponse,
  type TrafficEventsResponse,
} from '@ainyc/canonry-contracts'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  apiKeys,
  crawlerEventsHourly,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  trafficSources,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { hashApiKey } from '../src/auth.js'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-10-05T12:00:00.000Z'
const DAY_MS = 86_400_000
const READ_KEY = 'cnry_traffic_analytics_reader'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString()
}

function seedProject(name: string): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.example`,
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

function seedKey(raw: string, projectId?: string): void {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: raw, keyHash: hashApiKey(raw),
    keyPrefix: raw.slice(0, 9), scopes: ['read'], projectId: projectId ?? null, createdAt: NOW,
  }).run()
}

function seedSource(projectId: string, archived = false): string {
  const id = crypto.randomUUID()
  db.insert(trafficSources).values({
    id, projectId, sourceType: TrafficSourceTypes['cloud-run'], displayName: 'Stored traffic',
    status: archived ? TrafficSourceStatuses.archived : TrafficSourceStatuses.connected,
    configJson: {}, archivedAt: archived ? NOW : null, createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

function crawlerRow(projectId: string, sourceId: string, overrides: Partial<typeof crawlerEventsHourly.$inferInsert> = {}): typeof crawlerEventsHourly.$inferInsert {
  return {
    projectId, sourceId, tsHour: daysAgo(1), botId: 'gptbot', operator: 'OpenAI',
    verificationStatus: VerificationStatuses.verified, pathNormalized: '/blog', status: 200,
    hits: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

function seedCrawler(projectId: string, sourceId: string, overrides: Partial<typeof crawlerEventsHourly.$inferInsert> = {}): void {
  db.insert(crawlerEventsHourly).values(crawlerRow(projectId, sourceId, overrides)).run()
}

function seedUserFetch(projectId: string, sourceId: string, overrides: Partial<typeof aiUserFetchEventsHourly.$inferInsert> = {}): void {
  db.insert(aiUserFetchEventsHourly).values({
    projectId, sourceId, tsHour: daysAgo(1), botId: 'chatgpt-user', operator: 'OpenAI',
    verificationStatus: VerificationStatuses.claimed_unverified, pathNormalized: '/blog', status: 200,
    hits: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  }).run()
}

function referralRow(projectId: string, sourceId: string, overrides: Partial<typeof aiReferralEventsHourly.$inferInsert> = {}): typeof aiReferralEventsHourly.$inferInsert {
  return {
    projectId, sourceId, tsHour: daysAgo(1), product: 'ChatGPT', operator: 'OpenAI',
    sourceDomain: 'chatgpt.com', evidenceType: 'utm', landingPathNormalized: '/landing', status: 200,
    sessionsOrHits: 1, paidSessionsOrHits: 0, organicSessionsOrHits: 0,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

function seedReferral(projectId: string, sourceId: string, overrides: Partial<typeof aiReferralEventsHourly.$inferInsert> = {}): void {
  db.insert(aiReferralEventsHourly).values(referralRow(projectId, sourceId, overrides)).run()
}

async function readAnalytics(name: string, period?: number): Promise<TrafficAnalyticsResponse> {
  const response = await app.inject({
    method: 'GET', url: `/api/v1/projects/${name}/traffic/analytics${period === undefined ? '' : `?period=${period}`}`,
    headers: { authorization: `Bearer ${READ_KEY}` },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json<TrafficAnalyticsResponse>()
  expect(trafficAnalyticsResponseSchema.parse(body)).toEqual(body)
  return body
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-analytics-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey(READ_KEY)
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('GET /projects/:name/traffic/analytics', () => {
  test.each([false, true])('no active traffic source returns null (archived: %s)', async archived => {
    const projectId = seedProject('no-source')
    if (archived) {
      const sourceId = seedSource(projectId, true)
      seedCrawler(projectId, sourceId, { hits: 100 })
    }
    expect(await readAnalytics('no-source')).toEqual({ activity: null })
  })

  test('a connected source without events preserves zero counts and empty breakdowns', async () => {
    seedSource(seedProject('connected'))
    const { activity } = await readAnalytics('connected')
    const zero = { current: 0, prior: 0, deltaPct: null }
    expect(activity).toEqual({
      windowStart: daysAgo(30), windowEnd: NOW, hasData: false,
      verifiedCrawlerHits: zero, unverifiedCrawlerHits: zero, aiUserFetchHits: zero,
      referralArrivals: zero, referralRedirects: 0,
      referralArrivalsByClass: { paid: zero, organic: zero, unclassified: zero },
      referralArrivalsClassSummary: '', byOperator: [], topCrawledPaths: [],
      referralProducts: [], dailyTrend: [], topReferralLandingPaths: [],
    })
  })

  test.each([7, 14, 30, 90])('period=%s selects that exact window and its equal-length prior', async period => {
    const projectId = seedProject('window')
    const sourceId = seedSource(projectId)
    seedCrawler(projectId, sourceId, { tsHour: daysAgo(period - 1), hits: 10 })
    seedCrawler(projectId, sourceId, { tsHour: daysAgo(period + 1), hits: 5 })
    const { activity } = await readAnalytics('window', period)
    expect(activity!.windowStart).toBe(daysAgo(period))
    expect(activity!.windowEnd).toBe(NOW)
    expect(activity!.verifiedCrawlerHits).toEqual({ current: 10, prior: 5, deltaPct: 100 })
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.verifiedCrawlerHits, 0)).toBe(10)
  })

  test('more than 5000 hourly detail rows contribute to every aggregate before ranking', async () => {
    const projectId = seedProject('large-history')
    const sourceId = seedSource(projectId)
    // 600 observed hours × 10 paths: realistic hourly rows across a 25-day window.
    db.transaction(() => {
      for (let hour = 1; hour <= 600; hour++) {
        const tsHour = new Date(Date.parse(NOW) - hour * 3_600_000).toISOString()
        const crawlers = Array.from({ length: 10 }, (_, index) => crawlerRow(projectId, sourceId, {
          tsHour, pathNormalized: `/page-${index}`,
          operator: ['OpenAI', 'Anthropic', 'Google'][index % 3]!,
          verificationStatus: index % 2 === 0 ? VerificationStatuses.verified : VerificationStatuses.claimed_unverified,
        }))
        const referrals = Array.from({ length: 10 }, (_, index) => referralRow(projectId, sourceId, {
          tsHour, landingPathNormalized: `/page-${index}`,
          product: index % 2 === 0 ? 'ChatGPT' : 'Claude',
          operator: index % 2 === 0 ? 'OpenAI' : 'Anthropic',
          sourceDomain: index % 2 === 0 ? 'chatgpt.com' : 'claude.ai',
          paidSessionsOrHits: index % 3 === 0 ? 1 : 0,
          organicSessionsOrHits: index % 3 === 1 ? 1 : 0,
        }))
        db.insert(crawlerEventsHourly).values(crawlers).run()
        db.insert(aiReferralEventsHourly).values(referrals).run()
      }
    })
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/large-history/traffic/events?kind=crawler&limit=5000&since=${daysAgo(30)}`,
      headers: { authorization: `Bearer ${READ_KEY}` },
    })
    expect(detail.statusCode).toBe(200)
    const details = detail.json<TrafficEventsResponse>()
    expect(details.eventRows).toEqual({ total: 6000, returned: 5000, truncated: true })

    const { activity } = await readAnalytics('large-history')
    expect(activity!.verifiedCrawlerHits).toEqual({ current: 3000, prior: 0, deltaPct: null })
    expect(activity!.unverifiedCrawlerHits).toEqual({ current: 3000, prior: 0, deltaPct: null })
    expect(activity!.referralArrivals.current).toBe(6000)
    expect(activity!.byOperator).toEqual([
      { operator: 'OpenAI', verifiedHits: 1200, unverifiedHits: 1200, userFetchHits: 0, referralArrivals: 3000, deltaPct: null },
      { operator: 'Google', verifiedHits: 1200, unverifiedHits: 600, userFetchHits: 0, referralArrivals: 0, deltaPct: null },
      { operator: 'Anthropic', verifiedHits: 600, unverifiedHits: 1200, userFetchHits: 0, referralArrivals: 3000, deltaPct: null },
    ])
    expect(activity!.topCrawledPaths).toHaveLength(10)
    for (let index = 0; index < 10; index++) {
      expect(activity!.topCrawledPaths.find(row => row.path === `/page-${index}`)).toEqual({
        path: `/page-${index}`, verifiedHits: index % 2 === 0 ? 600 : 0,
        unverifiedHits: index % 2 === 1 ? 600 : 0, distinctOperators: 1,
      })
      expect(activity!.topReferralLandingPaths.find(row => row.path === `/page-${index}`)).toEqual({
        path: `/page-${index}`, arrivals: 600, distinctProducts: 1,
      })
    }
    expect(activity!.referralProducts.slice().sort((a, b) => a.product.localeCompare(b.product))).toEqual([
      { product: 'ChatGPT', arrivals: 3000, distinctLandingPaths: 5 },
      { product: 'Claude', arrivals: 3000, distinctLandingPaths: 5 },
    ])
    expect(activity!.referralArrivalsByClass).toEqual({
      paid: { current: 2400, prior: 0, deltaPct: null },
      organic: { current: 1800, prior: 0, deltaPct: null },
      unclassified: { current: 1800, prior: 0, deltaPct: null },
    })
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.verifiedCrawlerHits, 0)).toBe(3000)
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.unverifiedCrawlerHits, 0)).toBe(3000)
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.referralArrivals, 0)).toBe(6000)
  })

  test('adjacent windows count their shared boundary once and exclude older or future evidence', async () => {
    const projectId = seedProject('boundaries')
    const sourceId = seedSource(projectId)
    const start = daysAgo(7)
    const priorStart = daysAgo(14)
    const immediatelyBefore = new Date(Date.parse(start) - 1).toISOString()
    for (const [tsHour, hits] of [[NOW, 2], [start, 10], [priorStart, 3], [immediatelyBefore, 3], [daysAgo(15), 1000], [daysAgo(-1), 1000]] as const) {
      seedCrawler(projectId, sourceId, { tsHour, hits })
    }
    seedCrawler(projectId, sourceId, { tsHour: start, hits: 6, verificationStatus: VerificationStatuses.claimed_unverified })
    seedCrawler(projectId, sourceId, { tsHour: immediatelyBefore, hits: 3, verificationStatus: VerificationStatuses.claimed_unverified })
    seedUserFetch(projectId, sourceId, { tsHour: start, hits: 2 })
    seedUserFetch(projectId, sourceId, { tsHour: priorStart, hits: 4 })
    for (const tsHour of [NOW, start, priorStart]) {
      seedReferral(projectId, sourceId, { tsHour, sessionsOrHits: 9, paidSessionsOrHits: 3, organicSessionsOrHits: 4 })
    }
    const { activity } = await readAnalytics('boundaries', 7)
    expect(activity!.verifiedCrawlerHits).toEqual({ current: 12, prior: 6, deltaPct: 100 })
    expect(activity!.unverifiedCrawlerHits).toEqual({ current: 6, prior: 3, deltaPct: 100 })
    expect(activity!.aiUserFetchHits).toEqual({ current: 2, prior: 4, deltaPct: -50 })
    expect(activity!.referralArrivals).toEqual({ current: 18, prior: 9, deltaPct: 100 })
    expect(activity!.referralArrivalsByClass).toEqual({
      paid: { current: 6, prior: 3, deltaPct: 100 },
      organic: { current: 8, prior: 4, deltaPct: 100 },
      unclassified: { current: 4, prior: 2, deltaPct: 100 },
    })
    expect(activity!.byOperator).toEqual([
      { operator: 'OpenAI', verifiedHits: 12, unverifiedHits: 6, userFetchHits: 2, referralArrivals: 18, deltaPct: 100 },
    ])
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.verifiedCrawlerHits, 0)).toBe(12)
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.userFetchHits, 0)).toBe(2)
    expect(activity!.dailyTrend.reduce((sum, day) => sum + day.referralArrivals, 0)).toBe(18)
  })

  test('claimed and unknown crawler identities stay separate from verified hits in ranked paths', async () => {
    const projectId = seedProject('crawler-trust')
    const sourceId = seedSource(projectId)
    seedCrawler(projectId, sourceId, { pathNormalized: '/verified', hits: 30 })
    seedCrawler(projectId, sourceId, { pathNormalized: '/claimed', hits: 50, verificationStatus: VerificationStatuses.claimed_unverified })
    seedCrawler(projectId, sourceId, { pathNormalized: '/unknown', hits: 7, operator: 'Other', verificationStatus: VerificationStatuses.unknown_ai_like })
    const { activity } = await readAnalytics('crawler-trust')
    expect(activity!.verifiedCrawlerHits.current).toBe(30)
    expect(activity!.unverifiedCrawlerHits.current).toBe(57)
    expect(activity!.topCrawledPaths).toEqual([
      { path: '/claimed', verifiedHits: 0, unverifiedHits: 50, distinctOperators: 1 },
      { path: '/verified', verifiedHits: 30, unverifiedHits: 0, distinctOperators: 1 },
      { path: '/unknown', verifiedHits: 0, unverifiedHits: 7, distinctOperators: 1 },
    ])
    expect(activity!.byOperator.find(row => row.operator === 'Other')).toEqual({
      operator: 'Other', verifiedHits: 0, unverifiedHits: 7, userFetchHits: 0, referralArrivals: 0, deltaPct: null,
    })
  })

  test('landed referrals exclude only Location redirects and subresources, with independent class counts', async () => {
    const projectId = seedProject('referral-signals')
    const sourceId = seedSource(projectId)
    const arrivals = [
      { status: 200, sessionsOrHits: 10, paidSessionsOrHits: 3, organicSessionsOrHits: 5 },
      { status: 304, sessionsOrHits: 4, organicSessionsOrHits: 4 },
      { status: 300, sessionsOrHits: 1 },
      { status: 404, sessionsOrHits: 2, paidSessionsOrHits: 2 },
      { status: 500, sessionsOrHits: 3, organicSessionsOrHits: 3 },
      { status: 299, sessionsOrHits: 1 },
      { status: 400, sessionsOrHits: 2 },
    ]
    arrivals.forEach((row, index) => seedReferral(projectId, sourceId, { ...row, landingPathNormalized: `/landing-${index}` }))
    for (const status of [301, 302, 303, 307, 308]) {
      seedReferral(projectId, sourceId, { status, sessionsOrHits: 7, paidSessionsOrHits: 7, landingPathNormalized: `/hop-${status}` })
    }
    seedReferral(projectId, sourceId, { landingPathNormalized: '/_next/static/app.js', sessionsOrHits: 100, organicSessionsOrHits: 100 })
    seedReferral(projectId, sourceId, { landingPathNormalized: '/favicon.svg', status: 301, sessionsOrHits: 100, paidSessionsOrHits: 100 })
    const { activity } = await readAnalytics('referral-signals')
    expect(activity!.referralArrivals).toEqual({ current: 23, prior: 0, deltaPct: null })
    expect(activity!.referralRedirects).toBe(35)
    expect(activity!.referralArrivalsByClass).toEqual({
      paid: { current: 5, prior: 0, deltaPct: null },
      organic: { current: 12, prior: 0, deltaPct: null },
      unclassified: { current: 6, prior: 0, deltaPct: null },
    })
    expect(activity!.referralArrivalsClassSummary).toBe('Paid 5 · Organic 12 · Unclassified 6')
    expect(activity!.referralProducts).toEqual([{ product: 'ChatGPT', arrivals: 23, distinctLandingPaths: 7 }])
    expect(activity!.topReferralLandingPaths.reduce((sum, row) => sum + row.arrivals, 0)).toBe(23)
    expect(activity!.dailyTrend).toEqual([{ date: daysAgo(1).slice(0, 10), verifiedCrawlerHits: 0, unverifiedCrawlerHits: 0, userFetchHits: 0, referralArrivals: 23 }])
    expect(activity!.byOperator[0]!.referralArrivals).toBe(23)
  })

  test('redirect-only evidence remains data with zero landed arrivals', async () => {
    const projectId = seedProject('only-hops')
    seedReferral(projectId, seedSource(projectId), { status: 301, sessionsOrHits: 120 })
    const { activity } = await readAnalytics('only-hops')
    expect(activity!.hasData).toBe(true)
    expect(activity!.referralRedirects).toBe(120)
    expect(activity!.referralArrivals.current).toBe(0)
    expect(activity!.referralProducts).toEqual([])
    expect(activity!.topReferralLandingPaths).toEqual([])
  })

  test.each([false, true])('project traffic remains available and isolated for Simple/Advanced (Advanced: %s)', async advanced => {
    const projectId = seedProject('portfolio')
    if (advanced) {
      const plan = measurementPlanV2Fixture()
      const versionId = crypto.randomUUID()
      db.insert(measurementPlanVersions).values({
        id: versionId, projectId, revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan),
        checksum: 'a'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW,
      }).run()
      db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
    }
    seedCrawler(projectId, seedSource(projectId), { hits: 17 })
    const sibling = seedProject('sibling')
    seedCrawler(sibling, seedSource(sibling), { hits: 999 })
    const { activity } = await readAnalytics('portfolio')
    expect(activity!.verifiedCrawlerHits.current).toBe(17)
    expect(activity!.topCrawledPaths).toEqual([{ path: '/blog', verifiedHits: 17, unverifiedHits: 0, distinctOperators: 1 }])
  })

  test('stored analytics allow a project-scoped reader and deny unauthenticated or sibling reads', async () => {
    const projectId = seedProject('owned')
    seedCrawler(projectId, seedSource(projectId), { hits: 7 })
    seedProject('foreign')
    const scopedKey = 'cnry_traffic_analytics_scoped'
    seedKey(scopedKey, projectId)
    const owned = await app.inject({ method: 'GET', url: '/api/v1/projects/owned/traffic/analytics', headers: { authorization: `Bearer ${scopedKey}` } })
    expect(owned.statusCode).toBe(200)
    expect(owned.json<TrafficAnalyticsResponse>().activity!.verifiedCrawlerHits.current).toBe(7)
    const foreign = await app.inject({ method: 'GET', url: '/api/v1/projects/foreign/traffic/analytics', headers: { authorization: `Bearer ${scopedKey}` } })
    expect(foreign.statusCode).toBe(403)
    expect(foreign.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN')
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/projects/owned/traffic/analytics' })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED')
  })

  test('unknown projects and invalid periods return structured errors', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/projects/missing/traffic/analytics', headers: { authorization: `Bearer ${READ_KEY}` } })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND')
    seedProject('invalid-period')
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/projects/invalid-period/traffic/analytics?period=31', headers: { authorization: `Bearer ${READ_KEY}` } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR')
  })

  test.each(['report', 'report.html'])('the retired %s endpoint is absent', async suffix => {
    seedProject('retired-report')
    const response = await app.inject({
      method: 'GET', url: `/api/v1/projects/retired-report/${suffix}`,
      headers: { authorization: `Bearer ${READ_KEY}` },
    })
    expect(response.statusCode).toBe(404)
  })

  test('analytics register under a configured reverse-proxy base path', async () => {
    const projectId = seedProject('prefixed')
    seedCrawler(projectId, seedSource(projectId), { hits: 11 })
    const prefixedApp = Fastify()
    prefixedApp.register(apiRoutes, { db, routePrefix: '/canonry/api/v1' })
    try {
      await prefixedApp.ready()
      const response = await prefixedApp.inject({
        method: 'GET', url: '/canonry/api/v1/projects/prefixed/traffic/analytics',
        headers: { authorization: `Bearer ${READ_KEY}` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json<TrafficAnalyticsResponse>().activity!.verifiedCrawlerHits.current).toBe(11)
    } finally {
      await prefixedApp.close()
    }
  })
})
