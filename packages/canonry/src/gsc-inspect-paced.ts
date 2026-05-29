import { withRetry, isRetryableHttpError } from '@ainyc/canonry-contracts'
import type { GscUrlInspectionResult } from '@ainyc/canonry-integration-google'

/**
 * Paced, rate-aware driver for GSC URL Inspection loops.
 *
 * The URL Inspection API has a ~1 req/sec soft limit and a 2000/property/day
 * cap. Two callers inspect URLs in a loop (`gsc-inspect-sitemap` walks the
 * whole sitemap; `gsc-sync` inspects the top pages by clicks). Both used to
 * call `inspectUrl` with no retry, so a transient quota response silently
 * marked a URL as failed and polluted the coverage snapshot.
 *
 * Quirk worth knowing: under per-minute quota pressure the endpoint returns a
 * transient 403 (PERMISSION_DENIED-shaped) rather than a 429. We therefore
 * treat 403 as a soft rate signal — retried with backoff — and rely on the
 * consecutive-failure circuit breaker below to bail fast when the property is
 * genuinely inaccessible, so a real auth/property misconfiguration does not
 * burn the daily quota grinding every URL.
 */

/** Base spacing between successive inspections (~1 req/sec soft limit). */
export const INSPECT_BASE_DELAY_MS = 1000
/**
 * Extra random jitter (0..N ms) added to the base spacing so two overlapping
 * inspection runs (e.g. a manual run racing the coverage-refresh chain) do not
 * phase-lock into the same 1-second windows and amplify each other's bursts.
 */
export const INSPECT_PACING_JITTER_MS = 250
/** Per-URL retries for transient rate/server responses (on top of the initial attempt). */
export const INSPECT_MAX_RETRIES = 3
/** Upper bound on a single backoff sleep, so the exponential growth stays sane. */
export const INSPECT_MAX_BACKOFF_MS = 30_000
/**
 * Abort the whole loop after this many consecutive rate/auth-shaped failures.
 * Distinguishes a sustained quota-exhaustion / property-misconfig (every call
 * fails) from scattered per-URL data errors (404s etc.) that should not stop
 * the run. Only retryable (rate/server/network) failures count toward it; a
 * success resets it.
 */
export const INSPECT_FAILFAST_THRESHOLD = 5

/**
 * Retry predicate for a single inspection call. Retries everything
 * `isRetryableHttpError` already covers (429, 5xx, network errors) plus the
 * endpoint's quota-as-403 behavior. Genuine 401 (token) and 400 (bad URL)
 * stay non-retryable.
 */
export function isRetryableGscInspectError(err: unknown): boolean {
  if (err != null && typeof err === 'object' && 'status' in err) {
    if ((err as { status: unknown }).status === 403) return true
  }
  return isRetryableHttpError(err)
}

export interface PacedInspectLogger {
  info: (action: string, ctx?: Record<string, unknown>) => void
  error: (action: string, ctx?: Record<string, unknown>) => void
}

export interface PacedInspectCallbacks {
  /** Perform one inspection (caller binds accessToken + propertyId). */
  inspectOne: (url: string) => Promise<GscUrlInspectionResult>
  /** Persist a successful inspection. `index` is 0-based into the input list. */
  onResult: (url: string, result: GscUrlInspectionResult, index: number) => void
  /** Record a per-URL failure (after retries were exhausted). */
  onError: (url: string, err: unknown, index: number) => void
}

export interface PacedInspectDeps {
  /** Sleep implementation — injected in tests so pacing/backoff are instant. */
  sleep?: (ms: number) => Promise<void>
  /** Returns 0..1 for the pacing jitter — injected in tests for determinism. */
  jitter?: () => number
  log?: PacedInspectLogger
}

export interface PacedInspectOutcome {
  inspected: number
  errors: number
  /** True when the circuit breaker tripped before exhausting the URL list. */
  aborted: boolean
  /** The error that tripped the breaker, when `aborted`. */
  abortError?: unknown
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Inspect `urls` one at a time, pacing to stay under the soft rate limit,
 * retrying transient rate/server responses with jittered exponential backoff,
 * and stopping early via a consecutive-failure circuit breaker. The caller
 * owns persistence (via `onResult` / `onError`) and decides what an `aborted`
 * outcome means for its run status.
 */
export async function inspectUrlsPaced(
  urls: string[],
  cb: PacedInspectCallbacks,
  deps: PacedInspectDeps = {},
): Promise<PacedInspectOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const jitter = deps.jitter ?? Math.random

  let inspected = 0
  let errors = 0
  let consecutiveRetryableFailures = 0

  for (let index = 0; index < urls.length; index++) {
    const url = urls[index]!
    try {
      const result = await withRetry(() => cb.inspectOne(url), {
        maxRetries: INSPECT_MAX_RETRIES,
        baseDelayMs: INSPECT_BASE_DELAY_MS,
        maxDelayMs: INSPECT_MAX_BACKOFF_MS,
        isRetryable: isRetryableGscInspectError,
        sleep,
        onRetry: ({ attempt, delayMs, err }) =>
          deps.log?.info('inspect.retry', {
            url,
            attempt,
            delayMs: Math.round(delayMs),
            error: err instanceof Error ? err.message : String(err),
          }),
      })
      cb.onResult(url, result, index)
      inspected++
      consecutiveRetryableFailures = 0
    } catch (err) {
      errors++
      cb.onError(url, err, index)
      // Only rate/server/network-shaped failures advance the breaker — a
      // non-retryable per-URL error (bad URL, 404) is a data issue, not a
      // signal that the whole property is throttled or inaccessible.
      if (isRetryableGscInspectError(err)) {
        consecutiveRetryableFailures++
        if (consecutiveRetryableFailures >= INSPECT_FAILFAST_THRESHOLD) {
          deps.log?.error('inspect.circuit-break', {
            consecutiveFailures: consecutiveRetryableFailures,
            inspected,
            errors,
            remaining: urls.length - index - 1,
          })
          return { inspected, errors, aborted: true, abortError: err }
        }
      }
    }

    // Pace the next call. Failures already slept through their backoff inside
    // withRetry; this base spacing keeps the steady-state rate under the limit.
    if (index < urls.length - 1) {
      await sleep(INSPECT_BASE_DELAY_MS + jitter() * INSPECT_PACING_JITTER_MS)
    }
  }

  return { inspected, errors, aborted: false }
}
