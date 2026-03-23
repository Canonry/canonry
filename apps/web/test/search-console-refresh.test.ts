import { test, expect, onTestFinished, describe } from 'vitest'

import { triggerGscSync, fetchRunDetail, inspectBingUrl } from '../src/api.js'

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

describe('triggerGscSync', () => {
  test('returns run object on success', async () => {
    const restore = mockFetch(() => jsonResponse({ id: 'run-1', status: 'pending' }))
    onTestFinished(restore)

    const result = await triggerGscSync('my-project')
    expect(result).toEqual({ id: 'run-1', status: 'pending' })
  })

  test('throws on non-ok response', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'not found' }, 404))
    onTestFinished(restore)

    await expect(triggerGscSync('missing')).rejects.toThrow()
  })
})

describe('fetchRunDetail polling', () => {
  test('returns terminal status', async () => {
    const restore = mockFetch(() => jsonResponse({ id: 'run-1', status: 'completed' }))
    onTestFinished(restore)

    const detail = await fetchRunDetail('run-1')
    expect(detail.status).toBe('completed')
  })

  test('handles failed status', async () => {
    const restore = mockFetch(() => jsonResponse({ id: 'run-1', status: 'failed' }))
    onTestFinished(restore)

    const detail = await fetchRunDetail('run-1')
    expect(detail.status).toBe('failed')
  })
})

describe('Bing concurrency batching', () => {
  test('inspectBingUrl calls are made per-url', async () => {
    const calls: string[] = []
    const restore = mockFetch((url) => {
      calls.push(url as string)
      return jsonResponse({ url: 'https://example.com', status: 'Submitted' })
    })
    onTestFinished(restore)

    const urls = ['https://example.com/a', 'https://example.com/b']
    await Promise.allSettled(urls.map((url) => inspectBingUrl('proj', url)))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/bing/inspect')
    expect(calls[1]).toContain('/bing/inspect')
  })
})
