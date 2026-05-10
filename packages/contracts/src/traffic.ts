import { z } from 'zod'
import { runStatusSchema } from './run.js'

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

// Crawler verification tiers. See `packages/integration-traffic/AGENTS.md`:
// UA-only matches stay `claimed_unverified` until IP/rDNS verification is wired;
// `unknown_ai_like` is reserved for behavioral heuristics.
export const verificationStatusSchema = z.enum(['verified', 'claimed_unverified', 'unknown_ai_like'])
export type VerificationStatus = z.infer<typeof verificationStatusSchema>
export const VerificationStatuses = verificationStatusSchema.enum

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

export const trafficBackfillRequestSchema = z.object({
  /** Lookback window in days. Capped server-side at the upstream log retention ceiling (Cloud Logging _Default = 30d). Default: 30. */
  days: z.number().int().positive().optional(),
})
export type TrafficBackfillRequest = z.infer<typeof trafficBackfillRequestSchema>

/**
 * Async backfill response — returned as soon as the run row is created and the
 * background pull starts. Poll `GET /runs/:runId` for completion. Concrete
 * counts are not in this response; once the run is `completed`, query
 * `/traffic/sources/:id` and `/traffic/events` for the rebuilt rollup data.
 */
export const trafficBackfillResponseSchema = z.object({
  sourceId: z.string(),
  runId: z.string(),
  status: runStatusSchema,
  windowStart: z.string(),
  windowEnd: z.string(),
  /** Days actually used after server-side clamping (≤ requested). */
  daysRequested: z.number().int().positive(),
  daysApplied: z.number().int().positive(),
})
export type TrafficBackfillResponse = z.infer<typeof trafficBackfillResponseSchema>

export const trafficSourceTotalsSchema = z.object({
  crawlerHits: z.number().int().nonnegative(),
  aiReferralHits: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
})
export type TrafficSourceTotals = z.infer<typeof trafficSourceTotalsSchema>

export const trafficSourceListResponseSchema = z.object({
  sources: z.array(trafficSourceDtoSchema),
})
export type TrafficSourceListResponse = z.infer<typeof trafficSourceListResponseSchema>

export const trafficSourceDetailDtoSchema = trafficSourceDtoSchema.extend({
  totals24h: trafficSourceTotalsSchema,
  latestRun: z
    .object({
      runId: z.string(),
      status: runStatusSchema,
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
})
export type TrafficSourceDetailDto = z.infer<typeof trafficSourceDetailDtoSchema>

export const trafficStatusResponseSchema = z.object({
  sources: z.array(trafficSourceDetailDtoSchema),
})
export type TrafficStatusResponse = z.infer<typeof trafficStatusResponseSchema>

export const trafficEventKindSchema = z.enum(['crawler', 'ai-referral'])
export type TrafficEventKind = z.infer<typeof trafficEventKindSchema>
export const TrafficEventKinds = trafficEventKindSchema.enum

export const trafficCrawlerEventEntrySchema = z.object({
  kind: z.literal(TrafficEventKinds.crawler),
  sourceId: z.string(),
  tsHour: z.string(),
  botId: z.string(),
  operator: z.string(),
  verificationStatus: z.string(),
  pathNormalized: z.string(),
  status: z.number().int(),
  hits: z.number().int().nonnegative(),
})
export type TrafficCrawlerEventEntry = z.infer<typeof trafficCrawlerEventEntrySchema>

export const trafficAiReferralEventEntrySchema = z.object({
  kind: z.literal(TrafficEventKinds['ai-referral']),
  sourceId: z.string(),
  tsHour: z.string(),
  product: z.string(),
  operator: z.string(),
  sourceDomain: z.string(),
  evidenceType: z.string(),
  landingPathNormalized: z.string(),
  status: z.number().int(),
  hits: z.number().int().nonnegative(),
})
export type TrafficAiReferralEventEntry = z.infer<typeof trafficAiReferralEventEntrySchema>

export const trafficEventEntrySchema = z.discriminatedUnion('kind', [
  trafficCrawlerEventEntrySchema,
  trafficAiReferralEventEntrySchema,
])
export type TrafficEventEntry = z.infer<typeof trafficEventEntrySchema>

export const trafficEventsResponseSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  totals: z.object({
    crawlerHits: z.number().int().nonnegative(),
    aiReferralHits: z.number().int().nonnegative(),
  }),
  events: z.array(trafficEventEntrySchema),
})
export type TrafficEventsResponse = z.infer<typeof trafficEventsResponseSchema>
