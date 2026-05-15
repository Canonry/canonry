import { GBP_REQUEST_TIMEOUT_MS } from './constants.js'
import { GbpApiError } from './types.js'
import type { GbpFetchOptions } from './types.js'

interface GoogleErrorPayload {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Array<{ reason?: string }>
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

/**
 * Shared GET helper for every GBP sub-API. Throws `GbpApiError` on non-2xx,
 * mapping the structured `reason` field so callers can distinguish quota
 * exhaustion from scope problems, API-not-enabled, etc.
 */
export async function gbpFetchGet<T>(url: string, accessToken: string, opts: GbpFetchOptions = {}): Promise<T> {
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
      throw new GbpApiError(message, res.status, extractReason(body), body)
    }
    return body as T
  } finally {
    clearTimeout(timeout)
  }
}
