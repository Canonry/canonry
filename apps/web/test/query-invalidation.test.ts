import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import {
  invalidateProjectQueryDomain,
  PROJECT_QUERY_DOMAINS,
} from '../src/queries/query-invalidation.js'

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

test('a completed SEO profile refresh leaves other profiles and projects cached', async () => {
  const queryClient = new QueryClient()
  const keys = [
    [{ _id: 'getApiV1ProjectsByNameSeoOverview', path: { name: 'alpha' }, query: { profileId: 'france' } }],
    [{ _id: 'getApiV1ProjectsByNameSeoRankedKeywords', path: { name: 'alpha' }, query: { profileId: 'france', runId: 'saved' } }],
    [{ _id: 'getApiV1ProjectsByNameSeoOverview', path: { name: 'alpha' }, query: { profileId: 'germany' } }],
    [{ _id: 'getApiV1ProjectsByNameSeoOverview', path: { name: 'beta' }, query: { profileId: 'france' } }],
    [{ _id: 'getApiV1ProjectsByNameGoogleGscCoverage', path: { name: 'alpha' } }],
  ]
  for (const key of keys) queryClient.setQueryData(key, { saved: true })
  await invalidateProjectQueryDomain(queryClient, 'seo', { projectName: 'alpha', profileId: 'france' })
  expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, false, false, false])
  queryClient.clear()
})
