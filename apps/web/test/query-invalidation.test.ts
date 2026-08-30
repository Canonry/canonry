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

test('the measurement domain includes the server-derived per-query status endpoint', async () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

  await invalidateProjectQueryDomain(queryClient, 'measurement')

  const predicate = invalidate.mock.calls[0]?.[0]?.predicate
  expect(predicate).toBeTypeOf('function')
  const matches = (id: string) => predicate?.({ queryKey: [{ _id: id }] } as never)

  expect(matches('getApiV1ProjectsByNameMeasurementQueryStatuses')).toBe(true)
  expect(matches('getApiV1ProjectsByNameMeasurementOverview')).toBe(true)
  expect(matches('getApiV1ProjectsByNameQueries')).toBe(false)
})

test('tracked-basket and published-plan commits route through the measurement invalidation domain', () => {
  const sourceRoot = [
    join(process.cwd(), 'src'),
    join(process.cwd(), 'apps/web/src'),
  ].find(existsSync)
  if (!sourceRoot) throw new Error('Could not locate apps/web/src')
  const read = (relative: string) => readFileSync(join(sourceRoot, relative), 'utf8')

  // Append and direct add/remove cover the tracked basket. Discovery and
  // research promotions do too. Advanced draft changes become observable only
  // after publish or discard, both of which invoke the shared page callback.
  expect(read('queries/mutations.ts')).toContain("invalidateProjectQueryDomain(queryClient, 'measurement')")
  expect(read('components/project/DiscoverySection.tsx')).toContain("invalidateProjectQueryDomain(queryClient, 'measurement')")
  expect(read('components/project/ResearchQueriesSection.tsx')).toContain("invalidateProjectQueryDomain(queryClient, 'measurement')")
  expect(read('pages/ProjectPage.tsx')).toContain("invalidateProjectQueryDomain(queryClient, 'measurement')")
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
