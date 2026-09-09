import { describe, it, expect, vi } from 'vitest'
import { backoffDelayMs, isRateLimitError, isRetryableHttpError, retryAfterDelayMs, withRetry } from '../src/retry.js'

describe('backoffDelayMs', () => {
  it('returns `base * 2^attempt` with no jitter', () => {
    expect(backoffDelayMs(0, { baseDelayMs: 1000, jitter: false })).toBe(1000)
    expect(backoffDelayMs(1, { baseDelayMs: 1000, jitter: false })).toBe(2000)
    expect(backoffDelayMs(2, { baseDelayMs: 1000, jitter: false })).toBe(4000)
    expect(backoffDelayMs(3, { baseDelayMs: 500, jitter: false })).toBe(4000)
  })

  it('multiplies by Math.random() when jitter is on', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      // jitter=true (default): 0.5 * 1000 * 2^0 = 500
      expect(backoffDelayMs(0, { baseDelayMs: 1000 })).toBe(500)
      // 0.5 * 1000 * 2^2 = 2000
      expect(backoffDelayMs(2, { baseDelayMs: 1000 })).toBe(2000)
    } finally {
      rand.mockRestore()
    }
  })

  it('jitter defaults to enabled', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(1)
    try {
      expect(backoffDelayMs(0, { baseDelayMs: 1000 })).toBe(1000)
    } finally {
      rand.mockRestore()
    }
  })

  it('clamps to maxDelayMs', () => {
    expect(backoffDelayMs(10, { baseDelayMs: 1000, jitter: false, maxDelayMs: 5000 })).toBe(5000)
  })

  it('uses default baseDelayMs=1000 when omitted', () => {
    expect(backoffDelayMs(0, { jitter: false })).toBe(1000)
    expect(backoffDelayMs(2, { jitter: false })).toBe(4000)
  })
})

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { maxRetries: 3, sleep: async () => {} })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable error and returns when success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await withRetry(fn, { maxRetries: 5, sleep, isRetryable: () => true })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('rethrows after maxRetries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      withRetry(fn, { maxRetries: 2, sleep: async () => {}, isRetryable: () => true }),
    ).rejects.toThrow('boom')
    // 1 initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry when isRetryable returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad input'))
    const isRetryable = vi.fn().mockReturnValue(false)
    await expect(
      withRetry(fn, { maxRetries: 5, sleep: async () => {}, isRetryable }),
    ).rejects.toThrow('bad input')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(isRetryable).toHaveBeenCalledOnce()
  })

  it('fires onRetry with attempt, err, and computed delay', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce('ok')
    const onRetry = vi.fn()
    const rand = vi.spyOn(Math, 'random').mockReturnValue(1)
    try {
      await withRetry(fn, {
        maxRetries: 3, sleep: async () => {}, isRetryable: () => true, onRetry, baseDelayMs: 1000,
      })
    } finally {
      rand.mockRestore()
    }
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 0,
      err: expect.objectContaining({ message: 'first' }),
      delayMs: 1000,
    }))
  })

  it('honors computeDelayMs override (e.g. Retry-After header)', async () => {
    const err = Object.assign(new Error('rate-limited'), { retryAfterSeconds: 7 })
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok')
    const sleeps: number[] = []
    await withRetry(fn, {
      maxRetries: 3,
      isRetryable: () => true,
      sleep: async (ms) => { sleeps.push(ms) },
      computeDelayMs: (_attempt, e) => {
        const ra = (e as { retryAfterSeconds?: number }).retryAfterSeconds
        return ra !== undefined ? ra * 1000 : 0
      },
    })
    expect(sleeps).toEqual([7000])
  })
})

describe('isRetryableHttpError', () => {
  it('retries 429', () => {
    expect(isRetryableHttpError({ status: 429 })).toBe(true)
  })

  it('retries 5xx', () => {
    expect(isRetryableHttpError({ status: 500 })).toBe(true)
    expect(isRetryableHttpError({ status: 503 })).toBe(true)
    expect(isRetryableHttpError({ status: 504 })).toBe(true)
  })

  it('does NOT retry 4xx other than 429', () => {
    expect(isRetryableHttpError({ status: 400 })).toBe(false)
    expect(isRetryableHttpError({ status: 401 })).toBe(false)
    expect(isRetryableHttpError({ status: 403 })).toBe(false)
    expect(isRetryableHttpError({ status: 404 })).toBe(false)
    expect(isRetryableHttpError({ status: 422 })).toBe(false)
  })

  it('retries network-error message patterns', () => {
    expect(isRetryableHttpError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableHttpError(new Error('ECONNRESET happened'))).toBe(true)
    expect(isRetryableHttpError(new Error('connect ETIMEDOUT 1.2.3.4'))).toBe(true)
    expect(isRetryableHttpError(new Error('ENOTFOUND example.com'))).toBe(true)
    expect(isRetryableHttpError(new Error('ECONNREFUSED 127.0.0.1:443'))).toBe(true)
    expect(isRetryableHttpError(new Error('network error'))).toBe(true)
  })

  it('retries errors with no status field (likely network-level)', () => {
    expect(isRetryableHttpError(new Error('unknown'))).toBe(true)
    expect(isRetryableHttpError({})).toBe(true)
    expect(isRetryableHttpError(null)).toBe(true)
  })

  it('does NOT confuse a string message with a status field', () => {
    expect(isRetryableHttpError({ status: 'rate-limited' })).toBe(true)  // no number status → treated as network
  })
})

/**
 * Rate limiting does not always arrive as HTTP 429. The payload below is the
 * verbatim response Bing Webmaster Tools returns when it throttles, and it
 * comes back on a 400 — which the status-only predicate classified as a
 * permanent client error, so a throttled request failed instead of backing
 * off. These pin the semantic test that replaced it.
 */
const BING_THROTTLE_HOST = 'Bing API error (400): {"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}'
const BING_THROTTLE_USER = 'Bing API error (400): {"ErrorCode":4,"Message":"ERROR!!! ThrottleUser"}'

describe('isRateLimitError', () => {
  it('recognizes a throttle reported on a non-429 status', () => {
    expect(isRateLimitError(Object.assign(new Error(BING_THROTTLE_HOST), { status: 400 }))).toBe(true)
    expect(isRateLimitError(Object.assign(new Error(BING_THROTTLE_USER), { status: 400 }))).toBe(true)
  })

  it('recognizes the documented phrasings whatever the status', () => {
    for (const message of [
      'Rate limit exceeded',
      'RateLimit reached for this key',
      'Too Many Requests',
      'Quota exceeded for quota metric',
      'User is over quota',
      'Please slow down',
    ]) {
      expect(isRateLimitError(new Error(message))).toBe(true)
    }
  })

  it('recognizes HTTP 429 with no helpful message', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true)
  })

  it('treats a Retry-After as proof on its own', () => {
    expect(isRateLimitError({ status: 503, retryAfter: 30 })).toBe(true)
    expect(isRateLimitError({ 'retry-after': '120' })).toBe(true)
  })

  it('does not fire on ordinary client errors', () => {
    expect(isRateLimitError(Object.assign(new Error('Invalid site URL'), { status: 400 }))).toBe(false)
    expect(isRateLimitError(Object.assign(new Error('API key is invalid'), { status: 401 }))).toBe(false)
    expect(isRateLimitError(Object.assign(new Error('Not found'), { status: 404 }))).toBe(false)
    expect(isRateLimitError(new Error('fetch failed'))).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})

describe('isRetryableHttpError with body-reported throttling', () => {
  it('retries a throttle that arrived on a 400', () => {
    // The regression this whole change exists for.
    expect(isRetryableHttpError(Object.assign(new Error(BING_THROTTLE_HOST), { status: 400 }))).toBe(true)
    expect(isRetryableHttpError(Object.assign(new Error(BING_THROTTLE_USER), { status: 400 }))).toBe(true)
  })

  it('still refuses a genuine 400', () => {
    expect(isRetryableHttpError(Object.assign(new Error('Invalid site URL'), { status: 400 }))).toBe(false)
  })

  it('still refuses auth and not-found', () => {
    expect(isRetryableHttpError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false)
    expect(isRetryableHttpError(Object.assign(new Error('nope'), { status: 404 }))).toBe(false)
  })
})

describe('retryAfterDelayMs', () => {
  it('reads SDK response headers and preserves explicit overrides', () => {
    expect(retryAfterDelayMs({ headers: new Headers({ 'retry-after': '300' }) })).toBe(300_000)
    expect(retryAfterDelayMs({ headers: { 'retry-after': '12' } })).toBe(12_000)
    expect(retryAfterDelayMs({ headers: { 'Retry-After': '12' } })).toBe(12_000)
    expect(retryAfterDelayMs({ retryAfter: 5, headers: { 'retry-after': '12' } })).toBe(5_000)
  })

  it('reads delta-seconds in both numeric and string form', () => {
    expect(retryAfterDelayMs({ retryAfter: 30 })).toBe(30_000)
    expect(retryAfterDelayMs({ retryAfter: '30' })).toBe(30_000)
    expect(retryAfterDelayMs({ 'retry-after': '5' })).toBe(5_000)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-08-05T12:00:00Z')
    expect(retryAfterDelayMs({ retryAfter: 'Wed, 05 Aug 2026 12:01:00 GMT' }, now)).toBe(60_000)
  })

  it('never returns a negative delay for a date already past', () => {
    const now = Date.parse('2026-08-05T12:00:00Z')
    expect(retryAfterDelayMs({ retryAfter: 'Wed, 05 Aug 2026 11:00:00 GMT' }, now)).toBe(0)
  })

  it('returns null when there is nothing usable to read', () => {
    expect(retryAfterDelayMs({})).toBeNull()
    expect(retryAfterDelayMs({ retryAfter: '' })).toBeNull()
    expect(retryAfterDelayMs({ retryAfter: 'soon' })).toBeNull()
    expect(retryAfterDelayMs(new Error('nope'))).toBeNull()
    expect(retryAfterDelayMs(null)).toBeNull()
  })

  it('drives withRetry when wired through computeDelayMs', async () => {
    const slept: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('Too Many Requests'), { status: 429, retryAfter: 45 })
        return 'ok'
      },
      {
        isRetryable: isRetryableHttpError,
        computeDelayMs: (_attempt, err, defaultMs) => retryAfterDelayMs(err) ?? defaultMs,
        sleep: async (ms) => { slept.push(ms) },
      },
    )
    // The server's instruction, not our 1s exponential guess.
    expect(slept).toEqual([45_000])
  })
})
