import { test, expect, onTestFinished, describe, vi, beforeEach } from 'vitest'

import { fetchProjects, loginWithPassword, setupDashboardPassword, setOnAuthExpired, handleAuthExpired } from '../src/api.js'
import { fetchAeroTranscript, fetchAgentProviders, resetAeroTranscript, promptAero } from '../src/api-aero.js'

function mockFetch(status: number, body?: unknown) {
  const realFetch = globalThis.fetch
  const fetchMock = vi.fn(async () =>
    new Response(body != null ? JSON.stringify(body) : null, {
      status,
      headers: body != null ? { 'content-type': 'application/json' } : {},
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  onTestFinished(() => {
    globalThis.fetch = realFetch
  })
  return fetchMock
}

describe('apiFetch auth expiry', () => {
  // Reset the module-level handler before each test so a previous test's
  // failed cleanup can't leak into later tests.
  beforeEach(() => {
    setOnAuthExpired(null)
  })

  test('calls auth expired handler on 401', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('calls auth expired handler on 403', async () => {
    mockFetch(403, { error: 'Forbidden' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('does NOT call auth expired handler on 404', async () => {
    mockFetch(404, { error: 'Not found' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('does NOT call auth expired handler on 500', async () => {
    mockFetch(500, { error: 'Internal error' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('does NOT call auth expired handler on 401 from /session (wrong password)', async () => {
    mockFetch(401, { error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(loginWithPassword('wrong')).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('does NOT call auth expired handler on 401 from /session/setup', async () => {
    mockFetch(401, { error: { code: 'AUTH_INVALID', message: 'Server API key not found' } })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(setupDashboardPassword('password123')).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('does nothing when no handler is registered (401)', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    // No handler registered — should not throw, just reject the fetch
    await expect(fetchProjects()).rejects.toThrow()
  })

  test('setOnAuthExpired(null) clears the handler', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)
    setOnAuthExpired(null)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('handleAuthExpired calls the registered handler', () => {
    const handler = vi.fn()
    setOnAuthExpired(handler)

    handleAuthExpired()

    expect(handler).toHaveBeenCalledOnce()
  })

  test('handleAuthExpired is safe when no handler is registered', () => {
    // Should not throw
    expect(() => handleAuthExpired()).not.toThrow()
  })
})

describe('api-aero auth expiry', () => {
  // Aero endpoints bypass apiFetch (the prompt endpoint streams its SSE body),
  // so they wire handleAuthExpired() in independently. These tests guard the
  // long-lived-dashboard case: if the agent stream is the only active request
  // when the session expires, the user should still be kicked to login.
  beforeEach(() => {
    setOnAuthExpired(null)
  })

  test('fetchAeroTranscript triggers auth expiry on 401', async () => {
    mockFetch(401, { error: { code: 'AUTH_REQUIRED', message: 'Unauthorized' } })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchAeroTranscript('demo')).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('fetchAeroTranscript triggers auth expiry on 403', async () => {
    mockFetch(403, { error: 'Forbidden' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchAeroTranscript('demo')).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('fetchAeroTranscript does NOT trigger auth expiry on 404', async () => {
    mockFetch(404, { error: 'Not found' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchAeroTranscript('demo')).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  test('fetchAgentProviders triggers auth expiry on 401', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchAgentProviders('demo')).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('resetAeroTranscript triggers auth expiry on 401', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(resetAeroTranscript('demo')).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('promptAero triggers auth expiry on 401 before the stream opens', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(
      promptAero({ project: 'demo', prompt: 'hi', onEvent: () => {} }),
    ).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
  })
})
