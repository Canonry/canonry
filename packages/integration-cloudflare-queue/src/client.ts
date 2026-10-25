import type {
  AckCloudflareQueueMessagesOptions,
  CloudflareQueueAckResult,
  CloudflareQueueClientOptions,
  CloudflareQueueFetch,
  CloudflareQueueMessage,
  CloudflareQueueMessageBase,
  CloudflareQueuePullResult,
  CloudflareQueuePoisonMessage,
  CloudflareQueueRetry,
  PullCloudflareQueueMessagesOptions,
} from './types.js'

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
// Four 30-second request attempts plus three capped waits fit inside the
// route's five-minute source lease. Never honor an upstream Retry-After that
// would turn a bounded retry count into an unbounded sync.
const MAX_RETRY_DELAY_MS = 30_000
const MAX_PULL_BATCH_SIZE = 100
const MAX_VISIBILITY_TIMEOUT_MS = 12 * 60 * 60_000

/** Deliberately contains no bearer token, response body, or upstream details. */
export class CloudflareQueueApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfter?: string,
  ) {
    super(message)
    this.name = 'CloudflareQueueApiError'
  }
}

interface ResolvedClientOptions {
  accountId: string
  queueId: string
  apiToken: string
  fetchImpl: CloudflareQueueFetch
  apiBaseUrl: string
  timeoutMs: number
  maxRetries: number
  retryBaseDelayMs: number
  sleep?: (ms: number) => Promise<void>
}

function required(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new CloudflareQueueApiError(`${label} is required`, 400)
  return trimmed
}

function positiveInteger(value: number, label: string, maximum?: number): number {
  if (!Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? 'a positive integer' : `an integer from 1 to ${maximum}`
    throw new CloudflareQueueApiError(`${label} must be ${range}`, 400)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CloudflareQueueApiError(`${label} must be a non-negative integer`, 502)
  }
  return value
}

function resolveOptions(options: CloudflareQueueClientOptions): ResolvedClientOptions {
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '')
  try {
    new URL(apiBaseUrl)
  } catch {
    throw new CloudflareQueueApiError('apiBaseUrl must be a valid URL', 400)
  }
  return {
    accountId: required(options.accountId, 'accountId'),
    queueId: required(options.queueId, 'queueId'),
    apiToken: required(options.apiToken, 'apiToken'),
    fetchImpl: options.fetchImpl ?? fetch,
    apiBaseUrl,
    timeoutMs: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxRetries: nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries'),
    retryBaseDelayMs: positiveInteger(options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS, 'retryBaseDelayMs'),
    sleep: options.sleep,
  }
}

function queueUrl(options: ResolvedClientOptions): string {
  return `${options.apiBaseUrl}/accounts/${encodeURIComponent(options.accountId)}` +
    `/queues/${encodeURIComponent(options.queueId)}`
}

function queueMessagesUrl(options: ResolvedClientOptions, action: 'pull' | 'ack'): string {
  return `${queueUrl(options)}/messages/${action}`
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'TimeoutError'
}

function isRetryableQueueError(error: unknown): boolean {
  if (isAbortError(error)) return false
  if (error instanceof CloudflareQueueApiError) {
    return error.status === 429 || error.status >= 500
  }
  return true
}

function retryAfterDelay(value: string | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

async function withQueueRetry<T>(
  attempt: () => Promise<T>,
  options: Pick<ResolvedClientOptions, 'maxRetries' | 'retryBaseDelayMs' | 'sleep'>,
): Promise<T> {
  let lastError: unknown
  for (let attemptNumber = 0; attemptNumber <= options.maxRetries; attemptNumber += 1) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (attemptNumber >= options.maxRetries || !isRetryableQueueError(error)) throw error
      const defaultDelayMs = options.retryBaseDelayMs * Math.pow(2, attemptNumber)
      const requestedDelayMs = error instanceof CloudflareQueueApiError
        ? retryAfterDelay(error.retryAfter) ?? defaultDelayMs
        : defaultDelayMs
      const delayMs = Math.min(requestedDelayMs, MAX_RETRY_DELAY_MS)
      if (options.sleep) {
        await options.sleep(delayMs)
      } else if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

async function postJson<T>(
  options: ResolvedClientOptions,
  action: 'pull' | 'ack',
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson<T>(options, { method: 'POST', url: queueMessagesUrl(options, action), label: action, body }, signal)
}

async function requestJson<T>(
  options: ResolvedClientOptions,
  request: { method: 'GET' | 'POST'; url: string; label: string; body?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<T> {
  const { label: action } = request
  return withQueueRetry(async () => {
    let response: Response
    try {
      response = await options.fetchImpl(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: requestSignal(options.timeoutMs, signal),
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new CloudflareQueueApiError('Cloudflare Queue request timed out or was aborted', 408)
      }
      // Custom fetch implementations can include the Authorization header or
      // response body in their thrown error. Collapse all transport detail to
      // a retryable, secret-free error before it crosses this package boundary.
      throw new CloudflareQueueApiError('Cloudflare Queue request failed', 503)
    }

    if (!response.ok) {
      throw new CloudflareQueueApiError(
        `Cloudflare Queue ${action} failed with HTTP ${response.status}`,
        response.status,
        response.headers.get('retry-after') ?? undefined,
      )
    }

    try {
      return await response.json() as T
    } catch (error) {
      // A timeout while reading the body is a timeout, not a bad payload.
      if (isAbortError(error)) {
        throw new CloudflareQueueApiError('Cloudflare Queue request timed out or was aborted', 408)
      }
      throw new CloudflareQueueApiError(`Cloudflare Queue ${action} returned invalid JSON`, 502)
    }
  }, {
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    sleep: options.sleep,
  })
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudflareQueueApiError(`Cloudflare Queue ${label} is malformed`, 502)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new CloudflareQueueApiError(`Cloudflare Queue ${label} is malformed`, 502)
  }
  return value
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new CloudflareQueueApiError(`Cloudflare Queue ${label} is malformed`, 502)
  }
  return value
}

function metadata(record: Record<string, unknown>): Record<string, string> {
  const value = asRecord(record.metadata, 'message metadata')
  const parsed: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new CloudflareQueueApiError('Cloudflare Queue message metadata is malformed', 502)
    }
    parsed[key] = entry
  }
  return parsed
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(value)) {
    throw new CloudflareQueueApiError('Cloudflare Queue message body is malformed', 502)
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new CloudflareQueueApiError('Cloudflare Queue JSON message body is malformed', 502)
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CloudflareQueueApiError('Cloudflare Queue JSON message body is malformed', 502)
  }
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return parseJson(decodeUtf8(decodeBase64(value)))
  }
}

function safeMessageBase(
  record: Record<string, unknown>,
  leaseId: string,
): CloudflareQueueMessageBase {
  const rawMetadata = record.metadata
  const safeMetadata: Record<string, string> = {}
  let metadataIsSafe = rawMetadata != null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
  if (metadataIsSafe) {
    for (const [key, value] of Object.entries(rawMetadata as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        metadataIsSafe = false
        break
      }
      safeMetadata[key] = value
    }
  }
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : '<malformed>',
    leaseId,
    timestampMs: Number.isInteger(record.timestamp_ms) && (record.timestamp_ms as number) >= 0
      ? record.timestamp_ms as number
      : 0,
    attempts: Number.isInteger(record.attempts) && (record.attempts as number) >= 0
      ? record.attempts as number
      : 0,
    metadata: metadataIsSafe ? safeMetadata : {},
  }
}

function decodeMessage(record: Record<string, unknown>): CloudflareQueueMessage {
  const leaseId = requiredString(record, 'lease_id', 'message')
  let base: CloudflareQueueMessageBase
  let rawBody: string
  try {
    base = {
      id: requiredString(record, 'id', 'message'),
      leaseId,
      timestampMs: nonNegativeInteger(record.timestamp_ms as number, 'message timestamp_ms'),
      attempts: nonNegativeInteger(record.attempts as number, 'message attempts'),
      metadata: metadata(record),
    }
    rawBody = stringField(record, 'body', 'message')
  } catch (error) {
    if (!(error instanceof CloudflareQueueApiError)) throw error
    return {
      ...safeMessageBase(record, leaseId),
      contentType: 'poison',
      reason: 'malformed-envelope',
    }
  }
  const contentType = base.metadata['CF-Content-Type'] ?? 'json'
  const poison = (reason: CloudflareQueuePoisonMessage['reason']): CloudflareQueuePoisonMessage => ({
    ...base,
    contentType: 'poison',
    reason,
  })

  if (contentType === 'bytes') {
    try {
      return { ...base, contentType, body: decodeBase64(rawBody) }
    } catch {
      return poison('malformed-body')
    }
  }
  if (contentType === 'json') {
    try {
      return { ...base, contentType, body: decodeJson(rawBody) }
    } catch {
      return poison('malformed-body')
    }
  }
  if (contentType === 'text') {
    return { ...base, contentType, body: rawBody }
  }
  return poison('unsupported-content-type')
}

function parsePullEnvelope(value: unknown): CloudflareQueuePullResult {
  const envelope = asRecord(value, 'pull response')
  if (envelope.success !== true) {
    throw new CloudflareQueueApiError('Cloudflare Queue pull was not successful', 502)
  }
  const result = asRecord(envelope.result, 'pull result')
  const messageBacklogCount = nonNegativeInteger(result.message_backlog_count as number, 'message_backlog_count')
  if (!Array.isArray(result.messages)) {
    throw new CloudflareQueueApiError('Cloudflare Queue messages is malformed', 502)
  }
  if (result.messages.length > MAX_PULL_BATCH_SIZE) {
    throw new CloudflareQueueApiError('Cloudflare Queue returned too many messages', 502)
  }
  const messages: CloudflareQueueMessage[] = []
  let skippedUnleasedMessageCount = 0
  for (const rawMessage of result.messages) {
    if (rawMessage == null || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      skippedUnleasedMessageCount += 1
      continue
    }
    const message = rawMessage as Record<string, unknown>
    if (typeof message.lease_id !== 'string' || !message.lease_id.trim()) {
      skippedUnleasedMessageCount += 1
      continue
    }
    messages.push(decodeMessage(message))
  }
  return { messageBacklogCount, messages, skippedUnleasedMessageCount }
}

function optionalAckCount(record: Record<string, unknown>, key: 'ackCount' | 'retryCount'): number | undefined {
  if (!(key in record)) return undefined
  return nonNegativeInteger(record[key] as number, `ack response ${key}`)
}

function ackWarningCount(value: unknown): number {
  if (value == null) return 0
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudflareQueueApiError('Cloudflare Queue acknowledgement warnings are malformed', 502)
  }
  const warnings = value as Record<string, unknown>
  if (Object.values(warnings).some((warning) => typeof warning !== 'string')) {
    throw new CloudflareQueueApiError('Cloudflare Queue acknowledgement warnings are malformed', 502)
  }
  return Object.keys(warnings).length
}

function parseAckEnvelope(value: unknown, expectedAckCount: number, expectedRetryCount: number): number {
  const envelope = asRecord(value, 'ack response')
  if (envelope.success !== true) {
    throw new CloudflareQueueApiError('Cloudflare Queue acknowledgement was not successful', 502)
  }
  if (envelope.result == null) return 0
  const result = asRecord(envelope.result, 'ack result')
  const ackCount = optionalAckCount(result, 'ackCount')
  const retryCount = optionalAckCount(result, 'retryCount')
  if (
    ackCount !== undefined && ackCount !== expectedAckCount
    || retryCount !== undefined && retryCount !== expectedRetryCount
  ) {
    throw new CloudflareQueueApiError('Cloudflare Queue acknowledgement was incomplete', 502)
  }
  return ackWarningCount(result.warnings)
}

function normalizeRetries(retries: readonly CloudflareQueueRetry[] | undefined): CloudflareQueueRetry[] {
  return (retries ?? []).map((retry) => {
    const leaseId = required(retry.leaseId, 'retry leaseId')
    if (retry.delaySeconds !== undefined) {
      nonNegativeInteger(retry.delaySeconds, 'retry delaySeconds')
    }
    return { leaseId, ...(retry.delaySeconds === undefined ? {} : { delaySeconds: retry.delaySeconds }) }
  })
}

/** Cloudflare's longest configurable Queue message retention today: 14 days, in seconds. */
export const CLOUDFLARE_QUEUE_MAX_RETENTION_SECONDS = 14 * 24 * 60 * 60
// Cloudflare's shortest configurable retention, in seconds.
const MIN_RETENTION_SECONDS = 60
// A reported retention above today's maximum is used as is (Cloudflare may
// raise the limit); this sanity cap only rejects nonsense values.
const SANITY_MAX_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * The Queue's message retention in seconds, as Cloudflare reports it now
 * (`GET /queues/{id}`, `result.settings.message_retention_period`). A message
 * can only be redelivered while it is retained, so this bounds how long a
 * consumer must remember what it already processed. Null when the response
 * is not a success or carries no usable value; HTTP and transport failures throw.
 */
export async function getCloudflareQueueRetentionSeconds(
  client: CloudflareQueueClientOptions,
  signal?: AbortSignal,
): Promise<number | null> {
  const resolved = resolveOptions(client)
  const envelope = recordOrNull(await requestJson<unknown>(resolved, { method: 'GET', url: queueUrl(resolved), label: 'read' }, signal))
  if (envelope?.success !== true) return null
  const seconds = recordOrNull(recordOrNull(envelope.result)?.settings)?.message_retention_period
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= MIN_RETENTION_SECONDS && seconds <= SANITY_MAX_RETENTION_SECONDS
    ? seconds
    : null
}

/** Pull one short-poll batch. The caller owns draining, persistence, and ack ordering. */
export async function pullCloudflareQueueMessages(
  client: CloudflareQueueClientOptions,
  options: PullCloudflareQueueMessagesOptions = {},
): Promise<CloudflareQueuePullResult> {
  const resolved = resolveOptions(client)
  const body: Record<string, unknown> = {}
  if (options.batchSize !== undefined) body.batch_size = positiveInteger(options.batchSize, 'batchSize', MAX_PULL_BATCH_SIZE)
  if (options.visibilityTimeoutMs !== undefined) {
    body.visibility_timeout_ms = positiveInteger(
      options.visibilityTimeoutMs, 'visibilityTimeoutMs', MAX_VISIBILITY_TIMEOUT_MS,
    )
  }
  return parsePullEnvelope(await postJson<unknown>(resolved, 'pull', body, options.signal))
}

/** Group acknowledgements and explicit retries for one or more currently leased messages. */
export async function ackCloudflareQueueMessages(
  client: CloudflareQueueClientOptions,
  options: AckCloudflareQueueMessagesOptions,
): Promise<CloudflareQueueAckResult> {
  const resolved = resolveOptions(client)
  const acknowledgedLeaseIds = (options.acks ?? []).map((leaseId) => required(leaseId, 'ack leaseId'))
  const retriedLeaseIds = normalizeRetries(options.retries)
  if (acknowledgedLeaseIds.length === 0 && retriedLeaseIds.length === 0) {
    throw new CloudflareQueueApiError('at least one acknowledgement or retry is required', 400)
  }
  const envelope = await postJson<unknown>(resolved, 'ack', {
    acks: acknowledgedLeaseIds.map((lease_id) => ({ lease_id })),
    retries: retriedLeaseIds.map(({ leaseId, delaySeconds }) => ({
      lease_id: leaseId,
      ...(delaySeconds === undefined ? {} : { delay_seconds: delaySeconds }),
    })),
  }, options.signal)
  const warningCount = parseAckEnvelope(envelope, acknowledgedLeaseIds.length, retriedLeaseIds.length)
  return { acknowledgedLeaseIds, retriedLeaseIds, warningCount }
}
