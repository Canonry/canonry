import { withRetry } from '@ainyc/canonry-contracts'
import { GBP_REQUEST_TIMEOUT_MS } from './constants.js'
import { GbpApiError } from './types.js'
import type { GbpFetchOptions } from './types.js'

interface GoogleErrorPayload {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Array<{
      reason?: string
      metadata?: Record<string, string>
    }>
  }
}

function extractReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const payload = body as GoogleErrorPayload
  const details = payload.error?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    if (detail && typeof detail.reason === 'string') return detail.reason
  }
  return null
}

function extractQuotaLimitValue(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const payload = body as GoogleErrorPayload
  const details = payload.error?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const raw = detail?.metadata?.quota_limit_value
    if (typeof raw === 'string') {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

/**
 * Decide whether a `GbpApiError` is worth retrying. Mirrors Google's
 * guidance at https://developers.google.com/my-business/content/limits:
 *
 *   - 429 RATE_LIMIT_EXCEEDED  → retry, EXCEPT when `quota_limit_value` is 0
 *                                (the access-form gate — retry won't help).
 *   - 503 Service Unavailable  → retry (transient).
 *   - Everything else (401/403/404/4xx/5xx) → don't retry.
 *
 * Passed to the shared `withRetry` from `@ainyc/canonry-contracts`, which
 * handles the actual loop / backoff math.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof GbpApiError)) return false
  if (err.status === 429) {
    // 0-QPM access gate: project not approved; retrying just burns time.
    return err.quotaLimitValue !== 0
  }
  if (err.status === 503) return true
  return false
}

/**
 * Issue a single GET to the GBP API. Throws `GbpApiError` on non-2xx,
 * carrying the structured `reason` and `quotaLimitValue` so callers can
 * map them to specific error envelopes.
 */
async function gbpFetchOnce<T>(url: string, accessToken: string, opts: GbpFetchOptions): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GBP_REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    }
    if (opts.quotaProject) headers['x-goog-user-project'] = opts.quotaProject

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    const text = await res.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = text }

    if (!res.ok) {
      const payload = body as GoogleErrorPayload | string | undefined
      const message = typeof payload === 'object' && payload?.error?.message
        ? payload.error.message
        : typeof payload === 'string'
          ? payload
          : `HTTP ${res.status}`
      throw new GbpApiError(message, res.status, extractReason(body), body, extractQuotaLimitValue(body))
    }
    return body as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Shared GET helper for every GBP sub-API with retry support per Google's
 * guidance. Throws `GbpApiError` on terminal failure (after retries exhausted
 * or on a non-retryable error).
 *
 * The retry math (jittered exponential backoff) lives in the shared
 * `withRetry` helper in `@ainyc/canonry-contracts`. The only GBP-specific
 * piece is the `isRetryable` predicate above, which distinguishes a
 * transient rate limit (retryable) from the 0-QPM access-form gate (not).
 *
 * Defaults match Google's documented policy: 5 retries, base 1000ms,
 * jitter on.
 */
export async function gbpFetchGet<T>(url: string, accessToken: string, opts: GbpFetchOptions = {}): Promise<T> {
  return withRetry(() => gbpFetchOnce<T>(url, accessToken, opts), {
    maxRetries: opts.retry?.maxRetries ?? 5,
    baseDelayMs: opts.retry?.baseDelayMs ?? 1000,
    jitter: true,
    isRetryable,
    sleep: opts.retry?.sleep,
  })
}
