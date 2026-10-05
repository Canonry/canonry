import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { ainycComparison, ainycMentionShare, ainycMovement } from './ainyc-visibility-fixture.js'

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

const emptyCompetitorLandscape = {
  window: '30d',
  scope: { kind: 'project' },
  project: {
    domain: 'citypoint.example',
    label: 'Citypoint Dental NYC',
    surfaceClass: 'own',
    pinned: false,
    mentionCount: 0,
    shareOfVoice: null,
    citationCount: 0,
    answeredResults: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleUrls: [],
  },
  pinned: [],
  observed: [],
  otherSources: [],
  evidence: {
    answeredResults: 0,
    sourceResults: 0,
    missingAnswerTextResults: 0,
    mentionCredits: 0,
    incompleteSourceResults: 0,
    excludedProbeResults: 0,
    excludedNonCompletedResults: 0,
  },
  marketState: null,
  filters: {
    scope: 'project',
    groupKey: null,
    provider: null,
    queryClass: 'non-brand',
    location: null,
    runId: null,
  },
  truncated: false,
}

const score = (label: string) => ({ label, value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] })

/** GET /overview after a completed sweep, enough for the Simple cards to read their own data. */
const baselineOverview = {
  project,
  latestRun: { totalRuns: 2, run: null },
  health: null,
  topInsights: [],
  queryCounts: { totalQueries: 14, citedQueries: 7, notCitedQueries: 7, citedRate: 0.5, mentionedQueries: 7, notMentionedQueries: 7, mentionRate: 0.5 },
  providers: [],
  transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
  scores: {
    mention: score('Mention Coverage'),
    visibility: score('Answer Visibility'),
    mentionShare: ainycMentionShare(),
    gapQueries: score('Gap Queries'),
    mentionGaps: score('Mention Gaps'),
    indexCoverage: score('Index Coverage'),
    competitorPressure: score('Competitor Pressure'),
    runStatus: score('Run Status'),
  },
  movementSummary: ainycMovement(),
  citationMovement: ainycMovement(),
  mentionMovement: ainycMovement(),
  movementComparison: ainycComparison(),
  competitors: [],
  attentionItems: [],
  runHistory: [],
  contextLabel: 'US / EN',
}

async function renderEmbedOverview(overview: unknown, projectTabs = ['overview']) {
  window.__CANONRY_CONFIG__ = {
    embed: {
      enabled: true,
      projectTabs,
      renderToken: 'render-token-callgraph',
    },
  }

  const observed = new Set<string>()
  const observedMethods: Array<{ path: string; method: string }> = []
  const disallowed: string[] = []
  const restoreFetch = (() => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = canonicalPath(input)
      observed.add(path)
      observedMethods.push({
        path,
        method: input instanceof Request ? input.method : init?.method ?? 'GET',
      })

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
      if (path === '/api/v1/projects/citypoint/overview') return jsonResponse(overview)
      if (path === '/api/v1/projects/citypoint/analytics/metrics') return jsonResponse(emptyMetrics)
      if (path === '/api/v1/projects/citypoint/analytics/competitors?window=30d&queryClass=non-brand') return jsonResponse(emptyCompetitorLandscape)
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
  return { observed, observedMethods, disallowed }
}

test('embed project overview only issues reads covered by the overview server allowlist', async () => {
  const { observed, observedMethods, disallowed } = await renderEmbedOverview(null)

  await waitFor(() => {
    expect(observed.has('/api/v1/projects/citypoint/citations/visibility')).toBe(true)
    expect(observed.has('/api/v1/projects/citypoint/analytics/metrics')).toBe(true)
  })
  expect(observed.has('/api/v1/projects/citypoint/analytics/competitors?window=30d&queryClass=non-brand')).toBe(false)
  fireEvent.click(await screen.findByText('Competitor history', { selector: 'summary, summary > span' }))
  await waitFor(() => expect(observed.has('/api/v1/projects/citypoint/analytics/competitors?window=30d&queryClass=non-brand')).toBe(true))
  expect(await screen.findByText('Competitors over time', { selector: 'h2' })).toBeTruthy()

  expect(disallowed).toEqual([])
  expect(observedMethods.filter(request => request.path.includes('/analytics/competitors'))).toEqual([
    { path: '/api/v1/projects/citypoint/analytics/competitors?window=30d&queryClass=non-brand', method: 'GET' },
  ])
  expect(Array.from(observed).some(path => path.startsWith('/api/v1/settings'))).toBe(false)
})

test('an embed with a completed sweep renders the competitive card from /overview alone', async () => {
  const { observed, disallowed } = await renderEmbedOverview(baselineOverview)

  // "Where competitors are winning" reads mention share and both gap counts
  // from GET /overview, so it needs no read beyond the overview allowlist.
  expect(await screen.findByText('Where competitors are winning', { selector: 'h2' })).toBeTruthy()
  expect(await screen.findByText('Mention gaps')).toBeTruthy()
  expect(disallowed).toEqual([])
  expect(Array.from(observed).some(path => path.includes('/analytics/gaps'))).toBe(false)
})

test.each([[['report']], [['report', 'overview']], [['report', 'technical-aeo']]])(
  'a retired Report embed does not issue project analytics reads: %j',
  async (projectTabs) => {
    const { observed } = await renderEmbedOverview(null, projectTabs)
    expect(await screen.findByText(/This embed uses the retired Report tab/)).toBeTruthy()
    expect([...observed].filter(path => path.startsWith('/api/v1/projects/citypoint'))).toEqual([])
    expect(screen.queryByRole('navigation', { name: 'Project views' })).toBeNull()
  },
)
