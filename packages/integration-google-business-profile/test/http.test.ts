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
      await gbpFetchGet('https://example/api', 'tok')
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
})
