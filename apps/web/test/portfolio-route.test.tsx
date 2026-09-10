import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { queryTrackingWorkspaceResponseSchema, visibilityReportResponseSchema } from '@ainyc/canonry-contracts'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import { MANAGED_SWEEPS_COPY, MANAGED_SWEEPS_UNAVAILABLE_COPY, MANAGED_SWEEPS_RUNNING_COPY, MANAGED_SWEEPS_NEXT_LABEL } from '../src/components/project/ManagedSweepStatus.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import {
  getApiV1CdpStatusQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey,
  getApiV1ProjectsByNameMeasurementOverviewInfiniteQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameMeasurementReportQueryKey,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey,
  getApiV1ProjectsByNameSchedulesQueryKey,
  getApiV1ProjectsByNameScheduleQueryKey,
  getApiV1ProjectsByNameVisibilityReportQueryKey,
} from '@ainyc/canonry-api-client/react-query'

type EmbedBlock = { enabled: boolean; views?: string[]; projectTabs?: string[] }

beforeAll(async () => {
  await preloadAllLazyRoutes()
}, 60_000)

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
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
    overviewKey?: { scope?: 'all' | 'group'; groupKey?: string; queryClass?: 'all' | 'non-brand' | 'branded' }
    competitorLandscape?: ReturnType<typeof competitorLandscapeResponse>
    competitorLandscapeKey?: {
      window?: '7d' | '30d' | '90d' | 'all'
      queryClass?: 'all' | 'non-brand' | 'branded'
      groupKey?: string
      scope?: 'all-markets'
    }
    visibilityReport?: VisibilityReportResponse
  },
  /**
   * `seedPlan: false` leaves the measurement-plan query unseeded, which is the
   * cold-navigation state: the read is in flight and the surface is not yet
   * decidable. These render one synchronous pass, so an unseeded query stays
   * pending for the whole render.
   */
  options: {
    cdpStatus?: { connected: boolean; endpoint: string; browserVersion?: string; targets: [] }
    schedule?: unknown
    managedSweeps?: boolean
    managedRunKinds?: NonNullable<NonNullable<Window['__CANONRY_CONFIG__']>['dashboard']>['managedRunKinds']
    scanSchedule?: unknown
    failedScanHandoff?: boolean
    accountRole?: 'admin' | 'viewer'
    seedPlan?: boolean
    seedVisibilityReport?: boolean
    apiKey?: { id: string; scopes: string[]; projectId: string | null; readOnly: boolean }
    queries?: Array<{ id: string; query: string; createdAt: string }>
    settleReadiness?: boolean
    settleSchedule?: boolean
    readiness?: boolean
    configureFixture?: (dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) => void
  } = {},
): Promise<string> {
  if (embed) window.__CANONRY_CONFIG__ = { embed }
  else delete window.__CANONRY_CONFIG__
  if (options.managedSweeps !== undefined || options.managedRunKinds !== undefined) {
    window.__CANONRY_CONFIG__ = { ...window.__CANONRY_CONFIG__, dashboard: { managedSweeps: options.managedSweeps, managedRunKinds: options.managedRunKinds } }
  }

  const fixture = createDashboardFixture({})
  options.configureFixture?.(fixture.dashboard)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  if (options.cdpStatus !== undefined) {
    queryClient.setQueryData(
      getApiV1CdpStatusQueryKey({ client: heyClient }),
      options.cdpStatus,
    )
  }
  queryClient.setQueryData(
    getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } }),
    options.queries ?? [],
  )
  if (options.schedule !== undefined) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameScheduleQueryKey({ client: heyClient, path: { name: projectName }, query: { kind: 'answer-visibility' } }),
      options.schedule,
    )
    queryClient.setQueryData(
      getApiV1ProjectsByNameSchedulesQueryKey({ client: heyClient, path: { name: projectName } }),
      [options.schedule],
    )
  }
  if (options.scanSchedule !== undefined) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameScheduleQueryKey({ client: heyClient, path: { name: projectName }, query: { kind: 'site-audit' } }),
      options.scanSchedule,
    )
  }
  if (options.failedScanHandoff) {
    queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
      client: heyClient, path: { name: projectName, runId: 'run_failed' },
    }), { project: projectName, runId: 'run_failed', status: 'failed', phase: 'failed', attempt: null,
      layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
      error: 'The crawl could not reach the sitemap.',
    })
  }
  if (options.seedPlan !== false) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
      measurement?.plan ?? { active: null },
    )
  }
  const settledSetup = options.settleReadiness
    ? {
        ...(measurement?.setup ?? simpleMeasurementSetupResponse()),
        answerVisibilityProviderReady: options.readiness
          ?? measurement?.setup?.answerVisibilityProviderReady
          ?? false,
      }
    : measurement?.setup
  if (settledSetup) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
      settledSetup,
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
      queryClass: measurement.overviewKey?.queryClass ?? 'all',
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
  }
  if (measurement?.competitorLandscape) {
    const q = {
      window: measurement.competitorLandscapeKey?.window ?? '30d',
      // Advanced history follows the shared query-type selection. Simple
      // history retains its separate non-brand share-of-voice scope.
      queryClass: measurement.plan.active?.plan.schemaVersion === 2
        ? measurement.competitorLandscapeKey?.queryClass ?? 'all'
        : 'non-brand',
      ...(measurement.competitorLandscapeKey?.groupKey ? { groupKey: measurement.competitorLandscapeKey.groupKey } : {}),
      ...(measurement.competitorLandscapeKey?.scope ? { scope: measurement.competitorLandscapeKey.scope } : {}),
    }
    queryClient.setQueryData(
      getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: q,
      }),
      measurement.competitorLandscape,
    )
  }
  if (options.seedVisibilityReport !== false) {
    const url = new URL(pathname, 'http://localhost')
    const selection = parseVisibilitySelection(Object.fromEntries(url.searchParams.entries()))
    const report = measurement?.visibilityReport ?? visibilityReportResponse({
        mode: measurement?.plan?.active?.plan.schemaVersion === 2 ? 'advanced' : 'simple',
        queryClass: selection.queryClass,
        scope: selection.measurementScope,
        scopeKey: selection.measurementScopeKey,
      })
    // Fresh-project fixtures must not be seeded with a measured report.
    const project = fixture.dashboard.projects.find(entry => entry.project.name === projectName)!
    if (!measurement && options.configureFixture && project.queryCounts.total === 0) {
      report.selection.run.id = null
      report.selection.measurement.state = 'not-measured'
      report.selection.measurement.completedAt = null
      report.populations = []
    }
    queryClient.setQueryData(
      getApiV1ProjectsByNameVisibilityReportQueryKey(visibilityReportQuery(projectName, selection)), report,
    )
  }
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  const tree = (
    <AccountProvider account={options.accountRole ? { name: 'operator', role: options.accountRole } : null} apiKey={options.apiKey}>
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>
    </AccountProvider>
  )
  if ((!options.settleReadiness || !settledSetup) && !options.settleSchedule) return renderToStaticMarkup(tree)

  // Header-readiness assertions need the authoritative refetch to settle. Most
  // route snapshots intentionally stay synchronous; this opt-in branch mounts
  // only the tests that make a claim about the post-fetch sweep action.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    if (decodeURIComponent(url.pathname).endsWith('/measurement-setup')) {
      return jsonResponse(settledSetup ?? simpleMeasurementSetupResponse())
    }
    if (url.pathname.endsWith('/schedules')) return jsonResponse(options.schedule ? [options.schedule] : [])
    if (url.pathname.endsWith('/schedule') && options.schedule) return jsonResponse(options.schedule)
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  try {
    const page = render(tree)
    if (options.settleReadiness) await waitFor(() => {
      expect(queryClient.getQueryState(
        getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
      )?.fetchStatus).toBe('idle')
    })
    if (options.settleSchedule) await waitFor(() => {
      expect(queryClient.getQueryState(
        getApiV1ProjectsByNameSchedulesQueryKey({ client: heyClient, path: { name: projectName } }),
      )?.fetchStatus).toBe('idle')
    })
    const html = page.container.innerHTML
    page.unmount()
    return html
  } finally {
    globalThis.fetch = realFetch
  }
}

function visibilityReportQuery(
  projectName: string,
  selection: VisibilitySelectionState,
  pagination: { cursor?: string; search?: string } = {},
) {
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
      limit: 25,
      cursor: pagination.cursor,
      search: pagination.search,
    },
  }
}

function visibilityReportResponse(overrides: {
  mode?: 'simple' | 'advanced'
  queryClass?: 'all' | 'non-brand' | 'branded' | 'unknown'
  scope?: 'project' | 'group' | 'market' | 'property'
  scopeKey?: string
  scopeLabel?: string
  label?: string
  targetKey?: string
  queryKey?: string
  nextCursor?: string | null
  total?: number
  evidence?: boolean
} = {}): VisibilityReportResponse {
  const mode = overrides.mode ?? 'simple'
  const queryClass = overrides.queryClass ?? 'non-brand'
  const scopeKind = overrides.scope ?? 'project'
  const scopeId = scopeKind === 'project' ? 'project' : overrides.scopeKey ?? `${scopeKind}-synthetic`
  const scopeLabel = overrides.scopeLabel ?? (scopeKind === 'project' ? 'Whole site' : 'North')
  const rate = { numerator: 1, denominator: 1, rate: 1 }
  const classes = queryClass === 'all'
    ? ['branded', 'non-brand', 'unknown'] as const
    : [queryClass]
  const revision = mode === 'advanced' ? 4 : null
  const query = overrides.label ?? 'Harbor House'
  const queryKey = overrides.queryKey ?? 'visibility-query-old'
  const total = overrides.total ?? 1

  return visibilityReportResponseSchema.parse({
    selection: {
      mode,
      queryClass,
      scope: { id: scopeId, label: scopeLabel, kind: scopeKind, targetCount: 1 },
      provider: null,
      model: null,
      location: { kind: 'all' },
      time: { from: null, to: null },
      revision,
      run: { id: 'run-synthetic', explicit: false },
      provenance: mode === 'advanced'
        ? { kind: 'frozen-advanced', definitionRevision: 4 }
        : { kind: 'frozen-simple', definitionRevision: null },
      measurement: {
        state: 'measured',
        activeRevision: revision,
        measuredRevision: revision,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: '2026-08-02T12:05:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 },
      { id: 'north', label: 'North', kind: 'group', targetCount: 1 },
    ],
    filterOptions: { providers: ['openai'], models: [{ provider: 'openai', model: 'search-model' }], locations: [{ kind: 'all' }] },
    populations: classes.map(populationClass => ({
      queryClass: populationClass,
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
        createdAt: '2026-08-02T12:05:00.000Z',
        revision,
        provenance: mode === 'advanced'
          ? { kind: 'frozen-advanced', definitionRevision: 4 }
          : { kind: 'frozen-simple', definitionRevision: null },
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        continuity: { state: 'first', comparedRunId: null },
      }],
      queries: {
        items: [{
          queryKey,
          queryId: 'query-old',
          query,
          provider: 'openai',
          model: 'search-model',
          location: null,
          targetKeys: [overrides.targetKey ?? 'harbor-house'],
          answerCount: 1,
          mentionCoverage: rate,
          citationCoverage: rate,
        }],
        nextCursor: overrides.nextCursor ?? null,
        total,
      },
      evidence: {
        items: overrides.evidence ? [{
          answerId: 'answer-synthetic',
          runId: 'run-synthetic',
          queryKey,
          query,
          provider: 'openai',
          model: 'search-model',
          location: null,
          targetKeys: [overrides.targetKey ?? 'harbor-house'],
          mentioned: true,
          cited: true,
          answerText: 'Stored answer text.',
          createdAt: '2026-08-02T12:05:00.000Z',
          sources: ['https://locations.example/harbor-house'],
          observedCompetitors: [],
        }] : [],
        nextCursor: null,
        total: overrides.evidence ? 1 : 0,
      },
      competitorAvailability: { state: 'available' },
      competitors: [],
      observedCompetitors: [],
      breakdown: {
        properties: [{ id: 'harbor-house', label: 'Harbor House', queryCount: 1, mentionCoverage: rate, citationCoverage: rate }],
        groups: [{ id: 'north', label: 'North', queryCount: 1, mentionCoverage: rate, citationCoverage: rate }],
      },
    })),
  })
}

function queryTrackingWorkspaceResponse() {
  const context = { providers: ['openai'], models: { openai: 'search-model' }, location: null }
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'b'.repeat(64) },
    defaultContexts: [context],
    targets: [{ stableKey: 'citypoint', label: 'Citypoint Dental' }],
    groups: [{ stableKey: 'north', label: 'North', targetKeys: ['citypoint'] }],
    markets: [],
    tracked: [{
      queryId: 'query-citypoint',
      queryText: 'Citypoint dentist',
      normalizedText: 'citypoint dentist',
      provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
      state: 'tracked',
      lastMeasuredAt: '2026-09-04T12:10:00.000Z',
      assignments: [{
        targetKey: 'citypoint', groupKeys: ['north'], marketKeys: [], queryClass: 'branded', classificationSource: 'frozen', contexts: [context],
      }],
    }],
    savedSources: { research: [], discovery: [] },
  })
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
      displayedRunId: 'run-synthetic',
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
        flags: 0,
      }],
      nextCursor: overrides.nextCursor ?? null,
      totalEstimate: overrides.totalEstimate ?? 1,
    },
    flags: { total: 0 },
  }
}

function measurementSetupResponse(revision: number | null = null) {
  return {
    state: 'setup_in_progress' as const,
    nextAction: 'continue_setup' as const,
    mode: revision === null ? 'draft-only' as const : 'active-v2' as const,
    answerVisibilityProviderReady: true,
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
    answerVisibilityProviderReady: true,
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
    answerVisibilityProviderReady: true,
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

function competitorLandscapeResponse({
  scope = { kind: 'project' as const },
  pinnedLabel = 'Pinned operator',
  observedLabel = 'Observed rival',
}: {
  scope?: { kind: 'project' } | { kind: 'group'; groupKey: string } | { kind: 'all-markets' }
  pinnedLabel?: string
  observedLabel?: string
} = {}) {
  const row = (domain: string, label: string, pinned: boolean, shareOfVoice: number) => ({
    domain,
    label,
    surfaceClass: pinned || domain === 'citypoint.example' ? (domain === 'citypoint.example' ? 'own' as const : 'direct-competitor' as const) : 'direct-competitor' as const,
    pinned,
    mentionCount: shareOfVoice,
    shareOfVoice,
    citationCount: 2,
    answeredResults: 8,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-07T00:00:00.000Z',
    sampleUrls: [`https://${domain}/`],
  })
  return {
    window: '30d' as const,
    scope,
    project: row('citypoint.example', 'Citypoint', false, 50),
    pinned: [row('pinned.example', pinnedLabel, true, 0)],
    observed: [row('observed.example', observedLabel, false, 25)],
    otherSources: [],
    evidence: {
      answeredResults: 8,
      sourceResults: 8,
      missingAnswerTextResults: 0,
      mentionCredits: 4,
      incompleteSourceResults: 0,
      excludedProbeResults: 0,
      excludedNonCompletedResults: 0,
    },
    filters: {
      scope: scope.kind === 'all-markets' ? 'all-markets' as const : 'project' as const,
      groupKey: scope.kind === 'group' ? scope.groupKey : null,
      provider: null,
      queryClass: 'non-brand' as const,
      location: null,
      runId: null,
    },
    truncated: false,
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

test.each([false, true])('a Simple project retains its overview with or without a cached unified report (cached: %s)', async seedVisibilityReport => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { seedVisibilityReport })

  expect(html).toContain('Answer-engine trend')
  expect(html).toContain('Time window')
  expect(html).toContain('Coverage now')
  expect(html).toContain('Since last sweep')
  expect(html).toContain('Where competitors are winning')
  expect(html).toContain('Mention gaps')
  expect(html).toContain('Citation gaps')
  expect(html).toContain('Query evidence')
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Set up advanced measurement')
  expect(html).not.toContain('Republish setup')
  expect(html).not.toContain('More filters')
  expect(html).not.toContain('Project signals')
  expect(html).not.toContain('Latest signals')
})

test.each([false, true])('Simple query evidence stays open with its class and signal controls (embed: %s)', async embed => {
  const html = await renderAt(
    '/projects/project_citypoint',
    embed ? { enabled: true } : undefined,
  )
  const document = new DOMParser().parseFromString(html, 'text/html')
  const section = document.querySelector<HTMLDetailsElement>('#evidence-section')

  expect(section).not.toBeNull()
  expect(section!.open).toBe(true)
  expect(section!.querySelector('.evidence-table')).not.toBeNull()
  expect(section!.textContent).toContain('Mentions')
  expect(section!.textContent).toContain('Citations')
  expect(section!.textContent).toContain('All queries')
  if (embed) expect(section!.textContent).not.toContain('Manage queries')
})

test('an unpublished Advanced draft and stale report filters do not replace the Simple overview', async () => {
  const html = await renderAt('/projects/project_citypoint?measurementScope=group&measurementScopeKey=old&queryClass=unknown', undefined, {
    plan: { active: null },
    setup: measurementSetupResponse(),
    competitorLandscape: competitorLandscapeResponse(),
  })

  expect(html).toContain('Answer-engine trend')
  expect(html).toContain('Coverage now')
  expect(html).toContain('Query evidence')
  expect(html).toContain('Pinned operator')
  expect(html).not.toContain('More filters')
  expect(html).not.toContain('Unclassified queries')
})

test.each([false, true])('a clean Simple dashboard shows older saved results immediately (embed: %s)', async embed => {
  const report = visibilityReportResponse({ mode: 'simple', queryClass: 'all', label: 'Older saved query' })
  report.selection.provenance = { kind: 'legacy-simple', definitionRevision: null }
  for (const population of report.populations.filter(population => population.queryClass !== 'unknown')) {
    population.summary.queryCount = 0
    population.summary.answerCount = 0
    population.trend = []
    population.queries = { items: [], total: 0, nextCursor: null }
  }
  const html = await renderAt('/projects/project_citypoint', embed ? { enabled: true } : undefined, {
    plan: { active: null }, visibilityReport: report,
  }, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.visibilityEvidence = [{
        ...project.visibilityEvidence[0]!, query: 'Older saved query', queryClass: null,
      }]
    },
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const evidence = doc.querySelector<HTMLDetailsElement>('#evidence-section')
  expect(evidence?.open).toBe(true)
  expect((within(evidence!).getByLabelText('Query class') as HTMLSelectElement).value).toBe('all')
  expect(evidence?.querySelector('.evidence-table')?.textContent).toContain('Older saved query')
  expect(evidence?.querySelector('.evidence-table')?.textContent).toContain('Unclassified')
  expect(html).toContain('Coverage now')
  expect(doc.querySelector('select[aria-label="Query type"]')).toBeNull()
  expect(html).not.toContain('frozen query classification')
})

test('a Simple project loads pinned and historical competitors from the stored-evidence read', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: { active: null },
    competitorLandscape: competitorLandscapeResponse(),
  })

  expect(html).toContain('Competitor landscape')
  expect(html).toContain('Pinned operator')
  expect(html).toContain('Observed rival')
  expect(html.indexOf('Pinned operator')).toBeLessThan(html.indexOf('Observed rival'))
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
  queryClient.setQueryData(
    getApiV1ProjectsByNameVisibilityReportQueryKey(visibilityReportQuery(projectName, parseVisibilitySelection({}))),
    visibilityReportResponse(),
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

  expect(await page.findByRole('heading', { name: 'Answer-engine trend' })).toBeTruthy()
  expect(router.state.location.pathname).toBe('/projects/project_citypoint')
})

test('an active setup uses the unified report without flashing legacy metrics', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanResponse(3, true),
    report: measurementReportResponse(3),
    visibilityReport: visibilityReportResponse({ mode: 'advanced' }),
  })

  expect(html).toContain('Non-brand queries')
  expect(html).toContain('Properties mentioned')
  expect(html).toContain('Harbor House')
  expect(html).toContain('AI sweep running')
  // Competitor history remains available on the legacy Advanced Measurement
  // surface; group-only scope does not exist until a v2 plan is active.
  expect(html).toContain('Competitor landscape')
  expect(html).not.toContain('Where competitors are winning')
  expect(html).not.toContain('Republish setup')
})

test('a version-two setup never renders version-one class metrics as if they were current', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanV2Response(4),
    overview: measurementOverviewResponse(),
    visibilityReport: visibilityReportResponse({ mode: 'advanced' }),
  })

  // Was: asserted 'Edit setup' rendered here. Editing a published plan moved to
  // Settings; on the results surface it was a control unrelated to reading the
  // numbers, sitting between the headline and the table.
  expect(html).not.toContain('Edit setup')
  expect(html).toContain('Non-brand queries')
  expect(html).toContain('Harbor House')
  expect(html).toContain('1 of 1')
  expect(html).not.toContain('Republish setup')
  expect(html).not.toContain('Republish setup to enable Non-brand and Branded reporting.')
  expect(html).not.toContain('Where competitors are winning')
})

test('the unified visibility report owns scope, class, paging, search, and answer drill-in', async () => {
  const observed: string[] = []
  let releaseSearch: (() => void) | undefined
  let failRetrySearch = true
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve })
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
    if (url.pathname.endsWith('/visibility-report')) {
      if (url.searchParams.get('queryKey')) {
        return jsonResponse(visibilityReportResponse({
          mode: 'advanced',
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'Harbor Search Result',
          evidence: true,
        }))
      }
      if (url.searchParams.get('search') === 'retry') {
        if (failRetrySearch) {
          failRetrySearch = false
          return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic failure' }, 500)
        }
        return jsonResponse(visibilityReportResponse({ mode: 'advanced', label: 'Recovered Search Result' }))
      }
      if (url.searchParams.get('cursor') === 'cursor-2') {
        return jsonResponse(visibilityReportResponse({
          mode: 'advanced',
          label: 'Harbor Annex',
          targetKey: 'harbor-annex',
          total: 2,
        }))
      }
      if (url.searchParams.get('search') === 'harbor') {
        await searchGate
        return jsonResponse(visibilityReportResponse({
          mode: 'advanced',
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'Harbor Search Result',
        }))
      }
      if (url.searchParams.get('scope') === 'group' && url.searchParams.get('scopeKey') === 'north') {
        return jsonResponse(visibilityReportResponse({
          mode: 'advanced',
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'North Property',
        }))
      }
      return jsonResponse(visibilityReportResponse({ mode: 'advanced', nextCursor: 'cursor-2', total: 2 }))
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Global runId belongs to the run drawer. It must not silently pin this
  // report; only measurementRunId is a visibility-report filter.
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint?runId=drawer-run&queryClass=non-brand'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  // The global drawer owns `runId`; close it before exercising the report and
  // keep the first report URL assertion below as the boundary guard.
  fireEvent.click(await page.findByRole('button', { name: 'Close' }))
  expect(await page.findByText('Harbor House')).toBeTruthy()
  const firstReportUrl = observed.find(path => path.includes('/visibility-report?'))
  expect(firstReportUrl).toContain('scope=project')
  expect(firstReportUrl).toContain('queryClass=non-brand')
  expect(firstReportUrl).toContain('limit=25')
  expect(firstReportUrl).not.toContain('runId=drawer-run')
  expect(observed.some(path => path.includes('/measurement-overview?') || path.includes('/measurement-report?'))).toBe(false)

  fireEvent.click(page.getByText('Query results', { selector: 'span' }).closest('summary')!)
  fireEvent.click(page.getByRole('button', { name: 'Next queries' }))
  expect(await page.findByText('Harbor Annex')).toBeTruthy()
  expect(observed.some(path => path.includes('cursor=cursor-2'))).toBe(true)
  expect(observed.some(path => path.includes('cursor=cursor-2') && path.includes('runId=drawer-run'))).toBe(false)

  const scopePicker = page.getByText('Whole site', { selector: 'summary' }).closest('details')!
  fireEvent.click(page.getByText('Whole site', { selector: 'summary' }))
  fireEvent.click(within(scopePicker).getByRole('button', { name: 'Select North', exact: true }))
  expect(await page.findByText('North Property')).toBeTruthy()
  expect(observed.some(path => path.includes('scope=group') && path.includes('scopeKey=north'))).toBe(true)

  fireEvent.click(page.getByText('Query results', { selector: 'span' }).closest('summary')!)
  fireEvent.change(page.getByLabelText('Search Non-brand queries'), { target: { value: 'harbor' } })
  await waitFor(() => expect(observed.some(path => path.includes('search=harbor'))).toBe(true))
  expect((page.getByLabelText('Search Non-brand queries') as HTMLInputElement).value).toBe('harbor')
  releaseSearch!()
  expect(await page.findByText('Harbor Search Result')).toBeTruthy()
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)

  fireEvent.click(page.getByRole('button', { name: 'View answers for Harbor Search Result · openai' }))
  expect(await page.findByText('Stored answer text.')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => path.includes('queryKey=visibility-query-old'))).toBe(true))
  fireEvent.click(page.getByRole('button', { name: 'Close answers' }))
  await waitFor(() => expect(page.queryByRole('button', { name: 'Close answers' })).toBeNull())

  fireEvent.change(page.getByLabelText('Search Non-brand queries'), { target: { value: 'retry' } })
  expect(await page.findByRole('heading', { name: 'AI visibility unavailable' })).toBeTruthy()
  fireEvent.click(page.getByRole('button', { name: 'Retry' }))
  expect(await page.findByText('Recovered Search Result')).toBeTruthy()
  expect((page.getByLabelText('Search Non-brand queries') as HTMLInputElement).value).toBe('retry')
}, 15_000)

test('pinning a market competitor writes only a draft action and refetches that market landscape', async () => {
  const calls: Array<{ path: string; method: string; body: string; idempotencyKey: string | null }> = []
  let mutationSettled = false
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    const body = await request.clone().text()
    calls.push({ path, method: request.method, body, idempotencyKey: request.headers.get('idempotency-key') })

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({
        state: 'operational',
        nextAction: 'view_measurement',
        mode: 'active-v2',
        activeRevision: 4,
        activeSchemaVersion: 2,
        draft: mutationSettled ? { etag: '"mpd_1"', updatedAt: '2026-08-03T12:00:00.000Z' } : null,
      })
    }
    if (url.pathname.endsWith('/measurement-overview')) {
      return jsonResponse(measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North' }))
    }
    if (url.pathname.endsWith('/analytics/competitors')) {
      const response = competitorLandscapeResponse({
        scope: { kind: 'group', groupKey: 'north' },
        pinnedLabel: mutationSettled ? 'Draft rival' : 'North pin',
        observedLabel: 'Observed rival',
      })
      return jsonResponse({
        ...response,
        marketState: {
          activeRevision: 4,
          draft: mutationSettled ? { etag: '"mpd_1"', pendingCompetitorDomains: ['observed.example'] } : null,
        },
      })
    }
    if (url.pathname.endsWith('/measurement-plan/draft/actions/pin-competitor') && request.method === 'POST') {
      mutationSettled = true
      return jsonResponse({
        etag: '"mpd_1"',
        changed: true,
        warnings: [],
        counts: { targets: 1, includedTargets: 1, assignments: 1, unclassifiedAssignments: 0, groups: 1, competitors: 1 },
        groupKey: 'north',
        competitor: { stableKey: 'competitor-observed.example', label: 'Observed rival', domain: 'observed.example', aliases: ['Observed rival'] },
        draftCreated: true,
        published: { revision: 4, competitorsChanged: false },
      })
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint?scope=group:north'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(calls.some(call => call.path.includes('/analytics/competitors?'))).toBe(false)
  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary' }))
  expect(await page.findByRole('button', { name: 'Pin observed.example' })).toBeTruthy()
  fireEvent.click(page.getByRole('button', { name: 'Pin observed.example' }))

  await waitFor(() => expect(calls.some(call => call.path.endsWith('/measurement-plan/draft/actions/pin-competitor') && call.method === 'POST')).toBe(true))
  const mutation = calls.find(call => call.path.endsWith('/measurement-plan/draft/actions/pin-competitor'))!
  expect(JSON.parse(mutation.body)).toEqual({ expectedActiveRevision: 4, groupKey: 'north', domain: 'observed.example' })
  expect(mutation.idempotencyKey).toBeTruthy()

  const mutationIndex = calls.indexOf(mutation)
  await waitFor(() => expect(calls.slice(mutationIndex + 1).some(call => (
    call.method === 'GET' && call.path.includes('/analytics/competitors?') && call.path.includes('groupKey=north')
  ))).toBe(true))
  expect(await page.findByText('Draft rival')).toBeTruthy()
  expect(calls.some(call => call.path.includes('/measurement-plan/draft/actions/publish'))).toBe(false)
})

test('a direct Portfolio URL falls back safely in embed mode', async () => {
  const html = await renderAt('/projects/project_citypoint/portfolio', {
    enabled: true,
    views: ['project'],
    projectTabs: ['portfolio', 'unknown'],
  })

  expect(html).toContain('Citypoint Dental NYC')
  expect(html).toContain('Answer-engine trend')
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
    if (url.pathname.endsWith('/visibility-report')) return jsonResponse(visibilityReportResponse())
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

  expect(await screen.findByRole('heading', { name: 'Answer-engine trend' })).toBeTruthy()
  await waitFor(() => expect(observed.some(path => path.endsWith('/runs?kind=answer-visibility'))).toBe(true))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(observed.filter(path =>
    path.endsWith('/queries')
    || path.includes('/measurement-report?')
    || path.includes('/measurement-overview?')
    || path.includes('/query-tracking'),
  )).toEqual([])
  expect(observed.some(path => path.includes('/visibility-report?'))).toBe(false)
})

test('embedded Queries and legacy Discovery URLs fall back before reading unpublished tracking or research data', async () => {
  window.__CANONRY_CONFIG__ = {
    embed: { enabled: true, views: ['project'], projectTabs: ['overview', 'queries', 'discovery'] },
  }
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (url.pathname.endsWith('/visibility-report')) return jsonResponse(visibilityReportResponse())
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  for (const tab of ['queries', 'discovery']) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createAppRouter(queryClient, { initialEntries: [`/projects/project_citypoint/${tab}`] })
    await router.load()
    const screen = render(
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Answer-engine trend' })).toBeTruthy()
    screen.unmount()
  }

  expect(observed.some(path => path.includes('/query-tracking') || path.includes('/research') || path.includes('/discover'))).toBe(false)
})

test('the Queries route reads the workspace and keeps scoped removal active after its URL update', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (url.pathname.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (url.pathname.endsWith('/measurement-setup')) return jsonResponse({ state: 'unconfigured', nextAction: 'configure', mode: 'none', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (url.pathname.endsWith('/query-tracking')) return jsonResponse(queryTrackingWorkspaceResponse())
    if (url.pathname.endsWith('/measurement-query-templates')) return jsonResponse({ templates: [] })
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/queries?measurementScope=group&measurementScopeKey=north'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  expect(page.getByRole('tab', { name: 'Tracked' }).getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(observed.some(path => path.endsWith('/query-tracking'))).toBe(true))
  expect(observed.some(path => path.includes('/discover') || path.includes('/research'))).toBe(false)

  fireEvent.click(page.getByRole('button', { name: 'Remove Citypoint dentist' }))
  await waitFor(() => expect(router.state.location.search.trackingQueryId).toBe('query-citypoint'))
  expect(router.state.location.search.measurementScope).toBe('group')
  expect(router.state.location.search.measurementScopeKey).toBe('north')
  expect(page.getByRole('heading', { name: 'Remove query' })).toBeTruthy()
  expect(page.queryByRole('heading', { name: 'Edit query' })).toBeNull()
  expect(page.getByText('Only assignments in North · Group will be removed. Earlier results stay unchanged.')).toBeTruthy()
})

test('the legacy Discovery route opens the separate research workspace without tracking reads', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (url.pathname.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (url.pathname.endsWith('/measurement-setup')) return jsonResponse({ state: 'unconfigured', nextAction: 'configure', mode: 'none', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (url.pathname.endsWith('/discover/sessions')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/discovery'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(await page.findByRole('heading', { name: 'Generate and check questions' })).toBeTruthy()
  expect(page.getByRole('tab', { name: 'Research' }).getAttribute('aria-selected')).toBe('true')
  expect(page.getByRole('tab', { name: 'Find queries' }).getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(observed.some(path => path.includes('/discover/sessions'))).toBe(true))
  expect(observed.some(path => path.includes('/query-tracking'))).toBe(false)
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
    if (url.pathname.endsWith('/visibility-report')) return jsonResponse(visibilityReportResponse())
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
  expect(await page.findByRole('heading', { name: 'Answer-engine trend' })).toBeTruthy()
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

test('cached competitor history remains visible when its background refresh fails', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/measurement-setup')) return jsonResponse(simpleMeasurementSetupResponse())
    if (url.pathname.endsWith('/visibility-report')) return jsonResponse(visibilityReportResponse({ mode: 'simple' }))
    if (url.pathname.endsWith('/analytics/competitors')) {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    { active: null },
  )
  queryClient.setQueryData(
    getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { window: '30d', queryClass: 'non-brand' },
    }),
    competitorLandscapeResponse({ pinnedLabel: 'Cached pin', observedLabel: 'Cached observed rival' }),
  )
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary' }))

  await waitFor(() => expect(queryClient.getQueryState(
    getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { window: '30d', queryClass: 'non-brand' },
    }),
  )?.status).toBe('error'))
  expect(page.getByRole('rowheader', { name: 'Cached pin' })).toBeTruthy()
  expect(page.getByRole('rowheader', { name: 'Cached observed rival' })).toBeTruthy()
  expect(page.getByRole('alert').textContent).toContain('Could not refresh competitor history. Showing the last available data.')
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

function forceNoisyFreshVisibility(dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) {
  const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  const emptyMentionBreakdown = {
    projectMentionSnapshots: 0,
    competitorMentionSnapshots: 0,
    perCompetitor: [],
    snapshotsWithAnswerText: 0,
    snapshotsTotal: 0,
    score: null,
  }

  project.visibilityEvidence = []
  project.queryCounts = { cited: 0, total: 0 }
  project.recentRuns = []
  project.mentionSummary.value = 'No data'
  project.mentionSummary.delta = 'Run a sweep first'
  project.visibilitySummary.value = 'No data'
  project.visibilitySummary.delta = 'Run a sweep first'
  project.mentionShareSummary.value = 'No data'
  project.mentionShareSummary.delta = 'Run a sweep first'
  project.mentionShareSummary.breakdown = { ...emptyMentionBreakdown }
  project.mentionShareSummary.branded = { ...emptyMentionBreakdown }
  project.mentionGaps.value = 'No data'
  project.mentionGaps.delta = 'Run a sweep first'
  project.gapQueries.value = 'No data'
  project.gapQueries.delta = 'Run a sweep first'
  dashboard.runs = []
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

test('a DISABLED schedule promises no next sweep, even though the row still carries a stale nextRunAt', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { schedule: schedule({ enabled: false }) })

  expect(html).not.toContain('Next AI sweep')
  // The override is still offered — a paused schedule is exactly when someone
  // needs to run one by hand.
  expect(html).toContain('AI sweep')
})

test('a fresh project offers one AI Visibility setup action instead of an unready sweep', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      forceNoisyFreshVisibility(dashboard)
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['gemini']
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: false,
  })

  expect(html).toContain('Set up AI Visibility')
  expect(html).toContain('No AI Visibility baseline yet')
  expect(html).toContain('Coverage signals')
  expect(html).toContain('Your brand or domain appears in the answer text.')
  expect(html).toContain('Your domain appears in the engine')
  expect(html).toContain('Complete your first AI Visibility sweep to measure both signals.')
  expect(html).toContain('Where competitors are winning')
  expect(html).toContain('Competitor landscape')
  expect(html).toContain('Add competitor')
  expect(html).toContain('Competitive mention and citation gaps appear after the first AI Visibility sweep.')
  expect(html).not.toContain('No completed sweep')
  expect(html.match(/No data/g) ?? []).toHaveLength(0)
  expect(html.match(/Run a sweep first/g) ?? []).toHaveLength(0)
  expect(html).not.toContain('No comparison yet')
  expect(html).not.toContain('Run another sweep')
  expect(html).not.toContain('Baseline captured')
  expect(html).not.toContain('Run AI sweep')
})

test('a first sweep in flight replaces empty-state instructions with one live status', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      const queuedProjectRun = project.recentRuns.find(run => run.status === 'queued')!
      const queuedDashboardRun = dashboard.runs.find(run => run.status === 'queued')!
      forceNoisyFreshVisibility(dashboard)
      const freshProject = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      freshProject.recentRuns = [queuedProjectRun]
      dashboard.runs = [queuedDashboardRun]
    },
    settleReadiness: true,
    readiness: true,
  })

  expect(html).toContain('A fresh sweep is running now')
  expect(html).toContain('Queued')
  expect(html).not.toContain('No AI Visibility baseline yet')
  expect(html.match(/Your first sweep is running\. Results will appear when it completes\./g)).toHaveLength(1)
  expect(html.match(/Competitive mention and citation gaps appear after the first AI Visibility sweep\./g)).toHaveLength(1)
  expect(html.match(/No data/g) ?? []).toHaveLength(0)
  expect(html.match(/Run a sweep first/g) ?? []).toHaveLength(0)
  expect(html).not.toContain('Complete your first AI Visibility sweep')
  expect(html).not.toContain('No comparison yet')
})

test('a frozen visibility baseline remains visible when five newer failed runs fill the recent-run slice', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      const failedRun = project.recentRuns.find(run => run.kind === 'answer-visibility')!
      project.recentRuns = Array.from({ length: 5 }, (_, index) => ({
        ...failedRun,
        id: `failed-recent-${index}`,
        status: 'failed' as const,
        createdAt: `2026-09-0${index + 1}T12:00:00.000Z`,
      }))
    },
  })

  expect(html).toContain('Coverage now')
  expect(html).toContain('Since last sweep')
  expect(html).toContain('Mention gaps')
  expect(html).not.toContain('No AI Visibility baseline yet')
  expect(html).not.toContain('Complete your first AI Visibility sweep')
  expect(html).not.toContain('Competitive mention and citation gaps appear after the first AI Visibility sweep.')
})

test('fresh project settings use the empty collection instead of a noisy schedule 404', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/schedules')) return jsonResponse([])
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({
        state: 'not_started',
        nextAction: 'start_setup',
        mode: 'none',
        activeRevision: null,
        activeSchemaVersion: null,
        draft: null,
      })
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.visibilityEvidence = []
  project.queryCounts = { cited: 0, total: 0 }
  project.recentRuns = []
  fixture.dashboard.runs = []
  fixture.dashboard.settings.providerStatuses = []

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/settings'] })
  await router.load()
  const page = render(
    <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>
    </AccountProvider>,
  )

  expect(await page.findByRole('heading', { name: 'Scheduled runs' })).toBeTruthy()
  expect(page.getByText('No schedule configured. Set one to automatically trigger visibility sweeps.')).toBeTruthy()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(observed.some(path => path.endsWith('/schedules'))).toBe(true)
  expect(observed.some(path => path.endsWith('/schedule'))).toBe(false)
})

test('a query-ready project with a configured provider can run an AI sweep', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      const pendingEvidence = {
        ...project.visibilityEvidence[0]!,
        id: 'evidence-query-ready',
        query: 'emergency dentist brooklyn',
        provider: '',
        model: null,
        location: null,
        citationState: 'pending' as const,
        visibilityState: 'pending' as const,
        visibilityChangeLabel: 'Awaiting first run',
        changeLabel: 'Awaiting first run',
        answerSnippet: '',
        citedDomains: [],
        evidenceUrls: [],
        competitorDomains: [],
        groundingSources: [],
        relatedTechnicalSignals: [],
        summary: 'This query has not been measured yet.',
        runHistory: [],
      }
      forceNoisyFreshVisibility(dashboard)
      project.visibilityEvidence = [pendingEvidence]
    },
    queries: [{
      id: 'query-ready',
      query: 'emergency dentist brooklyn',
      createdAt: '2026-09-01T12:00:00.000Z',
    }],
    settleReadiness: true,
    readiness: true,
  })

  expect(html).toContain('Run AI sweep')
  expect(html).toContain('No AI Visibility baseline yet')
  expect(html).not.toContain('Set up AI Visibility to capture a baseline')
  expect(html).not.toContain('Checking AI readiness')
})

test('a project-scoped writer reads sweep readiness without instance settings access', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanResponse(7),
    setup: simpleMeasurementSetupResponse(),
  }, {
    apiKey: {
      id: 'key-project-writer',
      scopes: ['*'],
      projectId: 'project_citypoint',
      readOnly: false,
    },
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.recentRuns = []
      dashboard.runs = []
      // A project-scoped principal cannot rely on the instance-settings
      // summary. The project-readable setup response above is authoritative.
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: true,
  })

  expect(html).toContain('Run AI sweep')
  expect(html).not.toContain('Checking AI readiness')
  expect(html).not.toContain('Retry AI readiness')
})

test('a project-scoped writer can retry when the project readiness read fails', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
    }
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/schedules')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.recentRuns = []
  fixture.dashboard.runs = []
  fixture.dashboard.settings.providerStatuses = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1CdpStatusQueryKey({ client: heyClient }),
    { connected: false, endpoint: '', targets: [] },
  )
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(
    <AccountProvider
      account={null}
      apiKey={{ id: 'key-project-writer', scopes: ['*'], projectId: project.project.id, readOnly: false }}
    >
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>
    </AccountProvider>,
  )

  expect(await page.findByRole('button', { name: 'Retry AI readiness' })).toBeTruthy()
  expect(page.queryByRole('button', { name: 'Set up AI Visibility' })).toBeNull()
  expect(page.queryByRole('button', { name: 'Run AI sweep' })).toBeNull()
})

test('saving the project provider allowlist refreshes server-owned sweep readiness', async () => {
  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.project.providers = ['claude']
  project.recentRuns = []
  fixture.dashboard.runs = []
  fixture.dashboard.settings.providerStatuses = []

  let providersUpdated = false
  let setupReads = 0
  let savedBody: Record<string, unknown> | undefined
  let updatedProject = { ...project.project }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input))
    const url = new URL(request.url, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/measurement-setup')) {
      setupReads += 1
      return jsonResponse({
        ...simpleMeasurementSetupResponse(),
        answerVisibilityProviderReady: providersUpdated,
      })
    }
    if (path.endsWith('/settings')) {
      return jsonResponse({
        providers: [{ name: 'gemini', displayName: 'Gemini', configured: true }],
        providerCatalog: [{
          name: 'gemini',
          displayName: 'Gemini',
          mode: 'api',
          modelConfigurable: true,
          defaultModel: 'gemini-2.5-flash',
          knownModels: [],
          modelValidationPattern: { source: '^gemini-', flags: '' },
          modelValidationHint: 'Use a Gemini model ID.',
        }],
        google: { configured: false },
        bing: { configured: false },
      })
    }
    if (path.endsWith(`/projects/${project.project.name}`)) {
      if (request.method === 'PUT') {
        savedBody = await request.clone().json() as Record<string, unknown>
        providersUpdated = true
        updatedProject = { ...updatedProject, ...savedBody }
      }
      return jsonResponse(updatedProject)
    }
    if (path.endsWith('/projects')) return jsonResponse([updatedProject])
    if (path.endsWith('/queries')) return jsonResponse([{ id: 'tracked-query', query: 'places to rent' }])
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/schedules') || path.endsWith('/notifications')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/settings'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('button', { name: 'Set up AI Visibility' })).toBeTruthy()
  fireEvent.click(await page.findByLabelText('All configured engines'))
  fireEvent.click(page.getByRole('button', { name: 'Save engines' }))

  expect(await page.findByRole('button', { name: 'Run AI sweep' })).toBeTruthy()
  expect(savedBody?.providers).toEqual([])
  expect(setupReads).toBeGreaterThanOrEqual(2)
})

test('window focus refreshes server-owned sweep readiness on a mounted project', async () => {
  let ready = false
  let setupReads = 0
  let releaseFocusRead: (() => void) | undefined
  const focusRead = new Promise<void>(resolve => { releaseFocusRead = resolve })
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    if (path.endsWith('/measurement-setup')) {
      setupReads += 1
      if (setupReads === 2) await focusRead
      return jsonResponse({
        ...simpleMeasurementSetupResponse(),
        answerVisibilityProviderReady: ready,
      })
    }
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/schedules')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.recentRuns = []
  fixture.dashboard.runs = []
  fixture.dashboard.settings.providerStatuses = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1CdpStatusQueryKey({ client: heyClient }),
    { connected: false, endpoint: '', targets: [] },
  )
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('button', { name: 'Set up AI Visibility' })).toBeTruthy()
  ready = true
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  expect(await page.findByRole('button', { name: 'Checking AI readiness…' })).toBeTruthy()

  releaseFocusRead?.()
  expect(await page.findByRole('button', { name: 'Run AI sweep' })).toBeTruthy()
  expect(setupReads).toBe(2)
})

test('a sweep confirmation cannot use cached readiness after its refresh fails', async () => {
  let failed = false
  const writes: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
    const path = decodeURIComponent(url.pathname)
    if (input instanceof Request && input.method === 'POST') writes.push(path)
    if (path.endsWith('/measurement-setup')) return failed
      ? jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
      : jsonResponse(simpleMeasurementSetupResponse())
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/schedules') || path.endsWith('/runs')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })
  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.recentRuns = []
  fixture.dashboard.runs = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(<QueryClientProvider client={queryClient}><DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider>)
  fireEvent.click(await page.findByRole('button', { name: 'Run AI sweep' }))
  const confirm = await page.findByRole('button', { name: 'Run project-wide sweep' })
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  expect(writes).toEqual([])
  failed = true
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: project.project.name } }) })
  })
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true))
  fireEvent.click(confirm)
  expect(writes).toEqual([])
  fireEvent.click(page.getByRole('button', { name: 'Cancel' }))
  expect(await page.findByRole('button', { name: 'Retry AI readiness' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(page.getByRole('button', { name: 'Retry AI readiness' })))
})

test('AI Visibility honors the project provider allowlist instead of any configured provider', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['claude']
      project.recentRuns = []
      dashboard.runs = []
    },
    settleReadiness: true,
    readiness: false,
  })

  expect(html).toContain('Set up AI Visibility')
  expect(html).not.toContain('Run AI sweep')
})

test('an active measurement plan supplies runnable queries when the live basket is empty', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanResponse(9, true),
  }, {
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.visibilityEvidence = []
      project.queryCounts = { cited: 0, total: 0 }
      project.recentRuns = []
      dashboard.runs = []
    },
    settleReadiness: true,
    readiness: true,
  })

  expect(html).toContain('Run AI sweep')
  expect(html).not.toContain('Set up AI Visibility to capture a baseline')
})

test('a configured CDP provider is runnable even when no API provider is configured or connected', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    cdpStatus: {
      connected: false,
      endpoint: 'ws://127.0.0.1:9222',
      browserVersion: 'Chrome not reachable at ws://127.0.0.1:9222',
      targets: [],
    },
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['cdp:chatgpt']
      project.recentRuns = []
      dashboard.runs = []
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: true,
  })

  expect(html).toContain('Run AI sweep')
  expect(html).not.toContain('Set up AI Visibility to capture a baseline')
})

test('an unregistered CDP status does not make the project runnable', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    cdpStatus: { connected: false, endpoint: '', targets: [] },
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['cdp:chatgpt']
      project.recentRuns = []
      dashboard.runs = []
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: false,
  })

  expect(html).toContain('Set up AI Visibility')
  expect(html).not.toContain('Run AI sweep')
})

test('an established schedule stays visible when run prerequisites need repair', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    schedule: schedule(),
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['claude']
      project.recentRuns = project.recentRuns.filter(run => run.status !== 'queued' && run.status !== 'running')
      dashboard.runs = dashboard.runs.filter(run => run.status !== 'queued' && run.status !== 'running')
    },
    settleReadiness: true,
    readiness: false,
  })

  expect(html).toContain('Next AI sweep')
  expect(html).toContain('Set up AI Visibility')
  expect(html).not.toContain('Run AI sweep')
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
test('an unresolved measurement plan shows a skeleton instead of flashing legacy or unified metrics', async () => {
  // The bug: `resolveAdvancedMeasurementMode` reads a pending plan read as
  // `null`, and `null` means "this project has no plan". So a project WITH an
  // advanced plan painted the legacy overview first and swapped it out once the
  // read landed — a visible flash on every cold navigation into a project.
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { seedPlan: false })

  expect(html).toContain('Loading project overview')
  // Neither the old overview nor a cached report can answer an unresolved plan.
  expect(html).not.toContain('Where competitors are winning')
  expect(html).not.toContain('Non-brand queries')
})

test('a settled absent plan renders the Simple overview, so the guard is not a permanent skeleton', async () => {
  // The other half: once the plan settles as absent, render the Simple overview. A guard that cannot tell pending from settled would
  // strand this on the skeleton forever.
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('Answer-engine trend')
  expect(html).not.toContain('Loading project overview')
})

// ── Measurement view state lives in the URL ──────────────────────────────────
//
// Scale is the reason. At 47 properties an operator can re-pick a market after
// every reload; at 200+ markets that is the whole interaction, and a scope that
// only exists in component state cannot be linked, bookmarked, or reloaded.
// `?measurementScope=group&measurementScopeKey=<key>` makes a market a place
// you can send someone.

test('a scope in the URL selects that group on first paint, with no interaction', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?measurementScope=group&measurementScopeKey=north',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      visibilityReport: visibilityReportResponse({ mode: 'advanced', scope: 'group', scopeKey: 'north', scopeLabel: 'North' }),
    },
  )

  // The server-resolved scope reflects the URL rather than defaulting to site.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.querySelector('summary')?.textContent).toBe('North · 1 property')
})

test('a market scope reads that group\'s stored competitor landscape', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?scope=group:north',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      overview: measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North' }),
      overviewKey: { scope: 'group', groupKey: 'north' },
      competitorLandscape: competitorLandscapeResponse({
        scope: { kind: 'group', groupKey: 'north' },
        pinnedLabel: 'North pin',
        observedLabel: 'North rival',
      }),
      competitorLandscapeKey: { groupKey: 'north' },
    },
  )

  expect(html).toContain('North pin')
  expect(html).toContain('North rival')
  expect(html).not.toContain('Pinned operator')
})

test('a market fallback keeps project pins alongside frozen market pins', async () => {
  const plan = measurementPlanV2Response(2)
  plan.active.plan.groups[0]!.competitors = [{
    stableKey: 'north-rival',
    label: 'North rival',
    domain: 'north-rival.example',
    aliases: [],
  }]

  const html = await renderAt(
    '/projects/project_citypoint?scope=group:north',
    undefined,
    {
      plan,
      overview: measurementOverviewResponse({ scope: 'group', scopeKey: 'north', scopeLabel: 'North' }),
      overviewKey: { scope: 'group', groupKey: 'north' },
    },
  )

  expect(html).toContain('North rival')
  expect(html).toContain('downtownsmiles.com')
})

test('an all-properties v2 view requests and renders the explicit all-markets landscape', async () => {
  const html = await renderAt(
    '/projects/project_citypoint',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      overview: measurementOverviewResponse(),
      overviewKey: { scope: 'all' },
      competitorLandscape: competitorLandscapeResponse({
        scope: { kind: 'all-markets' },
        pinnedLabel: 'All market pin',
        observedLabel: 'All market rival',
      }),
      competitorLandscapeKey: { scope: 'all-markets' },
    },
  )

  expect(html).toContain('All market pin')
  expect(html).toContain('All market rival')
  expect(html).toContain('All markets')
})

test('a query class in the URL selects that class on first paint', async () => {
  const html = await renderAt(
    '/projects/project_citypoint?queryClass=branded',
    undefined,
    {
      plan: measurementPlanV2Response(2),
      overview: measurementOverviewResponse({ queryClass: 'branded' }),
      overviewKey: { queryClass: 'branded' },
      competitorLandscape: competitorLandscapeResponse({
        scope: { kind: 'all-markets' },
        observedLabel: 'Branded market rival',
      }),
      competitorLandscapeKey: { scope: 'all-markets', queryClass: 'branded' },
      visibilityReport: visibilityReportResponse({ mode: 'advanced', queryClass: 'branded' }),
    },
  )

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const control = doc.querySelector('select[aria-label="Query type"]')
  const checked = control?.querySelector('option[selected]')
  expect(checked?.textContent).toBe('Branded')
  expect(html).toContain('Branded market rival')
})

test('collapsed competitor history starts on demand and follows query class', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)

    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (url.pathname.endsWith('/visibility-report')) {
      const queryClass = url.searchParams.get('queryClass') === 'branded' ? 'branded' as const : 'all' as const
      return jsonResponse(visibilityReportResponse({ mode: 'advanced', queryClass }))
    }
    if (url.pathname.endsWith('/measurement-overview')) {
      const queryClass = url.searchParams.get('queryClass') === 'branded' ? 'branded' as const : 'all' as const
      return jsonResponse(measurementOverviewResponse({
        queryClass,
        label: queryClass === 'branded' ? 'Branded Property' : 'All-query Property',
      }))
    }
    if (url.pathname.endsWith('/analytics/competitors')) {
      const queryClass = url.searchParams.get('queryClass') === 'branded' ? 'branded' as const : 'all' as const
      const response = competitorLandscapeResponse({
        scope: { kind: 'all-markets' },
        pinnedLabel: queryClass === 'branded' ? 'Branded pin' : 'All-query pin',
        observedLabel: queryClass === 'branded' ? 'Branded rival' : 'All-query rival',
      })
      return jsonResponse({
        ...response,
        filters: { ...response.filters, queryClass },
      })
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

  expect(observed.some(path => path.includes('/analytics/competitors?'))).toBe(false)

  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary' }))
  expect(await page.findByText('All-query rival')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => (
    path.includes('/analytics/competitors?')
    && path.includes('scope=all-markets')
    && path.includes('queryClass=non-brand')
  ))).toBe(true))

  fireEvent.change(page.getByLabelText('Query type'), { target: { value: 'branded' } })

  expect(await page.findByRole('heading', { name: 'Branded queries' })).toBeTruthy()
  expect(await page.findByText('Branded rival')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => (
    path.includes('/analytics/competitors?')
    && path.includes('scope=all-markets')
    && path.includes('queryClass=branded')
  ))).toBe(true))
  expect(router.state.location.search).toMatchObject({ queryClass: 'branded' })
})

test('a stale group key fails closed instead of silently broadening to the whole site', async () => {
  const observed: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`
    observed.push(path)
    if (path.endsWith('/runs?kind=answer-visibility')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(2))
    if (url.pathname.endsWith('/visibility-report')) {
      return jsonResponse({ code: 'VISIBILITY_SCOPE_NOT_FOUND', message: 'That group no longer exists.' }, 400)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, {
    initialEntries: ['/projects/project_citypoint?measurementScope=group&measurementScopeKey=deleted-market'],
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('heading', { name: 'AI visibility unavailable' })).toBeTruthy()
  const staleRequest = observed.find(path => path.includes('/visibility-report?'))
  expect(staleRequest).toContain('scope=group')
  expect(staleRequest).toContain('scopeKey=deleted-market')
  expect(observed.some(path => path.includes('/visibility-report?scope=project'))).toBe(false)
})

const managedSchedule = {
  id: 'managed-schedule', projectId: 'project_citypoint', kind: 'answer-visibility',
  enabled: true, cronExpr: '0 6 * * *', timezone: 'UTC', providers: [],
  nextRunAt: '2026-09-08T06:00:00.000Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

function projectHeader(html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  return container.querySelector('.page-header')!
}

test('managed sweeps unset preserves the operator sweep control and identical opt-out markup', async () => {
  const options = { settleReadiness: true, readiness: true,
    configureFixture(dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) {
      dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
    },
  }
  const original = await renderAt('/projects/project_citypoint', undefined, undefined, options)
  const disabled = await renderAt('/projects/project_citypoint', undefined, undefined, { ...options, managedSweeps: false })
  expect(projectHeader(original).outerHTML).toBe(projectHeader(disabled).outerHTML)
  expect(projectHeader(original).textContent).toContain('Run AI sweep')
  expect(original).not.toContain(MANAGED_SWEEPS_COPY)
})

test.each(['simple', 'advanced'] as const)('managed sweeps replaces the %s header control for admins and viewers', async mode => {
  for (const accountRole of ['admin', 'viewer'] as const) {
    const html = await renderAt('/projects/project_citypoint', undefined,
      mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
      { managedSweeps: true, schedule: managedSchedule, accountRole, configureFixture(dashboard) {
        dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
      } },
    )
    const header = projectHeader(html)
    expect(header.querySelectorAll('button')).toHaveLength(mode === 'advanced' ? 1 : 0)
    expect(header.querySelector('time')?.dateTime).toBe(managedSchedule.nextRunAt)
    expect(header.textContent).toContain(mode === 'advanced'
      ? 'Next Portfolio AI visibility Sweep: September 8th, 2026'
      : MANAGED_SWEEPS_NEXT_LABEL)
    if (mode === 'advanced') expect(header.querySelector('button')?.getAttribute('aria-label')).toBe('This is managed by your Canonry team.')
    if (mode === 'advanced') expect(header.querySelectorAll('.page-header-right > p:not([role="status"])')).toHaveLength(0)
    expect(html).not.toMatch(/Run AI sweep|Run measurement|Checking AI readiness|Set up AI Visibility/)
  }
})

test('Advanced header keeps an explicit historical measurement range', async () => {
  const html = await renderAt('/projects/project_citypoint?measurementFrom=2026-09-01T00:00:00.000Z&measurementTo=2026-09-08T23:59:59.999Z', undefined,
    { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() },
    { managedSweeps: true, schedule: managedSchedule },
  )
  const header = projectHeader(html)
  const range = header.querySelector('.page-header-right > p:not([role="status"])')
  expect(range?.textContent).toContain('2026-09-01')
  expect(range?.textContent).toContain('2026-09-08')
})

test('managed sweeps without a schedule replaces the header action without inventing a date', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture(dashboard) {
      dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
    },
  })
  const status = projectHeader(html).querySelector('[role="status"]')!
  expect(status.textContent).toBe(MANAGED_SWEEPS_UNAVAILABLE_COPY)
  expect(status.querySelector('time')).toBeNull()
  expect(projectHeader(html).querySelector('button')).toBeNull()
})

test.each(['simple', 'advanced'] as const)('managed %s project header retains queued and running sweep signals', async mode => {
  for (const status of ['queued', 'running'] as const) {
    const html = await renderAt('/projects/project_citypoint', undefined,
      mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
      { managedSweeps: true, schedule: managedSchedule, configureFixture(dashboard) {
        const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
        project.recentRuns = [{ ...project.recentRuns[0]!, kind: 'answer-visibility', status }]
      } },
    )
    const header = projectHeader(html)
    expect(header.querySelector('[role="status"]')?.textContent).toBe(MANAGED_SWEEPS_RUNNING_COPY)
    expect(header.querySelector('time')).toBeNull()
    expect(header.querySelector('button')).toBeNull()
  }
})

test.each(['simple', 'advanced'] as const)('managed %s settings exposes schedule details without controls', async mode => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined,
    mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
    { managedSweeps: true, schedule: managedSchedule, accountRole: 'admin', settleSchedule: true },
  )
  const container = document.createElement('div')
  container.innerHTML = html
  const section = within(container).getByRole('heading', { name: 'Scheduled runs' }).closest('section')!
  expect(section.textContent).toContain(MANAGED_SWEEPS_COPY)
  expect(section.textContent).toContain('0 6 * * *')
  expect(within(section).queryByRole('button', { name: /Set schedule|Edit schedule|Pause|Resume|Remove|Save schedule/ })).toBeNull()
})

test('managed header does not label an active Site Health scan as a sweep', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.recentRuns = [{ ...project.recentRuns[0]!, kind: 'site-audit', status: 'running' }]
    },
  })
  expect(projectHeader(html).textContent).not.toContain('AI sweep running')
})

test('managed sweeps removes Simple empty-state launch instructions', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture: forceNoisyFreshVisibility,
  })
  expect(html).toContain(MANAGED_SWEEPS_COPY)
  expect(html).not.toMatch(/Run another sweep|Complete your first AI Visibility sweep|Run a sweep/)
})

test('legacy managedSweeps alone still leaves Site Health scan controls available', async () => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo', undefined, undefined, { managedSweeps: true })
  expect(html).toMatch(/Run scan|Checking scan/)
  expect(projectHeader(html).textContent).toContain(MANAGED_SWEEPS_RUNNING_COPY)
})

test('managed sweeps replaces the global batch sweep control', async () => {
  const original = await renderAt('/runs')
  expect(original).toContain('Run all projects')
  const managed = await renderAt('/runs', undefined, undefined, { managedSweeps: true })
  expect(managed).not.toContain('Run all projects')
  expect(managed).toContain(MANAGED_SWEEPS_COPY)
})


// Reverses #1108's deliberate Site Health exclusion when site-audit is opted in.
// The legacy boolean alone remains answer-visibility-only (asserted above).
test.each(['simple', 'advanced'] as const)('managed run kinds remove %s Site Health viewer launches and show the actual schedule', async mode => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo', undefined,
    mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
    { managedRunKinds: ['answer-visibility', 'site-audit'], accountRole: 'viewer',
      scanSchedule: { ...managedSchedule, kind: 'site-audit', nextRunAt: '2026-10-01T06:00:00.000Z' },
    },
  )
  expect(html).not.toMatch(/Run scan|Checking scan|Scan settings|Check dead links/)
  expect(html).toContain('Next scan')
  expect(html).toContain('Thursday 1 Oct, 06:00 UTC')
  const container = document.createElement('div')
  container.innerHTML = html
  expect(container.querySelector('time[datetime="2026-10-01T06:00:00.000Z"]')).not.toBeNull()
})

test.each(['simple', 'advanced'] as const)('managed %s Site Health hides the cold URL recovery button without losing failure copy', async mode => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo?siteHealthRunId=run_failed', undefined,
    mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
    { managedRunKinds: ['site-audit'], accountRole: 'viewer', failedScanHandoff: true },
  )
  expect(html).toContain('Scan failed')
  expect(html).toContain('The crawl could not reach the sitemap.')
  expect(html).not.toMatch(/Run scan|Scan settings|Check dead links/)
  expect(html).toContain('Scans are run by your Canonry team')
})

test.each(['simple', 'advanced'] as const)('managed %s Site Health keeps admin scan controls', async mode => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo', undefined,
    mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
    { managedRunKinds: ['site-audit'], accountRole: 'admin' },
  )
  expect(html).toContain('Run scan')
  expect(html).toContain('Scan settings')
  expect(html).not.toContain('Scans are run by your Canonry team')
})

test.each(['', '/technical-aeo', '/settings', '/history'])('unset managed run kinds preserve serialized Simple and Advanced route markup (%s)', async suffix => {
  for (const mode of ['simple', 'advanced'] as const) {
    const measurement = mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined
    const original = await renderAt(`/projects/project_citypoint${suffix}`, undefined, measurement, { accountRole: 'viewer' })
    const empty = await renderAt(`/projects/project_citypoint${suffix}`, undefined, measurement, { accountRole: 'viewer', managedRunKinds: [] })
    expect(empty).toBe(original)
  }
})
