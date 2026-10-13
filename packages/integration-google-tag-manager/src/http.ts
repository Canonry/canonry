import { describeFetchError, isRetryableHttpError, retryAfterDelayMs, withRetry } from '@ainyc/canonry-contracts'
import { GTM_REQUEST_TIMEOUT_MS } from './constants.js'
import { GtmApiError } from './types.js'
import type { GtmClientOptions } from './types.js'

interface GoogleErrorPayload {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Array<{
      reason?: string
      '@type'?: string
    }>
  }
}

function safeMessage(body: unknown, status: number, accessToken: string): string {
  const payload = body as GoogleErrorPayload | undefined
  const providerMessage = payload?.error?.message
  const message = typeof providerMessage === 'string' ? providerMessage : `Tag Manager request failed (HTTP ${status})`
  const redacted = accessToken ? message.replaceAll(accessToken, '[redacted]') : message
  return redacted.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}

function providerReason(body: unknown): string | null {
  const payload = body as GoogleErrorPayload | undefined
  for (const detail of payload?.error?.details ?? []) {
    if (typeof detail.reason === 'string') return detail.reason
  }
  return null
}

async function fetchOnce<T>(
  url: string,
  accessToken: string,
  options: GtmClientOptions,
): Promise<T> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GTM_REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(describeFetchError(error, url), { cause: error })
    }
    const text = await response.text()
    let body: unknown = undefined
    let invalidJson = false
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        invalidJson = true
      }
    }

    if (!response.ok) {
      const payload = body as GoogleErrorPayload | undefined
      throw new GtmApiError(safeMessage(body, response.status, accessToken), response.status, {
        providerStatus: payload?.error?.status ?? null,
        reason: providerReason(body),
        retryAfter: response.headers.get('retry-after'),
        requestId: response.headers.get('x-request-id'),
      })
    }
    if (invalidJson) {
      throw new GtmApiError('Tag Manager returned invalid JSON', 502, {
        reason: 'INVALID_PROVIDER_RESPONSE',
        retryAfter: response.headers.get('retry-after'),
        requestId: response.headers.get('x-request-id'),
      })
    }
    return body as T
  } finally {
    clearTimeout(timeout)
  }
}

/** Read-only GET transport with shared retry/backoff and Retry-After support. */
export async function gtmFetchGet<T>(
  url: string,
  accessToken: string,
  options: GtmClientOptions,
): Promise<T> {
  return withRetry(() => fetchOnce<T>(url, accessToken, options), {
    maxRetries: options.retry?.maxRetries ?? 3,
    baseDelayMs: options.retry?.baseDelayMs ?? 1_000,
    jitter: true,
    isRetryable: isRetryableHttpError,
    computeDelayMs: (_attempt, error, defaultMs) => retryAfterDelayMs(error) ?? defaultMs,
    sleep: options.retry?.sleep,
  })
}
