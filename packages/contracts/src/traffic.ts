import { z } from 'zod'

export const trafficSourceTypeSchema = z.enum([
  'cloud-run',
  'wordpress',
  'cloudflare',
  'vercel',
  'generic-log',
])
export type TrafficSourceType = z.infer<typeof trafficSourceTypeSchema>
export const TrafficSourceTypes = trafficSourceTypeSchema.enum

export const trafficAdapterCapabilitySchema = z.enum([
  'raw-request-events',
  'aggregate-request-metrics',
  'request-url',
  'status-code',
  'user-agent',
  'remote-ip',
  'referer',
  'cursor-pull',
])
export type TrafficAdapterCapability = z.infer<typeof trafficAdapterCapabilitySchema>
export const TrafficAdapterCapabilities = trafficAdapterCapabilitySchema.enum

export const trafficEvidenceKindSchema = z.enum(['raw-request', 'aggregate-bucket'])
export type TrafficEvidenceKind = z.infer<typeof trafficEvidenceKindSchema>
export const TrafficEvidenceKinds = trafficEvidenceKindSchema.enum

export const trafficEventConfidenceSchema = z.enum(['observed', 'provider-aggregated', 'inferred'])
export type TrafficEventConfidence = z.infer<typeof trafficEventConfidenceSchema>
export const TrafficEventConfidences = trafficEventConfidenceSchema.enum

export const trafficProviderResourceSchema = z.object({
  type: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
})
export type TrafficProviderResource = z.infer<typeof trafficProviderResourceSchema>

export const normalizedTrafficRequestSchema = z.object({
  sourceType: trafficSourceTypeSchema,
  evidenceKind: z.literal(TrafficEvidenceKinds['raw-request']),
  confidence: z.literal(TrafficEventConfidences.observed),
  eventId: z.string().min(1),
  observedAt: z.string().min(1),
  method: z.string().nullable(),
  requestUrl: z.string().nullable(),
  host: z.string().nullable(),
  path: z.string().min(1),
  queryString: z.string().nullable(),
  status: z.number().int().nullable(),
  userAgent: z.string().nullable(),
  remoteIp: z.string().nullable(),
  referer: z.string().nullable(),
  latencyMs: z.number().nullable(),
  requestSizeBytes: z.number().int().nullable(),
  responseSizeBytes: z.number().int().nullable(),
  providerResource: trafficProviderResourceSchema,
  providerLabels: z.record(z.string(), z.string()),
})
export type NormalizedTrafficRequest = z.infer<typeof normalizedTrafficRequestSchema>

export const normalizedTrafficPullPageSchema = z.object({
  events: z.array(normalizedTrafficRequestSchema),
  rawEntryCount: z.number().int().nonnegative(),
  skippedEntryCount: z.number().int().nonnegative(),
  nextPageToken: z.string().optional(),
  filter: z.string(),
})
export type NormalizedTrafficPullPage = z.infer<typeof normalizedTrafficPullPageSchema>

export const trafficSourceStatusSchema = z.enum(['connected', 'paused', 'error', 'archived'])
export type TrafficSourceStatus = z.infer<typeof trafficSourceStatusSchema>
export const TrafficSourceStatuses = trafficSourceStatusSchema.enum

export const trafficSourceAuthModeSchema = z.enum(['oauth', 'service-account'])
export type TrafficSourceAuthMode = z.infer<typeof trafficSourceAuthModeSchema>
export const TrafficSourceAuthModes = trafficSourceAuthModeSchema.enum

export const cloudRunSourceConfigSchema = z.object({
  gcpProjectId: z.string().min(1),
  serviceName: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  authMode: trafficSourceAuthModeSchema,
})
export type CloudRunSourceConfig = z.infer<typeof cloudRunSourceConfigSchema>

export const trafficSourceDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceType: trafficSourceTypeSchema,
  displayName: z.string(),
  status: trafficSourceStatusSchema,
  lastSyncedAt: z.string().nullable(),
  lastCursor: z.string().nullable(),
  lastError: z.string().nullable(),
  archivedAt: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TrafficSourceDto = z.infer<typeof trafficSourceDtoSchema>

export const trafficConnectCloudRunRequestSchema = z.object({
  gcpProjectId: z.string().min(1),
  serviceName: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  /** Service-account JSON content (string). When omitted, defaults to OAuth via `canonry google connect <project> --type ga4` flow. */
  keyJson: z.string().optional(),
})
export type TrafficConnectCloudRunRequest = z.infer<typeof trafficConnectCloudRunRequestSchema>

export const trafficSyncResponseSchema = z.object({
  sourceId: z.string(),
  runId: z.string(),
  syncedAt: z.string(),
  pulledEvents: z.number().int().nonnegative(),
  crawlerHits: z.number().int().nonnegative(),
  aiReferralHits: z.number().int().nonnegative(),
  unknownHits: z.number().int().nonnegative(),
  crawlerBucketRows: z.number().int().nonnegative(),
  aiReferralBucketRows: z.number().int().nonnegative(),
  sampleRows: z.number().int().nonnegative(),
  windowStart: z.string(),
  windowEnd: z.string(),
})
export type TrafficSyncResponse = z.infer<typeof trafficSyncResponseSchema>
