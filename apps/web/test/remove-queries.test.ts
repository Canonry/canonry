import { test, expect, onTestFinished, describe } from 'vitest'

import { removeQueries } from '../src/api.js'
import { mockFetch, pathOf, jsonResponse } from './mock-fetch.js'

/**
 * Contract for the `removeQueries` web wrapper, which backs the "Manage
 * queries → Remove" affordance on the project page. It must issue a
 * `DELETE /projects/:name/queries` with the query texts in the body and
 * surface the server's remaining-queries response back to the caller.
 */
describe('removeQueries', () => {
  test('issues DELETE /projects/:name/queries with the query texts and returns the remaining set', async () => {
    let observed: { url: string; method?: string; body?: string } | undefined
    const remaining = [{ id: 'q1', query: 'kept query', createdAt: '2026-06-03T00:00:00.000Z' }]
    const restore = mockFetch((url, init) => {
      observed = { url, method: init?.method, body: init?.body ? String(init.body) : undefined }
      return jsonResponse(remaining)
    })
    onTestFinished(restore)

    const result = await removeQueries('demo project', ['old query', 'stale query'])

    expect(observed?.method).toBe('DELETE')
    // Path param is URL-encoded by the generated SDK.
    expect(pathOf(observed?.url ?? '')).toBe('/api/v1/projects/demo%20project/queries')
    expect(JSON.parse(observed?.body ?? '{}')).toEqual({ queries: ['old query', 'stale query'] })
    // The caller receives the server's remaining-queries payload verbatim.
    expect(result).toEqual(remaining)
  })
})
