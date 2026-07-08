import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

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

const emptyMetrics = {
  window: 'all',
  buckets: [],
  overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
  byProvider: {},
  trend: 'stable',
  mentionTrend: 'stable',
  queryChanges: [],
}

const emptyCitationVisibility = {
  summary: {
    providersConfigured: 0,
    providersCiting: 0,
    providersMentioning: 0,
    totalQueries: 0,
    queriesCitedAndMentioned: 0,
    queriesCitedOnly: 0,
    queriesMentionedOnly: 0,
    queriesInvisible: 0,
    latestRunId: null,
    latestRunAt: null,
  },
  byQuery: [],
  competitorGaps: [],
  status: 'no-data',
  reason: 'no-runs-yet',
}

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
      if (path === '/api/v1/projects/citypoint/timeline') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/google/gsc/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/bing/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/insights') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/overview') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/analytics/metrics') return jsonResponse(emptyMetrics)
      if (path === '/api/v1/projects/citypoint/citations/visibility') return jsonResponse(emptyCitationVisibility)

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
    expect(observed.has('/api/v1/projects/citypoint/citations/visibility')).toBe(true)
    expect(observed.has('/api/v1/projects/citypoint/analytics/metrics')).toBe(true)
  })

  expect(disallowed).toEqual([])
  expect(Array.from(observed).some(path => path.startsWith('/api/v1/settings'))).toBe(false)
})
