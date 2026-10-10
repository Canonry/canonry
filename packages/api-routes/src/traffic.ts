import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { countableReferralCondition, referralLandedCondition } from './ai-referral-status.js'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { CURRENT_CLOUDFLARE_WORKER_VERSION } from './cloudflare-worker-version.js'
import {
  CLOUDFLARE_QUEUE_BATCH_SIZE,
  DEFAULT_CLOUDFLARE_QUEUE_MAX_BATCHES,
  DEFAULT_VERCEL_SYNC_DEADLINE_MS,
  VERCEL_MAX_SYNC_WINDOW_MS,
} from './traffic-limits.js'
import {
  trafficSources,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  aiUserFetchEventsHourly,
  aiUserFetchVerificationManifestsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
  schedules,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  aiReferralClassCounts,
  nextScheduleUpdatedAt,
  notFound,
  operationInProgress,
  providerError,
  validationError,
  RunKinds,
  RunStatuses,
  RunTriggers,
  SchedulableRunKinds,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  TrafficSourceAuthModes,
  TrafficEventKinds,
  TrafficSeriesGranularities,
  CloudflareTrafficDeliveryModes,
  cloudflareTrafficSourceConfigSchema,
  trafficConnectWordpressRequestSchema,
  trafficConnectVercelRequestSchema,
  trafficResetRequestSchema,
  classifyTrafficPath,
  linearTrend,
  TrafficPathClasses,
  segmentCrawlerHits,
  sumInfraHits,
  describeError,
  bucketDuration,
  OutcomeReasonCodes,
  OutcomeStatuses,
} from '@ainyc/canonry-contracts'
import type {
  NormalizedTrafficRequest,
  OutcomeReasonCode,
  RunStatus,
  SchedulableRunKind,
  TrafficSourceDto,
  TrafficSourceDetailDto,
  TrafficSourceListResponse,
  TrafficStatusResponse,
  TrafficSyncResponse,
  TrafficBackfillResponse,
  TrafficSourceStatus,
  TrafficSourceAuthMode,
  TrafficConnectCloudflareRequest,
  TrafficCrawlerEventEntry,
  TrafficAiUserFetchEventEntry,
  TrafficEventEntry,
  TrafficEventKind,
  TrafficEventsResponse,
  TrafficSeriesGranularity,
  TrafficSeriesPoint,
} from '@ainyc/canonry-contracts'
import {
  listCloudRunTrafficEvents,
  getCloudLoggingAccessToken,
} from '@ainyc/canonry-integration-cloud-run'
import type {
  CloudRunTrafficEventsPage,
  ListCloudRunTrafficEventsOptions,
} from '@ainyc/canonry-integration-cloud-run'
import { buildTrafficProbeReport, isSelfTraffic } from '@ainyc/canonry-integration-traffic'
import {
  listWordpressTrafficEvents,
  WordpressTrafficApiError,
} from '@ainyc/canonry-integration-wordpress-traffic'
import type {
  ListWordpressTrafficEventsOptions,
  WordpressTrafficEventsPage,
} from '@ainyc/canonry-integration-wordpress-traffic'
import {
  drainVercelTrafficEvents,
  listVercelTrafficEvents,
  VercelLogsApiError,
} from '@ainyc/canonry-integration-vercel'
import type {
  ListVercelTrafficEventsOptions,
  VercelTrafficEventsPage,
} from '@ainyc/canonry-integration-vercel'
import {
  DEFAULT_BOT_LIST,
  generateWorkerScript,
  generateWranglerToml,
  normalizeCloudflareWorkerEvent,
  verifyRequestSignature,
} from '@ainyc/canonry-integration-cloudflare-worker'
import {
  ackCloudflareQueueMessages,
  CloudflareQueueApiError,
  pullCloudflareQueueMessages,
} from '@ainyc/canonry-integration-cloudflare-queue'
import type {
  AckCloudflareQueueMessagesOptions,
  CloudflareQueueAckResult,
  CloudflareQueueClientOptions,
  CloudflareQueuePullResult,
  PullCloudflareQueueMessagesOptions,
} from '@ainyc/canonry-integration-cloudflare-queue'
import {
  cloudflareWorkerIngestRequestSchema,
  trafficConnectCloudflareRequestSchema,
  authRequired,
} from '@ainyc/canonry-contracts'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { connectionRoute, routeOutcomeFailure, webhookTargetRefusalReason, type ConnectionAttempt, type ConnectionSubject } from './connection-telemetry.js'
import { createGuardedFetch, EgressFailedError, EgressRefusedError } from './guarded-fetch.js'
import { resolveWebhookTarget } from './webhooks.js'
import { failedOutcome, reportFeatureOutcome, withFeatureOutcome, type FeatureOutcome } from './feature-outcome.js'
import { currentOutcomeAttribution } from './request-context.js'
import {
  DIRECT_PUSH_RECEIPT_TTL_MS,
  writeTrafficEventBatch,
} from './traffic-event-ingest.js'
import {
  enforceGlobalRawEventSampleRetention,
  enforceRawEventSampleRetention,
  RAW_EVENT_SAMPLE_RETENTION_SWEEP_INTERVAL_MS,
  retainedRawEventSampleTimestamp,
} from './raw-event-sample-retention.js'
import { releaseTrafficSyncLease, tryClaimTrafficSyncLease } from './traffic-sync-lease.js'

export interface CloudRunCredentialRecord {
  projectName: string
  gcpProjectId: string
  serviceName?: string
  location?: string
  authMode: TrafficSourceAuthMode
  clientEmail?: string
  privateKey?: string
  refreshToken?: string
  tokenExpiresAt?: string
  scopes?: string[]
  createdAt: string
  updatedAt: string
}

export interface CloudRunCredentialStore {
  getConnection: (projectName: string) => CloudRunCredentialRecord | undefined
  upsertConnection: (record: CloudRunCredentialRecord) => CloudRunCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface WordpressTrafficCredentialRecord {
  projectName: string
  baseUrl: string
  username: string
  applicationPassword: string
  createdAt: string
  updatedAt: string
}

export interface WordpressTrafficCredentialStore {
  getConnection: (projectName: string) => WordpressTrafficCredentialRecord | undefined
  upsertConnection: (record: WordpressTrafficCredentialRecord) => WordpressTrafficCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface VercelTrafficCredentialRecord {
  projectName: string
  /** Vercel project id (`prj_...`). */
  projectId: string
  /** Vercel team / owner id (`team_...`). */
  teamId: string
  /** Vercel API token (personal access token). The only secret in this record. */
  token: string
  /** Deployment environment whose request logs are pulled. */
  environment: 'production' | 'preview'
  createdAt: string
  updatedAt: string
}

export interface VercelTrafficCredentialStore {
  getConnection: (projectName: string) => VercelTrafficCredentialRecord | undefined
  upsertConnection: (record: VercelTrafficCredentialRecord) => VercelTrafficCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

interface CloudflareTrafficCredentialBase {
  projectName: string
  /** Discriminator for the credential/auth mechanism used by this source. */
  /** `traffic_sources.id` — pairs the credential row with the DB row. */
  sourceId: string
  /** Present only for direct-push records; optional preserves safe legacy-store inspection. */
  bearerToken?: string
  /** Present only for direct-push records; optional preserves safe legacy-store inspection. */
  hmacSecret?: string
  /** Semver of the Worker script bundle that was generated at connect/rotate time. */
  workerVersion: string
  /** Identifier of the bot/referer keyword set baked into the deployed Worker. */
  expectedBotListVersion: string
  zoneId: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudflareDirectPushTrafficCredentialRecord extends CloudflareTrafficCredentialBase {
  deliveryMode: 'direct-push'
  /** Bearer token authenticating ingest requests. Verified against sha256(bearer) === ingestTokenHash. */
  bearerToken: string
  /** HMAC-SHA256 shared secret. */
  hmacSecret: string
  accountId: string | null
}

export interface CloudflareQueuePullTrafficCredentialRecord extends CloudflareTrafficCredentialBase {
  deliveryMode: 'queue-pull'
  /** Account-scoped Queue read/write token; config store only. */
  apiToken: string
  accountId: string
  queueId: string
  queueName: string
  retentionSeconds: number
}

export type CloudflareTrafficCredentialRecord =
  | CloudflareDirectPushTrafficCredentialRecord
  | CloudflareQueuePullTrafficCredentialRecord

export interface CloudflareTrafficCredentialStore {
  getConnection: (projectName: string) => CloudflareTrafficCredentialRecord | undefined
  /** Used by the ingest endpoint to resolve creds from `X-Canonry-Source-Id`. */
  getConnectionBySourceId: (sourceId: string) => CloudflareTrafficCredentialRecord | undefined
  upsertConnection: (record: CloudflareTrafficCredentialRecord) => CloudflareTrafficCredentialRecord
  deleteConnection: (projectName: string) => boolean
  /** Optional while legacy stores migrate from project-name to source-id keys. */
  deleteConnectionBySourceId?: (sourceId: string) => boolean
}

export interface TrafficSyncedEvent {
  /** 'completed' = transactional rollup write succeeded. 'failed' = pull or auth failed before any rollup writes. */
  status: 'completed' | 'failed'
  /** Stable enum value (e.g. 'cloud-run', 'wp-plugin'). Mirrors `traffic_sources.source_type`. */
  sourceType: string
  /** Source row UUID — opaque, no PII. */
  sourceId: string
  /** Number of normalized events processed (post-dedupe, post-self-traffic-exclusion). 0 for failed syncs. */
  pulledEvents: number
  /** Self-traffic events (Canonry's own tooling) dropped before rollup. 0 for failed syncs. */
  selfTrafficExcluded: number
  /** Crawler hourly bucket inserts/updates. 0 for failed syncs. */
  crawlerHits: number
  /** AI user-fetch hourly bucket inserts/updates (ChatGPT-User, Perplexity-User, …). 0 for failed syncs. */
  aiUserFetchHits: number
  /** AI-referral hourly bucket inserts/updates. 0 for failed syncs. */
  aiReferralHits: number
  /** End-to-end duration including pull, classification, rollup write. */
  durationMs: number
  /** Stable error code on failure. Present only when status === 'failed'. */
  errorCode?: 'NO_CREDENTIAL' | 'PROVIDER_AUTH' | 'PROVIDER_PULL' | 'INTERNAL'
}

/** One authenticated push of traffic events into the server (the Cloudflare Worker's direct push). */
export interface TrafficIngestedEvent {
  /** Stable enum value mirroring `traffic_sources.source_type`. */
  sourceType: string
  status: 'succeeded' | 'failed'
  /** Accepted events after dedupe; 0 when failed. */
  events: number
  crawlerHits: number
  aiReferralHits: number
  aiUserFetchHits: number
  durationMs: number
  /** Why the push was refused; present only when failed. */
  reasonCode?: OutcomeReasonCode
  errorName?: string
}

export interface TrafficRoutesOptions {
  cloudRunCredentialStore?: CloudRunCredentialStore
  /** Override the Cloud Run pull function (for tests). Defaults to `listCloudRunTrafficEvents`. */
  pullCloudRunEvents?: (
    accessToken: string,
    options: ListCloudRunTrafficEventsOptions,
  ) => Promise<CloudRunTrafficEventsPage>
  /** Override the access-token resolver (for tests). Defaults to service-account JWT exchange. */
  resolveCloudRunAccessToken?: (record: CloudRunCredentialRecord) => Promise<string>
  /**
   * Store for WordPress traffic-logger Application Password credentials. When
   * absent, the WordPress connect / sync routes return a configuration error.
   */
  wordpressTrafficCredentialStore?: WordpressTrafficCredentialStore
  /** Override the WordPress traffic pull function (for tests). Defaults to `listWordpressTrafficEvents`. */
  pullWordpressTrafficEvents?: (
    options: ListWordpressTrafficEventsOptions,
  ) => Promise<WordpressTrafficEventsPage>
  /**
   * Store for Vercel traffic API-token credentials. When absent, the Vercel
   * connect / sync routes return a configuration error.
   */
  vercelTrafficCredentialStore?: VercelTrafficCredentialStore
  /** Override the Vercel traffic pull function (for tests). Defaults to `listVercelTrafficEvents`. */
  pullVercelTrafficEvents?: (
    options: ListVercelTrafficEventsOptions,
  ) => Promise<VercelTrafficEventsPage>
  /**
   * Max `request-logs` pages to walk per Vercel sync. Vercel paginates by page
   * number within a fixed time window with no resumable cursor, so a sync must
   * drain the whole window in one pass — if the budget is exhausted with
   * `hasMore` still true, the sync fails rather than advancing the cursor past
   * un-pulled rows.
   */
  defaultVercelMaxPages?: number
  /**
   * Store for Cloudflare Worker traffic per-source bearer + HMAC secrets.
   * When absent, the Cloudflare connect / ingest routes return a
   * configuration error.
   */
  cloudflareTrafficCredentialStore?: CloudflareTrafficCredentialStore
  /** Injectable Queue puller so route tests never call Cloudflare. */
  pullCloudflareQueueMessages?: (
    client: CloudflareQueueClientOptions,
    options?: PullCloudflareQueueMessagesOptions,
  ) => Promise<CloudflareQueuePullResult>
  /** Injectable Queue acknowledger so route tests can pin commit-before-ack ordering. */
  ackCloudflareQueueMessages?: (
    client: CloudflareQueueClientOptions,
    options: AckCloudflareQueueMessagesOptions,
  ) => Promise<CloudflareQueueAckResult>
  /** Bounded short-poll batches per sync invocation. */
  cloudflareQueueMaxBatches?: number
  /** Override the canonry ingest URL embedded into generated Worker scripts (for tests). */
  cloudflareTrafficIngestUrl?: string
  /** Per-source direct-push request budget per minute. Invalid auth is budgeted by caller IP. */
  cloudflareIngestRateLimitMax?: number
  /** Early public-endpoint request budget per caller IP, before body parsing. */
  cloudflareIngestIpRateLimitMax?: number
  /** Default lookback window in minutes when a sync is triggered without an explicit `since`. */
  defaultSyncWindowMinutes?: number
  /** Default page size for entries.list pulls. */
  defaultPageSize?: number
  /** Default max pages for entries.list pulls. */
  defaultMaxPages?: number
  /**
   * Default page size for the WordPress traffic puller. WP uses opaque-cursor
   * pagination, so this is a per-page cap rather than a window size.
   */
  defaultWordpressPageSize?: number
  /**
   * Default max pages per WordPress sync invocation. Bounds the fan-out of a
   * single sync so a misconfigured cursor or runaway plugin can't exhaust the
   * route — the next sync resumes from the persisted cursor.
   */
  defaultWordpressMaxPages?: number
  /** Cap on the number of raw_event_samples written per sync. */
  defaultSampleLimit?: number
  /**
   * Wall-clock budget (ms) for a single incremental Vercel sync's adaptive
   * drain. On hit the drain stops and the route commits the partial window +
   * advances `lastSyncedAt` to where it reached, so a dense or slow window can't
   * run unbounded. Defaults to `DEFAULT_VERCEL_SYNC_DEADLINE_MS`; tests pass a
   * tiny value to exercise the deadline path.
   */
  vercelSyncDeadlineMs?: number
  /** Fire-and-forget hook called after every sync completes (success OR failure). Used by canonry to emit telemetry. */
  onTrafficSynced?: (event: TrafficSyncedEvent) => void
  /** Fire-and-forget hook called after every authenticated ingest push (success OR failure). Used by canonry to emit telemetry. */
  onTrafficIngested?: (event: TrafficIngestedEvent) => void
  /**
   * Register/deregister a project schedule with the live scheduler. Connect
   * uses this to register the `traffic-sync` schedule it auto-creates, so the
   * source starts syncing on cadence without an extra operator step. Same
   * callback the schedule routes fire — wired from `ApiRoutesOptions`.
   */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string, kind: SchedulableRunKind) => void
  /**
   * Allow WordPress `baseUrl` to resolve to a loopback address. Mirrors
   * `allowLoopbackWebhooks` on the parent `ApiRoutesOptions` — only enabled by
   * the local `canonry serve` so dev users can point at `http://localhost`.
   * Cloud deployments leave this off so an API-key holder cannot coerce the
   * server into fetching its own metadata service or sidecar admin endpoints
   * with the attached Basic-auth credentials.
   */
  allowLoopbackWebhooks?: boolean
}

const DEFAULT_SYNC_WINDOW_MINUTES = 43_200
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_PAGES = 5
const DEFAULT_SAMPLE_LIMIT = 100
// WordPress traffic pulls use opaque cursors to page through a bounded time
// window. Caps below match Cloud Run's per-sync budget shape: a moderate page
// size with a bounded fan-out so a misconfigured cursor or runaway plugin
// can't exhaust the route. Adjust via TrafficRoutesOptions.
const DEFAULT_WP_PAGE_SIZE = 500
const DEFAULT_WP_MAX_PAGES = 20
// The plugin's retention is operator-configurable up to 365 days. Start an
// idle or new source at that maximum so a site that retained more than the
// default 90 days never silently advances past data Canonry could still pull.
// A shorter retention simply returns its available tail; an explicit
// `sinceMinutes` still wins.
const DEFAULT_WP_SYNC_WINDOW_MINUTES = 365 * 24 * 60
// Vercel's `request-logs` endpoint paginates by page number within a fixed
// `[startDate, endDate]` window and exposes no resumable page cursor. A
// window holding more than this many pages cannot be pulled in one pass, so
// `drainVercelTrafficEvents` narrows the time window adaptively until each
// slice fits. This is the per-sub-window page budget.
const DEFAULT_VERCEL_MAX_PAGES = 50
// Hard cap on adaptive sub-windows a single Vercel drain may walk before it
// gives up. This bounds provider calls for pathological windows while still
// leaving room for bursty minutes to drain through one-second slices.
const VERCEL_MAX_SUB_WINDOWS = 5_000
// VERCEL_MAX_SYNC_WINDOW_MS caps how far back one incremental sync reaches, and
// DEFAULT_VERCEL_SYNC_DEADLINE_MS bounds the adaptive drain's wall-clock budget
// within that window. Both live in traffic-limits.ts so the doctor sync-lag check
// reads the same numbers this route enforces; a duplicated literal would drift
// and make the health check wrong about when data starts being discarded.
// The deadline is overridable via `vercelSyncDeadlineMs`
// (env: CANONRY_VERCEL_SYNC_DEADLINE_MS).
// Vercel request-logs uses page-number pagination inside a fixed time window.
// Backfill large ranges as independent hour chunks so each chunk gets the full
// adaptive sub-window budget and one dense hour cannot make a multi-day
// recovery window impossible to drain.
const VERCEL_BACKFILL_CHUNK_MS = 60 * 60_000
// Bounded ring buffer of the most-recent normalized event IDs from the last
// sync. Used to dedupe events that fall in the small overlap window between
// `lastSyncedAt` and the new sync's `windowStart`. Sized for the practical
// boundary case (a few seconds of overlap × peak QPS) — well above what a
// realistic Cloud Logging burst produces in that window.
const MAX_TRACKED_EVENT_IDS = 1_000
// Backfill knobs. The 30-day cap matches Cloud Logging `_Default` retention —
// requesting more produces empty results from GCP, so we clamp rather than
// silently waste round-trips. Page budget is generous because backfill is a
// one-shot operation; a busy site with ~30K events/30d still completes in well
// under a minute.
const DEFAULT_BACKFILL_DAYS = 30
// Cadence for the traffic-sync schedule auto-created on connect. Every 30
// minutes keeps each sync's window tight (well inside upstream log retention)
// so the watermark never drifts far enough to wedge a pull. Operators can
// retune via `canonry schedule set <project> --kind traffic-sync --cron ...`.
const DEFAULT_TRAFFIC_SYNC_CRON = '*/30 * * * *'
const MAX_BACKFILL_DAYS = 90
const BACKFILL_MAX_PAGES = 1_000
const BACKFILL_SAMPLE_LIMIT = 500
const CLOUDFLARE_INGEST_BODY_LIMIT = 256 * 1024
// Queue retention is configured outside Canonry and this v1 connection only
// records the operator-provided value. Keep dedupe receipts through the
// current Cloudflare maximum (14 days) plus a replay margin, so a lower or
// stale local value can never shorten the redelivery safety window.
const CLOUDFLARE_QUEUE_RECEIPT_TTL_MS = 14 * 24 * 60 * 60_000 + 10 * 60_000
// The Queue client can spend up to 210 seconds on one transient ACK sequence
// (four 30-second requests plus three capped waits). Keep the upstream message
// lease beyond that budget so a second consumer cannot receive the same batch
// while Canonry is still acknowledging its committed receipts.
const CLOUDFLARE_QUEUE_VISIBILITY_TIMEOUT_MS = 5 * 60_000
const CLOUDFLARE_QUEUE_SYNC_LEASE_TTL_MS = 5 * 60_000
// A WordPress page request has a 30-second client timeout. Renew before every
// page and keep the lease comfortably beyond that one-request bound.
const WORDPRESS_SYNC_LEASE_TTL_MS = 5 * 60_000
const DEFAULT_CLOUDFLARE_INGEST_RATE_LIMIT_MAX = 6_000
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hashCloudflareBearerToken(value: string): string {
  return sha256Hex(value)
}

function timingSafeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (!SHA256_HEX_PATTERN.test(a) || !SHA256_HEX_PATTERN.test(b)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function parseDirectPushCloudflareSourceConfig(config: unknown) {
  const parsed = cloudflareTrafficSourceConfigSchema.safeParse(config)
  return parsed.success && parsed.data.deliveryMode === CloudflareTrafficDeliveryModes['direct-push']
    ? parsed.data
    : null
}

function parseQueuePullCloudflareSourceConfig(config: unknown) {
  const parsed = cloudflareTrafficSourceConfigSchema.safeParse(config)
  return parsed.success && parsed.data.deliveryMode === CloudflareTrafficDeliveryModes['queue-pull']
    ? parsed.data
    : null
}

function isDirectPushCloudflareDeliveryMode(value: unknown): value is 'direct-push' {
  return value === CloudflareTrafficDeliveryModes['direct-push']
}

interface AuthenticatedCloudflareIngest {
  bearerHash: string
  credential: CloudflareTrafficCredentialRecord
}

/** Authenticate the transport only. Project/source authorization follows separately. */
function authenticateCloudflareIngest(
  request: FastifyRequest,
  store: CloudflareTrafficCredentialStore | undefined,
): AuthenticatedCloudflareIngest | null {
  if (!store) return null
  const authHeader = request.headers.authorization
  const sourceIdHeader = request.headers['x-canonry-source-id']
  const timestampHeader = request.headers['x-canonry-timestamp']
  const signatureHeader = request.headers['x-canonry-signature']

  const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : ''
  const sourceId = typeof sourceIdHeader === 'string' ? sourceIdHeader : ''
  const timestamp = typeof timestampHeader === 'string' ? timestampHeader : ''
  const signature = typeof signatureHeader === 'string' ? signatureHeader : ''
  if (!bearerToken || !sourceId || !timestamp || !signature) return null

  const credential = store.getConnectionBySourceId(sourceId)
  if (!credential || credential.deliveryMode !== 'direct-push') return null
  const bearerHash = sha256Hex(bearerToken)
  if (!timingSafeEqualHex(bearerHash, sha256Hex(credential.bearerToken))) return null
  if (!verifyRequestSignature({
    timestamp,
    signature,
    payload: request.body,
    secret: credential.hmacSecret,
  }).ok) return null

  return { bearerHash, credential }
}

function cloudflareIngestRateLimitKey(
  request: FastifyRequest,
  store: CloudflareTrafficCredentialStore | undefined,
  db: DatabaseClient,
): string {
  const authenticated = authenticateCloudflareIngest(request, store)
  const params = request.params as { name?: unknown }
  if (
    authenticated
    && typeof params.name === 'string'
    && authenticated.credential.projectName === params.name
  ) {
    const source = db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, authenticated.credential.sourceId))
      .get()
    if (
      source
      && source.sourceType === TrafficSourceTypes.cloudflare
      && source.status === TrafficSourceStatuses.connected
      && parseDirectPushCloudflareSourceConfig(source.configJson)
      && timingSafeEqualHex(authenticated.bearerHash, source.ingestTokenHash)
    ) {
      return `cloudflare-source:${authenticated.credential.sourceId}`
    }
  }
  return `cloudflare-invalid:${request.ip}`
}

function assertCloudflareIngestUrlIsPublicHttps(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw validationError('Cloudflare ingest URL must be a valid public HTTPS URL')
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  const octets = ipv4?.slice(1).map(Number)
  const privateIpv4 = octets !== undefined && (
    octets.some((part) => part > 255)
    || octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  )
  const privateIpv6 = hostname.includes(':') && (
    hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe8')
    || hostname.startsWith('fe9')
    || hostname.startsWith('fea')
    || hostname.startsWith('feb')
  )
  const privateHostname = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || privateIpv6
    || privateIpv4

  if (
    url.protocol !== 'https:'
    || privateHostname
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw validationError(
      'Cloudflare ingest URL must be a credential-free public HTTPS URL without a query or fragment and reachable from the public Cloudflare edge; configure publicUrl to a public origin',
    )
  }
}

function normalizeDnsHostname(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '')
  if (
    normalized.length === 0
    || normalized.length > 253
    || normalized.includes('*')
    || !normalized.includes('.')
  ) return null
  const valid = normalized.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )
  return valid ? normalized : null
}

/** Resolve the exact hostname that the generated `host/*` Worker route owns. */
function resolveCloudflareWorkerRouteHost(value: string): string {
  const trimmed = value.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
    throw validationError('Project canonicalDomain must use an HTTP or HTTPS URL')
  }

  let url: URL
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    throw validationError('Project canonicalDomain must resolve to one exact public hostname')
  }

  if (
    url.username.length > 0
    || url.password.length > 0
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search.length > 0
    || url.hash.length > 0
    || url.port.length > 0
  ) {
    throw validationError(
      'Project canonicalDomain must be a bare hostname or root HTTP(S) URL without credentials, a non-default port, path, query, or fragment',
    )
  }

  const hostname = normalizeDnsHostname(url.hostname)
  if (!hostname || isIP(hostname) !== 0) {
    throw validationError('Project canonicalDomain must resolve to one exact public hostname without wildcards')
  }
  return hostname
}

function normalizeCloudflareEventHost(value: string | null): string | null {
  if (!value || /[/:@?#*]/.test(value)) return null
  return normalizeDnsHostname(value)
}

function assertCloudflareIngestUrlOutsideWorkerRoute(
  ingestUrl: string,
  workerRouteHost: string,
): void {
  const ingestHost = normalizeDnsHostname(new URL(ingestUrl).hostname)
  if (ingestHost && ingestHost === workerRouteHost) {
    throw validationError(
      'Cloudflare ingest URL hostname must be outside the generated Worker route hostname to prevent recursive ingestion',
    )
  }
}

function emptyTrafficSeriesPoint(bucket: string): TrafficSeriesPoint {
  return { bucket, crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, crawlerContentHits: 0, measured: true }
}

function completeTrafficSeries(
  windowStart: Date,
  windowEnd: Date,
  granularity: TrafficSeriesGranularity,
  pointsByBucket: ReadonlyMap<string, TrafficSeriesPoint>,
): TrafficSeriesPoint[] {
  const cursor = new Date(windowStart)
  const last = new Date(windowEnd)
  if (granularity === TrafficSeriesGranularities.day) {
    cursor.setUTCHours(0, 0, 0, 0)
    last.setUTCHours(0, 0, 0, 0)
  } else {
    cursor.setUTCMinutes(0, 0, 0)
    last.setUTCMinutes(0, 0, 0)
  }

  const points: TrafficSeriesPoint[] = []
  while (cursor <= last) {
    const bucket = granularity === TrafficSeriesGranularities.day
      ? cursor.toISOString().slice(0, 10)
      : cursor.toISOString()
    points.push(pointsByBucket.get(bucket) ?? emptyTrafficSeriesPoint(bucket))
    if (granularity === TrafficSeriesGranularities.day) cursor.setUTCDate(cursor.getUTCDate() + 1)
    else cursor.setUTCHours(cursor.getUTCHours() + 1)
  }
  return points
}

function trafficSeriesPoint(
  pointsByBucket: Map<string, TrafficSeriesPoint>,
  bucket: string,
): TrafficSeriesPoint {
  const existing = pointsByBucket.get(bucket)
  if (existing) return existing
  const created = emptyTrafficSeriesPoint(bucket)
  pointsByBucket.set(bucket, created)
  return created
}

type VerificationEventKey = Pick<
  TrafficCrawlerEventEntry,
  'sourceId' | 'tsHour' | 'botId' | 'verificationStatus' | 'pathNormalized' | 'status' | 'hits'
>

type VerificationManifestUsage = NonNullable<
  TrafficCrawlerEventEntry['verificationManifests']
>[number]

type VerificationManifestRow = Pick<
  TrafficCrawlerEventEntry,
  'sourceId' | 'tsHour' | 'botId' | 'verificationStatus' | 'pathNormalized' | 'status'
> & VerificationManifestUsage

type VerificationProvenance = {
  verificationManifests: VerificationManifestUsage[]
  verificationUnattributedHits: number
}

function verificationEventKey(row: Omit<VerificationEventKey, 'hits'>): string {
  return JSON.stringify([
    row.sourceId,
    row.tsHour,
    row.botId,
    row.verificationStatus,
    row.pathNormalized,
    row.status,
  ])
}

function verificationSelectedRowsJson(
  projectId: string,
  rows: readonly VerificationEventKey[],
): string {
  return JSON.stringify(rows.map(row => [
    projectId,
    row.sourceId,
    row.tsHour,
    row.botId,
    row.verificationStatus,
    row.pathNormalized,
    row.status,
  ]))
}

function buildVerificationProvenance(
  events: readonly VerificationEventKey[],
  rows: readonly VerificationManifestRow[],
): Map<string, VerificationProvenance> {
  const manifestsByEvent = new Map<string, VerificationManifestUsage[]>()
  for (const row of rows) {
    const key = verificationEventKey(row)
    const manifests = manifestsByEvent.get(key)
    const usage = { manifestId: row.manifestId, manifest: row.manifest, hits: row.hits }
    if (manifests) manifests.push(usage)
    else manifestsByEvent.set(key, [usage])
  }

  const provenanceByEvent = new Map<string, VerificationProvenance>()
  for (const event of events) {
    const key = verificationEventKey(event)
    const verificationManifests = manifestsByEvent.get(key) ?? []
    verificationManifests.sort((a, b) => a.manifestId.localeCompare(b.manifestId))
    const attributedHits = verificationManifests.reduce((sum, manifest) => sum + manifest.hits, 0)
    provenanceByEvent.set(key, {
      verificationManifests,
      verificationUnattributedHits: Math.max(0, event.hits - attributedHits),
    })
  }
  return provenanceByEvent
}

function crawlerVerificationProvenance(
  db: DatabaseClient,
  projectId: string,
  events: readonly TrafficCrawlerEventEntry[],
): Map<string, VerificationProvenance> {
  if (events.length === 0) return new Map()
  const selectedRows = verificationSelectedRowsJson(projectId, events)
  const rows = db
    .select({
      sourceId: crawlerVerificationManifestsHourly.sourceId,
      tsHour: crawlerVerificationManifestsHourly.tsHour,
      botId: crawlerVerificationManifestsHourly.botId,
      verificationStatus: crawlerVerificationManifestsHourly.verificationStatus,
      pathNormalized: crawlerVerificationManifestsHourly.pathNormalized,
      status: crawlerVerificationManifestsHourly.status,
      manifestId: crawlerVerificationManifestsHourly.manifestId,
      manifest: crawlerVerificationManifestsHourly.manifestJson,
      hits: crawlerVerificationManifestsHourly.hits,
    })
    .from(crawlerVerificationManifestsHourly)
    .where(sql`(
      ${crawlerVerificationManifestsHourly.projectId},
      ${crawlerVerificationManifestsHourly.sourceId},
      ${crawlerVerificationManifestsHourly.tsHour},
      ${crawlerVerificationManifestsHourly.botId},
      ${crawlerVerificationManifestsHourly.verificationStatus},
      ${crawlerVerificationManifestsHourly.pathNormalized},
      ${crawlerVerificationManifestsHourly.status}
    ) IN (
      SELECT
        json_extract(value, '$[0]'),
        json_extract(value, '$[1]'),
        json_extract(value, '$[2]'),
        json_extract(value, '$[3]'),
        json_extract(value, '$[4]'),
        json_extract(value, '$[5]'),
        json_extract(value, '$[6]')
      FROM json_each(${selectedRows})
    )`)
    .orderBy(crawlerVerificationManifestsHourly.manifestId)
    .all()
  return buildVerificationProvenance(events, rows)
}

function aiUserFetchVerificationProvenance(
  db: DatabaseClient,
  projectId: string,
  events: readonly TrafficAiUserFetchEventEntry[],
): Map<string, VerificationProvenance> {
  if (events.length === 0) return new Map()
  const selectedRows = verificationSelectedRowsJson(projectId, events)
  const rows = db
    .select({
      sourceId: aiUserFetchVerificationManifestsHourly.sourceId,
      tsHour: aiUserFetchVerificationManifestsHourly.tsHour,
      botId: aiUserFetchVerificationManifestsHourly.botId,
      verificationStatus: aiUserFetchVerificationManifestsHourly.verificationStatus,
      pathNormalized: aiUserFetchVerificationManifestsHourly.pathNormalized,
      status: aiUserFetchVerificationManifestsHourly.status,
      manifestId: aiUserFetchVerificationManifestsHourly.manifestId,
      manifest: aiUserFetchVerificationManifestsHourly.manifestJson,
      hits: aiUserFetchVerificationManifestsHourly.hits,
    })
    .from(aiUserFetchVerificationManifestsHourly)
    .where(sql`(
      ${aiUserFetchVerificationManifestsHourly.projectId},
      ${aiUserFetchVerificationManifestsHourly.sourceId},
      ${aiUserFetchVerificationManifestsHourly.tsHour},
      ${aiUserFetchVerificationManifestsHourly.botId},
      ${aiUserFetchVerificationManifestsHourly.verificationStatus},
      ${aiUserFetchVerificationManifestsHourly.pathNormalized},
      ${aiUserFetchVerificationManifestsHourly.status}
    ) IN (
      SELECT
        json_extract(value, '$[0]'),
        json_extract(value, '$[1]'),
        json_extract(value, '$[2]'),
        json_extract(value, '$[3]'),
        json_extract(value, '$[4]'),
        json_extract(value, '$[5]'),
        json_extract(value, '$[6]')
      FROM json_each(${selectedRows})
    )`)
    .orderBy(aiUserFetchVerificationManifestsHourly.manifestId)
    .all()
  return buildVerificationProvenance(events, rows)
}

function parseSourceConfig(row: typeof trafficSources.$inferSelect): Record<string, unknown> {
  return row.configJson
}

function rowToDto(row: typeof trafficSources.$inferSelect): TrafficSourceDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceType: row.sourceType as TrafficSourceDto['sourceType'],
    displayName: row.displayName,
    status: row.status as TrafficSourceStatus,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastCursor: row.lastCursor ?? null,
    lastError: row.lastError ?? null,
    skippedThroughAt: row.skippedThroughAt ?? null,
    queueBacklogCount: row.queueBacklogCount ?? null,
    queueBacklogObservedAt: row.queueBacklogObservedAt ?? null,
    archivedAt: row.archivedAt ?? null,
    config: parseSourceConfig(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function defaultResolveAccessToken(record: CloudRunCredentialRecord): Promise<string> {
  if (record.authMode === TrafficSourceAuthModes['service-account']) {
    if (!record.clientEmail || !record.privateKey) {
      throw validationError('Service-account credentials missing client_email or private_key')
    }
    return getCloudLoggingAccessToken(record.clientEmail, record.privateKey)
  }
  throw validationError(
    'OAuth-mode Cloud Run sync is not yet supported in v1. Provide a service-account key file.',
  )
}

/**
 * Per-source-type pull function for a backfill window. Receives the
 * `[windowStart, windowEnd)` bounds and returns a flat list of
 * `NormalizedTrafficRequest` for the entire window. Each adapter handles
 * its own pagination internally (Cloud Run via nextPageToken, WordPress
 * via opaque cursor against `since`/`until` on the plugin endpoint).
 *
 * Returning the events directly keeps the shared rollup-write path source-
 * agnostic and bounds error attribution: anything thrown here surfaces as
 * a "pull failed" run failure with the adapter-specific prefix from the
 * route's closure.
 */
type BackfillPullFn = () => Promise<NormalizedTrafficRequest[]>

type TrafficTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

function hasConnectedTrafficSourceSibling(
  db: DatabaseClient | TrafficTransaction,
  projectId: string,
  sourceId: string,
): boolean {
  return db.select().from(trafficSources)
    .where(eq(trafficSources.projectId, projectId)).all()
    .some(row => row.id !== sourceId && row.status === TrafficSourceStatuses.connected)
}

function isAuthoritativeTrafficSource(
  db: DatabaseClient | TrafficTransaction,
  source: typeof trafficSources.$inferSelect,
): boolean {
  return (source.status === TrafficSourceStatuses.connected
      || source.status === TrafficSourceStatuses.error)
    && !hasConnectedTrafficSourceSibling(db, source.projectId, source.id)
}

function trafficConnectStatus(
  tx: TrafficTransaction,
  projectId: string,
  existingSource: typeof trafficSources.$inferSelect | undefined,
): TrafficSourceStatus {
  return existingSource?.status === TrafficSourceStatuses.paused
    || hasConnectedTrafficSourceSibling(tx, projectId, existingSource?.id ?? '')
    ? TrafficSourceStatuses.paused
    : TrafficSourceStatuses.connected
}

function isSameTrafficSourceGeneration(
  current: typeof trafficSources.$inferSelect,
  started: typeof trafficSources.$inferSelect,
): boolean {
  return isDeepStrictEqual(current.configJson, started.configJson)
    && current.updatedAt === started.updatedAt
    && current.lastSyncedAt === started.lastSyncedAt
    && current.lastCursor === started.lastCursor
    && current.wordpressPendingUntil === started.wordpressPendingUntil
}

/**
 * Cursor and watermark state belongs to one WordPress REST endpoint, not to a
 * project in the abstract. Normalize only presentation differences that leave
 * the endpoint unchanged, such as a trailing slash or host casing, so a real
 * cutover starts with a fresh bounded drain.
 */
function wordpressBaseUrlIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch {
    return undefined
  }
}

function bindTrafficSyncSchedule(
  tx: TrafficTransaction,
  projectId: string,
  sourceId: string,
  now: string,
  createIfMissing = true,
): { changed: boolean; created: boolean } {
  const schedule = tx.select().from(schedules).where(and(
    eq(schedules.projectId, projectId),
    eq(schedules.kind, SchedulableRunKinds['traffic-sync']),
  )).get()
  if (schedule) {
    if (schedule.sourceId === sourceId) return { changed: false, created: false }
    tx.update(schedules).set({ sourceId, updatedAt: nextScheduleUpdatedAt(schedule.updatedAt, Date.parse(now)) })
      .where(eq(schedules.id, schedule.id)).run()
    return { changed: true, created: false }
  }
  if (!createIfMissing) return { changed: false, created: false }
  tx.insert(schedules).values({
    id: crypto.randomUUID(),
    projectId,
    kind: SchedulableRunKinds['traffic-sync'],
    cronExpr: DEFAULT_TRAFFIC_SYNC_CRON,
    preset: null,
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId,
    createdAt: now,
    updatedAt: now,
  }).run()
  return { changed: true, created: true }
}

class VercelRetentionClampError extends Error {
  constructor(requestedStartMs: number, effectiveStartMs: number) {
    super(
      `Vercel request-logs retention starts at ${new Date(effectiveStartMs).toISOString()}, `
        + `after requested start ${new Date(requestedStartMs).toISOString()}; refusing to advance `
        + 'because historical traffic would be skipped',
    )
    this.name = 'VercelRetentionClampError'
  }
}

function vercelRetentionClampError(
  requestedStartMs: number,
  effectiveStartMs: number,
): VercelRetentionClampError {
  return new VercelRetentionClampError(requestedStartMs, effectiveStartMs)
}

interface RunBackfillTaskOptions {
  app: FastifyInstance
  runId: string
  project: { id: string; name: string }
  sourceRow: typeof trafficSources.$inferSelect
  windowStart: Date
  windowEnd: Date
  /**
   * Adapter-supplied window pull. Closure encloses the per-source-type
   * credentials, page-size budget, and pagination. See `BackfillPullFn`.
   */
  pullForBackfill: BackfillPullFn
  /**
   * Prefix for the user-visible failure message when `pullForBackfill`
   * throws. Cloud Run and Vercel use adapter-specific prefixes, keeping the
   * run-failure surface attributable without coupling the task itself to a
   * source type.
   */
  pullErrorPrefix: string
}

async function runBackfillTask(options: RunBackfillTaskOptions): Promise<void> {
  const {
    app,
    runId,
    project,
    sourceRow,
    windowStart,
    windowEnd,
    pullForBackfill,
    pullErrorPrefix,
  } = options
  const backfillStartedAt = Date.now()
  // Reported after the request that started it, so who asked is read now, before the first await.
  const target = { feature: 'server_traffic', operation: 'backfill', attribution: currentOutcomeAttribution() } as const
  const reportBackfill = (outcome: FeatureOutcome) => reportFeatureOutcome(app, target, {
    ...outcome, durationBucket: bucketDuration(Date.now() - backfillStartedAt),
  })

  const markFailed = (msg: string, preserveSourceState = false) => {
    const failedAt = new Date().toISOString()
    try {
      app.db.transaction((tx) => {
        tx
          .update(runs)
          .set({ status: RunStatuses.failed, error: msg, finishedAt: failedAt })
          .where(eq(runs.id, runId))
          .run()
        const latestSource = tx.select().from(trafficSources)
          .where(eq(trafficSources.id, sourceRow.id)).get()
        if (!preserveSourceState
          && latestSource
          && isAuthoritativeTrafficSource(tx, latestSource)
          && isSameTrafficSourceGeneration(latestSource, sourceRow)) {
          tx
            .update(trafficSources)
            .set({ status: TrafficSourceStatuses.error, lastError: msg, updatedAt: failedAt })
            .where(eq(trafficSources.id, sourceRow.id))
            .run()
        }
      })
    } catch {
      // Last-ditch — if even the failure-recording transaction throws, we
      // can't surface it anywhere without crashing the process. The run row
      // will stay 'running' until the next sync overwrites it.
    }
  }

  // The plugin's retained event feed never proves it covers an entire replace
  // window. Do not let a background task delete old rollups and refill only a
  // newer retained tail. A dedicated repair workflow must establish coverage
  // and record any unrecoverable span before it can replace WordPress data.
  if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
    markFailed('Generic WordPress replace backfill is unavailable because retained coverage is unproven. Use a retention-aware repair that declares the unrecoverable span.')
    reportBackfill({ status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.UNSUPPORTED })
    return
  }

  let allEvents: NormalizedTrafficRequest[]
  try {
    allEvents = await pullForBackfill()
  } catch (e) {
    // A Vercel retention miss is a rejected optional historical recovery, not
    // a problem with the already-connected source. The failed run records the
    // exact range, while the existing source state is left intact so its
    // regular forward sync remains healthy.
    markFailed(
      `${pullErrorPrefix}: ${describeError(e)}`,
      e instanceof VercelRetentionClampError,
    )
    reportBackfill(failedOutcome(e, e instanceof VercelRetentionClampError ? OutcomeReasonCodes.NO_DATA : undefined))
    return
  }

  // Empty pull — could be a misconfigured serviceName / WP plugin not
  // serving the window, transient upstream glitch, or a genuinely quiet
  // site. Treat as a no-op: skip the destructive replace below so existing
  // rollup data isn't silently wiped, and just close out the run row.
  if (allEvents.length === 0) {
    const finishedAt = new Date().toISOString()
    let emptyOutcome: FeatureOutcome
    try {
      const completed = app.db.transaction((tx) => {
        const latestSource = tx.select().from(trafficSources)
          .where(eq(trafficSources.id, sourceRow.id)).get()
        const stillAuthoritative = latestSource
          && isAuthoritativeTrafficSource(tx, latestSource)
          && isSameTrafficSourceGeneration(latestSource, sourceRow)
        if (stillAuthoritative) {
          enforceRawEventSampleRetention(tx, sourceRow.id, finishedAt)
        }
        tx.update(runs).set(stillAuthoritative
          ? { status: RunStatuses.completed, finishedAt }
          : {
              status: RunStatuses.failed,
              error: 'Traffic source was deactivated or reconfigured during backfill',
              finishedAt,
            })
          .where(eq(runs.id, runId)).run()
        return Boolean(stillAuthoritative)
      })
      emptyOutcome = completed
        ? { status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.NO_DATA }
        : { status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.NOT_CONNECTED }
    } catch (e) {
      // swallow — same last-ditch behavior as markFailed
      emptyOutcome = failedOutcome(e)
    }
    reportBackfill(emptyOutcome)
    return
  }

  const report = buildTrafficProbeReport(allEvents, { sampleLimit: BACKFILL_SAMPLE_LIMIT })
  // Self-traffic exclusion is never silent. The backfill response already
  // returned, so the log is the surfacing channel here.
  if (report.totals.selfTrafficExcluded > 0) {
    app.log.info(
      { sourceId: sourceRow.id, selfTrafficExcluded: report.totals.selfTrafficExcluded },
      'Backfill dropped Canonry self-traffic before rollup',
    )
  }
  const finishedAt = new Date().toISOString()
  const windowStartIso = windowStart.toISOString()
  const windowEndIso = windowEnd.toISOString()

  // Reseed the cross-sync dedup ring with the most-recent IDs from the
  // backfill so subsequent incremental syncs continue to dedupe at the
  // boundary. lastSyncedAt advances to max(current, backfillEnd) — never
  // backwards, so a backfill never undoes incremental progress that ran
  // ahead of it. Self-traffic is dropped at rollup, so its IDs never need
  // cross-sync deduping — keep them out of the bounded ring.
  const newSorted = allEvents
    .filter((e) => !isSelfTraffic(e))
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
    .map((e) => e.eventId)
  const newRingBuffer = newSorted.slice(0, MAX_TRACKED_EVENT_IDS)
  const currentLastSyncedMs = sourceRow.lastSyncedAt
    ? new Date(sourceRow.lastSyncedAt).getTime()
    : Number.NEGATIVE_INFINITY
  // Advance to windowEnd (the pull's upper bound), not finishedAt — see the
  // sync-route comment for why. Backfill never moves the cursor backwards.
  const nextLastSyncedAt = Math.max(currentLastSyncedMs, windowEnd.getTime()) === windowEnd.getTime()
    ? windowEndIso
    : sourceRow.lastSyncedAt!

  try {
    const commitOutcome = app.db.transaction((tx) => {
      const latestSource = tx.select().from(trafficSources)
        .where(eq(trafficSources.id, sourceRow.id)).get()
      if (latestSource?.sourceType === TrafficSourceTypes.wordpress) {
        tx.update(runs).set({
          status: RunStatuses.failed,
          error: 'Generic WordPress replace backfill is unavailable because retained coverage is unproven.',
          finishedAt,
        }).where(eq(runs.id, runId)).run()
        return 'wordpress-backfill-unsupported' as const
      }
      if (!latestSource
        || !isAuthoritativeTrafficSource(tx, latestSource)
        || !isSameTrafficSourceGeneration(latestSource, sourceRow)) {
        tx.update(runs).set({
          status: RunStatuses.failed,
          error: 'Traffic source was deactivated or reconfigured during backfill',
          finishedAt,
        }).where(eq(runs.id, runId)).run()
        return 'source-inactive' as const
      }

      const rawSampleCutoff = enforceRawEventSampleRetention(
        tx,
        sourceRow.id,
        finishedAt,
      )

      // Replace mode: clear the rollup window first, then ingest fresh.
      // Boundaries are inclusive on both ends; windowStart is hour-floored
      // upstream so the boundary hour gets cleanly deleted and reinserted.
      tx
        .delete(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.sourceId, sourceRow.id),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.sourceId, sourceRow.id),
            gte(aiUserFetchEventsHourly.tsHour, windowStartIso),
            lte(aiUserFetchEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(aiReferralEventsHourly)
        .where(
          and(
            eq(aiReferralEventsHourly.sourceId, sourceRow.id),
            gte(aiReferralEventsHourly.tsHour, windowStartIso),
            lte(aiReferralEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(rawEventSamples)
        .where(
          and(
            eq(rawEventSamples.sourceId, sourceRow.id),
            gte(rawEventSamples.ts, windowStartIso),
            lte(rawEventSamples.ts, windowEndIso),
          ),
        )
        .run()

      for (const bucket of report.crawlerEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(crawlerEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              crawlerEventsHourly.projectId,
              crawlerEventsHourly.sourceId,
              crawlerEventsHourly.tsHour,
              crawlerEventsHourly.botId,
              crawlerEventsHourly.verificationStatus,
              crawlerEventsHourly.pathNormalized,
              crawlerEventsHourly.status,
            ],
            set: {
              hits: sql`${crawlerEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(crawlerVerificationManifestsHourly)
            .values({
              projectId: project.id,
              sourceId: sourceRow.id,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: finishedAt,
              updatedAt: finishedAt,
            })
            .onConflictDoUpdate({
              target: [
                crawlerVerificationManifestsHourly.projectId,
                crawlerVerificationManifestsHourly.sourceId,
                crawlerVerificationManifestsHourly.tsHour,
                crawlerVerificationManifestsHourly.botId,
                crawlerVerificationManifestsHourly.verificationStatus,
                crawlerVerificationManifestsHourly.pathNormalized,
                crawlerVerificationManifestsHourly.status,
                crawlerVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${crawlerVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: finishedAt,
              },
            })
            .run()
        }
      }

      for (const bucket of report.aiUserFetchEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiUserFetchEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiUserFetchEventsHourly.projectId,
              aiUserFetchEventsHourly.sourceId,
              aiUserFetchEventsHourly.tsHour,
              aiUserFetchEventsHourly.botId,
              aiUserFetchEventsHourly.verificationStatus,
              aiUserFetchEventsHourly.pathNormalized,
              aiUserFetchEventsHourly.status,
            ],
            set: {
              hits: sql`${aiUserFetchEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(aiUserFetchVerificationManifestsHourly)
            .values({
              projectId: project.id,
              sourceId: sourceRow.id,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: finishedAt,
              updatedAt: finishedAt,
            })
            .onConflictDoUpdate({
              target: [
                aiUserFetchVerificationManifestsHourly.projectId,
                aiUserFetchVerificationManifestsHourly.sourceId,
                aiUserFetchVerificationManifestsHourly.tsHour,
                aiUserFetchVerificationManifestsHourly.botId,
                aiUserFetchVerificationManifestsHourly.verificationStatus,
                aiUserFetchVerificationManifestsHourly.pathNormalized,
                aiUserFetchVerificationManifestsHourly.status,
                aiUserFetchVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${aiUserFetchVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: finishedAt,
              },
            })
            .run()
        }
      }

      for (const bucket of report.aiReferralEventsHourly) {
        tx
          .insert(aiReferralEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            product: bucket.product,
            operator: bucket.operator,
            sourceDomain: bucket.sourceDomain,
            evidenceType: bucket.evidenceType,
            landingPathNormalized: bucket.landingPathNormalized,
            status: bucket.status ?? 0,
            sessionsOrHits: bucket.hits,
            paidSessionsOrHits: bucket.paidHits,
            organicSessionsOrHits: bucket.organicHits,
            usersEstimated: null,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .run()
      }

      for (const sample of report.samples) {
        const sampleTimestamp = retainedRawEventSampleTimestamp(sample.observedAt, rawSampleCutoff)
        if (!sampleTimestamp) continue
        const eventType = sample.crawler
          ? 'crawler'
          : sample.aiUserFetch
            ? 'ai_user_fetch'
            : sample.aiReferral
              ? 'ai_referral'
              : 'unknown'
        const refererHost = (() => {
          if (!sample.referer) return null
          try {
            return new URL(sample.referer).hostname
          } catch {
            return null
          }
        })()
        tx
          .insert(rawEventSamples)
          .values({
            id: crypto.randomUUID(),
            projectId: project.id,
            sourceId: sourceRow.id,
            ts: sampleTimestamp,
            eventType,
            ipHash: null,
            userAgent: sample.userAgent,
            pathNormalized: sample.pathNormalized,
            status: sample.status,
            refererHost,
            classifierDetailsJson: {
              crawler: sample.crawler,
              aiUserFetch: sample.aiUserFetch,
              aiReferral: sample.aiReferral,
            },
            createdAt: finishedAt,
          })
          .run()
      }

      // A backfill that reached back to or past the recorded skip has recovered
      // it, so clear the marker. Cleared only when the window actually covers
      // the span: a shorter backfill leaves it set, which is the point — the
      // source keeps reporting unrecovered loss until someone really recovers it.
      const recordedSkipMs = sourceRow.skippedThroughAt ? Date.parse(sourceRow.skippedThroughAt) : Number.NaN
      const skipRecovered = sourceRow.sourceType !== TrafficSourceTypes.wordpress
        && Number.isFinite(recordedSkipMs)
        && windowStart.getTime() <= recordedSkipMs

      tx
        .update(trafficSources)
        .set({
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: nextLastSyncedAt,
          lastError: null,
          lastEventIds: newRingBuffer,
          ...(skipRecovered ? { skippedThroughAt: null } : {}),
          updatedAt: finishedAt,
        })
        .where(eq(trafficSources.id, sourceRow.id))
        .run()

      tx
        .update(runs)
        .set({ status: RunStatuses.completed, finishedAt })
        .where(eq(runs.id, runId))
        .run()
      return 'committed' as const
    })
    reportBackfill(commitOutcome === 'committed'
      ? {
          status: OutcomeStatuses.succeeded,
          counts: {
            events: report.totals.normalizedEvents,
            crawlerHits: report.totals.crawlerHits,
            aiReferralHits: report.totals.aiReferralHits,
            aiUserFetchHits: report.totals.aiUserFetchHits,
          },
        }
      : {
          status: OutcomeStatuses.failed,
          reasonCode: commitOutcome === 'source-inactive' ? OutcomeReasonCodes.NOT_CONNECTED : OutcomeReasonCodes.UNSUPPORTED,
        })
    if (commitOutcome === 'source-inactive' || commitOutcome === 'wordpress-backfill-unsupported') return
  } catch (e) {
    markFailed(`Backfill rollup write failed: ${describeError(e)}`)
    reportBackfill(failedOutcome(e))
  }
}

const TRAFFIC_SOURCE_INTEGRATIONS: Readonly<Partial<Record<string, ConnectionSubject['integration']>>> = {
  [TrafficSourceTypes.cloudflare]: 'traffic_cloudflare',
  [TrafficSourceTypes['cloud-run']]: 'traffic_cloud_run',
  [TrafficSourceTypes.vercel]: 'traffic_vercel',
  [TrafficSourceTypes.wordpress]: 'traffic_wordpress',
}

export async function trafficRoutes(app: FastifyInstance, opts: TrafficRoutesOptions) {
  const pullEvents = opts.pullCloudRunEvents ?? listCloudRunTrafficEvents
  const resolveAccessToken = opts.resolveCloudRunAccessToken ?? defaultResolveAccessToken
  const pullWordpressEvents = opts.pullWordpressTrafficEvents ?? listWordpressTrafficEvents
  const pullVercelEvents = opts.pullVercelTrafficEvents ?? listVercelTrafficEvents
  const pullQueueMessages = opts.pullCloudflareQueueMessages ?? pullCloudflareQueueMessages
  const ackQueueMessages = opts.ackCloudflareQueueMessages ?? ackCloudflareQueueMessages
  const cloudflareQueueMaxBatches = opts.cloudflareQueueMaxBatches ?? DEFAULT_CLOUDFLARE_QUEUE_MAX_BATCHES
  if (!Number.isInteger(cloudflareQueueMaxBatches) || cloudflareQueueMaxBatches < 1 || cloudflareQueueMaxBatches > 50) {
    throw new RangeError('cloudflareQueueMaxBatches must be an integer from 1 to 50')
  }
  const allowLoopback = opts.allowLoopbackWebhooks === true

  let rawSampleRetentionTimer: ReturnType<typeof setInterval> | undefined
  app.addHook('onReady', async () => {
    const pruneExpiredSamples = (): void => {
      try {
        enforceGlobalRawEventSampleRetention(app.db, new Date().toISOString())
      } catch {
        // Raw samples are optional debug evidence. Keep route startup and live
        // traffic available if maintenance fails, but make the failure visible.
        app.log.error('Raw traffic sample retention sweep failed')
      }
    }
    pruneExpiredSamples()
    rawSampleRetentionTimer = setInterval(
      pruneExpiredSamples,
      RAW_EVENT_SAMPLE_RETENTION_SWEEP_INTERVAL_MS,
    )
    rawSampleRetentionTimer.unref()
  })
  app.addHook('onClose', async () => {
    if (rawSampleRetentionTimer) clearInterval(rawSampleRetentionTimer)
  })

  /**
   * SSRF guard for the operator-supplied WordPress `baseUrl`. Every pull-side
   * call into `pullWordpressEvents` attaches Basic-auth credentials, so the
   * host is resolved and private / link-local / metadata addresses refused
   * before any pull, as a 400 that names the URL. Loopback is opt-in via
   * `allowLoopbackWebhooks` to preserve the local dev experience without ever
   * shipping that capability to cloud. Re-checked on every sync, not just at
   * connect, so a public name that later resolves to private space is refused.
   */
  async function assertWordpressTargetAllowed(baseUrl: string, attempt?: ConnectionAttempt): Promise<void> {
    const check = await resolveWebhookTarget(baseUrl, { allowLoopback })
    if (!check.ok) {
      attempt?.failed(undefined, webhookTargetRefusalReason(check))
      throw validationError(`WordPress baseUrl rejected: ${check.message}`)
    }
  }
  // Every pull goes through this fetch, which checks each request and each
  // redirect hop again and dials only the address it checked. The check above
  // alone would leave the window between it and the request open to DNS
  // rebinding, and a redirect (to an IP literal, which skips any pinned
  // lookup, or to a name) never passes through it.
  const wordpressTrafficFetch = createGuardedFetch({ allowLoopback })
  const vercelMaxPages = opts.defaultVercelMaxPages ?? DEFAULT_VERCEL_MAX_PAGES
  const vercelSyncDeadlineMs = opts.vercelSyncDeadlineMs ?? DEFAULT_VERCEL_SYNC_DEADLINE_MS
  const syncWindowMinutes = opts.defaultSyncWindowMinutes ?? DEFAULT_SYNC_WINDOW_MINUTES
  const pageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = opts.defaultMaxPages ?? DEFAULT_MAX_PAGES
  const sampleLimit = opts.defaultSampleLimit ?? DEFAULT_SAMPLE_LIMIT
  // This limiter has its own child store. It does not share Fastify's
  // request-level `rateLimitRan` marker with the public onRequest IP budget.
  const checkCloudflareSourceRateLimit = app.createRateLimit({
    max: opts.cloudflareIngestRateLimitMax ?? DEFAULT_CLOUDFLARE_INGEST_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: request =>
      cloudflareIngestRateLimitKey(request, opts.cloudflareTrafficCredentialStore, app.db),
  })

  function validateTrafficSourceCredential(
    source: typeof trafficSources.$inferSelect,
    projectName: string,
  ): { usesPullSchedule: boolean } {
    if (source.sourceType === TrafficSourceTypes.cloudflare) {
      const config = cloudflareTrafficSourceConfigSchema.safeParse(source.configJson)
      if (!config.success) throw validationError('Cloudflare source configuration is invalid')
      const credential = opts.cloudflareTrafficCredentialStore?.getConnectionBySourceId(source.id)
      if (config.data.deliveryMode === CloudflareTrafficDeliveryModes['queue-pull']) {
        if (!credential || credential.deliveryMode !== 'queue-pull'
          || credential.projectName !== projectName
          || typeof credential.apiToken !== 'string' || credential.apiToken.trim().length === 0
          || credential.accountId !== config.data.accountId
          || credential.queueId !== config.data.queueId
          || credential.queueName !== config.data.queueName
          || credential.retentionSeconds !== config.data.retentionSeconds) {
          throw validationError('Cloudflare Queue credential is not configured for this source')
        }
        return { usesPullSchedule: true }
      }
      if (!credential || credential.deliveryMode !== 'direct-push'
        || credential.projectName !== projectName
        || !credential.bearerToken || !credential.hmacSecret
        || !source.ingestTokenHash
        || !timingSafeEqualHex(sha256Hex(credential.bearerToken), source.ingestTokenHash)) {
        throw validationError('Cloudflare direct-push credential is not configured for this source')
      }
      return { usesPullSchedule: false }
    }
    if (source.sourceType === TrafficSourceTypes['cloud-run']) {
      const credential = opts.cloudRunCredentialStore?.getConnection(projectName)
      if (!credential
        || credential.authMode !== TrafficSourceAuthModes['service-account']
        || !credential.clientEmail?.trim()
        || !credential.privateKey?.trim()
        || credential.gcpProjectId !== source.configJson.gcpProjectId
        || source.configJson.authMode !== TrafficSourceAuthModes['service-account']
        || (credential.serviceName ?? null) !== (source.configJson.serviceName ?? null)
        || (credential.location ?? null) !== (source.configJson.location ?? null)) {
        throw validationError('Cloud Run credential is not configured for this source')
      }
      return { usesPullSchedule: true }
    }
    if (source.sourceType === TrafficSourceTypes.wordpress) {
      const credential = opts.wordpressTrafficCredentialStore?.getConnection(projectName)
      if (!credential
        || typeof credential.applicationPassword !== 'string' || !credential.applicationPassword.trim()
        || credential.baseUrl !== source.configJson.baseUrl
        || credential.username !== source.configJson.username) {
        throw validationError('WordPress traffic credential is not configured for this source')
      }
      return { usesPullSchedule: true }
    }
    if (source.sourceType === TrafficSourceTypes.vercel) {
      const credential = opts.vercelTrafficCredentialStore?.getConnection(projectName)
      if (!credential
        || typeof credential.token !== 'string' || !credential.token.trim()
        || credential.projectId !== source.configJson.projectId
        || credential.teamId !== source.configJson.teamId
        || credential.environment !== source.configJson.environment) {
        throw validationError('Vercel traffic credential is not configured for this source')
      }
      return { usesPullSchedule: true }
    }
    throw validationError(`Traffic source type "${source.sourceType}" cannot be activated`)
  }

  // POST /projects/:name/traffic/connect/cloud-run
  app.post<{
    Params: { name: string }
    Body: {
      gcpProjectId?: string
      serviceName?: string
      location?: string
      displayName?: string
      keyJson?: string
    }
  }>('/projects/:name/traffic/connect/cloud-run', connectionRoute(app, () => ({ integration: 'traffic_cloud_run', action: 'connect' }), async (request, _reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)
    const body = request.body ?? {}
    const { gcpProjectId, serviceName, location, displayName, keyJson } = body

    if (!gcpProjectId || typeof gcpProjectId !== 'string') {
      throw validationError('gcpProjectId is required')
    }
    if (!keyJson) {
      throw validationError(
        'keyJson is required for v1 (service-account JSON content). OAuth-mode Cloud Run is not yet supported.',
      )
    }
    if (!opts.cloudRunCredentialStore) {
      throw validationError('Cloud Run credential storage is not configured for this deployment')
    }

    let parsed: { client_email?: string; private_key?: string }
    try {
      parsed = JSON.parse(keyJson) as { client_email?: string; private_key?: string }
    } catch {
      throw validationError('Invalid JSON in keyJson')
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw validationError('Service-account JSON must contain client_email and private_key')
    }

    const now = new Date().toISOString()
    const existing = opts.cloudRunCredentialStore.getConnection(project.name)
    if (existing) attempt.update({ action: 'reauth' })
    opts.cloudRunCredentialStore.upsertConnection({
      projectName: project.name,
      gcpProjectId,
      serviceName: serviceName ?? undefined,
      location: location ?? undefined,
      authMode: TrafficSourceAuthModes['service-account'],
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    const config: Record<string, unknown> = {
      gcpProjectId,
      serviceName: serviceName ?? null,
      location: location ?? null,
      authMode: TrafficSourceAuthModes['service-account'],
    }
    const fallbackName = displayName ?? `Cloud Run · ${gcpProjectId}${serviceName ? ` / ${serviceName}` : ''}`

    const { sourceRow, scheduleChanged } = app.db.transaction((tx) => {
      // Authority selection must share the same immediate transaction as the
      // write. A concurrent adapter connect that commits first is visible here
      // and this source is staged instead of creating a second authority.
      const activeSource = tx.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .find(row => row.sourceType === TrafficSourceTypes['cloud-run']
          && row.status !== TrafficSourceStatuses.archived)
      const sourceId = activeSource?.id ?? crypto.randomUUID()
      const sourceStatus = trafficConnectStatus(tx, project.id, activeSource)
      if (activeSource) {
        tx.update(trafficSources).set({
          displayName: fallbackName,
          status: sourceStatus,
          lastError: null,
          configJson: config,
          updatedAt: now,
        }).where(eq(trafficSources.id, sourceId)).run()
      } else {
        tx.insert(trafficSources).values({
          id: sourceId,
          projectId: project.id,
          sourceType: TrafficSourceTypes['cloud-run'],
          displayName: fallbackName,
          status: sourceStatus,
          lastSyncedAt: null,
          lastCursor: null,
          lastError: null,
          archivedAt: null,
          configJson: config,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
      const scheduleBinding = sourceStatus === TrafficSourceStatuses.connected
        ? bindTrafficSyncSchedule(tx, project.id, sourceId, now, false)
        : { changed: false, created: false }
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'traffic.cloud-run.connected',
        entityType: 'traffic_source',
        entityId: sourceId,
      })
      return {
        sourceRow: tx.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!,
        scheduleChanged: scheduleBinding.changed,
      }
    }, { behavior: 'immediate' })
    if (scheduleChanged) {
      opts.onScheduleUpdated?.('upsert', project.id, SchedulableRunKinds['traffic-sync'])
    }

    return rowToDto(sourceRow)
  }))

  // POST /projects/:name/traffic/connect/wordpress
  //
  // Probes the WordPress traffic-logger plugin endpoint with the supplied
  // Application Password (single-page, limit=1) before persisting — a probe
  // failure surfaces as `providerError()` so the caller sees a meaningful
  // diagnostic up front instead of discovering it at the first sync.
  app.post<{
    Params: { name: string }
    Body: {
      baseUrl?: string
      username?: string
      applicationPassword?: string
      displayName?: string
    }
  }>('/projects/:name/traffic/connect/wordpress', connectionRoute(app, () => ({ integration: 'traffic_wordpress', action: 'connect' }), async (request, _reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.wordpressTrafficCredentialStore) {
      throw validationError('WordPress traffic credential storage is not configured for this deployment')
    }
    const credentialStore = opts.wordpressTrafficCredentialStore

    const parsed = trafficConnectWordpressRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    const { baseUrl, username, applicationPassword, displayName } = parsed.data

    // SSRF guard: the probe attaches Basic-auth creds, so refuse any baseUrl
    // that resolves to a private / loopback / link-local address before the
    // fetch goes out. Without this check an API-key holder can target the
    // host's metadata service (169.254.169.254, metadata.google.internal),
    // RFC1918 ranges, or sidecar admin endpoints — and the error body
    // bubbles back through providerError below. The probe itself goes through
    // the guarded fetch, so DNS rebinding and redirects are checked as well.
    await assertWordpressTargetAllowed(baseUrl, attempt)
    // Probe the plugin endpoint up-front so the caller learns about a bad
    // URL / wrong credential before we touch any persistent state.
    try {
      await pullWordpressEvents({
        baseUrl,
        username,
        applicationPassword,
        pageSize: 1,
        maxPages: 1,
        fetchImpl: wordpressTrafficFetch,
      })
    } catch (e) {
      attempt.failed(e, e instanceof EgressRefusedError ? 'BLOCKED_UNSAFE_URL' : e instanceof EgressFailedError ? 'NETWORK' : undefined)
      if (e instanceof WordpressTrafficApiError) {
        throw providerError(
          `WordPress traffic probe failed (HTTP ${e.status}): ${e.message}${e.body ? ` — ${e.body}` : ''}`,
        )
      }
      // The name answered differently for the probe than for the check above.
      if (e instanceof EgressRefusedError && !e.redirected) throw validationError(`WordPress baseUrl rejected: ${e.message}`)
      const msg = describeError(e)
      throw providerError(`WordPress traffic probe failed: ${msg}`)
    }

    const now = new Date().toISOString()
    const existing = credentialStore.getConnection(project.name)
    if (existing) attempt.update({ action: 'reauth' })
    credentialStore.upsertConnection({
      projectName: project.name,
      baseUrl,
      username,
      applicationPassword,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    // Only non-secret config goes on the row — the Application Password lives
    // in ~/.canonry/config.yaml via the credential store.
    const config: Record<string, unknown> = { baseUrl, username }
    const fallbackName = displayName ?? `WordPress · ${new URL(baseUrl).host}`

    const { sourceRow, scheduleChanged } = app.db.transaction((tx) => {
      const activeSource = tx.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .find(row => row.sourceType === TrafficSourceTypes.wordpress
          && row.status !== TrafficSourceStatuses.archived)
      // A cursor and the accumulated rollups belong to one endpoint. An
      // in-place baseUrl change would make the new site's additive sync merge
      // into the old site's history under the same sourceId. Archive the old
      // lineage and create a fresh source instead. Credential rotation on the
      // same endpoint still preserves its progress.
      const endpointChanged = activeSource !== undefined
        && wordpressBaseUrlIdentity(activeSource.configJson.baseUrl)
          !== wordpressBaseUrlIdentity(baseUrl)
      const sourceId = endpointChanged ? crypto.randomUUID() : (activeSource?.id ?? crypto.randomUUID())
      const sourceStatus = trafficConnectStatus(tx, project.id, activeSource)
      if (activeSource && !endpointChanged) {
        tx.update(trafficSources).set({
          displayName: fallbackName,
          status: sourceStatus,
          lastError: null,
          configJson: config,
          updatedAt: now,
        }).where(eq(trafficSources.id, sourceId)).run()
      } else {
        if (activeSource) {
          tx.update(trafficSources).set({
            status: TrafficSourceStatuses.archived,
            archivedAt: now,
            updatedAt: now,
          }).where(eq(trafficSources.id, activeSource.id)).run()
        }
        tx.insert(trafficSources).values({
          id: sourceId,
          projectId: project.id,
          sourceType: TrafficSourceTypes.wordpress,
          displayName: fallbackName,
          status: sourceStatus,
          lastSyncedAt: null,
          lastCursor: null,
          lastError: null,
          archivedAt: null,
          configJson: config,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
      const scheduleBinding = sourceStatus === TrafficSourceStatuses.connected
        ? bindTrafficSyncSchedule(tx, project.id, sourceId, now, false)
        : { changed: false, created: false }
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'traffic.wordpress.connected',
        entityType: 'traffic_source',
        entityId: sourceId,
      })
      return {
        sourceRow: tx.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!,
        scheduleChanged: scheduleBinding.changed,
      }
    }, { behavior: 'immediate' })
    if (scheduleChanged) {
      opts.onScheduleUpdated?.('upsert', project.id, SchedulableRunKinds['traffic-sync'])
    }

    return rowToDto(sourceRow)
  }))

  // POST /projects/:name/traffic/connect/vercel
  //
  // Probes Vercel's internal `request-logs` endpoint with the supplied API
  // token (single page, tiny recent window) before persisting — a probe
  // failure surfaces as `providerError()` so the caller sees a bad token /
  // wrong project or team id up front instead of at the first sync.
  app.post<{
    Params: { name: string }
    Body: {
      projectId?: string
      teamId?: string
      token?: string
      environment?: string
      displayName?: string
    }
  }>('/projects/:name/traffic/connect/vercel', connectionRoute(app, () => ({ integration: 'traffic_vercel', action: 'connect' }), async (request, _reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.vercelTrafficCredentialStore) {
      throw validationError('Vercel traffic credential storage is not configured for this deployment')
    }
    const credentialStore = opts.vercelTrafficCredentialStore

    const parsed = trafficConnectVercelRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    const { projectId, teamId, token, displayName } = parsed.data
    const environment = parsed.data.environment ?? 'production'

    // Probe the request-logs endpoint up-front so the caller learns about a
    // bad token / wrong project or team id before we touch persistent state.
    // A 60-minute window keeps the probe cheap; we only need an HTTP 2xx.
    const probeEnd = Date.now()
    try {
      await pullVercelEvents({
        token,
        projectId,
        teamId,
        environment,
        startDate: probeEnd - 60 * 60_000,
        endDate: probeEnd,
        maxPages: 1,
      })
    } catch (e) {
      attempt.failed(e)
      if (e instanceof VercelLogsApiError) {
        throw providerError(
          `Vercel traffic probe failed (HTTP ${e.status}): ${e.message}${e.body ? ` — ${e.body}` : ''}`,
        )
      }
      const msg = describeError(e)
      throw providerError(`Vercel traffic probe failed: ${msg}`)
    }

    const now = new Date().toISOString()
    const existing = credentialStore.getConnection(project.name)
    if (existing) attempt.update({ action: 'reauth' })
    credentialStore.upsertConnection({
      projectName: project.name,
      projectId,
      teamId,
      token,
      environment,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    // Only non-secret config goes on the row — the API token lives in
    // ~/.canonry/config.yaml via the credential store.
    const config: Record<string, unknown> = { projectId, teamId, environment }
    const fallbackName = displayName ?? `Vercel · ${projectId}`

    // Source upsert + the auto-created traffic-sync schedule are one atomic
    // write — a source must never be left connected without the schedule that
    // keeps it syncing (that's the trap this fixes).
    const { sourceRow, scheduleChanged } = app.db.transaction((tx) => {
      const activeSource = tx.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .find(row => row.sourceType === TrafficSourceTypes.vercel
          && row.status !== TrafficSourceStatuses.archived)
      const sourceStatus = trafficConnectStatus(tx, project.id, activeSource)
      let row: typeof trafficSources.$inferSelect
      if (activeSource) {
        tx
          .update(trafficSources)
          .set({
            displayName: fallbackName,
            status: sourceStatus,
            lastError: null,
            configJson: config,
            updatedAt: now,
          })
          .where(eq(trafficSources.id, activeSource.id))
          .run()
        row = tx
          .select()
          .from(trafficSources)
          .where(eq(trafficSources.id, activeSource.id))
          .get()!
      } else {
        const newId = crypto.randomUUID()
        tx
          .insert(trafficSources)
          .values({
            id: newId,
            projectId: project.id,
            sourceType: TrafficSourceTypes.vercel,
            displayName: fallbackName,
            status: sourceStatus,
            // Seed lastSyncedAt to NOW so the first sync uses a tight window.
            // Leaving this null would make the first sync fall back to
            // DEFAULT_SYNC_WINDOW_MINUTES (30 days) — which exceeds Vercel's
            // request-logs retention (~14 days), causing the first sync to
            // throw a retention error and leaving the source permanently
            // stuck before it ever drained an event. New users opt into
            // historical recovery via the explicit `traffic backfill` command;
            // they do not silently inherit a 30-day pull on connect.
            lastSyncedAt: now,
            lastCursor: null,
            lastError: null,
            archivedAt: null,
            configJson: config,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        row = tx
          .select()
          .from(trafficSources)
          .where(eq(trafficSources.id, newId))
          .get()!
      }

      // Auto-create the traffic-sync schedule so the source actually keeps
      // syncing. Seeding lastSyncedAt=NOW above keeps only the FIRST window
      // tight; the watermark stays tight only if something advances it on
      // cadence, and nothing does without a schedule. An unscheduled source's
      // watermark drifts, and the next sync pulls an unbounded window that
      // wedges — the half of the first-sync trap (#634) that connect left open.
      // Idempotent for the same source. If an old pull source left a stale
      // binding, repoint it without changing the operator's enabled choice.
      const scheduleBinding = sourceStatus === TrafficSourceStatuses.connected
        ? bindTrafficSyncSchedule(tx, project.id, row.id, now)
        : { changed: false, created: false }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'traffic.vercel.connected',
        entityType: 'traffic_source',
        entityId: row.id,
      })
      if (scheduleBinding.created) {
        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'schedule.created',
          entityType: 'schedule',
          diff: {
            kind: SchedulableRunKinds['traffic-sync'],
            cronExpr: DEFAULT_TRAFFIC_SYNC_CRON,
            sourceId: row.id,
          },
        })
      }

      return { sourceRow: row, scheduleChanged: scheduleBinding.changed }
    }, { behavior: 'immediate' })

    // Refresh the live scheduler after creating a schedule or rebinding a
    // stale one. A reconnect already bound to this source remains a no-op.
    if (scheduleChanged) {
      opts.onScheduleUpdated?.('upsert', project.id, SchedulableRunKinds['traffic-sync'])
    }

    return rowToDto(sourceRow)
  }))

  // POST /projects/:name/traffic/connect/cloudflare
  //
  // Cloudflare adapter. Direct push issues per-source Worker secrets; Queue
  // pull stores its API token only in Canonry. Generated artifacts are secret
  // free in both modes and a matching-mode reconnect reuses the source row.
  app.post<{
    Params: { name: string }
    Body: TrafficConnectCloudflareRequest
  }>('/projects/:name/traffic/connect/cloudflare', connectionRoute(app, () => ({ integration: 'traffic_cloudflare', action: 'connect' }), async (request, _reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.cloudflareTrafficCredentialStore) {
      throw validationError('Cloudflare traffic credential storage is not configured for this deployment')
    }
    const credentialStore = opts.cloudflareTrafficCredentialStore

    const parsed = trafficConnectCloudflareRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    if (parsed.data.deliveryMode === CloudflareTrafficDeliveryModes['queue-pull']) {
      const { displayName, zoneId, accountId, queueId, queueName, retentionSeconds, apiToken } = parsed.data
      const workerRouteHost = resolveCloudflareWorkerRouteHost(project.canonicalDomain)
      const now = new Date().toISOString()
      const cloudflareSources = app.db.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .filter(row => row.sourceType === TrafficSourceTypes.cloudflare && row.status !== TrafficSourceStatuses.archived)
      const sameModeSource = cloudflareSources.find(row => parseQueuePullCloudflareSourceConfig(row.configJson))
      if (sameModeSource) attempt.update({ action: 'reauth' })
      const sourceId = sameModeSource?.id ?? crypto.randomUUID()
      const previousCredential = credentialStore.getConnectionBySourceId(sourceId)
      const workerVersion = CURRENT_CLOUDFLARE_WORKER_VERSION
      const workerScript = generateWorkerScript({
        deliveryMode: 'queue-pull', workerVersion, botList: DEFAULT_BOT_LIST,
      })
      const wranglerToml = generateWranglerToml({
        deliveryMode: 'queue-pull', sourceId, hostname: workerRouteHost, workerVersion,
        queueName, zoneId: zoneId ?? null, accountId,
      })
      const config = {
        schemaVersion: 1 as const,
        deliveryMode: 'queue-pull' as const,
        workerVersion,
        expectedBotListVersion: DEFAULT_BOT_LIST.version,
        zoneId: zoneId ?? null,
        accountId,
        queueId,
        queueName,
        retentionSeconds,
      }
      const nextCredential: CloudflareQueuePullTrafficCredentialRecord = {
        projectName: project.name, sourceId, deliveryMode: 'queue-pull', apiToken, accountId, queueId,
        queueName, retentionSeconds, workerVersion, expectedBotListVersion: DEFAULT_BOT_LIST.version,
        zoneId: zoneId ?? null, createdAt: previousCredential?.createdAt ?? now, updatedAt: now,
      }
      credentialStore.upsertConnection(nextCredential)
      let sourceRow: typeof trafficSources.$inferSelect
      let scheduleChanged = false
      try {
        const result = app.db.transaction((tx) => {
          const currentSameModeSource = tx.select().from(trafficSources)
            .where(eq(trafficSources.projectId, project.id)).all()
            .find(row => row.sourceType === TrafficSourceTypes.cloudflare
              && row.status !== TrafficSourceStatuses.archived
              && parseQueuePullCloudflareSourceConfig(row.configJson) !== null)
          if ((currentSameModeSource?.id ?? null) !== (sameModeSource?.id ?? null)) {
            throw operationInProgress('Cloudflare Queue source changed during connect; retry')
          }
          const status = trafficConnectStatus(tx, project.id, currentSameModeSource)
          if (currentSameModeSource) {
            const queueConfigChanged = !isDeepStrictEqual(currentSameModeSource.configJson, config)
            tx.update(trafficSources).set({
              displayName: displayName ?? currentSameModeSource.displayName,
              status,
              lastError: null,
              configJson: config,
              ingestTokenHash: null,
              ...(queueConfigChanged ? {
                queueBacklogCount: null,
                queueBacklogObservedAt: null,
              } : {}),
              updatedAt: now,
            }).where(eq(trafficSources.id, sourceId)).run()
          } else {
            tx.insert(trafficSources).values({
              id: sourceId, projectId: project.id, sourceType: TrafficSourceTypes.cloudflare,
              displayName: displayName ?? `Cloudflare Queue · ${queueName}`,
              status, lastSyncedAt: null, lastCursor: null, lastError: null, archivedAt: null,
              configJson: config, ingestTokenHash: null, createdAt: now, updatedAt: now,
            }).run()
          }
          const changed = status === TrafficSourceStatuses.connected
            ? bindTrafficSyncSchedule(tx, project.id, sourceId, now).changed
            : false
          return {
            row: tx.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!,
            scheduleChanged: changed,
          }
        }, { behavior: 'immediate' })
        sourceRow = result.row
        scheduleChanged = result.scheduleChanged
      } catch (error) {
        if (previousCredential) credentialStore.upsertConnection(previousCredential)
        else credentialStore.deleteConnectionBySourceId?.(sourceId)
        throw error
      }
      writeAuditLog(app.db, {
        projectId: project.id, actor: 'api', action: 'traffic.cloudflare.queue-connected',
        entityType: 'traffic_source', entityId: sourceId,
      })
      if (scheduleChanged) {
        opts.onScheduleUpdated?.('upsert', project.id, SchedulableRunKinds['traffic-sync'])
      }
      return {
        sourceId, deliveryMode: 'queue-pull' as const,
        activationRequired: sourceRow.status !== TrafficSourceStatuses.connected,
        accountId, queueId, queueName, retentionSeconds, workerScript, wranglerToml, workerVersion,
        instructions: [
          'Deploy this Worker to your Cloudflare zone:',
          '  1. Save worker.js and wrangler.toml; neither file contains Queue credentials',
          `  2. Enable the Queue HTTP pull consumer: wrangler queues consumer http add ${queueName}`,
          `  3. Attach ${workerRouteHost}/* in the Cloudflare Dashboard with Fail open`,
          `  4. Canonry pulls Queue ${queueName}; activate this source after the route is live.`,
          `Source id: ${sourceRow.id}`,
        ].join('\n'),
      }
    }
    if (!opts.cloudflareTrafficIngestUrl) {
      throw validationError('Cloudflare ingest URL is not configured for this deployment')
    }
    const { deliveryMode, displayName, zoneId, accountId } = parsed.data
    const workerRouteHost = resolveCloudflareWorkerRouteHost(project.canonicalDomain)

    const now = new Date().toISOString()

    const activeSource = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .all()
      .find((row) => row.sourceType === TrafficSourceTypes.cloudflare
        && row.status !== TrafficSourceStatuses.archived
        && parseDirectPushCloudflareSourceConfig(row.configJson) !== null)

    if (activeSource) attempt.update({ action: 'reauth' })
    const sourceId = activeSource?.id ?? crypto.randomUUID()
    const parsedActiveConfig = activeSource
      ? parseDirectPushCloudflareSourceConfig(activeSource.configJson)
      : null
    if (activeSource && !parsedActiveConfig) {
      throw validationError('Existing Cloudflare source is not configured for direct-push delivery')
    }
    const previousCredential = activeSource
      ? credentialStore.getConnectionBySourceId(activeSource.id)
      : undefined
    if (previousCredential && previousCredential.deliveryMode !== 'direct-push') {
      throw validationError(
        `Cloudflare credential delivery mode "${previousCredential.deliveryMode}" does not match "${deliveryMode}"`,
      )
    }
    const reusableCredential = previousCredential?.sourceId === sourceId
      ? previousCredential
      : undefined
    const previousZoneId = reusableCredential?.zoneId
      ?? parsedActiveConfig?.zoneId
      ?? null
    const previousAccountId = reusableCredential?.accountId
      ?? parsedActiveConfig?.accountId
      ?? null
    const effectiveZoneId = zoneId ?? previousZoneId
    const effectiveAccountId = accountId ?? previousAccountId
    const bearerToken = reusableCredential?.bearerToken
      ?? `cnry_cfw_${crypto.randomBytes(32).toString('hex')}`
    const hmacSecret = reusableCredential?.hmacSecret
      ?? crypto.randomBytes(32).toString('hex')
    const ingestTokenHash = sha256Hex(bearerToken)
    const ingestUrl = opts.cloudflareTrafficIngestUrl.replace('{name}', encodeURIComponent(project.name))
    assertCloudflareIngestUrlIsPublicHttps(ingestUrl)
    assertCloudflareIngestUrlOutsideWorkerRoute(ingestUrl, workerRouteHost)

    const workerVersion = CURRENT_CLOUDFLARE_WORKER_VERSION
    const workerScript = generateWorkerScript({
      deliveryMode,
      workerVersion,
      botList: DEFAULT_BOT_LIST,
    })
    const wranglerToml = generateWranglerToml({
      deliveryMode,
      sourceId,
      hostname: workerRouteHost,
      ingestUrl,
      workerVersion,
      zoneId: effectiveZoneId,
      accountId: effectiveAccountId,
    })

    const config: Record<string, unknown> = {
      schemaVersion: 1,
      deliveryMode,
      workerVersion,
      expectedBotListVersion: DEFAULT_BOT_LIST.version,
      zoneId: effectiveZoneId,
      accountId: effectiveAccountId,
    }
    const fallbackName = displayName
      ?? activeSource?.displayName
      ?? `Cloudflare · ${effectiveZoneId ?? sourceId.slice(0, 8)}`

    credentialStore.upsertConnection({
      projectName: project.name,
      deliveryMode,
      sourceId,
      bearerToken,
      hmacSecret,
      workerVersion,
      expectedBotListVersion: DEFAULT_BOT_LIST.version,
      zoneId: effectiveZoneId,
      accountId: effectiveAccountId,
      createdAt: previousCredential?.createdAt ?? activeSource?.createdAt ?? now,
      updatedAt: now,
    })

    let sourceRow: typeof trafficSources.$inferSelect
    let scheduleRemoved = false
    try {
      const result = app.db.transaction((tx) => {
        const currentActiveSource = tx.select().from(trafficSources)
          .where(eq(trafficSources.projectId, project.id)).all()
          .find(row => row.sourceType === TrafficSourceTypes.cloudflare
            && row.status !== TrafficSourceStatuses.archived
            && parseDirectPushCloudflareSourceConfig(row.configJson) !== null)
        if ((currentActiveSource?.id ?? null) !== (activeSource?.id ?? null)) {
          throw operationInProgress('Cloudflare direct-push source changed during connect; retry')
        }
        const sourceStatus = trafficConnectStatus(tx, project.id, currentActiveSource)
        let row: typeof trafficSources.$inferSelect
        if (currentActiveSource) {
          tx
            .update(trafficSources)
            .set({
              displayName: fallbackName,
              status: sourceStatus,
              lastError: null,
              configJson: config,
              ingestTokenHash,
              updatedAt: now,
            })
            .where(eq(trafficSources.id, currentActiveSource.id))
            .run()
          row = tx
            .select()
            .from(trafficSources)
            .where(eq(trafficSources.id, currentActiveSource.id))
            .get()!
        } else {
          tx
            .insert(trafficSources)
            .values({
              id: sourceId,
              projectId: project.id,
              sourceType: TrafficSourceTypes.cloudflare,
              displayName: fallbackName,
              status: sourceStatus,
              // Seed `lastSyncedAt` to NOW so the `traffic.source.recent-data`
              // doctor check has a non-null baseline. Successful ingest advances
              // it as the receiver's last-activity timestamp.
              lastSyncedAt: now,
              lastCursor: null,
              lastError: null,
              archivedAt: null,
              configJson: config,
              ingestTokenHash,
              createdAt: now,
              updatedAt: now,
            })
            .run()
          row = tx
            .select()
            .from(trafficSources)
            .where(eq(trafficSources.id, sourceId))
            .get()!
        }

        // Direct push is the active authority only when it is connected. A
        // traffic-sync schedule can only drive pull adapters, so remove any
        // stale schedule in the same transaction as this authority change.
        let removed = false
        if (row.status === TrafficSourceStatuses.connected) {
          const schedule = tx
            .select()
            .from(schedules)
            .where(and(
              eq(schedules.projectId, project.id),
              eq(schedules.kind, SchedulableRunKinds['traffic-sync']),
            ))
            .get()
          if (schedule) {
            tx.delete(schedules).where(eq(schedules.id, schedule.id)).run()
            removed = true
          }
        }
        return { row, scheduleRemoved: removed }
      }, { behavior: 'immediate' })
      sourceRow = result.row
      scheduleRemoved = result.scheduleRemoved
    } catch (err) {
      try {
        if (previousCredential) {
          credentialStore.upsertConnection(previousCredential)
        } else {
          credentialStore.deleteConnectionBySourceId?.(sourceId)
        }
      } catch {
        // Preserve the original DB failure; rollback failure only affects the
        // operator's next reconnect attempt.
      }
      throw err
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'traffic.cloudflare.connected',
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })
    if (scheduleRemoved) {
      opts.onScheduleUpdated?.('delete', project.id, SchedulableRunKinds['traffic-sync'])
    }

    const routeInstruction = effectiveZoneId
      ? `  4. Deploy with \`wrangler deploy\`; wrangler.toml records zone ${effectiveZoneId} but does not claim a route`
      : '  4. Deploy with `wrangler deploy`; wrangler.toml intentionally does not claim a route'
    const instructions = [
      'Deploy this Worker to your Cloudflare zone:',
      '  1. Save worker.js and wrangler.toml; neither file contains credentials',
      '  2. Install the required bearer and HMAC Worker secret bindings locally; never paste their values into source or chat',
      `  3. Inspect existing Cloudflare Worker routes first; confirm the generated \`${workerRouteHost}/*\` catch-all will not replace or collide with another Worker`,
      routeInstruction,
      `  5. In the Cloudflare Dashboard route form, select \`${workerRouteHost}/*\` and this Worker`,
      '  6. Set Request limit failure mode to Fail open, then save the route; Wrangler cannot set this toggle',
      '  7. Keep the Canonry ingest hostname outside this Worker route to avoid recursion',
      '',
      `Source id: ${sourceRow.id}`,
      'After deploy, check `canonry doctor --project ' + project.name + '` to confirm events are arriving.',
    ].join('\n')

    return {
      sourceId: sourceRow.id,
      deliveryMode,
      activationRequired: sourceRow.status !== TrafficSourceStatuses.connected,
      workerScript,
      wranglerToml,
      workerVersion,
      instructions,
    }
  }))

  // POST /projects/:name/traffic/sources/:id/activate
  //
  // Delivery adapters coexist as staged sources. Activation is the sole
  // cutover point: validate the local credential, pause all project siblings,
  // connect this source, and hand the one project traffic-sync schedule to a
  // pull adapter (or remove it for direct push) atomically.
  app.post<{
    Params: { name: string; id: string }
  }>('/projects/:name/traffic/sources/:id/activate', connectionRoute(app, (request) => {
    // Activation picks which source is the project's traffic authority.
    const source = app.db.select({ sourceType: trafficSources.sourceType }).from(trafficSources)
      .where(eq(trafficSources.id, request.params.id)).get()
    const integration = source ? TRAFFIC_SOURCE_INTEGRATIONS[source.sourceType] : undefined
    return integration ? { integration, action: 'select' } : undefined
  }, async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const now = new Date().toISOString()
    const result = app.db.transaction((tx) => {
      const target = tx.select().from(trafficSources).where(eq(trafficSources.id, request.params.id)).get()
      if (!target || target.projectId !== project.id || target.status === TrafficSourceStatuses.archived) {
        throw notFound('Traffic source', request.params.id)
      }
      const { usesPullSchedule } = validateTrafficSourceCredential(target, project.name)

      const siblings = tx.select().from(trafficSources).where(eq(trafficSources.projectId, project.id)).all()
      for (const sibling of siblings) {
        if (sibling.id === target.id || sibling.status === TrafficSourceStatuses.archived) continue
        tx.update(trafficSources).set({
          status: TrafficSourceStatuses.paused, updatedAt: now,
        }).where(eq(trafficSources.id, sibling.id)).run()
      }
      tx.update(trafficSources).set({
        status: TrafficSourceStatuses.connected, lastError: null, archivedAt: null, updatedAt: now,
      }).where(eq(trafficSources.id, target.id)).run()

      let scheduleAction: 'upsert' | 'delete' | null = null
      if (usesPullSchedule) {
        bindTrafficSyncSchedule(tx, project.id, target.id, now)
        scheduleAction = 'upsert'
      } else {
        const schedule = tx.select().from(schedules).where(and(
          eq(schedules.projectId, project.id), eq(schedules.kind, SchedulableRunKinds['traffic-sync']),
        )).get()
        if (schedule) {
          tx.delete(schedules).where(eq(schedules.id, schedule.id)).run()
          scheduleAction = 'delete'
        }
      }
      const source = tx.select().from(trafficSources).where(eq(trafficSources.id, target.id)).get()!
      writeAuditLog(tx, {
        projectId: project.id, actor: 'api', action: 'traffic.source.activated',
        entityType: 'traffic_source', entityId: target.id,
      })
      return { source, scheduleAction }
    })
    if (result.scheduleAction) {
      opts.onScheduleUpdated?.(result.scheduleAction, project.id, SchedulableRunKinds['traffic-sync'])
    }
    return rowToDto(result.source)
  }))

  // POST /projects/:name/traffic/cloudflare/ingest
  //
  // Push-receive endpoint. Verifies the per-source bearer + HMAC signature,
  // normalizes each event into `NormalizedTrafficRequest`, runs the shared
  // classifier + rollup pipeline, and updates `last_worker_version`.
  //
  // Auth: opt-out of the global cnry_* bearer check (see `auth.ts`
  // `shouldSkipAuth`). The handler reads `X-Canonry-Source-Id` to resolve
  // the credential row, then verifies bearer hash + HMAC. Any failure
  // returns a single 401 — never disambiguate which leg failed to a caller
  // (defends against credential-leg enumeration).
  app.post<{
    Params: { name: string }
    Body: unknown
  }>('/projects/:name/traffic/cloudflare/ingest', {
    bodyLimit: CLOUDFLARE_INGEST_BODY_LIMIT,
    preHandler: async (request, reply) => {
      const key = cloudflareIngestRateLimitKey(
        request,
        opts.cloudflareTrafficCredentialStore,
        app.db,
      )
      // The onRequest budget below already meters unauthenticated callers by
      // IP. Keep this independent second budget per authenticated source.
      if (key.startsWith('cloudflare-invalid:')) return

      const result = await checkCloudflareSourceRateLimit(request)
      if (result.isAllowed || !result.isExceeded) return
      reply.header('retry-after', result.ttlInSeconds)
      return reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded, retry in ${result.ttlInSeconds} second(s)`,
      })
    },
    config: {
      rateLimit: {
        hook: 'onRequest',
        max: opts.cloudflareIngestIpRateLimitMax ?? DEFAULT_CLOUDFLARE_INGEST_RATE_LIMIT_MAX,
        timeWindow: '1 minute',
        groupId: 'cloudflare-direct-push-ip',
        keyGenerator: request => `cloudflare-ingest-ip:${request.ip}`,
      },
    },
  }, async (request, reply) => {
    const ingestStartedMs = Date.now()
    // Telemetry only after authentication: an unauthenticated caller never reaches it.
    const reportIngest = (outcome: Pick<TrafficIngestedEvent, 'events' | 'crawlerHits' | 'aiReferralHits' | 'aiUserFetchHits'> | { failure: unknown; reasonCode?: OutcomeReasonCode }) => {
      try {
        opts.onTrafficIngested?.('failure' in outcome
          ? {
              sourceType: TrafficSourceTypes.cloudflare, status: 'failed', events: 0, crawlerHits: 0, aiReferralHits: 0,
              aiUserFetchHits: 0, durationMs: Date.now() - ingestStartedMs, ...routeOutcomeFailure(outcome.failure, outcome.reasonCode),
            }
          : { sourceType: TrafficSourceTypes.cloudflare, status: 'succeeded', ...outcome, durationMs: Date.now() - ingestStartedMs })
      } catch {
        // Telemetry never fails an ingest.
      }
    }
    // Authenticate the transport before resolving the path's project. Invalid
    // source, bearer, timestamp, signature, mode, and path all share one 401.
    const authenticated = authenticateCloudflareIngest(
      request,
      opts.cloudflareTrafficCredentialStore,
    )
    if (
      !authenticated
      || authenticated.credential.projectName !== request.params.name
      || !isDirectPushCloudflareDeliveryMode(authenticated.credential.deliveryMode)
    ) {
      throw authRequired()
    }
    const { bearerHash, credential } = authenticated
    const sourceId = credential.sourceId

    const sourceRow = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, sourceId))
      .get()
    if (
      !sourceRow
      || sourceRow.sourceType !== TrafficSourceTypes.cloudflare
      || sourceRow.status !== TrafficSourceStatuses.connected
      || !parseDirectPushCloudflareSourceConfig(sourceRow.configJson)
      || !timingSafeEqualHex(bearerHash, sourceRow.ingestTokenHash)
    ) {
      throw authRequired()
    }

    // Only authenticated callers can reach project resolution or payload
    // validation, so an arbitrary path cannot enumerate project names.
    const project = resolveProject(app.db, request.params.name)
    if (sourceRow.projectId !== project.id) throw authRequired()

    const parsed = cloudflareWorkerIngestRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reportIngest({ failure: undefined, reasonCode: 'VALIDATION' })
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    const { workerVersion, events } = parsed.data

    const canonicalHost = resolveCloudflareWorkerRouteHost(project.canonicalDomain)
    const wrongHostIndex = events.findIndex(event =>
      normalizeCloudflareEventHost(event.host) !== canonicalHost,
    )
    if (wrongHostIndex !== -1) {
      reportIngest({ failure: undefined, reasonCode: 'VALIDATION' })
      throw validationError(
        `Cloudflare event at index ${wrongHostIndex} does not belong to project domain "${project.canonicalDomain}"`,
      )
    }

    const normalized: NormalizedTrafficRequest[] = []
    let normalizationDrops = 0
    for (const event of events) {
      const result = normalizeCloudflareWorkerEvent(event)
      if (result) normalized.push(result)
      else normalizationDrops += 1
    }

    const receivedAt = new Date().toISOString()
    let writeResult: ReturnType<typeof writeTrafficEventBatch>
    try {
      writeResult = writeTrafficEventBatch({
        db: app.db,
        projectId: project.id,
        sourceId,
        events: normalized,
        receivedAt,
        receiptTtlMs: DIRECT_PUSH_RECEIPT_TTL_MS,
        sampleLimit,
        validateSource: (latestRow) => {
          if (
            !latestRow
            || latestRow.projectId !== project.id
            || latestRow.sourceType !== TrafficSourceTypes.cloudflare
            || latestRow.status !== TrafficSourceStatuses.connected
            || !parseDirectPushCloudflareSourceConfig(latestRow.configJson)
            || !timingSafeEqualHex(bearerHash, latestRow.ingestTokenHash)
          ) {
            throw authRequired()
          }
        },
        sourceUpdate: {
          lastWorkerVersion: workerVersion,
          lastSyncedAt: receivedAt,
          lastError: null,
          updatedAt: receivedAt,
        },
      })
    } catch (err) {
      reportIngest({ failure: err })
      throw err
    }
    reportIngest({
      events: writeResult.acceptedEvents,
      crawlerHits: writeResult.crawlerHits,
      aiReferralHits: writeResult.aiReferralHits,
      aiUserFetchHits: writeResult.aiUserFetchHits,
    })

    return reply.status(200).send({
      acceptedEvents: writeResult.acceptedEvents,
      droppedEvents: normalizationDrops + writeResult.duplicateEvents,
      workerVersionAck: workerVersion,
      crawlerBucketRows: writeResult.crawlerBucketRows,
      aiUserFetchBucketRows: writeResult.aiUserFetchBucketRows,
      aiReferralBucketRows: writeResult.aiReferralBucketRows,
      sampleRows: writeResult.sampleRows,
    })
  })

  // POST /projects/:name/traffic/sources/:id/sync
  //
  // Source-type-agnostic shell. The handler resolves the source row, sets up
  // the run row and shared error path, then dispatches to one of two
  // per-source adapters that each return `{ events, nextCursor? }`. Cloud Run
  // uses a clamped time window; WordPress pages through an opaque cursor.
  // Everything from dedupe through rollup transaction to telemetry/audit log
  // is shared.
  app.post<{
    Params: { name: string; id: string }
    Body: { sinceMinutes?: number }
  }>('/projects/:name/traffic/sources/:id/sync', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const initialSourceRow = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, request.params.id))
      .get()
    if (!initialSourceRow || initialSourceRow.projectId !== project.id) {
      throw notFound('Traffic source', request.params.id)
    }
    let sourceRow: typeof trafficSources.$inferSelect = initialSourceRow
    const queueConfig = sourceRow.sourceType === TrafficSourceTypes.cloudflare
      ? parseQueuePullCloudflareSourceConfig(sourceRow.configJson)
      : null
    if (queueConfig) {
      if (sourceRow.status !== TrafficSourceStatuses.connected) {
        throw validationError('Cloudflare Queue source must be active before it can sync')
      }
      const credential = opts.cloudflareTrafficCredentialStore?.getConnectionBySourceId(sourceRow.id)
      if (!credential || credential.deliveryMode !== 'queue-pull'
        || credential.projectName !== project.name
        || typeof credential.apiToken !== 'string' || credential.apiToken.trim().length === 0
        || credential.accountId !== queueConfig.accountId
        || credential.queueId !== queueConfig.queueId
        || credential.queueName !== queueConfig.queueName
        || credential.retentionSeconds !== queueConfig.retentionSeconds) {
        throw validationError('Cloudflare Queue credential is not configured for this source')
      }
      const queueClient: CloudflareQueueClientOptions = {
        accountId: credential.accountId, queueId: credential.queueId, apiToken: credential.apiToken,
      }
      const now = new Date().toISOString()
      const leaseOwner = crypto.randomUUID()
      if (!tryClaimTrafficSyncLease({
        db: app.db, sourceId: sourceRow.id, owner: leaseOwner, now, ttlMs: CLOUDFLARE_QUEUE_SYNC_LEASE_TTL_MS,
      })) {
        throw operationInProgress('Cloudflare Queue source sync is already in progress', { sourceId: sourceRow.id })
      }
      const runId = crypto.randomUUID()
      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      try {
        app.db.insert(runs).values({
          id: runId, projectId: project.id, kind: RunKinds['traffic-sync'], status: RunStatuses.running,
          trigger: RunTriggers.manual, sourceId: sourceRow.id, startedAt, createdAt: startedAt,
        }).run()
        let acceptedEvents = 0
        let selfTrafficExcluded = 0
        let crawlerHits = 0
        let aiUserFetchHits = 0
        let aiReferralHits = 0
        let unknownHits = 0
        let crawlerBucketRows = 0
        let aiUserFetchBucketRows = 0
        let aiReferralBucketRows = 0
        let sampleRows = 0
        let committedAt = startedAt
        let remainingBacklogCount = 0
        const canonicalHost = resolveCloudflareWorkerRouteHost(project.canonicalDomain)
        for (let batch = 0; batch < cloudflareQueueMaxBatches; batch += 1) {
          if (!tryClaimTrafficSyncLease({
            db: app.db, sourceId: sourceRow.id, owner: leaseOwner, now: new Date().toISOString(),
            ttlMs: CLOUDFLARE_QUEUE_SYNC_LEASE_TTL_MS,
          })) throw new Error('Queue sync lease was lost')
          const pulled = await pullQueueMessages(queueClient, {
            batchSize: CLOUDFLARE_QUEUE_BATCH_SIZE,
            visibilityTimeoutMs: CLOUDFLARE_QUEUE_VISIBILITY_TIMEOUT_MS,
          })
          remainingBacklogCount = pulled.messageBacklogCount
          if (pulled.skippedUnleasedMessageCount > 0) {
            request.log.warn({
              sourceId: sourceRow.id,
              skippedUnleasedMessageCount: pulled.skippedUnleasedMessageCount,
            }, 'Skipped unacknowledgeable Cloudflare Queue messages; they remain eligible for redelivery')
          }
          const validLeases: string[] = []
          const poisonLeases: string[] = []
          const normalized: NormalizedTrafficRequest[] = []
          let workerVersion: string | null = null
          for (const message of pulled.messages) {
            if (message.contentType === 'poison') {
              poisonLeases.push(message.leaseId)
              request.log.warn({ sourceId: sourceRow.id, messageId: message.id, reason: message.reason },
                'Dropping malformed Cloudflare Queue message')
              continue
            }
            // The generated Worker is a JSON producer. Do not infer JSON from
            // a text body: an alternate producer must opt into the same wire
            // contract explicitly, otherwise ACK/drop the leased poison once.
            if (message.contentType !== 'json') {
              poisonLeases.push(message.leaseId)
              request.log.warn({
                sourceId: sourceRow.id,
                messageId: message.id,
                contentType: message.contentType,
                reason: 'unsupported-content-type',
              }, 'Dropping Cloudflare Queue message with an unsupported content type')
              continue
            }
            const parsedBatch = cloudflareWorkerIngestRequestSchema.safeParse(message.body)
            if (!parsedBatch.success) {
              poisonLeases.push(message.leaseId)
              request.log.warn({ sourceId: sourceRow.id, messageId: message.id },
                'Dropping Cloudflare Queue message with an invalid Canonry batch')
              continue
            }
            if (parsedBatch.data.events.some(event => normalizeCloudflareEventHost(event.host) !== canonicalHost)) {
              poisonLeases.push(message.leaseId)
              request.log.warn({ sourceId: sourceRow.id, messageId: message.id },
                'Dropping Cloudflare Queue message for another host')
              continue
            }
            workerVersion = parsedBatch.data.workerVersion
            for (const event of parsedBatch.data.events) {
              const normalizedEvent = normalizeCloudflareWorkerEvent(event)
              if (normalizedEvent) normalized.push(normalizedEvent)
            }
            validLeases.push(message.leaseId)
          }
          committedAt = new Date().toISOString()
          const writeResult = writeTrafficEventBatch({
            db: app.db, projectId: project.id, sourceId: sourceRow.id, events: normalized,
            receivedAt: committedAt,
            receiptTtlMs: CLOUDFLARE_QUEUE_RECEIPT_TTL_MS,
            sampleLimit,
            validateSource: latest => {
              if (!latest || latest.projectId !== project.id
                || latest.status !== TrafficSourceStatuses.connected
                || latest.syncLeaseOwner !== leaseOwner
                || !isDeepStrictEqual(latest.configJson, sourceRow.configJson)) {
                throw validationError('Cloudflare Queue source is no longer active')
              }
            },
            sourceUpdate: {
              status: TrafficSourceStatuses.connected, lastSyncedAt: committedAt, lastError: null,
              queueBacklogCount: remainingBacklogCount, queueBacklogObservedAt: committedAt,
              ...(workerVersion ? { lastWorkerVersion: workerVersion } : {}), updatedAt: committedAt,
            },
          })
          // Ack this <=100-message lease batch only after its receipt+rollup commit.
          if (validLeases.length > 0 || poisonLeases.length > 0) {
            // A Queue ACK may retry transient 429/5xx responses. Renew right
            // before it starts so the source lease covers the entire ACK
            // attempt rather than only the preceding pull/commit work.
            if (!tryClaimTrafficSyncLease({
              db: app.db, sourceId: sourceRow.id, owner: leaseOwner,
              now: new Date().toISOString(), ttlMs: CLOUDFLARE_QUEUE_SYNC_LEASE_TTL_MS,
            })) throw new Error('Queue sync lease was lost before acknowledgement')
            const latestSource = app.db.select().from(trafficSources)
              .where(eq(trafficSources.id, sourceRow.id)).get()
            if (!latestSource
              || latestSource.projectId !== project.id
              || latestSource.status !== TrafficSourceStatuses.connected
              || latestSource.syncLeaseOwner !== leaseOwner
              || !isDeepStrictEqual(latestSource.configJson, sourceRow.configJson)) {
              throw validationError('Cloudflare Queue source was reconfigured before acknowledgement')
            }
            const ackResult = await ackQueueMessages(queueClient, { acks: [...validLeases, ...poisonLeases] })
            if (ackResult.warningCount > 0) {
              request.log.warn({
                sourceId: sourceRow.id,
                warningCount: ackResult.warningCount,
              }, 'Cloudflare Queue acknowledgement completed with warnings')
            }
          }
          acceptedEvents += writeResult.acceptedEvents
          selfTrafficExcluded += writeResult.selfTrafficExcluded
          crawlerHits += writeResult.crawlerHits
          aiUserFetchHits += writeResult.aiUserFetchHits
          aiReferralHits += writeResult.aiReferralHits
          unknownHits += writeResult.unknownHits
          crawlerBucketRows += writeResult.crawlerBucketRows
          aiUserFetchBucketRows += writeResult.aiUserFetchBucketRows
          aiReferralBucketRows += writeResult.aiReferralBucketRows
          sampleRows += writeResult.sampleRows
          const pulledEnvelopeCount = pulled.messages.length + pulled.skippedUnleasedMessageCount
          if (pulledEnvelopeCount < CLOUDFLARE_QUEUE_BATCH_SIZE || remainingBacklogCount === 0) break
        }
        app.db.update(runs).set({ status: RunStatuses.completed, finishedAt: committedAt })
          .where(eq(runs.id, runId)).run()
        writeAuditLog(app.db, {
          projectId: project.id, actor: 'api', action: 'traffic.cloudflare.queue-synced',
          entityType: 'traffic_source', entityId: sourceRow.id,
        })
        try {
          opts.onTrafficSynced?.({
            status: 'completed', sourceType: sourceRow.sourceType, sourceId: sourceRow.id,
            pulledEvents: acceptedEvents, selfTrafficExcluded,
            crawlerHits, aiUserFetchHits, aiReferralHits,
            durationMs: Date.now() - startedMs,
          })
        } catch { /* telemetry never blocks Queue acknowledgement */ }
        const response: TrafficSyncResponse = {
          sourceId: sourceRow.id, runId, syncedAt: committedAt, pulledEvents: acceptedEvents,
          selfTrafficExcluded, crawlerHits, aiUserFetchHits, aiReferralHits, unknownHits,
          crawlerBucketRows, aiUserFetchBucketRows, aiReferralBucketRows, sampleRows,
          remainingBacklogCount,
          windowStart: startedAt, windowEnd: committedAt,
        }
        return response
      } catch (error) {
        const failedAt = new Date().toISOString()
        const safeError = error instanceof CloudflareQueueApiError
          ? error.message
          : 'Cloudflare Queue sync failed; retry the active source.'
        try {
          opts.onTrafficSynced?.({
            status: 'failed', sourceType: sourceRow.sourceType, sourceId: sourceRow.id,
            pulledEvents: 0, selfTrafficExcluded: 0, crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0,
            durationMs: Date.now() - startedMs,
            // A 401/403 is the stored API token; any other Queue API answer is the pull.
            errorCode: error instanceof CloudflareQueueApiError
              ? (error.status === 401 || error.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_PULL')
              : 'INTERNAL',
          })
        } catch { /* telemetry never blocks the failure path */ }
        app.db.transaction((tx) => {
          tx.update(runs).set({ status: RunStatuses.failed, error: safeError, finishedAt: failedAt })
            .where(eq(runs.id, runId)).run()
          const latestSource = tx.select().from(trafficSources)
            .where(eq(trafficSources.id, sourceRow.id)).get()
          if (latestSource
            && latestSource.status === TrafficSourceStatuses.connected
            && latestSource.syncLeaseOwner === leaseOwner
            && isDeepStrictEqual(latestSource.configJson, sourceRow.configJson)) {
            tx.update(trafficSources).set({ lastError: safeError, updatedAt: failedAt })
              .where(and(
                eq(trafficSources.id, sourceRow.id),
                eq(trafficSources.status, TrafficSourceStatuses.connected),
                eq(trafficSources.syncLeaseOwner, leaseOwner),
              )).run()
          }
        })
        throw providerError(safeError)
      } finally {
        releaseTrafficSyncLease({
          db: app.db, sourceId: sourceRow.id, owner: leaseOwner, now: new Date().toISOString(),
        })
      }
    }
    if (
      sourceRow.sourceType !== TrafficSourceTypes['cloud-run']
      && sourceRow.sourceType !== TrafficSourceTypes.wordpress
      && sourceRow.sourceType !== TrafficSourceTypes.vercel
    ) {
      throw validationError(
        `Sync for source type "${sourceRow.sourceType}" is not implemented yet — only cloud-run, wordpress, and vercel are supported in v1.`,
      )
    }
    const hasConnectedSibling = sourceRow.status === TrafficSourceStatuses.error
      && app.db.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .some(row => row.id !== sourceRow.id && row.status === TrafficSourceStatuses.connected)
    if (
      sourceRow.status === TrafficSourceStatuses.paused
      || sourceRow.status === TrafficSourceStatuses.archived
      || hasConnectedSibling
    ) {
      throw validationError('Traffic source must be active before it can sync')
    }

    // WordPress continuation state is durable, but it is not a lease: a
    // scheduler tick and a manual retry could otherwise both resume the same
    // cursor/window. Claim before inserting the run or reserving a window so
    // a loser performs no provider I/O and cannot poison the winner's source
    // generation on failure.
    const wordpressLeaseOwner = sourceRow.sourceType === TrafficSourceTypes.wordpress
      ? crypto.randomUUID()
      : undefined
    if (wordpressLeaseOwner && !tryClaimTrafficSyncLease({
      db: app.db,
      sourceId: sourceRow.id,
      owner: wordpressLeaseOwner,
      now: new Date().toISOString(),
      ttlMs: WORDPRESS_SYNC_LEASE_TTL_MS,
    })) {
      throw operationInProgress('WordPress source sync is already in progress', { sourceId: sourceRow.id })
    }

    try {
    // A new pull uses the sync-start instant as its exclusive upper bound. A
    // resumed WordPress continuation replaces `windowEnd` with its persisted
    // boundary so every retry pages through one finite interval exactly.
    const syncWindowEnd = new Date()
    let windowEnd = syncWindowEnd
    const startedAt = syncWindowEnd.toISOString()
    const syncStartedAtMs = syncWindowEnd.getTime()
    const runId = crypto.randomUUID()
    app.db
      .insert(runs)
      .values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['traffic-sync'],
        status: RunStatuses.running,
        trigger: RunTriggers.manual,
        sourceId: sourceRow.id,
        startedAt,
        createdAt: startedAt,
      })
      .run()

    const markFailed = (msg: string, errorCode: TrafficSyncedEvent['errorCode']) => {
      const failedAt = new Date().toISOString()
      app.db.transaction((tx) => {
        tx
          .update(runs)
          .set({ status: RunStatuses.failed, error: msg, finishedAt: failedAt })
          .where(eq(runs.id, runId))
          .run()
        const latestSource = tx.select().from(trafficSources)
          .where(eq(trafficSources.id, sourceRow.id)).get()
        // A cutover may have paused or reconfigured this source while the
        // provider call was in flight. Preserve that newer lifecycle state.
        if (latestSource?.status === TrafficSourceStatuses.connected
          && isSameTrafficSourceGeneration(latestSource, sourceRow)
          && (wordpressLeaseOwner === undefined || latestSource.syncLeaseOwner === wordpressLeaseOwner)) {
          tx
            .update(trafficSources)
            .set({ status: TrafficSourceStatuses.error, lastError: msg, updatedAt: failedAt })
            .where(eq(trafficSources.id, sourceRow.id))
            .run()
        }
      })
      // Fire-and-forget: never let a telemetry hook take down the sync.
      try {
        opts.onTrafficSynced?.({
          status: 'failed',
          sourceType: sourceRow.sourceType,
          sourceId: sourceRow.id,
          pulledEvents: 0,
          selfTrafficExcluded: 0,
          crawlerHits: 0,
          aiUserFetchHits: 0,
          aiReferralHits: 0,
          durationMs: Date.now() - syncStartedAtMs,
          errorCode,
        })
      } catch {
        // swallow — never block on telemetry
      }
    }

    const renewWordpressLease = () => {
      if (!wordpressLeaseOwner) return
      if (!tryClaimTrafficSyncLease({
        db: app.db,
        sourceId: sourceRow.id,
        owner: wordpressLeaseOwner,
        now: new Date().toISOString(),
        ttlMs: WORDPRESS_SYNC_LEASE_TTL_MS,
      })) {
        throw new Error('WordPress sync lease was lost')
      }
    }

    // Per-source dispatch: each branch validates its own credential store and
    // pulls events. windowStart and windowEnd bound both Cloud Run and
    // WordPress pulls; WordPress additionally uses an opaque cursor to resume
    // a partial drain inside that interval. nextCursor is only set by WP.
    let windowStart: Date
    let allEvents: NormalizedTrafficRequest[]
    let nextCursor: string | undefined
    let auditAction: string
    // The instant `lastSyncedAt` advances to on success. Defaults to windowEnd
    // (the pull's upper bound); the Vercel branch lowers it to the partial
    // boundary when an adaptive drain stops at its deadline mid-window.
    let effectiveWindowEnd = windowEnd

    if (sourceRow.sourceType === TrafficSourceTypes['cloud-run']) {
      auditAction = 'traffic.cloud-run.synced'
      const credentialStore = opts.cloudRunCredentialStore
      if (!credentialStore) {
        throw validationError('Cloud Run credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Cloud Run credential found for project "${project.name}". Run "canonry traffic connect cloud-run" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const gcpProjectId = (config.gcpProjectId as string | undefined) ?? credential.gcpProjectId
      const serviceName = (config.serviceName as string | null | undefined) ?? credential.serviceName ?? undefined
      const location = (config.location as string | null | undefined) ?? credential.location ?? undefined

      const requestedMinutes = request.body?.sinceMinutes
      const windowMinutes = Number.isFinite(requestedMinutes) && requestedMinutes && requestedMinutes > 0
        ? Math.floor(requestedMinutes)
        : syncWindowMinutes

      // Clamp windowStart forward to lastSyncedAt so back-to-back syncs don't
      // re-pull the previous window and double-count via the `hits + ?` upsert.
      const requestedStartMs = windowEnd.getTime() - windowMinutes * 60_000
      const lastSyncedMs = sourceRow.lastSyncedAt
        ? new Date(sourceRow.lastSyncedAt).getTime()
        : Number.NEGATIVE_INFINITY
      windowStart = new Date(
        Math.min(windowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs)),
      )

      let accessToken: string
      try {
        accessToken = await resolveAccessToken(credential)
      } catch (e) {
        const msg = describeError(e)
        markFailed(msg, 'PROVIDER_AUTH')
        throw providerError(`Failed to resolve Cloud Run access token: ${msg}`)
      }

      // Tell the Cloud Run client this is a first-time backfill if no prior
      // cursor exists, so its bounded page budget targets the most-recent
      // entries instead of exhausting on the oldest. Adapter-specific pull
      // strategy lives in @ainyc/canonry-integration-cloud-run, not here.
      const isFirstSync = !sourceRow.lastSyncedAt
      try {
        const page = await pullEvents(accessToken, {
          gcpProjectId,
          serviceName,
          location,
          startTime: windowStart.toISOString(),
          endTime: windowEnd.toISOString(),
          pageSize,
          maxPages,
          firstSync: isFirstSync,
          requestUrlSubstrings: [project.canonicalDomain],
        })
        allEvents = page.events
      } catch (e) {
        const msg = describeError(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw providerError(`Cloud Run pull failed: ${msg}`)
      }
    } else if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
      // WordPress traffic-logger adapter. Every pull is a reserved half-open
      // window, with an opaque cursor only for pagination inside it. Keep its
      // lower and upper bounds fixed while a page cap leaves a cursor behind;
      // otherwise the next cursor+window query could skip or chase events.
      auditAction = 'traffic.wordpress.synced'
      const credentialStore = opts.wordpressTrafficCredentialStore
      if (!credentialStore) {
        throw validationError('WordPress traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        // Audit log + markFailed would over-rotate the source row; this is a
        // user-config error before any pull happens, so the global handler's
        // validationError envelope is the right surface.
        app.db
          .delete(runs)
          .where(eq(runs.id, runId))
          .run()
        throw validationError(
          `No WordPress credential found for project "${project.name}". Run "canonry traffic connect wordpress" first.`,
        )
      }

      // A cursor written by the old unbounded sync has no recorded upper
      // boundary, so its already-advanced `lastSyncedAt` is not a valid
      // lower bound. Refuse that ambiguous legacy state rather than silently
      // skipping its undrained middle or replaying it without a window.
      if (sourceRow.lastCursor && !sourceRow.wordpressPendingUntil) {
        const message = 'WordPress source has a legacy continuation cursor without a bounded pending window. Reset it explicitly before resuming sync.'
        markFailed(message, 'INTERNAL')
        throw validationError(message)
      }

      if (sourceRow.wordpressPendingUntil) {
        // Resume a previously reserved finite window exactly. This also
        // covers a transient failure before its first page committed: there
        // is no cursor yet, but reusing the same bounds prevents a retry from
        // sliding the intended coverage forward.
        const pendingStartMs = sourceRow.lastSyncedAt
          ? Date.parse(sourceRow.lastSyncedAt)
          : Number.NaN
        const pendingEndMs = Date.parse(sourceRow.wordpressPendingUntil)
        if (!Number.isFinite(pendingStartMs)
          || !Number.isFinite(pendingEndMs)
          || pendingStartMs >= pendingEndMs
          || pendingEndMs > syncWindowEnd.getTime()) {
          const message = 'WordPress source has an invalid pending sync window. Reset it explicitly before resuming sync.'
          markFailed(message, 'INTERNAL')
          throw validationError(message)
        }
        windowStart = new Date(pendingStartMs)
        windowEnd = new Date(pendingEndMs)
        effectiveWindowEnd = windowEnd
      } else {
        const requestedMinutes = request.body?.sinceMinutes
        const hasExplicitWindow = Number.isFinite(requestedMinutes)
          && requestedMinutes !== undefined
          && requestedMinutes > 0
        const windowMinutes = hasExplicitWindow
          ? Math.floor(requestedMinutes)
          : DEFAULT_WP_SYNC_WINDOW_MINUTES
        const requestedStartMs = syncWindowEnd.getTime() - windowMinutes * 60_000
        const lastSyncedMs = sourceRow.lastSyncedAt
          ? new Date(sourceRow.lastSyncedAt).getTime()
          : Number.NEGATIVE_INFINITY
        windowStart = new Date(
          Math.min(syncWindowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs)),
        )
        const windowStartIso = windowStart.toISOString()
        const windowEndIso = windowEnd.toISOString()

        // Reserve the complete window before the provider call. A retry after
        // an upstream failure therefore uses identical bounds, and a capped
        // drain persists a cursor whose lower and upper limits are both known.
        const reservedAt = new Date().toISOString()
        // Take SQLite's write reservation before the generation read. A
        // deferred transaction lets two API processes both read the old row,
        // then makes the loser fail with SQLITE_BUSY_SNAPSHOT instead of
        // returning the ordinary stale-generation retry response.
        const reservedSource = app.db.transaction((tx) => {
          const latestSource = tx.select().from(trafficSources)
            .where(eq(trafficSources.id, sourceRow.id)).get()
          if (!latestSource
            || !isAuthoritativeTrafficSource(tx, latestSource)
            || !isSameTrafficSourceGeneration(latestSource, sourceRow)
            || latestSource.syncLeaseOwner !== wordpressLeaseOwner
            || latestSource.lastCursor
            || latestSource.wordpressPendingUntil) return undefined
          tx.update(trafficSources)
            .set({
              lastSyncedAt: windowStartIso,
              wordpressPendingUntil: windowEndIso,
              updatedAt: reservedAt,
            })
            .where(eq(trafficSources.id, sourceRow.id))
            .run()
          return tx.select().from(trafficSources)
            .where(eq(trafficSources.id, sourceRow.id)).get()
        }, { behavior: 'immediate' })
        if (!reservedSource) {
          const message = 'Traffic source changed while reserving the WordPress sync window; retry the sync.'
          markFailed(message, 'INTERNAL')
          throw validationError(message)
        }
        sourceRow = reservedSource
      }
      const windowStartIso = windowStart.toISOString()
      const windowEndIso = windowEnd.toISOString()

      const wpPageSize = opts.defaultWordpressPageSize ?? DEFAULT_WP_PAGE_SIZE
      const wpMaxPages = opts.defaultWordpressMaxPages ?? DEFAULT_WP_MAX_PAGES

      // Re-validate the persisted baseUrl on every sync, so a host that now
      // resolves to a private address fails the sync before any pull. Each
      // per-page fetch below goes through the guarded fetch, which checks the
      // address again and dials only that address, so DNS rebinding between
      // pages, or a redirect, can't carry Basic-auth creds to a metadata or
      // RFC1918 host.
      try {
        renewWordpressLease()
        await assertWordpressTargetAllowed(credential.baseUrl)
      } catch (e) {
        const msg = describeError(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw e
      }

      const collected: NormalizedTrafficRequest[] = []
      let cursor: string | undefined = sourceRow.lastCursor ?? undefined
      try {
        for (let page = 0; page < wpMaxPages; page += 1) {
          renewWordpressLease()
          const pageResult = await pullWordpressEvents({
            baseUrl: credential.baseUrl,
            username: credential.username,
            applicationPassword: credential.applicationPassword,
            cursor,
            pageSize: wpPageSize,
            maxPages: 1,
            since: windowStartIso,
            until: windowEndIso,
            fetchImpl: wordpressTrafficFetch,
          })
          collected.push(...pageResult.events)
          const previousCursor = cursor
          cursor = pageResult.nextCursor
          // A terminal plugin page has `has_more=false` and no cursor. Clear
          // any stale value defensively so the next sync starts at the bounded
          // watermark instead of replaying a historical cursor.
          if (!pageResult.hasMore) {
            cursor = undefined
            break
          }
          // A continuation is useful only with a new cursor. Fail before the
          // rollup transaction if the endpoint claims more events but cannot
          // provide one, because advancing the watermark would lose them.
          if (!cursor || cursor === previousCursor) {
            throw new Error('WordPress traffic endpoint returned has_more without a new continuation cursor')
          }
        }
        allEvents = collected
        nextCursor = cursor
      } catch (e) {
        const msg = describeError(e)
        markFailed(msg, 'PROVIDER_PULL')
        // The stored URL now resolves to a refused address: the same 400 the
        // check above gives. A refused redirect is the site's failure.
        if (e instanceof EgressRefusedError && !e.redirected) throw validationError(`WordPress baseUrl rejected: ${msg}`)
        throw providerError(`WordPress pull failed: ${msg}`)
      }
    } else {
      // Vercel `request-logs` adapter. Pulls the full `[windowStart,
      // windowEnd]` time window. Vercel paginates by page number with no
      // resumable cursor, so a dense window is drained in adaptive time
      // sub-windows: `drainVercelTrafficEvents` narrows the span until each
      // slice fits the per-sub-window page budget, deduping by eventId. If
      // Vercel can only serve a retained tail, the sync fails before commit so
      // `lastSyncedAt` never advances across missing history.
      auditAction = 'traffic.vercel.synced'
      const credentialStore = opts.vercelTrafficCredentialStore
      if (!credentialStore) {
        app.db.delete(runs).where(eq(runs.id, runId)).run()
        throw validationError('Vercel traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        // User-config error before any pull happens — the global handler's
        // validationError envelope is the right surface. Drop the run row so
        // it doesn't linger as 'running'.
        app.db.delete(runs).where(eq(runs.id, runId)).run()
        throw validationError(
          `No Vercel credential found for project "${project.name}". Run "canonry traffic connect vercel" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const vercelProjectId = (config.projectId as string | undefined) ?? credential.projectId
      const vercelTeamId = (config.teamId as string | undefined) ?? credential.teamId
      const vercelEnvironment = (config.environment as 'production' | 'preview' | undefined)
        ?? credential.environment

      const requestedMinutes = request.body?.sinceMinutes
      const windowMinutes = Number.isFinite(requestedMinutes) && requestedMinutes && requestedMinutes > 0
        ? Math.floor(requestedMinutes)
        : syncWindowMinutes

      // Clamp windowStart forward to lastSyncedAt so back-to-back syncs don't
      // re-pull the previous window and double-count via the `hits + ?` upsert.
      const requestedStartMs = windowEnd.getTime() - windowMinutes * 60_000
      const lastSyncedMs = sourceRow.lastSyncedAt
        ? new Date(sourceRow.lastSyncedAt).getTime()
        : Number.NEGATIVE_INFINITY
      const clampedStartMs = Math.min(windowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs))
      // Cap how far back one sync reaches. A watermark that drifted past the cap
      // (source idle while its schedule was paused/missing) would otherwise make
      // the adaptive drain grind through days of sub-windows in a single sync.
      // Skipping the pre-cap span is surfaced, not silent — a backfill recovers it.
      const cappedStartMs = Math.max(clampedStartMs, windowEnd.getTime() - VERCEL_MAX_SYNC_WINDOW_MS)
      if (cappedStartMs > clampedStartMs) {
        // Persist the skip. The warning alone is not enough: once the sync
        // commits, the watermark advances and current lag looks normal again,
        // so a check that reads only lag would call this source healthy a cycle
        // later while a hole in its history stays unrecovered. Keep the NEWEST
        // skipped instant so repeated skips do not understate the gap.
        const previousSkip = sourceRow.skippedThroughAt ? Date.parse(sourceRow.skippedThroughAt) : Number.NaN
        const skippedThrough = Number.isFinite(previousSkip)
          ? new Date(Math.max(previousSkip, cappedStartMs))
          : new Date(cappedStartMs)
        app.db
          .update(trafficSources)
          .set({ skippedThroughAt: skippedThrough.toISOString() })
          .where(eq(trafficSources.id, sourceRow.id))
          .run()
        request.log.warn(
          {
            sourceId: sourceRow.id,
            requestedStart: new Date(clampedStartMs).toISOString(),
            cappedStart: new Date(cappedStartMs).toISOString(),
          },
          'Vercel sync window exceeded the max single-sync span; clamped the start forward '
            + '(older traffic skipped — run a backfill to recover it)',
        )
      }
      windowStart = new Date(cappedStartMs)

      try {
        const drained = await drainVercelTrafficEvents({
          pull: pullVercelEvents,
          token: credential.token,
          projectId: vercelProjectId,
          teamId: vercelTeamId,
          environment: vercelEnvironment,
          startDate: windowStart.getTime(),
          endDate: windowEnd.getTime(),
          pagesPerSubWindow: vercelMaxPages,
          maxSubWindows: VERCEL_MAX_SUB_WINDOWS,
          // Bound the drain's wall-clock so a dense/slow window can't run for
          // many minutes. On hit the drain stops and reports how far it got.
          deadlineMs: syncStartedAtMs + vercelSyncDeadlineMs,
        })
        if (drained.retentionClamped) {
          throw vercelRetentionClampError(windowStart.getTime(), drained.effectiveStartMs)
        }
        if (drained.deadlineReached) {
          if (drained.drainedThroughMs <= windowStart.getTime()) {
            // No sub-window completed before the budget elapsed — request-logs is
            // slow or unavailable. Fail (the catch marks the run failed) rather
            // than committing an empty 'completed' window or orphaning a 'running'
            // run; the schedule retries next tick.
            throw new Error(
              `sync exceeded its ${vercelSyncDeadlineMs}ms drain budget without `
                + 'completing any sub-window (request-logs slow or unavailable)',
            )
          }
          // Partial progress: commit what drained and advance `lastSyncedAt` only
          // to there, so the next sync resumes from the boundary instead of
          // re-pulling. The additive rollup makes a partial window safe.
          effectiveWindowEnd = new Date(drained.drainedThroughMs)
          request.log.warn(
            {
              sourceId: sourceRow.id,
              drainedThrough: effectiveWindowEnd.toISOString(),
              requestedEnd: windowEnd.toISOString(),
              subWindows: drained.subWindowCount,
            },
            'Vercel drain hit its time budget; committing the partial window and advancing to it '
              + '— next sync resumes from here',
          )
        }
        if (drained.truncatedSliceCount > 0) {
          // A one-second slice exceeded the page budget and could not be sliced
          // thinner. The drain ingested a sample and advanced rather than
          // wedging the source. Surface it (never silent); the incremental sync
          // is additive so losing the tail of one pathological second is safe.
          request.log.warn(
            {
              sourceId: sourceRow.id,
              truncatedSlices: drained.truncatedSliceCount,
              sliceStarts: drained.truncatedSliceStartsMs.map((ms) => new Date(ms).toISOString()),
            },
            'Vercel drain truncated dense one-second slice(s); ingested a sample and advanced past them',
          )
        }
        if (drained.deadlineSkippedSliceCount > 0) {
          // The drain hit its wall-clock budget while still narrowing a dense or
          // slow slice at the window head and could not drain a single sub-window.
          // Rather than freeze the cursor (which wedges the source — every retry
          // re-hits the same head), it skipped past the head to guarantee forward
          // progress. The skipped span was dropped undrained; surface it (never
          // silent). The additive rollup keeps the rest of the window safe.
          request.log.warn(
            {
              sourceId: sourceRow.id,
              skippedSlices: drained.deadlineSkippedSliceCount,
              sliceStarts: drained.deadlineSkippedSliceStartsMs.map((ms) => new Date(ms).toISOString()),
            },
            'Vercel drain could not narrow a dense/slow head slice within its budget; skipped past it to guarantee progress',
          )
        }
        allEvents = drained.events
      } catch (e) {
        const msg = describeError(e)
        // A 401/403 is the credential's problem, not the pull's: the token was
        // rejected, or lacks access to this team, project or plan's request
        // logs. Either way every sync fails until the token or its scope
        // changes, like a Cloud Run credential that will not resolve.
        const credentialRefused = e instanceof VercelLogsApiError && (e.status === 401 || e.status === 403)
        markFailed(msg, credentialRefused ? 'PROVIDER_AUTH' : 'PROVIDER_PULL')
        throw providerError(`Vercel pull failed: ${msg}`)
      }
    }

    let crawlerBucketRows = 0
    let aiUserFetchBucketRows = 0
    let aiReferralBucketRows = 0
    let sampleRows = 0
    // These get assigned inside the transaction (after we re-read the row to
    // beat the read-then-write race on concurrent syncs) and read after the
    // transaction commits for the response + telemetry payload.
    let finishedAt = new Date().toISOString()
    let pulledEventsCount = 0
    let selfTrafficExcludedCount = 0
    let crawlerHitsCount = 0
    let aiUserFetchHitsCount = 0
    let aiReferralHitsCount = 0
    let unknownHitsCount = 0

    try {
      renewWordpressLease()
    } catch (e) {
      const msg = describeError(e)
      markFailed(msg, 'INTERNAL')
      throw providerError(`WordPress sync failed: ${msg}`)
    }

    // Serialize the generation check with its writes across API processes.
    // This matches the reservation above: the loser re-reads the first
    // committer's cursor/window state and cleanly aborts its own run.
    const commitOutcome = app.db.transaction((tx) => {
      // Re-read sourceRow inside the txn so a concurrent sync that committed
      // first is visible — otherwise both syncs would dedupe against the same
      // stale lastEventIds and the second commit would clobber the first
      // sync's ring buffer.
      const latestRow = tx
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceRow.id))
        .get()
      const latestHasConnectedSibling = tx.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .some(row => row.id !== sourceRow.id && row.status === TrafficSourceStatuses.connected)
      if (!latestRow
        || (latestRow.status !== TrafficSourceStatuses.connected && latestRow.status !== TrafficSourceStatuses.error)
        || latestHasConnectedSibling
        || (wordpressLeaseOwner !== undefined && latestRow.syncLeaseOwner !== wordpressLeaseOwner)
        || !isSameTrafficSourceGeneration(latestRow, sourceRow)) {
        const abortedAt = new Date().toISOString()
        tx.update(runs).set({
          status: RunStatuses.failed,
          error: 'Traffic source was deactivated or reconfigured during sync',
          finishedAt: abortedAt,
        }).where(eq(runs.id, runId)).run()
        return 'source-inactive' as const
      }

      // Cross-sync dedupe: drop events whose normalized eventId was already
      // observed in the previous successful sync. The lastSyncedAt clamp
      // narrows the fetch window, but events with timestamp == lastSyncedAt
      // (boundary second) can still appear in two consecutive pulls.
      const previousIds = latestRow.lastEventIds ?? []
      const seenEventIds = new Set(previousIds)
      const dedupedEvents = seenEventIds.size === 0
        ? allEvents
        : allEvents.filter(e => !seenEventIds.has(e.eventId))

      // Build the next sync's seen-set: new event IDs (newest-first) PREPENDED
      // to the previous seen IDs, deduplicated, capped at MAX_TRACKED_EVENT_IDS.
      // We must retain the previous IDs because Cloud Logging can re-return
      // the same boundary event on more than one subsequent sync; replacing
      // would let it re-enter on the third sync.
      // Self-traffic is always dropped at rollup, so its IDs never need
      // cross-sync deduping — keep them out of the bounded ring so they can't
      // evict real boundary-event IDs.
      const newSorted = dedupedEvents
        .filter(e => !isSelfTraffic(e))
        .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
        .map(e => e.eventId)
      const merged: string[] = []
      const mergedSet = new Set<string>()
      for (const id of [...newSorted, ...previousIds]) {
        if (mergedSet.has(id)) continue
        mergedSet.add(id)
        merged.push(id)
        if (merged.length >= MAX_TRACKED_EVENT_IDS) break
      }
      const nextEventIds = merged

      const report = buildTrafficProbeReport(dedupedEvents, { sampleLimit })
      finishedAt = new Date().toISOString()
      const rawSampleCutoff = enforceRawEventSampleRetention(
        tx,
        sourceRow.id,
        finishedAt,
      )
      pulledEventsCount = report.totals.normalizedEvents
      selfTrafficExcludedCount = report.totals.selfTrafficExcluded
      crawlerHitsCount = report.totals.crawlerHits
      aiUserFetchHitsCount = report.totals.aiUserFetchHits
      aiReferralHitsCount = report.totals.aiReferralHits
      unknownHitsCount = report.totals.unknownHits

      // Upsert crawler hourly buckets — composite PK lets us accumulate `hits`.
      for (const bucket of report.crawlerEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(crawlerEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              crawlerEventsHourly.projectId,
              crawlerEventsHourly.sourceId,
              crawlerEventsHourly.tsHour,
              crawlerEventsHourly.botId,
              crawlerEventsHourly.verificationStatus,
              crawlerEventsHourly.pathNormalized,
              crawlerEventsHourly.status,
            ],
            set: {
              hits: sql`${crawlerEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(crawlerVerificationManifestsHourly)
            .values({
              projectId: project.id,
              sourceId: sourceRow.id,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: finishedAt,
              updatedAt: finishedAt,
            })
            .onConflictDoUpdate({
              target: [
                crawlerVerificationManifestsHourly.projectId,
                crawlerVerificationManifestsHourly.sourceId,
                crawlerVerificationManifestsHourly.tsHour,
                crawlerVerificationManifestsHourly.botId,
                crawlerVerificationManifestsHourly.verificationStatus,
                crawlerVerificationManifestsHourly.pathNormalized,
                crawlerVerificationManifestsHourly.status,
                crawlerVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${crawlerVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: finishedAt,
              },
            })
            .run()
        }
        crawlerBucketRows += 1
      }

      for (const bucket of report.aiUserFetchEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiUserFetchEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiUserFetchEventsHourly.projectId,
              aiUserFetchEventsHourly.sourceId,
              aiUserFetchEventsHourly.tsHour,
              aiUserFetchEventsHourly.botId,
              aiUserFetchEventsHourly.verificationStatus,
              aiUserFetchEventsHourly.pathNormalized,
              aiUserFetchEventsHourly.status,
            ],
            set: {
              hits: sql`${aiUserFetchEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(aiUserFetchVerificationManifestsHourly)
            .values({
              projectId: project.id,
              sourceId: sourceRow.id,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: finishedAt,
              updatedAt: finishedAt,
            })
            .onConflictDoUpdate({
              target: [
                aiUserFetchVerificationManifestsHourly.projectId,
                aiUserFetchVerificationManifestsHourly.sourceId,
                aiUserFetchVerificationManifestsHourly.tsHour,
                aiUserFetchVerificationManifestsHourly.botId,
                aiUserFetchVerificationManifestsHourly.verificationStatus,
                aiUserFetchVerificationManifestsHourly.pathNormalized,
                aiUserFetchVerificationManifestsHourly.status,
                aiUserFetchVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${aiUserFetchVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: finishedAt,
              },
            })
            .run()
        }
        aiUserFetchBucketRows += 1
      }

      for (const bucket of report.aiReferralEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiReferralEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            product: bucket.product,
            operator: bucket.operator,
            sourceDomain: bucket.sourceDomain,
            evidenceType: bucket.evidenceType,
            landingPathNormalized: bucket.landingPathNormalized,
            status,
            sessionsOrHits: bucket.hits,
            paidSessionsOrHits: bucket.paidHits,
            organicSessionsOrHits: bucket.organicHits,
            usersEstimated: null,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiReferralEventsHourly.projectId,
              aiReferralEventsHourly.sourceId,
              aiReferralEventsHourly.tsHour,
              aiReferralEventsHourly.product,
              aiReferralEventsHourly.sourceDomain,
              aiReferralEventsHourly.evidenceType,
              aiReferralEventsHourly.landingPathNormalized,
              aiReferralEventsHourly.status,
            ],
            // All three counters accumulate. The class splits the measure, so a
            // colliding bucket adds its paid and organic arrivals to the ones
            // already there rather than overwriting a single label.
            set: {
              sessionsOrHits: sql`${aiReferralEventsHourly.sessionsOrHits} + ${bucket.hits}`,
              paidSessionsOrHits: sql`${aiReferralEventsHourly.paidSessionsOrHits} + ${bucket.paidHits}`,
              organicSessionsOrHits: sql`${aiReferralEventsHourly.organicSessionsOrHits} + ${bucket.organicHits}`,
              updatedAt: finishedAt,
            },
          })
          .run()
        aiReferralBucketRows += 1
      }

      for (const sample of report.samples) {
        const sampleTimestamp = retainedRawEventSampleTimestamp(sample.observedAt, rawSampleCutoff)
        if (!sampleTimestamp) continue
        const eventType = sample.crawler
          ? 'crawler'
          : sample.aiUserFetch
            ? 'ai_user_fetch'
            : sample.aiReferral
              ? 'ai_referral'
              : 'unknown'
        const refererHost = (() => {
          if (!sample.referer) return null
          try {
            return new URL(sample.referer).hostname
          } catch {
            return null
          }
        })()
        tx
          .insert(rawEventSamples)
          .values({
            id: crypto.randomUUID(),
            projectId: project.id,
            sourceId: sourceRow.id,
            ts: sampleTimestamp,
            eventType,
            ipHash: null,
            userAgent: sample.userAgent,
            pathNormalized: sample.pathNormalized,
            status: sample.status,
            refererHost,
            classifierDetailsJson: {
              crawler: sample.crawler,
              aiUserFetch: sample.aiUserFetch,
              aiReferral: sample.aiReferral,
            },
            createdAt: finishedAt,
          })
          .run()
        sampleRows += 1
      }

      // For WP we persist a continuation cursor and its fixed upper boundary
      // inside the same transaction as rollups. A terminal page clears both;
      // a capped drain retains the lower watermark below until its cursor is
      // exhausted. Cloud Run does not use either field (drizzle omits
      // undefined fields from the SET clause).
      const nextWatermark = sourceRow.sourceType === TrafficSourceTypes.wordpress && nextCursor
        ? windowStart
        : effectiveWindowEnd
      const sourceUpdate: Partial<typeof trafficSources.$inferInsert> = {
        status: TrafficSourceStatuses.connected,
        // Advance to nextWatermark, not finishedAt — events arriving at the
        // source between the window end and finishedAt aren't in this pull's
        // range. If we stored finishedAt, the next sync's clamp would skip past
        // them and they'd be lost. A capped WordPress drain retains its lower
        // bound; full pulls use effectiveWindowEnd, including a partial Vercel
        // boundary, so the next sync resumes exactly where this one left off.
        //
        // Never move the watermark BACKWARD. A sync already in flight when the
        // cursor is advanced out from under it (an operator reset, or a backfill
        // committing a later window) would otherwise commit its own older
        // window end and undo that advance — the source silently resumes from
        // the past and re-walks ground that was deliberately skipped. Backfill
        // has always guarded this; the incremental path did not, so a reset only
        // stuck if you first disabled the schedule and drained the in-flight run.
        lastSyncedAt: new Date(
          Math.max(
            latestRow.lastSyncedAt ? new Date(latestRow.lastSyncedAt).getTime() : Number.NEGATIVE_INFINITY,
            nextWatermark.getTime(),
          ),
        ).toISOString(),
        lastError: null,
        lastEventIds: nextEventIds,
        updatedAt: finishedAt,
      }
      if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
        sourceUpdate.lastCursor = nextCursor ?? null
        sourceUpdate.wordpressPendingUntil = nextCursor ? windowEnd.toISOString() : null
      }
      tx
        .update(trafficSources)
        .set(sourceUpdate)
        .where(eq(trafficSources.id, sourceRow.id))
        .run()

      tx
        .update(runs)
        .set({ status: RunStatuses.completed, finishedAt })
        .where(eq(runs.id, runId))
        .run()
      return 'committed' as const
    }, { behavior: 'immediate' })

    if (commitOutcome === 'source-inactive') {
      throw validationError('Traffic source is no longer active; discarded the in-flight sync')
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: auditAction,
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    // Self-traffic exclusion is never silent: if Canonry's own tooling crawled
    // the site during this window, surface how many events we dropped so the
    // (post-exclusion) `pulledEvents` count is explainable.
    if (selfTrafficExcludedCount > 0) {
      request.log.info(
        { sourceId: sourceRow.id, selfTrafficExcluded: selfTrafficExcludedCount },
        'Dropped Canonry self-traffic before rollup; excluded from pulledEvents',
      )
    }

    // Fire-and-forget telemetry. Never let a hook block the response.
    try {
      opts.onTrafficSynced?.({
        status: 'completed',
        sourceType: sourceRow.sourceType,
        sourceId: sourceRow.id,
        pulledEvents: pulledEventsCount,
        selfTrafficExcluded: selfTrafficExcludedCount,
        crawlerHits: crawlerHitsCount,
        aiUserFetchHits: aiUserFetchHitsCount,
        aiReferralHits: aiReferralHitsCount,
        durationMs: Date.now() - syncStartedAtMs,
      })
    } catch {
      // swallow — never block on telemetry
    }

    const response: TrafficSyncResponse = {
      sourceId: sourceRow.id,
      runId,
      syncedAt: finishedAt,
      pulledEvents: pulledEventsCount,
      selfTrafficExcluded: selfTrafficExcludedCount,
      crawlerHits: crawlerHitsCount,
      aiUserFetchHits: aiUserFetchHitsCount,
      aiReferralHits: aiReferralHitsCount,
      unknownHits: unknownHitsCount,
      crawlerBucketRows,
      aiUserFetchBucketRows,
      aiReferralBucketRows,
      sampleRows,
      windowStart: windowStart.toISOString(),
      // The window actually synced: equals windowEnd on a full sync, or the
      // partial boundary when a Vercel drain stopped at its deadline.
      windowEnd: effectiveWindowEnd.toISOString(),
    }
    return response
    } finally {
      if (wordpressLeaseOwner) {
        try {
          releaseTrafficSyncLease({
            db: app.db,
            sourceId: sourceRow.id,
            owner: wordpressLeaseOwner,
            now: new Date().toISOString(),
          })
        } catch (error) {
          // A released response must not turn into a 500 just because an
          // ephemeral lease cleanup raced a DB shutdown. The expiry remains
          // the safe recovery path if this write could not complete.
          request.log.warn({ sourceId: sourceRow.id, error: describeError(error) }, 'Failed to release WordPress sync lease')
        }
      }
    }
  })

  // POST /projects/:name/traffic/sources/:id/backfill
  //
  // One-shot reclassification of historical Cloud Run logs. Returns
  // immediately with `runId`; the caller polls `GET /runs/:id` for status.
  // On success: rebuilds the hourly rollup buckets for the requested window
  // by deleting then re-inserting them inside one transaction (replace
  // semantics — additive would double-count, since the cross-sync ring
  // buffer can only hold MAX_TRACKED_EVENT_IDS IDs). Sample buffer for the
  // window is also replaced so it stays consistent with the rollups.
  app.post<{
    Params: { name: string; id: string }
    Body: { days?: number }
  }>('/projects/:name/traffic/sources/:id/backfill', async (request) => withFeatureOutcome(app, { feature: 'server_traffic', operation: 'backfill' }, async (recordOutcome) => {
    const project = resolveProject(app.db, request.params.name)
    const sourceRow = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, request.params.id))
      .get()
    if (!sourceRow || sourceRow.projectId !== project.id) {
      throw notFound('Traffic source', request.params.id)
    }
    if (
      sourceRow.sourceType !== TrafficSourceTypes['cloud-run']
      && sourceRow.sourceType !== TrafficSourceTypes.wordpress
      && sourceRow.sourceType !== TrafficSourceTypes.vercel
    ) {
      throw validationError(
        `Backfill for source type "${sourceRow.sourceType}" is not implemented yet — generic replace backfill supports only cloud-run and vercel; WordPress requires a retention-aware repair.`,
      )
    }
    if (!isAuthoritativeTrafficSource(app.db, sourceRow)) {
      throw validationError('Traffic source must be active before it can backfill')
    }
    if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
      throw validationError(
        'Generic WordPress replace backfill is unavailable because retained coverage is unproven. Use a retention-aware repair that declares the unrecoverable span.',
      )
    }

    const requestedDays = request.body?.days ?? DEFAULT_BACKFILL_DAYS
    if (!Number.isInteger(requestedDays) || requestedDays <= 0) {
      throw validationError('"days" must be a positive integer')
    }
    const appliedDays = Math.min(requestedDays, MAX_BACKFILL_DAYS)

    const windowEnd = new Date()
    const requestedWindowStartMs = windowEnd.getTime() - appliedDays * 86_400_000
    // Backfill rollups are hourly, so replace the full lower-bound bucket.
    // Rounding forward would silently omit up to 59 minutes while still
    // reporting the requested number of days. A retention-limited adapter must
    // reject the full-bucket pull instead; the failed run preserves both the
    // existing rollups and the connected source state.
    const windowStart = new Date(requestedWindowStartMs)
    windowStart.setUTCMinutes(0, 0, 0)

    // Build the per-source-type window pull closure. Credential and config
    // validation happens up-front (synchronously throws validationError on
    // miss) so the run row never gets created for an obviously-misconfigured
    // request. The closure itself does all I/O lazily — invoked by
    // runBackfillTask after the run row is in place.
    let pullForBackfill: BackfillPullFn
    let pullErrorPrefix: string

    if (sourceRow.sourceType === TrafficSourceTypes['cloud-run']) {
      const credentialStore = opts.cloudRunCredentialStore
      if (!credentialStore) {
        throw validationError('Cloud Run credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Cloud Run credential found for project "${project.name}". Run "canonry traffic connect cloud-run" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const gcpProjectId = (config.gcpProjectId as string | undefined) ?? credential.gcpProjectId
      const serviceName = (config.serviceName as string | null | undefined) ?? credential.serviceName ?? undefined
      const location = (config.location as string | null | undefined) ?? credential.location ?? undefined

      pullErrorPrefix = 'Cloud Run pull failed'
      pullForBackfill = async () => {
        const accessToken = await resolveAccessToken(credential)
        const page = await pullEvents(accessToken, {
          gcpProjectId,
          serviceName,
          location,
          startTime: windowStart.toISOString(),
          endTime: windowEnd.toISOString(),
          pageSize: DEFAULT_PAGE_SIZE,
          maxPages: BACKFILL_MAX_PAGES,
          // Backfill is intentionally `firstSync: false`. We don't want desc
          // ordering — the in-memory rollup builder handles any order, and the
          // ring-buffer reseed at the end takes the most-recent IDs from the
          // dedupedEvents anyway.
          firstSync: false,
          orderBy: 'timestamp asc',
          requestUrlSubstrings: [project.canonicalDomain],
        })
        return page.events
      }
    } else {
      // Vercel `request-logs` window backfill. Pulls the fixed
      // `[windowStart, windowEnd]` window in hour chunks with a large page
      // budget. Backfill is replace mode — runBackfillTask deletes the
      // window's rollup buckets before re-ingesting — so a truncated pull
      // would wipe existing data and leave only a partial set. If Vercel
      // cannot serve any chunk fully, fail loudly before the replace
      // transaction instead of losing rows.
      const credentialStore = opts.vercelTrafficCredentialStore
      if (!credentialStore) {
        throw validationError('Vercel traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Vercel credential found for project "${project.name}". Run "canonry traffic connect vercel" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const vercelProjectId = (config.projectId as string | undefined) ?? credential.projectId
      const vercelTeamId = (config.teamId as string | undefined) ?? credential.teamId
      const vercelEnvironment = (config.environment as 'production' | 'preview' | undefined)
        ?? credential.environment

      pullErrorPrefix = 'Vercel pull failed'
      pullForBackfill = async () => {
        const collected: NormalizedTrafficRequest[] = []
        const seenEventIds = new Set<string>()
        const backfillEndMs = windowEnd.getTime()
        for (
          let chunkStartMs = windowStart.getTime();
          chunkStartMs < backfillEndMs;
          chunkStartMs += VERCEL_BACKFILL_CHUNK_MS
        ) {
          const chunkEndMs = Math.min(chunkStartMs + VERCEL_BACKFILL_CHUNK_MS, backfillEndMs)
          // Backfill is replace mode — a truncated sample would overwrite a
          // full prior rollup with a partial one. `abortOnTruncation` makes the
          // drain throw on the first irreducible one-second slice (the
          // incremental sync path samples-and-advances instead, since it is
          // additive, not destructive). Operator can re-run a narrower window.
          const drained = await drainVercelTrafficEvents({
            pull: pullVercelEvents,
            token: credential.token,
            projectId: vercelProjectId,
            teamId: vercelTeamId,
            environment: vercelEnvironment,
            startDate: chunkStartMs,
            endDate: chunkEndMs,
            pagesPerSubWindow: BACKFILL_MAX_PAGES,
            maxSubWindows: VERCEL_MAX_SUB_WINDOWS,
            abortOnTruncation: true,
          })
          if (drained.retentionClamped) {
            throw vercelRetentionClampError(chunkStartMs, drained.effectiveStartMs)
          }
          for (const event of drained.events) {
            if (seenEventIds.has(event.eventId)) continue
            seenEventIds.add(event.eventId)
            collected.push(event)
          }
        }
        return collected
      }
    }

    const startedAt = windowEnd.toISOString()
    const runId = crypto.randomUUID()
    app.db.transaction((tx) => {
      const latestSource = tx.select().from(trafficSources)
        .where(eq(trafficSources.id, sourceRow.id)).get()
      if (!latestSource
        || !isAuthoritativeTrafficSource(tx, latestSource)
        || !isSameTrafficSourceGeneration(latestSource, sourceRow)) {
        throw validationError('Traffic source must remain active and unchanged before it can backfill')
      }
      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['traffic-sync'],
        status: RunStatuses.running,
        trigger: RunTriggers.backfill,
        sourceId: sourceRow.id,
        startedAt,
        createdAt: startedAt,
      }).run()
    })

    // Fire-and-forget. The route returns immediately; the run row carries
    // status until the background task finishes. Errors inside the task are
    // recorded on the run row + traffic_sources.last_error — never thrown
    // back to this scope (the response has already been sent).
    void runBackfillTask({
      app,
      runId,
      project,
      sourceRow,
      windowStart,
      windowEnd,
      pullForBackfill,
      pullErrorPrefix,
    }).catch(() => {
      // runBackfillTask handles its own error recording. The catch here
      // exists only so an unhandled rejection cannot crash the process if
      // an internal bug bypasses the task's own try/catch.
    })
    // The background task reports the backfill's outcome when it finishes.
    recordOutcome(null)

    const response: TrafficBackfillResponse = {
      sourceId: sourceRow.id,
      runId,
      status: RunStatuses.running,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      daysRequested: requestedDays,
      daysApplied: appliedDays,
    }
    return response
  }))

  function buildSourceDetail(
    projectId: string,
    row: typeof trafficSources.$inferSelect,
    since: string,
  ): TrafficSourceDetailDto {
    // Group by path so crawler hits can be segmented into content vs
    // infrastructure (sitemap/robots/asset) at read time — the classification
    // lives in `classifyTrafficPath`, never reimplemented in SQL. The number of
    // distinct normalized paths per source/window is small, so this GROUP BY is
    // cheap. The per-class buckets sum back to the original `crawlerHits` total,
    // which is preserved unchanged.
    const crawlerPathRows = app.db
      .select({
        pathNormalized: crawlerEventsHourly.pathNormalized,
        hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
      })
      .from(crawlerEventsHourly)
      .where(
        and(
          eq(crawlerEventsHourly.sourceId, row.id),
          gte(crawlerEventsHourly.tsHour, since),
        ),
      )
      .groupBy(crawlerEventsHourly.pathNormalized)
      .all()
    const crawlerSegments = segmentCrawlerHits(
      crawlerPathRows.map((r) => ({ pathNormalized: r.pathNormalized, hits: Number(r.hits) })),
    )
    const crawlerTotal =
      crawlerSegments.content
      + crawlerSegments.sitemap
      + crawlerSegments.robots
      + crawlerSegments.asset
      + crawlerSegments.other

    const aiUserFetchTotals = app.db
      .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
      .from(aiUserFetchEventsHourly)
      .where(
        and(
          eq(aiUserFetchEventsHourly.sourceId, row.id),
          gte(aiUserFetchEventsHourly.tsHour, since),
        ),
      )
      .get()

    // `aiReferralHits` keeps its full-count contract. `landed` is what a
    // surface may call sessions: the COUNTABLE rows (no redirect hops, no
    // static subresource fetches) — the same predicate the report and
    // organic-evidence use, so no two surfaces can disagree about a session.
    // `redirected` stays status-based, derived from a status-only sum so a
    // subresource 200 is neither a session nor mislabelled a hop.
    const aiTotals = app.db
      .select({
        total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
        nonhop: sql<number>`COALESCE(SUM(CASE WHEN ${referralLandedCondition()} THEN ${aiReferralEventsHourly.sessionsOrHits} ELSE 0 END), 0)`,
        landed: sql<number>`COALESCE(SUM(CASE WHEN ${countableReferralCondition()} THEN ${aiReferralEventsHourly.sessionsOrHits} ELSE 0 END), 0)`,
      })
      .from(aiReferralEventsHourly)
      .where(
        and(
          eq(aiReferralEventsHourly.sourceId, row.id),
          gte(aiReferralEventsHourly.tsHour, since),
        ),
      )
      .get()

    const sampleTotals = app.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(rawEventSamples)
      .where(
        and(
          eq(rawEventSamples.sourceId, row.id),
          gte(rawEventSamples.ts, since),
        ),
      )
      .get()

    const latestRun = app.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['traffic-sync']),
          eq(runs.sourceId, row.id),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get()

    return {
      ...rowToDto(row),
      totals24h: {
        crawlerHits: crawlerTotal,
        crawlerContentHits: crawlerSegments.content,
        crawlerInfraHits: sumInfraHits(crawlerSegments),
        crawlerSegments,
        aiUserFetchHits: Number(aiUserFetchTotals?.total ?? 0),
        aiReferralHits: Number(aiTotals?.total ?? 0),
        aiReferralLandedHits: Number(aiTotals?.landed ?? 0),
        aiReferralRedirectedHits: Number(aiTotals?.total ?? 0) - Number(aiTotals?.nonhop ?? 0),
        sampleCount: Number(sampleTotals?.total ?? 0),
      },
      latestRun: latestRun
        ? {
            runId: latestRun.id,
            status: latestRun.status as RunStatus,
            startedAt: latestRun.startedAt,
            finishedAt: latestRun.finishedAt ?? null,
            error: latestRun.error ?? null,
          }
        : null,
    }
  }

  // POST /projects/:name/traffic/sources/:id/reset
  //
  // Operator recovery: advance `lastSyncedAt` to NOW, set `status` back to
  // `connected`, and clear the prior `last_error`. WordPress also clears its
  // continuation cursor and pending-window marker in the same transaction, so
  // the next sync starts at the reset watermark rather than combining it with
  // an old drain. Any pre-existing rollup history stays in place. A WordPress
  // reset records an unrecovered skip through the reset instant. Generic
  // WordPress replace-mode backfill is unavailable because plugin retention
  // cannot prove coverage for a safe historical repair.
  app.post<{
    Params: { name: string; id: string }
    Body: { advanceToNow?: unknown }
  }>('/projects/:name/traffic/sources/:id/reset', async (request) => withFeatureOutcome(app, { feature: 'server_traffic', operation: 'reset' }, async () => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = trafficResetRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(
        '`advanceToNow` must be `true`. There is no implicit reset.',
      )
    }

    const now = new Date().toISOString()
    let updatedRow!: typeof trafficSources.$inferSelect
    app.db.transaction((tx) => {
      const sourceRow = tx
        .select()
        .from(trafficSources)
        .where(and(eq(trafficSources.projectId, project.id), eq(trafficSources.id, request.params.id)))
        .get()
      if (!sourceRow) {
        throw notFound('traffic source', request.params.id)
      }
      // Reset is cursor recovery for the current authority, never a cutover.
      // Keep every lifecycle check in this transaction so activation cannot
      // race a stale pre-read and leave two connected sources.
      if (sourceRow.status === TrafficSourceStatuses.archived) {
        throw validationError(
          `Traffic source "${sourceRow.id}" is archived. Re-connect via "canonry traffic connect ..." to start tracking it again.`,
        )
      }
      if (sourceRow.status === TrafficSourceStatuses.paused) {
        throw validationError(
          `Traffic source "${sourceRow.id}" is staged. Activate it explicitly instead of resetting it.`,
        )
      }
      const hasConnectedSibling = tx.select().from(trafficSources)
        .where(eq(trafficSources.projectId, project.id)).all()
        .some(row => row.id !== sourceRow.id && row.status === TrafficSourceStatuses.connected)
      if (hasConnectedSibling) {
        throw validationError(
          `Traffic source "${sourceRow.id}" is not authoritative. Activate it explicitly instead of resetting it.`,
        )
      }
      validateTrafficSourceCredential(sourceRow, project.name)
      tx.update(trafficSources)
        .set({
          lastSyncedAt: now,
          ...(sourceRow.sourceType === TrafficSourceTypes.wordpress
            ? {
                lastCursor: null,
                wordpressPendingUntil: null,
                skippedThroughAt: now,
              }
            : {}),
          status: TrafficSourceStatuses.connected,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(trafficSources.id, sourceRow.id))
        .run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'traffic.source.reset',
        entityType: 'traffic_source',
        entityId: sourceRow.id,
      }))
      updatedRow = tx
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceRow.id))
        .get()!
    })
    return buildSourceDetail(project.id, updatedRow, new Date(Date.now() - 24 * 60 * 60_000).toISOString())
  }))

  // GET /projects/:name/traffic/sources
  app.get<{ Params: { name: string } }>('/projects/:name/traffic/sources', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .orderBy(desc(trafficSources.createdAt))
      .all()
    const sources: TrafficSourceDto[] = rows
      .filter((row) => row.status !== TrafficSourceStatuses.archived)
      .map(rowToDto)
    const response: TrafficSourceListResponse = { sources }
    return response
  })

  // GET /projects/:name/traffic/status
  app.get<{ Params: { name: string } }>('/projects/:name/traffic/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .orderBy(desc(trafficSources.createdAt))
      .all()
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const sources: TrafficSourceDetailDto[] = rows
      .filter((row) => row.status !== TrafficSourceStatuses.archived)
      .map((row) => buildSourceDetail(project.id, row, since))
    const response: TrafficStatusResponse = { sources }
    return response
  })

  // GET /projects/:name/traffic/sources/:id
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/traffic/sources/:id',
    async (request) => {
      const project = resolveProject(app.db, request.params.name)
      const row = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, request.params.id))
        .get()
      if (!row || row.projectId !== project.id) {
        throw notFound('Traffic source', request.params.id)
      }

      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
      return buildSourceDetail(project.id, row, since)
    },
  )

  // GET /projects/:name/traffic/events
  app.get<{
    Params: { name: string }
    Querystring: { since?: string; until?: string; kind?: string; limit?: string; sourceId?: string; granularity?: string; sinceMinutes?: string }
  }>('/projects/:name/traffic/events', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const now = new Date()
    const defaultSince = new Date(now.getTime() - 24 * 60 * 60_000)

    // `sinceMinutes` is the SYNC body parameter. Passed here it was silently
    // ignored and the window fell back to 24 hours, so a caller asking for 90
    // days got a correct-looking answer for the wrong range. A wrong number
    // returned confidently is worse than an error, so name the right parameter.
    if (request.query?.sinceMinutes !== undefined) {
      throw validationError(
        '"sinceMinutes" is not a query parameter on this route. Use "since" (and optionally "until") with an ISO-8601 timestamp.',
      )
    }

    const sinceParam = request.query?.since
    const untilParam = request.query?.until
    const since = sinceParam ? new Date(sinceParam) : defaultSince
    const until = untilParam ? new Date(untilParam) : now
    if (Number.isNaN(since.getTime())) {
      throw validationError('"since" must be an ISO-8601 timestamp')
    }
    if (Number.isNaN(until.getTime())) {
      throw validationError('"until" must be an ISO-8601 timestamp')
    }
    if (since.getTime() > until.getTime()) {
      throw validationError('"since" must be ≤ "until"')
    }

    const kindParam = request.query?.kind
    let kind: TrafficEventKind | 'all' = 'all'
    if (kindParam !== undefined) {
      if (
        kindParam === 'all'
        || kindParam === TrafficEventKinds.crawler
        || kindParam === TrafficEventKinds['ai-user-fetch']
        || kindParam === TrafficEventKinds['ai-referral']
      ) {
        kind = kindParam
      } else {
        throw validationError(
          `"kind" must be one of: all, ${TrafficEventKinds.crawler}, ${TrafficEventKinds['ai-user-fetch']}, ${TrafficEventKinds['ai-referral']}`,
        )
      }
    }

    const limitParam = request.query?.limit
    const requestedLimit = limitParam ? parseInt(limitParam, 10) : 500
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      throw validationError('"limit" must be a positive integer')
    }
    const limit = Math.min(requestedLimit, 5000)

    const granularityParam = request.query?.granularity
    let granularity: TrafficSeriesGranularity = TrafficSeriesGranularities.hour
    if (granularityParam !== undefined) {
      if (
        granularityParam === TrafficSeriesGranularities.hour
        || granularityParam === TrafficSeriesGranularities.day
      ) {
        granularity = granularityParam
      } else {
        throw validationError(
          `"granularity" must be one of: ${TrafficSeriesGranularities.hour}, ${TrafficSeriesGranularities.day}`,
        )
      }
    }

    const sourceIdParam = request.query?.sourceId
    const sinceIso = since.toISOString()
    const untilIso = until.toISOString()

    const events: TrafficEventEntry[] = []
    let crawlerTotal = 0
    let crawlerSegments = { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 }
    let aiUserFetchTotal = 0
    let aiReferralCounts = aiReferralClassCounts(0, 0, 0)
    let aiReferralTotalHits = 0
    let aiReferralNonHopHits = 0
    let aiReferralLandedHits = 0
    let totalEventRows = 0
    const seriesByBucket = new Map<string, TrafficSeriesPoint>()

    if (kind === 'all' || kind === TrafficEventKinds.crawler) {
      const crawlerFilters = [
        eq(crawlerEventsHourly.projectId, project.id),
        gte(crawlerEventsHourly.tsHour, sinceIso),
        lte(crawlerEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) crawlerFilters.push(eq(crawlerEventsHourly.sourceId, sourceIdParam))
      const crawlerWhere = and(...crawlerFilters)

      // Segment the FULL window by path class (not just the limit-truncated row
      // slice below) so the totals reflect every hit. Buckets sum to the
      // existing `crawlerHits` total, which stays unchanged.
      const pathTotals = app.db
        .select({
          pathNormalized: crawlerEventsHourly.pathNormalized,
          hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
          rows: sql<number>`COUNT(*)`,
        })
        .from(crawlerEventsHourly)
        .where(crawlerWhere)
        .groupBy(crawlerEventsHourly.pathNormalized)
        .all()
      crawlerSegments = segmentCrawlerHits(
        pathTotals.map((r) => ({ pathNormalized: r.pathNormalized, hits: Number(r.hits) })),
      )
      crawlerTotal =
        crawlerSegments.content
        + crawlerSegments.sitemap
        + crawlerSegments.robots
        + crawlerSegments.asset
        + crawlerSegments.other
      totalEventRows += pathTotals.reduce((sum, row) => sum + Number(row.rows), 0)

      const crawlerSeriesBucket = granularity === TrafficSeriesGranularities.day
        ? sql<string>`substr(${crawlerEventsHourly.tsHour}, 1, 10)`
        : crawlerEventsHourly.tsHour
      // Content-vs-infrastructure is decided per PATH, but grouping the series by
      // (bucket, path) materializes one row per path per bucket, which on a large
      // site is millions of rows for a 90-day window. Instead: read the DISTINCT
      // paths once (the bound the totals query already lives with), classify them
      // in JS, then aggregate per bucket with the non-content set pushed into SQL.
      // Rows returned are now (distinct paths + buckets), never their product.
      // `pathTotals` above already grouped this exact table by this exact
      // column under this exact predicate. Re-running it doubled the grouped
      // scan and re-classified every path a second time.
      const distinctPaths = pathTotals.map((r) => ({ pathNormalized: r.pathNormalized }))
      // Push whichever side is SMALLER into the IN list, so a site that is mostly
      // assets costs the same as one that is mostly pages.
      const contentPaths: string[] = []
      const infraPaths: string[] = []
      for (const { pathNormalized } of distinctPaths) {
        if (classifyTrafficPath(pathNormalized) === TrafficPathClasses.content) contentPaths.push(pathNormalized)
        else infraPaths.push(pathNormalized)
      }
      const useContentList = contentPaths.length <= infraPaths.length
      const listed = useContentList ? contentPaths : infraPaths
      // `inArray` binds one parameter per element and better-sqlite3 compiles
      // with SQLITE_MAX_VARIABLE_NUMBER = 32766, so an unbounded list makes the
      // whole route throw on exactly the high-cardinality sites this rewrite
      // exists to serve. Past the cap, fall back to classifying the grouped
      // rows in JS: more rows returned, but a correct answer instead of a 500.
      const IN_LIST_CAP = 20_000
      const listFitsInSql = listed.length <= IN_LIST_CAP
      const contentExpr = listed.length === 0
        // An empty list means one side is empty: either every path is content, or none is.
        ? (useContentList ? sql`0` : sql`${crawlerEventsHourly.hits}`)
        : useContentList
          ? sql`CASE WHEN ${inArray(crawlerEventsHourly.pathNormalized, listed)} THEN ${crawlerEventsHourly.hits} ELSE 0 END`
          : sql`CASE WHEN ${inArray(crawlerEventsHourly.pathNormalized, listed)} THEN 0 ELSE ${crawlerEventsHourly.hits} END`

      if (listFitsInSql) {
        const crawlerSeries = app.db
          .select({
            bucket: crawlerSeriesBucket,
            hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
            content: sql<number>`COALESCE(SUM(${contentExpr}), 0)`,
          })
          .from(crawlerEventsHourly)
          .where(crawlerWhere)
          .groupBy(crawlerSeriesBucket)
          .all()
        for (const row of crawlerSeries) {
          const point = trafficSeriesPoint(seriesByBucket, String(row.bucket))
          point.crawlerHits = Number(row.hits)
          point.crawlerContentHits = Number(row.content)
        }
      } else {
        const contentSet = new Set(useContentList ? contentPaths : infraPaths)
        const grouped = app.db
          .select({
            bucket: crawlerSeriesBucket,
            pathNormalized: crawlerEventsHourly.pathNormalized,
            hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
          })
          .from(crawlerEventsHourly)
          .where(crawlerWhere)
          .groupBy(crawlerSeriesBucket, crawlerEventsHourly.pathNormalized)
          .all()
        for (const row of grouped) {
          const point = trafficSeriesPoint(seriesByBucket, String(row.bucket))
          const hits = Number(row.hits)
          point.crawlerHits += hits
          const inList = contentSet.has(row.pathNormalized)
          if (useContentList ? inList : !inList) point.crawlerContentHits += hits
        }
      }

      const rows = app.db
        .select()
        .from(crawlerEventsHourly)
        .where(crawlerWhere)
        .orderBy(desc(crawlerEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        events.push({
          kind: TrafficEventKinds.crawler,
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          botId: r.botId,
          operator: r.operator,
          verificationStatus: r.verificationStatus,
          verificationManifests: [],
          verificationUnattributedHits: r.hits,
          pathNormalized: r.pathNormalized,
          pathClass: classifyTrafficPath(r.pathNormalized),
          status: r.status,
          hits: r.hits,
        })
      }
    }

    if (kind === 'all' || kind === TrafficEventKinds['ai-user-fetch']) {
      const userFetchFilters = [
        eq(aiUserFetchEventsHourly.projectId, project.id),
        gte(aiUserFetchEventsHourly.tsHour, sinceIso),
        lte(aiUserFetchEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) userFetchFilters.push(eq(aiUserFetchEventsHourly.sourceId, sourceIdParam))
      const userFetchWhere = and(...userFetchFilters)

      const total = app.db
        .select({
          total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
          rows: sql<number>`COUNT(*)`,
        })
        .from(aiUserFetchEventsHourly)
        .where(userFetchWhere)
        .get()
      aiUserFetchTotal = Number(total?.total ?? 0)
      totalEventRows += Number(total?.rows ?? 0)

      const userFetchSeriesBucket = granularity === TrafficSeriesGranularities.day
        ? sql<string>`substr(${aiUserFetchEventsHourly.tsHour}, 1, 10)`
        : aiUserFetchEventsHourly.tsHour
      const userFetchSeries = app.db
        .select({
          bucket: userFetchSeriesBucket,
          hits: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
        })
        .from(aiUserFetchEventsHourly)
        .where(userFetchWhere)
        .groupBy(userFetchSeriesBucket)
        .all()
      for (const row of userFetchSeries) {
        trafficSeriesPoint(seriesByBucket, row.bucket).aiUserFetchHits = Number(row.hits)
      }

      const rows = app.db
        .select()
        .from(aiUserFetchEventsHourly)
        .where(userFetchWhere)
        .orderBy(desc(aiUserFetchEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        events.push({
          kind: TrafficEventKinds['ai-user-fetch'],
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          botId: r.botId,
          operator: r.operator,
          verificationStatus: r.verificationStatus,
          verificationManifests: [],
          verificationUnattributedHits: r.hits,
          pathNormalized: r.pathNormalized,
          status: r.status,
          hits: r.hits,
        })
      }
    }

    if (kind === 'all' || kind === TrafficEventKinds['ai-referral']) {
      const aiFilters = [
        eq(aiReferralEventsHourly.projectId, project.id),
        gte(aiReferralEventsHourly.tsHour, sinceIso),
        lte(aiReferralEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) aiFilters.push(eq(aiReferralEventsHourly.sourceId, sourceIdParam))
      const aiWhere = and(...aiFilters)

      // The paid/organic/unknown classes are computed over LANDED hits only: a
      // redirect hop's paid tags are not a paid session, and every other
      // surface's class split already excludes hops. `aiReferralHits` keeps its
      // full-count contract; `landed`/`redirected` say how it divides.
      const total = app.db
        .select({
          total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
          nonhop: sql<number>`COALESCE(SUM(CASE WHEN ${referralLandedCondition()} THEN ${aiReferralEventsHourly.sessionsOrHits} ELSE 0 END), 0)`,
          landed: sql<number>`COALESCE(SUM(CASE WHEN ${countableReferralCondition()} THEN ${aiReferralEventsHourly.sessionsOrHits} ELSE 0 END), 0)`,
          paid: sql<number>`COALESCE(SUM(CASE WHEN ${countableReferralCondition()} THEN ${aiReferralEventsHourly.paidSessionsOrHits} ELSE 0 END), 0)`,
          organic: sql<number>`COALESCE(SUM(CASE WHEN ${countableReferralCondition()} THEN ${aiReferralEventsHourly.organicSessionsOrHits} ELSE 0 END), 0)`,
          rows: sql<number>`COUNT(*)`,
        })
        .from(aiReferralEventsHourly)
        .where(aiWhere)
        .get()
      aiReferralTotalHits = Number(total?.total ?? 0)
      aiReferralNonHopHits = Number(total?.nonhop ?? 0)
      aiReferralLandedHits = Number(total?.landed ?? 0)
      aiReferralCounts = aiReferralClassCounts(
        aiReferralLandedHits,
        Number(total?.paid ?? 0),
        Number(total?.organic ?? 0),
      )
      totalEventRows += Number(total?.rows ?? 0)

      const referralSeriesBucket = granularity === TrafficSeriesGranularities.day
        ? sql<string>`substr(${aiReferralEventsHourly.tsHour}, 1, 10)`
        : aiReferralEventsHourly.tsHour
      const referralSeries = app.db
        .select({
          bucket: referralSeriesBucket,
          hits: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
          landed: sql<number>`COALESCE(SUM(CASE WHEN ${countableReferralCondition()} THEN ${aiReferralEventsHourly.sessionsOrHits} ELSE 0 END), 0)`,
        })
        .from(aiReferralEventsHourly)
        .where(aiWhere)
        .groupBy(referralSeriesBucket)
        .all()
      for (const row of referralSeries) {
        const point = trafficSeriesPoint(seriesByBucket, row.bucket)
        point.aiReferralHits = Number(row.hits)
        point.aiReferralLandedHits = Number(row.landed)
      }

      const rows = app.db
        .select()
        .from(aiReferralEventsHourly)
        .where(aiWhere)
        .orderBy(desc(aiReferralEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        const counts = aiReferralClassCounts(r.sessionsOrHits, r.paidSessionsOrHits, r.organicSessionsOrHits)
        events.push({
          kind: TrafficEventKinds['ai-referral'],
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          product: r.product,
          operator: r.operator,
          sourceDomain: r.sourceDomain,
          evidenceType: r.evidenceType,
          landingPathNormalized: r.landingPathNormalized,
          status: r.status,
          hits: counts.total,
          paidHits: counts.paid,
          organicHits: counts.organic,
          unknownHits: counts.unknown,
        })
      }
    }

    events.sort((a, b) => (a.tsHour < b.tsHour ? 1 : a.tsHour > b.tsHour ? -1 : 0))
    const trimmed = events.slice(0, limit)
    const trimmedCrawlerEvents = trimmed.filter(
      (event): event is TrafficCrawlerEventEntry => event.kind === TrafficEventKinds.crawler,
    )
    const trimmedAiUserFetchEvents = trimmed.filter(
      (event): event is TrafficAiUserFetchEventEntry => event.kind === TrafficEventKinds['ai-user-fetch'],
    )
    const crawlerProvenance = crawlerVerificationProvenance(app.db, project.id, trimmedCrawlerEvents)
    const aiUserFetchProvenance = aiUserFetchVerificationProvenance(app.db, project.id, trimmedAiUserFetchEvents)
    const eventsWithProvenance: TrafficEventEntry[] = trimmed.map((event) => {
      if (event.kind === TrafficEventKinds.crawler) {
        const provenance = crawlerProvenance.get(verificationEventKey(event))
        return provenance ? { ...event, ...provenance } : event
      }
      if (event.kind === TrafficEventKinds['ai-user-fetch']) {
        const provenance = aiUserFetchProvenance.get(verificationEventKey(event))
        return provenance ? { ...event, ...provenance } : event
      }
      return event
    })

    const response: TrafficEventsResponse = {
      windowStart: sinceIso,
      windowEnd: untilIso,
      series: (() => {
        const points = completeTrafficSeries(since, until, granularity, seriesByBucket)
        // Earliest observation for the SELECTION being charted. Scoped to the
        // request's sourceId, because a per-source view that inherits another
        // source's coverage marks pre-connection buckets measured and then fits
        // a confident slope through zeros that were never recorded.
        // Still not window-bound: when recording began does not change with the
        // range being viewed.
        const coverageScope = (col: SQLiteColumn, srcCol: SQLiteColumn) =>
          sourceIdParam ? and(eq(col, project.id), eq(srcCol, sourceIdParam))! : eq(col, project.id)
        const firsts = [
          app.db.select({ v: sql<string>`MIN(${crawlerEventsHourly.tsHour})` })
            .from(crawlerEventsHourly)
            .where(coverageScope(crawlerEventsHourly.projectId, crawlerEventsHourly.sourceId)).get()?.v,
          app.db.select({ v: sql<string>`MIN(${aiUserFetchEventsHourly.tsHour})` })
            .from(aiUserFetchEventsHourly)
            .where(coverageScope(aiUserFetchEventsHourly.projectId, aiUserFetchEventsHourly.sourceId)).get()?.v,
          app.db.select({ v: sql<string>`MIN(${aiReferralEventsHourly.tsHour})` })
            .from(aiReferralEventsHourly)
            .where(coverageScope(aiReferralEventsHourly.projectId, aiReferralEventsHourly.sourceId)).get()?.v,
        ].filter((v): v is string => typeof v === 'string' && v.length > 0)
        const coverageStart = firsts.length ? firsts.slice().sort()[0]! : null
        // A DAY bucket is `YYYY-MM-DD` (`substr(ts_hour, 1, 10)`) and needs a time
        // appended; an HOUR bucket IS `ts_hour`, ALREADY a full ISO instant
        // (`2026-05-14T23:00:00.000Z`). Appending to the hour form produced
        // `...000Z:00:00.000Z`, which parses to NaN, so the `Number.isFinite`
        // guard below always failed and the partial-hour exclusion was dead code
        // on the hourly series: flat traffic read mid-hour reported a decline.
        const bucketStartMs = (bucket: string): number => Date.parse(
          granularity === TrafficSeriesGranularities.day ? `${bucket}T00:00:00.000Z` : bucket,
        )
        // The newest bucket is partial whenever `until` lands inside it rather
        // than on its boundary, which is the default case (`until` = now).
        const bucketMs = granularity === TrafficSeriesGranularities.day ? 86_400_000 : 3_600_000
        const lastBucket = points.length ? points[points.length - 1]!.bucket : null
        const lastBucketStartMs = lastBucket === null ? null : bucketStartMs(lastBucket)
        const trailingBucketIsPartial = lastBucketStartMs !== null
          && Number.isFinite(lastBucketStartMs)
          && until.getTime() < lastBucketStartMs + bucketMs
        // A bucket before coverage reads 0 because nothing was recording, not
        // because nothing happened. Compare on the bucket's own granularity so
        // the day coverage began is measured, not half-measured.
        const coverageKey = coverageStart === null
          ? null
          : (granularity === TrafficSeriesGranularities.day ? coverageStart.slice(0, 10) : coverageStart.slice(0, 13))
        for (const pt of points) {
          pt.measured = coverageKey === null
            ? false
            : (granularity === TrafficSeriesGranularities.day ? pt.bucket.slice(0, 10) : pt.bucket.slice(0, 13)) >= coverageKey
        }
        // The FIRST measured bucket is itself partial whenever recording began
        // INSIDE it rather than on its boundary. `measured` cannot see that: it
        // compares at bucket granularity, so the bucket holding `coverageStart`
        // reads as fully measured while holding only the tail of one. Left in,
        // a site flat at 10 hits/hour whose source connected at 14:00 contributes
        // a 100-hit first day against 240-hit neighbours, and the fit returns a
        // confident CLIMB for traffic that never changed. The trailing-edge error
        // mirrored, and the trailing guard alone left it in place.
        const firstMeasuredIdx = points.findIndex((pt) => pt.measured)
        const coverageStartMs = coverageStart === null ? null : Date.parse(coverageStart)
        const leadingBucketIsPartial = firstMeasuredIdx >= 0
          && coverageStartMs !== null
          && Number.isFinite(coverageStartMs)
          // Strict: coverage starting exactly on the boundary is a WHOLE bucket.
          && coverageStartMs > bucketStartMs(points[firstMeasuredIdx]!.bucket)
        // Fitted server-side so the CLI and every other consumer get the same
        // line the chart draws (the UI/CLI parity rule). Points are densified,
        // so a quiet day is a real 0 in the fit rather than a gap.
        return {
          granularity,
          points,
          coverageStart,
          // Two edges are excluded from the fit, both for the same reason: a
          // bucket that is not a full reading must not be treated as one.
          //
          // Leading: unmeasured buckets predate recording, so they are the
          // ABSENCE of a reading, not a reading of zero. The first MEASURED
          // bucket goes too when recording began inside it, since a fraction of
          // a bucket read as a whole one slopes the fit up out of nothing.
          //
          // Trailing: `until` defaults to now, so the newest bucket holds only
          // the elapsed fraction of the current period. A site flat at 500/day
          // read at 02:00 UTC gives [...500, 500, 40] and the fit returns a
          // confident decline for a site that is not declining. Same class of
          // error as the leading edge, and the one the leading guard alone
          // would have left in place.
          //
          // linearTrend skips nulls while surviving points keep their true
          // index, so dropping an edge does not compress the x-axis.
          trends: (() => {
            const usable = (pt: TrafficSeriesPoint, i: number) =>
              pt.measured
              && !(i === firstMeasuredIdx && leadingBucketIsPartial)
              && !(i === points.length - 1 && trailingBucketIsPartial)
            const series = (pick: (pt: TrafficSeriesPoint) => number) =>
              linearTrend(points.map((pt, i) => (usable(pt, i) ? pick(pt) : null)))
            return {
              crawlerContentHits: series((pt) => pt.crawlerContentHits),
              aiUserFetchHits: series((pt) => pt.aiUserFetchHits),
              aiReferralLandedHits: series((pt) => pt.aiReferralLandedHits),
            }
          })(),
        }
      })(),
      totals: {
        crawlerHits: crawlerTotal,
        crawlerContentHits: crawlerSegments.content,
        crawlerInfraHits: sumInfraHits(crawlerSegments),
        crawlerSegments,
        aiUserFetchHits: aiUserFetchTotal,
        aiReferralHits: aiReferralTotalHits,
        aiReferralLandedHits,
        aiReferralRedirectedHits: aiReferralTotalHits - aiReferralNonHopHits,
        aiReferralPaidHits: aiReferralCounts.paid,
        aiReferralOrganicHits: aiReferralCounts.organic,
        aiReferralUnknownHits: aiReferralCounts.unknown,
      },
      eventRows: {
        total: totalEventRows,
        returned: trimmed.length,
        truncated: trimmed.length < totalEventRows,
      },
      events: eventsWithProvenance,
    }
    return response
  })
}
