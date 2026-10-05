import type { TrafficAnalyticsResponse } from '@ainyc/canonry-contracts'

export const TRAFFIC_ANALYTICS_FIXTURE: TrafficAnalyticsResponse = {
  activity: {
    windowStart: '2026-09-01T12:00:00.000Z',
    windowEnd: '2026-10-01T12:00:00.000Z',
    coverageStart: '2026-08-01T12:00:00.000Z',
    priorWindowComplete: true,
    hasData: true,
    verifiedCrawlerHits: { current: 501, prior: 400, deltaPct: 25.25 },
    unverifiedCrawlerHits: { current: 8, prior: 4, deltaPct: 100 },
    aiUserFetchHits: { current: 9, prior: 0, deltaPct: null },
    referralArrivals: { current: 17, prior: 10, deltaPct: 70 },
    referralRedirects: 3,
    referralArrivalsByClass: {
      paid: { current: 2, prior: 1, deltaPct: 100 },
      organic: { current: 10, prior: 6, deltaPct: 66.67 },
      unclassified: { current: 5, prior: 3, deltaPct: 66.67 },
    },
    referralArrivalsClassSummary: 'Paid 2 · Organic 10 · Unclassified 5',
    byOperator: [{ operator: 'OpenAI', verifiedHits: 501, unverifiedHits: 8, userFetchHits: 9, referralArrivals: 17, deltaPct: 25.25 }],
    topCrawledPaths: Array.from({ length: 501 }, (_, index) => ({ path: `/page-${index}`, verifiedHits: 1, unverifiedHits: 0, distinctOperators: 1 })),
    referralProducts: [{ product: 'ChatGPT', arrivals: 17, distinctLandingPaths: 1 }],
    dailyTrend: [{ date: '2026-09-01', verifiedCrawlerHits: 501, unverifiedCrawlerHits: 8, userFetchHits: 9, referralArrivals: 17 }],
    topReferralLandingPaths: [{ path: '/page-500', arrivals: 17, distinctProducts: 1 }],
  },
}
