import { z } from 'zod'

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
    percentage: z.number(),
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
  ctr: z.number(),
  averagePosition: z.number(),
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
