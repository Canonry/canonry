import { withRetry as sharedWithRetry, isRetryableHttpError, describeError } from '@ainyc/canonry-contracts'

/**
 * Longest wait honored from a Gemini `RetryInfo.retryDelay`. A per-minute
 * limit asks for under a minute; anything longer is not worth holding a sweep
 * slot for, so the error surfaces instead.
 */
export const GEMINI_MAX_RATE_LIMIT_WAIT_MS = 65_000

/**
 * The wait Gemini asked for on a 429, in ms, or `null` when it gave none.
 *
 * The Google Gen AI SDK puts the whole JSON error body in `ApiError.message`,
 * and a rate-limited body carries a `google.rpc.RetryInfo` detail such as
 * `"retryDelay": "37s"`. The free tier's per-minute limits ask for 30-60s,
 * far past the 1/2/4s exponential backoff, so ignoring it burned every retry.
 */
export function geminiRetryDelayMs(err: unknown): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(describeError(err))
  return match ? Math.round(Number(match[1]) * 1000) : null
}

/**
 * A 429 for a daily quota (`quotaId` like `GenerateRequestsPerDay…`). Waiting
 * cannot help until the quota resets, so it is not retried.
 */
export function isGeminiDailyQuotaError(err: unknown): boolean {
  return /"quotaId"\s*:\s*"[^"]*PerDay/i.test(describeError(err))
}

export function isGeminiRetryable(err: unknown): boolean {
  if (!isRetryableHttpError(err) || isGeminiDailyQuotaError(err)) return false
  const asked = geminiRetryDelayMs(err)
  return asked === null || asked <= GEMINI_MAX_RATE_LIMIT_WAIT_MS
}

/**
 * Provider-flavored `withRetry` — pre-binds the shared retry helper (in
 * `@ainyc/canonry-contracts`) with the predicate every API provider uses:
 * retry 429s and 5xxs, plus network-level errors (`fetch failed`,
 * `ECONNRESET`, etc.). Logs each retry to stderr for debugging.
 *
 * On a 429 it waits the `retryDelay` Gemini asked for (plus a small margin)
 * instead of the exponential default, and does not retry a daily quota.
 *
 * The Google AI SDK throws error objects with a `status` property;
 * `isRetryableHttpError` keys on that.
 * Docs: https://github.com/google-gemini/generative-ai-js/blob/main/src/errors.ts
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelay?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  return sharedWithRetry(fn, {
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.initialDelay ?? 1000,
    // Jitter off preserves the historical deterministic backoff that every
    // provider has shipped to date (1000, 2000, 4000ms). Enable per-caller
    // if you need it.
    jitter: false,
    isRetryable: isGeminiRetryable,
    computeDelayMs: (_attempt, err, defaultMs) => {
      const asked = geminiRetryDelayMs(err)
      return asked === null ? defaultMs : asked + 500
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    onRetry: ({ attempt, err, delayMs }) => {
      console.warn(
        `[provider] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`,
        describeError(err),
      )
    },
  })
}
