import { test, expect, onTestFinished, describe, vi } from 'vitest'

import { fetchProjects, setOnAuthExpired, handleAuthExpired } from '../src/api.js'

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
  test('calls auth expired handler on 401', async () => {
    mockFetch(401, { error: 'Unauthorized' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()

    setOnAuthExpired(null)
  })

  test('calls auth expired handler on 403', async () => {
    mockFetch(403, { error: 'Forbidden' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()

    setOnAuthExpired(null)
  })

  test('does NOT call auth expired handler on 404', async () => {
    mockFetch(404, { error: 'Not found' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()

    setOnAuthExpired(null)
  })

  test('does NOT call auth expired handler on 500', async () => {
    mockFetch(500, { error: 'Internal error' })
    const handler = vi.fn()
    setOnAuthExpired(handler)

    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()

    setOnAuthExpired(null)
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

    setOnAuthExpired(null)
  })

  test('handleAuthExpired is safe when no handler is registered', () => {
    // Should not throw
    expect(() => handleAuthExpired()).not.toThrow()
  })
})
