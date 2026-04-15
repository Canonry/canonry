/**
 * Check whether an error is retryable. Client errors (4xx except 429) are
 * not retryable — they indicate a problem with the request itself (bad auth,
 * invalid parameters, not found, etc.) that won't resolve by repeating it.
 * Server errors (5xx), rate limits (429), and connection failures are retryable.
 */
function isRetryableError(err: unknown): boolean {
  if (err != null && typeof err === 'object' && 'status' in err) {
    // Anthropic SDK throws error objects with a `status` property.
    // Docs: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/error.ts
    const status = (err as { status: number }).status
    if (typeof status === 'number') {
      // 429 (rate limit) is retryable; other 4xx are not.
      // 5xx and network errors (status undefined/0) are retryable.
      return status >= 500 || status === 429
    }
  }

  // Handle SDK-specific error types that might not have a `status` field
  // or use different names for it.
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // Always retry network/connection-level failures
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('econnrefused') ||
      msg.includes('network error')
    ) {
      return true
    }
  }
  // No status code — likely a network/connection error, which is retryable.
  return true
}

/**
 * Simple exponential backoff retry wrapper.
 * Skips retries for non-retryable errors (4xx client errors except 429).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelay?: number } = {},
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000 } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err
      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = initialDelay * Math.pow(2, attempt)
        console.warn(`[provider] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, err instanceof Error ? err.message : String(err))
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        throw err
      }
    }
  }

  throw lastError
}
