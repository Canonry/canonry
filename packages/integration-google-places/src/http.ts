import { withRetry } from '@ainyc/canonry-contracts'
import { PLACES_REQUEST_TIMEOUT_MS } from './constants.js'
import { PlacesApiError } from './types.js'
import type { PlacesFetchOptions } from './types.js'

interface GoogleErrorPayload {
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

/** The `error.status` enum string (e.g. `INVALID_ARGUMENT`, `NOT_FOUND`). */
function extractReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const status = (body as GoogleErrorPayload).error?.status
  return typeof status === 'string' ? status : null
}

/**
 * Only transient errors are worth retrying: 429 (RESOURCE_EXHAUSTED — rate
 * limit) and 503 (UNAVAILABLE). 400/401/403/404 are terminal — a retry just
 * re-fails (bad field mask, unauthorized key, stale place id).
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof PlacesApiError)) return false
  return err.status === 429 || err.status === 503
}

async function placesFetchOnce<T>(url: string, apiKey: string, fieldMask: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PLACES_REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
      accept: 'application/json',
    }
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    const text = await res.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : undefined } catch { body = text }

    if (!res.ok) {
      // `body` can be null here (a non-OK response whose body is literally
      // `null`), so the optional chain below is load-bearing, not decorative.
      const payload = body as GoogleErrorPayload | string | null | undefined
      const message = typeof payload === 'object' && payload?.error?.message
        ? payload.error.message
        : typeof payload === 'string'
          ? payload
          : `HTTP ${res.status}`
      throw new PlacesApiError(message, res.status, extractReason(body), body)
    }
    return body as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Shared GET helper for the Places API. Auth is the API key (`X-Goog-Api-Key`)
 * and the field mask (`X-Goog-FieldMask`) — no OAuth. Throws `PlacesApiError`
 * on terminal failure. Retry math (jittered exponential backoff) is the shared
 * `withRetry` from contracts; only the `isRetryable` predicate is Places-specific.
 */
export async function placesFetchGet<T>(
  url: string,
  apiKey: string,
  fieldMask: string,
  opts: PlacesFetchOptions = {},
): Promise<T> {
  return withRetry(() => placesFetchOnce<T>(url, apiKey, fieldMask), {
    maxRetries: opts.retry?.maxRetries ?? 3,
    baseDelayMs: opts.retry?.baseDelayMs ?? 500,
    jitter: true,
    isRetryable,
    sleep: opts.retry?.sleep,
  })
}
