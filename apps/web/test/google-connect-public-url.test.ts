import { describe, expect, onTestFinished, test } from 'vitest'

import { googleConnect, resolveLocalGooglePublicUrl } from '../src/api.js'

interface Observed {
  method: string | undefined
  body: BodyInit | null | undefined
}

function mockFetch(handler: (req: Observed) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let method: string | undefined
    let body: BodyInit | null | undefined
    if (input instanceof Request) {
      method = input.method
      body = init?.body ?? (await input.clone().text().then((text) => (text.length ? text : null)).catch(() => null))
    } else {
      method = init?.method
      body = init?.body
    }
    return handler({ method, body })
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Google OAuth public URL', () => {
  test('normalizes loopback browser hosts to localhost', () => {
    expect(resolveLocalGooglePublicUrl({ protocol: 'http:', hostname: '127.0.0.1', port: '4100' }, '/canonry/'))
      .toBe('http://localhost:4100/canonry')
    expect(resolveLocalGooglePublicUrl({ protocol: 'http:', hostname: '[::1]', port: '4100' }))
      .toBe('http://localhost:4100')
    expect(resolveLocalGooglePublicUrl({ protocol: 'https:', hostname: 'example.com', port: '' }))
      .toBeUndefined()
  })

  test('googleConnect sends a local publicUrl for dashboard-initiated OAuth', async () => {
    const win = window as typeof window & { __CANONRY_CONFIG__?: { basePath?: string } }
    const previousConfig = win.__CANONRY_CONFIG__
    win.__CANONRY_CONFIG__ = { basePath: '/canonry/' }
    onTestFinished(() => {
      win.__CANONRY_CONFIG__ = previousConfig
    })

    let observed: Observed | undefined
    const restore = mockFetch((req) => {
      observed = req
      return jsonResponse({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
        redirectUri: 'http://localhost:4100/canonry/api/v1/google/callback',
      })
    })
    onTestFinished(restore)

    const expectedPublicUrl = resolveLocalGooglePublicUrl(window.location, '/canonry/')
    expect(expectedPublicUrl).toBeTruthy()

    await googleConnect('elkemi', 'gsc')

    expect(observed?.method).toBe('POST')
    expect(JSON.parse(String(observed?.body))).toEqual({
      type: 'gsc',
      publicUrl: expectedPublicUrl,
    })
  })
})
