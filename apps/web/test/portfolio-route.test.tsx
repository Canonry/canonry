import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import {
  getApiV1CdpStatusQueryKey,
  getApiV1ProjectsByNameMeasurementOverviewInfiniteQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameMeasurementReportQueryKey,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey,
  getApiV1ProjectsByNameSchedulesQueryKey,
  getApiV1ProjectsByNameScheduleQueryKey,
} from '@ainyc/canonry-api-client/react-query'

type EmbedBlock = { enabled: boolean; views?: string[]; projectTabs?: string[] }

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

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
    accountRole?: 'admin' | 'viewer'
    seedPlan?: boolean
    apiKey?: { id: string; scopes: string[]; projectId: string | null; readOnly: boolean }
    queries?: Array<{ id: string; query: string; createdAt: string }>
    settleReadiness?: boolean
    readiness?: boolean
    configureFixture?: (dashboard: ReturnType<typeof createDashboardFixture>['dashboard']) => void
  } = {},
): Promise<string> {
  if (embed) window.__CANONRY_CONFIG__ = { embed }
  else delete window.__CANONRY_CONFIG__
  if (options.managedSweeps !== undefined) {
    window.__CANONRY_CONFIG__ = { ...window.__CANONRY_CONFIG__, dashboard: { managedSweeps: options.managedSweeps } }
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
      // Simple projects have no class control, so the card always asks for the
      // one class a share of voice can be built on.
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
  if (!options.settleReadiness || !settledSetup) return renderToStaticMarkup(tree)

  // Header-readiness assertions need the authoritative refetch to settle. Most
  // route snapshots intentionally stay synchronous; this opt-in branch mounts
  // only the tests that make a claim about the post-fetch sweep action.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.origin)
    if (decodeURIComponent(url.pathname).endsWith('/measurement-setup')) {
      return jsonResponse(settledSetup)
    }
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  try {
    const page = render(tree)
    await waitFor(() => {
      expect(queryClient.getQueryState(
        getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
      )?.fetchStatus).toBe('idle')
    })
    const html = page.container.innerHTML
    page.unmount()
    return html
  } finally {
    globalThis.fetch = realFetch
  }
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

test('a Simple project keeps the existing Overview without advertising advanced measurement', async () => {
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('Competitor landscape')
  expect(html.match(/Where competitors are winning/g)).toHaveLength(1)
  expect(html).toContain('Mention gaps')
  expect(html).toContain('Citation gaps')
  expect(html.match(/competitive-summary/g)).toHaveLength(1)
  expect(html).toContain('AI sweep running')
  expect(html).not.toContain('Set up advanced measurement')
  expect(html).not.toContain('Republish setup')
  expect(html).not.toContain('Latest measurement')
})

test.each([false, true])('Simple query evidence starts expanded (embed: %s)', async (embed) => {
  const html = await renderAt(
    '/projects/project_citypoint',
    embed ? { enabled: true } : undefined,
  )
  const document = new DOMParser().parseFromString(html, 'text/html')
  const section = document.querySelector<HTMLDetailsElement>('#evidence-section')

  expect(section).not.toBeNull()
  expect(section!.open).toBe(true)
  expect(section!.querySelector('.evidence-table')).not.toBeNull()
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

  expect(await page.findByText('Competitor landscape')).toBeTruthy()
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
  // Competitor history remains available on the legacy Advanced Measurement
  // surface; group-only scope does not exist until a v2 plan is active.
  expect(html).toContain('Competitor landscape')
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
  expect(html).not.toContain('Where competitors are winning')
})

test('a version-two Overview uses server scope, search and pagination and defers evidence until a Property expands', async () => {
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
    if (url.pathname.endsWith('/measurement-overview')) {
      if (url.searchParams.get('search') === 'retry') {
        if (failRetrySearch) {
          failRetrySearch = false
          return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic failure' }, 500)
        }
        return jsonResponse(measurementOverviewResponse({ label: 'Recovered Search Result' }))
      }
      if (url.searchParams.get('cursor') === 'cursor-2') {
        return jsonResponse(measurementOverviewResponse({
          label: 'Harbor Annex',
          targetKey: 'harbor-annex',
          totalEstimate: 2,
        }))
      }
      if (url.searchParams.get('search') === 'harbor') {
        await searchGate
        return jsonResponse(measurementOverviewResponse({
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'Harbor Search Result',
        }))
      }
      if (url.searchParams.get('groupKey') === 'north') {
        return jsonResponse(measurementOverviewResponse({
          scope: 'group',
          scopeKey: 'north',
          scopeLabel: 'North',
          label: 'North Property',
        }))
      }
      return jsonResponse(measurementOverviewResponse({ nextCursor: 'cursor-2', totalEstimate: 2 }))
    }
    if (url.pathname.endsWith('/measurement-report')) return jsonResponse(measurementReportResponse(4))
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

  expect(await page.findByText('Harbor House')).toBeTruthy()
  const firstOverviewUrl = observed.find(path => path.includes('/measurement-overview?'))
  expect(firstOverviewUrl).toContain('scope=all')
  // All queries is the default now — the operator has not yet said which lane
  // he is asking about, and defaulting to one silently hid the other.
  expect(firstOverviewUrl).toContain('queryClass=all')
  expect(firstOverviewUrl).toContain('limit=50')
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)

  fireEvent.click(page.getByRole('button', { name: 'Show 50 more' }))
  expect(await page.findByText('Harbor Annex')).toBeTruthy()
  expect(observed.some(path => path.includes('cursor=cursor-2') && path.includes('runId=run-synthetic'))).toBe(true)

  // Group is a segmented radiogroup at <=5 groups, so pick the option by label.
  fireEvent.click(within(page.getByLabelText('Group')).getByRole('radio', { name: 'North' }))
  expect(await page.findByText('North Property')).toBeTruthy()
  expect(observed.some(path => path.includes('scope=group') && path.includes('groupKey=north'))).toBe(true)

  fireEvent.change(page.getByLabelText('Search properties'), { target: { value: 'harbor' } })
  await waitFor(() => expect(observed.some(path => path.includes('search=harbor'))).toBe(true))
  expect((page.getByLabelText('Search properties') as HTMLInputElement).value).toBe('harbor')
  expect(page.queryByText('North Property')).toBeNull()
  expect(page.getByLabelText('Updating Property results')).toBeTruthy()
  releaseSearch!()
  expect(await page.findByText('Harbor Search Result')).toBeTruthy()
  expect(observed.some(path => path.includes('/measurement-report?'))).toBe(false)

  fireEvent.click(page.getByText('Harbor Search Result').closest('tr')!)
  expect(await page.findByText('Assigned queries')).toBeTruthy()
  await waitFor(() => expect(observed.some(path => path.includes('/measurement-report?revision=4') && path.includes('runId=run-synthetic'))).toBe(true))

  fireEvent.change(page.getByLabelText('Search properties'), { target: { value: 'retry' } })
  expect(await page.findByText('Could not load the advanced measurement report.')).toBeTruthy()
  fireEvent.click(page.getByRole('button', { name: 'Retry report' }))
  expect(await page.findByText('Recovered Search Result')).toBeTruthy()
  expect((page.getByLabelText('Search properties') as HTMLInputElement).value).toBe('retry')
})

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
  expect(page.getByText('Competitor landscape')).toBeTruthy()
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

test('a baseline remains visible when five newer failed runs fill the recent-run slice', async () => {
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
  expect(html).toContain('Mention share')
  expect(html).toContain('Mention gaps')
  expect(html).toContain('Citation gaps')
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
test('an unresolved measurement plan shows a skeleton instead of flashing the Simple Overview', async () => {
  // The bug: `resolveAdvancedMeasurementMode` reads a pending plan read as
  // `null`, and `null` means "this project has no plan". So a project WITH an
  // advanced plan painted the legacy overview first and swapped it out once the
  // read landed — a visible flash on every cold navigation into a project.
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { seedPlan: false })

  expect(html).toContain('Loading project overview')
  // The legacy overview's own copy must not appear while the answer is unknown.
  expect(html).not.toContain('Competitor landscape')
})

test('a settled plan read still renders the Simple Overview, so the guard is not a permanent skeleton', async () => {
  // The other half: once the read settles as "no plan", `null` means what it
  // says and the legacy surface is correct. A guard that cannot tell pending
  // from settled would strand this on the skeleton forever.
  const html = await renderAt('/projects/project_citypoint')

  expect(html).toContain('Competitor landscape')
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
    '/projects/project_citypoint?class=branded',
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
    },
  )

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const control = doc.querySelector('[aria-labelledby="advanced-measurement-class-label"]')
  const checked = control?.querySelector('[role="radio"][aria-checked="true"]')
  expect(checked?.textContent).toBe('Branded')
  expect(html).toContain('Branded market rival')
})

test('switching query class refetches the competitor landscape under the matching cache key', async () => {
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

  expect(await page.findByText('All-query rival')).toBeTruthy()
  expect(observed.some(path => (
    path.includes('/analytics/competitors?')
    && path.includes('scope=all-markets')
    && path.includes('queryClass=all')
  ))).toBe(true)

  fireEvent.click(within(page.getByLabelText('Query type')).getByRole('radio', { name: 'Branded' }))

  expect(await page.findByText('Branded Property')).toBeTruthy()
  expect(await page.findByText('Branded rival')).toBeTruthy()
  expect(observed.some(path => (
    path.includes('/analytics/competitors?')
    && path.includes('scope=all-markets')
    && path.includes('queryClass=branded')
  ))).toBe(true)
  expect(router.state.location.search).toMatchObject({ class: 'branded' })
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
  expect(original).not.toContain('managed by your Canonry team')
  expect(original).not.toContain('Sweeps are run by your Canonry team')
})

test.each(['simple', 'advanced'] as const)('managed sweeps replaces the %s header control for admins and viewers', async mode => {
  for (const accountRole of ['admin', 'viewer'] as const) {
    const html = await renderAt('/projects/project_citypoint', undefined,
      mode === 'advanced' ? { plan: measurementPlanV2Response(2), overview: measurementOverviewResponse() } : undefined,
      { managedSweeps: true, schedule: managedSchedule, accountRole },
    )
    const header = projectHeader(html)
    expect(header.querySelector('button')).toBeNull()
    expect(header.querySelector('time')?.dateTime).toBe(managedSchedule.nextRunAt)
    expect(header.textContent).toContain('Next sync Tuesday 8 Sept, 06:00 UTC · managed by your Canonry team')
    expect(html).not.toMatch(/Run AI sweep|Run measurement|Checking AI readiness|Set up AI Visibility/)
  }
})

test('managed sweeps without a schedule replaces the header action without inventing a date', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, { managedSweeps: true })
  const status = projectHeader(html).querySelector('[role="status"]')!
  expect(status.textContent).toBe('Sweeps are run by your Canonry team')
  expect(status.querySelector('time')).toBeNull()
  expect(projectHeader(html).querySelector('button')).toBeNull()
  expect(status.textContent).not.toMatch(/Next sync|UTC|\d/)
})

test('managed sweeps removes Simple empty-state launch instructions', async () => {
  const html = await renderAt('/projects/project_citypoint', undefined, undefined, {
    managedSweeps: true, configureFixture: forceNoisyFreshVisibility,
  })
  expect(html).toContain('Sweeps are run by your Canonry team')
  expect(html).not.toMatch(/Run another sweep|Complete your first AI Visibility sweep|Run a sweep/)
})

test('managed sweeps leaves Site Health scan controls available', async () => {
  const html = await renderAt('/projects/project_citypoint/technical-aeo', undefined, undefined, { managedSweeps: true })
  expect(html).toMatch(/Run scan|Checking scan/)
  expect(projectHeader(html).textContent).toContain('Sweeps are run by your Canonry team')
})

test('managed sweeps replaces the global batch sweep control', async () => {
  const original = await renderAt('/runs')
  expect(original).toContain('Run all projects')
  const managed = await renderAt('/runs', undefined, undefined, { managedSweeps: true })
  expect(managed).not.toContain('Run all projects')
  expect(managed).toContain('Sweeps are run by your Canonry team')
})
