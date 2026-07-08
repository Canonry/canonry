import { test, expect, onTestFinished, describe } from 'vitest'

import { appendEmbedRenderToken, connectServerTrafficWordpress, fetchProjects, installBacklinks, loginWithPassword, triggerGscSync } from '../src/api.js'

/**
 * After the hey-api migration the SDK calls `fetch(new Request(...))` —
 * a single `Request` object instead of `(url, init)`. These helpers
 * normalize both call shapes so the assertions don't care which
 * transport built the request.
 */
interface Observed {
  url: string
  /** Path-only portion of `url` (drops scheme + host + basePath prefix). */
  path: string
  method: string | undefined
  body: BodyInit | null | undefined
  headers: Headers
}

function mockFetch(handler: (req: Observed) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    let method: string | undefined
    let body: BodyInit | null | undefined
    let headers: Headers
    if (input instanceof Request) {
      url = input.url
      method = input.method
      body = init?.body ?? (await input.clone().text().then((t) => (t.length ? t : null)).catch(() => null))
      headers = new Headers(input.headers)
    } else {
      url = String(input)
      method = init?.method
      body = init?.body
      headers = new Headers(init?.headers as HeadersInit | undefined)
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '') || url
    return handler({ url, path, method, body, headers })
  }) as typeof fetch
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

function withEmbedRenderToken(token: string): () => void {
  const previous = window.__CANONRY_CONFIG__
  window.__CANONRY_CONFIG__ = { embed: { enabled: true, renderToken: token } }
  return () => {
    window.__CANONRY_CONFIG__ = previous
  }
}

describe('apiFetch Content-Type header', () => {
  test('omits Content-Type on POST without body (Fastify rejects empty JSON bodies)', async () => {
    let observed: Observed | undefined
    const restore = mockFetch((req) => {
      observed = req
      return jsonResponse({ status: 'ok' })
    })
    onTestFinished(restore)

    await installBacklinks()

    expect(observed?.method).toBe('POST')
    expect(observed?.body).toBeFalsy()
    expect(observed?.headers.get('content-type')).toBeNull()
  })

  test('sets Content-Type on requests with a body', async () => {
    let observed: Observed | undefined
    const restore = mockFetch((req) => {
      observed = req
      return jsonResponse({ id: 'run-1', status: 'pending' })
    })
    onTestFinished(restore)

    await triggerGscSync('demo', { days: 7 })

    expect(observed?.method).toBe('POST')
    expect(observed?.body).toBeTruthy()
    expect(observed?.headers.get('content-type')).toBe('application/json')
  })

  test('posts WordPress traffic connects to the adapter-specific endpoint', async () => {
    let observed: Observed | undefined
    const restore = mockFetch((req) => {
      observed = req
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

    expect(observed?.path).toBe('/api/v1/projects/demo%20project/traffic/connect/wordpress')
    expect(observed?.method).toBe('POST')
    expect(observed?.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(observed?.body))).toEqual({
      baseUrl: 'https://example.com',
      username: 'admin',
      applicationPassword: 'xxxx xxxx',
      displayName: 'WP logs',
    })
  })

  test('appends the embed render token to generated SDK API requests', async () => {
    let observed: Observed | undefined
    const restoreFetch = mockFetch((req) => {
      observed = req
      return jsonResponse([])
    })
    const restoreConfig = withEmbedRenderToken('render-token-123')
    onTestFinished(() => {
      restoreFetch()
      restoreConfig()
    })

    await fetchProjects()

    expect(observed?.path).toBe('/api/v1/projects?token=render-token-123')
  })

  test('appends the embed render token to generated SDK API requests with bodies', async () => {
    let observed: Observed | undefined
    const restoreFetch = mockFetch((req) => {
      observed = req
      return jsonResponse({ id: 'run-1', status: 'queued' })
    })
    const restoreConfig = withEmbedRenderToken('render-token-body')
    onTestFinished(() => {
      restoreFetch()
      restoreConfig()
    })

    await triggerGscSync('demo', { days: 7 })

    expect(observed?.path).toBe('/api/v1/projects/demo/google/gsc/sync?token=render-token-body')
    expect(observed?.method).toBe('POST')
    expect(observed?.body).toBeTruthy()
  })

  test('only appends the embed render token to same-origin canonical API paths', () => {
    const restoreConfig = withEmbedRenderToken('render-token-safe')
    onTestFinished(restoreConfig)

    expect(appendEmbedRenderToken('/api/v1/projects')).toBe('/api/v1/projects?token=render-token-safe')
    expect(appendEmbedRenderToken('/nested/api/v1ish/projects')).toBe('/nested/api/v1ish/projects')
    expect(appendEmbedRenderToken('https://example.test/api/v1/projects')).toBe('https://example.test/api/v1/projects')
  })

  test('appends the embed render token to raw apiFetch requests', async () => {
    let observed: Observed | undefined
    const restoreFetch = mockFetch((req) => {
      observed = req
      return jsonResponse({ authenticated: true })
    })
    const restoreConfig = withEmbedRenderToken('render-token-456')
    onTestFinished(() => {
      restoreFetch()
      restoreConfig()
    })

    await loginWithPassword('pw')

    expect(observed?.path).toBe('/api/v1/session?token=render-token-456')
  })
})
