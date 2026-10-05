import { and, desc, eq, gte, lt, lte, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { aiReferralEventsHourly, aiUserFetchEventsHourly, crawlerEventsHourly, trafficSources, type DatabaseClient } from '@ainyc/canonry-db'
import {
  aiReferralClassCounts,
  deltaPercent,
  formatAiReferralClassSummary,
  parseTrafficAnalyticsPeriod,
  TrafficSourceStatuses,
  VerificationStatuses,
  type TrafficActivitySummary,
  type TrafficAnalyticsResponse,
} from '@ainyc/canonry-contracts'
import { countableReferralCondition, nonSubresourceReferralPathCondition } from './ai-referral-status.js'
import { resolveProject } from './helpers.js'

const SERVER_ACTIVITY_TOP_PATHS_LIMIT = 10

function readTrafficActivity(db: DatabaseClient, projectId: string, windowDays: number): TrafficActivitySummary | null {
  // 1. Bail if no traffic source is connected at all.
  // Treat archived sources as "not connected" — we don't want to surface
  // historical data for a host migration the user has moved past.
  const sourceRows = db
    .select({ id: trafficSources.id })
    .from(trafficSources)
    .where(
      and(
        eq(trafficSources.projectId, projectId),
        ne(trafficSources.status, TrafficSourceStatuses.archived),
      ),
    )
    .all()
  if (sourceRows.length === 0) return null

  const now = new Date()
  const headlineEnd = now.toISOString()
  // Uniform window: the headline + daily trend span the selected window, and
  // the prior comparison covers the equal-length window immediately before it.
  const headlineStartMs = now.getTime() - windowDays * 24 * 60 * 60_000
  const priorStartMs = headlineStartMs - windowDays * 24 * 60 * 60_000
  const trendStartMs = headlineStartMs

  const headlineStart = new Date(headlineStartMs).toISOString()
  const priorStart = new Date(priorStartMs).toISOString()
  const trendStart = new Date(trendStartMs).toISOString()

  // 2. Headline + prior totals (verified crawlers + referral sessions).
  // The headline upper bound uses `lte` (inclusive) so the current hour bucket
  // counts. The prior upper bound uses `lt` (strict) against `headlineStart` so a
  // row with `tsHour` exactly equal to the boundary lands in the headline window
  // only — never both. Latent double-count if `now` aligned to an hour exactly.
  const sumVerifiedCrawlers = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, projectId),
            eq(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(crawlerEventsHourly.tsHour, windowEndIso)
              : lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  const sumUnverifiedCrawlers = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, projectId),
            ne(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(crawlerEventsHourly.tsHour, windowEndIso)
              : lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  // Returns the window's referral sessions split by traffic class. `unknown` is
  // the residual for rows ingested before the classifier shipped; it must never
  // be folded into `organic`, which would report a client's ad clicks as earned
  // AI traffic.
  const sumReferrals = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) => {
    const row = db
      .select({
        total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
        paid: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.paidSessionsOrHits}), 0)`,
        organic: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.organicSessionsOrHits}), 0)`,
      })
      .from(aiReferralEventsHourly)
      .where(
        and(
          eq(aiReferralEventsHourly.projectId, projectId),
          countableReferralCondition(),
          gte(aiReferralEventsHourly.tsHour, windowStartIso),
          exclusiveEnd
            ? lt(aiReferralEventsHourly.tsHour, windowEndIso)
            : lte(aiReferralEventsHourly.tsHour, windowEndIso),
        ),
      )
      .get()
    return aiReferralClassCounts(Number(row?.total ?? 0), Number(row?.paid ?? 0), Number(row?.organic ?? 0))
  }

  // User-fetch hits roll verified + unverified together. For crawlers we
  // split because IP-range confirmation is the trust signal; for user-fetch
  // the operational question is "is an AI surface reading this page on
  // behalf of a real user, yes or no?", so verification matters less.
  const sumUserFetches = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
        .from(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.projectId, projectId),
            gte(aiUserFetchEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(aiUserFetchEventsHourly.tsHour, windowEndIso)
              : lte(aiUserFetchEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  const verifiedCurrent = sumVerifiedCrawlers(headlineStart, headlineEnd)
  const verifiedPrior = sumVerifiedCrawlers(priorStart, headlineStart, true)
  const unverifiedCurrent = sumUnverifiedCrawlers(headlineStart, headlineEnd)
  const unverifiedPrior = sumUnverifiedCrawlers(priorStart, headlineStart, true)
  const userFetchCurrent = sumUserFetches(headlineStart, headlineEnd)
  const userFetchPrior = sumUserFetches(priorStart, headlineStart, true)
  const referralCurrent = sumReferrals(headlineStart, headlineEnd)
  // Arrivals blocked by a redirect in the current window, derived as
  // (all non-subresource hits) - (landed hits) so the redirect band lives in
  // exactly one place, including projects with redirects but no arrivals.
  const referralAllCurrent = Number(
    db
      .select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` })
      .from(aiReferralEventsHourly)
      .where(
        and(
          eq(aiReferralEventsHourly.projectId, projectId),
          nonSubresourceReferralPathCondition(),
          gte(aiReferralEventsHourly.tsHour, headlineStart),
          lte(aiReferralEventsHourly.tsHour, headlineEnd),
        ),
      )
      .get()?.total ?? 0,
  )
  const referralRedirects = Math.max(0, referralAllCurrent - referralCurrent.total)
  const referralPrior = sumReferrals(priorStart, headlineStart, true)

  // 3. Per-operator: verified hits, unverified hits, referral sessions over headline window.
  const crawlerByOperatorRows = db
    .select({
      operator: crawlerEventsHourly.operator,
      verificationStatus: crawlerEventsHourly.verificationStatus,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        gte(crawlerEventsHourly.tsHour, headlineStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(crawlerEventsHourly.operator, crawlerEventsHourly.verificationStatus)
    .all()

  // Prior window covers BOTH verification tiers, because the current-window
  // aggregate it is compared against does. Filtering only one side made the
  // delta compare a verified-only present to a verified-only past and then
  // print it on a row whose other cells are combined.
  const crawlerByOperatorPriorRows = db
    .select({
      operator: crawlerEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        gte(crawlerEventsHourly.tsHour, priorStart),
        lt(crawlerEventsHourly.tsHour, headlineStart),
      ),
    )
    .groupBy(crawlerEventsHourly.operator)
    .all()

  const referralByOperatorRows = db
    .select({
      operator: aiReferralEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        countableReferralCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.operator)
    .all()

  const userFetchByOperatorRows = db
    .select({
      operator: aiUserFetchEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
    })
    .from(aiUserFetchEventsHourly)
    .where(
      and(
        eq(aiUserFetchEventsHourly.projectId, projectId),
        gte(aiUserFetchEventsHourly.tsHour, headlineStart),
        lte(aiUserFetchEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiUserFetchEventsHourly.operator)
    .all()

  const operatorAgg = new Map<string, {
    verified: number; unverified: number; userFetch: number; referrals: number; prior: number
  }>()
  const ensureOp = (op: string) => {
    let entry = operatorAgg.get(op)
    if (!entry) {
      entry = { verified: 0, unverified: 0, userFetch: 0, referrals: 0, prior: 0 }
      operatorAgg.set(op, entry)
    }
    return entry
  }
  for (const r of crawlerByOperatorRows) {
    const entry = ensureOp(r.operator)
    if (r.verificationStatus === VerificationStatuses.verified) entry.verified += Number(r.hits)
    else entry.unverified += Number(r.hits)
  }
  for (const r of crawlerByOperatorPriorRows) {
    ensureOp(r.operator).prior += Number(r.hits)
  }
  for (const r of userFetchByOperatorRows) {
    ensureOp(r.operator).userFetch += Number(r.hits)
  }
  for (const r of referralByOperatorRows) {
    ensureOp(r.operator).referrals += Number(r.hits)
  }

  const byOperator = [...operatorAgg.entries()]
    .map(([operator, v]) => ({
      operator,
      verifiedHits: v.verified,
      unverifiedHits: v.unverified,
      userFetchHits: v.userFetch,
      referralArrivals: v.referrals,
      deltaPct: deltaPercent(v.verified + v.unverified, v.prior),
    }))
    // Sort by total signal: verified hits first, then user-fetch, then unverified and referrals.
    .sort((a, b) =>
      b.verifiedHits - a.verifiedHits ||
      b.userFetchHits - a.userFetchHits ||
      b.unverifiedHits - a.unverifiedHits ||
      b.referralArrivals - a.referralArrivals,
    )

  // 4. Top crawled paths, both verification tiers. Verification needs a client
  // IP to match against the operator's published ranges, and some log sources
  // never carry one (Vercel request logs), so a verified-only table renders
  // empty for those projects while the headline tile above shows thousands of
  // hits. The split is a display attribute, not a filter.
  const topPathsRows = db
    .select({
      path: crawlerEventsHourly.pathNormalized,
      verifiedHits: sql<number>`COALESCE(SUM(CASE WHEN ${crawlerEventsHourly.verificationStatus} = ${VerificationStatuses.verified} THEN ${crawlerEventsHourly.hits} ELSE 0 END), 0)`,
      unverifiedHits: sql<number>`COALESCE(SUM(CASE WHEN ${crawlerEventsHourly.verificationStatus} <> ${VerificationStatuses.verified} THEN ${crawlerEventsHourly.hits} ELSE 0 END), 0)`,
      operators: sql<number>`COUNT(DISTINCT ${crawlerEventsHourly.operator})`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        gte(crawlerEventsHourly.tsHour, headlineStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(crawlerEventsHourly.pathNormalized)
    .orderBy(desc(sql`SUM(${crawlerEventsHourly.hits})`))
    .limit(SERVER_ACTIVITY_TOP_PATHS_LIMIT)
    .all()
  const topCrawledPaths = topPathsRows.map(r => ({
    path: r.path,
    verifiedHits: Number(r.verifiedHits),
    unverifiedHits: Number(r.unverifiedHits),
    distinctOperators: Number(r.operators),
  }))

  // 5. AI products that sent referrals + their distinct landing pages.
  const referralProductsRows = db
    .select({
      product: aiReferralEventsHourly.product,
      arrivals: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
      landingPaths: sql<number>`COUNT(DISTINCT ${aiReferralEventsHourly.landingPathNormalized})`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        countableReferralCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.product)
    .orderBy(desc(sql`SUM(${aiReferralEventsHourly.sessionsOrHits})`))
    .all()
  const referralProducts = referralProductsRows.map(r => ({
    product: r.product,
    arrivals: Number(r.arrivals),
    distinctLandingPaths: Number(r.landingPaths),
  }))

  // 6. Top referral landing paths (where humans actually land coming from AI products).
  const topReferralRows = db
    .select({
      path: aiReferralEventsHourly.landingPathNormalized,
      arrivals: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
      products: sql<number>`COUNT(DISTINCT ${aiReferralEventsHourly.product})`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        countableReferralCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.landingPathNormalized)
    .orderBy(desc(sql`SUM(${aiReferralEventsHourly.sessionsOrHits})`))
    .limit(SERVER_ACTIVITY_TOP_PATHS_LIMIT)
    .all()
  const topReferralLandingPaths = topReferralRows.map(r => ({
    path: r.path,
    arrivals: Number(r.arrivals),
    distinctProducts: Number(r.products),
  }))

  // 7. Daily trend (spans the selected window) — bucket tsHour to YYYY-MM-DD via SQLite SUBSTR.
  // Both tiers, for the same reason as the top-paths table: this is the only
  // crawler series, so on a source that cannot verify (Vercel
  // logs carry no client IP) a verified-only chart drew a flat zero line next
  // to a headline tile reporting thousands of hits.
  const crawlerTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${crawlerEventsHourly.tsHour}, 1, 10)`,
      verifiedHits: sql<number>`COALESCE(SUM(CASE WHEN ${crawlerEventsHourly.verificationStatus} = ${VerificationStatuses.verified} THEN ${crawlerEventsHourly.hits} ELSE 0 END), 0)`,
      unverifiedHits: sql<number>`COALESCE(SUM(CASE WHEN ${crawlerEventsHourly.verificationStatus} <> ${VerificationStatuses.verified} THEN ${crawlerEventsHourly.hits} ELSE 0 END), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        gte(crawlerEventsHourly.tsHour, trendStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${crawlerEventsHourly.tsHour}, 1, 10)`)
    .all()
  const referralTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${aiReferralEventsHourly.tsHour}, 1, 10)`,
      hits: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        countableReferralCondition(),
        gte(aiReferralEventsHourly.tsHour, trendStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${aiReferralEventsHourly.tsHour}, 1, 10)`)
    .all()

  const userFetchTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${aiUserFetchEventsHourly.tsHour}, 1, 10)`,
      hits: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
    })
    .from(aiUserFetchEventsHourly)
    .where(
      and(
        eq(aiUserFetchEventsHourly.projectId, projectId),
        gte(aiUserFetchEventsHourly.tsHour, trendStart),
        lte(aiUserFetchEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${aiUserFetchEventsHourly.tsHour}, 1, 10)`)
    .all()

  const emptyTrendEntry = () => ({ verifiedCrawlerHits: 0, unverifiedCrawlerHits: 0, userFetchHits: 0, referralArrivals: 0 })
  const dailyTrendMap = new Map<string, ReturnType<typeof emptyTrendEntry>>()
  for (const r of crawlerTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.verifiedCrawlerHits += Number(r.verifiedHits)
    e.unverifiedCrawlerHits += Number(r.unverifiedHits)
    dailyTrendMap.set(r.date, e)
  }
  for (const r of userFetchTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.userFetchHits += Number(r.hits)
    dailyTrendMap.set(r.date, e)
  }
  for (const r of referralTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.referralArrivals += Number(r.hits)
    dailyTrendMap.set(r.date, e)
  }
  const dailyTrend = [...dailyTrendMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    windowStart: headlineStart,
    windowEnd: headlineEnd,
    hasData: verifiedCurrent + unverifiedCurrent + userFetchCurrent + referralCurrent.total
      + verifiedPrior + unverifiedPrior + userFetchPrior + referralPrior.total
      + referralRedirects > 0
      || byOperator.length > 0
      || topCrawledPaths.length > 0
      || referralProducts.length > 0,
    verifiedCrawlerHits: {
      current: verifiedCurrent,
      prior: verifiedPrior,
      deltaPct: deltaPercent(verifiedCurrent, verifiedPrior),
    },
    unverifiedCrawlerHits: {
      current: unverifiedCurrent,
      prior: unverifiedPrior,
      deltaPct: deltaPercent(unverifiedCurrent, unverifiedPrior),
    },
    aiUserFetchHits: {
      current: userFetchCurrent,
      prior: userFetchPrior,
      deltaPct: deltaPercent(userFetchCurrent, userFetchPrior),
    },
    referralArrivals: {
      current: referralCurrent.total,
      prior: referralPrior.total,
      deltaPct: deltaPercent(referralCurrent.total, referralPrior.total),
    },
    referralRedirects,
    referralArrivalsByClass: {
      paid: {
        current: referralCurrent.paid,
        prior: referralPrior.paid,
        deltaPct: deltaPercent(referralCurrent.paid, referralPrior.paid),
      },
      organic: {
        current: referralCurrent.organic,
        prior: referralPrior.organic,
        deltaPct: deltaPercent(referralCurrent.organic, referralPrior.organic),
      },
      unclassified: {
        current: referralCurrent.unknown,
        prior: referralPrior.unknown,
        deltaPct: deltaPercent(referralCurrent.unknown, referralPrior.unknown),
      },
    },
    referralArrivalsClassSummary: formatAiReferralClassSummary(referralCurrent),
    byOperator,
    topCrawledPaths,
    referralProducts,
    dailyTrend,
    topReferralLandingPaths,
  }
}

export async function trafficAnalyticsRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: { period?: string } }>('/projects/:name/traffic/analytics', async request => {
    const periodDays = parseTrafficAnalyticsPeriod(request.query.period)
    const project = resolveProject(app.db, request.params.name)
    const response: TrafficAnalyticsResponse = { activity: readTrafficActivity(app.db, project.id, periodDays) }
    return response
  })
}
