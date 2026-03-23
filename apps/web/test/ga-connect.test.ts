import { test, expect, onTestFinished, describe } from 'vitest'

import { connectGa } from '../src/api.js'

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

describe('connectGa', () => {
  test('sends property ID and key JSON, returns connection info', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    let capturedMethod = ''

    const restore = mockFetch((url, init) => {
      capturedUrl = url
      capturedBody = init?.body as string
      capturedMethod = init?.method ?? 'GET'
      return jsonResponse({ connected: true, propertyId: '123456', clientEmail: 'sa@test.iam.gserviceaccount.com' })
    })
    onTestFinished(restore)

    const result = await connectGa('my-project', {
      propertyId: '123456',
      keyJson: '{"client_email":"sa@test.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}',
    })

    expect(capturedMethod).toBe('POST')
    expect(capturedUrl).toContain('/projects/my-project/ga/connect')
    expect(JSON.parse(capturedBody)).toEqual({
      propertyId: '123456',
      keyJson: '{"client_email":"sa@test.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}',
    })
    expect(result).toEqual({
      connected: true,
      propertyId: '123456',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
    })
  })

  test('encodes project name in URL', async () => {
    let capturedUrl = ''
    const restore = mockFetch((url) => {
      capturedUrl = url
      return jsonResponse({ connected: true, propertyId: '1', clientEmail: 'a@b.com' })
    })
    onTestFinished(restore)

    await connectGa('project with spaces', { propertyId: '1', keyJson: '{}' })
    expect(capturedUrl).toContain('/projects/project%20with%20spaces/ga/connect')
  })

  test('throws on non-ok response', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'Invalid key' }, 400))
    onTestFinished(restore)

    await expect(
      connectGa('proj', { propertyId: '1', keyJson: '{}' }),
    ).rejects.toThrow()
  })
})
