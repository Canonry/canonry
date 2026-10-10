import { z } from 'zod'
import { describeError } from './errors.js'
import { notificationEventSchema } from './notification.js'
import { PROVIDER_NAMES } from './provider.js'
import { classifyProviderErrorMessage, type ProviderErrorCode } from './provider-errors.js'

/**
 * Outcome telemetry: what happened when a feature ran, not just that a
 * command or page was used. Three generic event names cover every feature,
 * so the canonry.ai collector allowlist changes once and future features
 * only extend these enums:
 *
 * - `integration.connection`: one per connect, disconnect, test, reauth or
 *   select attempt for any integration, with a reason code on failure.
 * - `feature.completed`: one per job, sync, delivery, agent turn or other
 *   operation, with status, reason code, duration bucket and counts.
 * - `install.state`: one per running server per day: what is set up, plus
 *   24-hour usage totals (provider calls, Aero LLM usage, deliveries).
 *
 * Privacy: enums, integer counts and buckets only. Never URLs, domains
 * (use `domainHash`), account or property ids, names, or free text. The
 * collector rejects null, so absent fields are omitted, never null.
 */

/** Interfaces an outcome can come through. `system` is the server acting on its own (schedules, retries, startup). */
export const OUTCOME_SURFACES = ['cli', 'mcp-stdio', 'mcp-http', 'aero', 'api', 'dashboard', 'system'] as const
export const outcomeSurfaceSchema = z.enum(OUTCOME_SURFACES)
export type OutcomeSurface = z.infer<typeof outcomeSurfaceSchema>
export const OutcomeSurfaces = outcomeSurfaceSchema.enum

/** Every integration a user connects. `provider` carries the answer-engine name in `provider`. */
export const INTEGRATION_NAMES = [
  'provider',
  'gsc',
  'ga4',
  'bing',
  'gbp',
  'google_ads',
  'gtm',
  'openai_ads',
  'traffic_cloudflare',
  'traffic_vercel',
  'traffic_cloud_run',
  'wordpress',
  'backlinks',
  'webhook',
  'agent_webhook',
  'cdp',
] as const
export const integrationNameSchema = z.enum(INTEGRATION_NAMES)
export type IntegrationName = z.infer<typeof integrationNameSchema>
export const IntegrationNames = integrationNameSchema.enum

export const CONNECTION_ACTIONS = ['connect', 'disconnect', 'test', 'reauth', 'select'] as const
export const connectionActionSchema = z.enum(CONNECTION_ACTIONS)
export type ConnectionAction = z.infer<typeof connectionActionSchema>
export const ConnectionActions = connectionActionSchema.enum

/** `started` marks a multi-step flow (an OAuth redirect) whose result arrives later. */
export const CONNECTION_STATUSES = ['started', 'succeeded', 'failed', 'cancelled'] as const
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES)
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>
export const ConnectionStatuses = connectionStatusSchema.enum

export const OUTCOME_STATUSES = ['succeeded', 'partial', 'failed', 'skipped', 'cancelled'] as const
export const outcomeStatusSchema = z.enum(OUTCOME_STATUSES)
export type OutcomeStatus = z.infer<typeof outcomeStatusSchema>
export const OutcomeStatuses = outcomeStatusSchema.enum

/** What started an operation. `push` is an external system sending data in (a Cloudflare Worker). */
export const OUTCOME_TRIGGERS = ['manual', 'scheduled', 'agent', 'startup', 'retry', 'push'] as const
export const outcomeTriggerSchema = z.enum(OUTCOME_TRIGGERS)
export type OutcomeTrigger = z.infer<typeof outcomeTriggerSchema>
export const OutcomeTriggers = outcomeTriggerSchema.enum

/**
 * Why an attempt failed, was skipped or was cancelled. Stable and closed:
 * analysis ranks these to tell us what to fix. Map anything unrecognized to
 * `UNKNOWN` and put the error class name in `errorName`, never its message.
 */
export const OUTCOME_REASON_CODES = [
  'AUTH_DENIED',
  'OAUTH_CANCELLED',
  'OAUTH_STATE_INVALID',
  'INVALID_CREDENTIALS',
  'PERMISSION_MISSING',
  'NOT_CONNECTED',
  'ALREADY_CONNECTED',
  'NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
  'PROPERTY_NOT_FOUND',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'BILLING',
  'NETWORK',
  'TIMEOUT',
  'HTTP_4XX',
  'HTTP_5XX',
  'BLOCKED_UNSAFE_URL',
  'VALIDATION',
  'UNSUPPORTED',
  'NO_DATA',
  'NOT_DUE',
  'GATE_REFUSED',
  'OPERATION_IN_PROGRESS',
  'QUARANTINED',
  'CANCELLED_BY_USER',
  'SERVER_RESTARTED',
  'INTERNAL',
  'UNKNOWN',
] as const
export const outcomeReasonCodeSchema = z.enum(OUTCOME_REASON_CODES)
export type OutcomeReasonCode = z.infer<typeof outcomeReasonCodeSchema>
export const OutcomeReasonCodes = outcomeReasonCodeSchema.enum

/** Every feature and the operations it reports. An operation outside its feature's list is rejected. */
export const FEATURE_OPERATIONS = {
  search_console: ['sync', 'inspect', 'sitemap_submit'],
  ga4: ['sync'],
  bing: ['sync', 'inspect'],
  gbp: ['sync', 'reviews'],
  google_ads: ['sync'],
  gtm: ['sync'],
  openai_ads: ['sync', 'operation', 'activation', 'reconcile'],
  server_traffic: ['sync', 'ingest', 'backfill', 'reset'],
  backlinks: ['install', 'sync', 'extract'],
  content: ['analyze', 'brief'],
  research: ['run'],
  discovery: ['run'],
  sentiment: ['run'],
  aero: ['turn'],
  webhooks: ['deliver', 'test'],
  schedules: ['slot'],
  exports: ['export'],
  providers: ['reload'],
  wordpress: ['schema_deploy', 'llms_txt', 'meta_write', 'publish'],
  measurement: ['publish'],
  insights: ['generate'],
  site_liveness: ['check'],
  reports: ['download'],
  data_refresh: ['refresh'],
} as const satisfies Record<string, readonly string[]>
export type FeatureName = keyof typeof FEATURE_OPERATIONS
export const FEATURE_NAMES = Object.keys(FEATURE_OPERATIONS) as [FeatureName, ...FeatureName[]]
export const featureNameSchema = z.enum(FEATURE_NAMES)
export const FeatureNames = featureNameSchema.enum
export type FeatureOperation<F extends FeatureName = FeatureName> = (typeof FEATURE_OPERATIONS)[F][number]

/** Integer result counts an outcome may carry; at most 12 per event. Tokens and cost are totals, cost in micro-USD. */
export const OUTCOME_COUNT_KEYS = [
  'rows',
  'pages',
  'urls',
  'links',
  'domains',
  'reviews',
  'events',
  'crawlerHits',
  'aiReferralHits',
  'aiUserFetchHits',
  'campaigns',
  'operations',
  'queries',
  'snapshots',
  'briefs',
  'gaps',
  'targets',
  'insights',
  'toolCalls',
  'toolErrors',
  'modelCalls',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'costMicros',
  'attempts',
  'deliveries',
  'failures',
  'skipped',
  'providers',
  'items',
  'bytes',
] as const
export type OutcomeCountKey = (typeof OUTCOME_COUNT_KEYS)[number]
const COUNT_KEY_SET: ReadonlySet<string> = new Set(OUTCOME_COUNT_KEYS)
const MAX_COUNT = 1e12
const countValueSchema = z.number().int().min(0).max(MAX_COUNT)
const countsSchema = z
  .record(z.string(), countValueSchema)
  .refine(obj => Object.keys(obj).length > 0 && Object.keys(obj).length <= 12, 'counts must have 1 to 12 keys')
  .refine(obj => Object.keys(obj).every(k => COUNT_KEY_SET.has(k)), 'unknown count key')

/** Webhook destination kind, read from the URL host shape; never the URL itself. */
export const WEBHOOK_TARGETS = ['first_party', 'slack', 'discord'] as const
export const webhookTargetSchema = z.enum(WEBHOOK_TARGETS)
export type WebhookTarget = z.infer<typeof webhookTargetSchema>
export const WebhookTargets = webhookTargetSchema.enum

/** HTTP outcome class of an outbound call. `blocked` is refused before sending (unsafe destination). */
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'timeout', 'network', 'blocked'] as const
export const statusClassSchema = z.enum(STATUS_CLASSES)
export type StatusClass = z.infer<typeof statusClassSchema>
export const StatusClasses = statusClassSchema.enum

export const DURATION_BUCKETS = ['under_1s', '1s_to_10s', '10s_to_1m', '1m_to_5m', '5m_to_30m', '30m_or_more'] as const
export const durationBucketSchema = z.enum(DURATION_BUCKETS)
export type DurationBucket = z.infer<typeof durationBucketSchema>
export const DurationBuckets = durationBucketSchema.enum

/** The same low-cardinality buckets `cli.command.finished` uses. */
export function bucketDuration(durationMs: number): DurationBucket {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  if (duration < 1_000) return 'under_1s'
  if (duration < 10_000) return '1s_to_10s'
  if (duration < 60_000) return '10s_to_1m'
  if (duration < 300_000) return '1m_to_5m'
  if (duration < 1_800_000) return '5m_to_30m'
  return '30m_or_more'
}

const errorNameSchema = z.string().regex(/^[A-Z_$][\w$]{0,39}$/i)
const agentSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/)
const providerNameSchema = z.enum(PROVIDER_NAMES)
/** Model ids are public catalog names (`gemini-flash-latest`), bounded and character-limited. */
const modelIdSchema = z.string().regex(/^[A-Z0-9][\w.:/@-]{0,99}$/i).refine(v => !v.includes('://'), 'a model id is never a URL')
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/)

export const integrationConnectionPropertiesSchema = z
  .object({
    integration: integrationNameSchema,
    provider: providerNameSchema.optional(),
    action: connectionActionSchema,
    status: connectionStatusSchema,
    reasonCode: outcomeReasonCodeSchema.optional(),
    errorName: errorNameSchema.optional(),
    target: webhookTargetSchema.optional(),
    surface: outcomeSurfaceSchema.optional(),
    agent: agentSlugSchema.optional(),
    durationBucket: durationBucketSchema.optional(),
    attempt: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
  .refine(
    p => (p.integration === IntegrationNames.provider) === (p.provider !== undefined),
    'provider is required for, and only for, integration provider',
  )
  .refine(
    p => p.status === ConnectionStatuses.succeeded || p.status === ConnectionStatuses.started || p.reasonCode !== undefined,
    'a failed or cancelled attempt needs a reasonCode',
  )
export type IntegrationConnectionProperties = z.infer<typeof integrationConnectionPropertiesSchema>

export const featureCompletedPropertiesSchema = z
  .object({
    feature: featureNameSchema,
    operation: z.string().regex(/^[a-z][a-z_]{0,31}$/),
    status: outcomeStatusSchema,
    trigger: outcomeTriggerSchema.optional(),
    surface: outcomeSurfaceSchema.optional(),
    agent: agentSlugSchema.optional(),
    reasonCode: outcomeReasonCodeSchema.optional(),
    errorName: errorNameSchema.optional(),
    durationBucket: durationBucketSchema.optional(),
    counts: countsSchema.optional(),
    target: webhookTargetSchema.optional(),
    eventType: notificationEventSchema.optional(),
    statusClass: statusClassSchema.optional(),
    provider: providerNameSchema.optional(),
    model: modelIdSchema.optional(),
    modelProvider: slugSchema.optional(),
    sampleRate: z.number().int().min(1).max(1_000_000).optional(),
    droppedBefore: z.number().int().min(0).max(MAX_COUNT).optional(),
    domainHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine(
    p => (FEATURE_OPERATIONS[p.feature] as readonly string[]).includes(p.operation),
    'operation is not one this feature reports',
  )
  .refine(p => p.status === OutcomeStatuses.succeeded || p.reasonCode !== undefined, 'a non-succeeded outcome needs a reasonCode')
export type FeatureCompletedProperties = z.infer<typeof featureCompletedPropertiesSchema>

/** What an install has set up. Counts are exact small integers; there is nothing identifying in a count. */
export const INSTALL_STATE_COUNT_KEYS = [
  'projects',
  'queries',
  'competitors',
  'locations',
  'schedules',
  'webhooks',
  'agentWebhooks',
  'trafficSources',
  'googleConnections',
  'bingConnections',
  'backlinkSources',
  'adsAccounts',
] as const
/** 24-hour usage totals. Provider usage is answer-engine calls from sweeps, research and discovery; aero* is the built-in agent's own LLM. */
export const INSTALL_STATE_USAGE_KEYS = [
  'sweeps',
  'audits',
  'providerCalls',
  'inputTokens',
  'outputTokens',
  'costMicros',
  'aeroTurns',
  'aeroModelCalls',
  'aeroInputTokens',
  'aeroOutputTokens',
  'aeroCostMicros',
  'webhookDeliveries',
] as const
const fixedKeyCounts = (keys: readonly string[]) => {
  const allowed = new Set(keys)
  return z
    .record(z.string(), countValueSchema)
    .refine(obj => Object.keys(obj).every(k => allowed.has(k)), 'unknown key')
}

export const installStatePropertiesSchema = z
  .object({
    providers: z.array(providerNameSchema).max(PROVIDER_NAMES.length),
    integrations: z.array(integrationNameSchema.exclude([IntegrationNames.provider])).max(INTEGRATION_NAMES.length),
    counts: fixedKeyCounts(INSTALL_STATE_COUNT_KEYS),
    usage24h: fixedKeyCounts(INSTALL_STATE_USAGE_KEYS),
    providerCalls24h: fixedKeyCounts(PROVIDER_NAMES).optional(),
    agentProvider: slugSchema.optional(),
    agentModel: modelIdSchema.optional(),
    uptimeBucket: durationBucketSchema.optional(),
  })
  .strict()
export type InstallStateProperties = z.infer<typeof installStatePropertiesSchema>

/** An HTTP status, or the absence of one, as a status class. */
export function statusClassOf(status: number | undefined | null): StatusClass {
  if (status === undefined || status === null || status === 0) return 'network'
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  return '2xx'
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

function httpStatusOf(err: Record<string, unknown>): number | undefined {
  for (const value of [err.status, err.statusCode, (err.response as Record<string, unknown> | undefined)?.status, (err.details as Record<string, unknown> | undefined)?.httpStatus]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value
  }
  return undefined
}

/**
 * Classify any thrown value into a reason code without reading its message.
 * Callers that know better (an OAuth `access_denied`, a refused gate) pass
 * their own code; this is the fallback for everything else.
 */
export function classifyOutcomeError(err: unknown): { reasonCode: OutcomeReasonCode; errorName?: string } {
  if (!err || typeof err !== 'object') return { reasonCode: 'UNKNOWN' }
  const e = err as Record<string, unknown>
  const rawName = typeof e.name === 'string' ? e.name : (err as object).constructor?.name
  const errorName = typeof rawName === 'string' && errorNameSchema.safeParse(rawName).success ? rawName : undefined
  const code = typeof e.code === 'string' ? e.code : undefined
  const known = code && (OUTCOME_REASON_CODES as readonly string[]).includes(code) ? (code as OutcomeReasonCode) : undefined
  if (known) return { reasonCode: known, errorName }
  if (errorName === 'AbortError' || errorName === 'TimeoutError' || (code && TIMEOUT_CODES.has(code))) return { reasonCode: 'TIMEOUT', errorName }
  if (code && NETWORK_CODES.has(code)) return { reasonCode: 'NETWORK', errorName }
  if (code === 'PROVIDER_AUTH' || code === 'AUTH_INVALID' || code === 'AUTH_REQUIRED') return { reasonCode: 'INVALID_CREDENTIALS', errorName }
  if (code === 'FORBIDDEN') return { reasonCode: 'PERMISSION_MISSING', errorName }
  if (code === 'PROVIDER_BILLING') return { reasonCode: 'BILLING', errorName }
  if (code === 'NOT_FOUND') return { reasonCode: 'NOT_FOUND', errorName }
  if (code === 'VALIDATION_ERROR') return { reasonCode: 'VALIDATION', errorName }
  if (code === 'RUN_CANCELLED') return { reasonCode: 'CANCELLED_BY_USER', errorName }
  const status = httpStatusOf(e)
  if (status === 401) return { reasonCode: 'INVALID_CREDENTIALS', errorName }
  if (status === 403) return { reasonCode: 'PERMISSION_MISSING', errorName }
  if (status === 404) return { reasonCode: 'NOT_FOUND', errorName }
  if (status === 429) return { reasonCode: 'RATE_LIMITED', errorName }
  if (status !== undefined && status >= 500) return { reasonCode: 'HTTP_5XX', errorName }
  if (status !== undefined && status >= 400) return { reasonCode: 'HTTP_4XX', errorName }
  return { reasonCode: 'UNKNOWN', errorName }
}

/** A provider failure bucket (`classifyProviderErrorMessage`) as an outcome reason. */
export function providerErrorOutcomeReason(code: ProviderErrorCode): OutcomeReasonCode {
  switch (code) {
    case 'PROVIDER_AUTH': return 'INVALID_CREDENTIALS'
    case 'PROVIDER_BILLING': return 'BILLING'
    case 'RATE_LIMITED': return 'RATE_LIMITED'
    case 'PROVIDER_UNAVAILABLE': return 'HTTP_5XX'
    case 'TIMEOUT': return 'TIMEOUT'
    case 'NETWORK': return 'NETWORK'
    case 'PARSE_ERROR': return 'UNKNOWN'
    case 'UNKNOWN': return 'UNKNOWN'
  }
}

/**
 * Classify a failed answer-engine call. Provider adapters throw plain errors
 * whose text is the only signal, so after the code and status checks this
 * falls back to the same text buckets `run.completed` uses. The text is read
 * here and never sent.
 */
export function classifyProviderOutcomeError(err: unknown): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const classified = classifyOutcomeError(err)
  if (classified.reasonCode !== 'UNKNOWN') return classified
  return { ...classified, reasonCode: providerErrorOutcomeReason(classifyProviderErrorMessage(describeError(err))) }
}
