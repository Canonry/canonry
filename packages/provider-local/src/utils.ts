/**
 * Simple exponential backoff retry wrapper.
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
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt)
        console.warn(`[provider] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, err instanceof Error ? err.message : String(err))
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}
