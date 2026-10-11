import { z } from 'zod'

/**
 * Stored backlink origin. Common Crawl is the only active ingestion source.
 * `bing-webmaster` remains readable so databases created by older Canonry
 * versions do not lose access to their historical rows.
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
 * Headline Common Crawl backlink-summary math: linking-domain count, aggregate
 * host weight, and the concentration share of the 10 strongest linking domains.
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
  numHosts: z.number().int(),
  source: backlinkSourceSchema,
})
export type BacklinkDomainDto = z.infer<typeof backlinkDomainDtoSchema>

export const backlinkSummaryDtoSchema = z.object({
  projectId: z.string(),
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
 * Availability for a stored backlink source. Common Crawl can be connected and
 * refreshed; retired sources may report historical data but are never connected.
 * Common Crawl is `connected` when a workspace release sync has completed
 * (`ready`, or completed before and syncing again) and the project has a
 * stored summary, the rule the `backlinks.source.connected` doctor check
 * grades. No project setting is involved.
 */
export const backlinkSourceAvailabilityDtoSchema = z.object({
  source: backlinkSourceSchema,
  connected: z.boolean(),
  hasData: z.boolean(),
  latestRelease: z.string().nullable(),
  totalLinkingDomains: z.number().int(),
  lastSyncedAt: z.string().nullable(),
})
export type BacklinkSourceAvailabilityDto = z.infer<typeof backlinkSourceAvailabilityDtoSchema>

export const backlinkSourcesResponseSchema = z.object({
  projectId: z.string(),
  targetDomain: z.string(),
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
