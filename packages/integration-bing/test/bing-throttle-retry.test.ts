import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getUrlInfo, getSites, submitUrlBatch, __resetBingThrottleCooldownForTest } from '../src/bing-client.js'
import { BingApiError, BING_THROTTLE_ERROR_CODES } from '../src/types.js'
import { isRetryableHttpError } from '@canonry/canonry-contracts'

/**
 * Bing does not use HTTP 429 to report throttling. It answers `400` and puts
 * the condition in the body, so the status alone cannot distinguish a throttle
 * from a bad request. These bodies are verbatim from a production instance,
 * where the missing retry turned a routine refresh into 229 hard failures over
 * three days.
 */
const THROTTLE_HOST_BODY = '{"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}'
const THROTTLE_USER_BODY = '{"ErrorCode":4,"Message":"ERROR!!! ThrottleUser"}'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Bing throttle classification', () => {
  it('marks Bing\'s throttle codes as throttles', () => {
    expect(new BingApiError('x', 400, 5).isThrottle).toBe(true)
    expect(new BingApiError('x', 400, 4).isThrottle).toBe(true)
    expect([...BING_THROTTLE_ERROR_CODES].sort()).toEqual([4, 5])
  })

  it('does not mark other Bing error codes as throttles', () => {
    // 14 is NotAuthorized — a real failure that must not be retried.
    expect(new BingApiError('x', 400, 14).isThrottle).toBe(false)
    expect(new BingApiError('x', 400, null).isThrottle).toBe(false)
  })

  it('is retryable through the shared predicate despite the 400', () => {
    const err = new BingApiError(`Bing API error (400): ${THROTTLE_HOST_BODY}`, 400, 5)
    expect(isRetryableHttpError(err)).toBe(true)
  })

  it('leaves a genuine 400 non-retryable', () => {
    const err = new BingApiError('Bing API error (400): {"ErrorCode":2,"Message":"Invalid site"}', 400, 2)
    expect(isRetryableHttpError(err)).toBe(false)
  })
})

describe('bingFetch retry behaviour', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
    // The throttle cooldown is module state keyed by API key. A test that
    // exhausts its retries opens it, so without this reset the NEXT test would
    // fail fast on a cooldown it never asked for.
    __resetBingThrottleCooldownForTest()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  /** Run `p` while auto-advancing timers, so backoff sleeps do not stall the test. */
  async function withTimersRun<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    await vi.runAllTimersAsync()
    const outcome = await settled
    if (!outcome.ok) throw outcome.err
    return outcome.value
  }

  it('retries a throttled call and succeeds', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls <= 2) return errorResponse(400, THROTTLE_HOST_BODY)
      return jsonResponse({ d: { HttpStatus: 200, DocumentSize: 1234 } })
    }) as unknown as typeof globalThis.fetch

    const info = await withTimersRun(getUrlInfo('key', 'https://example.com', 'https://example.com/page'))

    expect(calls).toBe(3)
    expect(info.DocumentSize).toBe(1234)
  })

  it('retries the per-key throttle too', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return errorResponse(400, THROTTLE_USER_BODY)
      return jsonResponse({ d: [] })
    }) as unknown as typeof globalThis.fetch

    await withTimersRun(getSites('key'))
    expect(calls).toBe(2)
  })

  it('gives up after the retry budget and surfaces the throttle', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return errorResponse(400, THROTTLE_HOST_BODY)
    }) as unknown as typeof globalThis.fetch

    await expect(
      withTimersRun(getUrlInfo('key', 'https://example.com', 'https://example.com/page')),
    ).rejects.toThrow(/ThrottleHost/)

    // 1 initial attempt + BING_MAX_RETRIES.
    expect(calls).toBe(5)
  })

  it('does NOT retry an auth failure', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return new Response('nope', { status: 401 })
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getSites('key'))).rejects.toThrow(/invalid or unauthorized/)
    expect(calls).toBe(1)
  })

  it('does NOT retry a non-throttle 400', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return errorResponse(400, '{"ErrorCode":14,"Message":"ERROR!!! NotAuthorized"}')
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getSites('key'))).rejects.toThrow(/NotAuthorized/)
    // The failure mode this must never regress into: 550 NotAuthorized errors
    // were logged on this instance, and retrying each five times would have
    // quintupled the load for nothing.
    expect(calls).toBe(1)
  })

  it('retries a THROTTLED write, which Bing rejects before acting on it', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return errorResponse(400, THROTTLE_HOST_BODY)
      return jsonResponse({ d: null })
    }) as unknown as typeof globalThis.fetch

    await withTimersRun(submitUrlBatch('key', 'https://example.com/', ['https://example.com/a']))
    expect(calls).toBe(2)
  })

  it('does NOT retry a write that failed ambiguously', async () => {
    // A 5xx on SubmitUrlBatch may mean Bing accepted the URLs and lost the
    // response. Replaying it would spend the daily submission quota twice on
    // work that may already be done, and the quota cannot be reclaimed.
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return new Response('upstream boom', { status: 503 })
    }) as unknown as typeof globalThis.fetch

    await expect(
      withTimersRun(submitUrlBatch('key', 'https://example.com/', ['https://example.com/a'])),
    ).rejects.toThrow(/Bing API error \(503\)/)
    expect(calls).toBe(1)
  })

  it('DOES retry the same ambiguous failure on a read', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response('upstream boom', { status: 503 })
      return jsonResponse({ d: [] })
    }) as unknown as typeof globalThis.fetch

    await withTimersRun(getSites('key'))
    expect(calls).toBe(2)
  })

  it('tolerates a non-JSON error body without claiming a throttle', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return new Response('<html>Gateway Error</html>', { status: 400 })
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getSites('key'))).rejects.toThrow(/Bing API error \(400\)/)
    expect(calls).toBe(1)
  })
})

/**
 * Retrying is the right answer to a momentary throttle and the wrong answer to
 * a sustained one.
 *
 * Measured on 2026-08-06: once the account was throttled, every call kept
 * returning `ThrottleUser` for over an hour — including calls for a site that
 * had not been touched in six days, with nothing else in flight. The limit is
 * on the ACCOUNT, and continued requests are what hold it open. So a call that
 * burns its whole retry budget and is STILL throttled is treated as evidence
 * about the key rather than about that URL.
 */
describe('throttle cooldown', () => {
  let originalFetch: typeof globalThis.fetch
  let clock: number

  beforeEach(() => {
    originalFetch = globalThis.fetch
    clock = 1_000_000
    vi.useFakeTimers()
    __resetBingThrottleCooldownForTest(() => clock)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    __resetBingThrottleCooldownForTest()
  })

  async function withTimersRun<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    await vi.runAllTimersAsync()
    const outcome = await settled
    if (!outcome.ok) throw outcome.err
    return outcome.value
  }

  it('stops calling the API once a full retry budget ends in a throttle', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return errorResponse(400, THROTTLE_USER_BODY)
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).rejects.toThrow()
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(1) // it did retry

    // Second call: refused locally, no HTTP issued at all.
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/q'))).rejects.toThrow(
      /cooldown/i,
    )
    expect(calls).toBe(afterFirst)
  })

  it('cools down the CREDENTIAL, so every site on that key stops too', async () => {
    // The failure that made this necessary: a per-site cooldown would have let
    // the other projects on the same key keep hammering the account.
    globalThis.fetch = vi.fn(async () => errorResponse(400, THROTTLE_USER_BODY)) as unknown as typeof globalThis.fetch
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).rejects.toThrow()

    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await expect(withTimersRun(getUrlInfo('key-a', 'https://other.test/', 'https://other.test/p'))).rejects.toThrow(
      /cooldown/i,
    )
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before)
  })

  it('leaves a DIFFERENT credential untouched', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      return String(input).includes('key-a') ? errorResponse(400, THROTTLE_USER_BODY) : jsonResponse({ Url: 'ok' })
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).rejects.toThrow()
    // Two Bing accounts on one instance must not take each other down.
    await expect(withTimersRun(getUrlInfo('key-b', 'https://b.test/', 'https://b.test/p'))).resolves.toBeTruthy()
  })

  it('expires, so a throttle does not disable the integration forever', async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(400, THROTTLE_USER_BODY)) as unknown as typeof globalThis.fetch
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).rejects.toThrow()
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/q'))).rejects.toThrow(/cooldown/i)

    clock += 11 * 60 * 1000 // past BING_THROTTLE_COOLDOWN_MS
    globalThis.fetch = vi.fn(async () => jsonResponse({ Url: 'ok' })) as unknown as typeof globalThis.fetch
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/r'))).resolves.toBeTruthy()
  })

  it('is not opened by a non-throttle failure', async () => {
    // A 404 says something about the URL, not about the account.
    globalThis.fetch = vi.fn(async () =>
      errorResponse(404, '{"ErrorCode":2,"Message":"Not found"}'),
    ) as unknown as typeof globalThis.fetch
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).rejects.toThrow()

    globalThis.fetch = vi.fn(async () => jsonResponse({ Url: 'ok' })) as unknown as typeof globalThis.fetch
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/q'))).resolves.toBeTruthy()
  })

  it('is not opened when a throttle eventually succeeds on retry', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      return calls === 1 ? errorResponse(400, THROTTLE_HOST_BODY) : jsonResponse({ Url: 'ok' })
    }) as unknown as typeof globalThis.fetch

    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/p'))).resolves.toBeTruthy()
    // A momentary throttle is exactly what retry is for — it must not trigger
    // the heavier account-level backoff.
    await expect(withTimersRun(getUrlInfo('key-a', 'https://a.test/', 'https://a.test/q'))).resolves.toBeTruthy()
  })
})
