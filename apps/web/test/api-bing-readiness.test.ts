import { expect, onTestFinished, test } from 'vitest'

import { fetchConnectedBingCoverage } from '../src/api.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

test('skips Bing coverage when the project has no Bing connection', async () => {
  const requested: string[] = []
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    requested.push(path)
    if (path.endsWith('/bing/status')) {
      return jsonResponse({
        connected: false,
        domain: 'example.com',
        siteUrl: null,
        createdAt: null,
        updatedAt: null,
      })
    }
    return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'No Bing connection' } }, 400)
  })
  onTestFinished(restore)

  await expect(fetchConnectedBingCoverage('example')).resolves.toBeNull()
  expect(requested).toEqual(['/api/v1/projects/example/bing/status'])
})

test('reads Bing coverage after connection readiness is confirmed', async () => {
  const requested: string[] = []
  const coverage = {
    summary: { total: 1, indexed: 1, notIndexed: 0, unknown: 0, percentage: 100 },
    lastInspectedAt: '2026-09-01T12:00:00.000Z',
    indexed: [],
    notIndexed: [],
    unknown: [],
  }
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    requested.push(path)
    if (path.endsWith('/bing/status')) {
      return jsonResponse({
        connected: true,
        domain: 'example.com',
        siteUrl: 'https://example.com/',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
      })
    }
    if (path.endsWith('/bing/coverage')) return jsonResponse(coverage)
    return jsonResponse({}, 404)
  })
  onTestFinished(restore)

  await expect(fetchConnectedBingCoverage('example')).resolves.toEqual(coverage)
  expect(requested).toEqual([
    '/api/v1/projects/example/bing/status',
    '/api/v1/projects/example/bing/coverage',
  ])
})
