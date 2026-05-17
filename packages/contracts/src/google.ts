import { z } from 'zod'

export const googleConnectionTypeSchema = z.enum(['gsc', 'ga4'])
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

export const gscPerformanceDailyPointSchema = z.object({
  date: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
})
export type GscPerformanceDailyPoint = z.infer<typeof gscPerformanceDailyPointSchema>

export const gscPerformanceDailyDtoSchema = z.object({
  totals: z.object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    days: z.number(),
  }),
  daily: z.array(gscPerformanceDailyPointSchema),
})
export type GscPerformanceDailyDto = z.infer<typeof gscPerformanceDailyDtoSchema>

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
  indexed: z.string(),
})
export type GscSitemapContentDto = z.infer<typeof gscSitemapContentDtoSchema>

/**
 * A sitemap registered for the active GSC property. Mirrors Google's
 * Search Console API `WmxSitemap` resource.
 */
export const gscSitemapDtoSchema = z.object({
  path: z.string(),
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
})
export type GscSitemapListResponseDto = z.infer<typeof gscSitemapListResponseDtoSchema>
