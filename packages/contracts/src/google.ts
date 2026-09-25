import { z } from 'zod'
import { linearTrendSchema } from './statistics.js'

export const googleConnectionTypeSchema = z.enum(['gsc', 'ga4', 'gbp'])
export type GoogleConnectionType = z.infer<typeof googleConnectionTypeSchema>

export const googleConnectionDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  connectionType: googleConnectionTypeSchema,
  propertyId: z.string().nullable().optional(),
  sitemapUrl: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GoogleConnectionDto = z.infer<typeof googleConnectionDtoSchema>

export const gscSearchDataDtoSchema = z.object({
  date: z.string(),
  query: z.string(),
  page: z.string(),
  country: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})
export type GscSearchDataDto = z.infer<typeof gscSearchDataDtoSchema>

export const gscPerformanceOrderBySchema = z.enum(['clicks', 'impressions', 'date'])
export type GscPerformanceOrderBy = z.infer<typeof gscPerformanceOrderBySchema>

/**
 * Envelope for the dimensioned GSC performance read.
 *
 * `rows` is one page of the dimensioned table, ordered by `orderBy` (clicks
 * descending by default). Ordering by `date` and then truncating is what made
 * the old bare-array response return a single day: on a real project the
 * newest date alone holds more rows than the page limit, so the cap was spent
 * before the first date boundary. `totalMatching` is the COUNT over the same
 * WHERE ignoring limit/offset, so a caller can tell a complete answer from a
 * page. `latestAvailableDate` is MAX(date) for the project ignoring the date
 * filter, which is what lets a caller distinguish "no data" from "asked past
 * the GSC reporting lag".
 *
 * Never sum `rows` for a property total. The dimensioned table both understates
 * clicks (Google withholds rare and anonymised queries) and overstates
 * impressions (one impression fans out across query x page x country x device).
 * Use /performance/daily for totals.
 */
export const gscPerformanceResponseDtoSchema = z.object({
  rows: z.array(gscSearchDataDtoSchema),
  totalMatching: z.number(),
  truncated: z.boolean(),
  latestAvailableDate: z.string().nullable(),
})
export type GscPerformanceResponseDto = z.infer<typeof gscPerformanceResponseDtoSchema>

export const gscPerformanceDailyPointSchema = z.object({
  date: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  /**
   * Average ranking position for the day, or `null` on a date served by the
   * dimensioned fallback. Summing `gsc_search_data` cannot produce a property
   * position (a mean of per-row positions is not the property's mean), so the
   * absence is reported rather than a fabricated `0` — which would also read as
   * an impossibly good rank on a chart with an inverted axis.
   */
  position: z.number().nullable(),
})
export type GscPerformanceDailyPoint = z.infer<typeof gscPerformanceDailyPointSchema>

/**
 * The date range a labelled window resolved to, and the reporting lag that
 * decided it.
 *
 * Search Console publishes on a two-to-three day delay, so a window anchored at
 * today spends its most recent days on dates that cannot hold data. The range
 * is therefore anchored on the last published day (what Google's own UI does),
 * and reported here so a caller can label the period it actually got instead of
 * the period it asked for.
 */
export const gscWindowRangeSchema = z.object({
  /** Inclusive lower bound, or `null` for the `all` window. */
  startDate: z.string().nullable(),
  /** Inclusive upper bound: the last date the property published. */
  endDate: z.string().nullable(),
  /** `MAX(date)` across the project's GSC data, ignoring the window. */
  latestDataDate: z.string().nullable(),
  /**
   * Calendar days since the last day with recorded traffic, on GSC's Pacific
   * calendar. `null` with no data.
   *
   * NOT Google's publication lag: Search Analytics omits zero-data days, so a
   * quiet tail is indistinguishable from an unpublished one and inflates this
   * number. Render it as "data through <endDate>", never as "Search Console is
   * N days behind".
   */
  daysSinceLatestData: z.number().nullable(),
})
export type GscWindowRange = z.infer<typeof gscWindowRangeSchema>

/**
 * Least-squares fit of one metric across the window's days, computed server-side
 * so the dashboard, the CLI, and the report all draw the SAME line (per the
 * UI/CLI parity rule — a chart-only regression would be invisible to an agent).
 *
 * `null` when the window holds fewer than two days carrying that metric.
 */
export const gscPerformanceTrendsSchema = z.object({
  clicks: linearTrendSchema.nullable(),
  impressions: linearTrendSchema.nullable(),
  ctr: linearTrendSchema.nullable(),
  position: linearTrendSchema.nullable(),
})
export type GscPerformanceTrends = z.infer<typeof gscPerformanceTrendsSchema>

const gscPeriodTotalsSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  /** The period's own `clicks / impressions`, never a mean of daily ratios. */
  ctr: z.number().nullable(),
  /** Impression-weighted mean position, or null when no day carried one. */
  position: z.number().nullable(),
  /**
   * Which table the figures came from. `gsc_daily_totals` (property-daily) and
   * `SUM(gsc_search_data)` (dimensioned) are not interchangeable: on one real
   * property-month the same period reads 1,142 clicks / 34,916 impressions from
   * the first and 792 / 45,266 from the second.
   */
  source: z.enum(['property-daily', 'dimensioned', 'mixed', 'empty']),
})

/**
 * The selected window measured against the equal-length period before it.
 *
 * This is what the headline percentages are computed from. It replaced the
 * fitted trend line's start-to-end movement, which had two failure modes on
 * real data: the unconstrained fit predicted a negative day-one value for a
 * non-negative metric (so there was no baseline and the tile printed nothing
 * on a metric that had grown six-fold), and where it did print it described the
 * LINE rather than the property — average position read as a 45.8% improvement
 * over a window in which the real position got worse.
 *
 * Both periods are real, adjacent, equal-length stretches of recorded days,
 * split over the CALENDAR rather than the row array, since Search Analytics
 * omits zero-data days. Read `basis` before reading `days`: under
 * `split-window` the two periods come out of the selected window itself, so
 * `days` is HALF of it. `null` when there is no span to divide, no evidence, or
 * the span extends beyond the project's known GSC data frontier.
 */
export const gscPeriodComparisonSchema = z.object({
  /**
   * Length of EACH period in calendar days. Equals the selected window under
   * `basis: 'prior-window'`, and half of it under `basis: 'split-window'`.
   */
  days: z.number(),
  /**
   * Which two periods these are, so a surface can say what it is showing.
   *
   * `prior-window` — the selected window against the equal-length period
   * immediately before it. What a reader means by "vs prior 90d".
   *
   * `split-window` — the selected window's own trailing and leading halves.
   * Used when there is nothing before the window to compare with: an unbounded
   * selection (`window=all`), or a prior period the sync never reached, whose
   * unsynced days would otherwise be counted as zeroes and manufacture growth.
   * A surface printing "vs prior {days}d" here is naming a period HALF the
   * length of the control the reader pressed, which is honest but surprising —
   * hence the label.
   *
   * Optional for the same reason as `window` and `trends`: a server older than
   * this field returns the comparison WITHOUT it, and declaring it required
   * would tell a generated consumer it may dereference the field safely against
   * a legacy response. Absent means the basis is unstated; every such server
   * split the window, but a surface should render the absence with its
   * period-length copy rather than assert a basis nobody sent.
   */
  basis: z.enum(['prior-window', 'split-window']).optional(),
  prior: gscPeriodTotalsSchema,
  trailing: gscPeriodTotalsSchema,
  /**
   * False when either period contains dimensioned fallback totals, in which
   * case every `change` is null. Empty/property-daily halves are comparable;
   * `SUM(gsc_search_data)` is never valid for property totals.
   */
  comparable: z.boolean(),
  /**
   * Relative change as a ratio (0.5 = +50%), null where the prior period gives
   * nothing to divide by or the trailing metric is unavailable. The sign is
   * mathematical: a POSITIVE `position` means the rank number rose, which is
   * worse. Desirability is the renderer's call.
   */
  change: z.object({
    clicks: z.number().nullable(),
    impressions: z.number().nullable(),
    ctr: z.number().nullable(),
    position: z.number().nullable(),
  }),
})
export type GscPeriodComparison = z.infer<typeof gscPeriodComparisonSchema>

export const gscPerformanceDailyDtoSchema = z.object({
  totals: z.object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    /**
     * Impression-weighted mean position over the window, or `null` when no day
     * carried a property-level position. Weighted, not a plain mean of the
     * daily values: position is non-additive, and an unweighted mean lets a
     * one-impression day count as much as a thousand-impression day.
     */
    position: z.number().nullable(),
    /**
     * Days that carried a property-level position. Below `days`, `position`
     * describes a subset of the window and must be labelled as partial.
     */
    positionDays: z.number(),
    days: z.number(),
  }),
  daily: z.array(gscPerformanceDailyPointSchema),
  /**
   * Optional because a server older than this field omits it. Both the web and
   * the CLI guard for that skew; declaring it required here would tell a
   * generated consumer it may dereference the field safely against a legacy
   * response, which is exactly the crash those guards exist to prevent.
   */
  window: gscWindowRangeSchema.optional(),
  /**
   * Optional for the same reason as `window`: a server older than this field
   * omits it, and the chart guards for that skew.
   */
  trends: gscPerformanceTrendsSchema.optional(),
  /**
   * Optional for the same reason as `window` and `trends`, and additionally
   * null when there is no span to divide into two periods, no evidence, or the
   * span extends beyond the project's known GSC data frontier. A consumer must
   * render the absence rather than substitute a percentage.
   */
  periodComparison: gscPeriodComparisonSchema.nullable().optional(),
})
export type GscPerformanceDailyDto = z.infer<typeof gscPerformanceDailyDtoSchema>

export const gscTopPageRowSchema = z.object({
  page: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
})
export type GscTopPageRow = z.infer<typeof gscTopPageRowSchema>

/**
 * Ranked pages plus an OPTIONAL window total.
 *
 * The rows are a ranking, aggregated from the dimensioned `gsc_search_data`
 * table. That table is valid for ranking and INVALID for totals: Google
 * withholds rare/anonymised queries, so summing it under-counts clicks, and one
 * impression fans out across every query x page x country x device combination,
 * so summing it over-counts impressions. On one real property-month the sum
 * read 792 clicks against 1,142 actual and 45,266 impressions against 34,916.
 *
 * `totals` is therefore never the sum of `rows`. It is read from the
 * un-dimensioned property-level daily table and carries the explicit
 * `totalsSource` discriminator so a consumer can tell where it came from. When
 * that table has no rows in the window, `totals` is `null`: the honest answer
 * is "no property-level total available", not a plausible wrong number.
 */
export const gscTopPagesDtoSchema = z.object({
  rows: z.array(gscTopPageRowSchema),
  totals: z.object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    days: z.number(),
    /** First date the property-level totals actually cover. */
    coveredFrom: z.string().nullable(),
    /** Last date the property-level totals actually cover. */
    coveredThrough: z.string().nullable(),
    /**
     * False when the totals span less than the ranked rows above.
     *
     * The dimensioned and property-level tables sync independently, so a
     * 30-day totals sync can sit next to months of dimensioned rows. Printing
     * both as one period would misstate the window the totals belong to.
     */
    complete: z.boolean(),
  }).nullable(),
  totalsSource: z.literal('property-daily'),
  /** First date the ranked rows cover, so a caller can compare spans. */
  rankedFrom: z.string().nullable(),
  /** Last date the ranked rows cover. */
  rankedThrough: z.string().nullable(),
})
export type GscTopPagesDto = z.infer<typeof gscTopPagesDtoSchema>

/**
 * Where one query's window total came from.
 *
 * `google`: every day came from Google's un-dimensioned `['date','query']`
 * fetch, so the figures match Search Console's own per-query numbers.
 * `page-summed`: every day came from the legacy page-dimensioned table, where
 * one search showing several of the site's pages is stored as several rows, so
 * impressions over-count (clicks and position are still usable).
 * `mixed`: the window spans both, the normal state while a backfill is partial.
 */
export const gscQueryTotalsSourceSchema = z.enum(['google', 'page-summed', 'mixed'])
export type GscQueryTotalsSource = z.infer<typeof gscQueryTotalsSourceSchema>

export const gscQueryTotalRowSchema = z.object({
  query: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  /** clicks / impressions, 0 when impressions are 0. */
  ctr: z.number(),
  /**
   * Impression-weighted average position over the window:
   * sum(position * impressions) / sum(impressions). When the query has no
   * impressions in the window, the plain mean of its daily positions.
   */
  position: z.number(),
  /** Distinct dates the query appeared on in the window. */
  days: z.number(),
  source: gscQueryTotalsSourceSchema,
})
export type GscQueryTotalRow = z.infer<typeof gscQueryTotalRowSchema>

/**
 * Search Console totals per query over a date window, read from stored sync
 * data (no call to Google).
 *
 * The rows cover the queries Google NAMES. Google leaves rare and anonymised
 * queries out of per-query data, so summing `rows` gives less than the
 * property's total; read `GET /google/gsc/performance/daily` (CLI
 * `canonry google performance-daily`) for the property total.
 *
 * Rows are ordered clicks desc, impressions desc, then query ascending by code
 * point, so `limit` / `offset` pages are stable. `totalMatching` counts every
 * query in the window; `truncated` is true when more rows follow this page.
 */
export const gscQueryTotalsDtoSchema = z.object({
  rows: z.array(gscQueryTotalRowSchema),
  totalMatching: z.number(),
  truncated: z.boolean(),
  /**
   * The range the rows were read from, exactly. Explicit dates win; a labelled
   * window paired with only `endDate` spans that many days ending on it. A
   * `null` side is unbounded.
   */
  window: gscWindowRangeSchema,
})
export type GscQueryTotalsDto = z.infer<typeof gscQueryTotalsDtoSchema>

export const gscUrlInspectionDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  indexingState: z.string().nullable().optional(),
  verdict: z.string().nullable().optional(),
  coverageState: z.string().nullable().optional(),
  pageFetchState: z.string().nullable().optional(),
  robotsTxtState: z.string().nullable().optional(),
  crawlTime: z.string().nullable().optional(),
  lastCrawlResult: z.string().nullable().optional(),
  isMobileFriendly: z.boolean().nullable().optional(),
  richResults: z.array(z.string()).default([]),
  // Spec gap: server has returned `referringUrls` since the GSC inspect
  // route shipped (see google.ts handler at /gsc/inspect + /gsc/inspections),
  // but the schema dropped the field so the generated TS client (and
  // anything else reading from this DTO) lost the data silently. Adding
  // here restores end-to-end visibility.
  referringUrls: z.array(z.string()).default([]),
  inspectedAt: z.string(),
})
export type GscUrlInspectionDto = z.infer<typeof gscUrlInspectionDtoSchema>

export const indexTransitionSchema = z.enum(['stable', 'reindexed', 'deindexed', 'still-missing', 'new'])
export type IndexTransition = z.infer<typeof indexTransitionSchema>

export const gscDeindexedRowSchema = z.object({
  url: z.string(),
  previousState: z.string().nullable(),
  currentState: z.string().nullable(),
  transitionDate: z.string(),
})
export type GscDeindexedRowDto = z.infer<typeof gscDeindexedRowSchema>

export const gscReasonGroupSchema = z.object({
  reason: z.string(),
  count: z.number(),
  urls: z.array(gscUrlInspectionDtoSchema).default([]),
})
export type GscReasonGroup = z.infer<typeof gscReasonGroupSchema>

export const gscCoverageSummaryDtoSchema = z.object({
  summary: z.object({
    total: z.number(),
    indexed: z.number(),
    notIndexed: z.number(),
    deindexed: z.number(),
    percentage: z.number(),
  }),
  lastInspectedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  indexed: z.array(gscUrlInspectionDtoSchema).default([]),
  notIndexed: z.array(gscUrlInspectionDtoSchema).default([]),
  deindexed: z.array(gscDeindexedRowSchema).default([]),
  reasonGroups: z.array(gscReasonGroupSchema).default([]),
})
export type GscCoverageSummaryDto = z.infer<typeof gscCoverageSummaryDtoSchema>

export const indexingNotificationDtoSchema = z.object({
  url: z.string(),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']),
  notifiedAt: z.string(),
})
export type IndexingNotificationDto = z.infer<typeof indexingNotificationDtoSchema>

export const indexingRequestResultDtoSchema = z.object({
  url: z.string(),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']),
  notifiedAt: z.string(),
  status: z.enum(['success', 'error']),
  error: z.string().optional(),
})
export type IndexingRequestResultDto = z.infer<typeof indexingRequestResultDtoSchema>

/**
 * Wrapper returned by `POST /projects/:name/google/indexing/request` — a
 * `{summary, results[]}` shape consumed by the dashboard's batch-submit
 * UI and the CLI. Same envelope shape as Bing's indexing-request response
 * (defined in `bing.ts`), just with `IndexingRequestResultDto` elements.
 */
export const indexingRequestResponseDtoSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  results: z.array(indexingRequestResultDtoSchema).default([]),
})
export type IndexingRequestResponseDto = z.infer<typeof indexingRequestResponseDtoSchema>

export const gscCoverageSnapshotDtoSchema = z.object({
  date: z.string(),
  indexed: z.number(),
  notIndexed: z.number(),
  /**
   * Pages with no evidence either way — no impressions in the window and never
   * inspected. Deliberately NOT folded into `notIndexed`: absence of
   * impressions is not evidence of exclusion, and merging the two would report
   * every unmeasured page as a problem.
   */
  unknownPages: z.number().default(0),
  /** Of the total, how many carry a real URL Inspection verdict. */
  verifiedByInspection: z.number().default(0),
  /** Pages proven indexed by impressions alone, costing no inspection quota. */
  derivedFromImpressions: z.number().default(0),
  reasonBreakdown: z.record(z.string(), z.number()).default({}),
})
export type GscCoverageSnapshotDto = z.infer<typeof gscCoverageSnapshotDtoSchema>

/**
 * A GSC site/property the connected Google principal has access to.
 * Returned by `listSites` and wrapped in `GscSiteListResponseDto`.
 */
export const gscSiteDtoSchema = z.object({
  siteUrl: z.string(),
  permissionLevel: z.string(),
})
export type GscSiteDto = z.infer<typeof gscSiteDtoSchema>

/**
 * Response shape for `GET /projects/:name/google/properties`. Wraps the
 * site list for forward-compat with pagination/cursors.
 */
export const gscSiteListResponseDtoSchema = z.object({
  sites: z.array(gscSiteDtoSchema).default([]),
})
export type GscSiteListResponseDto = z.infer<typeof gscSiteListResponseDtoSchema>

/**
 * Per-format content row inside a sitemap (e.g. submitted vs. indexed
 * counts per content type — `web`, `image`, `video`).
 */
export const gscSitemapContentDtoSchema = z.object({
  type: z.string(),
  submitted: z.string(),
  // Google still returns this for existing sitemap reads, but it is not a
  // reliable submission outcome. Retained only for response compatibility.
  indexed: z.string().optional().describe('Deprecated compatibility field.'),
})
export type GscSitemapContentDto = z.infer<typeof gscSitemapContentDtoSchema>

/**
 * A sitemap registered for the active GSC property. Mirrors Google's
 * Search Console API `WmxSitemap` resource.
 */
export const gscSitemapDtoSchema = z.object({
  path: z.string(),
  parentSitemapUrl: z.string().optional(),
  lastSubmitted: z.string().optional(),
  isPending: z.boolean().optional(),
  isSitemapsIndex: z.boolean().optional(),
  type: z.string().optional(),
  lastDownloaded: z.string().optional(),
  warnings: z.string().optional(),
  errors: z.string().optional(),
  contents: z.array(gscSitemapContentDtoSchema).optional(),
})
export type GscSitemapDto = z.infer<typeof gscSitemapDtoSchema>

/**
 * Response shape for `GET /projects/:name/google/gsc/sitemaps`. Wraps
 * the sitemap list for forward-compat.
 */
export const gscSitemapListResponseDtoSchema = z.object({
  sitemaps: z.array(gscSitemapDtoSchema).default([]),
  summary: z.object({
    total: z.number().int().nonnegative(),
    indexes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  preferredSubmissionUrls: z.array(z.string()).default([]),
})
export type GscSitemapListResponseDto = z.infer<typeof gscSitemapListResponseDtoSchema>

export const gscSubmitSitemapsRequestDtoSchema = z.object({
  sitemapUrls: z.array(
    z.string().url().refine(
      (value) => {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      },
      { message: 'Sitemap URL must use http or https.' },
    ),
  ).min(1).max(50),
})
export type GscSubmitSitemapsRequestDto = z.infer<typeof gscSubmitSitemapsRequestDtoSchema>

export const gscSubmitSitemapResultDtoSchema = z.object({
  sitemapUrl: z.string(),
  status: z.enum(['accepted', 'error']),
  submittedAt: z.string().optional(),
  error: z.string().optional(),
})
export type GscSubmitSitemapResultDto = z.infer<typeof gscSubmitSitemapResultDtoSchema>

export const gscSubmitSitemapsResponseDtoSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  results: z.array(gscSubmitSitemapResultDtoSchema),
})
export type GscSubmitSitemapsResponseDto = z.infer<typeof gscSubmitSitemapsResponseDtoSchema>

export const gscDiscoverSitemapsResponseDtoSchema = z.object({
  sitemaps: z.array(gscSitemapDtoSchema),
  primarySitemapUrl: z.string(),
  run: z.object({
    id: z.string(),
    projectId: z.string(),
    kind: z.string(),
    status: z.string(),
    trigger: z.string(),
    createdAt: z.string(),
  }).nullable(),
})
export type GscDiscoverSitemapsResponseDto = z.infer<typeof gscDiscoverSitemapsResponseDtoSchema>
