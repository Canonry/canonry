import { expect, onTestFinished, test } from 'vitest'

import { advancedMeasurementService } from '../src/components/project/advanced-measurement/service.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

test('keeps a caller-owned receipt key when replacing draft query text', async () => {
  let observed: { path: string; body?: unknown; headers?: HeadersInit } | undefined
  const restoreFetch = mockFetch((url, init) => {
    observed = {
      path: pathOf(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers,
    }
    return jsonResponse({
      etag: '"mpd_8"',
      changed: true,
      warnings: [],
      counts: { targets: 1, includedTargets: 1, assignments: 1, unclassifiedAssignments: 0, groups: 0, competitors: 0 },
      previousQueryId: 'query_old',
      replacementQuery: { id: 'query_new', query: 'Which apartments fit a growing team?', createdAt: '2026-08-30T00:00:00.000Z' },
    })
  })
  onTestFinished(restoreFetch)

  await advancedMeasurementService.replaceQuery(
    'northstar-demo',
    '"mpd_7"',
    { queryId: 'query_old', queryText: 'Which apartments fit a growing team?' },
    'replace-query-receipt-1',
  )

  expect(observed?.path).toBe('/api/v1/projects/northstar-demo/measurement-plan/draft/actions/replace-query')
  expect(observed?.body).toEqual({ queryId: 'query_old', queryText: 'Which apartments fit a growing team?' })
  const headers = new Headers(observed?.headers)
  expect(headers.get('If-Match')).toBe('"mpd_7"')
  expect(headers.get('Idempotency-Key')).toBe('replace-query-receipt-1')
})
