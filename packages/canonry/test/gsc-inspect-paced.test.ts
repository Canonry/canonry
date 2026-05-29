import { describe, it, expect } from 'vitest'
import type { GscUrlInspectionResult } from '@ainyc/canonry-integration-google'
import {
  inspectUrlsPaced,
  isRetryableGscInspectError,
  INSPECT_MAX_RETRIES,
  INSPECT_FAILFAST_THRESHOLD,
  INSPECT_BASE_DELAY_MS,
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
function fastDeps(extra: Partial<PacedInspectDeps> = {}): PacedInspectDeps & { sleeps: number[] } {
  const sleeps: number[] = []
  return {
    sleeps,
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
    // One pacing sleep between each pair of calls — never after the final URL.
    expect(deps.sleeps).toEqual([INSPECT_BASE_DELAY_MS, INSPECT_BASE_DELAY_MS])
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
      fastDeps(),
    )

    expect(outcome.aborted).toBe(true)
    expect(outcome.errors).toBe(INSPECT_FAILFAST_THRESHOLD)
    expect(outcome.inspected).toBe(0)
    // Stopped at the threshold — the remaining URLs were never touched.
    expect(attempted.size).toBe(INSPECT_FAILFAST_THRESHOLD)
  })

  it('resets the breaker on success so scattered failures do not abort', async () => {
    // 4 fail, 1 success, 4 fail — max run of consecutive failures is 4 (< threshold of 5).
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
      fastDeps(),
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
