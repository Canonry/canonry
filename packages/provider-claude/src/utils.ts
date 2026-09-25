import { withRetry as sharedWithRetry, isRetryableHttpError, describeError } from '@ainyc/canonry-contracts'

/**
 * Provider-flavored `withRetry` — pre-binds the shared retry helper (in
 * `@ainyc/canonry-contracts`) with the predicate every API provider uses:
 * retry 429s and 5xxs, plus network-level errors (`fetch failed`,
 * `ECONNRESET`, etc.). Logs each retry to stderr for debugging.
 *
 * The Anthropic SDK throws error objects with a `status` property;
 * `isRetryableHttpError` keys on that.
 * Docs: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/error.ts
 *
 * `isRetryable` narrows what is retried (a batch submit may only retry a
 * definite rejection), and `computeDelayMs` overrides the backoff (to honour
 * `Retry-After`). Both default to the behaviour every sync call has today.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    initialDelay?: number
    isRetryable?: (err: unknown) => boolean
    computeDelayMs?: (attempt: number, err: unknown, defaultMs: number) => number
  } = {},
): Promise<T> {
  return sharedWithRetry(fn, {
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.initialDelay ?? 1000,
    // Jitter off preserves the historical deterministic backoff that every
    // provider has shipped to date (1000, 2000, 4000ms). Enable per-caller
    // if you need it.
    jitter: false,
    isRetryable: options.isRetryable ?? isRetryableHttpError,
    computeDelayMs: options.computeDelayMs,
    onRetry: ({ attempt, err, delayMs }) => {
      console.warn(
        `[provider] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`,
        describeError(err),
      )
    },
  })
}
