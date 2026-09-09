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
 * Read a `Retry-After` off an error and turn it into a delay in ms.
 *
 * When a rate limiter says how long to wait, that instruction beats our own
 * exponential guess — backing off 1s against a limiter asking for 60 just
 * burns the remaining attempts. Accepts both wire forms: delta-seconds
 * (`Retry-After: 30`) and an HTTP date (`Retry-After: Wed, 21 Oct 2026 …`).
 *
 * Returns `null` when the error carries no usable value, so callers can fall
 * through to `backoffDelayMs`. Pass it straight to `withRetry`:
 *
 * ```ts
 * computeDelayMs: (_attempt, err, defaultMs) => retryAfterDelayMs(err) ?? defaultMs
 * ```
 *
 * A past or unparseable date yields `0` and `null` respectively — never a
 * negative delay.
 */
export function retryAfterDelayMs(err: unknown, now: number = Date.now()): number | null {
  if (err == null || typeof err !== 'object') return null
  const record = err as Record<string, unknown>
  // Provider SDKs expose response headers instead of a top-level retryAfter.
  const headers = record.headers
  const header = typeof Headers !== 'undefined' && headers instanceof Headers
    ? headers.get('retry-after')
    : headers && typeof headers === 'object'
      ? (headers as Record<string, unknown>)['retry-after'] ?? (headers as Record<string, unknown>)['Retry-After']
      : undefined
  const raw = record.retryAfter ?? record['retry-after'] ?? header

  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, raw * 1000) : null
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed === '') return null

  // Delta-seconds is the common form, so try it first. A bare integer is never
  // a valid HTTP date, so there is no ambiguity between the two.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/**
 * Textual markers a service uses to say "you are going too fast", in the
 * lowercased error message. Deliberately narrow: each names rate limiting
 * specifically, so none of them can match an ordinary validation message.
 */
const RATE_LIMIT_MARKERS = [
  'throttle', // Bing Webmaster Tools: ThrottleHost / ThrottleUser
  'rate limit',
  'ratelimit',
  'too many requests',
  'quota exceeded',
  'quotaexceeded',
  'over quota',
  'slow down',
] as const

/**
 * True when `err` is a service telling us we are going too fast.
 *
 * **Rate limiting does not always arrive as HTTP 429.** Several APIs answer
 * with a 4xx — or even a 200 — and put the condition in the payload, so a
 * status-code check alone silently classifies a throttle as a permanent client
 * error and gives up. Bing Webmaster Tools is the case that motivated this: it
 * returns `400` with `{"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}`, which
 * `isRetryableHttpError` used to treat as "bad request, never retry", so a
 * refresh burst failed outright instead of backing off.
 *
 * So the test is semantic, not positional. In order:
 *
 *   1. an explicit `retryAfter` / `Retry-After` on the error — only a rate
 *      limiter sends one;
 *   2. HTTP 429;
 *   3. a documented throttle marker in the message, whatever the status.
 *
 * A service that signals throttling only through a private numeric code should
 * put that code's meaning into the error message (or set `retryAfter`) so this
 * can see it — see `BingApiError` for the pattern.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err != null && typeof err === 'object') {
    const record = err as Record<string, unknown>

    const retryAfter = record.retryAfter ?? record['retry-after']
    if (typeof retryAfter === 'number' || typeof retryAfter === 'string') return true

    if (typeof record.status === 'number' && record.status === 429) return true
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return RATE_LIMIT_MARKERS.some((marker) => msg.includes(marker))
  }

  return false
}

/**
 * Default `isRetryable` predicate for HTTP/SDK errors:
 *
 *   - Retry: rate limiting in any of the forms `isRateLimitError` recognizes
 *     (429, a `Retry-After`, or a throttle marker on any status), 5xx
 *     (server), and network-level errors that show up as plain `Error`
 *     instances with no `.status` field.
 *   - Don't retry: other 4xx — bad auth, scope, validation, or not-found
 *     don't get better with a retry.
 *
 * The network-error detection looks at lowercased message text for the
 * standard Node failure tokens (`fetch failed`, `econnreset`, `etimedout`,
 * `enotfound`, `econnrefused`, `network error`).
 */
export function isRetryableHttpError(err: unknown): boolean {
  // Checked before the status code, because a throttle can arrive wearing a
  // status this function would otherwise reject outright.
  if (isRateLimitError(err)) return true

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
