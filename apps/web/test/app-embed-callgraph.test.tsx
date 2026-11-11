import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { CitationStates, RunKinds, RunStatuses, RunTriggers, visibilityReportResponseSchema } from '@canonry/canonry-contracts'

import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { ainycComparison, ainycMentionShare, ainycMovement } from './ainyc-visibility-fixture.js'
import { COMPETITOR_COMPARISON_COPY } from '../src/pages/ProjectPage.js'

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
  overall: { citationRate: 0, cited: 0, total: 0, citationNotMeasured: 0, mentionRate: 0, mentionedCount: 0 },
  byProvider: {},
  trend: 'stable',
  mentionTrend: 'stable',
  queryChanges: [],
}

const completedRun = { id: 'run-citypoint-baseline', projectId: project.id, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: '2026-11-06T12:00:00.000Z', startedAt: '2026-11-06T12:00:00.000Z', finishedAt: '2026-11-06T12:01:00.000Z' }
const completedAnswer = { id: 'snapshot-citypoint', runId: completedRun.id, queryId: 'query-dentist', query: 'dentist near me', provider: 'gemini', model: 'gemini-test', citationState: CitationStates.cited, answerMentioned: true, answerText: 'Citypoint Dental NYC is one option.', citedDomains: ['citypoint.example'], citedUrls: ['https://citypoint.example'], createdAt: completedRun.finishedAt }

const baselineReport = visibilityReportResponseSchema.parse({
  selection: {
    mode: 'simple', queryClass: 'all', scope: { id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 },
    provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: null,
    run: { id: completedRun.id, explicit: false }, provenance: { kind: 'frozen-simple', definitionRevision: null },
    measurement: { state: 'measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: completedRun.finishedAt },
    availability: { state: 'available' },
  },
  scopeOptions: [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 }],
  filterOptions: { providers: ['gemini'], models: [{ provider: 'gemini', model: 'gemini-test' }], locations: [{ kind: 'none' }] },
  populations: (['branded', 'non-brand', 'unknown'] as const).map(queryClass => {
    const measured = queryClass === 'non-brand'
    const count = measured ? 1 : 0
    const rate = measured ? { numerator: 1, denominator: 1, rate: 1 } : { numerator: null, denominator: null, rate: null, reason: 'no-population' }
    return {
      queryClass,
      summary: { queryCount: count, answerCount: count, mentionCoverage: rate, citationCoverage: rate, propertyReach: rate, outcomes: { bothSignals: count, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: count } },
      trend: [], queries: { items: [], total: 0, nextCursor: null }, evidence: { items: [], total: 0, nextCursor: null },
      competitorAvailability: { state: 'available' }, competitors: [], observedCompetitors: [],
      breakdown: { properties: [], groups: [], providers: measured ? [{ provider: 'gemini', queryCount: 1, answerCount: 1, mentionCoverage: rate, citationCoverage: rate }] : [] },
    }
  }),
})

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
  latestRun: { totalRuns: 1, run: completedRun },
  health: null,
  topInsights: [],
  queryCounts: { totalQueries: 1, citedQueries: 1, notCitedQueries: 0, citedRate: 1, mentionedQueries: 1, notMentionedQueries: 0, mentionRate: 1 },
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

async function renderEmbedOverview(overview: typeof baselineOverview | null, projectTabs = ['overview']) {
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
      if (path === '/api/v1/runs?kind=answer-visibility') return jsonResponse(overview ? [completedRun] : [])
      if (path === '/api/v1/projects/citypoint') return jsonResponse(project)
      if (path === '/api/v1/projects/citypoint/runs?kind=answer-visibility') return jsonResponse(overview ? [completedRun] : [])
      if (path === `/api/v1/runs/${completedRun.id}` && overview) return jsonResponse({ ...completedRun, snapshots: [completedAnswer] })
      if (path === '/api/v1/projects/citypoint/queries') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/competitors') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/timeline?limit=20') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/google/gsc/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/bing/coverage') return jsonResponse(null)
      if (path === '/api/v1/projects/citypoint/insights') return jsonResponse([])
      if (path === '/api/v1/projects/citypoint/overview') return jsonResponse(overview)
      if (path === '/api/v1/projects/citypoint/analytics/metrics') return jsonResponse(emptyMetrics)
      if (path === '/api/v1/projects/citypoint/analytics/competitors?window=30d&queryClass=non-brand') return jsonResponse(emptyCompetitorLandscape)
      if (new URL(path, window.location.origin).pathname === '/api/v1/projects/citypoint/visibility-report' && overview) return jsonResponse(baselineReport)

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
    expect(observed.has('/api/v1/projects/citypoint/overview')).toBe(true)
    expect(observed.has('/api/v1/projects/citypoint/analytics/metrics')).toBe(true)
  })
  expect(screen.queryByRole('heading', { name: 'By engine' })).toBeNull()
  expect([...observed].some(path => path.includes('/visibility-report') || path.includes('/citations/visibility'))).toBe(false)
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

test('a completed embed keeps competitor comparison optional and reads engine counts from the canonical report', async () => {
  const { observed, observedMethods, disallowed } = await renderEmbedOverview(baselineOverview)

  const comparison = (await screen.findByRole('heading', { name: 'Compare competitors' })).closest('details')!
  expect(comparison.open).toBe(false)
  fireEvent.click(within(comparison).getByRole('heading', { name: 'Compare competitors' }).closest('summary')!)
  expect(comparison.open).toBe(true)
  // The embed fixture tracks no competitors, so gap rows would always read 0:
  // the empty state replaces them, and a read-only embed offers no add button.
  expect(within(comparison).getByText(COMPETITOR_COMPARISON_COPY.emptyTitle)).toBeTruthy()
  expect(within(comparison).queryByText('Mention gaps')).toBeNull()
  expect(within(comparison).queryByRole('button', { name: COMPETITOR_COMPARISON_COPY.add })).toBeNull()
  const engines = await screen.findByRole('table', { name: 'By engine, non-brand queries' })
  expect(within(engines).getByText('Gemini')).toBeTruthy()
  expect(within(engines).getAllByText('1 of 1 answers')).toHaveLength(2)
  const reports = observedMethods.filter(request => request.path.includes('/visibility-report'))
  expect(reports).toHaveLength(1)
  expect(reports[0]!.method).toBe('GET')
  const selection = new URL(reports[0]!.path, window.location.origin).searchParams
  expect(selection.get('queryClass')).toBe('all')
  expect(selection.get('limit')).toBe('1')
  expect(disallowed).toEqual([])
  expect(Array.from(observed).some(path => path.includes('/analytics/gaps'))).toBe(false)
  expect(Array.from(observed).some(path => path.includes('/citations/visibility'))).toBe(false)
  expect(observedMethods.every(request => request.method === 'GET')).toBe(true)
})

test.each([[['report']], [['report', 'overview']], [['report', 'agent-readiness']], [['report', 'technical-aeo']]])(
  'a retired Report embed does not issue project analytics reads: %j',
  async (projectTabs) => {
    const { observed } = await renderEmbedOverview(null, projectTabs)
    expect(await screen.findByText(/This embed uses the retired Report tab/)).toBeTruthy()
    expect([...observed].filter(path => path.startsWith('/api/v1/projects/citypoint'))).toEqual([])
    expect(screen.queryByRole('navigation', { name: 'Project views' })).toBeNull()
  },
)
