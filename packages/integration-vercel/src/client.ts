import { normalizeVercelLogRow } from './normalize.js'
import type {
  ListVercelTrafficEventsOptions,
  VercelRequestLogsResponseBody,
  VercelTrafficEventsPage,
} from './types.js'

const VERCEL_REQUEST_LOGS_URL = 'https://vercel.com/api/logs/request-logs'
const DEFAULT_ENVIRONMENT = 'production'
const DEFAULT_MAX_PAGES = 1
const DEFAULT_TIMEOUT_MS = 30_000
/**
 * Retry transient pull failures (HTTP 429, 5xx, network errors) up to this
 * many times before giving up. A 13-day backfill makes thousands of pulls;
 * one unretried 5xx anywhere in that run would otherwise force the whole
 * replace-mode transaction to roll back. Mirrors the GA4 client retry shape.
 */
const DEFAULT_MAX_RETRIES = 3
/** First backoff before retrying. Doubles each attempt (1s, 2s, 4s). */
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000

export class VercelLogsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
    /** Seconds parsed from the `Retry-After` header, if Vercel sent one. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'VercelLogsApiError'
  }
}

/**
 * Parse `Retry-After` per RFC 7231 §7.1.3: either a delay-seconds integer
 * or an HTTP-date. Returns the delay in seconds, or `undefined` if the
 * header is absent or unparseable.
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  const asNum = Number(trimmed)
  if (Number.isFinite(asNum) && asNum >= 0) return asNum
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, (asDate - Date.now()) / 1000)
  }
  return undefined
}

/**
 * A transient failure is one a retry has a chance of recovering from:
 * - `VercelLogsApiError` with HTTP 429 (rate limit) or 5xx (server-side)
 * - any non-Vercel error (network failure, `fetch` rejection, abort/timeout)
 *
 * 4xx other than 429 — `Unauthorized`, `Forbidden`, retention `400`, bad
 * params — are caller-fixable and surface immediately so the operator sees
 * the real cause instead of waiting through the backoff schedule.
 */
function isRetryableVercelError(error: unknown): boolean {
  if (error instanceof VercelLogsApiError) {
    return error.status === 429 || error.status >= 500
  }
  return true
}

function trimRequired(name: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new VercelLogsApiError(`${name} is required`, 400)
  }
  return trimmed
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new VercelLogsApiError('maxPages must be a positive integer', 400)
  }
  return maxPages
}

function toEpochMs(label: string, value: number | string | Date): string {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : new Date(value).getTime()
  if (!Number.isFinite(ms)) {
    throw new VercelLogsApiError(`${label} must be a valid date`, 400)
  }
  return String(Math.trunc(ms))
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '')
  if (!text) return undefined
  return text.length <= 500 ? text : `${text.slice(0, 500)}... [truncated]`
}

/**
 * Wrap a single fetch+parse attempt with exponential-backoff retry on
 * transient failures (`isRetryableVercelError`). Up to `maxRetries` retries
 * (total attempts capped at `maxRetries + 1`), with backoff doubling each
 * attempt. A `Retry-After` header on the error overrides the computed backoff
 * for that attempt. The final failure is rethrown unchanged so callers see
 * the real underlying error.
 */
async function withVercelRetry<T>(
  attempt: () => Promise<T>,
  maxRetries: number,
  initialDelayMs: number,
): Promise<T> {
  let lastError: unknown
  for (let attemptNumber = 0; attemptNumber <= maxRetries; attemptNumber += 1) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (attemptNumber >= maxRetries || !isRetryableVercelError(error)) throw error
      const retryAfterSeconds = error instanceof VercelLogsApiError
        ? error.retryAfterSeconds
        : undefined
      const computedDelayMs = initialDelayMs * Math.pow(2, attemptNumber)
      const delayMs = retryAfterSeconds !== undefined
        ? Math.max(0, retryAfterSeconds * 1_000)
        : computedDelayMs
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

/**
 * Pull a page (or up to `maxPages` pages) of request logs from Vercel's
 * internal `request-logs` endpoint — the same endpoint the `vercel` CLI rides
 * — normalize each row into `NormalizedTrafficRequest`, and return the merged
 * page plus the `hasMore` continuation signal.
 *
 * Pure pull adapter — no DB, no classification, no credential storage. The
 * caller supplies the Vercel personal access token and bounds the time window.
 */
export async function listVercelTrafficEvents(
  options: ListVercelTrafficEventsOptions,
): Promise<VercelTrafficEventsPage> {
  const token = trimRequired('token', options.token)
  const projectId = trimRequired('projectId', options.projectId)
  const teamId = trimRequired('teamId', options.teamId)
  const environment = options.environment ?? DEFAULT_ENVIRONMENT
  const startDate = toEpochMs('startDate', options.startDate)
  const endDate = toEpochMs('endDate', options.endDate)
  const maxPages = normalizeMaxPages(options.maxPages)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS

  let rawEntryCount = 0
  let skippedEntryCount = 0
  let hasMore = false
  const events: VercelTrafficEventsPage['events'] = []

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(VERCEL_REQUEST_LOGS_URL)
    url.searchParams.set('projectId', projectId)
    url.searchParams.set('ownerId', teamId)
    url.searchParams.set('teamId', teamId)
    url.searchParams.set('page', String(page))
    url.searchParams.set('startDate', startDate)
    url.searchParams.set('endDate', endDate)
    url.searchParams.set('environment', environment)

    // One fetch+parse pass, wrapped in retry so a transient 429/5xx/network
    // hiccup does not kill a multi-hour drain that has already pulled
    // thousands of pages successfully.
    const body = await withVercelRetry(async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        const errorBody = await readErrorBody(response)
        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))
        throw new VercelLogsApiError(
          `Vercel request-logs endpoint returned HTTP ${response.status}`,
          response.status,
          errorBody,
          retryAfterSeconds,
        )
      }

      return (await response.json()) as VercelRequestLogsResponseBody
    }, maxRetries, initialRetryDelayMs)

    const rows = body.rows ?? []
    rawEntryCount += rows.length

    for (const row of rows) {
      const event = normalizeVercelLogRow(row)
      if (event) {
        events.push(event)
      } else {
        skippedEntryCount += 1
      }
    }

    hasMore = Boolean(body.hasMoreRows)
    if (!hasMore) break
  }

  return {
    events,
    rawEntryCount,
    skippedEntryCount,
    hasMore,
    endpoint: VERCEL_REQUEST_LOGS_URL,
  }
}
