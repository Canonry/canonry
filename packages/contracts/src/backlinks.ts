import { z } from 'zod'

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
})
export type BacklinkSummaryDto = z.infer<typeof backlinkSummaryDtoSchema>

export const backlinkListResponseSchema = z.object({
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
})
export type BacklinkHistoryEntry = z.infer<typeof backlinkHistoryEntrySchema>

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
