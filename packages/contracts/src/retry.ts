/**
 * Generic retry / backoff helpers used across providers, integrations, and
 * the API surface. Two pieces:
 *
 *   - `backoffDelayMs(attempt, opts)` — pure delay calculator. Implements
 *     Google's documented exponential-backoff-with-jitter formula by default:
 *     `sleep = random() * baseDelayMs * 2^attempt`. Toggle jitter off, set
 *     a `maxDelayMs` clamp, or override the base — all knobs callers care
 *     about live here.
 *
 *   - `withRetry(fn, opts)` — wraps any async call with retry semantics.
 *     Callers supply an `isRetryable` predicate (defaults to "retry
 *     everything"), an optional `computeDelayMs` to honor server-supplied
 *     `Retry-After` headers, and an `onRetry` hook for logging.
 *
 * Why one helper? Without it, every provider / integration package grows its
 * own near-identical `withRetry` over time (we had five of them before
 * extracting this), each with subtle differences — `Math.pow(2, attempt)`
 * without jitter, no max-delay clamp, no `Retry-After` override, divergent
 * logging. Centralizing the math + control flow lets domain-specific code
 * focus on the only thing that genuinely differs: "which errors are
 * retryable for THIS service?"
 *
 * Reference: https://developers.google.com/my-business/content/limits
 */

export interface BackoffOptions {
  /** Base delay (ms). Default 1000 — Google's documented 1.0s. */
  baseDelayMs?: number
  /**
   * Add uniform random jitter scaled to the computed delay (default true).
   * `random() * baseDelayMs * 2^attempt`, matching Google's
   * `random.uniform(0, base_delay * (2 ** attempt))`.
   */
  jitter?: boolean
  /** Cap on the returned delay. Default unbounded. */
  maxDelayMs?: number
}

const DEFAULT_BASE_DELAY_MS = 1000

/**
 * Compute the exponential backoff delay for `attempt` (0-indexed). With
 * jitter: `random() * baseDelayMs * 2^attempt`. Without: `baseDelayMs * 2^attempt`.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const jitter = opts.jitter ?? true
  const raw = base * Math.pow(2, attempt)
  const delay = jitter ? Math.random() * raw : raw
  return opts.maxDelayMs !== undefined ? Math.min(opts.maxDelayMs, delay) : delay
}

export interface RetryOptions extends BackoffOptions {
  /** Maximum retries (not counting the initial attempt). Default 3. */
  maxRetries?: number
  /**
   * Returns true if `err` is worth retrying. Default: retry every error.
   * Domain-specific code (e.g. `isRetryableHttpError`) belongs here.
   */
  isRetryable?: (err: unknown) => boolean
  /**
   * Override the per-attempt delay. Defaults to the computed exponential
   * backoff; callers can override (e.g. honor a `Retry-After` header by
   * returning `seconds * 1000`).
   */
  computeDelayMs?: (attempt: number, err: unknown, defaultMs: number) => number
  /** Fired before each sleep. Useful for logging retry attempts. */
  onRetry?: (info: { attempt: number; err: unknown; delayMs: number }) => void
  /** Sleep implementation. Default `setTimeout`. Inject for tests. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_RETRIES = 3

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Generic exponential-backoff retry wrapper. The function `fn` is invoked
 * up to `maxRetries + 1` times; between attempts, `withRetry` sleeps for
 * `computeDelayMs(attempt) ?? backoffDelayMs(attempt)` ms. Caller decides
 * which errors are retryable via `isRetryable`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const isRetryable = opts.isRetryable ?? (() => true)
  const sleep = opts.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt >= maxRetries || !isRetryable(err)) throw err
      const defaultMs = backoffDelayMs(attempt, opts)
      const delayMs = opts.computeDelayMs?.(attempt, err, defaultMs) ?? defaultMs
      opts.onRetry?.({ attempt, err, delayMs })
      await sleep(delayMs)
    }
  }
  // Unreachable in practice — the loop either returns or throws.
  throw lastErr
}

/**
 * Default `isRetryable` predicate for HTTP/SDK errors:
 *
 *   - Retry: 429 (rate limit), 5xx (server), and network-level errors that
 *     show up as plain `Error` instances with no `.status` field.
 *   - Don't retry: 4xx other than 429 — bad auth, scope, validation, or
 *     not-found don't get better with a retry.
 *
 * The network-error detection looks at lowercased message text for the
 * standard Node failure tokens (`fetch failed`, `econnreset`, `etimedout`,
 * `enotfound`, `econnrefused`, `network error`).
 */
export function isRetryableHttpError(err: unknown): boolean {
  if (err != null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') {
      return status >= 500 || status === 429
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
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
  // No (numeric) status field → likely a network/connection error.
  return true
}
