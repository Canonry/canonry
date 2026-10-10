import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import type { CompetitorLandscapeResponse, EmbedClientConfig, MeasurementPlanResponse, MeasurementPlanV2, UiTelemetryEvent, VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { aggregateSentiment, emptyCitationVisibility, queryTrackingWorkspaceResponseSchema, sentimentSettingsSchema, sentimentSummarySchema, visibilityReportResponseSchema } from '@ainyc/canonry-contracts'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { MANAGED_SWEEPS_COPY, MANAGED_SWEEPS_UNAVAILABLE_COPY, MANAGED_SWEEPS_RUNNING_COPY, MANAGED_SWEEPS_NEXT_LABEL } from '../src/components/project/ManagedSweepStatus.js'
import { VISIBILITY_SCOPE_RECOVERY_COPY } from '../src/components/project/VisibilityTrendSection.js'
import { MARKET_SCOPE_COPY } from '../src/components/project/VisibilityScopePicker.js'
import { parseVisibilitySelection, visibilityReportFirstPageQuery } from '../src/lib/measurement-view-url.js'
import { PROJECT_SCOPE_COPY } from '../src/lib/project-scope.js'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import { AINYC_LATEST_RUN, ainycCitationVisibility, ainycComparison, ainycEvidence, ainycLandscape, ainycMentionShare, ainycMetrics, ainycProviderScores, ainycRuns } from './ainyc-visibility-fixture.js'
import { toRunListItem } from '../src/build-dashboard.js'
import { mapInsightDtosToVms } from '../src/mappers/insight-mapper.js'
import { AdvancedMeasurementSection } from '../src/components/project/advanced-measurement/AdvancedMeasurementSection.js'
import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { TRACKED_FILTER_KEYS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { configureUiTelemetry, recordUiSearchParamsChange, resetUiTelemetryForTests, UI_FILTER_DEBOUNCE_MS } from '../src/lib/ui-telemetry.js'
import {
  getApiV1CdpStatusQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsQueryKey,
  getApiV1ProjectsByNameMeasurementOverviewInfiniteQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameMeasurementReportQueryKey,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey,
  getApiV1ProjectsByNameCitationsVisibilityQueryKey,
  getApiV1ProjectsByNameSchedulesQueryKey,
  getApiV1ProjectsByNameScheduleQueryKey,
  getApiV1ProjectsByNameQueryKey,
  getApiV1ProjectsByNameRunAdmissionQueryKey,
  getApiV1ProjectsByNameVisibilityReportQueryKey,
} from '@ainyc/canonry-api-client/react-query'

type EmbedBlock = Pick<EmbedClientConfig, 'enabled' | 'views' | 'projectTabs'>

// Pass-through spy: the setup's Publish step sits behind a multi-step draft
// flow, so the route test reads the props ProjectPage hands the section.
vi.mock('../src/components/project/advanced-measurement/AdvancedMeasurementSection.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/project/advanced-measurement/AdvancedMeasurementSection.js')>()
  return { ...actual, AdvancedMeasurementSection: vi.fn(actual.AdvancedMeasurementSection) }
})

// Pass-through spy: the route test reads what ProjectPage hands the Queries section from the URL,
// whatever the section's pages draw.
vi.mock('../src/components/project/DiscoverySection.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/project/DiscoverySection.js')>()
  return { ...actual, QueriesSection: vi.fn(actual.QueriesSection) }
})

/** The place picker's project option for the fixture project. */
const ALL_OF_CITYPOINT = PROJECT_SCOPE_COPY.allOf('Citypoint Dental NYC')

/** The Simple overview opens on the trend chart: no Visibility card or table above it. */
function expectTrendChartFirst(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.getElementById('overview-brief-title')).toBeNull()
  expect(doc.querySelector('table[aria-label="Visibility by query type"]')).toBeNull()
  expect(doc.querySelector('.av-card-title')?.textContent).toBe('AI answers over time')
}

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
    plan: MeasurementPlanResponse
    setup?: ReturnType<typeof measurementSetupResponse>
      | ReturnType<typeof simpleMeasurementSetupResponse>
      | ReturnType<typeof activeMeasurementSetupResponse>
    report?: ReturnType<typeof measurementReportResponse>
    overview?: ReturnType<typeof measurementOverviewResponse>
    overviewKey?: { scope?: 'all' | 'group'; groupKey?: string; queryClass?: 'all' | 'non-brand' | 'branded' }
    competitorLandscape?: ReturnType<typeof competitorLandscapeResponse> | CompetitorLandscapeResponse
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
    /**
     * The status of this project's most recent readable Site Health scan, or
     * undefined for a project that has never been scanned (what the
     * fresh-project fixtures mean).
     */
    siteHealthScan?: 'completed' | 'partial' | 'failed'
    /** GET /analytics/metrics for every window, so the trend and What changed render in one pass. */
    analyticsMetrics?: unknown
    /** GET /citations/visibility, so the By engine card renders in one pass. */
    citationVisibility?: unknown
    /** GET /run-admission: whether the next sweep would be refused, or leave providers out. */
    runAdmission?: unknown
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
  if (options.analyticsMetrics !== undefined) {
    // The trend's key carries its window, competitor frame and sweep revision; the prefix seeds all of them.
    queryClient.setQueryDefaults(['analytics-metrics'], { initialData: options.analyticsMetrics })
  }
  if (options.citationVisibility !== undefined) {
    queryClient.setQueryData(getApiV1ProjectsByNameCitationsVisibilityQueryKey({ client: heyClient, path: { name: projectName } }), options.citationVisibility)
  }
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
  if (options.runAdmission !== undefined) {
    for (const selection of ['manual', 'scheduled'] as const) {
      queryClient.setQueryData(getApiV1ProjectsByNameRunAdmissionQueryKey({ client: heyClient, path: { name: projectName }, query: { selection } }), options.runAdmission)
    }
  }
  if (options.scanSchedule !== undefined) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameScheduleQueryKey({ client: heyClient, path: { name: projectName }, query: { kind: 'site-audit' } }),
      options.scanSchedule,
    )
  }
  queryClient.setQueryData(
    getApiV1ProjectsByNameTechnicalAeoRunsQueryKey({ client: heyClient, path: { name: projectName }, query: { limit: 20 } }),
    {
      project: projectName,
      scans: options.siteHealthScan
        ? [{
            runId: 'run_scanned',
            status: options.siteHealthScan,
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:05:00.000Z',
            hasCrawlData: options.siteHealthScan !== 'failed',
          }]
        : [],
    },
  )
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

function visibilityReportQuery(projectName: string, selection: VisibilitySelectionState) {
  return { client: heyClient, path: { name: projectName }, query: visibilityReportFirstPageQuery(selection) }
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

function queryTrackingWorkspaceResponse(overrides: Record<string, unknown> = {}) {
  const context = { providers: ['openai'], models: { openai: 'search-model' }, location: null }
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'b'.repeat(64) },
    defaultContexts: [context],
    targets: [{ stableKey: 'citypoint', label: 'Citypoint Dental' }],
    groups: [{ stableKey: 'north', label: 'North', targetKeys: ['citypoint'] }],
    markets: [],
    // Server-built, as `planScopeOptions` builds them for tracking: no market links.
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
      { id: 'north', label: 'North', kind: 'group', targetCount: 1 },
      { id: 'citypoint', label: 'Citypoint Dental', kind: 'property', targetCount: 1, parentGroupIds: ['north'] },
    ],
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
    ...overrides,
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

function measurementPlanV2Response(revision: number): {
  active: Omit<NonNullable<MeasurementPlanResponse['active']>, 'plan'> & { plan: MeasurementPlanV2 }
} {
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
  pinnedDomain = 'pinned.example',
  observedDomain = 'observed.example',
}: {
  scope?: { kind: 'project' } | { kind: 'group'; groupKey: string } | { kind: 'all-markets' }
  pinnedLabel?: string
  observedLabel?: string
  /** The card names competitors by display name and domain, so a test tells responses apart by these. */
  pinnedDomain?: string
  observedDomain?: string
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
    pinned: [row(pinnedDomain, pinnedLabel, true, 0)],
    observed: [row(observedDomain, observedLabel, false, 25)],
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

/** Simple overviews keep their own controls: no results toolbar and no Filters button. */
function expectNoResultsToolbar(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.querySelector('.visibility-results-toolbar')).toBeNull()
  expect([...doc.querySelectorAll('button')].filter(button => /^Filters/.test(button.textContent ?? ''))).toEqual([])
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

  expect(html).toContain('AI answers over time')
  expect(html).toContain('Time window')
  expectTrendChartFirst(html)
  expect(html).toContain('Where competitors are winning')
  expect(html).toContain('Mention gaps')
  expect(html).toContain('Citation gaps')
  expect(html).toContain('Query evidence')
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Set up advanced measurement')
  expect(html).not.toContain('Republish setup')
  expectNoResultsToolbar(html)
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

  expect(html).toContain('AI answers over time')
  expectTrendChartFirst(html)
  expect(html).toContain('Query evidence')
  expect(html).toContain('pinned.example')
  expectNoResultsToolbar(html)
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
  expectTrendChartFirst(html)
  expect(doc.querySelector('select[aria-label="Query type"]')).toBeNull()
  expect(html).not.toContain('frozen query classification')
})

test('a Simple project loads pinned and historical competitors from the stored-evidence read', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: { active: null },
    competitorLandscape: competitorLandscapeResponse(),
  })

  expect(html).toContain('Competitors over time')
  expect(html).toContain('pinned.example')
  expect(html).toContain('observed.example')
  expect(html.indexOf('pinned.example')).toBeLessThan(html.indexOf('observed.example'))
  // A Simple project has no per-property numbers, so its Cited needs no qualifier.
  expect(html).not.toContain('cited (any page)')
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

  expect(await page.findByRole('heading', { name: 'AI answers over time' })).toBeTruthy()
  expect(router.state.location.pathname).toBe('/projects/project_citypoint')
})

test('an active setup uses the unified report without flashing legacy metrics', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanResponse(3, true),
    report: measurementReportResponse(3),
    visibilityReport: visibilityReportResponse({ mode: 'advanced' }),
  })

  expect(html).toContain('Non-brand queries')
  expect(html).toContain('Locations mentioned')
  expect(html).toContain('Harbor House')
  expect(html).toContain('AI sweep running')
  // Competitor history remains available on the legacy Advanced Measurement
  // surface; group-only scope does not exist until a v2 plan is active.
  expect(html).toContain('Competitors over time')
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

  const scopePicker = page.getByText(ALL_OF_CITYPOINT, { selector: 'summary, summary > span' }).closest('details')!
  fireEvent.click(page.getByText(ALL_OF_CITYPOINT, { selector: 'summary, summary > span' }))
  fireEvent.click(within(scopePicker).getByRole('button', { name: 'Select North' }))
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
        pinnedDomain: mutationSettled ? 'draft-rival.example' : 'north-pin.example',
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
  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary, summary > span' }))
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
  expect(await page.findByRole('rowheader', { name: 'Draft rival draft-rival.example' })).toBeTruthy()
  expect(calls.some(call => call.path.includes('/measurement-plan/draft/actions/publish'))).toBe(false)
})

test('Advanced project signals name the site-wide citation flag by domain and any page', async () => {
  const insight = (id: string, type: 'regression' | 'gain' | 'competitor-gained', title: string) => ({
    id, projectId: 'project_citypoint', runId: 'run-1', type, severity: 'high' as const, title,
    query: 'dentist open late', provider: 'gemini', dismissed: false, createdAt: '2026-08-02T00:00:00.000Z',
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = decodeURIComponent(new URL(request.url, window.location.origin).pathname)
    if (path.endsWith('/runs')) return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', answerVisibilityProviderReady: true, activeRevision: 4, activeSchemaVersion: 2, draft: null })
    }
    if (path.endsWith('/measurement-overview')) return jsonResponse(measurementOverviewResponse())
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  // The insights as the overview read maps them, so the mapper's subject flag is exercised too.
  fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.insights = mapInsightDtosToVms([
    insight('insight-lost', 'regression', 'Citation lost'),
    insight('insight-gain', 'gain', 'Citation gained'),
    insight('insight-rival', 'competitor-gained', 'Rival gained a citation'),
  ])
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

  fireEvent.click(await page.findByText('Project signals', { selector: 'summary, summary > span' }))
  const signals = await page.findByRole('region', { name: 'Latest signals' })
  // These insights read the older flag (any page on the domain), not a
  // property's own pages, so each badge says so instead of a bare "Lost" or
  // "Cited" beside the per-property numbers.
  const badgeFor = (title: string) => within(signals).getByText(title).closest('.py-3')!.querySelector('details li > div:first-child')!.textContent
  expect(badgeFor('Citation lost')).toBe('citypointdental.com citation lost (any page)')
  expect(badgeFor('Citation gained')).toBe('citypointdental.com newly cited (any page)')
  // A competitor's gain borrows the "cited" state for the rival, never the project's domain.
  expect(badgeFor('Rival gained a citation')).toBe('Cited')
})

test('a direct Portfolio URL falls back safely in embed mode', async () => {
  const html = await renderAt('/projects/project_citypoint/portfolio', {
    enabled: true,
    views: ['project'],
    projectTabs: ['portfolio', 'unknown'],
  })

  expect(html).toContain('Citypoint Dental NYC')
  expect(html).toContain('AI answers over time')
  expect(html).not.toContain('Import sitemap')
  expect(html).not.toContain('>All projects</a>')
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

  expect(await screen.findByRole('heading', { name: 'AI answers over time' })).toBeTruthy()
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
    expect(await screen.findByRole('heading', { name: 'AI answers over time' })).toBeTruthy()
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

// The fixture's Citypoint project has a queued AI sweep; dropping it leaves only the completed one.
function dashboardFixture(sweepActive: boolean) {
  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  if (!sweepActive) project.recentRuns = project.recentRuns.filter(run => run.status !== 'queued' && run.status !== 'running')
  expect(project.recentRuns.some(run => run.kind === 'answer-visibility' && run.status === 'queued')).toBe(sweepActive)
  return fixture
}

test.each([true, false])('the Queries route pauses publishing while a sweep is queued (queued: %s)', async sweepActive => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    if (url.pathname.endsWith('/runs')) return jsonResponse([])
    if (url.pathname.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (url.pathname.endsWith('/measurement-setup')) return jsonResponse({ state: 'unconfigured', nextAction: 'configure', mode: 'none', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (url.pathname.endsWith('/query-tracking')) return jsonResponse(queryTrackingWorkspaceResponse())
    if (url.pathname.endsWith('/query-tracking/preview')) {
      const { workspaceVersion, active } = queryTrackingWorkspaceResponse()
      return jsonResponse({
        mode: 'advanced', workspaceVersion, previewToken: `qtp_${'c'.repeat(64)}`, reviewedAt: '2026-09-04T12:15:00.000Z', active, tracked: [],
        diff: { added: [], removed: [{ queryId: 'query-citypoint', queryText: 'Citypoint dentist', assignmentCount: 1 }], reused: [], unchanged: [], noOp: false },
        workload: { existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 0, nextSweepProviderCalls: 0, addedNodes: 0, addedProviderCalls: 0, removedNodes: 1, removedProviderCalls: 1 },
      })
    }
    if (url.pathname.endsWith('/measurement-query-templates')) return jsonResponse({ templates: [] })
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = dashboardFixture(sweepActive)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/queries'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  fireEvent.click(await page.findByRole('button', { name: 'Remove Citypoint dentist' }))
  fireEvent.click(page.getByRole('button', { name: 'Review changes' }))
  const publish = await page.findByRole('button', { name: 'Publish 1 change' }) as HTMLButtonElement
  expect(publish.disabled).toBe(sweepActive)
  const message = page.queryByText('A sweep is queued or running. Publish after it finishes.')
  expect(message?.getAttribute('role') ?? null).toBe(sweepActive ? 'status' : null)
})

test.each([true, false])('the Portfolio route passes a queued sweep to setup Publish (queued: %s)', async sweepActive => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })
  const section = vi.mocked(AdvancedMeasurementSection)
  section.mockClear()

  const fixture = dashboardFixture(sweepActive)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/portfolio'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => expect(section).toHaveBeenCalled())
  expect(section.mock.lastCall![0].sweepActive).toBe(sweepActive)
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
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/discovery?researchMode=find'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(await page.findByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(page.getByRole('tab', { name: 'Research' }).getAttribute('aria-selected')).toBe('true')
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
  expect(await page.findByRole('heading', { name: 'AI answers over time' })).toBeTruthy()
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
  const disabledSentiment = sentimentSummarySchema.parse({
    ...aggregateSentiment([], { disabled: true }), configured: false, queries: [], reason: null, evaluationDefinition: null, breakdowns: [],
    selection: { mode: 'simple', scope: 'project', queryClass: 'branded', runId: null, revision: null, evaluationDefinitionId: null },
  })
  const disabledSentimentSettings = sentimentSettingsSchema.parse({
    installEnabled: false, enabled: false, ready: false, readinessReasons: ['Sentiment is disabled in install configuration.'],
    model: 'jev-1.13.0', enablementEpoch: 0, completionBoundary: 0,
    evaluationDefinitionId: null, actions: { configure: false, backfill: false }, experimental: true, disclosure: 'Sentiment quality has not completed independent evaluation.',
  })
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
    if (url.pathname.endsWith('/sentiment')) return jsonResponse(disabledSentiment)
    if (url.pathname.endsWith('/sentiment/settings')) return jsonResponse(disabledSentimentSettings)
    if (url.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
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
    competitorLandscapeResponse({ pinnedDomain: 'cached-pin.example', observedDomain: 'cached-observed.example' }),
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

  // Cached history stays dormant until the operator opens it.
  expect(queryClient.getQueryState(getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({
    client: heyClient, path: { name: projectName }, query: { window: '30d', queryClass: 'non-brand' },
  }))?.fetchStatus).toBe('idle')
  expect(page.getByRole('rowheader', { name: 'Pinned operator cached-pin.example' }).closest<HTMLDetailsElement>('details.visibility-disclosure')?.open).toBe(false)
  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary, summary > span' }))
  await waitFor(() => expect(queryClient.getQueryState(
    getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { window: '30d', queryClass: 'non-brand' },
    }),
  )?.status).toBe('error'))
  expect(page.getByRole('rowheader', { name: 'Pinned operator cached-pin.example' })).toBeTruthy()
  expect(page.getByRole('rowheader', { name: 'Observed rival cached-observed.example' })).toBeTruthy()
  expect(page.queryByLabelText('Favorable answer scores')).toBeNull()
  expect(page.getByRole('alert').textContent).toContain('Could not refresh competitors over time. Showing the last available data.')
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
    combinedMentionSnapshots: 0,
    ranking: [],
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
  dashboard.runs = []
}

// On a managed instance the sweep is scheduled, so the header states when the
// next one fires and the manual trigger beside it is the override. The button
// is deliberately secondary: as the primary it told every reader that running
// the sweep by hand was the normal way to operate the product.
test('the header states when the next AI sweep fires', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { schedule: schedule() })

  expect(within(renderedPage(html)).getByText('Next AI sweep Aug 7')).toBeTruthy()
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

  expect(html).toContain('>Map site<')
  expect(html).toContain('Set up AI Visibility')
  expectTrendChartFirst(html)
  expect(html).toContain('Where competitors are winning')
  expect(html).toContain('Competitors over time')
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

test('Map site is the overview primary action and is omitted on Site Health', async () => {
  const unmappedProject = {
    configureFixture(dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) {
      forceNoisyFreshVisibility(dashboard)
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['gemini']
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: false,
  }

  const overview = await renderAt('/projects/project_citypoint', undefined, undefined, unmappedProject)
  expect(overview).toContain('>Map site<')
  const overviewRow = contextRow(new DOMParser().parseFromString(overview, 'text/html'))
  const overviewActions = [...overviewRow.querySelectorAll('[data-project-actions] button')].map(button => button.textContent)
  expect(overviewActions).toEqual(expect.arrayContaining(['Map site', 'Set up AI Visibility']))

  const siteHealth = await renderAt('/projects/project_citypoint/technical-aeo', undefined, undefined, unmappedProject)
  expect(siteHealth).not.toContain('>Map site<')

  // An invitation to map a site that is already mapped is just a wrong label.
  // Nothing in the sweep-readiness flags carries this, so it is read separately.
  const alreadyMapped = await renderAt('/projects/project_citypoint', undefined, undefined, {
    ...unmappedProject,
    siteHealthScan: 'completed',
  })
  expect(alreadyMapped).not.toContain('>Map site<')
  expect(alreadyMapped).toContain('Set up AI Visibility')

  // A bounded first run that hits the page or duration budget lands as
  // `partial`. It is still a scan the operator can open, so the invitation to
  // map the site is just as wrong as after a complete one.
  const partiallyMapped = await renderAt('/projects/project_citypoint', undefined, undefined, {
    ...unmappedProject,
    siteHealthScan: 'partial',
  })
  expect(partiallyMapped).not.toContain('>Map site<')

  // A failed scan left nothing to read, so the invitation still stands.
  const failedScan = await renderAt('/projects/project_citypoint', undefined, undefined, {
    ...unmappedProject,
    siteHealthScan: 'failed',
  })
  expect(failedScan).toContain('>Map site<')
})

test('a scanned project is pointed at the evidence it has, not an empty tab', async () => {
  // `/projects/:name` opens on AI Visibility, which for a project with no
  // queries is entirely empty, while the Page Health result the operator just
  // waited through onboarding for is two tabs away with nothing pointing at it.
  const scanned = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      forceNoisyFreshVisibility(dashboard)
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = ['gemini']
      dashboard.settings.providerStatuses = []
    },
    settleReadiness: true,
    readiness: false,
    siteHealthScan: 'partial',
  })

  expect(scanned).toContain('>View Page Health<')
  expect(scanned).not.toContain('>Map site<')
  const scannedRow = contextRow(new DOMParser().parseFromString(scanned, 'text/html'))
  expect([...scannedRow.querySelectorAll('[data-project-actions] button')].map(button => button.textContent)).toContain('View Page Health')
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

  expectTrendChartFirst(html)
  // Past sweeps says the queued sweep is waiting to start.
  const pastSweepsPage = renderedPage(html)
  document.body.append(pastSweepsPage)
  onTestFinished(() => { pastSweepsPage.remove() })
  expect(within(within(pastSweepsPage).getByRole('table', { name: 'Past sweeps' })).getByRole('cell', { name: 'queued' })).toBeTruthy()
  expect(html.match(/Competitive mention and citation gaps appear after the first AI Visibility sweep\./g)).toHaveLength(1)
  expect(html.match(/No data/g) ?? []).toHaveLength(0)
  expect(html.match(/Run a sweep first/g) ?? []).toHaveLength(0)
  expect(html).not.toContain('No comparison yet')
})

/** Puts ainyc's two Sep 29 sweeps behind the Simple overview's cards. */
function withAinycSweeps(dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) {
  const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  const completed = project.recentRuns.find(run => run.status === 'completed')!
  project.visibilityEvidence = ainycEvidence()
  project.movementComparison = ainycComparison()
  project.queryCounts = { cited: 7, total: 14 }
  project.recentRuns = [{ ...completed, id: AINYC_LATEST_RUN.id, trigger: 'manual', createdAt: AINYC_LATEST_RUN.createdAt, startedAt: 'Sep 29, 5:59 AM' }]
  project.visibilitySweeps = [...project.recentRuns]
  // GET /overview's all-queries scores for the same sweep: 7 of 14 named, 7 of
  // 14 cited, and 1 of 14 queries each named and cited instead of you.
  project.mentionSummary = { ...project.mentionSummary, value: '50.0%', delta: '7 of 14 queries mentioned', progress: 50 }
  project.visibilitySummary = { ...project.visibilitySummary, value: '50.0%', delta: '7 of 14 queries cited', progress: 50 }
  project.mentionGaps = { ...project.mentionGaps, value: '1', delta: '1 of 14 queries', progress: 100 / 14 }
  project.gapQueries = { ...project.gapQueries, value: '1', delta: '1 of 14 queries', progress: 100 / 14 }
  return project
}

test.each([false, true])('ainyc\'s Simple overview opens on the trend chart, with no Visibility card above it (embed: %s)', async embed => {
  const html = await renderAt('/projects/project_citypoint', embed ? { enabled: true } : undefined, undefined, { configureFixture: withAinycSweeps })
  const doc = new DOMParser().parseFromString(html, 'text/html')

  expectTrendChartFirst(html)
  // The chart is the first section after the tabs, then the cards in page order.
  expect(doc.querySelector('nav.project-subnav + section .av-card-title')?.textContent).toBe('AI answers over time')
  const at = (title: string) => html.indexOf(`class="av-card-title">${title}<`)
  const competitive = at('Where competitors are winning')
  expect(at('AI answers over time')).toBeGreaterThan(-1)
  expect(at('AI answers over time')).toBeLessThan(competitive)
  expect(competitive).toBeLessThan(html.indexOf('Query evidence'))
  expect(html).not.toMatch(/Coverage signals|No sweep yet|first AI sweep|Compared with the|Visibility by query type/)
})

test('What changed names ainyc\'s added queries as written and dates the sweep before the change', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'))
  vi.stubEnv('TZ', 'UTC')
  onTestFinished(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture: withAinycSweeps,
    analyticsMetrics: ainycMetrics('all'),
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const changes = doc.querySelector('details.av-wc')!

  expect(changes.querySelector('.av-wc-summary')?.textContent).toBe('Sep 29 · 3 queries added · 4 new models')
  // Stored basket keys are lowercase; the page hands the section the tracked and added query text.
  expect([...changes.querySelectorAll('.av-details-list li')].map(item => item.textContent)).toEqual([
    'Added Sep 29: Canonry, Canonry AEO agency, Canonry reviews',
    'Claude last answered with claude-sonnet-5 on Sep 29',
    'Gemini last answered with gemini-3.5-flash on Sep 29',
    'OpenAI last answered with chat-latest on Sep 29',
    'Perplexity last answered with openai/gpt-6-luna on Sep 29',
  ])
  expect([...changes.querySelectorAll('button[aria-label]')].map(button => button.getAttribute('aria-label')))
    .toContainEqual(expect.stringMatching(/ Sweep before: Jul 14\.$/))
  expect(html).not.toContain('Query set changed')
})

test('Where competitors are winning and the query table read ainyc\'s latest sweep', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = withAinycSweeps(dashboard)
      project.mentionShareSummary = ainycMentionShare()
      project.competitors = [{ id: 'competitor_pbj', domain: 'pbjmarketing.com', citationCount: 5, totalQueries: 14, pressureLabel: '', citedQueries: [], movement: '', notes: '' }]
    },
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const card = [...doc.querySelectorAll('section.page-section-divider')]
    .find(section => section.querySelector('h2')?.textContent === 'Where competitors are winning')!

  expect(card.querySelector('.av-card-meta')?.textContent).toBe('Latest sweep')
  // Non-brand mention share, its caption and the server's brand ranking.
  expect(card.querySelector('.mention-share-value')?.textContent).toBe('33.3%')
  expect(card.querySelector('.mention-share-caption')?.textContent).toBe('Non-brand · 7 of 21 brand mentions')
  expect([...card.querySelectorAll('.mention-share-rows .mention-share-row')].map(row => [
    row.querySelector('th')?.textContent,
    row.querySelector('.mention-share-count')?.textContent,
    row.querySelector('.mention-share-share')?.textContent,
  ])).toEqual([
    ['pbjmarketing.com', '14', '66.7%'],
    ['Citypoint Dental NYC (you)', '7', '33.3%'],
  ])
  // The gap scope remains explicit beside a separately scoped mention-share control.
  expect(card.querySelector('.competitive-gaps-scope')?.textContent).toBe('All queries')
  // Each value also carries its scope for assistive technology; the denominator appears once.
  expect([...card.querySelectorAll('.competitive-gaps .aeo-hero-row')].map(row => [
    row.querySelector('.aeo-hero-row-label')?.firstChild?.textContent,
    row.querySelector('.aeo-hero-row-value')?.textContent,
    row.querySelector('.aeo-hero-row-detail')?.textContent,
  ])).toEqual([
    ['Mention gaps', '1 / 14 queries, all queries', undefined],
    ['Citation gaps', '1 / 14 queries, all queries', undefined],
  ])

  // The query table: Non-brand first, then Branded; "new query" only on the added three.
  const table = doc.querySelector('#evidence-section table')!
  expect([...table.querySelectorAll('tr.query-evidence-group th')].map(heading => heading.textContent)).toEqual(['Non-brand (11)', 'Branded (3)'])
  expect([...table.querySelectorAll('.query-evidence-new')].map(label => label.closest('tr')!.querySelector('button')!.getAttribute('aria-label')))
    .toEqual(['Canonry', 'Canonry AEO agency', 'Canonry reviews'])
  expect(table.textContent).not.toContain('First mention')
  expect([...table.querySelector('tbody .query-evidence-meta')!.children].map(item => item.textContent)).toEqual(['Non-brand', 'Claude', 'Gemini', 'OpenAI', 'Perplexity'])
  expect(doc.querySelector('#evidence-section')!.textContent).toContain('1 to 14 of 14 queries')
  expect(html.indexOf('Where competitors are winning')).toBeLessThan(html.indexOf('Query evidence'))
})

test('switching mention share to branded leaves gaps explicitly scoped to all queries', async () => {
  const { page } = await renderScopeRoute('/projects/project_citypoint', url => {
    if (url.pathname.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (url.pathname.endsWith('/measurement-setup')) return jsonResponse(simpleMeasurementSetupResponse())
    return undefined
  }, {
    configureFixture(dashboard) {
      const project = withAinycSweeps(dashboard)
      project.mentionShareSummary = ainycMentionShare()
      project.competitors = [{ id: 'competitor_pbj', domain: 'pbjmarketing.com', citationCount: 5, totalQueries: 14, pressureLabel: '', citedQueries: [], movement: '', notes: '' }]
    },
  })
  const heading = await page.findByRole('heading', { name: 'Where competitors are winning' })
  const section = heading.closest('section')!
  const gaps = () => [...section.querySelectorAll('.aeo-hero-row-value')].map(value => value.textContent)
  const expectedGaps = ['1 / 14 queries, all queries', '1 / 14 queries, all queries']
  expect(gaps()).toEqual(expectedGaps)
  fireEvent.click(within(section).getByRole('radio', { name: 'Branded' }))
  expect(section.querySelector('.mention-share-caption')?.textContent).toBe('Branded · 12 of 12 brand mentions')
  expect(section.querySelector('.mention-share-value')?.textContent).toBe('100%')
  expect(section.querySelector('.competitive-gaps-scope')?.textContent).toBe('All queries')
  expect(gaps()).toEqual(expectedGaps)
  expect(section.querySelector('.competitive-gaps')?.textContent).not.toContain('1 of 14 queries')
})

test('By engine, Past sweeps and Competitors over time read ainyc as the approved cards', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, { plan: { active: null }, competitorLandscape: ainycLandscape() }, {
    configureFixture(dashboard) {
      const project = withAinycSweeps(dashboard)
      project.recentRuns = ainycRuns().map(run => toRunListItem(run, project.project.name))
      project.competitors = [{ id: 'competitor_pbj', domain: 'pbjmarketing.com', citationCount: 5, totalQueries: 14, pressureLabel: '', citedQueries: [], movement: '', notes: '' }]
      project.providerScores = ainycProviderScores()
    },
    citationVisibility: ainycCitationVisibility(),
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const card = (title: string) => [...doc.querySelectorAll('section.overview-brief')]
    .find(section => section.querySelector('.av-card-title')?.textContent === title)!
  const cells = (row: Element) => [...row.children].map(cell => cell.textContent)

  const byEngine = card('By engine')
  expect([...byEngine.querySelectorAll('.av-grid tr')].map(cells)).toEqual([
    ['Of 11 queries', 'Claude', 'Gemini', 'OpenAI', 'Perplexity'],
    ['Mentioned', '1', '3', '0', '3'],
    ['Cited', '2', '3', '0', '4'],
  ])
  expect(byEngine.querySelector('.av-card-line')?.textContent).toBe('Competitor cited instead of you8 of 44 answers · non-brand queries')
  // The tiles, engine counts, per-model rates and competitor gap rows of the
  // old diagnostics are Details lines; the per-model rates come from /overview.
  expect([...byEngine.querySelectorAll('.av-details-list li')].map(item => item.textContent)).toEqual([
    'Cited and named: 4 of 11 queries',
    'Cited but not named: 0 of 11 queries',
    'Named but not cited: 0 of 11 queries',
    'Not cited or named: 7 of 11 queries',
    'All queries: cited by 4 of 4 engines, named by 4 of 4',
    'Claude (claude-sonnet-5) citation rate: 28.6%, 4 of 14 answers, all queries',
    'Gemini (gemini-3.5-flash) citation rate: 42.9%, 6 of 14 answers, all queries',
    'OpenAI (chat-latest) citation rate: 14.3%, 2 of 14 answers, all queries',
    'Perplexity (fast) citation rate: 50.0%, 7 of 14 answers, all queries',
    '"AEO Agency in NYC" (Claude): pbjmarketing.com cited instead of you',
    '"AEO Agency in NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"AEO Agency NYC" (Claude): pbjmarketing.com cited instead of you',
    '"AEO Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"Answer Engine Optimization Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"best AEO agency New York" (Claude): pbjmarketing.com cited instead of you',
    '"best AEO agency New York" (Perplexity): pbjmarketing.com cited instead of you',
    '"NYC AEO Agency" (OpenAI): pbjmarketing.com cited instead of you',
  ])

  // Trigger and duration in words; times follow the viewer's zone.
  const sweeps = [...card('Past sweeps').querySelectorAll('tbody tr')].map(cells)
  expect(sweeps.map(row => row.slice(1, 3))).toEqual([
    ['Manual', '2 minutes 28 seconds'],
    ['Manual', '2 minutes 10 seconds'],
    ['Scheduled', '3 minutes 53 seconds'],
    ['Manual', '3 minutes 54 seconds'],
    ['Spot check', '5 seconds'],
  ])

  const competitors = card('Competitors over time')
  // Simple names its scope again, as Advanced does.
  expect(competitors.querySelector('.av-card-meta')?.textContent).toBe('Project-wide · Non-brand · last 30 days · tracked competitors only')
  expect([...competitors.querySelectorAll('.av-grid[aria-label="Competitors over time"] tbody tr')].map(row => cells(row).slice(0, 5))).toEqual([
    ['Canonry (you)', 'Your brand', '31.7%', '13 of 88', '17 of 88'],
    ['pbjmarketing.com', 'Competitor', '68.3%', '28 of 88', '28 of 88'],
  ])
  // Two incomplete source lists qualify the Cited figures without opening Details.
  expect([...competitors.querySelectorAll('.av-card-body p')].map(line => line.textContent)).toEqual(['Citation data incomplete'])
  expect(competitors.querySelector<HTMLDetailsElement>('details.av-details')!.open).toBe(false)

  // Engine results precede the evidence table; both histories start collapsed below it.
  const at = (title: string) => html.indexOf(`class="av-card-title">${title}<`)
  expect(at('By engine')).toBeLessThan(html.indexOf('Query evidence'))
  expect(html.indexOf('Query evidence')).toBeLessThan(at('Past sweeps'))
  expect(at('Past sweeps')).toBeLessThan(at('Competitors over time'))
  expect(card('Past sweeps').querySelector<HTMLDetailsElement>('details.av-history')?.open).toBe(false)
  expect(competitors.closest<HTMLDetailsElement>('details.visibility-disclosure')?.open).toBe(false)
  expect(html).not.toMatch(/All time|Citation and engine diagnostics|Recent execution history|Competitor landscape/)
})

test('a running spot check keeps the Run button waiting', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    configureFixture(dashboard) {
      const project = withAinycSweeps(dashboard)
      const sweep = project.recentRuns[0]!
      project.recentRuns = [
        { ...sweep, id: 'probe-running', trigger: 'probe', status: 'running', createdAt: '2026-09-29T10:10:00.000Z', startedAt: 'Sep 29, 6:10 AM' },
        { ...sweep, id: 'probe-done', trigger: 'probe', status: 'completed', createdAt: '2026-09-29T10:05:00.000Z', startedAt: 'Sep 29, 6:05 AM' },
        sweep,
      ]
    },
  })

  // The server refuses a sweep while the probe runs, so the button keeps waiting.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect([...doc.querySelectorAll('[data-project-actions] button')].map(button => button.textContent)).toContain('AI sweep running…')
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

  expect(html).toContain('Mention gaps')
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
  // Awaited, not synchronous: this copy appears only once the schedules query
  // settles, and nothing before it waits on that query. The heading above can
  // resolve first, so a synchronous read here is a race that only passed while
  // an unrelated component happened to keep the tree re-rendering.
  expect(await page.findByText('No schedule configured. Set one to automatically trigger visibility sweeps.')).toBeTruthy()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(observed.some(path => path.endsWith('/schedules'))).toBe(true)
  expect(observed.some(path => path.endsWith('/schedule'))).toBe(false)
})

test('a query-ready project with a configured provider can run an AI sweep', async () => {
  for (const providerMode of ['api', 'registered-cdp'] as const) {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    cdpStatus: providerMode === 'registered-cdp' ? { connected: false, endpoint: 'ws://127.0.0.1:9222', browserVersion: 'Chrome not reachable at ws://127.0.0.1:9222', targets: [] } : undefined,
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
      if (providerMode === 'registered-cdp') { project.project.providers = ['cdp:chatgpt']; dashboard.settings.providerStatuses = []; project.recentRuns = []; dashboard.runs = [] }
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
  expectTrendChartFirst(html)
  expect(html).not.toContain('Set up AI Visibility to capture a baseline')
  expect(html).not.toContain('Checking AI readiness')
  }
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
    runAdmission: {
      refused: false, retryAfter: null,
      providers: {
        openai: { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: '2026-10-01T00:00:00.000Z', latestRunId: 'run-9', retryAfter: '2026-10-09T12:30:00.000Z' },
      },
    },
  })

  expect(html).toContain('Run AI sweep')
  expect(html).not.toContain('Checking AI readiness')
  expect(html).not.toContain('Retry AI readiness')
  const container = renderedPage(html)
  expect(container.querySelector('a[href="/settings#provider-openai"]')).toBeNull()
  expect(container.textContent).toContain('Ask an administrator to fix OpenAI.')
})

test.each([
  { name: 'Simple', measurement: { plan: { active: null } as MeasurementPlanResponse, setup: simpleMeasurementSetupResponse() } },
  { name: 'Advanced', measurement: { plan: measurementPlanV2Response(4), visibilityReport: visibilityReportResponse({ mode: 'advanced' }) } },
])('a $name project whose sweeps are on hold says so and holds its sweep button', async ({ measurement }) => {
  const streak = { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: '2026-10-01T00:00:00.000Z', latestRunId: 'run-9', retryAfter: '2026-10-08T12:30:00.000Z' }
  const page = (runAdmission: unknown) => renderAt('/projects/project_citypoint', undefined, measurement, {
    settleReadiness: true,
    readiness: true,
    queries: [{ id: 'query-ready', query: 'emergency dentist brooklyn', createdAt: '2026-09-01T12:00:00.000Z' }],
    // No sweep in flight: that state would label the button first.
    configureFixture(dashboard) {
      dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
      dashboard.runs = []
    },
    runAdmission,
  })

  const held = await page({ refused: true, retryAfter: streak.retryAfter, providers: { openai: streak } })
  expect(held).toContain('Sweeps are on hold')
  expect(held).toContain('AI sweeps on hold')
  expect(held).not.toContain('>Run AI sweep<')

  const skipped = await page({ refused: false, retryAfter: null, providers: { openai: streak } })
  expect(skipped).toContain('OpenAI is left out of sweeps')
  expect(skipped).toContain('Run AI sweep')
  expect(skipped).not.toContain('AI sweeps on hold')

  const clear = await page({ refused: false, retryAfter: null, providers: {} })
  expect(clear).not.toContain('left out of sweeps')
  expect(clear).not.toContain('on hold')
})

test('simple manual sweep admission is independent of the scheduled roster', async () => {
  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.recentRuns = []
  fixture.dashboard.runs = []
  const streak = { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: '2026-10-01T00:00:00.000Z', latestRunId: 'run-9', retryAfter: '2026-10-09T12:30:00.000Z' }
  const plan = { active: null }
  const selectionReads: Array<string | null> = []
  const writes: string[] = []
  let manualRefused = false
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input))
    const url = new URL(request.url, window.location.origin)
    const path = decodeURIComponent(url.pathname)
    if (request.method === 'POST') writes.push(path)
    if (path.endsWith('/run-admission')) {
      const selection = url.searchParams.get('selection')
      selectionReads.push(selection)
      return jsonResponse(selection === 'manual'
        ? { refused: manualRefused, retryAfter: manualRefused ? streak.retryAfter : null, providers: { openai: streak } }
        : manualRefused
          ? { refused: false, retryAfter: null, providers: {} }
          : { refused: true, retryAfter: streak.retryAfter, providers: { openai: streak } })
    }
    if (path.endsWith('/measurement-setup')) return jsonResponse(simpleMeasurementSetupResponse())
    if (path.endsWith('/measurement-plan')) return jsonResponse(plan)
    if (path.endsWith('/visibility-report')) return jsonResponse(visibilityReportResponse({ mode: 'simple' }))
    if (path.endsWith('/schedules') || path.endsWith('/runs')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: project.project.name } }), plan)
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  const page = render(<QueryClientProvider client={queryClient}><DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider>)

  const launch = await page.findByRole('button', { name: 'Run AI sweep' })
  expect(launch.hasAttribute('disabled')).toBe(false)
  expect(selectionReads).toContain('manual')
  expect(selectionReads).toContain('scheduled')
  expect(await page.findByRole('region', { name: 'Scheduled sweeps are on hold' })).toBeTruthy()
  expect(await page.findByRole('region', { name: 'OpenAI is left out of manual sweeps' })).toBeTruthy()
  fireEvent.click(launch)
  const confirm = await page.findByRole('button', { name: 'Run project-wide sweep' })
  expect(confirm.hasAttribute('disabled')).toBe(false)
  expect(page.getByRole('dialog').textContent).toContain('OpenAI is left out')

  // The manual roster can become fully held even while the schedule is healthy.
  manualRefused = true
  await act(async () => {
    await queryClient.refetchQueries({ predicate: query => (query.queryKey[0] as { _id?: string })._id === 'getApiV1ProjectsByNameRunAdmission' })
  })
  await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(true))
  fireEvent.click(confirm)
  expect(writes).toEqual([])
  fireEvent.click(page.getByRole('button', { name: 'Cancel' }))
  const held = await page.findByRole('button', { name: 'AI sweeps on hold' })
  expect(held.hasAttribute('disabled')).toBe(true)
  expect(await page.findByRole('region', { name: 'Manual sweeps are on hold' })).toBeTruthy()
  expect(page.queryByRole('region', { name: 'Scheduled sweeps are on hold' })).toBeNull()
})

test('a project-scoped writer can retry when the project readiness read fails', async () => {
  let setupReads = 0
  const requests: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    const path = `${decodeURIComponent(url.pathname)}${url.search}`

    requests.push(path)
    if (path.endsWith('/measurement-setup')) {
      setupReads++
      return setupReads === 1
        ? jsonResponse({ code: 'INTERNAL_ERROR', message: 'temporary failure' }, 500)
        : jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', answerVisibilityProviderReady: true, activeRevision: null, activeSchemaVersion: null, draft: null })
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

  const retry = await page.findByRole('button', { name: 'Retry AI readiness' })
  expect(retry.hasAttribute('disabled')).toBe(false)
  expect(page.queryByRole('button', { name: 'Set up AI Visibility' })).toBeNull()
  expect(page.queryByRole('button', { name: 'Run AI sweep' })).toBeNull()
  fireEvent.click(retry)
  const launch = await page.findByRole('button', { name: 'Run AI sweep' })
  expect(launch.hasAttribute('disabled')).toBe(false)
  expect(page.queryByRole('button', { name: 'Retry AI readiness' })).toBeNull()
  expect(setupReads).toBe(2)
  expect(requests.filter(path => path.startsWith('/api/v1/settings'))).toEqual([])
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

  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  onTestFinished(() => queryClient.clear())
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
  for (const providerMode of ['excluded-api', 'unregistered-cdp'] as const) {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    cdpStatus: { connected: false, endpoint: '', targets: [] },
    configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.project.providers = providerMode === 'excluded-api' ? ['claude'] : ['cdp:chatgpt']
      if (providerMode === 'unregistered-cdp') dashboard.settings.providerStatuses = []
      project.recentRuns = []
      dashboard.runs = []
    },
    settleReadiness: true,
    readiness: false,
  })

  expect(html).toContain('Set up AI Visibility')
  expect(html).not.toContain('Run AI sweep')
  }
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

  expect(projectActions(html).textContent).toContain('AI sweep')
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

  expect(html).toContain('AI answers over time')
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
  expect(doc.querySelector('.visibility-scope-trigger')?.textContent).toBe('North · 1 location')
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
        pinnedDomain: 'north-pin.example',
        observedDomain: 'north-rival.example',
      }),
      competitorLandscapeKey: { groupKey: 'north' },
    },
  )

  expect(html).toContain('north-pin.example')
  expect(html).toContain('north-rival.example')
  expect(html).not.toContain('pinned.example')
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

  expect(html).toContain('north-rival.example')
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
        pinnedDomain: 'all-market-pin.example',
        observedDomain: 'all-market-rival.example',
      }),
      competitorLandscapeKey: { scope: 'all-markets' },
    },
  )

  expect(html).toContain('all-market-pin.example')
  expect(html).toContain('all-market-rival.example')
  expect(html).toContain('All markets')
  // Beside per-property numbers, your row's Cited is the older site-wide count,
  // so it names the domain and "any page" under the figure.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const you = doc.querySelector('.av-grid[aria-label="Competitors over time"] tbody tr')!
  expect(you.querySelectorAll('td')[3]!.textContent).toBe('2 of 8citypoint.example cited (any page)')
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
        observedDomain: 'branded-market-rival.example',
      }),
      competitorLandscapeKey: { scope: 'all-markets', queryClass: 'branded' },
      visibilityReport: visibilityReportResponse({ mode: 'advanced', queryClass: 'branded' }),
    },
  )

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const control = doc.querySelector('select[aria-label="Query type"]')
  const checked = control?.querySelector('option[selected]')
  expect(checked?.textContent).toBe('Branded')
  expect(html).toContain('branded-market-rival.example')
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
        pinnedDomain: queryClass === 'branded' ? 'branded-pin.example' : 'all-query-pin.example',
        observedDomain: queryClass === 'branded' ? 'branded-rival.example' : 'all-query-rival.example',
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

  fireEvent.click(await page.findByText('Competitor history', { selector: 'summary, summary > span' }))
  expect(await page.findByText('all-query-rival.example')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => (
    path.includes('/analytics/competitors?')
    && path.includes('scope=all-markets')
    && path.includes('queryClass=non-brand')
  ))).toBe(true))

  fireEvent.change(page.getByLabelText('Query type'), { target: { value: 'branded' } })

  expect(await page.findByRole('heading', { name: 'Branded queries' })).toBeTruthy()
  expect(await page.findByText('branded-rival.example')).toBeTruthy()
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
  // A failure without retired-scope details is the workspace alert's to retry;
  // the context row adds nothing.
  expect(page.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(page.queryByText(VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite)).toBeNull()
  expect(page.container.querySelector('.project-context-row')).not.toBeNull()
  expect(page.container.querySelector('.project-context-row .project-context-scope')).toBeNull()
  const staleRequest = observed.find(path => path.includes('/visibility-report?'))
  expect(staleRequest).toContain('scope=group')
  expect(staleRequest).toContain('scopeKey=deleted-market')
  expect(observed.some(path => path.includes('/visibility-report?scope=project'))).toBe(false)
})

// ── Measurement scope in the project context row ─────────────────────────────

function contextRow(root: ParentNode): HTMLElement {
  const row = root.querySelector<HTMLElement>('.project-context-row')
  if (!row) throw new Error('Missing .project-context-row')
  return row
}

async function rowTrigger(root: ParentNode): Promise<HTMLElement> {
  return waitFor(() => {
    const trigger = contextRow(root).querySelector<HTMLElement>('.visibility-scope-trigger')
    expect(trigger).not.toBeNull()
    return trigger!
  })
}

async function renderScopeRoute(
  entry: string,
  respond: (url: URL) => Response | Promise<Response> | undefined,
  options: { accountRole?: 'admin' | 'viewer'; configureFixture?: (dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) => void } = {},
) {
  const observed: URL[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
    observed.push(url)
    const response = await respond(url)
    if (response) return response
    // Only the run lists; Site Health's own `/technical-aeo/runs` has another shape.
    if (/^\/api\/v1\/(?:projects\/[^/]+\/)?runs$/.test(decodeURIComponent(url.pathname))) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  options.configureFixture?.(fixture.dashboard)
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [entry] })
  await router.load()
  const page = render(
    <AccountProvider account={options.accountRole ? { name: 'operator', role: options.accountRole } : null}>
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>
    </AccountProvider>,
  )
  return { observed, page, router, queryClient, projectName }
}

function trackingRoute(
  workspace = queryTrackingWorkspaceResponse(),
  measurement: { plan: unknown; setup: unknown } = { plan: measurementPlanV2Response(4), setup: activeMeasurementSetupResponse(4) },
) {
  return (url: URL) => {
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurement.plan)
    if (path.endsWith('/measurement-setup')) return jsonResponse(measurement.setup)
    if (path.endsWith('/query-tracking')) return jsonResponse(workspace)
    if (path.endsWith('/measurement-query-templates')) return jsonResponse({ templates: [] })
    if (path.endsWith('/discover/sessions')) return jsonResponse([])
    return undefined
  }
}

function overviewRoute(respond: (url: URL) => Response | Promise<Response>) {
  return (url: URL) => {
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2Response(4))
    if (path.endsWith('/measurement-setup')) return jsonResponse(activeMeasurementSetupResponse(4))
    if (path.endsWith('/visibility-report')) return respond(url)
    return undefined
  }
}

test('AI Visibility v2 renders one scope trigger, in the project context row, with its label kept for assistive tech', async () => {
  const doc = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, {
    plan: measurementPlanV2Response(4),
    visibilityReport: visibilityReportResponse({ mode: 'advanced' }),
  }), 'text/html')
  const triggers = doc.querySelectorAll('.visibility-scope-trigger')
  expect(triggers).toHaveLength(1)
  const trigger = triggers[0]!
  expect(trigger.closest('.project-context-scope')?.parentElement).toBe(contextRow(doc))
  expect(trigger.textContent).toBe(ALL_OF_CITYPOINT)
  const label = doc.getElementById(trigger.getAttribute('aria-labelledby')!.split(' ')[0]!)!
  expect(label.textContent).toBe(PROJECT_SCOPE_COPY.place)
  const rules = parseCompiledCss(await compileAppStyles([...label.classList]))
  expect(compiledElementProperty(rules, label, 'position')).toBe('absolute')
  expect(cssLengthPx(compiledElementProperty(rules, label, 'width')!, rules)).toBe(1)
  expect(cssLengthPx(compiledElementProperty(rules, label, 'height')!, rules)).toBe(1)
  expect(compiledElementProperty(rules, label, 'overflow')).toBe('hidden')

  // v1 and Simple overviews offer no scope options, so the row has no slot.
  for (const html of [
    await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanResponse(3, true), report: measurementReportResponse(3), visibilityReport: visibilityReportResponse({ mode: 'advanced' }) }),
    await renderAt('/projects/project_citypoint'),
  ]) {
    const other = new DOMParser().parseFromString(html, 'text/html')
    expect(contextRow(other).querySelector('.project-context-scope')).toBeNull()
    expect(other.querySelector('.visibility-scope-trigger')).toBeNull()
  }
})

/** The slot's parts as a sighted reader meets them: the label, the trigger, then the counts, or `null` when the row prints none. */
function placeSlotParts(root: ParentNode): Array<string | null> {
  const [label, picker, counts] = contextRow(root).querySelector('.project-context-scope')!.firstElementChild!.children
  return [label!.textContent, picker!.querySelector('.visibility-scope-trigger')!.textContent, counts?.textContent ?? null]
}

test('AI Visibility reads Place, All of the project, then the location and market options the report listed', async () => {
  const report = visibilityReportResponse({ mode: 'advanced' })
  // The project option claims nine targets. The row counts the options the server listed.
  report.scopeOptions = [
    { id: 'project', label: 'Project', kind: 'project', targetCount: 9 },
    { id: 'north', label: 'North', kind: 'group', targetCount: 2 },
    { id: 'harbor', label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'] },
    { id: 'pier', label: 'Pier Inn', kind: 'property', targetCount: 1, parentGroupIds: ['north'] },
    { id: 'coast', label: 'Coast', kind: 'market', targetCount: 2, parentGroupIds: ['north'] },
  ]
  const doc = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanV2Response(4), visibilityReport: report }, {
    // The root reads the display name, which is not the project name here.
    configureFixture(dashboard) { dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.project.displayName = 'Citypoint Dental Group' },
  }), 'text/html')
  expect(placeSlotParts(doc)).toEqual([PROJECT_SCOPE_COPY.place, 'All of Citypoint Dental Group', '2 locations · 1 market'])
  // The trigger is already named Place by the picker's own label, so the visible word is not read twice.
  const visibleLabel = contextRow(doc).querySelector('.project-context-scope')!.firstElementChild!.firstElementChild!
  expect(visibleLabel.getAttribute('aria-hidden')).toBe('true')
  // The report names the whole project as the picker does.
  expect(doc.querySelector('details[data-query-results] .visibility-disclosure-meta')?.textContent).toBe('1 result · All of Citypoint Dental Group')
  expect(doc.body.textContent).not.toContain(ALL_OF_CITYPOINT)
  expect(doc.body.textContent).not.toMatch(/Whole site|Measurement scope/)
})

test('tracked Queries reads Place, All of the project, then the lengths of the workspace location and market lists', async () => {
  const base = queryTrackingWorkspaceResponse()
  // Three locations and two markets, with one location among the picker's options.
  const workspace = queryTrackingWorkspaceResponse({
    targets: [...base.targets, { stableKey: 'harbor', label: 'Harbor House' }, { stableKey: 'pier', label: 'Pier Inn' }],
    markets: ['new-york', 'boston'].map(stableKey => ({ stableKey, label: stableKey, groupKey: 'north', usageEdges: [] })),
  })
  const { page } = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(workspace), { accountRole: 'viewer' })
  await rowTrigger(page.container)
  expect(placeSlotParts(page.container)).toEqual([PROJECT_SCOPE_COPY.place, ALL_OF_CITYPOINT, '3 locations · 2 markets'])
})

test('a place narrower than the whole project shows no counts, and a project with no markets names none', async () => {
  // The counts are the project's totals, so beside a group they would read as the group's own.
  const report = visibilityReportResponse({ mode: 'advanced', scope: 'group', scopeKey: 'north' })
  report.scopeOptions = [...report.scopeOptions, { id: 'harbor', label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'] }, { id: 'coast', label: 'Coast', kind: 'market', targetCount: 1, parentGroupIds: ['north'] }]
  const doc = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint?measurementScope=group&measurementScopeKey=north', undefined, { plan: measurementPlanV2Response(4), visibilityReport: report }), 'text/html')
  expect(placeSlotParts(doc)).toEqual([PROJECT_SCOPE_COPY.place, 'North · 1 location', null])

  const scoped = await renderScopeRoute('/projects/project_citypoint/queries?measurementScope=property&measurementScopeKey=citypoint', trackingRoute(), { accountRole: 'viewer' })
  await rowTrigger(scoped.page.container)
  expect(placeSlotParts(scoped.page.container)).toEqual([PROJECT_SCOPE_COPY.place, 'Citypoint Dental · Location', null])
  scoped.page.unmount()

  // One location and no markets: the empty list is left out, never printed as "0 markets".
  const root = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(), { accountRole: 'viewer' })
  await rowTrigger(root.page.container)
  expect(placeSlotParts(root.page.container)).toEqual([PROJECT_SCOPE_COPY.place, ALL_OF_CITYPOINT, '1 location'])
})

test('the row holds a 44px placeholder only while the AI Visibility report loads', async () => {
  const loading = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanV2Response(4) }, { seedVisibilityReport: false }), 'text/html')
  const slot = contextRow(loading).querySelector('.project-context-scope')!
  const placeholder = slot.querySelector('[role="status"]')!
  expect(placeholder.getAttribute('aria-label')).toBe(PROJECT_SCOPE_COPY.loadingPlaces)
  const rules = parseCompiledCss(await compileAppStyles([...placeholder.classList]))
  expect(cssLengthPx(compiledElementProperty(rules, placeholder, 'height')!, rules)).toBe(44)
  expect(slot.querySelector('.visibility-scope-trigger')).toBeNull()
  // Place is there from the start, and the counts' room is held, so nothing moves when the report lands.
  const [label, picker, counts] = slot.firstElementChild!.children
  expect(label!.textContent).toBe(PROJECT_SCOPE_COPY.place)
  expect(picker!.firstElementChild).toBe(placeholder)
  expect(counts!.textContent).toBe('')
  expect(counts!.getAttribute('aria-hidden')).toBe('true')
  // A narrower place prints no counts, so its placeholder holds no room for them.
  const scoped = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint?measurementScope=group&measurementScopeKey=north', undefined, { plan: measurementPlanV2Response(4) }, { seedVisibilityReport: false }), 'text/html')
  expect([...contextRow(scoped).querySelector('.project-context-scope')!.firstElementChild!.children].map(part => part.textContent)).toEqual([PROJECT_SCOPE_COPY.place, ''])

  // Before either plan read lands, the overview's mode is unknown and the row reserves nothing.
  const unresolved = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, undefined, { seedPlan: false }), 'text/html')
  expect(contextRow(unresolved).querySelector('.project-context-scope')).toBeNull()
})

test('a long Group label wraps in the row trigger instead of being clipped', async () => {
  const longLabel = 'Coastal Maine and New Hampshire waterfront resorts, harbor inns, and seasonal cottages'
  const report = visibilityReportResponse({ mode: 'advanced', scope: 'group', scopeKey: 'north', scopeLabel: longLabel })
  report.scopeOptions = report.scopeOptions.map(option => option.id === 'north' ? { ...option, label: longLabel } : option)
  const doc = new DOMParser().parseFromString(await renderAt(
    '/projects/project_citypoint?measurementScope=group&measurementScopeKey=north',
    undefined,
    { plan: measurementPlanV2Response(4), visibilityReport: report },
  ), 'text/html')
  const trigger = contextRow(doc).querySelector('.visibility-scope-trigger')!
  expect(trigger.textContent).toBe(`${longLabel} · 1 location`)
  const slot = trigger.closest('.project-context-scope')!
  const rules = parseCompiledCss(await compileAppStyles([...trigger.classList, ...slot.classList]))
  expect(compiledElementProperty(rules, trigger, 'white-space') ?? 'normal').toBe('normal')
  expect(compiledElementProperty(rules, trigger, 'overflow') ?? 'visible').toBe('visible')
  expect(compiledElementProperty(rules, trigger, 'text-overflow') ?? 'clip').toBe('clip')
  expect(cssLengthPx(compiledElementProperty(rules, slot, 'min-width')!, rules)).toBe(0)
  // From md the slot holds Place, the trigger and the counts on one line, so it is capped at 42rem.
  expect(compiledElementProperty(rules, slot, 'max-width', '@media (width >= 48rem)')).toBe('var(--container-2xl)')
  expect(rules.flatMap(rule => rule.declarations).find(([key]) => key === '--container-2xl')?.[1]).toBe('42rem')
  // Below md Place takes its own line, so the open menu starts at the page gutter.
  const label = slot.firstElementChild!.firstElementChild!
  const labelRules = parseCompiledCss(await compileAppStyles([...label.classList]))
  expect(compiledElementProperty(labelRules, label, 'flex-basis')).toBe('100%')
  expect(compiledElementProperty(labelRules, label, 'flex-basis', '@media (width >= 48rem)')).toBe('auto')
})

test('below md the counts and their loading placeholder take the same line under the picker', async () => {
  const report = visibilityReportResponse({ mode: 'advanced' })
  report.scopeOptions = [...report.scopeOptions, { id: 'harbor', label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'] }]
  const loaded = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanV2Response(4), visibilityReport: report }), 'text/html')
  const loading = new DOMParser().parseFromString(await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanV2Response(4) }, { seedVisibilityReport: false }), 'text/html')
  const counts = (doc: Document) => contextRow(doc).querySelector('.project-context-scope')!.firstElementChild!.children[2]!
  expect(counts(loaded).textContent).toBe('1 location')
  for (const part of [counts(loaded), counts(loading)]) {
    const rules = parseCompiledCss(await compileAppStyles([...part.classList]))
    expect(compiledElementProperty(rules, part, 'flex-basis')).toBe('100%')
    expect(compiledElementProperty(rules, part, 'flex-basis', '@media (width >= 48rem)')).toBe('auto')
  }
})

test('a scoped Advanced Site Health tab says Project-wide, while unscoped and Simple tabs say nothing', async () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
  const scoped = parse(await renderAt('/projects/project_citypoint/technical-aeo?measurementScope=group&measurementScopeKey=north', undefined, { plan: measurementPlanV2Response(4) }))
  const slot = contextRow(scoped).querySelector('.project-context-scope')!
  expect(slot.textContent).toBe('Project-wide')
  expect([...slot.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['This tab covers the whole project. Your place stays selected for AI Visibility and Queries.'])

  const unscoped = parse(await renderAt('/projects/project_citypoint/technical-aeo', undefined, { plan: measurementPlanV2Response(4) }))
  const simple = parse(await renderAt('/projects/project_citypoint/technical-aeo?measurementScope=group&measurementScopeKey=north'))
  for (const doc of [unscoped, simple]) {
    expect(contextRow(doc).querySelector('.project-context-scope')).toBeNull()
    expect(doc.body.textContent).not.toContain('Project-wide')
  }
  for (const doc of [scoped, unscoped, simple]) expect(doc.querySelector('.visibility-scope-trigger')).toBeNull()
})

test('a viewer reads setup on a scope-blind tab only when the URL is scoped', async () => {
  const setupKey = (projectName: string) => getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } })
  const scoped = await renderScopeRoute('/projects/project_citypoint/technical-aeo?measurementScope=group&measurementScopeKey=north', trackingRoute(), { accountRole: 'viewer' })
  await waitFor(() => expect(contextRow(scoped.page.container).querySelector('.project-context-scope')?.textContent).toBe(PROJECT_SCOPE_COPY.projectWide))
  expect(scoped.observed.filter(url => url.pathname.endsWith('/measurement-setup'))).toHaveLength(1)
  expect(scoped.observed.some(url => url.pathname.endsWith('/measurement-plan'))).toBe(false)
  scoped.page.unmount()

  const unscoped = await renderScopeRoute('/projects/project_citypoint/technical-aeo', trackingRoute(), { accountRole: 'viewer' })
  // Effects have run, so an enabled read would already be fetching.
  expect(unscoped.queryClient.getQueryState(setupKey(unscoped.projectName))?.fetchStatus ?? 'idle').toBe('idle')
  expect(unscoped.observed.some(url => url.pathname.endsWith('/measurement-setup'))).toBe(false)
  expect(contextRow(unscoped.page.container).querySelector('.project-context-scope')).toBeNull()
})

test('a public demo visitor on a scope-blind tab reads the plan once for the Advanced tag, and no setup', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const { observed, page } = await renderScopeRoute('/projects/project_citypoint/technical-aeo', trackingRoute(), { accountRole: 'viewer' })
  await waitFor(() => expect(contextRow(page.container).querySelector('.project-mode-tag')?.textContent).toBe('Advanced1 property · 1 market'))
  expect(observed.filter(url => url.pathname.endsWith('/measurement-plan'))).toHaveLength(1)
  expect(observed.some(url => url.pathname.endsWith('/measurement-setup'))).toBe(false)
  expect(contextRow(page.container).querySelector('.project-context-scope')).toBeNull()
})

test('a viewer on Advanced tracked Queries gets exactly one scope trigger, in the row, without plan or setup reads', async () => {
  const { observed, page, queryClient, projectName } = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(), { accountRole: 'viewer' })
  const keyOptions = { client: heyClient, path: { name: projectName } }
  expect(queryClient.getQueryState(getApiV1ProjectsByNameMeasurementSetupQueryKey(keyOptions))?.fetchStatus ?? 'idle').toBe('idle')
  expect(queryClient.getQueryState(getApiV1ProjectsByNameMeasurementPlanQueryKey(keyOptions))?.fetchStatus ?? 'idle').toBe('idle')

  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  const trigger = await rowTrigger(page.container)
  expect(trigger.textContent).toBe(ALL_OF_CITYPOINT)
  expect(page.container.querySelectorAll('.visibility-scope-trigger')).toHaveLength(1)
  expect(page.getByRole('region', { name: 'Tracked queries' }).querySelector('.visibility-scope-trigger')).toBeNull()
  // The row reads the body's own workspace key, so it adds no request.
  expect(observed.filter(url => url.pathname.endsWith('/query-tracking'))).toHaveLength(1)
  expect(observed.some(url => url.pathname.endsWith('/measurement-setup') || url.pathname.endsWith('/measurement-plan'))).toBe(false)
  const nav = page.getByRole('navigation', { name: 'Project sections' })
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Change History'])
})

test('a viewer without research access who opens Research gets the tracked table and the row trigger', async () => {
  const { observed, page } = await renderScopeRoute('/projects/project_citypoint/queries?queryWorkspace=research', trackingRoute(), { accountRole: 'viewer' })
  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  expect(page.queryByRole('tab', { name: 'Research' })).toBeNull()
  expect((await rowTrigger(page.container)).textContent).toBe(ALL_OF_CITYPOINT)
  expect(page.container.querySelectorAll('.visibility-scope-trigger')).toHaveLength(1)
  expect(observed.some(url => url.pathname.includes('/research'))).toBe(false)
})

test('a retired tracking scope is named in the row while the body keeps the recovery action', async () => {
  const { page, router } = await renderScopeRoute('/projects/project_citypoint/queries?measurementScope=group&measurementScopeKey=retired-group', trackingRoute())
  expect(await page.findByText('This saved group filter is unavailable in the current measurement.')).toBeTruthy()
  const row = contextRow(page.container)
  await waitFor(() => expect(row.querySelector('.project-context-scope')?.textContent).toBe(PROJECT_SCOPE_COPY.savedScopeUnavailable))
  expect(page.container.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(within(row).queryByRole('button', { name: 'Show whole site' })).toBeNull()

  fireEvent.click(page.getByRole('button', { name: 'Show whole site' }))
  await waitFor(() => expect(router.state.location.search.measurementScope).toBe('project'))
  expect((await rowTrigger(page.container)).textContent).toBe(ALL_OF_CITYPOINT)
  expect(row.textContent).not.toContain(PROJECT_SCOPE_COPY.savedScopeUnavailable)
})

test('Simple tracked Queries have no scope trigger', async () => {
  const base = queryTrackingWorkspaceResponse()
  const simple = queryTrackingWorkspaceResponse({
    mode: 'simple', active: null, targets: [], groups: [], markets: [],
    scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }],
    tracked: base.tracked.map(row => ({ ...row, assignments: [] })),
  })
  const { page } = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(simple, { plan: { active: null }, setup: simpleMeasurementSetupResponse() }))
  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  expect(page.container.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(contextRow(page.container).querySelector('.project-context-scope')).toBeNull()
  const nav = page.getByRole('navigation', { name: 'Project sections' })
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Change History'])
})

test.each([
  ['the Research workspace', '/projects/project_citypoint/queries?queryWorkspace=research&researchMode=find'],
  ['the legacy Discovery route', '/projects/project_citypoint/discovery?researchMode=find'],
])('%s has no scope trigger and no tracking read', async (_name, entry) => {
  const { observed, page } = await renderScopeRoute(entry, trackingRoute())
  expect((await page.findByRole('tab', { name: 'Research' })).getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(observed.some(url => url.pathname.endsWith('/discover/sessions'))).toBe(true))
  expect(page.container.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(contextRow(page.container).querySelector('.project-context-scope')).toBeNull()
  expect(observed.some(url => url.pathname.endsWith('/query-tracking'))).toBe(false)
})

/** What ProjectPage last handed the Queries section. */
function queriesSectionProps() {
  return vi.mocked(QueriesSection).mock.lastCall![0]
}

test.each([
  ['no researchMode hands the Queries section no mode', undefined, undefined],
  ['researchMode=write reaches the Queries section', 'write', 'write'],
  ['researchMode=pattern reaches the Queries section', 'pattern', 'pattern'],
  ['researchMode=find reaches the Queries section', 'find', 'find'],
  ['the older researchMode=test reads as write', 'test', 'write'],
  ['a researchMode no page has hands the Queries section no mode', 'other', undefined],
] as const)('%s', async (_label, inUrl, mode) => {
  vi.mocked(QueriesSection).mockClear()
  const { page, router } = await renderScopeRoute(`/projects/project_citypoint/queries?queryWorkspace=research${inUrl ? `&researchMode=${inUrl}` : ''}`, trackingRoute())
  expect((await page.findByRole('tab', { name: 'Research' })).getAttribute('aria-selected')).toBe('true')
  expect(queriesSectionProps().researchMode).toBe(mode)
  // Reading the mode never rewrites the URL, so a link keeps the mode it was shared with.
  expect(router.state.location.search.researchMode).toBe(inUrl)
})

test('the Tracked filter keys survive a reload and reach the Queries section, apart from the query type AI Visibility is set to', async () => {
  vi.mocked(QueriesSection).mockClear()
  const opened = { trackedSubject: 'market', trackedType: 'non-brand', trackedStatus: 'not-asked', trackedSource: 'manual', trackedResult: 'not-cited', trackedView: 'thin-markets' }
  expect(Object.keys(opened)).toEqual([...Object.values(TRACKED_FILTER_KEYS), 'trackedView'])
  const { router } = await renderScopeRoute(`/projects/project_citypoint/queries?${new URLSearchParams({ ...opened, queryClass: 'branded' })}`, trackingRoute())
  expect(router.state.location.search).toMatchObject({ ...opened, queryClass: 'branded' })
  expect(queriesSectionProps().trackedFilters).toEqual({ subject: 'market', type: 'non-brand', status: 'not-asked', source: 'manual', result: 'not-cited' })

  // A filter back on its default leaves the URL; every other key stays, the shared query type included.
  act(() => queriesSectionProps().onTrackedFiltersChange!({ type: 'mixed', status: 'asked' }))
  await waitFor(() => expect(queriesSectionProps().trackedFilters).toEqual({ subject: 'market', type: 'mixed', status: 'asked', source: 'manual', result: 'not-cited' }))
  const href = router.state.location.href
  expect(Object.fromEntries(new URL(href, window.location.origin).searchParams)).toEqual({
    trackedSubject: 'market', trackedType: 'mixed', trackedSource: 'manual', trackedResult: 'not-cited', trackedView: 'thin-markets', queryClass: 'branded',
  })

  const reloaded = createAppRouter(new QueryClient(), { initialEntries: [href] })
  await reloaded.load()
  expect(reloaded.state.location.search).toEqual(router.state.location.search)

  // The route holds each key as text, like every other Queries key: a number or a flag is dropped.
  const untyped = createAppRouter(new QueryClient(), { initialEntries: ['/projects/project_citypoint/queries?trackedSubject=7&trackedType=true&trackedStatus=7&trackedSource=false&trackedResult=7&trackedView=7'] })
  await untyped.load()
  const held = untyped.state.matches.at(-1)!.search as Record<string, unknown>
  expect(Object.keys(opened).filter(key => held[key] !== undefined)).toEqual([])

  // With no key of its own, the Tracked Type is All whatever AI Visibility is filtered to.
  vi.mocked(QueriesSection).mockClear()
  const shared = await renderScopeRoute('/projects/project_citypoint/queries?queryClass=branded', trackingRoute())
  expect(queriesSectionProps().trackedFilters).toEqual({ subject: 'any', type: 'all', status: 'asked', source: 'any', result: 'any' })
  expect(shared.router.state.location.search.queryClass).toBe('branded')
})

test('each Tracked URL key reports a filter change by its dimension, never by its value', () => {
  vi.useFakeTimers()
  const sent: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async event => { sent.push(event); return { accepted: true } } })
  onTestFinished(() => {
    resetUiTelemetryForTests()
    vi.useRealTimers()
  })
  const reported = [...Object.values(TRACKED_FILTER_KEYS), 'trackedView'].map(key => {
    const before = sent.length
    recordUiSearchParamsChange({ runId: 'run-1' }, { runId: 'run-2', [key]: 'value-kept-out' })
    vi.advanceTimersByTime(UI_FILTER_DEBOUNCE_MS)
    return [key, sent.slice(before).map(event => event.event === 'ui.action' ? [event.action, event.filter] : [event.event])]
  })
  expect(Object.fromEntries(reported)).toEqual({
    trackedSubject: [['filter.change', 'other']],
    trackedType: [['filter.change', 'query_class']],
    trackedStatus: [['filter.change', 'other']],
    trackedSource: [['filter.change', 'other']],
    trackedResult: [['filter.change', 'other']],
    trackedView: [['filter.change', 'other']],
  })
  expect(JSON.stringify(sent)).not.toContain('value-kept-out')
})

test.each([
  ['with no sweep under way', { sweepActive: false, managed: false }, { trackingChangedAt: '2026-08-01T12:00:00.000Z', nextSweepDate: 'Aug 7' }],
  ['while a sweep is queued', { sweepActive: true, managed: false }, { trackingChangedAt: '2026-08-01T12:00:00.000Z', nextSweepDate: undefined }],
  ['on managed sweeps', { sweepActive: false, managed: true }, { trackingChangedAt: undefined, nextSweepDate: undefined }],
] as const)('the Queries section is handed the dates AI Visibility names %s', async (_label, state, dates) => {
  if (state.managed) window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  vi.mocked(QueriesSection).mockClear()
  const tracking = trackingRoute()
  const { observed, queryClient } = await renderScopeRoute(
    '/projects/project_citypoint/queries',
    url => url.pathname.endsWith('/schedules') ? jsonResponse([schedule()]) : tracking(url),
    {
      configureFixture(dashboard) {
        const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
        if (!state.sweepActive) project.recentRuns = project.recentRuns.filter(run => run.status !== 'queued' && run.status !== 'running')
        expect(project.recentRuns.some(run => run.kind === 'answer-visibility' && run.status === 'queued')).toBe(state.sweepActive)
      },
    },
  )
  // The plan gives the tracking change and the schedule gives the next sweep, so both reads settle first.
  await waitFor(() => expect(observed.some(url => url.pathname.endsWith('/measurement-plan'))).toBe(true))
  if (!state.managed) await waitFor(() => expect(observed.some(url => url.pathname.endsWith('/schedules'))).toBe(true))
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  await waitFor(() => {
    const { trackingChangedAt, nextSweepDate } = queriesSectionProps()
    expect({ trackingChangedAt, nextSweepDate }).toEqual(dates)
  })
})

test('the tracked Queries row picker floats over the table, closes on Escape or outside interaction, and keeps focus after a search selection', async () => {
  const base = queryTrackingWorkspaceResponse()
  const workspace = queryTrackingWorkspaceResponse({
    markets: [{ stableKey: 'new-york', label: 'New York', groupKey: 'north', usageEdges: [{ executionNodeKey: 'node-citypoint', targetKey: 'citypoint', queryId: 'query-citypoint' }] }],
    scopeOptions: [...base.scopeOptions!.slice(0, 2), { id: 'new-york', label: 'New York', kind: 'market', targetCount: 1, parentGroupIds: ['north'] }, base.scopeOptions![2]!],
  })
  const { page, router } = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(workspace))
  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  const trigger = await rowTrigger(page.container)
  const details = trigger.closest('details')!
  fireEvent.click(trigger)
  expect(details.open).toBe(true)
  const search = within(details).getByRole('searchbox', { name: 'Search places' })
  const menu = search.closest('.visibility-scope-menu')!
  expect(details.contains(menu)).toBe(true)
  const rules = parseCompiledCss(await compileAppStyles([...details.classList, ...menu.classList]))
  expect(compiledElementProperty(rules, details, 'position')).toBe('relative')
  expect(compiledElementProperty(rules, menu, 'position')).toBe('absolute')
  expect(compiledElementProperty(rules, menu, 'top')).toBe('100%')
  expect(cssLengthPx(compiledElementProperty(rules, menu, 'left')!, rules)).toBe(0)
  expect(compiledElementProperty(rules, menu, 'z-index')).toBe('30')

  search.focus()
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)

  fireEvent.click(trigger)
  expect(details.open).toBe(true)
  fireEvent.pointerDown(search)
  expect(details.open).toBe(true)
  const querySearch = page.getByRole('searchbox', { name: 'Filter tracked queries' })
  querySearch.focus()
  fireEvent.pointerDown(querySearch)
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(querySearch)

  fireEvent.click(trigger)
  fireEvent.change(within(details).getByRole('searchbox', { name: 'Search places' }), { target: { value: 'New York' } })
  expect(within(details).queryByRole('button', { name: 'Select North' })).toBeNull()
  const option = within(details).getByRole('button', { name: 'Select New York' })
  option.focus()
  fireEvent.click(option)
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'market', measurementScopeKey: 'new-york' }))
  expect(router.state.location.search.measurementMarketKey).toBeUndefined()
  await waitFor(() => expect(trigger.textContent).toBe('New York · Market'))
})

test('the tracked Queries row picker searches a large property list and browses nested Groups', async () => {
  const properties = Array.from({ length: 225 }, (_, index) => ({ stableKey: `property-${index}`, label: `Property ${index}` }))
  const workspace = queryTrackingWorkspaceResponse({
    targets: [{ stableKey: 'citypoint', label: 'Citypoint Dental' }, ...properties],
    groups: [
      { stableKey: 'metro', label: 'Metro', targetKeys: ['citypoint'] },
      { stableKey: 'north-east', label: 'North East', parentGroupKey: 'metro', targetKeys: ['citypoint'] },
    ],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 226 },
      { id: 'metro', label: 'Metro', kind: 'group', targetCount: 1 },
      { id: 'north-east', label: 'North East', kind: 'group', targetCount: 1, parentGroupIds: ['metro'] },
      { id: 'citypoint', label: 'Citypoint Dental', kind: 'property', targetCount: 1, parentGroupIds: ['metro', 'north-east'] },
      ...properties.map(property => ({ id: property.stableKey, label: property.label, kind: 'property', targetCount: 1, parentGroupIds: [] })),
    ],
  })
  const { page, router } = await renderScopeRoute('/projects/project_citypoint/queries', trackingRoute(workspace))
  expect(await page.findByText('Citypoint dentist')).toBeTruthy()
  const trigger = await rowTrigger(page.container)
  const details = trigger.closest('details')!

  fireEvent.click(trigger)
  fireEvent.change(within(details).getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Property 224' } })
  expect(within(details).queryByRole('button', { name: 'Select Property 223' })).toBeNull()
  fireEvent.click(within(details).getByRole('button', { name: 'Select Property 224' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'property', measurementScopeKey: 'property-224' }))
  await waitFor(() => expect(trigger.textContent).toBe('Property 224 · Location'))

  fireEvent.click(trigger)
  fireEvent.click(within(details).getByRole('button', { name: 'Back to all groups' }))
  expect(within(details).getByRole('button', { name: 'Select Metro' })).toBeTruthy()
  expect(within(details).queryByRole('button', { name: 'Select North East' })).toBeNull()
  expect(within(details).queryByRole('button', { name: 'Select Citypoint Dental' })).toBeNull()
  fireEvent.click(within(details).getByRole('button', { name: 'Browse Metro' }))
  expect(within(details).getByText('All in this group')).toBeTruthy()
  expect(within(details).getByText('Subgroups (1)', { selector: 'summary, summary > span' }).closest('details')!.open).toBe(true)
  expect(within(details).getByText('All locations (1)', { selector: 'summary, summary > span' }).closest('details')!.open).toBe(false)
  fireEvent.click(within(details).getByRole('button', { name: 'Select North East' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'group', measurementScopeKey: 'north-east' }))
  await waitFor(() => expect(trigger.textContent).toBe('North East · 1 location'))
}, 15_000)

test('AI Visibility makes one first-page request, normalizes without a history entry, and shows a new scope while it loads', async () => {
  let releaseNorth: (() => void) | undefined
  const northGate = new Promise<void>(resolve => { releaseNorth = resolve })
  const { observed, page, router } = await renderScopeRoute('/projects/project_citypoint', overviewRoute(async url => {
    if (url.searchParams.get('scopeKey') === 'north') {
      await northGate
      return jsonResponse(visibilityReportResponse({ mode: 'advanced', scope: 'group', scopeKey: 'north', scopeLabel: 'North', label: 'North Property' }))
    }
    return jsonResponse(visibilityReportResponse({ mode: 'advanced', queryClass: url.searchParams.get('queryClass') === 'all' ? 'all' : 'non-brand' }))
  }))
  const historyLength = router.history.length

  expect(await page.findByText('Harbor House')).toBeTruthy()
  await waitFor(() => expect(router.state.location.search.queryClass).toBe('non-brand'))
  expect(router.history.length).toBe(historyLength)
  const trigger = await rowTrigger(page.container)
  expect(trigger.textContent).toBe(ALL_OF_CITYPOINT)
  const firstPages = observed.filter(url => url.pathname.endsWith('/visibility-report')
    && url.searchParams.get('limit') === '25' && !url.searchParams.has('cursor') && !url.searchParams.has('search') && !url.searchParams.has('queryKey'))
  expect(firstPages.map(url => url.searchParams.get('queryClass'))).toEqual(['all'])

  fireEvent.click(trigger)
  fireEvent.click(within(trigger.closest('details')!).getByRole('button', { name: 'Select North' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'non-brand' }))
  // The URL owns the trigger, so it does not snap back while the report loads.
  await waitFor(() => expect(trigger.textContent).toBe('North · 1 location'))
  expect(page.getByRole('status', { name: 'Loading AI visibility' })).toBeTruthy()
  expect(router.history.length).toBe(historyLength + 1)

  releaseNorth!()
  expect(await page.findByText('North Property')).toBeTruthy()
  expect(trigger.textContent).toBe('North · 1 location')
  expect(observed.filter(url => url.pathname.endsWith('/visibility-report') && url.searchParams.get('scopeKey') === 'north')).toHaveLength(1)
})

test.each([
  {
    kind: 'market',
    search: '?measurementScope=group&measurementScopeKey=north&measurementMarketKey=gone-market&queryClass=non-brand',
    details: { reason: 'retired-market', kind: 'market', key: 'gone-market' },
    recovery: VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets,
    label: VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets,
    help: VISIBILITY_SCOPE_RECOVERY_COPY.retiredMarketHelp,
    recovered: { measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'non-brand' },
    trigger: 'North · 1 location',
  },
  {
    kind: 'group',
    search: '?measurementScope=group&measurementScopeKey=gone-group&queryClass=non-brand',
    details: { reason: 'retired-scope', kind: 'group', key: 'gone-group' },
    // The button reads "Show all"; its name and the note's tooltip say all of which project.
    recovery: 'Show all of Citypoint Dental NYC',
    label: VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite,
    help: 'This saved place is not in this measurement. Show all of Citypoint Dental NYC to pick another.',
    recovered: { measurementScope: 'project', queryClass: 'non-brand' },
    trigger: ALL_OF_CITYPOINT,
  },
] as const)('a retired $kind from the real error envelope is named in the row and recovered in the body', async ({ search, details, recovery, label, help, recovered, trigger }) => {
  const { page, router } = await renderScopeRoute(`/projects/project_citypoint${search}`, overviewRoute(url => {
    const retiredKey = url.searchParams.get(details.kind === 'market' ? 'marketKey' : 'scopeKey')
    if (retiredKey === details.key) {
      return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: `${details.kind} "${details.key}" is not in this frozen definition.`, details } }, 400)
    }
    const scopeKey = url.searchParams.get('scopeKey')
    return jsonResponse(visibilityReportResponse({ mode: 'advanced', ...(scopeKey ? { scope: 'group' as const, scopeKey, scopeLabel: 'North' } : {}) }))
  }))

  expect(await page.findByRole('heading', { name: 'AI visibility unavailable' })).toBeTruthy()
  const row = contextRow(page.container)
  await waitFor(() => expect(row.querySelector('.project-context-scope')?.textContent).toBe(PROJECT_SCOPE_COPY.savedScopeUnavailable))
  expect(page.container.querySelector('.visibility-scope-trigger')).toBeNull()
  expect(page.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(page.getByRole('button', { name: help })).toBeTruthy()
  expect(page.getByRole('button', { name: recovery }).textContent).toBe(label)

  fireEvent.click(page.getByRole('button', { name: recovery }))
  await waitFor(() => expect(router.state.location.search).toMatchObject(recovered))
  expect(router.state.location.search.measurementMarketKey).toBeUndefined()
  if (details.kind === 'group') expect(router.state.location.search.measurementScopeKey).toBeUndefined()
  expect((await rowTrigger(page.container)).textContent).toBe(trigger)
  expect(row.textContent).not.toContain(PROJECT_SCOPE_COPY.savedScopeUnavailable)
})

const PROPERTY_MARKET = { id: 'north-market', label: 'North Market', kind: 'market' as const, targetCount: 1, parentGroupIds: ['north'] }

function measurementPlanV2WithMarket(assignedClass: 'branded' | 'non-brand' = 'non-brand') {
  const base = measurementPlanV2Response(4)
  return {
    active: {
      ...base.active,
      plan: {
        ...base.active.plan,
        assignments: base.active.plan.assignments.map(assignment => ({ ...assignment, queryClass: assignedClass })),
        reportingScopes: [{ stableKey: PROPERTY_MARKET.id, label: PROPERTY_MARKET.label, kind: 'market' as const, groupKey: 'north', usageEdges: base.active.plan.usageEdges }],
      },
    },
  }
}

function propertyScopeReport(queryClass: 'branded' | 'non-brand' = 'non-brand', market?: typeof PROPERTY_MARKET): VisibilityReportResponse {
  const report = visibilityReportResponse({ mode: 'advanced', queryClass, scope: 'property', scopeKey: 'harbor-house', scopeLabel: 'Harbor House' })
  report.scopeOptions.push(
    { id: 'harbor-house', label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'], marketKeys: [PROPERTY_MARKET.id] },
    PROPERTY_MARKET,
  )
  if (market) report.selection.market = market
  return report
}

function propertyOverviewResponse(queryClass: 'branded' | 'non-brand') {
  const metric = { state: 'available' as const, value: 0.5, numerator: 1, denominator: 2 }
  return {
    mode: 'active-v2' as const,
    scope: { kind: 'property' as const, key: 'harbor-house', label: 'Harbor House' },
    queryClass,
    measurement: { state: 'complete' as const, displayedRunId: 'run-synthetic', completed: 1, expected: 1, completedAt: '2026-08-02T12:05:00.000Z' },
    nextAction: { kind: 'none' as const },
    metrics: { propertiesMentioned: metric, mentionCoverage: metric, citationCoverage: metric, brandPresence: metric, sov: metric },
    properties: {
      items: [{ targetKey: 'harbor-house', label: 'Harbor House', mentionCoverage: metric, citationCoverage: metric, providers: [], flags: 0 }],
      nextCursor: null,
      totalEstimate: 1,
    },
    flags: { total: 0 },
  }
}

async function renderPropertyRoute(entry: string, assignedClass: 'branded' | 'non-brand' = 'non-brand') {
  const observed: URL[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
    observed.push(url)
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/runs')) return jsonResponse([])
    if (path.endsWith('/measurement-plan')) return jsonResponse(measurementPlanV2WithMarket(assignedClass))
    if (path.endsWith('/measurement-setup')) {
      return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', activeRevision: 4, activeSchemaVersion: 2, draft: null })
    }
    if (path.endsWith('/visibility-report')) {
      return jsonResponse(propertyScopeReport(url.searchParams.get('queryClass') === 'non-brand' ? 'non-brand' : 'branded', PROPERTY_MARKET))
    }
    if (path.endsWith('/measurement-overview')) {
      return jsonResponse(propertyOverviewResponse(url.searchParams.get('queryClass') === 'branded' ? 'branded' : 'non-brand'))
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [entry] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
  return { observed, page, router }
}

test('the AI Visibility row picker writes a single-market Group\'s market for a Property inside it, names that market, and writes none for the Group', async () => {
  // Server-declared links: North links exactly one market, and Harbor House sits in both.
  const withMarketLinks = (report: VisibilityReportResponse) => {
    report.scopeOptions = [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 },
      { id: 'north', label: 'North', kind: 'group', targetCount: 1, marketKeys: [PROPERTY_MARKET.id] },
      { id: 'harbor-house', label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'], marketKeys: [PROPERTY_MARKET.id] },
      PROPERTY_MARKET,
    ]
    return report
  }
  const { page, router } = await renderScopeRoute('/projects/project_citypoint?queryClass=non-brand', overviewRoute(url => {
    const scopeKey = url.searchParams.get('scopeKey')
    if (scopeKey === 'harbor-house') return jsonResponse(withMarketLinks(propertyScopeReport('non-brand', url.searchParams.get('marketKey') === PROPERTY_MARKET.id ? PROPERTY_MARKET : undefined)))
    if (scopeKey === 'north') return jsonResponse(withMarketLinks(visibilityReportResponse({ mode: 'advanced', scope: 'group', scopeKey: 'north', scopeLabel: 'North' })))
    return jsonResponse(withMarketLinks(visibilityReportResponse({ mode: 'advanced' })))
  }))
  const trigger = await rowTrigger(page.container)
  await waitFor(() => expect(trigger.textContent).toBe(ALL_OF_CITYPOINT))
  const details = trigger.closest('details')!

  fireEvent.click(trigger)
  fireEvent.click(within(details).getByRole('button', { name: MARKET_SCOPE_COPY.browse('North') }))
  fireEvent.click(within(details).getByRole('button', { name: MARKET_SCOPE_COPY.select('Harbor House') }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({
    measurementScope: 'property', measurementScopeKey: 'harbor-house', measurementMarketKey: PROPERTY_MARKET.id, queryClass: 'non-brand',
  }))
  // The trigger reads the market from the URL, so it names the drilldown's market.
  await waitFor(() => expect(trigger.textContent).toBe(`Harbor House · ${PROPERTY_MARKET.label}`))
  expect(router.state.location.search.runId).toBeUndefined()

  fireEvent.click(trigger)
  fireEvent.click(within(details).getByRole('button', { name: 'Back to all groups' }))
  fireEvent.click(within(details).getByRole('button', { name: MARKET_SCOPE_COPY.select('North') }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'non-brand' }))
  expect(router.state.location.search.measurementMarketKey).toBeUndefined()
  await waitFor(() => expect(trigger.textContent).toBe('North · 1 location'))
}, 15_000)

test('the tracked Queries row picker drops a carried market when it changes scope', async () => {
  const { page, router } = await renderScopeRoute('/projects/project_citypoint/queries?measurementScope=group&measurementScopeKey=north&measurementMarketKey=new-york', trackingRoute())
  const trigger = await rowTrigger(page.container)
  await waitFor(() => expect(trigger.textContent).toBe('North · 1 location'))
  const details = trigger.closest('details')!

  fireEvent.click(trigger)
  fireEvent.change(within(details).getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Citypoint' } })
  fireEvent.click(within(details).getByRole('button', { name: MARKET_SCOPE_COPY.select('Citypoint Dental') }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ measurementScope: 'property', measurementScopeKey: 'citypoint' }))
  expect(router.state.location.search.measurementMarketKey).toBeUndefined()
  await waitFor(() => expect(trigger.textContent).toBe('Citypoint Dental · Location'))
})

test('a published Property scope opens the Property page, and every return keeps the report selection', async () => {
  const reportSearch = new URLSearchParams({
    measurementScope: 'property',
    measurementScopeKey: 'harbor-house',
    measurementMarketKey: PROPERTY_MARKET.id,
    queryClass: 'branded',
    measurementRunId: 'run-synthetic',
  })
  const { observed, page, router } = await renderPropertyRoute(`/projects/project_citypoint?${reportSearch}`)
  const hrefOf = (link: HTMLElement) => new URL(link.getAttribute('href')!, window.location.origin)

  // ProjectPage links by project name, not by the id this entry resolved.
  const projectPath = `/projects/${encodeURIComponent('Citypoint Dental NYC')}`
  const details = await page.findByRole('link', { name: 'Location details for Harbor House' })
  expect(details.textContent).toBe('Location details')
  expect(hrefOf(details).pathname).toBe(`${projectPath}/properties/harbor-house`)
  expect(Object.fromEntries(hrefOf(details).searchParams)).toEqual(Object.fromEntries(reportSearch))

  fireEvent.click(details)
  expect(await page.findByRole('heading', { level: 1, name: 'Harbor House' })).toBeTruthy()
  // Property reads take no market, so the page states its wider scope instead
  // of implying the carried market filter applies to these numbers.
  expect(page.getByText(/Filters not applied/)).toBeTruthy()
  expect(page.getByRole('button', { name: `AI Visibility is filtered to ${PROPERTY_MARKET.label}, a saved sweep. This page shows the latest measurement for all markets and answer engines.` })).toBeTruthy()
  expect((page.getByLabelText('Query type') as HTMLSelectElement).value).toBe('branded')
  const back = page.getByRole('link', { name: 'Back to AI Visibility' })
  expect(hrefOf(back).pathname).toBe(projectPath)
  expect(Object.fromEntries(hrefOf(back).searchParams)).toEqual(Object.fromEntries(reportSearch))
  // The market section compares markets, so its overview link returns to the whole site.
  const marketOverview = hrefOf(page.getByRole('link', { name: 'Open measurement overview' }))
  expect(marketOverview.pathname).toBe(projectPath)
  expect(Object.fromEntries(marketOverview.searchParams)).toEqual({ measurementScope: 'project', queryClass: 'branded', measurementRunId: 'run-synthetic' })

  fireEvent.change(page.getByLabelText('Query type'), { target: { value: 'non-brand' } })
  await waitFor(() => expect((page.getByLabelText('Query type') as HTMLSelectElement).value).toBe('non-brand'))
  expect(router.state.location.search).toMatchObject({ ...Object.fromEntries(reportSearch), queryClass: 'non-brand' })
  expect(router.state.location.search.runId).toBeUndefined()

  fireEvent.click(page.getByRole('link', { name: 'Back to AI Visibility' }))
  expect(await page.findByRole('link', { name: 'Location details for Harbor House' })).toBeTruthy()
  const returned = observed.filter(url => url.pathname.endsWith('/visibility-report')).at(-1)!
  expect(Object.fromEntries(returned.searchParams)).toMatchObject({
    scope: 'property', scopeKey: 'harbor-house', marketKey: PROPERTY_MARKET.id, queryClass: 'non-brand', runId: 'run-synthetic',
  })
}, 15_000)

test.each([
  ['a clean URL', '', 'non-brand'],
  ['an unclassified URL', '?queryClass=unknown', 'non-brand'],
  ['a clean URL for a branded-only Property', '', 'branded'],
] as const)('%s resolves the Property query type from its assignments and records it', async (_label, search, assignedClass) => {
  const { page, router } = await renderPropertyRoute(`/projects/project_citypoint/properties/harbor-house${search}`, assignedClass)

  expect(await page.findByRole('heading', { level: 1, name: 'Harbor House' })).toBeTruthy()
  await waitFor(() => {
    expect(router.state.location.search.queryClass).toBe(assignedClass)
    expect((page.getByLabelText('Query type') as HTMLSelectElement).value).toBe(assignedClass)
    expect(page.getByRole('link', { name: 'Back to AI Visibility' }).getAttribute('href')).toBe(`/projects/project_citypoint?queryClass=${assignedClass}`)
  })
  expect(page.queryByText(/Filters not applied/)).toBeNull()
})

test('Location details is offered only for a published Advanced Property scope outside embeds', async () => {
  const propertyPath = '/projects/project_citypoint?measurementScope=property&measurementScopeKey=harbor-house'

  const published = await renderAt(propertyPath, undefined, { plan: measurementPlanV2Response(4), visibilityReport: propertyScopeReport() })
  expect(published).toContain('aria-label="Location details for Harbor House"')
  expect(published).toContain(`/projects/${encodeURIComponent('Citypoint Dental NYC')}/properties/harbor-house?measurementScope=property&amp;measurementScopeKey=harbor-house`)

  const wholeSite = await renderAt('/projects/project_citypoint', undefined, { plan: measurementPlanV2Response(4), visibilityReport: visibilityReportResponse({ mode: 'advanced' }) })
  expect(wholeSite).toContain('Locations mentioned')
  expect(wholeSite).not.toContain('/properties/')

  const embedded = await renderAt(propertyPath, { enabled: true, projectTabs: ['overview'] }, { plan: measurementPlanV2Response(4), visibilityReport: propertyScopeReport() })
  expect(embedded).toContain('aria-label="AI visibility results"')
  expect(embedded).not.toContain('/properties/')

  // Simple projects keep their own overview; there is no Property to open.
  const simple = await renderAt(propertyPath)
  expect(simple).not.toContain('aria-label="AI visibility results"')
  expect(simple).not.toContain('/properties/')
})

const managedSchedule = {
  id: 'managed-schedule', projectId: 'project_citypoint', kind: 'answer-visibility',
  enabled: true, cronExpr: '0 6 * * *', timezone: 'UTC', providers: [],
  nextRunAt: '2026-09-08T06:00:00.000Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

function renderedPage(html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

function projectActions(html: string) {
  return renderedPage(html).querySelector<HTMLElement>('[data-project-actions]')!
}

test('managed sweeps unset preserves the operator sweep control and identical opt-out markup', async () => {
  const options = { settleReadiness: true, readiness: true,
    configureFixture(dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) {
      dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
    },
  }
  const original = await renderAt('/projects/project_citypoint', undefined, undefined, options)
  const disabled = await renderAt('/projects/project_citypoint', undefined, undefined, { ...options, managedSweeps: false })
  for (const html of [original, disabled]) {
    const launch = within(projectActions(html)).getByRole('button', { name: 'Run AI sweep' })
    expect(launch.hasAttribute('disabled')).toBe(false)
    expect(html).not.toContain('Sweeps are run by your Canonry team')
  }
})

test.each(['simple', 'advanced'] as const)('managed sweeps replaces the %s header control for admins and viewers', async mode => {
  for (const accountRole of ['admin', 'viewer'] as const) {
    const html = await renderAt('/projects/project_citypoint', undefined,
      mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
      { managedSweeps: true, schedule: managedSchedule, accountRole, configureFixture(dashboard) {
        dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
      } },
    )
    const actions = projectActions(html)
    expect(actions.querySelectorAll('button')).toHaveLength(0)
    expect(actions.querySelector('time')?.dateTime).toBe(managedSchedule.nextRunAt)
    expect(actions.textContent).toContain(MANAGED_SWEEPS_NEXT_LABEL)
    if (mode === 'advanced') {
      // No default range: Advanced renders no meta element at all, and the
      // actions hold nothing but the managed status.
      expect(renderedPage(html).querySelector('.project-context-meta')).toBeNull()
      expect(actions.querySelectorAll('p:not([role="status"])')).toHaveLength(0)
    }
    expect(html).not.toMatch(/Run AI sweep|Run measurement|Checking AI readiness|Set up AI Visibility/)
  }
})

test('an Advanced explicit historical range is a results filter token, not context-row meta', async () => {
  const html = await renderAt('/projects/project_citypoint?measurementFrom=2026-09-01T00:00:00.000Z&measurementTo=2026-09-08T23:59:59.999Z', undefined,
    { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() },
    { managedSweeps: true, schedule: managedSchedule },
  )
  const page = renderedPage(html)
  expect(page.querySelector('.project-context-meta')).toBeNull()
  const toolbar = page.querySelector('.visibility-results-toolbar')!
  expect([...toolbar.querySelectorAll('button[aria-label^="Remove filter "]')].map(token => [token.textContent, token.getAttribute('aria-label')])).toEqual([
    ['Sep 1 to Sep 8, 2026 (UTC)', 'Remove filter Sep 1 to Sep 8, 2026 (UTC)'],
  ])
  expect(toolbar.querySelector('button[aria-controls]')?.textContent).toBe('Filters · 1')
  expect(page.textContent).not.toContain('2026-09-01 to 2026-09-08')
})

test.each([
  { label: 'names when tracking changed and the next scheduled sweep', managedSweeps: false, running: false, visible: 'Tracking changed Aug 1', detail: 'Showing the Jul 30 results, from before the change. New numbers after the Sep 8 sweep.' },
  { label: 'names no next sweep date while a sweep is under way', managedSweeps: false, running: true, visible: 'Tracking changed Aug 1', detail: 'Showing the Jul 30 results, from before the change. New numbers after the next sweep.' },
  { label: 'names neither date on a managed dashboard', managedSweeps: true, running: false, visible: 'Tracking changed', detail: 'Showing the Jul 30 results, from before the change. New numbers after the next sweep.' },
])('the Advanced tracking-changed strip $label', async ({ managedSweeps, running, visible, detail }) => {
  const report = visibilityReportResponse({ mode: 'advanced', queryClass: parseVisibilitySelection({}).queryClass })
  report.selection.measurement = { ...report.selection.measurement, activeRevision: 5, awaitingSweep: true, pendingAssignmentCount: 1, completedAt: '2026-07-30T12:05:00.000Z' }
  // The plan (published Aug 1) and the schedule are cached in every case, so only the page's own rules keep a date out.
  const html = await renderAt('/projects/project_citypoint', undefined,
    { plan: measurementPlanV2Response(5), overview: measurementOverviewResponse(), visibilityReport: report },
    { managedSweeps, schedule: managedSchedule, configureFixture(dashboard) {
      const project = dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
      project.recentRuns = running ? [{ ...project.recentRuns[0]!, kind: 'answer-visibility', status: 'running' }] : []
    } },
  )
  const strips = [...renderedPage(html).querySelectorAll('[role="status"]')].filter(status => status.textContent?.startsWith('Tracking changed'))
  // Only the short label shows; the rest of the sentence is the name of the caution icon the strip holds.
  expect(strips.map(strip => [strip.textContent, [...strip.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))])).toEqual([[visible, [detail]]])
})

test('managed sweeps without a schedule replaces the header action without inventing a date', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture(dashboard) {
      dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.recentRuns = []
    },
  })
  const status = projectActions(html).querySelector('[role="status"]')!
  expect(status.textContent).toBe(MANAGED_SWEEPS_UNAVAILABLE_COPY)
  expect(status.querySelector('time')).toBeNull()
  expect(projectActions(html).querySelector('button')).toBeNull()
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
    const actions = projectActions(html)
    expect(actions.querySelector('[role="status"]')?.textContent).toBe(MANAGED_SWEEPS_RUNNING_COPY)
    expect(actions.querySelector('time')).toBeNull()
    expect(actions.querySelector('button')).toBeNull()
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
  expect(projectActions(html).textContent).not.toContain('AI sweep running')
})

test('managed sweeps removes Simple empty-state launch instructions', async () => {
  // By engine's empty state, now the first one a fresh Simple overview settles.
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture: forceNoisyFreshVisibility, citationVisibility: emptyCitationVisibility('no-runs-yet'),
  })
  expect(html).toContain(MANAGED_SWEEPS_COPY)
  expect(html).not.toMatch(/Run another sweep|Complete your first AI Visibility sweep|Run a sweep|Engine results appear after the first AI Visibility sweep/)
})

test('legacy managedSweeps alone still leaves Site Health scan controls available', async () => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo', undefined, undefined, { managedSweeps: true })
  expect(html).toMatch(/Run scan|Checking scan/)
  expect(projectActions(html).textContent).toContain(MANAGED_SWEEPS_RUNNING_COPY)
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
    for (const html of [original, empty]) {
      const doc = renderedPage(html)
      expect(within(doc).getByRole('heading', { level: 1, name: 'Citypoint Dental NYC' })).toBeTruthy()
      expect(html).not.toContain('Scans are run by your Canonry team')
      expect(html).not.toContain('Sweeps are run by your Canonry team')
      expect(within(projectActions(html)).getByRole('button', { name: /AI sweep running|Checking AI readiness|Set up AI Visibility|Run AI sweep/ }).hasAttribute('disabled')).toBe(true)
      if (suffix === '/technical-aeo') expect(within(doc).getByRole('heading', { name: 'Site Health' })).toBeTruthy()
      if (suffix === '/settings') expect(within(doc).getByRole('heading', { name: 'Project settings' })).toBeTruthy()
      if (suffix === '/history') expect(within(within(doc).getByRole('tablist', { name: 'Project history views' })).getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true')
      if (suffix === '' && mode === 'simple') expectTrendChartFirst(html)
      if (suffix === '' && mode === 'advanced') expect(doc.querySelector('.visibility-scope-trigger')?.textContent).toBe(ALL_OF_CITYPOINT)
    }
  }
})

// Project Settings' "Site Health scans" section: the saved page budget every
// scan without its own budget uses. Simple and Advanced share the section.
function siteHealthScansSection(html: string) {
  return within(renderedPage(html)).getByRole('heading', { level: 2, name: 'Site Health scans' }).closest('section')!
}

function advancedSettings(mode: 'simple' | 'advanced') {
  return mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined
}

test.each(['simple', 'advanced'] as const)('%s Settings shows the saved Site Health page budget in its editor', async mode => {
  for (const { saved, choice, custom } of [
    { saved: null, choice: 'full', custom: null },
    { saved: 2_500, choice: '2500', custom: null },
    { saved: 750, choice: 'custom', custom: '750' },
  ]) {
    const html = await renderAt('/projects/project_citypoint/settings', undefined, advancedSettings(mode), {
      accountRole: 'admin',
      configureFixture(dashboard) {
        dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.project.siteAuditMaxPages = saved
      },
    })
    const section = siteHealthScansSection(html)
    const select = within(section).getByRole('combobox', { name: 'Page budget' }) as HTMLSelectElement
    expect(select.value, String(saved)).toBe(choice)
    expect((within(section).queryByRole('spinbutton', { name: 'Custom page budget' }) as HTMLInputElement | null)?.value ?? null, String(saved)).toBe(custom)
    expect(within(section).getByRole('button', { name: 'Save page budget' }).hasAttribute('disabled')).toBe(true)
    // It sits right after the answer engine settings.
    const engines = section.parentElement!.querySelector('.project-engine-settings')!
    expect(engines).not.toBe(section)
    expect(engines.nextElementSibling).toBe(section)
  }
})

test.each(['simple', 'advanced'] as const)('%s Settings shows the saved page budget read-only to a viewer, a managed project writer and an embed', async mode => {
  const projectWriter = { id: 'key-project-writer', scopes: ['*'], projectId: 'project_citypoint', readOnly: false }
  const cases = [
    { label: 'viewer', embed: undefined, options: { accountRole: 'viewer' as const } },
    { label: 'managed project writer', embed: undefined, options: { apiKey: projectWriter, managedRunKinds: ['site-audit' as const] } },
    { label: 'embed', embed: { enabled: true, projectTabs: ['settings'] }, options: {} },
  ]
  for (const { label, embed, options } of cases) {
    const html = await renderAt('/projects/project_citypoint/settings', embed, advancedSettings(mode), {
      ...options,
      configureFixture(dashboard) {
        dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!.project.siteAuditMaxPages = 2_500
      },
    })
    const section = siteHealthScansSection(html)
    expect(section.textContent, label).toBe('Site Health scansPage budget: 2,500 pages')
    expect(within(section).queryByRole('combobox'), label).toBeNull()
    expect(within(section).queryByRole('button', { name: /Save|Cancel/ }), label).toBeNull()
  }
})

test.each(['simple', 'advanced'] as const)('%s Settings lets a project writer edit the page budget when Site Health scans are not managed', async mode => {
  const html = await renderAt('/projects/project_citypoint/settings', undefined, advancedSettings(mode), {
    apiKey: { id: 'key-project-writer', scopes: ['*'], projectId: 'project_citypoint', readOnly: false },
    managedRunKinds: ['answer-visibility'],
  })
  const select = within(siteHealthScansSection(html)).getByRole('combobox', { name: 'Page budget' }) as HTMLSelectElement
  expect(select.value).toBe('full')
})

test.each(['simple', 'advanced'] as const)('%s Settings saves the page budget through the project PUT without touching other fields', async mode => {
  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  project.project.siteAuditMaxPages = 2_500
  project.recentRuns = []
  fixture.dashboard.runs = []

  const puts: Array<Record<string, unknown>> = []
  let stored: Record<string, unknown> = { ...project.project, aliases: ['A1 Citypoint'] }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input))
    const url = new URL(request.url, window.location.origin)
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith(`/projects/${project.project.name}`)) {
      if (request.method === 'PUT') {
        const body = await request.clone().json() as Record<string, unknown>
        puts.push(body)
        stored = { ...stored, ...body }
      }
      return jsonResponse(stored)
    }
    if (path.endsWith('/projects')) return jsonResponse([stored])
    if (path.endsWith('/measurement-plan')) return jsonResponse(mode === 'advanced' ? measurementPlanV2Response(2) : { active: null })
    if (path.endsWith('/measurement-setup')) return jsonResponse(mode === 'advanced' ? activeMeasurementSetupResponse(2) : simpleMeasurementSetupResponse())
    if (path.endsWith('/schedules') || path.endsWith('/notifications') || path.endsWith('/runs')) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (mode === 'advanced') {
    queryClient.setQueryData(getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: project.project.name } }), measurementPlanV2Response(2))
  }
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint/settings'] })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  const section = await page.findByRole('region', { name: 'Site Health scans' })
  const select = within(section).getByRole('combobox', { name: 'Page budget' }) as HTMLSelectElement
  expect(select.value).toBe('2500')

  fireEvent.change(select, { target: { value: '10000' } })
  fireEvent.click(within(section).getByRole('button', { name: 'Save page budget' }))
  expect(await within(section).findByText('Page budget saved.')).toBeTruthy()
  expect(puts).toHaveLength(1)
  expect(puts[0]!.siteAuditMaxPages).toBe(10_000)
  // The rest of the project is the stored project, unchanged.
  expect(puts[0]!.aliases).toEqual(['A1 Citypoint'])
  expect(puts[0]!.displayName).toBe(project.project.displayName ?? project.project.name)
  // The project page's cached project now carries the new budget, which Site Health's Scan settings reads.
  const cached = queryClient.getQueryData(getApiV1ProjectsByNameQueryKey({ client: heyClient, path: { name: project.project.name } })) as { siteAuditMaxPages?: number | null } | undefined
  expect(cached?.siteAuditMaxPages).toBe(10_000)

  // Full site saves null, which the server stores as "no budget".
  fireEvent.change(select, { target: { value: 'full' } })
  fireEvent.click(within(section).getByRole('button', { name: 'Save page budget' }))
  await waitFor(() => expect(puts).toHaveLength(2))
  expect(puts[1]).toHaveProperty('siteAuditMaxPages', null)
  await waitFor(() => expect(select.value).toBe('full'))
})
