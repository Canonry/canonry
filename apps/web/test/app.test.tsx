import { test, expect, onTestFinished, vi, beforeAll } from 'vitest'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameVisibilityReportQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { fetchHealthCheck, fetchServiceStatus, heyClient } from '../src/api.js'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

// Routes are lazy-loaded in production (see
// `apps/web/src/router/routes.tsx → lazyRouteComponent(...)`).
// `renderToStaticMarkup` cannot suspend, so the lazy components must be
// preloaded before any test renders them — otherwise the page <main>
// element comes back empty. `preloadAllLazyRoutes` awaits every
// `.preload()` promise so the components are synchronously available.
beforeAll(async () => {
  await preloadAllLazyRoutes()
})

type TestWindowConfig = {
  __CANONRY_CONFIG__?: {
    basePath?: string
  }
}

/**
 * These render ONE synchronous pass with renderToStaticMarkup, so no query ever
 * settles. The project overview now waits for the measurement-plan read before
 * choosing between the legacy and advanced surfaces — previously "pending" and
 * "no plan" were the same value, which is the flash that guard removes — so a
 * never-settling plan query paints a skeleton forever here.
 *
 * Seeding "this project has no advanced plan" is the state these tests are
 * actually describing, and it is the same setup portfolio-route.test.tsx uses.
 */
function seedNoMeasurementPlan(queryClient: QueryClient, fixture: ReturnType<typeof createDashboardFixture>): void {
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: entry.project.name } }),
      { active: null },
    )
  }
}

function visibilityReportQuery(projectName: string, selection: VisibilitySelectionState) {
  return {
    client: heyClient,
    path: { name: projectName },
    query: {
      scope: selection.measurementScope,
      scopeKey: selection.measurementScopeKey,
      queryClass: selection.queryClass,
      provider: selection.provider,
      model: selection.model,
      location: selection.location,
      from: selection.from,
      to: selection.to,
      revision: selection.revision,
      runId: selection.measurementRunId,
      queryKey: selection.queryKey,
      limit: 50,
      cursor: undefined,
      search: undefined,
    },
  }
}

function visibilityReportFixture(selection: VisibilitySelectionState): VisibilityReportResponse {
  const rate = { numerator: 1, denominator: 1, rate: 1 }
  const classes = selection.queryClass === 'all'
    ? ['branded', 'non-brand', 'unknown'] as const
    : [selection.queryClass]
  const scopeKind = selection.measurementScope
  const scopeId = scopeKind === 'project' ? 'project' : selection.measurementScopeKey ?? `${scopeKind}-synthetic`

  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'simple',
      queryClass: selection.queryClass,
      scope: { id: scopeId, label: scopeKind === 'project' ? 'Whole site' : 'Selected scope', kind: scopeKind, targetCount: 1 },
      provider: null,
      model: null,
      location: { kind: 'all' },
      time: { from: null, to: null },
      revision: null,
      run: { id: 'run-synthetic', explicit: false },
      provenance: { kind: 'frozen-simple', definitionRevision: null },
      measurement: {
        state: 'measured',
        activeRevision: null,
        measuredRevision: null,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: '2026-09-04T12:00:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: scopeId, label: scopeKind === 'project' ? 'Whole site' : 'Selected scope', kind: scopeKind, targetCount: 1 }],
    filterOptions: {
      providers: ['openai'],
      models: [{ provider: 'openai', model: 'search-model' }],
      locations: [{ kind: 'all' }],
    },
    populations: classes.map(queryClass => ({
      queryClass,
      summary: {
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        propertyReach: rate,
        outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
      },
      trend: [{
        runId: 'run-synthetic',
        createdAt: '2026-09-04T12:00:00.000Z',
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
          queryKey: 'query-synthetic',
          queryId: 'query-synthetic',
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
      breakdown: { properties: [], groups: [] },
    })),
  })
}

function seedVisibilityReport(
  queryClient: QueryClient,
  fixture: ReturnType<typeof createDashboardFixture>,
  pathname: string,
): void {
  const url = new URL(pathname, 'http://localhost')
  const selection = parseVisibilitySelection(Object.fromEntries(url.searchParams.entries()))
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameVisibilityReportQueryKey(visibilityReportQuery(entry.project.name, selection)),
      visibilityReportFixture(selection),
    )
  }
}

async function renderApp(
  pathname: string,
  options: Parameters<typeof createDashboardFixture>[0] = {},
  mutateFixture?: (fixture: ReturnType<typeof createDashboardFixture>) => void,
  trackedQueries: Record<string, { query: string }[]> = {},
): Promise<string> {
  const fixture = createDashboardFixture(options)
  mutateFixture?.(fixture)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  for (const [projectName, queries] of Object.entries(trackedQueries)) {
    queryClient.setQueryData(['setup', 'resume-queries', projectName], queries)
  }

  seedNoMeasurementPlan(queryClient, fixture)
  seedVisibilityReport(queryClient, fixture, pathname)

  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

test('overview route renders the premium portfolio dashboard', async () => {
  const html = await renderApp('/')

  expect(html).toMatch(/Portfolio/)
  expect(html).toMatch(/Visibility across all projects/)
  expect(html).toMatch(/Infrastructure/)
  expect(html).toMatch(/Citypoint Dental NYC/)
  expect(html).toMatch(/Harbor Legal Group/)
  expect(html).toMatch(/src="\.\/favicon\.svg"/)
})

test('project route renders a concise visibility summary with progressive detail', async () => {
  const html = await renderApp('/projects/project_citypoint')

  expect(html).toMatch(/Citypoint Dental NYC/)
  // The tab is labelled for what it shows. The route id stays `overview` —
  // embed configs pass that id on the wire (CANONRY_EMBED_PROJECT_TABS), so
  // renaming it would break an existing install's allowlist.
  expect(html).toMatch(/AI Visibility/)
  expect(html).toMatch(/Search Engines/)
  // The route/embed token remains `technical-aeo`; only the product label changes.
  expect(html).toMatch(/Site Health/)
  expect(html).toMatch(/Queries/)
  expect(html).toMatch(/Latest signals/)
  expect(html).toMatch(/Lost citation on 1 query/)
  expect(html).toMatch(/Emergency-intent prompts stopped grounding Citypoint/)
  expect(html).toMatch(/Evidence · 1 affected query/)
  expect(html).toMatch(/Complete/)
  expect(html).toMatch(/Non-brand queries/)
  expect(html).toMatch(/Mentioned answers/)
  expect(html).toMatch(/Cited answers/)
  expect(html).toMatch(/Query performance/)
  expect(html).toMatch(/emergency dentist near me/)
  expect(html).toMatch(/aria-label="View answers for emergency dentist near me · openai"/)
  expect(html).toMatch(/Trend data and comparability/)
  expect(html).toMatch(/Competitors/)
  expect(html).toMatch(/Manage queries/)
  expect(html).toMatch(/Suggested query/)
  expect(html).toMatch(/Review in Queries/)
  expect(html).not.toMatch(/aria-label="Track query/)
  expect(html).not.toMatch(/Next action/)
  expect(html).not.toMatch(/Action queue/)
  expect(html).not.toMatch(/What needs your attention/)
  expect(html).not.toMatch(/Loading AI visibility/)
})

test('runs route renders the operational timeline and filters', async () => {
  const html = await renderApp('/runs')

  expect(html).toMatch(/Runs/)
  expect(html).toMatch(/All runs/)
  expect(html).toMatch(/Queued follow-up after local ranking movement/)
  expect(html).toMatch(/Citation losses on emergency-intent prompts/)
})

test('settings route renders provider state, quota summary, and service health', async () => {
  const html = await renderApp('/settings')

  expect(html).toMatch(/Settings/)
  expect(html).toMatch(/Rate limit/)
  expect(html).toMatch(/Service health/)
  expect(html).toMatch(/Gemini/)
})

test('traffic route offers a source-agnostic connect entry point', async () => {
  const html = await renderApp('/traffic')

  expect(html).toMatch(/Traffic sources/)
  expect(html).toMatch(/Connect a source/)
  expect(html).toMatch(/AI crawler hits and referral sessions from your server logs/)
  expect(html).not.toMatch(/Cloud Run logs or the WordPress Traffic Logger plugin/)
})

test('settings route renders the shared Google OAuth configuration card', async () => {
  const html = await renderApp('/settings')

  expect(html).toMatch(/Google OAuth/)
  expect(html).toMatch(/~\/\.canonry\/config\.yaml/)
  expect(html).toMatch(/Configure Google OAuth|Update OAuth app/)
})

test('setup route skips completed health checks and starts at project creation', async () => {
  const html = await renderApp('/setup?experience=legacy', {}, (fixture) => {
    fixture.dashboard.projects = []
    fixture.dashboard.runs = []
  })

  expect(html).toMatch(/Setup/)
  expect(html).toMatch(/Create project/)
  expect(html).toMatch(/Step 2 of 5/)
})

test('setup resumes at queries when a durable project has no query basket', async () => {
  const html = await renderApp('/setup?experience=legacy', {}, (fixture) => {
    fixture.dashboard.projects = [fixture.dashboard.projects[0]!]
    fixture.dashboard.projects[0]!.queryCounts.total = 0
    fixture.dashboard.projects[0]!.competitors = []
    fixture.dashboard.runs = []
  })

  expect(html).toMatch(/Step 3 of 5/)
  expect(html).toMatch(/Add queries/)
})

test('setup blocks progress until API, worker, and provider readiness pass', async () => {
  const html = await renderApp('/setup?experience=legacy', { providerNeedsConfig: true }, (fixture) => {
    fixture.dashboard.projects = []
    fixture.dashboard.runs = []
  })

  expect(html).toMatch(/Launch is blocked until at least one provider is configured/)
  expect(html).toMatch(/Paste a Gemini key/)
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/)
})

test('setup treats a cancelled first run as retryable, not complete', async () => {
  const html = await renderApp('/setup?experience=legacy', {}, (fixture) => {
    const project = fixture.dashboard.projects[0]!
    const cancelled = {
      ...fixture.dashboard.runs.find(run => run.projectId === project.project.id)!,
      status: 'cancelled' as const,
      statusDetail: 'Cancelled by operator before provider responses completed.',
    }
    fixture.dashboard.projects = [project]
    project.queryCounts.total = 0
    fixture.dashboard.runs = [cancelled]
  }, {
    'Citypoint Dental NYC': [{ query: 'emergency dentist brooklyn' }],
  })

  expect(html).toMatch(/Cancelled/)
  expect(html).toMatch(/Retry visibility sweep/)
  expect(html).not.toMatch(/Setup is complete/)
})

test('setup recognizes an older baseline outside the global run window', async () => {
  const html = await renderApp('/setup?experience=legacy', {}, (fixture) => {
    fixture.dashboard.projects = [fixture.dashboard.projects[0]!]
    fixture.dashboard.runs = []
  })

  expect(html).toMatch(/Setup is complete/)
  expect(html).not.toMatch(/Launch visibility sweep/)
})

test('overview route renders first-run onboarding guidance when there are no projects', async () => {
  const html = await renderApp('/', { emptyPortfolio: true })

  expect(html).toMatch(/No projects yet/)
  expect(html).toMatch(/Canonry becomes useful after one project/)
  expect(html).toMatch(/Launch setup/)
})

test('default overview covers multiple projects and recent runs', async () => {
  const html = await renderApp('/')

  expect(html).toMatch(/Northstar Orthopedics/)
  expect(html).toMatch(/One follow-up run is queued/)
  expect(html).toMatch(/System health/)
})

test('setup route renders step indicator with all step labels', async () => {
  const html = await renderApp('/setup?experience=legacy')

  expect(html).toMatch(/System check/)
  expect(html).toMatch(/Create project/)
  expect(html).toMatch(/Queries/)
  expect(html).toMatch(/Competitors/)
  expect(html).toMatch(/Launch/)
})

test('runs route renders partial runs clearly', async () => {
  const html = await renderApp('/runs', { runScenario: 'partial' })

  expect(html).toMatch(/Partial visibility sweep after quota cap/)
  expect(html).toMatch(/Quota window closed mid-run/)
})

test('runs route renders failed runs clearly', async () => {
  const html = await renderApp('/runs', { runScenario: 'failed' })

  expect(html).toMatch(/Provider retries exhausted before results were captured/)
  expect(html).toMatch(/Worker could not reach the provider after repeated retry exhaustion/)
})

test('project route renders server attention without restoring the action queue', async () => {
  const html = await renderApp('/projects/project_citypoint', { visibilityDropProjectId: 'project_citypoint' }, (fixture) => {
    fixture.dashboard.projects[0]!.insights.unshift({
      id: 'stale_visibility',
      tone: 'caution',
      title: 'Visibility data needs refresh',
      detail: 'A newer integration sync landed after the latest visibility sweep.',
      actionLabel: 'Stale',
      actionGroup: 'investigate',
      affectedPhrases: [],
    })
  })

  expect(html).toMatch(/Non-brand queries/)
  expect(html).toMatch(/Query performance/)
  expect(html).toMatch(/emergency dentist near me/)
  expect(html).toMatch(/Sharp citation drop detected/)
  expect(html).toMatch(/Visibility data needs refresh/)
  expect(html).toMatch(/A newer integration sync landed after the latest visibility sweep/)
  expect(html).not.toMatch(/Action queue/)
  expect(html).not.toMatch(/What needs your attention/)
})

test('project search console route renders the Search Engines section', async () => {
  const html = await renderApp('/projects/project_citypoint/search-console')

  expect(html).toMatch(/Search Engines/)
  expect(html).toMatch(/Search engine workspaces/)
  expect(html).toMatch(/Google Search Console/)
  expect(html).toMatch(/>Google</)
  expect(html).toMatch(/>Bing</)
  expect(html).toMatch(/aria-label="Refresh search data"/)
  expect(html).not.toMatch(/Coverage and performance/)
  expect(html.indexOf('Search engine workspaces')).toBeLessThan(html.indexOf('Google Search Console'))
  expect(html).not.toMatch(/Bing \(OpenAI\)/)
  expect(html).not.toMatch(/Operator snapshot/)
  expect(html).not.toMatch(/Opportunities/)
})

test('fetchServiceStatus reports ok details from a health payload', async () => {
  const realFetch = globalThis.fetch
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        version: 'phase-1',
        databaseUrlConfigured: true,
        lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    ))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/worker-health', 'Worker')

  expect(result).toEqual({
    label: 'Worker',
    state: 'ok',
    detail: 'phase-1 · database configured · heartbeat 2026-03-09T00:00:00.000Z',
    version: 'phase-1',
    databaseConfigured: true,
    lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
  })
  expect(fetchMock).toHaveBeenCalledWith('/worker-health', { credentials: 'same-origin' })
})

test('fetchServiceStatus reports transport failures', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/api-health', 'API')

  expect(result).toEqual({
    label: 'API',
    state: 'error',
    detail: 'connection refused',
  })
})

test('fetchServiceStatus respects basePath for public health endpoints', async () => {
  const realFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: TestWindowConfig }).window
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        version: 'phase-1',
        databaseUrlConfigured: true,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    ))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  ;(globalThis as typeof globalThis & { window?: TestWindowConfig }).window = { __CANONRY_CONFIG__: { basePath: '/canonry/' } }

  onTestFinished(() => {
    globalThis.fetch = realFetch
    ;(globalThis as typeof globalThis & { window?: TestWindowConfig }).window = originalWindow
  })

  await fetchServiceStatus('/health', 'API')

  expect(fetchMock).toHaveBeenCalledWith('/canonry/health', { credentials: 'same-origin' })
})

test('fetchServiceStatus adds troubleshooting hint for 404 health responses', async () => {
  const realFetch = globalThis.fetch
  const fetchMock = vi.fn(async () =>
    new Response(null, {
      status: 404,
      statusText: 'Not Found',
    }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
  })

  await expect(fetchServiceStatus('/health', 'API')).resolves.toMatchObject({
    label: 'API',
    state: 'error',
    detail: 'API 404: Not Found',
    statusCode: 404,
    hint: expect.stringMatching(/basePath|reverse-proxy|API-prefixed route/i),
  })
})

test('fetchHealthCheck uses the public health endpoint', async () => {
  const realFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: TestWindowConfig }).window
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ status: 'ok' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    ))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  ;(globalThis as typeof globalThis & { window?: TestWindowConfig }).window = { __CANONRY_CONFIG__: { basePath: '/canonry/' } }

  onTestFinished(() => {
    globalThis.fetch = realFetch
    ;(globalThis as typeof globalThis & { window?: TestWindowConfig }).window = originalWindow
  })

  await expect(fetchHealthCheck()).resolves.toEqual({ status: 'ok' })
  expect(fetchMock).toHaveBeenCalledWith('/canonry/health', { credentials: 'same-origin' })
})

test('settings route exposes health failure details on the badge tooltip', async () => {
  const html = await renderApp('/settings', {}, (fixture) => {
    fixture.health.apiStatus = {
      label: 'API',
      state: 'error',
      detail: 'API 404: Not Found',
      statusCode: 404,
      hint: 'Health endpoint returned 404. Check basePath configuration.',
    }
    fixture.health.workerStatus = {
      label: 'Worker',
      state: 'error',
      detail: 'Depends on API health check · API 404: Not Found',
      statusCode: 404,
      hint: 'Worker status is inferred from API health in this deployment mode. Check basePath configuration.',
    }
  })

  expect(html).toMatch(/title="API 404: Not Found/)
  expect(html).toMatch(/Check basePath configuration/)
  expect(html).toMatch(/Depends on API health check · API 404: Not Found/)
})
