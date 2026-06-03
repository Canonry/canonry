import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { RunKinds } from '@ainyc/canonry-contracts'

import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'

let queryClient: QueryClient
let invalidateSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
})

afterEach(() => {
  invalidateSpy.mockRestore()
  queryClient.clear()
})

/**
 * The new predicate-based invalidation calls `invalidateQueries({ predicate })`
 * with a function that matches against the generated `<op>QueryKey` shape
 * (`[{ _id: 'getApiV1...' }]`). Re-run the predicate against synthetic
 * query keys for each operation prefix the test cares about — that proves
 * the right "domain" was invalidated without coupling the test to the
 * legacy hierarchical `queryKeys.X.project(name)` registry.
 */
function predicateMatches(opId: string): boolean {
  const synthetic = { queryKey: [{ _id: opId }] } as unknown as Parameters<
    NonNullable<Parameters<typeof queryClient.invalidateQueries>[0]>['predicate'] extends infer P
      ? P extends (...args: infer A) => unknown
        ? A[0]
        : never
      : never
  >[0]
  return invalidateSpy.mock.calls.some(([arg]) => {
    const predicate = (arg as { predicate?: (q: unknown) => boolean })?.predicate
    return typeof predicate === 'function' && predicate(synthetic)
  })
}

test('always invalidates the shared runs and projects operations', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], 'demo')
  // Top-level runs / projects use direct queryKey invalidation (not a
  // predicate) so each call passes a `queryKey` arg with the generated
  // SDK key shape `[{_id: 'getApiV1Runs', ...}]` / `[{_id: 'getApiV1Projects', ...}]`.
  const exactKeyOpIds = invalidateSpy.mock.calls
    .map(([arg]) => (arg as { queryKey?: Array<{ _id?: string }> })?.queryKey?.[0]?._id)
    .filter((id): id is string => typeof id === 'string')
  expect(exactKeyOpIds).toContain('getApiV1Runs')
  expect(exactKeyOpIds).toContain('getApiV1Projects')
})

test('invalidates GSC operations for gsc-sync runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['gsc-sync'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameGoogleGscCoverage')).toBe(true)
  expect(predicateMatches('getApiV1ProjectsByNameGoogleGscPerformance')).toBe(true)
})

test('invalidates GSC operations for inspect-sitemap runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['inspect-sitemap'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameGoogleGscSitemaps')).toBe(true)
})

test('invalidates Bing operations for bing-inspect runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['bing-inspect'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameBingInspections')).toBe(true)
  expect(predicateMatches('getApiV1ProjectsByNameBingCoverage')).toBe(true)
})

test('invalidates Bing operations for bing-inspect-sitemap runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['bing-inspect-sitemap'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameBingCoverage')).toBe(true)
})

test('invalidates GA operations for ga-sync runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['ga-sync'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameGaTraffic')).toBe(true)
  expect(predicateMatches('getApiV1ProjectsByNameGaStatus')).toBe(true)
})

test('invalidates GBP operations for gbp-sync runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['gbp-sync'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameGbpSummary')).toBe(true)
  expect(predicateMatches('getApiV1ProjectsByNameGbpKeywords')).toBe(true)
})

test('does not invalidate domain-scoped operations for answer-visibility runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], 'demo')
  expect(predicateMatches('getApiV1ProjectsByNameGoogleGscCoverage')).toBe(false)
  expect(predicateMatches('getApiV1ProjectsByNameBingCoverage')).toBe(false)
  expect(predicateMatches('getApiV1ProjectsByNameGaTraffic')).toBe(false)
  expect(predicateMatches('getApiV1ProjectsByNameGbpSummary')).toBe(false)
})
