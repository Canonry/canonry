import { SENTIMENT_MODEL, isRetryableHttpError, retryAfterDelayMs, withRetry } from '@ainyc/canonry-contracts'
import type { SentimentUsage } from '@ainyc/canonry-contracts'

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = SENTIMENT_MODEL

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}
export interface JevRequest {
  model: string
  state: unknown
  questions: Record<string, JevChoiceQuestion>
}
export interface JevError {
  code: string
  message: string
  retryable: boolean
  retryAfterMs: number | null
}
export type JevResult = {
  ok: true
  returnedModel: string
  answers: Record<string, unknown>
  usage: SentimentUsage
} | {
  ok: false
  returnedModel: string | null
  error: JevError
  usage: SentimentUsage
}
export interface JevClientOptions {
  apiKey: string
  /** Inject transport below the fixed production URL; never exposed in user configuration. */
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function usageFrom(value: unknown): SentimentUsage {
  const usage = record(record(value)?.usage)
  const input = usage?.input_tokens
  const output = usage?.output_tokens
  if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 &&
      typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
    return { kind: 'reported', inputTokens: input, outputTokens: output }
  }
  return { kind: 'unknown', inputTokens: null, outputTokens: null }
}

function failure(code: string, message: string, retryable = false, retryAfterMs: number | null = null, usage: SentimentUsage = usageFrom(null), returnedModel: string | null = null): JevResult {
  return { ok: false, returnedModel, error: { code, message, retryable, retryAfterMs }, usage }
}

async function fetchOnce(request: JevRequest, options: JevClientOptions): Promise<JevResult> {
  if (options.signal?.aborted) return failure('canceled', 'Classification was canceled before dispatch.')
  if (!options.apiKey.trim()) return failure('credential-missing', 'TypeSafe credentials are unavailable.')
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    return failure('invalid-timeout', 'TypeSafe timeout must be between 1 and 120000 milliseconds.')
  }
  const controller = new AbortController()
  const timeout = { expired: false }
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timeout.expired = true; controller.abort() }, timeoutMs)
  try {
    const response = await (options.fetch ?? fetch)(TYPESAFE_URL, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: controller.signal,
    })
    let body: unknown
    try { body = await response.json() } catch {
      if (controller.signal.aborted) throw new Error('Request aborted')
      body = null
    }
    const usage = usageFrom(body)
    if (!response.ok) {
      const statusError = { status: response.status, ...(response.status === 429 || response.status >= 500 ? { retryAfter: response.headers.get('retry-after') ?? undefined } : {}) }
      const retryable = isRetryableHttpError(statusError)
      const code = response.status === 401 || response.status === 403 ? 'provider-authorization'
        : response.status === 413 ? 'provider-context-limit'
          : response.status === 429 ? 'provider-rate-limit'
            : retryable ? 'provider-unavailable' : 'provider-rejected'
      return failure(code, `TypeSafe returned HTTP ${response.status}.`, retryable, retryAfterDelayMs(statusError), usage)
    }
    const parsed = record(body)
    const model = typeof parsed?.model === 'string' ? parsed.model : null
    if (model !== null && model !== request.model) {
      return failure('model-mismatch', 'TypeSafe returned a different evaluator model.', false, null, usage, model)
    }
    const answers = record(parsed?.answers)
    if (!model || !answers || usage.kind !== 'reported') {
      return failure('response-contract', 'TypeSafe returned an incomplete evaluation response.', false, null, usage, model)
    }
    return { ok: true, returnedModel: model, answers, usage }
  } catch {
    if (options.signal?.aborted) return failure('canceled', 'Classification was canceled during dispatch.')
    if (timeout.expired) return failure('provider-timeout', 'TypeSafe request timed out; billed usage is unknown.', true)
    return failure('provider-network', 'TypeSafe request failed; billed usage is unknown.', isRetryableHttpError(new Error('network error')))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}

/** One dispatch per call. Persisted worker scheduling owns the total retry budget and Retry-After delay. */
export function requestJev(request: JevRequest, options: JevClientOptions): Promise<JevResult> {
  return withRetry(() => fetchOnce(request, options), {
    maxRetries: 0,
    isRetryable: isRetryableHttpError,
    computeDelayMs: (_attempt, error, defaultMs) => retryAfterDelayMs(error) ?? defaultMs,
  })
}
