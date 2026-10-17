import { describe, it, expect } from 'vitest'
import type { GscUrlInspectionResult } from '@canonry/canonry-integration-google'
import {
  inspectUrlsPaced,
  isRetryableGscInspectError,
  INSPECT_MAX_RETRIES,
  INSPECT_FAILFAST_THRESHOLD,
  INSPECT_BASE_DELAY_MS,
  INSPECT_MAX_CONCURRENCY,
  INSPECT_SWEEP_MAX_URLS,
  INSPECT_DAILY_QUOTA,
  type PacedInspectDeps,
} from '../src/gsc-inspect-paced.js'

/** A throwable carrying a numeric `.status`, like `GoogleApiError`. */
function statusErr(status: number): Error & { status: number } {
  const e = new Error(`status ${status}`) as Error & { status: number }
  e.status = status
  return e
}

const FAKE_RESULT = {} as GscUrlInspectionResult

/** Deterministic, instant deps: no real sleeping, no jitter. */
let gateSeq = 0
function fastDeps(extra: Partial<PacedInspectDeps> = {}): PacedInspectDeps & { sleeps: number[] } {
  const sleeps: number[] = []
  return {
    sleeps,
    // A key unique per call, so these tests measure ONE sweep's pacing without
    // queueing behind a sibling test's gate. Cross-sweep behaviour is covered
    // in inspect-rate-gate.test.ts, which shares a key on purpose.
    rateGateKey: `test-gate-${gateSeq++}`,
    jitter: () => 0,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    ...extra,
  }
}

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://example.com/p${i}`)
}

describe('isRetryableGscInspectError', () => {
  it('retries the endpoint quota-as-403 response', () => {
    expect(isRetryableGscInspectError(statusErr(403))).toBe(true)
  })

  it('retries 429 and 5xx', () => {
    expect(isRetryableGscInspectError(statusErr(429))).toBe(true)
    expect(isRetryableGscInspectError(statusErr(500))).toBe(true)
    expect(isRetryableGscInspectError(statusErr(503))).toBe(true)
  })

  it('does not retry auth (401) or bad-request (400)', () => {
    expect(isRetryableGscInspectError(statusErr(401))).toBe(false)
    expect(isRetryableGscInspectError(statusErr(400))).toBe(false)
    expect(isRetryableGscInspectError(statusErr(404))).toBe(false)
  })

  it('retries network-shaped errors with no status', () => {
    expect(isRetryableGscInspectError(new Error('fetch failed'))).toBe(true)
  })
})

describe('inspectUrlsPaced', () => {
  it('inspects every URL and paces between (not after the last) call', async () => {
    const seen: Array<{ url: string; index: number }> = []
    const deps = fastDeps()
    let calls = 0

    const outcome = await inspectUrlsPaced(
      urls(3),
      {
        inspectOne: async () => {
          calls++
          return FAKE_RESULT
        },
        onResult: (url, _result, index) => seen.push({ url, index }),
        onError: () => {
          throw new Error('should not error')
        },
      },
      deps,
    )

    expect(calls).toBe(3)
    expect(outcome).toEqual({ inspected: 3, errors: 0, aborted: false })
    expect(seen).toEqual([
      { url: 'https://example.com/p0', index: 0 },
      { url: 'https://example.com/p1', index: 1 },
      { url: 'https://example.com/p2', index: 2 },
    ])
    // One pacing sleep per REQUEST, including the first, and never after the
    // final URL. The first request used to be exempt, which was harmless while
    // each call owned its gate — but under a shared gate (`rateGateKey`) that
    // exemption let every concurrent sweep fire one ungated request the instant
    // it started, which is the burst the gate exists to stop.
    expect(deps.sleeps).toEqual([INSPECT_BASE_DELAY_MS, INSPECT_BASE_DELAY_MS, INSPECT_BASE_DELAY_MS])
  })

  it('retries a transient 403 then records the eventual success', async () => {
    let calls = 0
    let errored = false

    const outcome = await inspectUrlsPaced(
      urls(1),
      {
        inspectOne: async () => {
          calls++
          if (calls === 1) throw statusErr(403)
          return FAKE_RESULT
        },
        onResult: () => {},
        onError: () => {
          errored = true
        },
      },
      fastDeps(),
    )

    expect(calls).toBe(2)
    expect(errored).toBe(false)
    expect(outcome).toEqual({ inspected: 1, errors: 0, aborted: false })
  })

  it('gives up after the retry budget on a persistent rate response', async () => {
    let calls = 0

    const outcome = await inspectUrlsPaced(
      urls(1),
      {
        inspectOne: async () => {
          calls++
          throw statusErr(429)
        },
        onResult: () => {
          throw new Error('should not succeed')
        },
        onError: () => {},
      },
      fastDeps(),
    )

    // initial attempt + INSPECT_MAX_RETRIES
    expect(calls).toBe(INSPECT_MAX_RETRIES + 1)
    expect(outcome).toEqual({ inspected: 0, errors: 1, aborted: false })
  })

  it('trips the circuit breaker after consecutive rate failures and stops early', async () => {
    const attempted = new Set<string>()

    const outcome = await inspectUrlsPaced(
      urls(10),
      {
        inspectOne: async (url) => {
          attempted.add(url)
          throw statusErr(403)
        },
        onResult: () => {},
        onError: () => {},
      },
      fastDeps({ concurrency: 1 }),
    )

    expect(outcome.aborted).toBe(true)
    expect(outcome.errors).toBe(INSPECT_FAILFAST_THRESHOLD)
    expect(outcome.inspected).toBe(0)
    // Stopped at the threshold — the remaining URLs were never touched.
    expect(attempted.size).toBe(INSPECT_FAILFAST_THRESHOLD)
  })

  it('resets the breaker on success so scattered failures do not abort', async () => {
    // 4 fail, 1 success, 4 fail — max run of consecutive failures is 4 (< threshold of 5).
    //
    // Pinned to one worker: the breaker counts failures consecutive in
    // COMPLETION order, and with several in flight a success can land before
    // failures that started earlier, so the run length is not a property of the
    // input any more. Concurrent breaker behaviour is covered separately below.
    const outcome = await inspectUrlsPaced(
      urls(9),
      {
        inspectOne: async (url) => {
          if (url === 'https://example.com/p4') return FAKE_RESULT
          throw statusErr(403)
        },
        onResult: () => {},
        onError: () => {},
      },
      fastDeps({ concurrency: 1 }),
    )

    expect(outcome.aborted).toBe(false)
    expect(outcome.inspected).toBe(1)
    expect(outcome.errors).toBe(8)
  })

  it('does not let non-retryable per-URL errors trip the breaker', async () => {
    let calls = 0

    const outcome = await inspectUrlsPaced(
      urls(6),
      {
        inspectOne: async () => {
          calls++
          throw statusErr(400) // bad URL — a data issue, not a quota/auth signal
        },
        onResult: () => {},
        onError: () => {},
      },
      fastDeps(),
    )

    expect(outcome.aborted).toBe(false)
    expect(outcome.errors).toBe(6)
    // No retries on a non-retryable status: exactly one call per URL.
    expect(calls).toBe(6)
  })
})

/**
 * Concurrency was added because the loop was serial, not because the rate limit
 * required it: Google documents 600 QPM per site and the pacing allows 60, but
 * running one call at a time meant throughput was bounded by Google's ~6.3s
 * per-call latency instead — about 9.5 QPM.
 */
describe('inspectUrlsPaced concurrency', () => {
  it('never exceeds the configured number in flight', async () => {
    let inFlight = 0
    let peak = 0
    await inspectUrlsPaced(
      urls(20),
      {
        inspectOne: async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await Promise.resolve()
          inFlight--
          return FAKE_RESULT
        },
        onResult: () => {},
        onError: () => {},
      },
      fastDeps({ concurrency: 4 }),
    )

    expect(peak).toBeLessThanOrEqual(4)
  })

  it('keeps the request rate identical to the serial loop', async () => {
    // The whole safety argument: workers take start slots from one shared
    // clock, so N URLs cost N-1 spacings no matter how many run at once.
    const serial = fastDeps({ concurrency: 1 })
    await inspectUrlsPaced(urls(8), { inspectOne: async () => FAKE_RESULT, onResult: () => {}, onError: () => {} }, serial)

    const parallel = fastDeps({ concurrency: 5 })
    await inspectUrlsPaced(urls(8), { inspectOne: async () => FAKE_RESULT, onResult: () => {}, onError: () => {} }, parallel)

    expect(parallel.sleeps).toEqual(serial.sleeps)
    expect(parallel.sleeps).toHaveLength(8)
  })

  it('does not burst the opening batch', async () => {
    // An earlier version skipped the gate for the first `concurrency` requests,
    // which fired 5 at once before any pacing applied.
    const deps = fastDeps({ concurrency: 5 })
    await inspectUrlsPaced(urls(5), { inspectOne: async () => FAKE_RESULT, onResult: () => {}, onError: () => {} }, deps)

    expect(deps.sleeps).toHaveLength(5)
  })

  it('inspects every URL exactly once and reports each original index', async () => {
    const seen: Array<{ url: string; index: number }> = []
    const outcome = await inspectUrlsPaced(
      urls(12),
      {
        inspectOne: async () => FAKE_RESULT,
        onResult: (url, _r, index) => { seen.push({ url, index }) },
        onError: () => {},
      },
      fastDeps({ concurrency: 5 }),
    )

    expect(outcome.inspected).toBe(12)
    expect(new Set(seen.map((s) => s.url)).size).toBe(12)
    // Results may arrive out of order, but each carries its own index.
    for (const { url, index } of seen) expect(url).toBe(`https://example.com/p${index}`)
  })

  it('still trips the breaker when the whole property is failing', async () => {
    const outcome = await inspectUrlsPaced(
      urls(50),
      { inspectOne: async () => { throw statusErr(403) }, onResult: () => {}, onError: () => {} },
      fastDeps({ concurrency: 5 }),
    )

    expect(outcome.aborted).toBe(true)
    // Stopped early rather than burning the daily quota on all 50.
    expect(outcome.errors).toBeLessThan(50)
  })
})

describe('sweep budget', () => {
  it('caps a sweep below the daily quota, leaving room for other consumers', () => {
    // A sweep is not the only draw on the 2000/day: scheduled refreshes, a
    // second sweep, and manual inspections share it.
    expect(INSPECT_SWEEP_MAX_URLS).toBeLessThan(INSPECT_DAILY_QUOTA)
    expect(INSPECT_DAILY_QUOTA).toBe(2000)
  })

  it('is small enough that a full sweep finishes in a working session', () => {
    // At ~7.1s serial the cap would be ~3 hours; at concurrency 5 it is ~30 min.
    const serialHours = (INSPECT_SWEEP_MAX_URLS * 7.1) / 3600
    const concurrentHours = serialHours / INSPECT_MAX_CONCURRENCY
    expect(concurrentHours).toBeLessThan(1)
  })
})
