import { afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { MeasurementPropertyPage } from '../src/pages/MeasurementPropertyPage.js'
import { heyClient } from '../src/api.js'
import {
  getApiV1ProjectsByNameMeasurementChangesQueryKey,
  getApiV1ProjectsByNameMeasurementOverviewQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const TARGET_KEY = 'harbor-house'
const RUN_ID = 'run-synthetic'
const OWN_URL = 'https://locations.example/harbor-house'
const NEARBY_QUESTION = 'boutique hotels near the harbor'
/** The panel now reads one row per ANSWER, so every request carries the shape. */
const EVIDENCE_SHAPE = 'answers' as const

type Metric =
  | { state: 'available'; value: number; numerator: number; denominator: number }
  | { state: 'unavailable'; reason: string }

const available = (numerator: number, denominator: number): Metric => ({
  state: 'available',
  value: numerator / denominator,
  numerator,
  denominator,
})
const unavailable = (reason: string): Metric => ({ state: 'unavailable', reason })

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(cleanup)

function planResponse() {
  return {
    active: {
      revision: 7,
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
          stableKey: TARGET_KEY,
          label: 'Harbor House',
          aliases: ['Harbor House'],
          urlMatchers: [{ kind: 'prefix' as const, host: 'locations.example', pathPrefix: '/harbor-house', pathCase: 'insensitive' as const }],
          mentionNotApplicable: false,
          discoveryIdentity: 'sitemap:harbor-house',
        }],
        // TWO markets, and this Property is in exactly one of them. A fixture
        // whose only group contains the only target cannot see a membership
        // filter at all: deleting the filter outright left every test green.
        groups: [
          { stableKey: 'north', label: 'North', targetKeys: [TARGET_KEY], competitors: ['rival.example', 'other.example'] },
          { stableKey: 'south', label: 'South', targetKeys: ['other-property'], competitors: ['southern.example'] },
        ],
        querySnapshots: [{
          queryId: 'query-nearby',
          queryText: 'boutique hotels near the harbor',
          provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' },
        }],
        assignments: [{ targetKey: TARGET_KEY, queryId: 'query-nearby', queryClass: 'non-brand' as const, executionNodeKey: 'node-nearby' }],
        executionNodes: [{
          stableKey: 'node-nearby',
          queryId: 'query-nearby',
          queryText: 'boutique hotels near the harbor',
          context: { providers: ['openai' as const], models: {}, location: null },
          expectedSnapshots: 1,
        }],
        usageEdges: [{ executionNodeKey: 'node-nearby', targetKey: TARGET_KEY, queryId: 'query-nearby' }],
        compiledChecksum: 'b'.repeat(64),
      },
    },
  }
}

function legacyPlanResponse() {
  return {
    active: {
      revision: 6,
      checksum: 'c'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 1 as const,
        defaultContext: null,
        effectiveOwnedHosts: ['locations.example'],
        projectCanonicalHost: 'locations.example',
        projectBrandNames: ['Locations'],
        targets: [],
        groups: [],
        targetQuerySelections: [],
        querySnapshots: [],
        executionNodes: [],
        usageEdges: [],
        warnings: [],
      },
    },
  }
}

function overviewResponse(queryClass: 'branded' | 'non-brand', row: {
  mentionCoverage: Metric
  citationCoverage: Metric
  providers?: Array<{ provider: string; mentionCoverage: Metric; citationCoverage: Metric }>
}, options: {
  measurementState?: 'complete' | 'not_measured'
  nextAction?: 'none' | 'run_measurement'
  flags?: number
} = {}) {
  return {
    mode: 'active-v2' as const,
    scope: { kind: 'property' as const, key: TARGET_KEY, label: 'Harbor House' },
    queryClass,
    measurement: {
      state: options.measurementState ?? 'complete',
      displayedRunId: RUN_ID,
      completed: 2,
      expected: 2,
      completedAt: '2026-08-02T12:05:00.000Z',
    },
    nextAction: { kind: options.nextAction ?? 'none' },
    metrics: {
      propertiesMentioned: row.mentionCoverage,
      mentionCoverage: row.mentionCoverage,
      citationCoverage: row.citationCoverage,
      brandPresence: row.mentionCoverage,
      sov: row.mentionCoverage,
    },
    properties: {
      items: [{
        targetKey: TARGET_KEY,
        label: 'Harbor House',
        mentionCoverage: row.mentionCoverage,
        citationCoverage: row.citationCoverage,
        providers: row.providers ?? [],
        flags: options.flags ?? 0,
      }],
      nextCursor: null,
      totalEstimate: 1,
    },
    flags: { total: options.flags ?? 0 },
  }
}

type AnswerSource = {
  sourceUrl: string
  normalizedUrl: string | null
  classification: 'assigned' | 'sibling' | 'ownedUnmapped' | 'external' | 'ambiguous' | 'invalid'
  matchedTargetIds: string[]
  matchedUrlIds: string[]
}

const ownSource = (url: string = OWN_URL): AnswerSource => ({
  sourceUrl: url,
  normalizedUrl: url,
  classification: 'assigned',
  matchedTargetIds: [TARGET_KEY],
  matchedUrlIds: [`${TARGET_KEY}:url:0`],
})

const externalSource = (url: string): AnswerSource => ({
  sourceUrl: url,
  normalizedUrl: url,
  classification: 'external',
  matchedTargetIds: [],
  matchedUrlIds: [],
})

/**
 * One answer as this Property saw it. `mentioned` defaults to a measured miss
 * so a test that cares about the unknown case has to say so out loud.
 */
function answerRow(overrides: {
  slot: string
  queryText?: string
  mentioned?: boolean | null
  cited?: boolean | null
  sources?: AnswerSource[]
  provider?: string
  location?: string | null
  historical?: boolean
}) {
  const sources = overrides.sources ?? []
  return {
    observationId: `obs-${overrides.slot}`,
    expectedSlotId: `slot:${overrides.slot}`,
    executionId: 'node-nearby',
    usageEdgeId: `target:${TARGET_KEY}:query-nearby:node-nearby`,
    usageEdgeType: 'target' as const,
    provider: overrides.provider ?? 'openai',
    queryText: overrides.queryText ?? NEARBY_QUESTION,
    location: overrides.location ?? null,
    queryClass: 'non-brand' as const,
    mentioned: overrides.mentioned === undefined ? false : overrides.mentioned,
    // `??` treated an explicit null as absent and fell through to a computed
    // boolean, so a test could not express "capture was incomplete" at all.
    cited: 'cited' in overrides ? overrides.cited! : sources.some(source => source.classification === 'assigned'),
    sourceCount: sources.length,
    sourcesTruncated: false,
    sources,
    bridged: false,
    historical: overrides.historical ?? false,
    evidenceComplete: true,
  }
}

function evidenceResponse(
  items: ReturnType<typeof answerRow>[] = [answerRow({ slot: 'nearby', mentioned: true, sources: [ownSource()] })],
) {
  return {
    property: { targetKey: TARGET_KEY, label: 'Harbor House' },
    queryClass: 'non-brand' as const,
    measurement: { state: 'complete' as const, displayedRunId: RUN_ID },
    answers: {
      items,
      nextCursor: null as string | null,
      totalEstimate: items.length,
    },
  }
}

function measurementChangesResponse(runId = RUN_ID) {
  return {
    current: {
      state: 'complete' as const,
      displayedRunId: runId,
      planRevision: 7,
      completedAt: '2026-08-02T12:05:00.000Z',
      executionIdentity: 'openai:search-model',
      measurementScope: 'full' as const,
    },
    comparison: { state: 'unavailable' as const, reason: 'no_previous_run' as const },
  }
}

function runDetailResponse(id: string, kind: 'answer-visibility' | 'site-audit') {
  return {
    id,
    projectId: 'project_citypoint',
    kind,
    status: 'completed' as const,
    trigger: 'manual' as const,
    measurementPlanVersionId: kind === 'answer-visibility' ? 'measurement-plan-v7' : null,
    measurementScope: null,
    location: null,
    queries: null,
    startedAt: '2026-08-02T12:00:00.000Z',
    finishedAt: '2026-08-02T12:05:00.000Z',
    error: null,
    createdAt: '2026-08-02T12:00:00.000Z',
    snapshots: [],
  }
}

/** The panel's own table, addressed by the caption every test shares. */
function answersTable() {
  return screen.findByRole('table', { name: 'Answers measured for this Property' })
}

function answerFor(table: HTMLElement, queryText: string): HTMLElement {
  return within(table).getByText(queryText).closest('tr')!
}

async function renderPropertyPage(options: {
  branded: ReturnType<typeof overviewResponse>
  nonBrand: ReturnType<typeof overviewResponse>
  plan?: ReturnType<typeof planResponse> | ReturnType<typeof legacyPlanResponse>
  evidence?: ReturnType<typeof evidenceResponse>
}): Promise<void> {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    options.plan ?? planResponse(),
  )
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementChangesQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { scope: 'property', targetKey: TARGET_KEY, queryClass: 'non-brand', runId: RUN_ID },
    }),
    measurementChangesResponse(),
  )
  for (const [queryClass, response] of [['branded', options.branded], ['non-brand', options.nonBrand]] as const) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementOverviewQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass },
      }),
      response,
    )
  }
  const evidenceQuery = {
    targetKey: TARGET_KEY,
    queryClass: 'non-brand' as const,
    shape: EVIDENCE_SHAPE,
    limit: 50,
    runId: RUN_ID,
  }
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: evidenceQuery,
    }),
    {
      pages: [options.evidence ?? evidenceResponse()],
      pageParams: [{ path: { name: projectName }, query: evidenceQuery }],
    },
  )

  const router = createAppRouter(queryClient, {
    initialEntries: [`/projects/${projectName}/properties/${TARGET_KEY}`],
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

async function renderPropertyPageFromApi(
  handler: (url: string) => Response | Promise<Response>,
  initialEntry?: string,
  seed?: (queryClient: QueryClient, projectName: string) => void,
) {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(queryClient, projectName)
  const restoreFetch = mockFetch(url => handler(url))
  onTestFinished(restoreFetch)
  const router = createAppRouter(queryClient, {
    initialEntries: [initialEntry ?? `/projects/${projectName}/properties/${TARGET_KEY}`],
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
  return { projectName, queryClient, router }
}

/** AuthGate mounts the router without DashboardProvider in production. */
async function renderPropertyPageWithoutDashboardContext(
  handler: (url: string) => Response | Promise<Response>,
  initialEntry: string,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const restoreFetch = mockFetch(url => handler(url))
  onTestFinished(restoreFetch)
  const rootRoute = createRootRoute({ component: Outlet })
  const propertyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectName/properties/$targetKey',
    component: MeasurementPropertyPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([propertyRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  await router.load()
  render(
    <AccountProvider account={null}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </AccountProvider>,
  )
  return { queryClient, router }
}

function propertyPageResponses({
  branded = overviewResponse('branded', { mentionCoverage: available(1, 2), citationCoverage: available(1, 2) }),
  nonBrand = overviewResponse('non-brand', { mentionCoverage: available(3, 4), citationCoverage: available(2, 4) }),
  evidence = evidenceResponse(),
}: {
  branded?: ReturnType<typeof overviewResponse>
  nonBrand?: ReturnType<typeof overviewResponse>
  evidence?: ReturnType<typeof evidenceResponse>
} = {}) {
  return (url: string) => {
    const path = pathOf(url)
    if (/\/api\/v1\/projects\/[^/?]+(?:\?.*)?$/.test(path)) {
      return jsonResponse({ id: 'project_citypoint', name: 'citypoint' })
    }
    if (path.endsWith(`/runs/${RUN_ID}`)) return jsonResponse(runDetailResponse(RUN_ID, 'answer-visibility'))
    if (path.endsWith('/measurement-plan')) return jsonResponse(planResponse())
    if (path.includes('/measurement-overview')) {
      return new URL(url).searchParams.get('queryClass') === 'branded'
        ? jsonResponse(branded)
        : jsonResponse(nonBrand)
    }
    if (path.includes('/measurement-property-evidence')) return jsonResponse(evidence)
    if (path.includes('/measurement-changes')) return jsonResponse(measurementChangesResponse())
    if (path.includes('/measurement-property-competitors')) {
      return jsonResponse({
        property: { targetKey: TARGET_KEY, label: 'Harbor House' },
        measurement: { state: 'complete', displayedRunId: RUN_ID, planRevision: 7, completedAt: '2026-08-02T12:05:00.000Z' },
        queryClass: 'non-brand',
        basis: { state: 'available', answeredResults: 4, targetMissResults: 3, recommendationOccurrences: 5 },
        competitors: [
          {
            name: 'Harborline Homes', occurrences: 3, providers: ['openai', 'gemini'],
            providerTotal: 2, providersTruncated: false,
            questions: [NEARBY_QUESTION], questionTotal: 1, questionsTruncated: false,
          },
          {
            name: 'The Sutton', occurrences: 1, providers: ['gemini'],
            providerTotal: 1, providersTruncated: false,
            questions: [NEARBY_QUESTION], questionTotal: 1, questionsTruncated: false,
          },
        ],
        total: 2,
        truncated: false,
      })
    }
    if (path.includes('/measurement-question-result')) {
      return jsonResponse({
        property: { targetKey: TARGET_KEY, label: 'Harbor House' },
        measurement: { state: 'complete', displayedRunId: RUN_ID, planRevision: 7, completedAt: '2026-08-02T12:05:00.000Z' },
        question: {
          resultId: 'obs-nearby', queryId: 'query-nearby', text: NEARBY_QUESTION, class: 'non-brand',
          provider: 'openai', requestedModel: null, servedModel: null, location: null, status: 'answered',
        },
        mentioned: false,
        cited: false,
        recommendedInstead: [],
        answer: 'The strongest options nearby are Harborline Homes and The Sutton, both a short walk from the water.',
        sources: [],
        captureStatus: 'complete',
        retrievalStatus: 'used',
        retrievalContract: 'native-auto-v1',
      })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }
}

describe('Property page', () => {
  it('forwards a measurement snapshot without DashboardProvider or a run-detail classifier', async () => {
    const observed: string[] = []
    const responses = propertyPageResponses()

    await renderPropertyPageWithoutDashboardContext(url => {
      observed.push(url)
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?measurementRunId=${RUN_ID}`)

    expect(await screen.findByRole('heading', { name: 'Harbor House' })).toBeTruthy()
    const overviewRequests = observed.filter(url => pathOf(url).includes('/measurement-overview'))
    expect(overviewRequests).not.toHaveLength(0)
    expect(overviewRequests.every(url => new URL(url).searchParams.get('runId') === RUN_ID)).toBe(true)
    expect(observed.some(url => pathOf(url).endsWith(`/runs/${RUN_ID}`))).toBe(false)
  })

  it('leaves an invalid measurement snapshot to the server instead of silently unpinning it', async () => {
    const observed: string[] = []
    const otherProjectRunId = 'run-other-project'
    const responses = propertyPageResponses()

    await renderPropertyPageWithoutDashboardContext(url => {
      observed.push(url)
      if (pathOf(url).includes('/measurement-overview') && new URL(url).searchParams.get('runId') === otherProjectRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Run belongs to another project' }, 422)
      }
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?measurementRunId=${otherProjectRunId}`)

    expect(await screen.findByText('Could not load this Property.')).toBeTruthy()
    const overviewRequests = observed.filter(url => pathOf(url).includes('/measurement-overview'))
    expect(overviewRequests).not.toHaveLength(0)
    expect(overviewRequests.every(url => new URL(url).searchParams.get('runId') === otherProjectRunId)).toBe(true)
    expect(observed.some(url => pathOf(url).endsWith(`/runs/${otherProjectRunId}`))).toBe(false)
  })

  it('starts pinned Property reads before the active plan resolves and never fetches run detail', async () => {
    const observed: string[] = []
    let releasePlan: (() => void) | undefined
    const planGate = new Promise<void>(resolve => { releasePlan = resolve })
    const responses = propertyPageResponses()

    await renderPropertyPageFromApi(url => {
      observed.push(url)
      const path = pathOf(url)
      if (path.endsWith('/measurement-plan')) return planGate.then(() => responses(url))
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?measurementRunId=${RUN_ID}`)

    await waitFor(() => {
      expect(observed.some(url => pathOf(url).endsWith('/measurement-plan'))).toBe(true)
      expect(observed.some(url => pathOf(url).includes('/measurement-overview'))).toBe(true)
    })
    expect(observed.some(url => pathOf(url).endsWith(`/runs/${RUN_ID}`))).toBe(false)
    await act(async () => { releasePlan?.() })
    await waitFor(() => expect(observed.some(url => pathOf(url).includes('/measurement-overview'))).toBe(true))
    expect(await screen.findByRole('heading', { name: 'Harbor House', hidden: true })).toBeTruthy()
    const overviewRequests = observed.filter(url => pathOf(url).includes('/measurement-overview'))
    expect(overviewRequests.every(url => new URL(url).searchParams.get('runId') === RUN_ID)).toBe(true)
  })

  it('keeps a non-measurement run drawer separate from Property measurement reads', async () => {
    const observed: string[] = []
    const drawerRunId = 'run-site-audit'
    const responses = propertyPageResponses()
    const { router } = await renderPropertyPageFromApi(url => {
      observed.push(url)
      const path = pathOf(url)
      if (path.endsWith(`/runs/${drawerRunId}`)) return jsonResponse(runDetailResponse(drawerRunId, 'site-audit'))
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('runId') === drawerRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Not a measurement run' }, 422)
      }
      if (path.includes('/measurement-changes') && new URL(url).searchParams.get('runId') === drawerRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Not a measurement run' }, 422)
      }
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?scope=group:north&class=branded&runId=${drawerRunId}&keep=fixture`)

    expect(await screen.findByRole('heading', { name: 'Harbor House' })).toBeTruthy()
    await screen.findByRole('region', { name: /Named instead of this Property/ })

    const runSensitiveRequests = observed.filter(url => (
      /measurement-overview|measurement-property-evidence|measurement-property-competitors|measurement-changes/.test(pathOf(url))
    ))
    expect(runSensitiveRequests).not.toHaveLength(0)
    expect(runSensitiveRequests.every(url => new URL(url).searchParams.get('runId') !== drawerRunId)).toBe(true)

    const back = screen.getByRole('link', { name: 'Back to measurement overview' })
    const backDestination = new URL(back.getAttribute('href')!, window.location.origin)
    expect(backDestination.searchParams.get('scope')).toBe('group:north')
    expect(backDestination.searchParams.get('class')).toBe('branded')
    expect(backDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(backDestination.searchParams.get('runId')).toBeNull()
    expect(backDestination.searchParams.get('keep')).toBe('fixture')
    expect(router.state.location.search.runId).toBe(drawerRunId)

    const market = screen.getByRole('region', { name: /Measured at the market level/ })
    const overviewDestination = new URL(
      within(market).getByRole('link', { name: 'Open measurement overview' }).getAttribute('href')!,
      window.location.origin,
    )
    const groupDestination = new URL(
      within(market).getByRole('link', { name: 'North' }).getAttribute('href')!,
      window.location.origin,
    )
    expect(overviewDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(groupDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(overviewDestination.searchParams.get('runId')).toBeNull()
    expect(groupDestination.searchParams.get('runId')).toBeNull()
  })

  it('does not pin Property reads to an answer run from another plan version', async () => {
    const observed: string[] = []
    const staleRunId = 'run-prior-plan'
    const responses = propertyPageResponses()

    await renderPropertyPageFromApi(url => {
      observed.push(url)
      const path = pathOf(url)
      if (path.endsWith(`/runs/${staleRunId}`)) {
        return jsonResponse({
          ...runDetailResponse(staleRunId, 'answer-visibility'),
          measurementPlanVersionId: 'measurement-plan-v6',
        })
      }
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('runId') === staleRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Run belongs to a prior plan' }, 422)
      }
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?runId=${staleRunId}`)

    expect(await screen.findByRole('heading', { name: 'Harbor House' })).toBeTruthy()
    await screen.findByRole('region', { name: /Named instead of this Property/ })

    const runSensitiveRequests = observed.filter(url => (
      /measurement-overview|measurement-property-evidence|measurement-property-competitors|measurement-changes/.test(pathOf(url))
    ))
    expect(runSensitiveRequests).not.toHaveLength(0)
    expect(runSensitiveRequests.every(url => new URL(url).searchParams.get('runId') !== staleRunId)).toBe(true)
  })

  it('falls back unpinned when cached active-plan revalidation fails', async () => {
    const observed: string[] = []
    const stalePlanRunId = 'run-stale-active-plan'
    const responses = propertyPageResponses()

    await renderPropertyPageFromApi(url => {
      observed.push(url)
      const path = pathOf(url)
      if (path.endsWith(`/runs/${stalePlanRunId}`)) return jsonResponse(runDetailResponse(stalePlanRunId, 'answer-visibility'))
      if (path.endsWith('/measurement-plan')) return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic revalidation failure' }, 500)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('runId') === stalePlanRunId) {
        return jsonResponse({ code: 'INVALID_RUN', message: 'Stale plan cannot validate this pin' }, 422)
      }
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?runId=${stalePlanRunId}`, (queryClient) => {
      queryClient.setQueryData(
        getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: 'project_citypoint' } }),
        planResponse(),
      )
    })

    await waitFor(() => expect(observed.some(url => pathOf(url).endsWith('/measurement-plan'))).toBe(true))
    expect(await screen.findByText('Harbor House')).toBeTruthy()
    const measurementRequests = observed.filter(url => (
      /measurement-overview|measurement-property-evidence|measurement-property-competitors|measurement-changes/.test(pathOf(url))
    ))
    expect(measurementRequests).not.toHaveLength(0)
    expect(measurementRequests.every(url => new URL(url).searchParams.get('runId') !== stalePlanRunId)).toBe(true)
  })

  it('waits for the resolved overview run before reading named competitors', async () => {
    const observed: string[] = []
    let releaseOverview: (() => void) | undefined
    const overviewGate = new Promise<void>(resolve => { releaseOverview = resolve })
    const responses = propertyPageResponses()

    await renderPropertyPageFromApi(url => {
      observed.push(url)
      if (pathOf(url).includes('/measurement-overview')) {
        return overviewGate.then(() => responses(url))
      }
      return responses(url)
    })

    await screen.findByLabelText('Query type')
    await waitFor(() => expect(observed.filter(url => pathOf(url).includes('/measurement-overview'))).toHaveLength(2))
    expect(observed.some(url => pathOf(url).includes('/measurement-property-competitors'))).toBe(false)
    expect(screen.queryByRole('region', { name: /Named instead of this Property/ })).toBeNull()

    releaseOverview?.()
    await screen.findByRole('region', { name: /Named instead of this Property/ })
    const competitorRequest = observed.find(url => pathOf(url).includes('/measurement-property-competitors'))
    expect(competitorRequest).toBeDefined()
    expect(new URL(competitorRequest!).searchParams.get('runId')).toBe(RUN_ID)
  })

  it('does not read named competitors when both overview reads fail', async () => {
    const observed: string[] = []
    const responses = propertyPageResponses()

    await renderPropertyPageFromApi(url => {
      observed.push(url)
      if (pathOf(url).includes('/measurement-overview')) {
        return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Synthetic failure' }, 500)
      }
      return responses(url)
    })

    await screen.findByText('Could not load this Property.')
    expect(observed.filter(url => pathOf(url).includes('/measurement-overview'))).toHaveLength(2)
    expect(observed.some(url => pathOf(url).includes('/measurement-property-competitors'))).toBe(false)
    expect(screen.queryByRole('region', { name: /Named instead of this Property/ })).toBeNull()
  })

  it('keeps Property class and measurement snapshot continuity in the URL across back and forward navigation', async () => {
    const pinnedRunId = 'run-pinned'
    const observed: string[] = []
    const pinnedOverview = (queryClass: 'branded' | 'non-brand') => ({
      ...overviewResponse(queryClass, { mentionCoverage: available(1, 2), citationCoverage: available(1, 2) }),
      measurement: {
        ...overviewResponse(queryClass, { mentionCoverage: available(1, 2), citationCoverage: available(1, 2) }).measurement,
        displayedRunId: pinnedRunId,
      },
    })
    const responses = propertyPageResponses({
      branded: pinnedOverview('branded'),
      nonBrand: pinnedOverview('non-brand'),
    })
    const { router } = await renderPropertyPageFromApi(url => {
      observed.push(url)
      return responses(url)
    }, `/projects/project_citypoint/properties/${TARGET_KEY}?scope=group:north&class=branded&measurementRunId=${pinnedRunId}&keep=fixture`)

    const queryType = await screen.findByLabelText('Query type') as HTMLSelectElement
    expect(queryType.value).toBe('branded')
    await screen.findByRole('heading', { name: 'Since previous comparable sweep' })
    await screen.findByRole('region', { name: /Named instead of this Property/ })

    const pinSensitiveRequests = observed.filter(url => (
      /measurement-overview|measurement-property-evidence|measurement-property-competitors|measurement-changes/.test(pathOf(url))
    ))
    expect(pinSensitiveRequests.length).toBeGreaterThan(0)
    for (const url of pinSensitiveRequests) {
      expect(new URL(url).searchParams.get('runId')).toBe(pinnedRunId)
    }

    fireEvent.change(queryType, { target: { value: 'non-brand' } })
    await waitFor(() => {
      const search = router.state.location.search as Record<string, unknown>
      expect(search.class).toBe('non-brand')
      expect(search.scope).toBe('group:north')
      expect(search.measurementRunId).toBe(pinnedRunId)
      expect(search.runId).toBeUndefined()
      expect(search.keep).toBe('fixture')
    })

    await act(async () => { router.history.back() })
    await waitFor(() => expect((screen.getByLabelText('Query type') as HTMLSelectElement).value).toBe('branded'))
    await act(async () => { router.history.forward() })
    await waitFor(() => expect((screen.getByLabelText('Query type') as HTMLSelectElement).value).toBe('non-brand'))
  })

  it('returns to the incoming Group and makes each member Group link scoped', async () => {
    const { router } = await renderPropertyPageFromApi(propertyPageResponses(),
      `/projects/project_citypoint/properties/${TARGET_KEY}?scope=group:north&class=non-brand&measurementRunId=${RUN_ID}`)

    // The header link is intentionally visible while the overview is loading,
    // but it cannot claim a run until the displayed snapshot resolves.
    await screen.findByRole('heading', { name: 'Since previous comparable sweep' })
    const back = await screen.findByRole('link', { name: 'Back to measurement overview' })
    const backDestination = new URL(back.getAttribute('href')!, window.location.origin)
    expect(backDestination.searchParams.get('scope')).toBe('group:north')
    expect(backDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(backDestination.searchParams.get('runId')).toBeNull()

    const market = await screen.findByRole('region', { name: /Measured at the market level/ })
    const memberGroup = within(market).getByRole('link', { name: 'North' })
    const groupDestination = new URL(memberGroup.getAttribute('href')!, window.location.origin)
    expect(groupDestination.searchParams.get('scope')).toBe('group:north')
    expect(groupDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(groupDestination.searchParams.get('runId')).toBeNull()
    expect(router.state.location.search.scope).toBe('group:north')
  })

  it('returns a direct Property link to the Portfolio', async () => {
    await renderPropertyPageFromApi(propertyPageResponses(),
      `/projects/project_citypoint/properties/${TARGET_KEY}?class=branded&measurementRunId=${RUN_ID}`)

    await screen.findByRole('heading', { name: 'Since previous comparable sweep' })
    const back = await screen.findByRole('link', { name: 'Back to measurement overview' })
    const backDestination = new URL(back.getAttribute('href')!, window.location.origin)
    expect(backDestination.searchParams.get('scope')).toBeNull()
    expect(backDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(backDestination.searchParams.get('runId')).toBeNull()
  })

  it('keeps the compact loading skeleton inside a readable status', async () => {
    await renderPropertyPageFromApi(() => new Promise<Response>(() => {}))

    expect((await screen.findByRole('status')).textContent).toContain('Loading Property')
  })

  it('keeps a successful class visible when the other class fails and retries only that class', async () => {
    let brandedAttempts = 0
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'branded') {
        brandedAttempts += 1
        return brandedAttempts === 1
          ? new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
          : jsonResponse(overviewResponse('branded', { mentionCoverage: available(2, 2), citationCoverage: available(2, 2) }))
      }
      return propertyPageResponses()(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by query class',
    })
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!
    expect(within(nonBrand).getByText('75%')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Could not load branded queries.')

    fireEvent.click(screen.getByRole('button', { name: 'Retry branded queries' }))
    await waitFor(() => expect(within(contrast).getAllByText('100%')).toHaveLength(2))
    expect(brandedAttempts).toBe(2)
  })

  it('keeps cached class metrics and evidence visible when a background refresh fails', async () => {
    let brandedAttempts = 0
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'branded') {
        brandedAttempts += 1
        if (brandedAttempts === 2) {
          return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
        }
        return jsonResponse(overviewResponse('branded', {
          mentionCoverage: available(brandedAttempts === 1 ? 1 : 2, 2),
          citationCoverage: available(brandedAttempts === 1 ? 1 : 2, 2),
        }))
      }
      return propertyPageResponses()(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by query class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    expect(within(branded).getAllByText('50%')).toHaveLength(2)
    // The evidence panel is now one row per ANSWER, so the row that survives a
    // failed refresh is addressed by its question rather than by a cited URL —
    // the URL moved inside the row and is collapsed by default.
    const evidence = await answersTable()

    await queryClient.refetchQueries({
      exact: true,
      queryKey: getApiV1ProjectsByNameMeasurementOverviewQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass: 'branded' },
      }),
    })

    await screen.findByText('Refresh failed.')
    expect(within(branded).getAllByText('50%')).toHaveLength(2)
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry branded queries' }))
    await waitFor(() => expect(within(branded).getAllByText('100%')).toHaveLength(2))
    expect(brandedAttempts).toBe(3)
  })

  it('keeps the complete cached Property page when every report refresh fails', async () => {
    let failRefresh = false
    const responses = propertyPageResponses()
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (failRefresh && (path.endsWith('/measurement-plan') || path.includes('/measurement-overview'))) {
        return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return responses(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by query class',
    })
    // Same rename as above: the panel's caption follows the answer rows.
    const evidence = await answersTable()
    failRefresh = true
    await Promise.all([
      queryClient.refetchQueries({
        exact: true,
        queryKey: getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
      }),
      ...(['branded', 'non-brand'] as const).map(queryClass => queryClient.refetchQueries({
        exact: true,
        queryKey: getApiV1ProjectsByNameMeasurementOverviewQueryKey({
          client: heyClient,
          path: { name: projectName },
          query: { scope: 'property', targetKey: TARGET_KEY, queryClass },
        }),
      })),
    ])

    expect(screen.queryByText('Could not load this Property.')).toBeNull()
    expect(contrast).toBeTruthy()
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Refresh failed.')).toHaveLength(2))
  })

  // A failed "show more" must never take the loaded rows down with it — the
  // panel is an explanation of a gap, and blanking it turns a paging hiccup
  // into "there is no evidence". Rewritten for the answer rows: the first page
  // is now addressed by its question, not by a cited URL.
  it('keeps the loaded answers on a next-page failure and retries that page from one alert', async () => {
    let nextPageAttempts = 0
    const secondPage = evidenceResponse([answerRow({ slot: 'dining', queryText: 'harbour restaurants with rooms above' })])
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-property-evidence')) {
        if (new URL(url).searchParams.get('cursor') === 'next') {
          nextPageAttempts += 1
          if (nextPageAttempts === 1) {
            return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
          }
          return jsonResponse({ ...secondPage, answers: { ...secondPage.answers, totalEstimate: 2 } })
        }
        const first = evidenceResponse()
        return jsonResponse({ ...first, answers: { ...first.answers, nextCursor: 'next', totalEstimate: 2 } })
      }
      return propertyPageResponses()(url)
    })

    const evidence = await answersTable()
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more evidence.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry more evidence' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry more evidence' }))
    await waitFor(() => expect(within(evidence).getByText('harbour restaurants with rooms above')).toBeTruthy())
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(nextPageAttempts).toBe(2)
  })

  it('offers a contextual measurement link when this Property has not been measured', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      }, { measurementState: 'not_measured', nextAction: 'run_measurement' }),
    })

    const link = await screen.findByRole('link', { name: 'Go to measurement overview' })
    expect(link.getAttribute('href')).toMatch(/\/projects\/[^/]+$/)
  })

  it('directs a legacy measurement plan to republish setup', async () => {
    await renderPropertyPage({
      plan: legacyPlanResponse(),
      branded: overviewResponse('branded', { mentionCoverage: unavailable('plan_v1'), citationCoverage: unavailable('plan_v1') }),
      nonBrand: overviewResponse('non-brand', { mentionCoverage: unavailable('plan_v1'), citationCoverage: unavailable('plan_v1') }),
    })

    expect(await screen.findByRole('link', { name: 'Republish setup' })).toBeTruthy()
  })

  it('leads with the branded versus non-brand contrast for one Property', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(12, 12),
        citationCoverage: available(12, 12),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(0, 12),
        citationCoverage: available(0, 12),
      }),
    })

    expect(await screen.findByRole('heading', { name: 'Harbor House' })).toBeTruthy()
    const contrast = screen.getByRole('table', {
      name: 'Mention and citation coverage for this Property, split by query class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!

    expect(within(branded).getAllByText('100%')).toHaveLength(2)
    expect(within(branded).getAllByText('12 of 12')).toHaveLength(2)
    // A measured zero is a real reading and must render as one, so the two
    // rows are legible against each other.
    expect(within(nonBrand).getAllByText('0%')).toHaveLength(2)
    expect(within(nonBrand).getAllByText('0 of 12')).toHaveLength(2)
  })

  it('renders a Property with no branded question as not measured, never as 0%', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
      }),
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by query class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!

    expect(within(branded).getAllByText('Not measured')).toHaveLength(2)
    expect(within(branded).getAllByText('No queries of this type are assigned')).toHaveLength(2)
    expect(within(branded).queryByText(/%$/)).toBeNull()
    for (const reason of within(branded).getAllByText('No queries of this type are assigned')) {
      expect(reason.className).toContain('text-sm')
      expect(reason.className).toContain('text-secondary')
    }
  })

  it('breaks the selected class down by answer engine', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
        providers: [
          { provider: 'gemini', mentionCoverage: available(1, 2), citationCoverage: available(0, 2) },
          { provider: 'openai', mentionCoverage: available(2, 2), citationCoverage: available(2, 2) },
        ],
      }),
    })

    const providers = await screen.findByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('gemini').closest('tr')!
    const openai = within(providers).getByText('openai').closest('tr')!

    expect(within(gemini).getByText('50%')).toBeTruthy()
    expect(within(gemini).getByText('0%')).toBeTruthy()
    expect(within(openai).getAllByText('100%')).toHaveLength(2)
  })

  it('lists the assigned questions, URLs, and scoped evidence for the selected class', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
      }),
    })

    const questions = await screen.findByRole('table', { name: 'Queries assigned to this Property' })
    expect(within(questions).getByText(NEARBY_QUESTION)).toBeTruthy()

    const urls = screen.getByRole('table', { name: 'URL matchers configured for this Property' })
    expect(within(urls).getByText('https://locations.example/harbor-house/*')).toBeTruthy()

    // The cited URL and its classification moved inside the answer row, so this
    // assertion now expands the answer before reading them.
    const evidence = await answersTable()
    fireEvent.click(within(evidence).getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    expect(within(evidence).getByText('Matches this Property')).toBeTruthy()
    expect(within(evidence).getByText(OWN_URL)).toBeTruthy()
    expect(screen.queryByText(/revision \d+/i)).toBeNull()
    expect(screen.getByLabelText('Query type').className).toContain('h-11')
  })

  it('labels ambiguous source-to-Property matches consistently', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
      }, { flags: 2 }),
    })

    expect(await screen.findByText('2 ambiguous matches')).toBeTruthy()
    expect(screen.getByRole('button', {
      name: /recorded as an ambiguous source-to-Property match instead of being credited to either/i,
    })).toBeTruthy()
  })
})

describe('Property answer evidence', () => {
  const measuredNonBrand = overviewResponse('non-brand', {
    mentionCoverage: available(1, 4),
    citationCoverage: available(0, 4),
  })
  const measuredBranded = overviewResponse('branded', {
    mentionCoverage: unavailable('no_population'),
    citationCoverage: unavailable('no_population'),
  })

  async function renderAnswers(items: ReturnType<typeof answerRow>[]) {
    await renderPropertyPage({
      branded: measuredBranded,
      nonBrand: measuredNonBrand,
      evidence: evidenceResponse(items),
    })
    return answersTable()
  }

  it('renders an answer row for every measured answer when this Property was cited in none of them', async () => {
    const evidence = await renderAnswers([
      answerRow({ slot: 'a', queryText: 'where to stay by the water' }),
      answerRow({ slot: 'b', queryText: 'best small hotels in the old port' }),
      answerRow({ slot: 'c', queryText: 'quiet hotels with harbour views' }),
    ])

    // Three answers, zero citations. The per-URL shape had nothing to emit for
    // any of them, which is exactly the gap this panel exists to show.
    expect(within(evidence).getAllByRole('row')).toHaveLength(4)
    expect(within(evidence).getByText('where to stay by the water')).toBeTruthy()
    expect(within(evidence).getByText('quiet hotels with harbour views')).toBeTruthy()
    expect(screen.queryByText('No answers matched this Property in the displayed measurement.')).toBeNull()
  })

  it('renders a mention with no citation as mentioned yes and cited no', async () => {
    const evidence = await renderAnswers([
      answerRow({
        slot: 'a',
        queryText: 'where to stay by the water',
        mentioned: true,
        sources: [externalSource('https://guide.example/harbour-stays')],
      }),
    ])
    const row = answerFor(evidence, 'where to stay by the water')

    expect(within(row).getByText('Mentioned')).toBeTruthy()
    expect(within(row).getByText('Not cited')).toBeTruthy()
    expect(within(row).queryByText('Not mentioned')).toBeNull()
    expect(within(row).queryByText('Cited')).toBeNull()
  })

  it('renders an unread mention as Not measured with its reason and never as a zero', async () => {
    const evidence = await renderAnswers([
      answerRow({ slot: 'a', queryText: 'where to stay by the water', mentioned: null }),
      answerRow({ slot: 'b', queryText: 'best small hotels in the old port', mentioned: null, historical: true }),
    ])
    const unread = answerFor(evidence, 'where to stay by the water')
    const recovered = answerFor(evidence, 'best small hotels in the old port')

    expect(within(unread).getByText('Not measured')).toBeTruthy()
    expect(within(unread).getByText('No mention signal for this Property')).toBeTruthy()
    // Was: asserted "Recovered from an earlier run without its answer text".
    // The wire says the signal is unreadable, never why, so naming a cause was a
    // provenance claim the response does not carry.
    expect(within(recovered).getByText('No mention signal for this Property')).toBeTruthy()

    // An absent signal is not a measured zero. Neither the row nor the panel
    // may put a number on it.
    expect(within(unread).queryByText('Not mentioned')).toBeNull()
    expect(within(unread).queryByText('0%')).toBeNull()
    expect(within(evidence).queryByText('0%')).toBeNull()
    expect(within(evidence).queryByText(/0%/)).toBeNull()
  })

  it('renders an uncaptured citation as Not measured, never as Not cited', async () => {
    // `cited: null` means the sources were never fully captured. "Not cited"
    // states a measured miss, and a source count of 0 claims the engine returned
    // no URLs when we simply never saw them.
    const evidence = await renderAnswers([
      answerRow({ slot: 'a', queryText: 'where to stay by the water', cited: null, sources: [] }),
    ])
    const unknown = answerFor(evidence, 'where to stay by the water')

    expect(within(unknown).queryByText('Not cited')).toBeNull()
    expect(within(unknown).getAllByText('Not measured').length).toBeGreaterThan(0)
    expect(within(unknown).getByText('Sources were not fully captured')).toBeTruthy()
  })

  // Was: 'puts losses above wins by default', asserting a client-side re-sort.
  // That ranked only the rows FETCHED so far, so a loss on page two arrived via
  // "Show more" and jumped above rows the operator was already reading. Ranking
  // the whole result set belongs on the server, which this change does not do,
  // so the panel preserves server order and this asserts exactly that.
  it('preserves the order the server returned', async () => {
    const evidence = await renderAnswers([
      answerRow({ slot: 'a', queryText: 'won both ways', mentioned: true, sources: [ownSource()] }),
      answerRow({ slot: 'b', queryText: 'mentioned only', mentioned: true }),
      answerRow({ slot: 'c', queryText: 'mention never read', mentioned: null }),
      answerRow({ slot: 'd', queryText: 'lost both ways' }),
    ])

    const order = within(evidence)
      .getAllByRole('row')
      .slice(1)
      .map(row => row.querySelector('td')!.textContent)

    expect(order).toEqual([
      expect.stringContaining('won both ways'),
      expect.stringContaining('mentioned only'),
      expect.stringContaining('mention never read'),
      expect.stringContaining('lost both ways'),
    ])
  })

  it('collapses every answer and leads its sources with this Property\'s own', async () => {
    const evidence = await renderAnswers([
      answerRow({
        slot: 'a',
        queryText: 'where to stay by the water',
        mentioned: true,
        sources: [externalSource('https://guide.example/harbour-stays'), ownSource(), externalSource('https://reviews.example/harbour')],
      }),
    ])

    expect(within(evidence).queryByText(OWN_URL)).toBeNull()
    const toggle = within(evidence).getByRole('button', { name: 'Read the answer for where to stay by the water' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    const sources = within(evidence).getByRole('table', { name: 'Source URLs for where to stay by the water' })
    expect(within(sources).getAllByRole('row').slice(1).map(row => row.querySelector('td:last-child')!.textContent))
      .toEqual([OWN_URL, 'https://guide.example/harbour-stays', 'https://reviews.example/harbour'])
    expect(within(sources).getByText('Matches this Property')).toBeTruthy()
  })

  it('says an answer cited nothing rather than leaving its detail blank', async () => {
    const evidence = await renderAnswers([answerRow({ slot: 'a', queryText: 'where to stay by the water' })])

    fireEvent.click(within(evidence).getByRole('button', { name: 'Read the answer for where to stay by the water' }))
    expect(within(evidence).getByText('This answer returned no source URLs at all.')).toBeTruthy()
  })

  it('re-scopes the answers when the question type changes', async () => {
    const requested: string[] = []
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-property-evidence')) {
        const params = new URL(url).searchParams
        requested.push(`${params.get('queryClass')}:${params.get('shape')}`)
        return jsonResponse(evidenceResponse([
          answerRow({ slot: params.get('queryClass') === 'branded' ? 'branded' : 'nonbrand', queryText: `${params.get('queryClass')} answer` }),
        ]))
      }
      return propertyPageResponses()(url)
    })

    await waitFor(async () => expect(within(await answersTable()).getByText('non-brand answer')).toBeTruthy())

    // The panel unmounts while the new class loads, so the table is re-read
    // rather than held across the switch.
    fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'branded' } })
    await waitFor(async () => expect(within(await answersTable()).getByText('branded answer')).toBeTruthy())
    expect(requested).toContain('non-brand:answers')
    expect(requested).toContain('branded:answers')
  })
})

describe('Coverage hero', () => {
  it('leads with non-brand and shows the count behind each rate', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(12, 12),
        citationCoverage: available(12, 12),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(4, 20),
        citationCoverage: available(3, 20),
      }),
    })

    const hero = await screen.findByRole('region', { name: 'Coverage for this Property' })
    // Non-brand is the demand a Property has to earn, so it reads first.
    const eyebrows = within(hero).getAllByText(/the demand to earn|already named/)
    expect(eyebrows[0]!.textContent).toContain('the demand to earn')

    // The rate is never shown without the count it came from.
    expect(within(hero).getByText('20')).toBeTruthy()
    expect(within(hero).getByText('4 of 20')).toBeTruthy()
    expect(within(hero).getByText('3 of 20')).toBeTruthy()
    expect(within(hero).getAllByText('12 of 12').length).toBe(2)
  })

  it('renders no bar at all for an unmeasured class, so it cannot read as a measured zero', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(12, 12),
        citationCoverage: available(12, 12),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
    })

    const hero = await screen.findByRole('region', { name: 'Coverage for this Property' })
    expect(within(hero).getAllByText('Not measured').length).toBe(2)

    // A zero-width track beside "Not measured" would read as a measured zero.
    // Branded is measured and keeps its two bars; the unmeasured pair has none.
    expect(hero.querySelectorAll('.aeo-hero-row-bar').length).toBe(2)
    expect(within(hero).queryByText('0%')).toBeNull()
  })
})

describe('Property facts and market link', () => {
  it('states each count once, in the section that owns it, not also in a card above it', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(4, 4),
        citationCoverage: available(4, 4),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(1, 4),
        citationCoverage: available(0, 4),
        providers: [
          { provider: 'openai', mentionCoverage: available(1, 2), citationCoverage: available(0, 2) },
          { provider: 'gemini', mentionCoverage: available(0, 2), citationCoverage: available(0, 2) },
        ],
      }),
    })

    // The page used to open with four metric cards, three of which restated a
    // count the section directly below already carried. The counts still exist
    // — in one place each.
    await screen.findByRole('region', { name: /assigned to this Property/ })
    expect(screen.queryByText('Questions assigned')).toBeNull()
    expect(screen.queryByText('Owned URLs')).toBeNull()
    expect(screen.queryByText('Answer engines')).toBeNull()
    expect(document.querySelectorAll('.metric-card')).toHaveLength(0)

    // Provenance is the one fact no section states, so it survives as a line.
    expect(screen.getByText(/Measured Aug 2, 2026/)).toBeTruthy()
    expect(screen.queryByText(/No completed sweep yet/)).toBeNull()
  })

  it('never claims zero engines for a class the run never measured', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(4, 4),
        citationCoverage: available(4, 4),
      }),
      // The server ships `providers: []` next to an unavailable metric, so an
      // empty provider list here means "this class was not measured", not "no
      // engine answered". Counting it printed "0 / No engine answered" while
      // the hero on the same screen said "Not measured".
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
    })

    await screen.findByRole('region', { name: 'Coverage for this Property' })
    expect(screen.queryByText('No engine answered for this Property')).toBeNull()
    // The server's own reason reaches the reader rather than a bare em dash.
    // It appears in the hero rows too, which is why this counts rather than
    // asserting a single node.
    expect(screen.getAllByText(/No queries of this type are assigned/).length).toBeGreaterThan(0)
  })

  it('names the markets this Property is in, and only those', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(4, 4),
        citationCoverage: available(4, 4),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(1, 4),
        citationCoverage: available(0, 4),
      }),
    })

    // A single Property has nobody to compare against, so the page points at
    // the market rather than rendering an empty competitor card that reads as
    // missing data. "South" exists in the plan and does not contain this
    // Property, so naming it here would attribute a comparison that is not this
    // Property's.
    const market = await screen.findByRole('region', { name: /Measured at the market level/ })
    expect(within(market).getByText('North')).toBeTruthy()
    expect(within(market).queryByText('South')).toBeNull()
    expect(within(market).getByText('2 competitors')).toBeTruthy()

    // Group identity is in the URL, so each member link lands on the market it
    // names instead of silently turning into the all-properties overview.
    const links = within(market).getAllByRole('link')
    expect(links).toHaveLength(2)
    const overview = within(market).getByRole('link', { name: 'Open measurement overview' })
    expect(overview).toBeTruthy()
    const north = within(market).getByRole('link', { name: 'North' })
    const overviewDestination = new URL(overview.getAttribute('href')!, window.location.origin)
    const groupDestination = new URL(north.getAttribute('href')!, window.location.origin)
    expect(overviewDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(overviewDestination.searchParams.get('runId')).toBeNull()
    expect(groupDestination.searchParams.get('scope')).toBe('group:north')
    expect(groupDestination.searchParams.get('measurementRunId')).toBe(RUN_ID)
    expect(groupDestination.searchParams.get('runId')).toBeNull()
    // Portfolio defaults remain elided even as the resolved snapshot is made
    // explicit, keeping the Group/Portfolio URL contract compact.
    expect(overviewDestination.searchParams.get('class')).toBeNull()
    expect(groupDestination.searchParams.get('class')).toBeNull()
  })

  it('does not claim the Property was never swept while a class is failing', async () => {
    // The facts grid read `selected?.measurement.completedAt ?? null`, which
    // collapses "this response was never read" into "there has never been a
    // completed sweep" and prints "Last measured: Never / No completed sweep
    // yet" about a Property that was measured this morning.
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'non-brand') {
        return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return propertyPageResponses()(url)
    })

    // The provenance line must not appear at all rather than assert a sweep
    // history nobody has read: "Never" is a measured claim.
    await screen.findByRole('region', { name: 'Coverage for this Property' })
    expect(screen.queryByText(/Never/)).toBeNull()
    expect(screen.queryByText(/No completed sweep yet/)).toBeNull()

    // And the hero says the class failed rather than spinning forever: the
    // retry is in the table below, so "Loading" is a promise nothing will keep.
    const hero = screen.getByRole('region', { name: 'Coverage for this Property' })
    expect(within(hero).getAllByText('Unavailable')).toHaveLength(2)
    expect(within(hero).queryByText('Loading')).toBeNull()
  })

  it('uses the singular for a market with one competitor', async () => {
    const plan = planResponse()
    plan.active.plan.groups[0]!.competitors = ['rival.example']
    await renderPropertyPage({
      plan,
      branded: overviewResponse('branded', { mentionCoverage: available(4, 4), citationCoverage: available(4, 4) }),
      nonBrand: overviewResponse('non-brand', { mentionCoverage: available(1, 4), citationCoverage: available(0, 4) }),
    })

    const market = await screen.findByRole('region', { name: /Measured at the market level/ })
    expect(within(market).getByText('1 competitor')).toBeTruthy()
  })
})

describe('Reading the answer', () => {
  it('leads an opened row with what the engine actually said', async () => {
    // The row can only say whether this Property was named. The reason to open
    // it is to find out what was recommended instead — a "not mentioned" row on
    // a local question can turn out to be an answer naming two rival buildings,
    // and no badge or source count carries that.
    await renderPropertyPageFromApi(propertyPageResponses())

    const toggle = await screen.findByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` })
    fireEvent.click(toggle)

    expect(await screen.findByText(/Harborline Homes and The Sutton/)).toBeTruthy()
    expect(screen.getByText(/What openai answered/i)).toBeTruthy()
  })

  it('fetches the answer only when a row is opened', async () => {
    // Answers run to thousands of characters and most rows are never opened,
    // so the list read deliberately does not carry them.
    const paths: string[] = []
    await renderPropertyPageFromApi(url => {
      paths.push(pathOf(url))
      return propertyPageResponses()(url)
    })

    await screen.findByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` })
    expect(paths.some(path => path.includes('/measurement-question-result'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    await screen.findByText(/Harborline Homes and The Sutton/)
    expect(paths.some(path => path.includes('/measurement-question-result'))).toBe(true)
  })
})

// Two queries repeated down almost every row — the production shape that
// motivated collapsing the Queries cell into a count. A real screenshot had
// nine rows where four carried this exact joined string and the rest carried
// one half of it.
const REPEATED_QUERY_A = 'apartments in north district'
const REPEATED_QUERY_B = 'best apartments near north district'
const REPEATED_QUERIES_TEXT = `${REPEATED_QUERY_A} · ${REPEATED_QUERY_B}`

type CompetitorRowFixture = {
  name: string
  occurrences: number
  providers: string[]
  providerTotal: number
  providersTruncated: boolean
  questions: string[]
  questionTotal: number
  questionsTruncated: boolean
}

function competitorRow(
  overrides: { name: string; questions: string[] } & Partial<CompetitorRowFixture>,
): CompetitorRowFixture {
  return {
    occurrences: 1,
    providers: ['openai'],
    providerTotal: 1,
    providersTruncated: false,
    questionTotal: overrides.questions.length,
    questionsTruncated: false,
    ...overrides,
  }
}

function competitorsResponse(rows: CompetitorRowFixture[]) {
  return {
    property: { targetKey: TARGET_KEY, label: 'Harbor House' },
    measurement: { state: 'complete' as const, displayedRunId: RUN_ID, planRevision: 7, completedAt: '2026-08-02T12:05:00.000Z' },
    queryClass: 'non-brand' as const,
    basis: { state: 'available' as const, answeredResults: 9, targetMissResults: 9, recommendationOccurrences: 20 },
    competitors: rows,
    total: rows.length,
    truncated: false,
  }
}

function renderNamedInsteadWith(rows: CompetitorRowFixture[]) {
  return renderPropertyPageFromApi(url => {
    if (pathOf(url).includes('/measurement-property-competitors')) return jsonResponse(competitorsResponse(rows))
    return propertyPageResponses()(url)
  })
}

describe('Named instead of this Property', () => {
  it('names who the engines recommended in the answers this Property missed', async () => {
    // Coverage says there is a gap. Only this says what is in it — and the
    // occurrence counts are meaningless without the basis, which states how
    // many answers they were counted over.
    await renderPropertyPageFromApi(propertyPageResponses())

    const section = await screen.findByRole('region', { name: /Named instead of this Property/ })
    expect(within(section).getByText('Harborline Homes')).toBeTruthy()
    expect(within(section).getByText('The Sutton')).toBeTruthy()
    expect(within(section).getByText('openai, gemini')).toBeTruthy()
    expect(within(section).getByText(/3 of 4 answers to non-brand queries did not name this Property/)).toBeTruthy()
  })

  it('collapses a repeated query list into a count, and keeps the text reachable behind disclosure', async () => {
    // Alpha and Beta are two DIFFERENT rivals that share the exact same query
    // list — the production shape. Gamma carries only half that list, so its
    // count must read differently even though its query text overlaps.
    const rows = [
      competitorRow({ name: 'Alpha Towers', occurrences: 4, questions: [REPEATED_QUERY_A, REPEATED_QUERY_B] }),
      competitorRow({ name: 'Beta Lofts', occurrences: 6, questions: [REPEATED_QUERY_A, REPEATED_QUERY_B] }),
      competitorRow({ name: 'Gamma Flats', occurrences: 5, questions: [REPEATED_QUERY_A] }),
    ]
    await renderNamedInsteadWith(rows)

    const section = await screen.findByRole('region', { name: /Named instead of this Property/ })

    // The wide, near-constant text is gone from the row cells on first render
    // — only the count survives there.
    expect(within(section).queryByText(REPEATED_QUERIES_TEXT)).toBeNull()
    expect(within(section).queryByText(REPEATED_QUERY_A)).toBeNull()

    const alphaRow = within(section).getByText('Alpha Towers').closest('tr')!
    const betaRow = within(section).getByText('Beta Lofts').closest('tr')!
    const gammaRow = within(section).getByText('Gamma Flats').closest('tr')!

    // The count is the signal that survives: two different rivals both show
    // "2" — that IS the thing a reader compares row to row.
    expect(within(alphaRow).getByText('2')).toBeTruthy()
    expect(within(betaRow).getByText('2')).toBeTruthy()
    expect(within(gammaRow).getByText('1')).toBeTruthy()

    // The disclosure control is a real, named, keyboard-reachable button, and
    // activating it exposes the exact joined query text.
    const alphaToggle = within(alphaRow).getByRole('button', { name: REPEATED_QUERIES_TEXT })
    fireEvent.click(alphaToggle)
    expect(await screen.findByText(REPEATED_QUERIES_TEXT)).toBeTruthy()
  })

  it('surfaces the truncation indicator behind the disclosure control, worded exactly', async () => {
    const rows = [
      competitorRow({
        name: 'Delta Suites',
        occurrences: 9,
        questions: [REPEATED_QUERY_A, REPEATED_QUERY_B],
        questionTotal: 5,
        questionsTruncated: true,
      }),
    ]
    await renderNamedInsteadWith(rows)

    const section = await screen.findByRole('region', { name: /Named instead of this Property/ })
    const deltaRow = within(section).getByText('Delta Suites').closest('tr')!

    // The count is the SERVER total (5), not the length of the sample array (2).
    expect(within(deltaRow).getByText('5')).toBeTruthy()

    const deltaToggle = within(deltaRow).getByRole('button', { name: `${REPEATED_QUERIES_TEXT} +3 more` })
    fireEvent.click(deltaToggle)
    expect(await screen.findByText(`${REPEATED_QUERIES_TEXT} +3 more`)).toBeTruthy()
  })

  it('says so plainly when no rival was named, rather than showing an empty table', async () => {
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-competitors')) {
        return jsonResponse({
          property: { targetKey: TARGET_KEY, label: 'Harbor House' },
          measurement: { state: 'complete', displayedRunId: RUN_ID, planRevision: 7, completedAt: '2026-08-02T12:05:00.000Z' },
          queryClass: 'non-brand',
          basis: { state: 'unavailable', reason: 'no_population' },
          competitors: [], total: 0, truncated: false,
        })
      }
      return propertyPageResponses()(url)
    })

    const section = await screen.findByRole('region', { name: /Named instead of this Property/ })
    expect(within(section).getByText(/No rival was named/)).toBeTruthy()
    expect(section.querySelector('table')).toBeNull()
  })
})
