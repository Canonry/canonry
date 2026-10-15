import { withRetry, isRetryableHttpError, describeError } from '@canonry/canonry-contracts'
import { sharedRateGate } from './inspect-rate-gate.js'

/**
 * Paced, rate-aware driver for GSC URL Inspection loops.
 *
 * Google documents two per-site limits for URL Inspection: **2000 QPD** and
 * **600 QPM** (https://developers.google.com/webmaster-tools/limits). We pace
 * well under the per-minute figure — see the constants below for why. Two callers inspect URLs in a loop (`gsc-inspect-sitemap` walks the
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

/**
 * Minimum spacing between successive request STARTS, across all workers.
 *
 * This is a rate control: one start per second is at most 60 QPM, an order of
 * magnitude under Google's documented 600 QPM. It is deliberately conservative
 * — the endpoint signals per-minute pressure with a transient 403 rather than
 * a 429 (see the retry predicate below), so the ceiling is not something we
 * want to probe in production.
 *
 * It is NOT a concurrency control. The two were conflated: because the loop was
 * serial, the effective rate was bounded by Google's own per-call latency
 * (~6.3s for a live index lookup) rather than by this spacing, so a site paid
 * ~7.4s per URL and got ~9.5 QPM — six times slower than this constant allows.
 * `INSPECT_MAX_CONCURRENCY` lifts that accidental cap while this figure keeps
 * the rate posture exactly where it was.
 */
export const INSPECT_BASE_DELAY_MS = 1000

/**
 * How many inspections may be in flight at once.
 *
 * Bounded by hand rather than derived from the documented QPM: reports from
 * practitioners put the safe operating point around 5-10 concurrent, with
 * throttling appearing well before the documented ceiling. 5 is the bottom of
 * that range — roughly a 5x throughput gain over the serial loop, with the
 * request rate still capped by `INSPECT_BASE_DELAY_MS` and the circuit breaker
 * still watching for sustained failure.
 *
 * Raise this only with measurement. The daily 2000 QPD cap is unaffected by
 * concurrency, so it buys wall-clock on mid-sized sites and nothing at all on
 * sites past the quota — those need derived coverage, not more parallelism.
 */
export const INSPECT_MAX_CONCURRENCY = 5

/**
 * Google's per-site daily cap on URL Inspection calls.
 *
 * A hard wall that concurrency does not move: 2000 requests per property per
 * day, on a sliding 24-hour window rather than a midnight reset.
 */
export const INSPECT_DAILY_QUOTA = 2000

/**
 * The most URLs one sweep will attempt.
 *
 * Below the quota on purpose. A sweep is not the only consumer — scheduled
 * refreshes, a second sweep later in the day, and manual inspections all draw
 * on the same 2000 — so a single run taking the entire allowance would starve
 * everything else and leave nothing for the rest of the day.
 *
 * Beyond this a sweep cannot finish regardless: at ~7.1s per URL it would run
 * for hours, exhaust the quota partway, and trip the consecutive-failure
 * breaker — reporting a failure that is really a budget being spent. Capping
 * and saying so is more honest than starting work that cannot complete.
 */
export const INSPECT_SWEEP_MAX_URLS = 1500
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
 *
 * "Consecutive" means consecutive in COMPLETION order. With more than one
 * request in flight a success can land before failures that started earlier, so
 * the run length is not a pure property of the input — it is a live signal that
 * the property is failing right now, which is what the breaker is for. Tests
 * asserting an exact run length must pin `concurrency: 1`.
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

export interface PacedInspectCallbacks<TResult> {
  /** Perform one inspection (caller binds accessToken + propertyId). */
  inspectOne: (url: string) => Promise<TResult>
  /** Persist a successful inspection. `index` is 0-based into the input list. */
  onResult: (url: string, result: TResult, index: number) => void
  /** Record a per-URL failure (after retries were exhausted). */
  onError: (url: string, err: unknown, index: number) => void
}

export interface PacedInspectDeps {
  /** Sleep implementation — injected in tests so pacing/backoff are instant. */
  sleep?: (ms: number) => Promise<void>
  /** Returns 0..1 for the pacing jitter — injected in tests for determinism. */
  jitter?: () => number
  /**
   * Requests in flight at once. Defaults to `INSPECT_MAX_CONCURRENCY`; clamped
   * to at least 1, so `1` restores the old strictly-serial behaviour.
   */
  concurrency?: number
  /**
   * Which failures count as transient. Defaults to the GSC predicate, which
   * treats the endpoint's quota-as-403 as a rate signal.
   *
   * Injectable because the predicate decides TWO things: what gets retried, and
   * what advances the circuit breaker. A caller whose service signals throttling
   * differently — Bing answers `400` with `ErrorCode 5` — would otherwise never
   * trip the breaker, and would grind through a whole sitemap against a wall.
   */
  isRetryable?: (err: unknown) => boolean
  /**
   * Names the upstream limit this sweep draws on, so concurrent sweeps sharing
   * that limit queue behind ONE clock (see `inspect-rate-gate.ts`). REQUIRED,
   * and it must name the shared resource rather than the caller: an
   * independently-keyed sweep silently multiplies the rate on a shared
   * credential by the number of sweeps running.
   */
  rateGateKey: string
  /**
   * Minimum spacing between request STARTS. Defaults to
   * `INSPECT_BASE_DELAY_MS`; a service that throttles harder than Google needs
   * its own figure rather than inheriting the GSC one.
   */
  spacingMs?: number
  /**
   * Per-URL retries at THIS layer. Defaults to `INSPECT_MAX_RETRIES`.
   *
   * Pass 0 when the caller's own HTTP client already retries. Two retry layers
   * multiply rather than add: Bing's client retries 4 times inside a driver
   * that retried 3 more, so one throttled URL cost 5 x 4 = 20 requests and the
   * breaker's five-failure budget spent 100 requests to inspect nothing.
   */
  maxRetries?: number
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
 * Inspect `urls` with a bounded number in flight, a globally paced request
 * rate, per-URL retry with jittered exponential backoff, and a
 * consecutive-failure circuit breaker. The caller owns persistence (via
 * `onResult` / `onError`) and decides what an `aborted` outcome means for its
 * run status.
 *
 * Rate and concurrency are separate controls here, which is the fix: every
 * worker takes its start slot from one shared clock, so the request rate is
 * identical to the old serial loop's no matter how many workers run. What
 * changes is that Google's ~6.3s per-call latency is now overlapped instead of
 * serialised.
 *
 * `onResult` / `onError` may fire OUT OF ORDER — each carries the URL's
 * original index so a caller can still report position. Callers that only
 * persist rows are unaffected; a caller rendering sequential progress should
 * expect gaps.
 */
export async function inspectUrlsPaced<TResult>(
  urls: string[],
  cb: PacedInspectCallbacks<TResult>,
  // Required, not defaulted: `rateGateKey` has no safe default, and a sweep
  // that silently picked one would be back to pacing only itself.
  deps: PacedInspectDeps,
): Promise<PacedInspectOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const jitter = deps.jitter ?? Math.random
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? INSPECT_MAX_CONCURRENCY, urls.length || 1))
  const isRetryable = deps.isRetryable ?? isRetryableGscInspectError
  const spacingMs = deps.spacingMs ?? INSPECT_BASE_DELAY_MS
  const maxRetries = deps.maxRetries ?? INSPECT_MAX_RETRIES

  let inspected = 0
  let errors = 0
  let consecutiveRetryableFailures = 0
  let nextIndex = 0
  let aborted = false
  let abortError: unknown

  // One gate for this pool AND for every other sweep on the same upstream
  // limit. Serialising only the WAIT (not the request) keeps the rate at one
  // start per `spacingMs` while allowing `concurrency` requests in flight.
  const gate = sharedRateGate(deps.rateGateKey)
  const takeRateSlot = (): Promise<void> => gate.take(spacingMs + jitter() * INSPECT_PACING_JITTER_MS, sleep)

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) return
      const index = nextIndex++
      if (index >= urls.length) return
      const url = urls[index]!

      // EVERY start waits its turn, including the first. Exempting index 0 was
      // safe while the gate was per-call, but under a shared gate it would let
      // each concurrent sweep fire one ungated request the instant it began —
      // reproducing, at run granularity, exactly the opening burst the gate
      // exists to prevent.
      await takeRateSlot()
      if (aborted) return

      try {
      // Retries take a rate slot too. The gate used to cover only fresh-URL
      // starts, so a throttled sweep's retry traffic — the overwhelming
      // majority of its requests once things go wrong — bypassed rate control
      // entirely and hammered the limit that was already refusing it.
      let attempt = 0
      const result = await withRetry(async () => {
        if (attempt++ > 0) await takeRateSlot()
        return cb.inspectOne(url)
      }, {
        maxRetries,
        baseDelayMs: spacingMs,
        maxDelayMs: INSPECT_MAX_BACKOFF_MS,
        isRetryable,
        sleep,
        onRetry: ({ attempt, delayMs, err }) =>
          deps.log?.info('inspect.retry', {
            url,
            attempt,
            delayMs: Math.round(delayMs),
            error: describeError(err),
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
        if (isRetryable(err)) {
          consecutiveRetryableFailures++
          if (consecutiveRetryableFailures >= INSPECT_FAILFAST_THRESHOLD) {
            deps.log?.error('inspect.circuit-break', {
              consecutiveFailures: consecutiveRetryableFailures,
              inspected,
              errors,
              remaining: urls.length - nextIndex,
            })
            // Shared flag rather than an early return: the sibling workers must
            // stop claiming work too, and their in-flight calls are awaited
            // below so nothing is orphaned.
            aborted = true
            abortError = err
            return
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  return aborted ? { inspected, errors, aborted: true, abortError } : { inspected, errors, aborted: false }
}
