import { linearTrendSchema } from './statistics.js'
import { z } from 'zod'
import { runStatusSchema } from './run.js'
import { aiReferralTrafficClassSchema } from './traffic-class.js'
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

/**
 * Exact bundled IP-range manifest used when a crawler or AI user-fetch event
 * was classified. Persisting this provenance keeps historical verification
 * results auditable after an operator publishes a newer range list.
 */
export const trafficVerificationManifestSchema = z.object({
  /** Stable identity: source + publisher version + canonical prefix-content digest. */
  id: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
})
export type TrafficVerificationManifest = z.infer<typeof trafficVerificationManifestSchema>

export const trafficVerificationManifestUsageSchema = z.object({
  manifestId: z.string().min(1),
  manifest: trafficVerificationManifestSchema.nullable(),
  hits: z.number().int().nonnegative(),
})
export type TrafficVerificationManifestUsage = z.infer<typeof trafficVerificationManifestUsageSchema>

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
  /**
   * Newest instant a sync clamped past instead of ingesting, or null when no
   * skip is outstanding. Non-null means this source has a known gap in its
   * history that only a repair with proven source coverage can close — it does
   * not clear when the watermark catches up, because catching up is exactly
   * what the skipping sync did. WordPress generic replace-mode backfill is
   * deliberately unavailable because the retained feed cannot prove coverage.
   */
  skippedThroughAt: z.string().nullable(),
  /** Residual Cloudflare Queue depth reported by the most recent bounded pull. */
  queueBacklogCount: z.number().int().nonnegative().nullable(),
  /** Instant at which `queueBacklogCount` was observed, or null before the first pull. */
  queueBacklogObservedAt: z.string().nullable(),
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

/**
 * How a Cloudflare edge Worker hands selected request events to Canonry.
 * Direct push and Queue pull share edge capture but use distinct delivery
 * credentials and lifecycle semantics.
 */
export const cloudflareTrafficDeliveryModeSchema = z.enum(['direct-push', 'queue-pull'])
export type CloudflareTrafficDeliveryMode = z.infer<typeof cloudflareTrafficDeliveryModeSchema>
export const CloudflareTrafficDeliveryModes = cloudflareTrafficDeliveryModeSchema.enum

/** Cloudflare Queue names are 1-63 alphanumeric/dash characters with alphanumeric ends. */
export const cloudflareQueueNameSchema = z.string().regex(
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
  'Cloudflare Queue name must be 1-63 characters, use only letters, numbers, or dashes, and start and end with a letter or number',
)

/**
 * Persisted in `traffic_sources.configJson` for `sourceType = 'cloudflare'`.
 * The per-source bearer token + HMAC secret never live here — they go to
 * `~/.canonry/config.yaml` under `cloudflareTraffic.connections.<sourceId>`.
 * The DB only carries the sha256 hash of the bearer for verification.
 *
 * Missing `deliveryMode` means `direct-push` so source rows written before the
 * transport discriminator was introduced continue to parse unchanged.
 */
const cloudflareTrafficSourceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  /** Semver of the Worker script bundle that was generated at connect/rotate time. */
  workerVersion: z.string().min(1),
  /** Identifier of the bot/referer keyword set baked into the deployed Worker. */
  expectedBotListVersion: z.string().min(1),
  /** Target Cloudflare zone for the operator-managed Worker route. */
  zoneId: z.string().nullable(),
})

export const cloudflareDirectPushTrafficSourceConfigSchema = cloudflareTrafficSourceBaseSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['direct-push']),
  /** Cloudflare account id used to target the correct account during Wrangler deploy. */
  accountId: z.string().nullable(),
})

export const cloudflareQueuePullTrafficSourceConfigSchema = cloudflareTrafficSourceBaseSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['queue-pull']),
  /** Cloudflare account that owns the Queue. */
  accountId: z.string().min(1),
  /** Cloudflare Queue id used by Canonry's pull consumer. */
  queueId: z.string().min(1),
  /** Queue producer binding target written to the generated Wrangler file. */
  queueName: cloudflareQueueNameSchema,
  /** Operator-recorded Queue retention for configuration drift checks. */
  retentionSeconds: z.number().int().min(60).max(1_209_600),
})

function defaultCloudflareDeliveryMode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return 'deliveryMode' in record ? value : { ...record, deliveryMode: 'direct-push' }
}

export const cloudflareTrafficSourceConfigSchema = z.preprocess(
  defaultCloudflareDeliveryMode,
  z.discriminatedUnion('deliveryMode', [
    cloudflareDirectPushTrafficSourceConfigSchema,
    cloudflareQueuePullTrafficSourceConfigSchema,
  ]),
)
export type CloudflareTrafficSourceConfig = z.infer<typeof cloudflareTrafficSourceConfigSchema>

/** @deprecated Use `cloudflareTrafficSourceConfigSchema`. */
export const cloudflareWorkerSourceConfigSchema = cloudflareTrafficSourceConfigSchema
/** @deprecated Use `CloudflareTrafficSourceConfig`. */
export type CloudflareWorkerSourceConfig = CloudflareTrafficSourceConfig

const trafficConnectCloudflareBaseRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  /** Target Cloudflare zone. Canonry does not validate it against Cloudflare. */
  zoneId: z.string().min(1).optional(),
})

export const trafficConnectCloudflareDirectPushRequestSchema = trafficConnectCloudflareBaseRequestSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['direct-push']),
  /** Cloudflare account id. Set it when Wrangler can access more than one account. */
  accountId: z.string().min(1).optional(),
})

export const trafficConnectCloudflareQueuePullRequestSchema = trafficConnectCloudflareBaseRequestSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['queue-pull']),
  accountId: z.string().min(1),
  queueId: z.string().min(1),
  queueName: cloudflareQueueNameSchema,
  retentionSeconds: z.number().int().min(60).max(1_209_600),
  /** Queue pull token; secret-store only, never persisted in configJson or returned. */
  apiToken: z.string().min(1),
})

export const trafficConnectCloudflareRequestSchema = z.preprocess(
  defaultCloudflareDeliveryMode,
  z.discriminatedUnion('deliveryMode', [
    trafficConnectCloudflareDirectPushRequestSchema,
    trafficConnectCloudflareQueuePullRequestSchema,
  ]),
)
export type TrafficConnectCloudflareRequest = z.infer<typeof trafficConnectCloudflareRequestSchema>

/**
 * Returned by `POST /traffic/connect/cloudflare`. The operator deploys the
 * generated Worker script to their Cloudflare zone. Direct push installs
 * per-source bearer + HMAC Worker bindings; Queue pull keeps its API token in
 * Canonry and emits only a producer binding. No secret is returned in source
 * or Wrangler configuration.
 */
const trafficConnectCloudflareResponseBaseSchema = z.object({
  sourceId: z.string().min(1),
  workerScript: z.string().min(1),
  wranglerToml: z.string().min(1),
  workerVersion: z.string().min(1),
  instructions: z.string().min(1),
})

export const trafficConnectCloudflareDirectPushResponseSchema = trafficConnectCloudflareResponseBaseSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['direct-push']),
  activationRequired: z.boolean().default(false),
})

export const trafficConnectCloudflareQueuePullResponseSchema = trafficConnectCloudflareResponseBaseSchema.extend({
  deliveryMode: z.literal(CloudflareTrafficDeliveryModes['queue-pull']),
  activationRequired: z.boolean().default(false),
  accountId: z.string().min(1),
  queueId: z.string().min(1),
  queueName: cloudflareQueueNameSchema,
  retentionSeconds: z.number().int().min(60).max(1_209_600),
})

export const trafficConnectCloudflareResponseSchema = z.discriminatedUnion('deliveryMode', [
  trafficConnectCloudflareDirectPushResponseSchema,
  trafficConnectCloudflareQueuePullResponseSchema,
])
export type TrafficConnectCloudflareResponse = z.infer<typeof trafficConnectCloudflareResponseSchema>

/**
 * One transport-neutral event observed by a Cloudflare edge Worker. Direct
 * push and the later Queue pull adapter share this exact shape. Every
 * non-mandatory field is nullable — `cf.*` properties depend on the customer's
 * plan tier and are absent on free/Pro plans without Bot Management.
 */
export const cloudflareEdgeEventSchema = z.object({
  /** Cloudflare `cf-ray` request id — globally unique per request. */
  eventId: z.string().min(1),
  observedAt: z.string().datetime(),
  method: z.string().nullable(),
  host: z.string().nullable(),
  path: z.string().min(1),
  queryString: z.string().nullable(),
  status: z.number().int().nullable(),
  userAgent: z.string().nullable(),
  remoteIp: z.string().nullable(),
  referer: z.string().nullable(),
  cf: z.object({
    verifiedBot: z.boolean().nullable(),
    botScore: z.number().int().nullable(),
    country: z.string().nullable(),
    asn: z.number().int().nullable(),
    asOrganization: z.string().nullable(),
  }).nullable(),
})
export type CloudflareEdgeEvent = z.infer<typeof cloudflareEdgeEventSchema>

/** @deprecated Use `cloudflareEdgeEventSchema`. */
export const cloudflareWorkerEventSchema = cloudflareEdgeEventSchema
/** @deprecated Use `CloudflareEdgeEvent`. */
export type CloudflareWorkerEvent = CloudflareEdgeEvent

/**
 * Transport-neutral batch emitted by the edge Worker. Direct push sends this
 * as the ingest request body; Queue pull stores and later reads the same shape.
 */
export const cloudflareEdgeEventBatchSchema = z.object({
  schemaVersion: z.literal(1),
  workerVersion: z.string().min(1),
  events: z.array(cloudflareEdgeEventSchema).min(1).max(100),
})
export type CloudflareEdgeEventBatch = z.infer<typeof cloudflareEdgeEventBatchSchema>

/** @deprecated Direct push compatibility alias; use `cloudflareEdgeEventBatchSchema`. */
export const cloudflareWorkerIngestRequestSchema = cloudflareEdgeEventBatchSchema
/** @deprecated Use `CloudflareEdgeEventBatch`. */
export type CloudflareWorkerIngestRequest = CloudflareEdgeEventBatch

/**
 * Acknowledgement returned by `POST /traffic/cloudflare/ingest`. `acceptedEvents`
 * is the count that normalized and reached the rollup pipeline.
 * `droppedEvents` includes normalization failures and duplicate durable receipts.
 * The `*BucketRows` / `sampleRows` fields report how many hourly-rollup and
 * sample rows the batch touched —
 * diagnostic only; the Worker ignores the body.
 */
export const cloudflareWorkerIngestResponseSchema = z.object({
  acceptedEvents: z.number().int(),
  droppedEvents: z.number().int(),
  workerVersionAck: z.string(),
  crawlerBucketRows: z.number().int(),
  aiUserFetchBucketRows: z.number().int(),
  aiReferralBucketRows: z.number().int(),
  sampleRows: z.number().int(),
})
export type CloudflareWorkerIngestResponse = z.infer<typeof cloudflareWorkerIngestResponseSchema>

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
  /** Residual upstream Queue depth after a bounded sync; present for Queue pull. */
  remainingBacklogCount: z.number().int().nonnegative().optional(),
  windowStart: z.string(),
  windowEnd: z.string(),
})
export type TrafficSyncResponse = z.infer<typeof trafficSyncResponseSchema>

export const trafficBackfillRequestSchema = z.object({
  /** Lookback window in days. Default: 30; capped server-side at the adapter ceiling. WordPress always requires a retention-aware repair, not this generic replace operation. */
  days: z.number().int().positive().optional(),
})
export type TrafficBackfillRequest = z.infer<typeof trafficBackfillRequestSchema>

/**
 * Operator recovery: advance `lastSyncedAt` to NOW and clear the error state
 * so subsequent scheduled syncs resume from a recent timestamp. Used when an
 * idle source's `lastSyncedAt` has aged past the upstream's retention window
 * (Vercel `request-logs`, Cloud Logging) and every sync now throws a
 * retention error. Skipped history is the explicit trade-off. A WordPress
 * reset also clears its continuation cursor and pending-window marker, then
 * records an unrecovered skip through the reset instant. It starts at the new
 * watermark rather than resuming an old partial drain, which prevents replay;
 * it is not a historical repair. WordPress generic replace-mode backfill is
 * unavailable because the retained feed cannot prove coverage.
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
  /**
   * Every request carrying AI-origin evidence. UNCHANGED contract — still the
   * full count across every status. Use `aiReferralLandedHits` for the
   * "someone actually arrived" signal.
   */
  aiReferralHits: z.number().int().nonnegative(),
  /**
   * Countable referral SESSIONS: excludes requests answered with a proven
   * Location redirect (301/302/303/307/308) AND static subresource fetches,
   * matching the report's predicate exactly. This is the figure to present as
   * visits, visitors, sessions or arrivals. "Not proven" on the redirect half:
   * a source that never observed a status stores 0, and an unobserved status
   * is not a hop, so those rows count — the benefit-of-the-doubt default.
   * `landed + redirected <= total`; the gap is subresource noise, which is
   * neither a session nor a hop.
   */
  aiReferralLandedHits: z.number().int().nonnegative(),
  /**
   * Referral hits answered with a Location redirect. The visitor got no
   * content here; the destination raises its own row when it carries the same
   * evidence, so counting these as arrivals double-counts one person. A site
   * where this is most of the total is a finding in itself: its AI arrivals
   * all bounce off a redirect.
   */
  aiReferralRedirectedHits: z.number().int().nonnegative(),
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
  /**
   * The part of `aiReferralHits` not answered with a Location redirect — the
   * series to chart under any label that says sessions or visits.
   */
  aiReferralLandedHits: z.number().int().nonnegative(),
  /**
   * The part of `crawlerHits` that is a real content page, excluding robots,
   * sitemaps and assets. `crawlerHits` keeps its full-count contract; this is
   * the series to chart under any label that says "pages crawled", because a
   * sitemap re-fetch is not a page an engine read.
   */
  crawlerContentHits: z.number().int().nonnegative(),
  /**
   * False for a bucket that predates any observation for this project, i.e.
   * before `series.coverageStart`. Such a bucket reads 0 because nothing was
   * being recorded, NOT because nothing happened, and a chart must not draw
   * those as a measured zero. Derived here rather than in a component so the
   * CLI draws the same distinction.
   */
  measured: z.boolean(),
})
export type TrafficSeriesPoint = z.infer<typeof trafficSeriesPointSchema>

export const trafficCrawlerEventEntrySchema = z.object({
  kind: z.literal(TrafficEventKinds.crawler),
  sourceId: z.string(),
  tsHour: z.string(),
  botId: z.string(),
  operator: z.string(),
  verificationStatus: z.string(),
  verificationManifests: z.array(trafficVerificationManifestUsageSchema).optional(),
  verificationUnattributedHits: z.number().int().nonnegative().optional(),
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
  verificationManifests: z.array(trafficVerificationManifestUsageSchema).optional(),
  verificationUnattributedHits: z.number().int().nonnegative().optional(),
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
    /**
     * Earliest event ever observed for this project, across ALL of its traffic
     * sources, or null when nothing has been recorded. Buckets before it were
     * not measured. Earliest-across-sources is deliberate: the band answers
     * "before this we have nothing", and if any source has data we do not have
     * nothing. The cost is that a source connected much later hides its own
     * early gap, which is the better error than marking real data unmeasured.
     */
    coverageStart: z.string().nullable(),
    /**
     * Least-squares fit per charted metric, over the densified points.
     *
     * Fitted HERE rather than in a chart component: a regression computed in the
     * UI is invisible to the CLI and to any other consumer, which is the
     * UI/CLI parity rule. `null` for a metric with fewer than two observations,
     * so a caller renders "no trend" instead of a fabricated flat line.
     */
    trends: z.object({
      crawlerContentHits: linearTrendSchema.nullable(),
      aiUserFetchHits: linearTrendSchema.nullable(),
      aiReferralLandedHits: linearTrendSchema.nullable(),
    }),
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
    /**
     * Every AI-referral request in the window, whatever the server answered.
     * NOT a session count: use `aiReferralLandedHits` for anything presented
     * as sessions or visits. The three class buckets sum to the LANDED figure,
     * because a redirect hop's paid tags are not a paid session.
     */
    aiReferralHits: z.number().int().nonnegative(),
    /**
     * Countable referral SESSIONS: no redirect hops, no static subresource
     * fetches — the same predicate the report uses, so windowed totals here
     * and report arrivals cannot disagree.
     */
    aiReferralLandedHits: z.number().int().nonnegative(),
    /** Referral hits answered with a Location redirect — hops, not arrivals. */
    aiReferralRedirectedHits: z.number().int().nonnegative(),
    /** LANDED sessions carrying paid-attribution UTM evidence. */
    aiReferralPaidHits: z.number().int().nonnegative(),
    /** LANDED sessions with no paid-attribution evidence. */
    aiReferralOrganicHits: z.number().int().nonnegative(),
    /** LANDED sessions ingested before the classifier shipped; unresolvable, never organic. */
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


export const trafficSampleKindSchema = z.enum(['crawler', 'ai-user-fetch', 'ai-referral', 'unknown'])
export type TrafficSampleKind = z.infer<typeof trafficSampleKindSchema>
export const TrafficSampleKinds = trafficSampleKindSchema.enum

export const trafficSamplesQuerySchema = z.object({
  kind: z.enum(['crawler', 'ai-user-fetch', 'ai-referral', 'unknown', 'all']).optional(),
  sourceId: z.string().min(1).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict()
export type TrafficSamplesQuery = z.infer<typeof trafficSamplesQuerySchema>

// Stored classifier evidence may come from an install upgraded within the
// retention window. Inner fields may be absent or null; unknown fields are stripped.
const sampleUserFetchSchema = z.object({
  botId: z.string().nullish(),
  operator: z.string().nullish(),
  product: z.string().nullish(),
  verificationStatus: verificationStatusSchema.nullish(),
  verificationManifest: z.object({ id: z.string().nullish(), source: z.string().nullish(), version: z.string().nullish() }).nullish(),
  matchedUserAgent: z.string().nullish(),
})
export const trafficSampleClassifierSchema = z.object({
  crawler: sampleUserFetchSchema.extend({ purpose: z.string().nullish() }).nullable().default(null),
  aiUserFetch: sampleUserFetchSchema.nullable().default(null),
  aiReferral: z.object({
    operator: z.string().nullish(), product: z.string().nullish(), sourceDomain: z.string().nullish(),
    evidenceType: z.enum(['referer', 'utm', 'referer-utm']).nullish(), trafficClass: aiReferralTrafficClassSchema.nullish(),
  }).nullable().default(null),
})
export type TrafficSampleClassifier = z.infer<typeof trafficSampleClassifierSchema>
export const trafficSampleDtoSchema = z.object({
  id: z.string(), sourceId: z.string(), ts: z.string(), kind: trafficSampleKindSchema,
  pathNormalized: z.string(), status: z.number().int().nullable(), refererHost: z.string().nullable(), userAgent: z.string().nullable(),
  classifier: trafficSampleClassifierSchema,
})
export type TrafficSampleDto = z.infer<typeof trafficSampleDtoSchema>
export const trafficSamplesResponseSchema = z.object({
  scope: z.object({ project: z.string(), sourceId: z.string().nullable(), attribution: z.literal('project-source-only'), unavailableDimensions: z.array(z.enum(['property', 'target', 'market'])) }),
  windowStart: z.string(), windowEnd: z.string(), retentionDays: z.literal(30),
  sampling: z.object({ complete: z.literal(false), perSync: z.literal(100), perBackfill: z.literal(500), perPushHour: z.literal(100) }),
  totalRows: z.number().int().nonnegative(), limit: z.number().int(), offset: z.number().int(), samples: z.array(trafficSampleDtoSchema),
})
export type TrafficSamplesResponse = z.infer<typeof trafficSamplesResponseSchema>
