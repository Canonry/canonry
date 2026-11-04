import { z } from 'zod'
import { fraction, percent } from './ratio-unit.js'

export const bingConnectionDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  siteUrl: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type BingConnectionDto = z.infer<typeof bingConnectionDtoSchema>

export const bingUrlInspectionDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  httpCode: z.number().nullable().optional(),
  inIndex: z.boolean().nullable().optional(),
  lastCrawledDate: z.string().nullable().optional(),
  inIndexDate: z.string().nullable().optional(),
  inspectedAt: z.string(),
  // Fields derived from GetUrlInfo response (more reliable than InIndex)
  documentSize: z.number().nullable().optional(),
  anchorCount: z.number().nullable().optional(),
  discoveryDate: z.string().nullable().optional(),
})
export type BingUrlInspectionDto = z.infer<typeof bingUrlInspectionDtoSchema>

export const bingCoverageSummaryDtoSchema = z.object({
  summary: z.object({
    total: z.number(),
    indexed: z.number(),
    notIndexed: z.number(),
    unknown: z.number().optional(),
    percentage: percent(),
  }),
  lastInspectedAt: z.string().nullable(),
  indexed: z.array(bingUrlInspectionDtoSchema).default([]),
  notIndexed: z.array(bingUrlInspectionDtoSchema).default([]),
  unknown: z.array(bingUrlInspectionDtoSchema).default([]).optional(),
})
export type BingCoverageSummaryDto = z.infer<typeof bingCoverageSummaryDtoSchema>

export const bingKeywordStatsDtoSchema = z.object({
  query: z.string(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: fraction(),
  averagePosition: z.number(),
  /**
   * Bing's weekly bucket for this row (YYYY-MM-DD). The live read returns one
   * row per query per week, so the same query repeats; this tells them apart.
   */
  date: z.string().nullable().optional(),
})
export type BingKeywordStatsDto = z.infer<typeof bingKeywordStatsDtoSchema>

export const bingCoverageSnapshotDtoSchema = z.object({
  date: z.string(),
  indexed: z.number(),
  notIndexed: z.number(),
  unknown: z.number(),
})
export type BingCoverageSnapshotDto = z.infer<typeof bingCoverageSnapshotDtoSchema>

export const bingSubmitResultDtoSchema = z.object({
  url: z.string(),
  status: z.enum(['success', 'error']),
  submittedAt: z.string(),
  error: z.string().optional(),
})
export type BingSubmitResultDto = z.infer<typeof bingSubmitResultDtoSchema>

/**
 * Wrapper returned by `POST /projects/:name/bing/request-indexing` — a
 * `{summary, results[]}` shape. Matches Google's
 * `IndexingRequestResponseDto` envelope, just with `BingSubmitResultDto`
 * elements.
 */
export const bingIndexingRequestResponseDtoSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  results: z.array(bingSubmitResultDtoSchema).default([]),
  /**
   * Bing's submission allowance for the site, read just before submitting:
   * what is LEFT today and this month. URLs past the allowance are returned
   * as errors without being sent. Null when the quota could not be read.
   */
  quota: z.object({
    dailyQuota: z.number().int().nonnegative(),
    monthlyQuota: z.number().int().nonnegative(),
  }).nullable().optional(),
})
export type BingIndexingRequestResponseDto = z.infer<typeof bingIndexingRequestResponseDtoSchema>

/**
 * A Bing Webmaster Tools site descriptor (from Bing's GetSites API).
 * Used inline in /bing/sites and /bing/connect responses.
 */
export const bingSiteDtoSchema = z.object({
  url: z.string(),
  verified: z.boolean(),
})
export type BingSiteDto = z.infer<typeof bingSiteDtoSchema>

/**
 * Response shape for `GET /projects/:name/bing/sites`. Just a wrapper
 * over the site list for forward-compat with pagination cursors.
 */
export const bingSitesResponseDtoSchema = z.object({
  sites: z.array(bingSiteDtoSchema).default([]),
})
export type BingSitesResponseDto = z.infer<typeof bingSitesResponseDtoSchema>

/**
 * Response shape for `GET /projects/:name/bing/status`. Carries
 * connection state for the dashboard's Bing settings card.
 *
 * Distinct from `BingConnectionDto` (the persisted connection record)
 * even though they look similar — status is what the dashboard reads,
 * connection is what the integration writes.
 */
export const bingStatusDtoSchema = z.object({
  connected: z.boolean(),
  domain: z.string(),
  siteUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type BingStatusDto = z.infer<typeof bingStatusDtoSchema>

/**
 * Response shape for `POST /projects/:name/bing/connect`. After a
 * successful key verification, the dashboard reads `availableSites`
 * so the operator can pick which site to scope subsequent operations
 * to via `POST /bing/set-site`.
 */
export const bingConnectResponseDtoSchema = z.object({
  connected: z.boolean(),
  domain: z.string(),
  siteUrl: z.string().nullable(),
  availableSites: z.array(bingSiteDtoSchema).default([]),
})
export type BingConnectResponseDto = z.infer<typeof bingConnectResponseDtoSchema>

/**
 * Response shape for `POST /projects/:name/bing/set-site`. Just echoes
 * back the URL the operator selected.
 */
export const bingSetSiteResponseDtoSchema = z.object({
  siteUrl: z.string(),
})
export type BingSetSiteResponseDto = z.infer<typeof bingSetSiteResponseDtoSchema>

// ── Stored Bing search data (`bing-sync`) ────────────────────────────────

/** The date window a stored read covered, after defaults were applied. */
export const bingWindowDtoSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
})
export type BingWindowDto = z.infer<typeof bingWindowDtoSchema>

export const bingTrafficDayDtoSchema = z.object({
  date: z.string(),
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  ctr: fraction(),
})
export type BingTrafficDayDto = z.infer<typeof bingTrafficDayDtoSchema>

/**
 * `GET /projects/:name/bing/traffic`: daily site clicks and impressions from
 * Bing (`GetRankAndTrafficStats`), with window totals. Totals come from the
 * daily rows, which are the whole site, so they are safe to show as the
 * site's Bing total.
 */
export const bingTrafficResponseDtoSchema = z.object({
  rows: z.array(bingTrafficDayDtoSchema),
  totals: z.object({
    clicks: z.number().int().nonnegative(),
    impressions: z.number().int().nonnegative(),
    ctr: fraction(),
  }),
  window: bingWindowDtoSchema,
  /** Newest stored day for the project, ignoring the window. Null before the first sync. */
  latestAvailableDate: z.string().nullable(),
  /** Oldest stored day. A window that starts earlier is only partly covered. */
  earliestAvailableDate: z.string().nullable(),
})
export type BingTrafficResponseDto = z.infer<typeof bingTrafficResponseDtoSchema>

const bingSearchTotalsShape = {
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  ctr: fraction(),
  /** Impression-weighted average position. Null when Bing sent no position. */
  avgImpressionPosition: z.number().nullable(),
  /** Click-weighted average click position. Null when Bing sent its `-1` "no value". */
  avgClickPosition: z.number().nullable(),
  /** Weekly buckets the row appeared in inside the window. */
  weeks: z.number().int().nonnegative(),
}

export const bingQueryTotalsRowDtoSchema = z.object({ query: z.string(), ...bingSearchTotalsShape })
export type BingQueryTotalsRowDto = z.infer<typeof bingQueryTotalsRowDtoSchema>

export const bingPageTotalsRowDtoSchema = z.object({ page: z.string(), ...bingSearchTotalsShape })
export type BingPageTotalsRowDto = z.infer<typeof bingPageTotalsRowDtoSchema>

/** One weekly bucket, summed over every matching query or page. */
export const bingWeeklyTotalsRowDtoSchema = z.object({ date: z.string(), ...bingSearchTotalsShape })
export type BingWeeklyTotalsRowDto = z.infer<typeof bingWeeklyTotalsRowDtoSchema>

const bingSearchListEnvelope = {
  totalMatching: z.number().int().nonnegative(),
  truncated: z.boolean(),
  window: bingWindowDtoSchema,
  latestAvailableDate: z.string().nullable(),
}

/**
 * `GET /projects/:name/bing/queries`. Bing reports query stats per WEEK, so
 * these are weekly rows summed over the window. Bing names only the queries
 * it chooses to; never sum these rows for a site total (use `/bing/traffic`).
 * With `groupBy=week` the rows are weekly totals instead (`weekly`).
 */
export const bingQueryTotalsResponseDtoSchema = z.object({
  groupBy: z.enum(['query', 'week']),
  rows: z.array(bingQueryTotalsRowDtoSchema),
  weekly: z.array(bingWeeklyTotalsRowDtoSchema),
  ...bingSearchListEnvelope,
})
export type BingQueryTotalsResponseDto = z.infer<typeof bingQueryTotalsResponseDtoSchema>

/** `GET /projects/:name/bing/pages`: as `/bing/queries`, keyed by page URL. */
export const bingPageTotalsResponseDtoSchema = z.object({
  groupBy: z.enum(['page', 'week']),
  rows: z.array(bingPageTotalsRowDtoSchema),
  weekly: z.array(bingWeeklyTotalsRowDtoSchema),
  ...bingSearchListEnvelope,
})
export type BingPageTotalsResponseDto = z.infer<typeof bingPageTotalsResponseDtoSchema>

export const bingCrawlStatsDayDtoSchema = z.object({
  date: z.string(),
  crawledPages: z.number().int().nonnegative(),
  inIndex: z.number().int().nonnegative(),
  crawlErrors: z.number().int().nonnegative(),
  inLinks: z.number().int().nonnegative(),
  code2xx: z.number().int().nonnegative(),
  code301: z.number().int().nonnegative(),
  code302: z.number().int().nonnegative(),
  code4xx: z.number().int().nonnegative(),
  code5xx: z.number().int().nonnegative(),
  allOtherCodes: z.number().int().nonnegative(),
  blockedByRobotsTxt: z.number().int().nonnegative(),
  connectionTimeout: z.number().int().nonnegative(),
  containsMalware: z.number().int().nonnegative(),
  dnsFailures: z.number().int().nonnegative(),
})
export type BingCrawlStatsDayDto = z.infer<typeof bingCrawlStatsDayDtoSchema>

/** `GET /projects/:name/bing/crawl-stats`: daily Bingbot crawl counts, newest first. */
export const bingCrawlStatsResponseDtoSchema = z.object({
  rows: z.array(bingCrawlStatsDayDtoSchema),
  window: bingWindowDtoSchema,
  latestAvailableDate: z.string().nullable(),
})
export type BingCrawlStatsResponseDto = z.infer<typeof bingCrawlStatsResponseDtoSchema>

export const bingSitemapDtoSchema = z.object({
  url: z.string(),
  /** The sitemap index this sitemap was listed under; null for a top-level submission. */
  parentUrl: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  urlCount: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  compressed: z.boolean(),
  submittedAt: z.string().nullable(),
  lastCrawledAt: z.string().nullable(),
  syncedAt: z.string(),
})
export type BingSitemapDto = z.infer<typeof bingSitemapDtoSchema>

/** `GET /projects/:name/bing/sitemaps`: what Bing has for each submitted sitemap, as of the last sync. */
export const bingSitemapsResponseDtoSchema = z.object({
  sitemaps: z.array(bingSitemapDtoSchema),
  syncedAt: z.string().nullable(),
})
export type BingSitemapsResponseDto = z.infer<typeof bingSitemapsResponseDtoSchema>

export const bingSiteSnapshotKindSchema = z.enum([
  'url-submission-quota',
  'content-submission-quota',
  'crawl-settings',
  'crawl-issues',
  'blocked-urls',
  'page-preview-blocks',
  'deep-link-blocks',
  'query-parameters',
  'country-region-settings',
  'fetched-urls',
  'connected-pages',
  'site-roles',
])
export type BingSiteSnapshotKind = z.infer<typeof bingSiteSnapshotKindSchema>
export const BingSiteSnapshotKinds = bingSiteSnapshotKindSchema.enum

export const bingSiteSnapshotStatusSchema = z.enum(['ok', 'unauthorized', 'failed'])
export type BingSiteSnapshotStatus = z.infer<typeof bingSiteSnapshotStatusSchema>

/**
 * One Bing site setting as of the last sync. `payload` is normalised per kind
 * (camelCase, ISO dates, enums as words):
 * - `url-submission-quota`, `content-submission-quota`: `{ dailyQuota, monthlyQuota }`, both what is LEFT
 * - `crawl-settings`: `{ crawlBoostAvailable, crawlBoostEnabled, crawlRate: number[24] }`
 * - `crawl-issues`: `[{ url, httpCode, inLinks, issues }]`
 * - `blocked-urls`: `[{ url, date, daysToExpire, entityType: page|directory, requestType: cache-only|full-removal }]`
 * - `query-parameters`: `[{ parameter, isEnabled, date, source }]`
 * - `country-region-settings`: `[{ url, countryCode, type: page|directory|domain|subdomain, date }]`
 * - `fetched-urls`: `[{ url, date, expired, fetched }]`
 * - `site-roles`: `[{ site, email, role: administrator|read-only|read-write, date, expired }]`
 * - `page-preview-blocks`, `deep-link-blocks`, `connected-pages`: Bing's rows, dates converted
 *
 * `status` is `unauthorized` for the owner-only reads (`connected-pages`,
 * `site-roles`) when the key is not the site owner's; `payload` is then null.
 */
export const bingSiteSnapshotDtoSchema = z.object({
  kind: bingSiteSnapshotKindSchema,
  status: bingSiteSnapshotStatusSchema,
  payload: z.unknown(),
  error: z.string().nullable(),
  syncedAt: z.string(),
})
export type BingSiteSnapshotDto = z.infer<typeof bingSiteSnapshotDtoSchema>

/** `GET /projects/:name/bing/site`: every stored Bing site setting. */
export const bingSiteResponseDtoSchema = z.object({
  snapshots: z.array(bingSiteSnapshotDtoSchema),
  syncedAt: z.string().nullable(),
})
export type BingSiteResponseDto = z.infer<typeof bingSiteResponseDtoSchema>

export const bingKeywordDemandRowDtoSchema = z.object({
  query: z.string(),
  country: z.string(),
  language: z.string(),
  /** Newest stored week for this query and market. */
  latestWeek: z.string().nullable(),
  /** Exact-match Bing searches in the newest week. */
  latestImpressions: z.number().int().nonnegative().nullable(),
  latestBroadImpressions: z.number().int().nonnegative().nullable(),
  /** Mean weekly exact-match searches over the stored weeks. */
  avgWeeklyImpressions: z.number().nonnegative().nullable(),
  /**
   * Weeks stored. A query Bing reports no volume for holds one zero week,
   * dated the day it was checked, so it is not re-read daily.
   */
  weeks: z.number().int().nonnegative(),
  syncedAt: z.string().nullable(),
})
export type BingKeywordDemandRowDto = z.infer<typeof bingKeywordDemandRowDtoSchema>

export const bingKeywordWeekDtoSchema = z.object({
  date: z.string(),
  impressions: z.number().int().nonnegative(),
  broadImpressions: z.number().int().nonnegative(),
})
export type BingKeywordWeekDto = z.infer<typeof bingKeywordWeekDtoSchema>

/**
 * `GET /projects/:name/bing/keyword-demand`: stored weekly Bing search volume
 * for the project's tracked queries. Demand, not the site's own traffic.
 * With `query`, `history` holds that query's weeks.
 */
export const bingKeywordDemandResponseDtoSchema = z.object({
  market: z.object({ country: z.string(), language: z.string() }),
  rows: z.array(bingKeywordDemandRowDtoSchema),
  history: z.array(bingKeywordWeekDtoSchema),
})
export type BingKeywordDemandResponseDto = z.infer<typeof bingKeywordDemandResponseDtoSchema>

// ── Live Bing reads (one call to Bing per request) ───────────────────────

export const bingStatsRowDtoSchema = z.object({
  date: z.string().nullable(),
  /** The search query (page-queries) or page URL (query-pages). */
  key: z.string(),
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  ctr: fraction(),
  avgImpressionPosition: z.number().nullable(),
  avgClickPosition: z.number().nullable(),
})
export type BingStatsRowDto = z.infer<typeof bingStatsRowDtoSchema>

/** `GET /projects/:name/bing/query-pages` (`GetQueryPageStats`): weekly rows, `key` = page URL. */
export const bingQueryPagesResponseDtoSchema = z.object({
  query: z.string(),
  rows: z.array(bingStatsRowDtoSchema),
})
export type BingQueryPagesResponseDto = z.infer<typeof bingQueryPagesResponseDtoSchema>

/** `GET /projects/:name/bing/page-queries` (`GetPageQueryStats`): weekly rows, `key` = query. */
export const bingPageQueriesResponseDtoSchema = z.object({
  page: z.string(),
  rows: z.array(bingStatsRowDtoSchema),
})
export type BingPageQueriesResponseDto = z.infer<typeof bingPageQueriesResponseDtoSchema>

/**
 * `GET /projects/:name/bing/query-history`. Without `page`: one query's DAILY
 * clicks and impressions (`GetQueryTrafficStats`, `position` null). With
 * `page`: that query on that page per WEEK, with position
 * (`GetQueryPageDetailStats`).
 */
export const bingQueryHistoryResponseDtoSchema = z.object({
  query: z.string(),
  page: z.string().nullable(),
  granularity: z.enum(['day', 'week']),
  rows: z.array(z.object({
    date: z.string().nullable(),
    clicks: z.number().int().nonnegative(),
    impressions: z.number().int().nonnegative(),
    ctr: fraction(),
    position: z.number().nullable(),
  })),
})
export type BingQueryHistoryResponseDto = z.infer<typeof bingQueryHistoryResponseDtoSchema>

export const bingUrlTrafficDtoSchema = z.object({
  url: z.string(),
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  isPage: z.boolean(),
})
export type BingUrlTrafficDto = z.infer<typeof bingUrlTrafficDtoSchema>

/** `GET /projects/:name/bing/url-traffic` (`GetUrlTrafficInfo`, plus `GetChildrenUrlTrafficInfo` with `children`). */
export const bingUrlTrafficResponseDtoSchema = z.object({
  url: bingUrlTrafficDtoSchema,
  /** URLs under this one; empty unless `children` was asked for. */
  children: z.array(bingUrlTrafficDtoSchema),
  page: z.number().int().nonnegative(),
})
export type BingUrlTrafficResponseDto = z.infer<typeof bingUrlTrafficResponseDtoSchema>

/** `GET /projects/:name/bing/url-children` (`GetChildrenUrlInfo`): index details for the URLs under a directory. */
export const bingUrlChildrenResponseDtoSchema = z.object({
  url: z.string(),
  page: z.number().int().nonnegative(),
  rows: z.array(z.object({
    url: z.string(),
    httpStatus: z.number().nullable(),
    documentSize: z.number().nullable(),
    anchorCount: z.number().nullable(),
    isPage: z.boolean().nullable(),
    totalChildUrlCount: z.number().nullable(),
    discoveryDate: z.string().nullable(),
    lastCrawledDate: z.string().nullable(),
  })),
})
export type BingUrlChildrenResponseDto = z.infer<typeof bingUrlChildrenResponseDtoSchema>

/**
 * `GET /projects/:name/bing/links`. Without `url`: the site's pages that have
 * inbound links (`GetLinkCounts`, `count` set). With `url`: the external pages
 * linking to it (`GetUrlLinks`, `anchorText` set). 0-indexed `page`.
 */
export const bingLinksResponseDtoSchema = z.object({
  url: z.string().nullable(),
  page: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  rows: z.array(z.object({
    url: z.string(),
    count: z.number().int().nonnegative().nullable(),
    anchorText: z.string().nullable(),
  })),
})
export type BingLinksResponseDto = z.infer<typeof bingLinksResponseDtoSchema>

/** `GET /projects/:name/bing/fetched-urls` (`GetFetchedUrls`, or `GetFetchedUrlDetails` with `url`). */
export const bingFetchedUrlsResponseDtoSchema = z.object({
  rows: z.array(z.object({
    url: z.string(),
    date: z.string().nullable(),
    expired: z.boolean().nullable(),
    fetched: z.boolean().nullable(),
  })),
  details: z.object({
    url: z.string(),
    date: z.string().nullable(),
    status: z.string().nullable(),
    headers: z.string().nullable(),
    document: z.string().nullable(),
  }).nullable(),
})
export type BingFetchedUrlsResponseDto = z.infer<typeof bingFetchedUrlsResponseDtoSchema>

/**
 * `GET /projects/:name/bing/keywords`: Bing keyword research for any keyword
 * (`GetKeyword`, `GetKeywordStats`, `GetRelatedKeywords`). Not tied to the
 * site. `impressions` is exact-match search volume, `broadImpressions`
 * broad-match.
 */
export const bingKeywordResearchResponseDtoSchema = z.object({
  keyword: z.string(),
  market: z.object({ country: z.string(), language: z.string() }),
  window: z.object({ startDate: z.string(), endDate: z.string() }),
  volume: z.object({
    impressions: z.number().int().nonnegative(),
    broadImpressions: z.number().int().nonnegative(),
  }).nullable(),
  history: z.array(bingKeywordWeekDtoSchema),
  related: z.array(z.object({
    query: z.string(),
    impressions: z.number().int().nonnegative(),
    broadImpressions: z.number().int().nonnegative(),
  })),
})
export type BingKeywordResearchResponseDto = z.infer<typeof bingKeywordResearchResponseDtoSchema>
