import { withRetry as sharedWithRetry, isRetryableHttpError } from '@ainyc/canonry-contracts'

/**
 * Provider-flavored `withRetry` — pre-binds the shared retry helper (in
 * `@ainyc/canonry-contracts`) with the predicate every API provider uses:
 * retry 429s and 5xxs, plus network-level errors (`fetch failed`,
 * `ECONNRESET`, etc.). Logs each retry to stderr for debugging.
 *
 * The OpenAI SDK (which Perplexity and Local also use) throws error objects
 * with a `status` property; `isRetryableHttpError` keys on that.
 * Docs: https://github.com/openai/openai-node/blob/master/src/error.ts
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelay?: number } = {},
): Promise<T> {
  return sharedWithRetry(fn, {
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.initialDelay ?? 1000,
    // Jitter off preserves the historical deterministic backoff that every
    // provider has shipped to date (1000, 2000, 4000ms). Enable per-caller
    // if you need it.
    jitter: false,
    isRetryable: isRetryableHttpError,
    onRetry: ({ attempt, err, delayMs }) => {
      console.warn(
        `[provider] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`,
        err instanceof Error ? err.message : String(err),
      )
    },
  })
}
