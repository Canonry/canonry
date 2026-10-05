import { z } from 'zod'
import { validationError } from './errors.js'
import { percent } from './ratio-unit.js'

/** Stored server-activity windows supported by API, CLI, and MCP. */
export const TRAFFIC_ANALYTICS_PERIOD_OPTIONS = [7, 14, 30, 90] as const
export type TrafficAnalyticsPeriodDays = (typeof TRAFFIC_ANALYTICS_PERIOD_OPTIONS)[number]
export const TRAFFIC_ANALYTICS_DEFAULT_PERIOD_DAYS: TrafficAnalyticsPeriodDays = 30

export const trafficAnalyticsPeriodSchema = z
  .union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)])
  .describe('Traffic activity window in days (7, 14, 30, or 90). Defaults to 30 when omitted.')

/** Missing values use the default; unsupported values fail before reading evidence. */
export function parseTrafficAnalyticsPeriod(value: string | number | undefined | null): TrafficAnalyticsPeriodDays {
  if (value === undefined || value === null || value === '') return TRAFFIC_ANALYTICS_DEFAULT_PERIOD_DAYS
  const parsed = typeof value === 'number' ? value : Number(value)
  const result = trafficAnalyticsPeriodSchema.safeParse(parsed)
  if (!result.success) {
    throw validationError(`"period" must be one of ${TRAFFIC_ANALYTICS_PERIOD_OPTIONS.join(', ')}`)
  }
  return result.data
}

/** Count during the selected period, equal preceding period, and signed percent change. */
export const trafficActivityCountSchema = z.object({ current: z.number(), prior: z.number(), deltaPct: percent().nullable() })
export type TrafficActivityCount = z.infer<typeof trafficActivityCountSchema>

/** Full-window aggregates from stored crawler, user-fetch, and AI-referral evidence. */
export const trafficActivitySummarySchema = z.object({
  /** ISO8601 inclusive lower bound of the selected window (default: 30 days). */
  windowStart: z.string(),
  /** ISO8601 inclusive upper bound. */
  windowEnd: z.string(),
  hasData: z.boolean(),

  /** Verified crawler hits during the selected period and the equal preceding period. */
  verifiedCrawlerHits: trafficActivityCountSchema,
  /** Unverified crawler hits during the selected period, separate from verified hits. */
  unverifiedCrawlerHits: trafficActivityCountSchema,
  /**
   * On-demand per-user fetches during the selected period from AI surfaces (ChatGPT-User,
   * Perplexity-User, MistralAI-User). Disjoint from `verifiedCrawlerHits` /
   * `unverifiedCrawlerHits` — those measure bulk crawl; this measures human
   * users asking an AI to read a URL. Counts verified + unverified together
   * because the operational question for user-fetch is "is this happening?"
   * not "is this a confirmed bot identity?"
   */
  aiUserFetchHits: trafficActivityCountSchema,
  /**
   * AI-referral sessions during the selected period (sessionized from server-side request
   * evidence). Paid + organic + unclassified. Excludes subresource fetches and
   * requests answered with a Location redirect (301/302/303/307/308): a hop is
   * not an arrival, and its destination raises its own row. Redirect-answered
   * requests are reported separately in `referralRedirects`.
   */
  referralArrivals: trafficActivityCountSchema,
  /**
   * AI-referred requests in the current window that were answered with a
   * Location redirect instead of a page. Not arrivals — but a site where this
   * dominates has its AI traffic bouncing off a redirect before landing, which
   * is exactly the thing to fix, so the summary must show it rather
   * than render an empty section.
   */
  referralRedirects: z.number().int().nonnegative(),
  /**
   * `referralArrivals` split by traffic class. The three buckets sum to it.
   *
   * `unclassified` counts sessions ingested before the classifier shipped: the
   * UTM tags that carry paid-ness were never persisted, so those sessions can
   * never be resolved. Reporting them as organic would overstate earned AI
   * traffic by exactly a client's ad volume.
   */
  referralArrivalsByClass: z.object({
    paid: trafficActivityCountSchema,
    organic: trafficActivityCountSchema,
    unclassified: trafficActivityCountSchema,
  }),
  /** Pre-rendered one-line breakdown, e.g. "Paid 1,200 · Organic 24". Empty when there is nothing to split. */
  referralArrivalsClassSummary: z.string(),

  /** Per-AI-operator breakdown (OpenAI, Anthropic, Google AI, Perplexity, …). */
  byOperator: z.array(z.object({
    operator: z.string(),
    verifiedHits: z.number(),
    /** claimed-bot UA, source IP not in a published range. */
    unverifiedHits: z.number(),
    /** Per-user fetches from this operator's AI surface (ChatGPT-User, …). */
    userFetchHits: z.number(),
    referralArrivals: z.number(),
    deltaPct: percent().nullable(),
  })),

  /**
   * Top crawled paths during the selected period, with both verified and
   * unverified crawler hits. These are request counts, not citation evidence.
   */
  topCrawledPaths: z.array(z.object({
    path: z.string(),
    verifiedHits: z.number(),
    /**
     * Hits from a crawler that identified itself but whose source IP could not
     * be matched against the operator's published ranges. Additive, not an
     * alternative: some log sources carry no client IP at all (Vercel request
     * logs, for one), so for those projects every hit lands here and a
     * verified-only view reports zero against real crawl activity.
     */
    unverifiedHits: z.number().default(0),
    /** How many distinct AI operators crawled this path in the window. */
    distinctOperators: z.number(),
  })),

  /** AI products that sent ≥1 session in the window (referral by destination). */
  referralProducts: z.array(z.object({
    product: z.string(),
    arrivals: z.number(),
    distinctLandingPaths: z.number(),
  })),

  /** Daily request counts during the selected period. */
  dailyTrend: z.array(z.object({
    date: z.string(),
    verifiedCrawlerHits: z.number(),
    /** See topCrawledPaths.unverifiedHits. Plotted alongside, never instead. */
    unverifiedCrawlerHits: z.number().default(0),
    userFetchHits: z.number(),
    referralArrivals: z.number(),
  })),

  /**
   * Top landing paths for AI-referral sessions during the selected period.
   * Complements crawler paths with server-observed referral arrivals.
   */
  topReferralLandingPaths: z.array(z.object({
    path: z.string(),
    arrivals: z.number(),
    distinctProducts: z.number(),
  })),
})

export type TrafficActivitySummary = z.infer<typeof trafficActivitySummarySchema>

export const trafficAnalyticsResponseSchema = z.object({
  /** Null when no non-archived traffic source is connected. Connected sources without events return zero counts. */
  activity: trafficActivitySummarySchema.nullable(),
})
export type TrafficAnalyticsResponse = z.infer<typeof trafficAnalyticsResponseSchema>
