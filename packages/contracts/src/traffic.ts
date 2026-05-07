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
