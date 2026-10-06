import { describe, it, expect, beforeEach } from 'vitest'
import { sharedRateGate, credentialGateKey, resetRateGatesForTest } from '../src/inspect-rate-gate.js'
import { inspectUrlsPaced, type PacedInspectDeps } from '../src/gsc-inspect-paced.js'

/**
 * The defect these cover, in one sentence: pacing that a SECOND caller can
 * ignore is not a rate limit.
 *
 * `inspectUrlsPaced` built its gate in a local variable, so each call paced
 * itself and no other. Bing meters the API key, one key serves every project on
 * the instance, and the daily `data-refresh` fires all of them in the same
 * millisecond, so three sweeps each honouring "1 req/sec" put 3 req/sec on one
 * account.
 */

beforeEach(() => {
  resetRateGatesForTest()
})

describe('sharedRateGate', () => {
  it('queues the same resource while a different resource continues', async () => {
    const started: string[] = []
    let releaseFirst = () => {}
    const first = sharedRateGate('bing:account-one').take(1000, () => new Promise<void>((resolve) => {
      started.push('account-one:first')
      releaseFirst = resolve
    }))
    const second = sharedRateGate('bing:account-one').take(1000, async () => {
      started.push('account-one:second')
    })
    const independent = sharedRateGate('bing:account-two').take(1000, async () => {
      started.push('account-two')
    })

    try {
      await Promise.resolve()
      expect(started).toEqual(['account-one:first', 'account-two'])
    } finally {
      releaseFirst()
      await Promise.all([first, second, independent])
    }
    expect(started).toEqual(['account-one:first', 'account-two', 'account-one:second'])
  })

  it('does not wedge every future waiter when one rejects', async () => {
    const gate = sharedRateGate('bing:acct')
    const boom = gate.take(1, async () => {
      throw new Error('sleep exploded')
    })
    await expect(boom).rejects.toThrow('sleep exploded')

    // The next caller must still be served — a poisoned chain would hang or
    // reject every subsequent sweep on that credential for the process's life.
    let served = false
    await gate.take(1, async () => {
      served = true
    })
    expect(served).toBe(true)
  })
})

describe('credentialGateKey', () => {
  it('separates two credentials', () => {
    expect(credentialGateKey('bing', 'key-one')).not.toBe(credentialGateKey('bing', 'key-two'))
  })

  it('is stable for the same credential', () => {
    expect(credentialGateKey('bing', 'key-one')).toBe(credentialGateKey('bing', 'key-one'))
  })

  it('never embeds the secret', () => {
    const secret = 'super-secret-bing-key'
    expect(credentialGateKey('bing', secret)).not.toContain(secret)
  })
})

/**
 * The regression itself, at the level the bug actually occurred: two SWEEPS,
 * not two gate objects.
 */
describe('concurrent sweeps sharing one upstream limit', () => {
  function pacedDeps(record: (ms: number) => void, extra: Partial<PacedInspectDeps> = {}): PacedInspectDeps {
    return { jitter: () => 0, sleep: async (ms) => record(ms), concurrency: 1, rateGateKey: 'unset', ...extra }
  }

  it('spaces every request START across all sweeps on one credential', async () => {
    // A shared virtual clock. Each rate slot advances it; each request records
    // the time it STARTED. The invariant the throttle cares about is that no
    // two starts share an instant, no matter how many sweeps are running.
    let clock = 0
    const starts: number[] = []
    const run = (tag: string) =>
      inspectUrlsPaced(
        [`https://${tag}.test/1`, `https://${tag}.test/2`, `https://${tag}.test/3`],
        {
          inspectOne: async () => {
            starts.push(clock)
            return {}
          },
          onResult: () => {},
          onError: () => {},
        },
        pacedDeps((ms) => { clock += ms }, { rateGateKey: 'bing:same-account' }),
      )

    await Promise.all([run('a'), run('b'), run('c')])

    expect(starts).toHaveLength(9)
    // Strictly increasing: nine requests, nine distinct instants, 1000ms apart.
    // The per-call gate produced THREE requests at t=0 (one free start per
    // sweep) and three more at each subsequent tick — the exact burst that put
    // 3 req/sec on a one-request-per-second budget.
    const sorted = [...starts].sort((x, y) => x - y)
    expect(new Set(sorted).size).toBe(9)
    expect(sorted).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])
  })

})

/**
 * Retry amplification: the second half of why a throttled Bing sweep spent ~100
 * requests to inspect nothing.
 */
describe('retry layering', () => {
  it('maxRetries: 0 issues exactly one attempt per URL', async () => {
    let attempts = 0
    const outcome = await inspectUrlsPaced(
      ['https://a.test/1', 'https://a.test/2'],
      {
        inspectOne: async () => {
          attempts++
          throw Object.assign(new Error('throttled'), { status: 429 })
        },
        onResult: () => {},
        onError: () => {},
      },
      { jitter: () => 0, sleep: async () => {}, concurrency: 1, maxRetries: 0, rateGateKey: 'retry-a' },
    )

    // The caller's own HTTP client is what retries. Without this, Bing's 5
    // client attempts were multiplied by 4 driver attempts = 20 requests per
    // URL, and the breaker's 5-failure budget cost ~100 requests.
    expect(attempts).toBe(2)
    expect(outcome.errors).toBe(2)
  })

  it('retries take a rate slot instead of bypassing the gate', async () => {
    const sleeps: number[] = []
    let attempts = 0
    await inspectUrlsPaced(
      ['https://a.test/1'],
      {
        inspectOne: async () => {
          attempts++
          throw Object.assign(new Error('throttled'), { status: 429 })
        },
        onResult: () => {},
        onError: () => {},
      },
      { jitter: () => 0, sleep: async (ms) => { sleeps.push(ms) }, concurrency: 1, maxRetries: 2, rateGateKey: 'retry-b' },
    )

    // 3 attempts = 1 initial + 2 retries. Each pays a rate slot, and withRetry
    // adds its own backoff sleep between attempts. The gate used to cover only
    // fresh-URL starts, so retry traffic — most of a throttled sweep's requests
    // — was completely unrated.
    expect(attempts).toBe(3)
    const rateSlots = sleeps.filter((ms) => ms === 1000).length
    expect(rateSlots).toBeGreaterThanOrEqual(3)
  })
})
