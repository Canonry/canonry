import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import { projectScheduleQueryOptions } from '../src/queries/schedule-query.js'
import {
  getApiV1ProjectsByNameMeasurementOverviewInfiniteQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementPortfolioSummaryQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameMeasurementReportQueryKey,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameScheduleQueryKey,
} from '@ainyc/canonry-api-client/react-query'

type EmbedBlock = { enabled: boolean; views?: string[]; projectTabs?: string[] }

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

async function renderAt(
  pathname: string,
  embed?: EmbedBlock,
  measurement?: {
    plan: ReturnType<typeof measurementPlanResponse> | ReturnType<typeof measurementPlanV2Response>
    setup?: ReturnType<typeof measurementSetupResponse>
      | ReturnType<typeof simpleMeasurementSetupResponse>
      | ReturnType<typeof activeMeasurementSetupResponse>
    report?: ReturnType<typeof measurementReportResponse>
    overview?: ReturnType<typeof measurementOverviewResponse>
    summary?: ReturnType<typeof measurementPortfolioSummaryResponse>
    overviewKey?: { scope?: 'all' | 'group'; groupKey?: string; queryClass?: 'all' | 'non-brand' | 'branded'; runId?: string }
  },
  /**
   * `seedPlan: false` leaves the measurement-plan query unseeded, which is the
   * cold-navigation state: the read is in flight and the surface is not yet
   * decidable. These render one synchronous pass, so an unseeded query stays
   * pending for the whole render.
   */
  options: { schedule?: unknown; scheduleReadFailure?: boolean; seedPlan?: boolean } = {},
): Promise<string> {
  if (embed) window.__CANONRY_CONFIG__ = { embed }
  else delete window.__CANONRY_CONFIG__

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  queryClient.setQueryData(
    getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } }),
    [],
  )
  if (options.scheduleReadFailure) {
    const scheduleKey = getApiV1ProjectsByNameScheduleQueryKey({ client: heyClient, path: { name: projectName } })
    // Keep the captured 500 visible for the synchronous SSR assertion. The
    // interactive retry behavior is covered by ScheduleSection; this test
    // verifies the project header's interpretation of that same error state.
    queryClient.setQueryDefaults(scheduleKey, { retryOnMount: false })
    await queryClient.fetchQuery({
      ...projectScheduleQueryOptions(projectName),
      retry: false,
    }).catch(() => undefined)
  } else if (options.schedule !== undefined) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameScheduleQueryKey({ client: heyClient, path: { name: projectName } }),
      options.schedule,
    )
  }
  if (options.seedPlan !== false) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
      measurement?.plan ?? { active: null },
    )
  }
  if (measurement?.setup) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
      measurement.setup,
    )
  }
  if (measurement?.report && measurement.plan.active) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementReportQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { revision: measurement.plan.active.revision },
      }),
      measurement.report,
    )
  }
  if (measurement?.overview) {
    // Seed under the EXACT scope/class the page is expected to request. A test
    // that seeds `all` and asserts a group rendered proves nothing: the page
    // would read the seeded `all` page either way. Seeding only the group key
    // is what makes "did the URL drive the request?" observable — get it wrong
    // and the surface paints a skeleton instead.
    const q = {
      scope: measurement.overviewKey?.scope ?? 'all',
      ...(measurement.overviewKey?.groupKey ? { groupKey: measurement.overviewKey.groupKey } : {}),
      queryClass: measurement.overviewKey?.queryClass ?? 'non-brand',
      ...(measurement.overviewKey?.runId ? { runId: measurement.overviewKey.runId } : {}),
      limit: 50,
    }
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementOverviewInfiniteQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: q,
      }),
      { pages: [measurement.overview], pageParams: [{ path: { name: projectName }, query: q }] },
    )
    if (measurement.summary) {
      const summaryQuery = {
        queryClass: q.queryClass,
        ...(q.groupKey ? { groupKey: q.groupKey } : {}),
        ...(measurement.overview.measurement.displayedRunId ? { runId: measurement.overview.measurement.displayedRunId } : {}),
      }
      queryClient.setQueryData(
        getApiV1ProjectsByNameMeasurementPortfolioSummaryQueryKey({
          client: heyClient,
          path: { name: projectName },
          query: summaryQuery,
        }),
        measurement.summary,
      )
    }
  }
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

async function renderSettingsScheduleDeepLink() {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } }),
    [],
  )
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    { active: null },
  )
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
    simpleMeasurementSetupResponse(),
  )
  // The first entry makes a back-button assertion meaningful: clearing the
  // one-time marker must REPLACE the deep-link entry, not push another URL
  // that returns to an editor on Back.
  const router = createAppRouter(queryClient, {
    initialEntries: [
      '/projects/project_citypoint/settings',
      '/projects/project_citypoint/settings?schedule=edit',
    ],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
  return { page, router }
}

function measurementPlanResponse(revision: number, populated = false) {
  return {
    active: {
      revision,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 1 as const,
        defaultContext: null,
        effectiveOwnedHosts: ['locations.example'],
        projectCanonicalHost: 'locations.example',
        projectBrandNames: ['Locations'],
        targets: populated ? [{
          stableKey: 'harbor-house',
          label: 'Harbor House',
          urls: [{ kind: 'prefix' as const, host: 'locations.example', pathPrefix: '/harbor-house', pathCase: 'insensitive' as const }],
          aliases: ['Harbor House'],
          mentionNotApplicable: false,
        }] : [],
        groups: [],
        targetQuerySelections: populated ? [{ targetKey: 'harbor-house', queryIds: ['query-old'] }] : [],
        querySnapshots: populated ? [{ queryId: 'query-old', queryText: 'old service query' }] : [],
        executionNodes: [],
        usageEdges: [],
        warnings: [],
      },
    },
  }
}

function measurementPlanV2Response(revision: number) {
  return {
    active: {
      revision,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 2 as const,
        identities: {
          projectBrand: {
            canonicalHost: 'locations.example',
            ownedHosts: ['locations.example'],
            names: ['Locations'],
          },
        },
        targets: [{
          stableKey: 'harbor-house',
          label: 'Harbor House',
          aliases: ['Harbor House'],
          urlMatchers: [{ kind: 'prefix' as const, host: 'locations.example', pathPrefix: '/harbor-house', pathCase: 'insensitive' as const }],
          mentionNotApplicable: false,
          discoveryIdentity: 'sitemap:harbor-house',
        }],
        groups: [{ stableKey: 'north', label: 'North', targetKeys: ['harbor-house'], competitors: [] }],
        querySnapshots: [{
          queryId: 'query-old',
          queryText: 'old service query',
          provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' },
        }],
        assignments: [{ targetKey: 'harbor-house', queryId: 'query-old', queryClass: 'non-brand' as const, executionNodeKey: 'node-old' }],
        executionNodes: [{
          stableKey: 'node-old',
          queryId: 'query-old',
          queryText: 'old service query',
          context: { providers: ['openai' as const], models: { openai: 'search-model' }, location: null },
          expectedSnapshots: 1,
        }],
        usageEdges: [{ executionNodeKey: 'node-old', targetKey: 'harbor-house', queryId: 'query-old' }],
        compiledChecksum: 'b'.repeat(64),
      },
    },
  }
}

function measurementOverviewResponse(overrides: {
  scope?: 'all' | 'group'
  scopeKey?: string
  scopeLabel?: string
  nextCursor?: string | null
  totalEstimate?: number
  label?: string
  targetKey?: string
  queryClass?: 'all' | 'non-brand' | 'branded'
  displayedRunId?: string
} = {}) {
  return {
    mode: 'active-v2' as const,
    scope: {
      kind: overrides.scope ?? 'all',
      ...(overrides.scopeKey ? { key: overrides.scopeKey } : {}),
      label: overrides.scopeLabel ?? 'All Properties',
    },
    queryClass: (overrides.queryClass ?? 'non-brand') as 'all' | 'non-brand' | 'branded',
    measurement: {
      state: 'complete' as const,
      displayedRunId: overrides.displayedRunId ?? 'run-synthetic',
      completed: 1,
      expected: 1,
      completedAt: '2026-08-02T12:05:00.000Z',
    },
    nextAction: { kind: 'none' as const },
    metrics: {
      propertiesMentioned: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
      mentionCoverage: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
      citationCoverage: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
      brandPresence: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
      sov: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
    },
    properties: {
      items: [{
        targetKey: overrides.targetKey ?? 'harbor-house',
        label: overrides.label ?? 'Harbor House',
        mentionCoverage: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
        citationCoverage: { state: 'available' as const, value: 1, numerator: 1, denominator: 1 },
        providers: [],
        flags: 0,
      }],
      nextCursor: overrides.nextCursor ?? null,
      totalEstimate: overrides.totalEstimate ?? 1,
    },
    outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
    flags: { total: 0 },
  }
}

function measurementPortfolioSummaryResponse(groupKey?: string, queryClass: 'all' | 'non-brand' | 'branded' = 'non-brand') {
  const metric = { state: 'available' as const, value: 1, numerator: 1, denominator: 1 }
  const countMetric = { ...metric, rate: 1 }
  return {
    portfolio: {
      groupKey: groupKey ?? null,
      label: groupKey === 'north' ? 'North' : null,
      measurementScope: 'full' as const,
    },
    measurement: {
      state: 'complete' as const,
      displayedRunId: 'run-synthetic',
      planRevision: 4,
      completedAt: '2026-08-02T12:05:00.000Z',
    },
    queryClass,
    metrics: { propertiesMentioned: countMetric, mentionCoverage: metric, citationCoverage: metric },
    weakestProperties: [],
    markets: groupKey ? [] : [{
      groupKey: 'north',
      label: 'North',
      propertyCount: 1,
      propertiesMentioned: countMetric,
      mentionCoverage: metric,
      citationCoverage: metric,
    }],
    totalProperties: groupKey ? 1 : 218,
    truncated: false,
  }
}

function measurementChangesResponse() {
  const metric = (delta: number) => ({
    state: 'available' as const,
    previous: { state: 'available' as const, value: 0.5 },
    current: { state: 'available' as const, value: 0.5 + delta },
    delta,
  })
  return {
    current: {
      state: 'complete' as const,
      displayedRunId: 'run-synthetic',
      planRevision: 4,
      completedAt: '2026-08-02T12:05:00.000Z',
      executionIdentity: 'openai:search-model',
      measurementScope: 'full' as const,
    },
    comparison: {
      state: 'available' as const,
      previous: {
        displayedRunId: 'run-previous',
        planRevision: 4,
        completedAt: '2026-08-01T12:05:00.000Z',
        executionIdentity: 'openai:search-model',
        measurementScope: 'full' as const,
      },
      metrics: {
        propertiesMentioned: metric(0),
        mentionCoverage: metric(0.1),
        citationCoverage: metric(-0.1),
      },
      changedProperties: [],
      totalProperties: 1,
      truncated: false,
    },
  }
}

function runDetailResponse(
  id: string,
  kind: 'answer-visibility' | 'site-audit',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    projectId: 'project_citypoint',
    kind,
    status: 'completed' as const,
    trigger: 'manual' as const,
    measurementPlanVersionId: kind === 'answer-visibility' ? 'measurement-plan-v4' : null,
    measurementScope: null,
    location: null,
    queries: null,
    startedAt: '2026-08-02T12:00:00.000Z',
    finishedAt: '2026-08-02T12:05:00.000Z',
    error: null,
    createdAt: '2026-08-02T12:00:00.000Z',
    snapshots: [],
    ...overrides,
  }
}

function measurementSetupResponse(revision: number | null = null) {
  return {
    state: 'setup_in_progress' as const,
    nextAction: 'continue_setup' as const,
    mode: revision === null ? 'draft-only' as const : 'active-v2' as const,
    activeRevision: revision,
    activeSchemaVersion: revision === null ? null : 2 as const,
    draft: { etag: '"mpd_7"', updatedAt: '2026-08-02T12:00:00.000Z' },
  }
}

function simpleMeasurementSetupResponse() {
  return {
    state: 'simple' as const,
    nextAction: 'start_setup' as const,
    mode: 'simple' as const,
    activeRevision: null,
    activeSchemaVersion: null,
    draft: null,
  }
}

function activeMeasurementSetupResponse(revision: number) {
  return {
    state: 'operational' as const,
    nextAction: 'view_measurement' as const,
    mode: 'active-v2' as const,
    activeRevision: revision,
    activeSchemaVersion: 2 as const,
    draft: null,
  }
}

function measurementDraftResponse() {
  return {
    draft: {
      id: 'draft-synthetic',
      projectId: 'project_citypoint',
      schemaVersion: 2 as const,
      baseActiveVersionId: 'version-7',
      baseActiveRevision: 7,
      authoring: {
        defaultContext: { providers: ['openai' as const], models: { openai: 'search-model' }, locations: [] },
        targets: [{
          stableKey: 'harbor-house',
          label: 'Harbor House',
          status: 'included' as const,
          aliases: ['Harbor House'],
          urlMatchers: ['https://locations.example/harbor-house'],
          source: 'sitemap' as const,
          discoveredUrl: 'https://locations.example/harbor-house',
          discoveryIdentity: 'sitemap:harbor-house',
        }],
        assignments: [{
          targetKey: 'harbor-house',
          queryId: 'query-old',
          queryClass: 'non-brand' as const,
          classificationSource: 'rule' as const,
        }],
        groups: [],
      },
      createdBy: { kind: 'user' as const, id: 'user-editor', label: 'Editor' },
      updatedBy: { kind: 'user' as const, id: 'user-editor', label: 'Editor' },
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-02T12:00:00.000Z',
    },
    etag: '"mpd_7"',
  }
}

function measurementReportResponse(revision: number) {
  return {
    revision,
    run: {
      id: 'run-synthetic',
      status: 'completed' as const,
      createdAt: '2026-08-02T12:00:00.000Z',
      startedAt: '2026-08-02T12:00:00.000Z',
      finishedAt: '2026-08-02T12:05:00.000Z',
    },
    groups: [],
    targets: [{
      id: 'harbor-house',
      label: 'Harbor House',
      completeness: { executed: 1, expected: 1, sourceCompleteObservations: 1, complete: true, sourceComplete: true, answerComplete: true },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      providers: [],
    }],
    evidence: [],
    diagnostics: {
      bridgedObservationIds: [],
      historicalObservationIds: [],
      evidenceIncompleteObservationIds: [],
      ambiguousObservationIds: [],
      unmatchedObservationIds: [],
    },
  }
}

test('the Portfolio route is an explicit non-embed project workspace', async () => {
  const html = await renderAt('/projects/project_citypoint/portfolio')

  expect(html).not.toMatch(/href="\/projects\/[^"/]+\/portfolio" class="project-subnav-link/)
  expect(html).toContain('Advanced measurement setup')
  expect(html).toContain('Loading advanced measurement setup')
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Portfolio setup')
  expect(html).not.toContain('Coverage and performance')
})

test('a Simple project keeps the existing Overview without advertising advanced measurement', async () => {
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('Where competitors are winning')
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Set up advanced measurement')
  expect(html).not.toContain('Republish setup')
  expect(html).not.toContain('Latest measurement')
})

test('project navigation ignores stale Site Health onboarding markers', async () => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo?onboarding=site-health')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const link = [...doc.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Project sections"] a')]
    .find(anchor => anchor.textContent === 'AI Visibility')

  expect(link).toBeTruthy()
  const destination = new URL(link!.href, 'http://localhost')
  expect(destination.pathname).toBe('/projects/Citypoint%20Dental%20NYC')
  expect(destination.search).toBe('')
})

test('project navigation preserves an open run drawer but clears one-shot onboarding markers', async () => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo?onboarding=site-health&runId=run-synthetic')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const link = [...doc.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Project sections"] a')]
    .find(anchor => anchor.textContent === 'AI Visibility')

  expect(link).toBeTruthy()
  const destination = new URL(link!.href, 'http://localhost')
  expect(destination.pathname).toBe('/projects/Citypoint%20Dental%20NYC')
  expect(destination.searchParams.get('runId')).toBe('run-synthetic')
  expect(destination.searchParams.get('onboarding')).toBeNull()
})

test('a stale Site Health onboarding marker cannot redirect the project overview', async () => {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } }),
    [],
  )
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    { active: null },
  )
  const router = createAppRouter(queryClient, {
    initialEntries: ['/projects/project_citypoint?onboarding=site-health'],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Where competitors are winning')).toBeTruthy()
  expect(router.state.location.pathname).toBe('/projects/project_citypoint')
})

test('an active setup replaces the Simple Overview with the advanced measurement landing', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanResponse(3, true),
    report: measurementReportResponse(3),
  })

  expect(html).toContain('Republish setup')
  // The advanced surface counts Properties and only Properties. The
  // assignment-denominated hero was removed: two populations side by side, with
  // the unit printed on neither, is what made the section unreadable.
  // That fixture carries no outcome counts, so the row correctly renders
  // nothing; what matters is that the assignment-denominated hero is gone.
  expect(html).not.toContain('aria-label="Coverage"')
  expect(html).toContain('advanced-measurement-properties-title')
  expect(html).toContain('Harbor House')
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Where competitors are winning')
})

test('a version-two setup never renders version-one class metrics as if they were current', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanV2Response(4),
    overview: measurementOverviewResponse(),
  })

  // Was: asserted 'Edit setup' rendered here. Editing a published plan moved to
  // Settings; on the results surface it was a control unrelated to reading the
  // numbers, sitting between the headline and the table.
  expect(html).not.toContain('Edit setup')
  expect(html).toContain('Harbor House')
  expect(html).toContain('1 of 1 (100%)')
  expect(html).not.toContain('Republish setup')
  expect(html).not.toContain('Republish setup to enable Non-brand and Branded reporting.')
})

test('a Property link carries the overview snapshot without opening a run drawer', async () => {
  const html = await renderAt('/projects/project_citypoint?scope=group:north&class=non-brand', undefined, {
    plan: measurementPlanV2Response(4),
    overview: measurementOverviewResponse({
      scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'North Property', displayedRunId: 'run-synthetic',
    }),
    overviewKey: { scope: 'group', groupKey: 'north', queryClass: 'non-brand' },
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const propertyLink = [...doc.querySelectorAll<HTMLAnchorElement>('a')]
    .find(anchor => anchor.textContent === 'North Property')

  expect(propertyLink).toBeTruthy()
  const destination = new URL(propertyLink!.href, window.location.origin)
  expect(destination.searchParams.get('scope')).toBe('group:north')
  expect(destination.searchParams.get('class')).toBe('non-brand')
  expect(destination.searchParams.get('measurementRunId')).toBe('run-synthetic')
  expect(destination.searchParams.get('runId')).toBeNull()
})

test('Portfolio and Group links carry the overview snapshot without a drawer param', async () => {
  const portfolioHtml = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanV2Response(4),
    overview: measurementOverviewResponse({ displayedRunId: 'run-synthetic' }),
    summary: measurementPortfolioSummaryResponse(),
    overviewKey: { scope: 'all', queryClass: 'non-brand' },
  })
  const portfolioDocument = new DOMParser().parseFromString(portfolioHtml, 'text/html')
  const groupLink = [...portfolioDocument.querySelectorAll<HTMLAnchorElement>('a')]
    .find(anchor => anchor.textContent === 'North')
  expect(groupLink).toBeTruthy()
  const groupDestination = new URL(groupLink!.href, window.location.origin)
  expect(groupDestination.searchParams.get('scope')).toBe('group:north')
  expect(groupDestination.searchParams.get('measurementRunId')).toBe('run-synthetic')
  expect(groupDestination.searchParams.get('runId')).toBeNull()
  expect(groupDestination.searchParams.get('class')).toBeNull()

  const groupHtml = await renderAt('/projects/project_citypoint?scope=group:north', undefined, {
    plan: measurementPlanV2Response(4),
    overview: measurementOverviewResponse({
      scope: 'group', scopeKey: 'north', scopeLabel: 'North', displayedRunId: 'run-synthetic',
    }),
    summary: measurementPortfolioSummaryResponse('north'),
    overviewKey: { scope: 'group', groupKey: 'north', queryClass: 'non-brand' },
  })
  const groupDocument = new DOMParser().parseFromString(groupHtml, 'text/html')
  const portfolioLink = [...groupDocument.querySelectorAll<HTMLAnchorElement>('a')]
    .find(anchor => {
      const destination = new URL(anchor.href, window.location.origin)
      return anchor.textContent === 'Portfolio'
        && destination.pathname.startsWith('/projects/')
        && destination.pathname.split('/').filter(Boolean).length === 2
    })
  expect(portfolioLink).toBeTruthy()
  const portfolioDestination = new URL(portfolioLink!.href, window.location.origin)
  expect(portfolioDestination.searchParams.get('scope')).toBeNull()
  expect(portfolioDestination.searchParams.get('measurementRunId')).toBe('run-synthetic')
  expect(portfolioDestination.searchParams.get('runId')).toBeNull()
  expect(portfolioDestination.searchParams.get('class')).toBeNull()
})

test('a version-two Overview uses server scope, search and pagination and defers evidence until a Property expands', async () => {
  const observed: string[] = []
  let releaseSearch: (() => void) | undefined
  let failRetrySearch = true
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve })
  const fixture = createDashboardFixture({})
  const measurementRunId = 'run-measurement'
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({
        state: 'operational',
        nextAction: 'view_measurement',
        mode: 'active-v2',
        activeRevision: 4,
        activeSchemaVersion: 2,
        draft: null,
      })
    }
    if (url.pathname.endsWith('/measurement-overview')) {
      const displayedRunId = url.searchParams.get('runId') ?? 'run-synthetic'
      if (url.searchParams.get('search') === 'retry') {
        if (failRetrySearch) {
          failRetrySearch = false
          return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic failure' }, 500)
        }
        return jsonResponse(measurementOverviewResponse({
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'Recovered Search Result',
          displayedRunId,
        }))
      }
      if (url.searchParams.get('cursor') === 'cursor-2') {
        return jsonResponse(measurementOverviewResponse({
          label: 'Harbor Annex',
          targetKey: 'harbor-annex',
          totalEstimate: 2,
          displayedRunId,
        }))
      }
      if (url.searchParams.get('search') === 'harbor') {
        await searchGate
        return jsonResponse(measurementOverviewResponse({
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'Harbor Search Result',
          displayedRunId,
        }))
      }
      if (url.searchParams.get('groupKey') === 'north') {
        return jsonResponse(measurementOverviewResponse({
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'North Property',
          displayedRunId,
        }))
      }
      return jsonResponse(measurementOverviewResponse({ nextCursor: 'cursor-2', totalEstimate: 2, displayedRunId }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) {
      return jsonResponse(measurementPortfolioSummaryResponse(
        url.searchParams.get('groupKey') ?? undefined,
        (url.searchParams.get('queryClass') ?? 'non-brand') as 'all' | 'non-brand' | 'branded',
      ))
    }
    if (url.pathname.endsWith('/measurement-changes')) return jsonResponse(measurementChangesResponse())
    if (url.pathname.endsWith('/measurement-property-evidence')) {
      const displayedRunId = url.searchParams.get('runId') ?? 'run-synthetic'
      return jsonResponse({
        property: { targetKey: url.searchParams.get('targetKey') ?? 'harbor-house', label: 'Harbor Search Result' },
        queryClass: url.searchParams.get('queryClass') ?? 'non-brand',
        measurement: { state: 'complete', displayedRunId },
        evidence: {
          items: [{
            observationId: 'observation-1',
            expectedSlotId: 'slot-1',
            executionId: 'node-old',
            usageEdgeId: 'edge-1',
            usageEdgeType: 'target',
            provider: 'openai',
            queryText: 'old service query',
            location: null,
            sourceUrl: 'https://locations.example/harbor-house',
            bridged: false,
            historical: false,
            evidenceComplete: true,
            classification: 'assigned',
            normalizedUrl: 'https://locations.example/harbor-house',
            matchedTargetIds: ['harbor-house'],
            matchedUrlIds: ['url-1'],
          }],
          nextCursor: null,
          totalEstimate: 1,
        },
      })
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [`/projects/project_citypoint?measurementRunId=${measurementRunId}`] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Harbor House')).toBeTruthy()
  const firstOverviewUrl = observed.find(path => path.includes('/measurement-overview?'))
  expect(firstOverviewUrl).toContain('scope=all')
  expect(firstOverviewUrl).toContain('queryClass=non-brand')
  expect(firstOverviewUrl).toContain(`runId=${measurementRunId}`)
  expect(firstOverviewUrl).toContain('limit=50')
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)
  expect(await page.findByRole('heading', { name: 'Portfolio pulse', hidden: true })).toBeTruthy()
  expect(page.queryByRole('dialog')).toBeNull()
  expect(observed.some(path => path.includes(`/runs/${measurementRunId}`))).toBe(false)
  await waitFor(() => expect(observed.some(path => path.includes('/measurement-portfolio-summary?')
    && path.includes('queryClass=non-brand')
    && path.includes(`runId=${measurementRunId}`))).toBe(true))

  fireEvent.click(page.getByRole('button', { name: 'Show 50 more', hidden: true }))
  expect(await page.findByText('Harbor Annex')).toBeTruthy()
  expect(observed.some(path => path.includes('cursor=cursor-2') && path.includes(`runId=${measurementRunId}`))).toBe(true)

  // The Pulse row is a real URL-backed link, so Groups remain shareable rather
  // than becoming local dropdown state.
  const pulseGroups = page.getByRole('table', { name: /Advanced measurement Groups/, hidden: true })
  fireEvent.click(within(pulseGroups).getByRole('link', { name: 'North', hidden: true }))
  expect(await page.findByText('North Property')).toBeTruthy()
  // A resolved measurement snapshot owns continuity between Portfolio and a
  // Group without reusing the global drawer's `runId` namespace.
  expect(router.state.location.search.measurementRunId).toBe(measurementRunId)
  expect(router.state.location.search.runId).toBeUndefined()
  expect(page.queryByRole('dialog')).toBeNull()
  expect(observed.some(path => path.includes('scope=group') && path.includes('groupKey=north'))).toBe(true)
  await waitFor(() => expect(observed.some(path => path.includes('/measurement-portfolio-summary?')
    && path.includes('groupKey=north')
    && path.includes('queryClass=non-brand')
    && path.includes(`runId=${measurementRunId}`))).toBe(true))

  expect(page.getByRole('heading', { name: 'North', hidden: true })).toBeTruthy()
  expect(await page.findByRole('heading', { name: 'Since previous comparable sweep', hidden: true })).toBeTruthy()
  expect(page.getAllByLabelText('Property outcomes')).toHaveLength(1)
  const propertyLink = page.getByRole('link', { name: 'North Property', hidden: true })
  const propertyDestination = new URL(propertyLink.getAttribute('href')!, window.location.origin)
  expect(propertyDestination.searchParams.get('scope')).toBe('group:north')
  expect(propertyDestination.searchParams.get('class')).toBe('non-brand')
  expect(propertyDestination.searchParams.get('measurementRunId')).toBe(measurementRunId)
  expect(propertyDestination.searchParams.get('runId')).toBeNull()
  fireEvent.change(page.getByLabelText('Search properties'), { target: { value: 'harbor' } })
  await waitFor(() => expect(observed.some(path => path.includes('search=harbor'))).toBe(true))
  await waitFor(() => expect(page.queryByRole('heading', { name: 'North' })).toBeNull())
  expect((page.getByLabelText('Search properties') as HTMLInputElement).value).toBe('harbor')
  expect(page.queryByText('North Property')).toBeNull()
  expect(page.getByLabelText('Updating Property results')).toBeTruthy()
  releaseSearch!()
  expect(await page.findByText('Harbor Search Result')).toBeTruthy()
  expect(page.getByLabelText('Property outcomes')).toBeTruthy()
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)

  fireEvent.click(page.getByText('Harbor Search Result').closest('tr')!)
  expect(await page.findByText('Assigned queries')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => path.includes('/measurement-property-evidence?')
    && path.includes('targetKey=harbor-house')
    && path.includes(`runId=${measurementRunId}`))).toBe(true))
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)

  fireEvent.change(page.getByLabelText('Search properties'), { target: { value: 'retry' } })
  expect(await page.findByText('Could not load the advanced measurement report.')).toBeTruthy()
  fireEvent.click(page.getByRole('button', { name: 'Retry report', hidden: true }))
  expect(await page.findByText('Recovered Search Result')).toBeTruthy()
  expect((page.getByLabelText('Search properties') as HTMLInputElement).value).toBe('retry')

  fireEvent.change(page.getByLabelText('Search properties'), { target: { value: '' } })
  const groupPulse = (await page.findByRole('heading', { name: 'North', hidden: true })).closest('section')!
  fireEvent.click(within(groupPulse).getByRole('link', { name: 'Portfolio', hidden: true }))
  expect(await page.findByRole('heading', { name: 'Portfolio pulse', hidden: true })).toBeTruthy()
  expect(router.state.location.search.measurementRunId).toBe(measurementRunId)
  expect(router.state.location.search.runId).toBeUndefined()
  expect(page.queryByRole('dialog')).toBeNull()
})

test('a non-measurement run drawer does not pin Group measurement reads', async () => {
  const observed: string[] = []
  const drawerRunId = 'run-site-audit'
  const fixture = createDashboardFixture({})
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (url.pathname.endsWith(`/runs/${drawerRunId}`)) return jsonResponse(runDetailResponse(drawerRunId, 'site-audit'))
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.has('runId')) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Not a measurement run' }, 422)
      }
      return jsonResponse(measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'North Property' }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) {
      if (url.searchParams.get('runId') === drawerRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Not a measurement run' }, 422)
      }
      return jsonResponse(measurementChangesResponse())
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [`/projects/project_citypoint?scope=group:north&runId=${drawerRunId}`] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('North Property')).toBeTruthy()
  expect(await page.findByRole('heading', { name: 'Since previous comparable sweep', hidden: true })).toBeTruthy()
  expect(router.state.location.search.runId).toBe(drawerRunId)
  expect(page.getByRole('dialog')).toBeTruthy()

  const overviewRequests = observed.filter(path => path.includes('/measurement-overview?'))
  expect(overviewRequests).not.toHaveLength(0)
  expect(overviewRequests.every(path => new URL(path, window.location.origin).searchParams.get('runId') === null)).toBe(true)
  const changesRequests = observed.filter(path => path.includes('/measurement-changes?'))
  expect(changesRequests).not.toHaveLength(0)
  expect(changesRequests.every(path => new URL(path, window.location.origin).searchParams.get('runId') === 'run-synthetic')).toBe(true)
})

test.each([
  ["another project's answer-visibility run", { projectId: 'project-other' }],
  ['an unplanned answer-visibility run', { measurementPlanVersionId: 'measurement-plan-old' }],
  ['a full probe run', { trigger: 'probe', measurementScope: null }],
  ['a scoped probe run', {
    trigger: 'probe',
    measurementScope: { groups: ['north'], targets: [], queries: [], resolvedTargets: ['harbor-house'] },
  }],
])('%s does not pin Group measurement reads', async (_label, overrides) => {
  const observed: string[] = []
  const drawerRunId = 'run-rejected-measurement'
  const fixture = createDashboardFixture({})
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (url.pathname.endsWith(`/runs/${drawerRunId}`)) {
      return jsonResponse(runDetailResponse(drawerRunId, 'answer-visibility', overrides))
    }
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.has('runId')) return jsonResponse({ code: 'INVALID_RUN' }, 422)
      return jsonResponse(measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'North Property' }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) return jsonResponse(measurementChangesResponse())
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [`/projects/project_citypoint?scope=group:north&runId=${drawerRunId}`] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('North Property')).toBeTruthy()
  const overviewRequests = observed.filter(path => path.includes('/measurement-overview?'))
  expect(overviewRequests).not.toHaveLength(0)
  expect(overviewRequests.every(path => new URL(path, window.location.origin).searchParams.get('runId') === null)).toBe(true)
  expect(router.state.location.search.runId).toBe(drawerRunId)
})

test('a cached active plan cannot validate a drawer run after revalidation fails', async () => {
  const observed: string[] = []
  const stalePlanRunId = 'run-stale-active-plan'
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (url.pathname.endsWith(`/runs/${stalePlanRunId}`)) return jsonResponse(runDetailResponse(stalePlanRunId, 'answer-visibility'))
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic revalidation failure' }, 500)
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.get('runId') === stalePlanRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Stale plan cannot validate this pin' }, 422)
      }
      return jsonResponse(measurementOverviewResponse({
        scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'North Property', displayedRunId: 'run-unpinned',
      }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) return jsonResponse(measurementChangesResponse())
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    measurementPlanV2Response(4),
  )
  const router = createAppRouter(queryClient, {
    initialEntries: [`/projects/project_citypoint?scope=group:north&runId=${stalePlanRunId}`],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => expect(observed.some(path => path.endsWith('/measurement-plan'))).toBe(true))
  expect(await page.findByText('North Property')).toBeTruthy()
  const measurementRequests = observed.filter(path => /measurement-overview|measurement-changes/.test(path))
  expect(measurementRequests).not.toHaveLength(0)
  expect(measurementRequests.every(path => new URL(path, window.location.origin).searchParams.get('runId') !== stalePlanRunId)).toBe(true)
})

test('Group changes clear while a new valid overview pin is resolving', async () => {
  const observed: string[] = []
  let releaseNextOverview: (() => void) | undefined
  const nextOverview = new Promise<void>(resolve => { releaseNextOverview = resolve })
  const fixture = createDashboardFixture({})
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.get('runId') === 'run-measurement-new') {
        await nextOverview
        return jsonResponse(measurementOverviewResponse({
          scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'New Property', displayedRunId: 'run-measurement-new',
        }))
      }
      return jsonResponse(measurementOverviewResponse({
        scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'Old Property', displayedRunId: 'run-measurement-old',
      }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) {
      const response = measurementChangesResponse()
      const runId = url.searchParams.get('runId')!
      response.current.displayedRunId = runId
      response.comparison.metrics.mentionCoverage.delta = runId === 'run-measurement-new' ? 0.2 : 0.1
      return jsonResponse(response)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, {
    initialEntries: ['/projects/project_citypoint?scope=group:north&measurementRunId=run-measurement-old'],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Old Property')).toBeTruthy()
  expect(await page.findByText('+10 pp')).toBeTruthy()

  await act(async () => {
    await router.navigate({
      to: '/projects/$projectName',
      params: { projectName: 'project_citypoint' },
      search: previous => ({ ...previous, measurementRunId: 'run-measurement-new' }),
    })
  })
  await waitFor(() => expect(observed.some(path => path.includes('/measurement-overview?') && path.includes('runId=run-measurement-new'))).toBe(true))
  expect(page.queryByText('+10 pp')).toBeNull()

  releaseNextOverview!()
  expect(await page.findByText('New Property')).toBeTruthy()
  expect(await page.findByText('+20 pp')).toBeTruthy()
})

test('Group changes clear while closing a valid pin reloads the unpinned overview', async () => {
  const observed: string[] = []
  let releaseUnpinnedOverview: (() => void) | undefined
  const unpinnedOverview = new Promise<void>(resolve => { releaseUnpinnedOverview = resolve })
  const fixture = createDashboardFixture({})
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (!url.searchParams.has('runId')) {
        await unpinnedOverview
        return jsonResponse(measurementOverviewResponse({
          scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'Unpinned Property', displayedRunId: 'run-unpinned',
        }))
      }
      return jsonResponse(measurementOverviewResponse({
        scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'Old Property', displayedRunId: 'run-measurement-old',
      }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) {
      const response = measurementChangesResponse()
      const runId = url.searchParams.get('runId')!
      response.current.displayedRunId = runId
      response.comparison.metrics.mentionCoverage.delta = runId === 'run-unpinned' ? 0.2 : 0.1
      return jsonResponse(response)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, {
    initialEntries: ['/projects/project_citypoint?scope=group:north&measurementRunId=run-measurement-old'],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Old Property')).toBeTruthy()
  expect(await page.findByText('+10 pp')).toBeTruthy()

  await act(async () => {
    await router.navigate({
      to: '/projects/$projectName',
      params: { projectName: 'project_citypoint' },
      search: previous => ({ ...previous, measurementRunId: undefined }),
    })
  })
  await waitFor(() => expect(observed.some(path => (
    path.includes('/measurement-overview?') && !new URL(path, window.location.origin).searchParams.has('runId')
  ))).toBe(true))
  expect(page.queryByText('+10 pp')).toBeNull()

  releaseUnpinnedOverview!()
  expect(await page.findByText('Unpinned Property')).toBeTruthy()
  expect(await page.findByText('+20 pp')).toBeTruthy()
})

test('an invalid measurement snapshot never falls back to an unpinned overview', async () => {
  const observed: string[] = []
  let releaseInvalidOverview: (() => void) | undefined
  const invalidOverview = new Promise<void>(resolve => { releaseInvalidOverview = resolve })
  const fixture = createDashboardFixture({})
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.get('runId') === 'run-invalid') {
        await invalidOverview
        return jsonResponse({ code: 'INVALID_RUN', message: 'Snapshot is not comparable to this active plan' }, 422)
      }
      return jsonResponse(measurementOverviewResponse({
        scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'Old Property', displayedRunId: 'run-measurement-old',
      }))
    }
    if (url.pathname.endsWith('/measurement-portfolio-summary')) return jsonResponse(measurementPortfolioSummaryResponse('north'))
    if (url.pathname.endsWith('/measurement-changes')) {
      const response = measurementChangesResponse()
      const runId = url.searchParams.get('runId')!
      response.current.displayedRunId = runId
      response.comparison.metrics.mentionCoverage.delta = runId === 'run-unpinned' ? 0.2 : 0.1
      return jsonResponse(response)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, {
    initialEntries: ['/projects/project_citypoint?scope=group:north&measurementRunId=run-measurement-old'],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Old Property')).toBeTruthy()
  expect(await page.findByText('+10 pp')).toBeTruthy()

  await act(async () => {
    await router.navigate({
      to: '/projects/$projectName',
      params: { projectName: 'project_citypoint' },
      search: previous => ({ ...previous, measurementRunId: 'run-invalid' }),
    })
  })
  await waitFor(() => expect(observed.some(path => (
    path.includes('/measurement-overview?') && path.includes('runId=run-invalid')
  ))).toBe(true))
  expect(page.queryByText('+10 pp')).toBeNull()

  await act(async () => { releaseInvalidOverview!() })
  const overviewRequests = observed.filter(path => path.includes('/measurement-overview?'))
  expect(overviewRequests.some(path => new URL(path, window.location.origin).searchParams.get('runId') === null)).toBe(false)
  expect(observed.some(path => path.includes('/runs/run-invalid'))).toBe(false)
})

test('a direct Portfolio URL falls back safely in embed mode', async () => {
  const html = await renderAt('/projects/project_citypoint/portfolio', {
    enabled: true,
    views: ['project'],
    projectTabs: ['portfolio', 'unknown'],
  })

  expect(html).toContain('Citypoint Dental NYC')
  expect(html).toContain('Visibility')
  expect(html).not.toContain('Import sitemap')
  expect(html).not.toContain('>Portfolio</a>')
  expect(html).not.toContain('Coverage and performance')
})

test('an embed with no project-tab allowlist never mounts Portfolio data reads', async () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true, views: ['project'] } }
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/portfolio'] })
  await router.load()
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Visibility')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => path.endsWith('/runs?kind=answer-visibility'))).toBe(true))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(observed.filter(path =>
    path.endsWith('/queries')
    || path.includes('/measurement-report?'),
  )).toEqual([])
})

test('the Portfolio workspace refreshes its setup data without reading a report early', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/queries')) {
      return jsonResponse([{ id: 'query-new', query: 'new service query', createdAt: '2026-08-01T12:00:00.000Z' }])
    }
    if (path.endsWith('/measurement-plan')) {
      return jsonResponse(measurementPlanResponse(8))
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300_000 } } })
  const queriesKey = getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } })
  const planKey = getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } })
  queryClient.setQueryData(queriesKey, [
    { id: 'query-old', query: 'old service query', createdAt: '2026-08-01T11:00:00.000Z' },
  ])
  queryClient.setQueryData(planKey, measurementPlanResponse(7))
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/portfolio'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(observed.some(path => path.endsWith('/queries'))).toBe(true)
    expect(observed.some(path => path.endsWith('/measurement-plan'))).toBe(true)
  })
  expect(queryClient.getQueryData(queriesKey)).toEqual([
    { id: 'query-new', query: 'new service query', createdAt: '2026-08-01T12:00:00.000Z' },
  ])
  expect(queryClient.getQueryData(planKey)).toEqual(measurementPlanResponse(8))
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)
})

test('a failed setup read blocks setup instead of looking planless', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path.endsWith('/measurement-setup') || path.endsWith('/measurement-plan/draft')) {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/portfolio'] })
  await router.load()
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(screen.getByText('Could not load advanced measurement setup.')).toBeTruthy()
  })
  expect(screen.queryByRole('button', { name: 'Review sitemap' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Publish setup' })).toBeNull()
})

test('a failed setup read keeps project results and the global run action visible without exposing setup actions', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan') || path.endsWith('/measurement-setup')) {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByText('Could not check the advanced measurement setup. Existing project-wide results remain available.')).toBeTruthy()
  expect(page.getByText('Where competitors are winning')).toBeTruthy()
  expect(page.getByRole('button', { name: 'AI sweep running…' })).toBeTruthy()
  expect(page.queryByRole('button', { name: 'Set up advanced measurement' })).toBeNull()
  expect(page.getByRole('button', { name: 'Retry setup check' })).toBeTruthy()
})

test('cached setup and queries remain usable when their background refresh fails', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-setup')) return jsonResponse(measurementSetupResponse(7))
    if (path.endsWith('/measurement-plan/draft')) return jsonResponse(measurementDraftResponse())
    if (path.endsWith('/queries') || path.endsWith('/measurement-plan')) {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queriesKey = getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } })
  const planKey = getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } })
  queryClient.setQueryData(queriesKey, [
    { id: 'query-old', query: 'old service query', createdAt: '2026-08-01T11:00:00.000Z' },
  ])
  queryClient.setQueryData(planKey, measurementPlanResponse(7, true))
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/portfolio'] })
  await router.load()
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(queryClient.getQueryState(planKey)?.status).toBe('error')
    expect(queryClient.getQueryState(queriesKey)?.status).toBe('error')
  })
  expect(screen.getByRole('heading', { name: 'Properties' })).toBeTruthy()
  expect(screen.queryByText('Could not load the active measurement setup.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Groups' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Queries' })).toBeTruthy())
  expect(screen.getByText('old service query')).toBeTruthy()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    projectId: 'project_citypoint',
    kind: 'answer-visibility' as const,
    cronExpr: '0 6 * * *',
    preset: 'daily',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    nextRunAt: '2026-08-07T06:00:00.000Z',
    lastRunAt: '2026-08-06T06:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function installSettingsScheduleApi() {
  let scheduleExists = true
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input), window.location.origin)
    const method = request?.method ?? init?.method ?? 'GET'
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/schedule')) {
      if (method === 'GET') return scheduleExists ? jsonResponse(schedule()) : jsonResponse({ code: 'NOT_FOUND' }, 404)
      if (method === 'PUT') return jsonResponse(schedule())
      if (method === 'DELETE') {
        scheduleExists = false
        return jsonResponse({})
      }
    }
    if (pathname.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (pathname.endsWith('/measurement-setup')) return jsonResponse(simpleMeasurementSetupResponse())
    // These unrelated Settings reads are intentionally not part of this route
    // test. A failed side query must not block the schedule deep-link flow.
    return jsonResponse({ code: 'UNAVAILABLE' }, 503)
  }) as typeof fetch
  return () => { globalThis.fetch = realFetch }
}

// On a managed instance the sweep is scheduled, so the header states when the
// next one fires and the manual trigger beside it is the override. The button
// is deliberately secondary: as the primary it told every reader that running
// the sweep by hand was the normal way to operate the product.
test('the header states when the next AI sweep fires', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { schedule: schedule() })

  expect(html).toContain('Next AI sweep')
  // The fixture has a sweep in flight, so the button sits in its busy state.
  // The point is the vocabulary: every state of this control names the sweep.
  expect(html).toContain('AI sweep running')
  // "Run now" said nothing about WHAT ran, and the page has six other sync
  // kinds. The disabled state already called it a sweep, so the label only
  // admitted what it did once you had clicked it.
  expect(html).not.toContain('Run now')
})

test('the header links the next sweep to the one-time Settings editor handoff and preserves only runId', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?runId=run-header&scope=group:ignored&class=branded',
    undefined,
    undefined,
    { schedule: schedule() },
  )
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const link = [...doc.querySelectorAll<HTMLAnchorElement>('a')]
    .find(anchor => anchor.textContent?.includes('Next AI sweep'))

  expect(link).toBeTruthy()
  const destination = new URL(link!.href, 'http://localhost')
  expect(destination.pathname).toBe('/projects/Citypoint%20Dental%20NYC/settings')
  expect(destination.searchParams.get('schedule')).toBe('edit')
  expect(destination.searchParams.get('runId')).toBe('run-header')
  expect(destination.searchParams.get('scope')).toBeNull()
  expect(destination.searchParams.get('class')).toBeNull()
})

test('the header makes a missing AI sweep schedule explicit without inventing a next date', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { schedule: null })

  expect(html).toContain('No AI sweep scheduled')
  expect(html).not.toContain('Next AI sweep')
})

test('the header does not turn a failed schedule read into a false no-schedule state', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => jsonResponse({ code: 'UNAVAILABLE' }, 500)) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { scheduleReadFailure: true })

  expect(html).toContain('AI sweep schedule unavailable')
  expect(html).not.toContain('No AI sweep scheduled')
  expect(html).not.toContain('Next AI sweep')
})

test('the Settings schedule deep link opens once, clears with replace on cancel, and does not reopen on Back', async () => {
  const restoreFetch = installSettingsScheduleApi()
  onTestFinished(restoreFetch)
  const { page, router } = await renderSettingsScheduleDeepLink()

  expect(await page.findByLabelText('Frequency')).toBeTruthy()
  fireEvent.click(page.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => {
    const search = router.state.location.search as { schedule?: string }
    expect(search.schedule).toBeUndefined()
  })
  expect(page.queryByLabelText('Frequency')).toBeNull()

  await act(async () => { router.history.back() })
  await waitFor(() => {
    const search = router.state.location.search as { schedule?: string }
    expect(search.schedule).toBeUndefined()
  })
  expect(page.queryByLabelText('Frequency')).toBeNull()
})

test('the Settings schedule deep link clears its marker after save and remove', async () => {
  const restoreFetch = installSettingsScheduleApi()
  onTestFinished(restoreFetch)

  const saved = await renderSettingsScheduleDeepLink()
  expect(await saved.page.findByLabelText('Frequency')).toBeTruthy()
  fireEvent.click(saved.page.getByRole('button', { name: 'Save schedule' }))
  await waitFor(() => expect((saved.router.state.location.search as { schedule?: string }).schedule).toBeUndefined())
  saved.page.unmount()

  const removed = await renderSettingsScheduleDeepLink()
  expect(await removed.page.findByLabelText('Frequency')).toBeTruthy()
  fireEvent.click(removed.page.getByRole('button', { name: 'Remove schedule' }))
  await waitFor(() => expect((removed.router.state.location.search as { schedule?: string }).schedule).toBeUndefined())
  expect(await removed.page.findByText('No AI visibility sweep is scheduled. Set one to automatically trigger visibility sweeps.')).toBeTruthy()
})

test('a DISABLED schedule promises no next sweep, even though the row still carries a stale nextRunAt', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { schedule: schedule({ enabled: false }) })

  expect(html).not.toContain('Next AI sweep')
  // The override is still offered — a paused schedule is exactly when someone
  // needs to run one by hand.
  expect(html).toContain('AI sweep')
})

// Deleting a project destroys every query, run and snapshot. It used to be an
// icon button in the page header, the same size as and immediately beside the
// most-clicked button on the page.
test('deleting the project is not reachable from the page header', async () => {
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('AI sweep')
  expect(html).not.toContain('Delete project')
})

// The assertion above would also pass if deleting had been removed outright,
// so prove it still exists — just somewhere a misclick cannot reach.
test('deleting the project is still offered, at the end of the Settings tab', async () => {
  const html = await renderAt('/projects/project_citypoint/settings')

  expect(html).toContain('Delete project')
  expect(html).toContain('Permanently deletes this project and all its queries, competitors, runs, and snapshots.')
})

test('Settings is the only discoverable entry to advanced measurement for a Simple project', async () => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined, {
    plan: { active: null },
    setup: simpleMeasurementSetupResponse(),
  })

  expect(html).toContain('Advanced measurement')
  expect(html).toContain('Measure individual properties, locations, or site sections with separate query sets.')
  expect(html).toContain('Set up advanced measurement')
})

test('Settings resumes an unfinished advanced measurement draft', async () => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined, {
    plan: { active: null },
    setup: measurementSetupResponse(),
  })

  expect(html).toContain('Continue setup')
  expect(html).not.toContain('Set up advanced measurement')
})

test('Settings edits a published advanced measurement setup', async () => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined, {
    plan: measurementPlanV2Response(4),
    setup: activeMeasurementSetupResponse(4),
  })

  expect(html).toContain('Edit setup')
})

test('Settings resumes an unpublished draft over an active advanced setup', async () => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined, {
    plan: measurementPlanV2Response(4),
    setup: measurementSetupResponse(4),
  })

  expect(html).toContain('Continue setup')
  expect(html).not.toContain('Edit setup')
})

// Restored: these two shipped in #953 and were dropped when a later branch's
// version of this file was taken wholesale. The guard they cover
// (`isMeasurementModeUnresolved`) stayed on main the whole time, unguarded.
test('an unresolved measurement plan shows a skeleton instead of flashing the Simple Overview', async () => {
  // The bug: `resolveAdvancedMeasurementMode` reads a pending plan read as
  // `null`, and `null` means "this project has no plan". So a project WITH an
  // advanced plan painted the legacy overview first and swapped it out once the
  // read landed — a visible flash on every cold navigation into a project.
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { seedPlan: false })

  expect(html).toContain('Loading project overview')
  // The legacy overview's own copy must not appear while the answer is unknown.
  expect(html).not.toContain('Where competitors are winning')
})

test('a settled plan read still renders the Simple Overview, so the guard is not a permanent skeleton', async () => {
  // The other half: once the read settles as "no plan", `null` means what it
  // says and the legacy surface is correct. A guard that cannot tell pending
  // from settled would strand this on the skeleton forever.
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('Where competitors are winning')
  expect(html).not.toContain('Loading project overview')
})

// ── Measurement view state lives in the URL ──────────────────────────────────
//
// Scale is the reason. At 47 properties an operator can re-pick a market after
// every reload; at 200+ markets that is the whole interaction, and a scope that
// only exists in component state cannot be linked, bookmarked, or reloaded.
// `?scope=group:<key>` makes a market a place you can send someone.

test('a scope in the URL selects that group on first paint, with no interaction', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?scope=group:north',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      overview: measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North' }),
      overviewKey: { scope: 'group', groupKey: 'north' },
    },
  )

  // The group control reflects the URL rather than defaulting to all-properties.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const group = doc.querySelector('[aria-labelledby="advanced-measurement-group-label"]')
  const checked = group?.querySelector('[role="radio"][aria-checked="true"], option[selected]')
  expect(checked?.textContent).toBe('North')
})

test('a query class in the URL selects that class on first paint', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?class=branded',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      overview: measurementOverviewResponse({ queryClass: 'branded' }),
      overviewKey: { queryClass: 'branded' },
    },
  )

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const control = doc.querySelector('[aria-labelledby="advanced-measurement-class-label"]')
  const checked = control?.querySelector('[role="radio"][aria-checked="true"]')
  expect(checked?.textContent).toBe('Branded')
})

test('a stale group key in the URL falls back to all properties instead of erroring', async () => {
  // A bookmark outlives the group it names. The page must still render.
  const html = await renderAt(
    '/projects/project_citypoint?scope=group:deleted-market',
    undefined,
    { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() },
  )

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const group = doc.querySelector('[aria-labelledby="advanced-measurement-group-label"]')
  const checked = group?.querySelector('[role="radio"][aria-checked="true"], option[selected]')
  expect(checked?.textContent).toBe('All properties')
  expect(html).not.toContain('Something went wrong')
})
