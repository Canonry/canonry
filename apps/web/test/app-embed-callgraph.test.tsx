import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'

import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function canonicalPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input)
  const parsed = new URL(raw, window.location.origin)
  parsed.searchParams.delete('token')
  const search = parsed.searchParams.toString()
  return `${parsed.pathname}${search ? `?${search}` : ''}`
}

const project = {
  id: 'project_citypoint',
  name: 'citypoint',
  displayName: 'Citypoint Dental NYC',
  canonicalDomain: 'citypoint.example',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  tags: [],
  labels: {},
  providers: [],
  locations: [],
  defaultLocation: null,
  autoExtractBacklinks: false,
  configSource: 'cli',
  configRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const rate = { numerator: 1, denominator: 1, rate: 1 }

// This is the one aggregate read the embed overview uses. Keep it a valid
// shared-report response: returning a permissive empty object here would let a
// legacy fallback hide an accidental call outside the embed allowlist.
const visibilityReport = visibilityReportResponseSchema.parse({
  selection: {
    mode: 'simple',
    queryClass: 'non-brand',
    scope: { id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 },
    provider: null,
    model: null,
    location: { kind: 'all' },
    time: { from: null, to: null },
    revision: null,
    run: { id: 'run-embed-callgraph', explicit: false },
    provenance: { kind: 'frozen-simple', definitionRevision: null },
    measurement: {
      state: 'measured',
      activeRevision: null,
      measuredRevision: null,
      awaitingSweep: false,
      pendingAssignmentCount: 0,
      completedAt: '2026-09-04T12:05:00.000Z',
    },
    availability: { state: 'available' },
  },
  scopeOptions: [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 }],
  filterOptions: {
    providers: ['openai'],
    models: [{ provider: 'openai', model: 'search-model' }],
    locations: [{ kind: 'all' }],
  },
  populations: [{
    queryClass: 'non-brand',
    summary: {
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: rate,
      citationCoverage: rate,
      propertyReach: rate,
      outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
    },
    trend: [{
      runId: 'run-embed-callgraph',
      createdAt: '2026-09-04T12:05:00.000Z',
      revision: null,
      provenance: { kind: 'frozen-simple', definitionRevision: null },
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: rate,
      citationCoverage: rate,
      continuity: { state: 'first', comparedRunId: null },
    }],
    queries: {
      items: [{
        queryKey: 'embed-callgraph-query',
        queryId: 'query-embed-callgraph',
        query: 'emergency dentist near me',
        provider: 'openai',
        model: 'search-model',
        location: null,
        targetKeys: ['citypoint'],
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
      }],
      nextCursor: null,
      total: 1,
    },
    evidence: { items: [], nextCursor: null, total: 0 },
    competitorAvailability: { state: 'available' },
    competitors: [],
    observedCompetitors: [],
    breakdown: {
      properties: [{ id: 'citypoint', label: 'Citypoint Dental NYC', queryCount: 1, mentionCoverage: rate, citationCoverage: rate }],
      groups: [],
    },
  }],
})

test('embed project overview only issues reads covered by the overview server allowlist', async () => {
  window.__CANONRY_CONFIG__ = {
    embed: {
      enabled: true,
      projectTabs: ['overview'],
      renderToken: 'render-token-callgraph',
    },
  }

  const observed = new Set<string>()
  const disallowed: string[] = []
  const restoreFetch = (() => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = canonicalPath(input)
      observed.add(path)

      if (path === '/health') return jsonResponse({ version: 'test', databaseUrlConfigured: true })
      if (path === '/api/v1/projects') return jsonResponse([project])
      if (path === '/api/v1/runs?kind=answer-visibility') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint') return jsonResponse(project)
      if (path === '/api/v1/projects/citypoint/runs?kind=answer-visibility') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/queries') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/competitors') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/timeline?limit=20') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/google/gsc/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/bing/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/insights') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/overview') return jsonResponse(null)
      if (path.startsWith('/api/v1/projects/citypoint/visibility-report?')) return jsonResponse(visibilityReport)

      if (path.startsWith('/api/v1/')) {
        disallowed.push(path)
        return jsonResponse({ error: 'outside embed overview allowlist' }, 403)
      }
      return jsonResponse({}, 404)
    }) as typeof fetch
    return () => {
      globalThis.fetch = realFetch
    }
  })()
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/citypoint'] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(Array.from(observed).some(path => path.startsWith('/api/v1/projects/citypoint/visibility-report?'))).toBe(true)
  })

  expect(disallowed).toEqual([])
  expect(Array.from(observed).some(path => path.startsWith('/api/v1/projects/citypoint/analytics/metrics'))).toBe(false)
  expect(Array.from(observed).some(path => path.startsWith('/api/v1/projects/citypoint/citations/visibility'))).toBe(false)
  expect(Array.from(observed).some(path => path.startsWith('/api/v1/settings'))).toBe(false)
})
