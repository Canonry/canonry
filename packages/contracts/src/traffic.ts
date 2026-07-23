import { z } from 'zod'
import { runStatusSchema } from './run.js'
import type { TrafficCrawlerSegments, TrafficPathClass } from './traffic-path.js'

/**
 * Per-class breakdown of crawler hits (content / sitemap / robots / asset /
 * other). Read-time segmentation of `crawlerHits` so the headline "content was
 * crawled" number is not inflated by sitemap/robots polling and asset fetches.
 * The five buckets always sum to the total `crawlerHits`. `satisfies` ties the
 * schema to the {@link TrafficCrawlerSegments} helper interface so the two
 * cannot drift.
 */
export const trafficCrawlerSegmentsSchema = z.object({
  content: z.number().int().nonnegative(),
  sitemap: z.number().int().nonnegative(),
  robots: z.number().int().nonnegative(),
  asset: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
}) satisfies z.ZodType<TrafficCrawlerSegments>

export const trafficPathClassSchema = z.enum([
  'content',
  'sitemap',
  'robots',
  'asset',
  'other',
]) satisfies z.ZodType<TrafficPathClass>

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
// a UA-only match stays `claimed_unverified` unless the source IP falls in the
// operator's published range; `unknown_ai_like` is reserved for behavioral
// heuristics.
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

/**
 * Persisted in `traffic_sources.configJson` for `sourceType = 'wordpress'`.
 * Credentials (Application Password) live in `~/.canonry/config.yaml`, never here.
 */
export const wordpressTrafficSourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  username: z.string().min(1),
})
export type WordpressTrafficSourceConfig = z.infer<typeof wordpressTrafficSourceConfigSchema>

export const vercelTrafficEnvironmentSchema = z.enum(['production', 'preview'])
export type VercelTrafficEnvironment = z.infer<typeof vercelTrafficEnvironmentSchema>
export const VercelTrafficEnvironments = vercelTrafficEnvironmentSchema.enum

/**
 * Persisted in `traffic_sources.configJson` for `sourceType = 'vercel'`.
 * The Vercel API token lives in `~/.canonry/config.yaml`, never here.
 */
export const vercelTrafficSourceConfigSchema = z.object({
  /** Vercel project id (e.g. `prj_...`). */
  projectId: z.string().min(1),
  /** Vercel team or account id: the org that owns the project. */
  teamId: z.string().min(1),
  environment: vercelTrafficEnvironmentSchema,
})
export type VercelTrafficSourceConfig = z.infer<typeof vercelTrafficSourceConfigSchema>

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

export const trafficConnectWordpressRequestSchema = z.object({
  baseUrl: z.string().url(),
  username: z.string().min(1),
  /** WordPress Application Password (the same auth used by the content client). */
  applicationPassword: z.string().min(1),
  displayName: z.string().min(1).optional(),
})
export type TrafficConnectWordpressRequest = z.infer<typeof trafficConnectWordpressRequestSchema>

export const trafficConnectVercelRequestSchema = z.object({
  /** Vercel project id (e.g. `prj_...`) — from the Vercel dashboard or `.vercel/project.json`. */
  projectId: z.string().min(1),
  /** Vercel team or account id: the org that owns the project ("orgId" in .vercel/project.json). */
  teamId: z.string().min(1),
  /** Vercel personal access token. Stored in `~/.canonry/config.yaml`, never the DB. */
  token: z.string().min(1),
  /** Which deployment environment's request logs to pull. Default: `production`. */
  environment: vercelTrafficEnvironmentSchema.optional(),
  displayName: z.string().min(1).optional(),
})
export type TrafficConnectVercelRequest = z.infer<typeof trafficConnectVercelRequestSchema>

export const trafficSyncResponseSchema = z.object({
  sourceId: z.string(),
  runId: z.string(),
  syncedAt: z.string(),
  pulledEvents: z.number().int().nonnegative(),
  /** Self-traffic events (Canonry's own tooling) dropped before rollup. */
  selfTrafficExcluded: z.number().int().nonnegative(),
  crawlerHits: z.number().int().nonnegative(),
  aiUserFetchHits: z.number().int().nonnegative(),
  aiReferralHits: z.number().int().nonnegative(),
  unknownHits: z.number().int().nonnegative(),
  crawlerBucketRows: z.number().int().nonnegative(),
  aiUserFetchBucketRows: z.number().int().nonnegative(),
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
 * Operator recovery: advance `lastSyncedAt` to NOW and clear the error state
 * so subsequent scheduled syncs resume from a recent timestamp. Used when an
 * idle source's `lastSyncedAt` has aged past the upstream's retention window
 * (Vercel `request-logs`, Cloud Logging) and every sync now throws a
 * retention error. Skipped history is the explicit trade-off; the operator
 * runs `traffic backfill` separately if they want to recover any of it.
 *
 * `advanceToNow` must be `true` — there is no implicit reset. The schema
 * rejects `false` / missing to keep the call sites self-documenting.
 */
export const trafficResetRequestSchema = z.object({
  advanceToNow: z.literal(true),
})
export type TrafficResetRequest = z.infer<typeof trafficResetRequestSchema>

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
  /**
   * Total classified-crawler hits in the window. UNCHANGED contract — still the
   * full count across every path class. Use `crawlerContentHits` for the
   * "content was actually crawled" signal.
   */
  crawlerHits: z.number().int().nonnegative(),
  /** Crawler hits against content/document paths only (= `crawlerSegments.content`). */
  crawlerContentHits: z.number().int().nonnegative(),
  /** Infrastructure crawler hits — sitemap + robots + asset fetches (`crawlerSegments.{sitemap,robots,asset}`). */
  crawlerInfraHits: z.number().int().nonnegative(),
  /** Full per-class crawler-hit breakdown; the five buckets sum to `crawlerHits`. */
  crawlerSegments: trafficCrawlerSegmentsSchema,
  aiUserFetchHits: z.number().int().nonnegative(),
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

export const trafficEventKindSchema = z.enum(['crawler', 'ai-user-fetch', 'ai-referral'])
export type TrafficEventKind = z.infer<typeof trafficEventKindSchema>
export const TrafficEventKinds = trafficEventKindSchema.enum

export const trafficSeriesGranularitySchema = z.enum(['hour', 'day'])
export type TrafficSeriesGranularity = z.infer<typeof trafficSeriesGranularitySchema>
export const TrafficSeriesGranularities = trafficSeriesGranularitySchema.enum

export const trafficSeriesPointSchema = z.object({
  /**
   * UTC bucket key: an ISO hour for hourly series, or `YYYY-MM-DD` for daily
   * series. The response includes zero-value buckets across the full window.
   */
  bucket: z.string(),
  crawlerHits: z.number().int().nonnegative(),
  aiUserFetchHits: z.number().int().nonnegative(),
  aiReferralHits: z.number().int().nonnegative(),
})
export type TrafficSeriesPoint = z.infer<typeof trafficSeriesPointSchema>

export const trafficCrawlerEventEntrySchema = z.object({
  kind: z.literal(TrafficEventKinds.crawler),
  sourceId: z.string(),
  tsHour: z.string(),
  botId: z.string(),
  operator: z.string(),
  verificationStatus: z.string(),
  pathNormalized: z.string(),
  /** Coarse class of the fetched path — lets the UI split content crawls from sitemap/robots/asset polling. */
  pathClass: trafficPathClassSchema,
  status: z.number().int(),
  hits: z.number().int().nonnegative(),
})
export type TrafficCrawlerEventEntry = z.infer<typeof trafficCrawlerEventEntrySchema>

// On-demand per-user fetch from an AI surface (e.g. ChatGPT-User clicking a
// citation, Perplexity-User fetching a referenced URL). UA-evidenced like a
// crawler, but with a real user in the loop — kept in its own kind so the
// dashboard / API / CLI don't conflate machine crawl with human-driven fetch.
export const trafficAiUserFetchEventEntrySchema = z.object({
  kind: z.literal(TrafficEventKinds['ai-user-fetch']),
  sourceId: z.string(),
  tsHour: z.string(),
  botId: z.string(),
  operator: z.string(),
  verificationStatus: z.string(),
  pathNormalized: z.string(),
  status: z.number().int(),
  hits: z.number().int().nonnegative(),
})
export type TrafficAiUserFetchEventEntry = z.infer<typeof trafficAiUserFetchEventEntrySchema>

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
  /** Total AI-referral sessions in the bucket. `paidHits + organicHits + unknownHits === hits`. */
  hits: z.number().int().nonnegative(),
  /** Sessions carrying paid-attribution UTM evidence (`utm_medium=cpc`, …). */
  paidHits: z.number().int().nonnegative(),
  /** Sessions with no paid-attribution evidence. Not proof the click was unpaid — an untagged ad click is indistinguishable. */
  organicHits: z.number().int().nonnegative(),
  /**
   * Sessions ingested before the classifier shipped. Their UTM tags were never
   * persisted, so they can never be resolved to paid or organic. Never fold
   * these into `organicHits`.
   */
  unknownHits: z.number().int().nonnegative(),
})
export type TrafficAiReferralEventEntry = z.infer<typeof trafficAiReferralEventEntrySchema>

export const trafficEventEntrySchema = z.discriminatedUnion('kind', [
  trafficCrawlerEventEntrySchema,
  trafficAiUserFetchEventEntrySchema,
  trafficAiReferralEventEntrySchema,
])
export type TrafficEventEntry = z.infer<typeof trafficEventEntrySchema>

export const trafficEventsResponseSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  /**
   * Full-window chart data, aggregated independently from the capped detail
   * rows below. This prevents dense windows from silently losing old buckets.
   */
  series: z.object({
    granularity: trafficSeriesGranularitySchema,
    points: z.array(trafficSeriesPointSchema),
  }),
  totals: z.object({
    /** Total classified-crawler hits across the window. UNCHANGED contract. */
    crawlerHits: z.number().int().nonnegative(),
    /** Crawler hits against content/document paths only (= `crawlerSegments.content`). */
    crawlerContentHits: z.number().int().nonnegative(),
    /** Infrastructure crawler hits — sitemap + robots + asset fetches. */
    crawlerInfraHits: z.number().int().nonnegative(),
    /** Full per-class crawler-hit breakdown; the five buckets sum to `crawlerHits`. */
    crawlerSegments: trafficCrawlerSegmentsSchema,
    aiUserFetchHits: z.number().int().nonnegative(),
    /** Total AI-referral sessions. The three class buckets below sum to it. */
    aiReferralHits: z.number().int().nonnegative(),
    /** AI-referral sessions carrying paid-attribution UTM evidence. */
    aiReferralPaidHits: z.number().int().nonnegative(),
    /** AI-referral sessions with no paid-attribution evidence. */
    aiReferralOrganicHits: z.number().int().nonnegative(),
    /** AI-referral sessions ingested before the classifier shipped; unresolvable, never organic. */
    aiReferralUnknownHits: z.number().int().nonnegative(),
  }),
  eventRows: z.object({
    /** Total detail rows matching the window/source/kind filters before `limit`. */
    total: z.number().int().nonnegative(),
    /** Number of newest detail rows included in `events`. */
    returned: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  events: z.array(trafficEventEntrySchema),
})
export type TrafficEventsResponse = z.infer<typeof trafficEventsResponseSchema>
