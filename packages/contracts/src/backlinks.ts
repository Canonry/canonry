import { z } from 'zod'

/**
 * Which source produced a backlink row. The two sources have different refresh
 * cadences and data shapes (Common Crawl is a ~monthly public hyperlink-graph
 * release; Bing Webmaster is a live first-party inbound-link feed), so every
 * backlink surface is source-aware end to end. Never conflate them.
 */
export const backlinkSourceSchema = z.enum(['commoncrawl', 'bing-webmaster'])
export type BacklinkSource = z.infer<typeof backlinkSourceSchema>
export const BacklinkSources = backlinkSourceSchema.enum

export interface BacklinkSummaryMetrics {
  totalLinkingDomains: number
  totalHosts: number
  /** Six-decimal fixed string in [0,1], or '0' for an empty set. */
  top10HostsShare: string
}

/**
 * Headline backlink-summary math shared by every extractor (Common Crawl and
 * Bing): linking-domain count, aggregate host weight, and the concentration
 * share of the 10 strongest linking domains. Pure — one source of truth so the
 * Common Crawl and Bing paths can never drift apart.
 */
export function computeBacklinkSummaryMetrics(
  rows: ReadonlyArray<{ numHosts: number }>,
): BacklinkSummaryMetrics {
  if (rows.length === 0) {
    return { totalLinkingDomains: 0, totalHosts: 0, top10HostsShare: '0' }
  }
  const sorted = [...rows].sort((a, b) => b.numHosts - a.numHosts)
  const totalHosts = sorted.reduce((acc, r) => acc + r.numHosts, 0)
  const top10Hosts = sorted.slice(0, 10).reduce((acc, r) => acc + r.numHosts, 0)
  const share = totalHosts > 0 ? top10Hosts / totalHosts : 0
  return {
    totalLinkingDomains: rows.length,
    totalHosts,
    top10HostsShare: share.toFixed(6),
  }
}

export const ccReleaseSyncStatusSchema = z.enum(['queued', 'downloading', 'querying', 'ready', 'failed'])
export type CcReleaseSyncStatus = z.infer<typeof ccReleaseSyncStatusSchema>
export const CcReleaseSyncStatuses = ccReleaseSyncStatusSchema.enum

export const ccReleaseSyncDtoSchema = z.object({
  id: z.string(),
  release: z.string(),
  status: ccReleaseSyncStatusSchema,
  phaseDetail: z.string().nullable().optional(),
  vertexPath: z.string().nullable().optional(),
  edgesPath: z.string().nullable().optional(),
  vertexSha256: z.string().nullable().optional(),
  edgesSha256: z.string().nullable().optional(),
  vertexBytes: z.number().int().nullable().optional(),
  edgesBytes: z.number().int().nullable().optional(),
  projectsProcessed: z.number().int().nullable().optional(),
  domainsDiscovered: z.number().int().nullable().optional(),
  downloadStartedAt: z.string().nullable().optional(),
  downloadFinishedAt: z.string().nullable().optional(),
  queryStartedAt: z.string().nullable().optional(),
  queryFinishedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CcReleaseSyncDto = z.infer<typeof ccReleaseSyncDtoSchema>

export const backlinkDomainDtoSchema = z.object({
  linkingDomain: z.string(),
  // For Common Crawl this is the count of distinct hosts within the linking
  // domain; for Bing Webmaster it is the count of distinct linking pages (URLs)
  // from that linking host. Read alongside `source` — the unit differs per source.
  numHosts: z.number().int(),
  source: backlinkSourceSchema,
})
export type BacklinkDomainDto = z.infer<typeof backlinkDomainDtoSchema>

export const backlinkSummaryDtoSchema = z.object({
  projectId: z.string(),
  // Window identifier. Common Crawl uses the release slug
  // (`cc-main-YYYY-<mon>-<mon>-<mon>`); Bing Webmaster uses a synthetic
  // per-sync-day window (`bing-YYYY-MM-DD`).
  release: z.string(),
  targetDomain: z.string(),
  totalLinkingDomains: z.number().int(),
  totalHosts: z.number().int(),
  top10HostsShare: z.string(),
  queriedAt: z.string(),
  source: backlinkSourceSchema,
  // Populated when the response is filtered (e.g. ?excludeCrawlers=1).
  // Counts the rows omitted from totalLinkingDomains/totalHosts so callers
  // can show "N hidden" hints without re-deriving them.
  excludedLinkingDomains: z.number().int().optional(),
  excludedHosts: z.number().int().optional(),
})
export type BacklinkSummaryDto = z.infer<typeof backlinkSummaryDtoSchema>

export const backlinkListResponseSchema = z.object({
  // The source this response was filtered to (defaults to commoncrawl when the
  // caller omits `?source`).
  source: backlinkSourceSchema,
  summary: backlinkSummaryDtoSchema.nullable(),
  total: z.number().int(),
  rows: z.array(backlinkDomainDtoSchema),
})
export type BacklinkListResponse = z.infer<typeof backlinkListResponseSchema>

export const backlinkHistoryEntrySchema = z.object({
  release: z.string(),
  totalLinkingDomains: z.number().int(),
  totalHosts: z.number().int(),
  top10HostsShare: z.string(),
  queriedAt: z.string(),
  source: backlinkSourceSchema,
})
export type BacklinkHistoryEntry = z.infer<typeof backlinkHistoryEntrySchema>

/**
 * Per-source availability for a project's backlinks surface. Lets the UI/CLI
 * degrade gracefully across CC-only / Bing-only / both / neither without
 * erroring when a source is absent.
 */
export const backlinkSourceAvailabilityDtoSchema = z.object({
  source: backlinkSourceSchema,
  /**
   * The source is set up for this project:
   *  - commoncrawl: `autoExtractBacklinks` enabled AND a `ready` release sync exists.
   *  - bing-webmaster: a Bing Webmaster connection exists for the project domain.
   */
  connected: z.boolean(),
  /** Backlink rows exist for this project + source. */
  hasData: z.boolean(),
  /** Latest window id with data for this source, null when none. */
  latestRelease: z.string().nullable(),
  /**
   * Linking-domain count in the latest window. Excludes crawler/proxy hosts only
   * when the request sets `?excludeCrawlers=1` (default off, matching the summary
   * and domains endpoints); the dashboard passes it so the switcher pill matches
   * the metric card.
   */
  totalLinkingDomains: z.number().int(),
  /** Freshness: `queriedAt` of the latest summary for this source, null when none. */
  lastSyncedAt: z.string().nullable(),
})
export type BacklinkSourceAvailabilityDto = z.infer<typeof backlinkSourceAvailabilityDtoSchema>

export const backlinkSourcesResponseSchema = z.object({
  projectId: z.string(),
  targetDomain: z.string(),
  /** Availability for every known source, in a stable order. */
  sources: z.array(backlinkSourceAvailabilityDtoSchema),
  anyConnected: z.boolean(),
  anyData: z.boolean(),
})
export type BacklinkSourcesResponseDto = z.infer<typeof backlinkSourcesResponseSchema>

export const backlinksInstallStatusDtoSchema = z.object({
  duckdbInstalled: z.boolean(),
  duckdbVersion: z.string().nullable().optional(),
  duckdbSpec: z.string(),
  pluginDir: z.string(),
})
export type BacklinksInstallStatusDto = z.infer<typeof backlinksInstallStatusDtoSchema>

export const backlinksInstallResultDtoSchema = z.object({
  installed: z.boolean(),
  version: z.string(),
  path: z.string(),
  alreadyPresent: z.boolean(),
})
export type BacklinksInstallResultDto = z.infer<typeof backlinksInstallResultDtoSchema>

export const ccAvailableReleaseSchema = z.object({
  release: z.string(),
  vertexUrl: z.string(),
  edgesUrl: z.string(),
  vertexBytes: z.number().int().nullable(),
  edgesBytes: z.number().int().nullable(),
  lastModified: z.string().nullable(),
})
export type CcAvailableRelease = z.infer<typeof ccAvailableReleaseSchema>

export const ccCachedReleaseSchema = z.object({
  release: z.string(),
  syncStatus: ccReleaseSyncStatusSchema.nullable(),
  bytes: z.number().int(),
  lastUsedAt: z.string().nullable(),
})
export type CcCachedRelease = z.infer<typeof ccCachedReleaseSchema>
