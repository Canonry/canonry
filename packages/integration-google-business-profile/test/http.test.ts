import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { gbpFetchGet } from '../src/http.js'
import { GbpApiError } from '../src/types.js'

describe('gbpFetchGet', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns parsed JSON on 200', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accounts: [{ name: 'accounts/1' }] }),
    })
    const result = await gbpFetchGet<{ accounts: { name: string }[] }>('https://example/api', 'tok')
    expect(result).toEqual({ accounts: [{ name: 'accounts/1' }] })
  })

  it('attaches Authorization header and omits x-goog-user-project by default', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
    await gbpFetchGet('https://example/api', 'tok')
    const call = fetchSpy.mock.calls[0]!
    const headers = (call[1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['x-goog-user-project']).toBeUndefined()
  })

  it('attaches x-goog-user-project header when quotaProject is passed', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
    await gbpFetchGet('https://example/api', 'tok', { quotaProject: 'my-proj' })
    const call = fetchSpy.mock.calls[0]!
    const headers = (call[1] as { headers: Record<string, string> }).headers
    expect(headers['x-goog-user-project']).toBe('my-proj')
  })

  it('throws GbpApiError with the structured reason for scope problems', async () => {
    const body = {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      },
    }
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => JSON.stringify(body) })
    await expect(gbpFetchGet('https://example/api', 'tok')).rejects.toMatchObject({
      name: 'GbpApiError',
      status: 403,
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    })
  })

  it('throws GbpApiError with reason=RATE_LIMIT_EXCEEDED for quota gate', async () => {
    const body = {
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'Requests'",
        status: 'RESOURCE_EXHAUSTED',
        details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
      },
    }
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify(body) })
    try {
      // maxRetries=0 to exercise the error-shape path without retrying.
      await gbpFetchGet('https://example/api', 'tok', { retry: { maxRetries: 0 } })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GbpApiError)
      expect((err as GbpApiError).status).toBe(429)
      expect((err as GbpApiError).reason).toBe('RATE_LIMIT_EXCEEDED')
    }
  })

  it('falls back to null reason when error.details is missing', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'Internal' } }),
    })
    try {
      await gbpFetchGet('https://example/api', 'tok')
      expect.fail('expected throw')
    } catch (err) {
      expect((err as GbpApiError).reason).toBeNull()
    }
  })

  // ─── Retry / backoff guards (per Google's official guidance) ──────────
  // https://developers.google.com/my-business/content/limits

  describe('retry behavior', () => {
    function okResponse(body: unknown) {
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    function rateLimitedResponse(quotaLimit = '300') {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Requests'",
            status: 'RESOURCE_EXHAUSTED',
            details: [{
              reason: 'RATE_LIMIT_EXCEEDED',
              metadata: { quota_limit_value: quotaLimit, quota_unit: '1/min/{project}' },
            }],
          },
        }),
      }
    }

    it('retries on 429 RATE_LIMIT_EXCEEDED until success', async () => {
      fetchSpy
        .mockResolvedValueOnce(rateLimitedResponse('300'))
        .mockResolvedValueOnce(rateLimitedResponse('300'))
        .mockResolvedValueOnce(okResponse({ accounts: [] }))
      const result = await gbpFetchGet<{ accounts: unknown[] }>(
        'https://example/api', 'tok',
        { retry: { baseDelayMs: 1, maxRetries: 5 } },
      )
      expect(result).toEqual({ accounts: [] })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('does NOT retry when quota_limit_value is "0" (the access-form gate)', async () => {
      fetchSpy.mockResolvedValueOnce(rateLimitedResponse('0'))
      await expect(
        gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 5 } }),
      ).rejects.toMatchObject({
        name: 'GbpApiError',
        status: 429,
        reason: 'RATE_LIMIT_EXCEEDED',
        quotaLimitValue: 0,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('exposes a non-zero quotaLimitValue when an approved project hits the rate ceiling', async () => {
      fetchSpy.mockResolvedValueOnce(rateLimitedResponse('300'))
      try {
        await gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 0 } })
        expect.fail('expected throw')
      } catch (err) {
        expect((err as GbpApiError).quotaLimitValue).toBe(300)
      }
    })

    it('gives up after maxRetries consecutive 429s', async () => {
      for (let i = 0; i < 4; i++) fetchSpy.mockResolvedValueOnce(rateLimitedResponse('300'))
      await expect(
        gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 3 } }),
      ).rejects.toMatchObject({ name: 'GbpApiError', status: 429 })
      // 1 initial + 3 retries = 4 total
      expect(fetchSpy).toHaveBeenCalledTimes(4)
    })

    it('does NOT retry on 401 (auth expired — needs reconnect)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false, status: 401,
        text: async () => JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }),
      })
      await expect(
        gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 5 } }),
      ).rejects.toMatchObject({ status: 401 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false, status: 403,
        text: async () => JSON.stringify({
          error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
        }),
      })
      await expect(
        gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 5 } }),
      ).rejects.toMatchObject({ status: 403, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('retries on 503 Service Unavailable (transient)', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'unavailable' } }) })
        .mockResolvedValueOnce(okResponse({}))
      const result = await gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 3 } })
      expect(result).toEqual({})
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('does NOT retry on 404', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => JSON.stringify({ error: { code: 404, message: 'Not Found' } }),
      })
      await expect(
        gbpFetchGet('https://example/api', 'tok', { retry: { baseDelayMs: 1, maxRetries: 5 } }),
      ).rejects.toMatchObject({ status: 404 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('uses jittered exponential delay between retries (sleep grows with attempt)', async () => {
      const sleeps: number[] = []
      const sleep = (ms: number) => { sleeps.push(ms); return Promise.resolve() }
      for (let i = 0; i < 4; i++) fetchSpy.mockResolvedValueOnce(rateLimitedResponse('300'))
      // Mock Math.random to return 1 (max jitter) for deterministic upper-bound delays.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
      try {
        await gbpFetchGet('https://example/api', 'tok', {
          retry: { baseDelayMs: 1000, maxRetries: 3, sleep },
        })
      } catch { /* expected */ }
      randomSpy.mockRestore()
      // With random=1: attempt 0 sleep = 1000, attempt 1 = 2000, attempt 2 = 4000.
      // The pattern is `random * base * 2^attempt`.
      expect(sleeps).toEqual([1000, 2000, 4000])
    })
  })
})
