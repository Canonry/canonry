import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { RunKinds } from '@ainyc/canonry-contracts'

import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'
import { queryKeys } from '../src/queries/query-keys.js'

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

function invalidatedKeys(): unknown[] {
  return invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey)
}

test('always invalidates the shared runs and projects keys', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.runs.all)
  expect(invalidatedKeys()).toContainEqual(queryKeys.projects.all)
})

test('invalidates GSC project key for gsc-sync runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['gsc-sync'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.gsc.project('demo'))
})

test('invalidates GSC project key for inspect-sitemap runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['inspect-sitemap'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.gsc.project('demo'))
})

test('invalidates Bing project key for bing-inspect runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['bing-inspect'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.bing.project('demo'))
})

test('invalidates Bing project key for bing-inspect-sitemap runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['bing-inspect-sitemap'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.bing.project('demo'))
})

test('invalidates traffic project key for ga-sync runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['ga-sync'], 'demo')
  expect(invalidatedKeys()).toContainEqual(queryKeys.traffic.project('demo'))
})

test('does not invalidate domain-scoped keys for answer-visibility runs', () => {
  invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], 'demo')
  const keys = invalidatedKeys()
  expect(keys).not.toContainEqual(queryKeys.gsc.project('demo'))
  expect(keys).not.toContainEqual(queryKeys.bing.project('demo'))
  expect(keys).not.toContainEqual(queryKeys.traffic.project('demo'))
})
