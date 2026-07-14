import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoQueryKey,
  getApiV1ProjectsByNameTechnicalAeoTrendQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { TechnicalAeoSection } from '../src/components/project/TechnicalAeoSection.js'
import { heyClient } from '../src/api.js'
import { resetRunTracker } from '../src/lib/run-tracker-store.js'
import { resetToasts } from '../src/lib/toast-store.js'

const projectName = 'citypoint'
const projectId = 'proj_1'
const scoreKey = getApiV1ProjectsByNameTechnicalAeoQueryKey({
  client: heyClient,
  path: { name: projectName },
})
const trendKey = getApiV1ProjectsByNameTechnicalAeoTrendQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { limit: 30 },
})
const pagesKey = getApiV1ProjectsByNameTechnicalAeoPagesQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { limit: 100, sort: 'score-asc' },
})
const auditRunsKey = getApiV1ProjectsByNameRunsQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { kind: 'site-audit', limit: 10 },
})

function score(runId: string, aggregateScore = 84) {
  return {
    project: projectName,
    hasData: true,
    runId,
    runStatus: 'completed',
    sitemapUrl: 'https://citypoint.example/sitemap.xml',
    auditedAt: '2026-07-14T18:16:33.000Z',
    aggregateScore,
    pagesDiscovered: 41,
    pagesAudited: 39,
    pagesSkipped: 2,
    pagesErrored: 0,
    deltaScore: 3,
    trend: 'up',
    previousScore: 81,
    previousAuditedAt: '2026-07-01T18:16:33.000Z',
    factors: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
  }
}

function run(id: string, status: string) {
  return {
    id,
    projectId,
    kind: 'site-audit',
    status,
    trigger: 'manual',
    location: null,
    startedAt: '2026-07-14T18:15:00.000Z',
    finishedAt: status === 'running' || status === 'queued' ? null : '2026-07-14T18:16:33.000Z',
    error: null,
    createdAt: '2026-07-14T18:15:00.000Z',
  }
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scoreKey, score('audit_old'))
  queryClient.setQueryData(trendKey, { project: projectName, points: [] })
  queryClient.setQueryData(pagesKey, { project: projectName, runId: 'audit_old', auditedAt: null, total: 0, pages: [] })
  return queryClient
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetRunTracker()
  resetToasts()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  resetRunTracker()
  resetToasts()
  vi.restoreAllMocks()
})

test('shows an active audit and prevents a duplicate re-run', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(auditRunsKey, [run('audit_running', 'running')])

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  expect((screen.getByRole('button', { name: 'Audit running' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Results refresh automatically when this audit finishes.')).not.toBeNull()
})

test('refreshes the score, trend, and pages when a newer audit completes', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(auditRunsKey, [run('audit_new', 'completed')])

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/pages')) {
      return jsonResponse({ project: projectName, runId: 'audit_new', auditedAt: null, total: 0, pages: [] })
    }
    if (url.includes('/technical-aeo/trend')) {
      return jsonResponse({ project: projectName, points: [] })
    }
    if (url.includes('/technical-aeo')) {
      return jsonResponse(score('audit_new', 90))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByText('90')).not.toBeNull())
  const fetchedUrls = fetchMock.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input))
  expect(fetchedUrls.some((url) => url.includes('/technical-aeo/pages'))).toBe(true)
  expect(fetchedUrls.some((url) => url.includes('/technical-aeo/trend'))).toBe(true)
})
