import { test, expect, onTestFinished, describe, vi, beforeEach } from 'vitest'

import { fetchProjects, loginWithPassword, setupDashboardPassword, setOnAuthExpired, handleAuthExpired } from '../src/api.js'

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
