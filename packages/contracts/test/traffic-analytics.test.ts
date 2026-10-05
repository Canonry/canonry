import { describe, expect, it } from 'vitest'
import {
  TRAFFIC_ANALYTICS_DEFAULT_PERIOD_DAYS,
  TRAFFIC_ANALYTICS_PERIOD_OPTIONS,
  parseTrafficAnalyticsPeriod,
  trafficAnalyticsPeriodSchema,
  trafficAnalyticsResponseSchema,
  type TrafficActivitySummary,
} from '../src/traffic-analytics.js'

describe('traffic analytics period', () => {
  it('defaults omitted input to 30 days', () => {
    expect(TRAFFIC_ANALYTICS_DEFAULT_PERIOD_DAYS).toBe(30)
    for (const input of [undefined, null, '']) {
      expect(parseTrafficAnalyticsPeriod(input)).toBe(30)
    }
  })

  it('accepts each supported period as a number or a query-string value', () => {
    expect(TRAFFIC_ANALYTICS_PERIOD_OPTIONS).toEqual([7, 14, 30, 90])
    for (const period of TRAFFIC_ANALYTICS_PERIOD_OPTIONS) {
      expect(parseTrafficAnalyticsPeriod(period)).toBe(period)
      expect(parseTrafficAnalyticsPeriod(String(period))).toBe(period)
      expect(trafficAnalyticsPeriodSchema.parse(period)).toBe(period)
    }
  })

  it('rejects unsupported periods with the public validation error', () => {
    for (const input of ['15', '0', '-7', 'abc', '30.5', ' ', 31, 8, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseTrafficAnalyticsPeriod(input)).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: '"period" must be one of 7, 14, 30, 90',
        }),
      )
      expect(trafficAnalyticsPeriodSchema.safeParse(input).success).toBe(false)
    }
  })
})

describe('traffic analytics response', () => {
  it('preserves separate crawler tiers, user fetches, session classes, redirects, and breakdowns', () => {
    const activity: TrafficActivitySummary = {
      windowStart: '2026-09-05T12:00:00.000Z',
      windowEnd: '2026-10-05T12:00:00.000Z',
      coverageStart: '2026-08-01T12:00:00.000Z',
      priorWindowComplete: true,
      hasData: true,
      verifiedCrawlerHits: { current: 6, prior: 4, deltaPct: 50 },
      unverifiedCrawlerHits: { current: 2, prior: 4, deltaPct: -50 },
      aiUserFetchHits: { current: 3, prior: 0, deltaPct: null },
      referralArrivals: { current: 4, prior: 2, deltaPct: 100 },
      referralRedirects: 1,
      referralArrivalsByClass: {
        paid: { current: 1, prior: 0, deltaPct: null },
        organic: { current: 2, prior: 2, deltaPct: 0 },
        unclassified: { current: 1, prior: 0, deltaPct: null },
      },
      referralArrivalsClassSummary: 'Paid 1 · Organic 2 · Unclassified 1',
      byOperator: [{ operator: 'OpenAI', verifiedHits: 6, unverifiedHits: 2, userFetchHits: 3, referralArrivals: 4, deltaPct: 50 }],
      topCrawledPaths: [{ path: '/guide', verifiedHits: 6, unverifiedHits: 2, distinctOperators: 1 }],
      referralProducts: [{ product: 'ChatGPT', arrivals: 4, distinctLandingPaths: 1 }],
      dailyTrend: [{ date: '2026-10-05', verifiedCrawlerHits: 6, unverifiedCrawlerHits: 2, userFetchHits: 3, referralArrivals: 4 }],
      topReferralLandingPaths: [{ path: '/guide', arrivals: 4, distinctProducts: 1 }],
    }

    expect(trafficAnalyticsResponseSchema.parse({ activity })).toEqual({ activity })
    expect(trafficAnalyticsResponseSchema.parse({ activity: { ...activity, coverageStart: null, priorWindowComplete: false } }).activity).toMatchObject({ coverageStart: null, priorWindowComplete: false })
    const { coverageStart: _coverageStart, priorWindowComplete: _priorWindowComplete, ...withoutCoverage } = activity
    expect(trafficAnalyticsResponseSchema.safeParse({ activity: withoutCoverage }).success).toBe(false)
  })

  it('uses null to represent no connected source, while requiring the activity field', () => {
    expect(trafficAnalyticsResponseSchema.parse({ activity: null })).toEqual({ activity: null })
    expect(trafficAnalyticsResponseSchema.safeParse({}).success).toBe(false)
  })
})
