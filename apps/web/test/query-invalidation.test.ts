import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { RunKinds } from '@ainyc/canonry-contracts'

import {
  invalidateProjectQueryDomain,
  invalidateQueryTrackingPublication,
  PROJECT_QUERY_DOMAINS,
} from '../src/queries/query-invalidation.js'
import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

test('the Google connection domain includes connection-owned and GSC queries', async () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

  await invalidateProjectQueryDomain(queryClient, 'google')

  const predicate = invalidate.mock.calls[0]?.[0]?.predicate
  expect(predicate).toBeTypeOf('function')
  const matches = (id: string) => predicate?.({ queryKey: [{ _id: id }] } as never)

  expect(matches('getApiV1ProjectsByNameGoogleConnections')).toBe(true)
  expect(matches('getApiV1ProjectsByNameGoogleProperties')).toBe(true)
  expect(matches('getApiV1ProjectsByNameGoogleGscCoverage')).toBe(true)
  expect(matches('getApiV1ProjectsByNameGaStatus')).toBe(false)
  expect(matches('getApiV1ProjectsByNameBingStatus')).toBe(false)
})

// The generated operation of GET /projects/{name}/query-tracking/results, and its cache key for one project and place.
const RESULTS_READ = 'getApiV1ProjectsByNameQueryTrackingResults'
const WORKSPACE_READ = 'getApiV1ProjectsByNameQueryTracking'
const readKey = (id: string, name: string, query?: Record<string, string>) => [{ _id: id, baseUrl: '', path: { name }, ...(query ? { query } : {}) }]

test('a tracking publish refreshes the results read of every place in that project only', async () => {
  const queryClient = new QueryClient()
  const published = [readKey(RESULTS_READ, 'demo'), readKey(RESULTS_READ, 'demo', { scope: 'market', scopeKey: 'north' }), readKey(WORKSPACE_READ, 'demo')]
  const untouched = [readKey(RESULTS_READ, 'other'), readKey(WORKSPACE_READ, 'other')]
  for (const key of [...published, ...untouched]) queryClient.setQueryData(key, {})

  await invalidateQueryTrackingPublication(queryClient, 'demo')

  expect(published.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true])
  expect(untouched.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([false, false])
})

test('a finished sweep refetches a mounted results read once', async () => {
  const queryClient = new QueryClient()
  const key = readKey(RESULTS_READ, 'demo')
  const read = vi.fn(async () => ({ rows: [] }))
  const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn: read, staleTime: Infinity }).subscribe(() => {})
  await vi.waitFor(() => expect(queryClient.getQueryData(key)).toEqual({ rows: [] }))
  expect(read).toHaveBeenCalledTimes(1)

  invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], 'demo')

  // Two invalidations of the same read would cancel the first refetch and send a second request.
  await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: key })).toBe(0))
  expect(read).toHaveBeenCalledTimes(2)
  unsubscribe()
  queryClient.clear()
})

test('keeps generated operation-prefix matching in the typed domain registry', () => {
  const sourceRoot = [
    join(process.cwd(), 'src'),
    join(process.cwd(), 'apps/web/src'),
  ].find(existsSync)
  if (!sourceRoot) throw new Error('Could not locate apps/web/src')
  const registryPath = join(sourceRoot, 'queries/query-invalidation.ts')
  const violations = sourceFiles(sourceRoot)
    .filter((path) => path !== registryPath)
    .filter((path) => /\.startsWith\(\s*['"]getApiV1/.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(sourceRoot.length + 1))

  expect(violations).toEqual([])
  expect(Object.keys(PROJECT_QUERY_DOMAINS).length).toBeGreaterThan(0)
})
