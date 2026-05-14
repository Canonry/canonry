import { test, expect, onTestFinished, describe } from 'vitest'

import { connectServerTrafficWordpress, installBacklinks, triggerGscSync } from '../src/api.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function headerFromInit(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(name)
  const lowerName = name.toLowerCase()
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lowerName) return v
  }
  return null
}

describe('apiFetch Content-Type header', () => {
  test('omits Content-Type on POST without body (Fastify rejects empty JSON bodies)', async () => {
    let observed: RequestInit | undefined
    const restore = mockFetch((_url, init) => {
      observed = init
      return jsonResponse({ status: 'ok' })
    })
    onTestFinished(restore)

    await installBacklinks()

    expect(observed?.method).toBe('POST')
    expect(observed?.body).toBeUndefined()
    expect(headerFromInit(observed, 'Content-Type')).toBeNull()
  })

  test('sets Content-Type on requests with a body', async () => {
    let observed: RequestInit | undefined
    const restore = mockFetch((_url, init) => {
      observed = init
      return jsonResponse({ id: 'run-1', status: 'pending' })
    })
    onTestFinished(restore)

    await triggerGscSync('demo', { days: 7 })

    expect(observed?.method).toBe('POST')
    expect(observed?.body).toBeDefined()
    expect(headerFromInit(observed, 'Content-Type')).toBe('application/json')
  })

  test('posts WordPress traffic connects to the adapter-specific endpoint', async () => {
    let observedUrl = ''
    let observed: RequestInit | undefined
    const restore = mockFetch((url, init) => {
      observedUrl = url
      observed = init
      return jsonResponse({
        id: 'source-1',
        projectId: 'project-1',
        sourceType: 'wordpress',
        displayName: 'WordPress - example.com',
        status: 'connected',
        lastSyncedAt: null,
        lastCursor: null,
        lastError: null,
        archivedAt: null,
        config: { baseUrl: 'https://example.com', username: 'admin' },
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      })
    })
    onTestFinished(restore)

    await connectServerTrafficWordpress('demo project', {
      baseUrl: 'https://example.com',
      username: 'admin',
      applicationPassword: 'xxxx xxxx',
      displayName: 'WP logs',
    })

    expect(observedUrl).toBe('/api/v1/projects/demo%20project/traffic/connect/wordpress')
    expect(observed?.method).toBe('POST')
    expect(headerFromInit(observed, 'Content-Type')).toBe('application/json')
    expect(JSON.parse(String(observed?.body))).toEqual({
      baseUrl: 'https://example.com',
      username: 'admin',
      applicationPassword: 'xxxx xxxx',
      displayName: 'WP logs',
    })
  })
})
