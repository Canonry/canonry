import { afterEach, expect, test, vi } from 'vitest'
import { createFirstAdministrator, fetchProjects, setOnAuthExpired } from '../src/api.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

const restores: Array<() => void> = []
afterEach(() => { for (const restore of restores.splice(0)) restore(); setOnAuthExpired(null) })

test('setup sends its key once, excludes cookies, and leaves subsequent requests unprivileged', async () => {
  const secret = crypto.randomUUID()
  const body = { name: crypto.randomUUID(), password: crypto.randomUUID() }
  const requests: Array<{ url: string; headers: Headers; credentials?: RequestCredentials; body?: unknown }> = []
  const originalFetch = globalThis.fetch
  restores.push(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const text = await request.clone().text()
    requests.push({ url: request.url, headers: request.headers, credentials: request.credentials, body: text ? JSON.parse(text) : undefined })
    return jsonResponse(request.url.endsWith('/users') ? { id: crypto.randomUUID(), name: body.name, role: 'admin' } : [])
  }
  await createFirstAdministrator(body, secret)
  await fetchProjects()
  expect(requests).toHaveLength(2)
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${secret}`)
  expect(requests[0]?.credentials).toBe('omit')
  expect(requests[0]?.body).toEqual({ ...body, role: 'admin', onlyIfFirstAdmin: true })
  expect(requests[0]?.url).not.toContain(secret)
  expect(requests[1]?.headers.has('authorization')).toBe(false)
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})

test('an incorrect setup credential is an inline failure, not session expiry', async () => {
  const expired = vi.fn()
  setOnAuthExpired(expired)
  restores.push(mockFetch(() => jsonResponse({ error: { code: 'AUTH_INVALID', message: crypto.randomUUID() } }, 401)))
  await expect(createFirstAdministrator({ name: crypto.randomUUID(), password: crypto.randomUUID() }, crypto.randomUUID())).rejects.toMatchObject({ statusCode: 401 })
  expect(expired).not.toHaveBeenCalled()
})
