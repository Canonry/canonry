import { afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import { EVIDENCE_LABELS, OTHER_QUERIES_COPY } from '../src/pages/MeasurementPropertyPage.js'
import { PROPERTY_NAMES_COPY, PropertyNamesSection } from '../src/components/project/advanced-measurement/PropertyNamesEditor.js'
import { AccountProvider, type SignedInAccount } from '../src/contexts/account-context.js'
import {
  answerProseForMentions,
  measurementTargetNameIssueMessage,
  MeasurementTargetNameIssueCodes,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
} from '@ainyc/canonry-contracts'
import { createQueryClient } from '../src/queries/query-client.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { ANSWER_SOURCES_LABEL } from '../src/components/shared/AnswerMarkdown.js'
import {
  getApiV1ProjectsByNameMeasurementOverviewQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const TARGET_KEY = 'harbor-house'
const RUN_ID = 'run-synthetic'
const OWN_URL = 'https://locations.example/harbor-house'
const NEARBY_QUESTION = 'boutique hotels near the harbor'
/** The panel now reads one row per ANSWER, so every request carries the shape. */
const EVIDENCE_SHAPE = 'answers' as const

type Metric =
  | { state: 'available'; value: number; numerator: number; denominator: number; unattributed?: number; unchecked?: number }
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

/**
 * AI Visibility's report for this Property after a tracking change: it restates
 * the last sweep from revision 6 while revision 7 waits for its first sweep.
 * `measuredRevision: null` is a Property no sweep has ever measured. `empty` is
 * a Property that sweep asked no queries of this type, which the change gave its first.
 */
function lastResultsReport(measuredRevision: number | null, empty = false) {
  const rate = { numerator: 1, denominator: 2, rate: 0.5 }
  const missing = { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  const provenance = { kind: 'frozen-advanced', definitionRevision: 7 }
  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'advanced', queryClass: 'non-brand', scope: { id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1 },
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: measuredRevision, run: { id: measuredRevision === null ? null : 'run-before-change', explicit: false }, provenance,
      measurement: {
        state: measuredRevision === null ? 'not-measured' : 'measured', activeRevision: 7, measuredRevision, awaitingSweep: true,
        pendingAssignmentCount: 1, completedAt: measuredRevision === null ? null : '2026-07-30T12:05:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 }, { id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1 }],
    filterOptions: { providers: ['openai'], models: [], locations: [{ kind: 'all' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: empty
        ? { queryCount: 0, answerCount: 0, mentionCoverage: missing, citationCoverage: missing, propertyReach: missing, outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 1 } }
        : { queryCount: 1, answerCount: 2, mentionCoverage: rate, citationCoverage: rate, propertyReach: rate, outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 1, notMeasured: 0, total: 2 } },
      trend: [], queries: { items: [], total: 0, nextCursor: null }, evidence: { items: [], total: 0, nextCursor: null },
      competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [], breakdown: { groups: [], properties: [] },
    }],
  })
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
}, options: { measurementState?: 'complete' | 'not_measured'; nextAction?: 'none' | 'run_measurement' } = {}) {
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
        flags: 0,
      }],
      nextCursor: null,
      totalEstimate: 1,
    },
    flags: { total: 0 },
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

type OtherQueryRow = {
  observationId: string
  expectedSlotId: string
  executionId: string
  provider: string
  queryText: string
  location: string | null
  queryClass: 'branded' | 'non-brand'
  assignedTargetKeys: string[]
  sources: Array<{ sourceUrl: string; normalizedUrl: string | null; matchedUrlIds: string[] }>
  sourceCount: number
  sourcesTruncated: boolean
  evidenceComplete: boolean
}

function otherQueriesResponse(items: OtherQueryRow[], queryClass: 'branded' | 'non-brand' = 'non-brand') {
  return {
    property: { targetKey: TARGET_KEY, label: 'Harbor House' },
    queryClass,
    measurement: { state: 'complete' as const, displayedRunId: RUN_ID },
    otherQueries: { items, nextCursor: null as string | null, totalEstimate: items.length },
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
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: { account?: SignedInAccount | null; search?: string; queryClient?: QueryClient } = {},
) {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = options.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const restoreFetch = mockFetch((url, init) => handler(url, init))
  onTestFinished(restoreFetch)
  const router = createAppRouter(queryClient, {
    initialEntries: [`/projects/${projectName}/properties/${TARGET_KEY}${options.search ?? ''}`],
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={options.account ?? null}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { projectName, queryClient, router }
}

/** `GET /projects/{name}`: the project's own record, nothing below it. */
const PROJECT_READ = /\/projects\/[^/?]+$/

/**
 * The project as the server reads it now. Its brand names are what the draft
 * API checks Property names against; by default they match the published
 * plan's `Locations`.
 */
function projectRead(overrides: { displayName?: string; canonicalDomain?: string } = {}) {
  return {
    id: 'project_citypoint',
    name: 'Citypoint Dental NYC',
    displayName: overrides.displayName ?? 'Locations',
    canonicalDomain: overrides.canonicalDomain ?? 'locations.example',
    ownedDomains: [],
    aliases: [],
    qualifiedAliases: [],
    country: 'US',
    language: 'en',
  }
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
    if (path.endsWith('/measurement-plan')) return jsonResponse(planResponse())
    if (path.endsWith('/measurement-plan/draft')) return jsonResponse({ draft: null, etag: null })
    if (PROJECT_READ.test(path)) return jsonResponse(projectRead())
    if (path.includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'other-queries') {
      return jsonResponse(otherQueriesResponse([]))
    }
    if (path.includes('/measurement-overview')) {
      return new URL(url).searchParams.get('queryClass') === 'branded'
        ? jsonResponse(branded)
        : jsonResponse(nonBrand)
    }
    if (path.includes('/measurement-property-evidence')) return jsonResponse(evidence)
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

describe('Property page in a read-only embed', () => {
  // The project subnav drops `portfolio` in every embed. A direct link to this
  // child route must agree for every host list: none and one naming `portfolio`
  // (the raw list admitted both), and the server default of `overview`.
  it.each<{ label: string; embed: { enabled: true; projectTabs?: string[] } }>([
    { label: 'no tab allowlist', embed: { enabled: true } },
    { label: 'the default overview allowlist', embed: { enabled: true, projectTabs: ['overview'] } },
    { label: 'an allowlist that names portfolio', embed: { enabled: true, projectTabs: ['overview', 'portfolio'] } },
  ])('renders the unavailable state and reads no measurement data with $label', async ({ embed }) => {
    const previousConfig = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { ...previousConfig, embed }
    onTestFinished(() => {
      if (previousConfig === undefined) delete window.__CANONRY_CONFIG__
      else window.__CANONRY_CONFIG__ = previousConfig
    })
    const fetched: string[] = []
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      fetched.push(pathOf(url))
      return propertyPageResponses()(url)
    })

    expect(await screen.findByText('This view is not available here.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to AI Visibility' }).getAttribute('href')).toBe(`/projects/${encodeURIComponent(projectName)}`)
    // The message is on the first render, so give any query that did start time
    // to reach the mocked fetch, then check the cache: the queries exist but never ran.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetched.filter(path => path.includes('/measurement-'))).toEqual([])
    const measurementQueries = queryClient.getQueryCache().findAll()
      .filter(query => JSON.stringify(query.queryKey).includes('Measurement'))
    expect(measurementQueries.length).toBeGreaterThan(0)
    expect(measurementQueries.map(query => [query.state.fetchStatus, query.state.dataUpdatedAt, query.state.errorUpdatedAt]))
      .toEqual(measurementQueries.map(() => ['idle', 0, 0]))
  })
})

describe('Property page', () => {
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
    expect(within(nonBrand).getByText('75.0%')).toBeTruthy()
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
    expect(within(branded).getAllByText('50.0%')).toHaveLength(2)
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
    expect(within(branded).getAllByText('50.0%')).toHaveLength(2)
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

    const link = await screen.findByRole('link', { name: 'Go to AI Visibility' })
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/\/projects\/[^/?]+\?queryClass=non-brand$/))
  })

  /** A Property this page must measure, beside AI Visibility's report for it. Settles every read before returning. */
  async function renderNeedsMeasurement(report: ReturnType<typeof lastResultsReport>, search = '') {
    const reports: URL[] = []
    const blank = { mentionCoverage: unavailable('no_completed_run'), citationCoverage: unavailable('no_completed_run') }
    const { queryClient } = await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/visibility-report')) {
        reports.push(new URL(url))
        return jsonResponse(report)
      }
      return propertyPageResponses({
        branded: overviewResponse('branded', blank),
        nonBrand: overviewResponse('non-brand', blank, { measurementState: 'not_measured', nextAction: 'run_measurement' }),
      })(url)
    }, { search })
    await waitFor(() => expect(reports).toHaveLength(1))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    return reports
  }

  it.each([
    { label: 'links to this Location\'s last results when AI Visibility still shows a sweep from before the change', measuredRevision: 6, empty: false, name: 'See the last results', scoped: true },
    { label: 'keeps the AI Visibility link when no sweep has measured this Location', measuredRevision: null, empty: false, name: 'Go to AI Visibility', scoped: false },
    { label: 'keeps the AI Visibility link when the last sweep asked this Location nothing of this type', measuredRevision: 6, empty: true, name: 'Go to AI Visibility', scoped: false },
  ])('$label', async ({ measuredRevision, empty, name, scoped }) => {
    const reports = await renderNeedsMeasurement(lastResultsReport(measuredRevision, empty))

    const link = screen.getByRole('link', { name })
    // The page asks the very report the scoped link opens.
    expect(Object.fromEntries(reports[0]!.searchParams)).toMatchObject({ scope: 'property', scopeKey: TARGET_KEY, queryClass: 'non-brand' })
    await waitFor(() => expect(new URL(link.getAttribute('href')!, window.location.origin).searchParams.get('queryClass')).toBe('non-brand'))
    const search = new URL(link.getAttribute('href')!, window.location.origin).searchParams
    expect([search.get('measurementScope'), search.get('measurementScopeKey')]).toEqual(scoped ? ['property', TARGET_KEY] : [null, null])
    // The admin instruction says why the link names results it cannot collect.
    const next = screen.getByRole('region', { name: 'Measurement next step' })
    expect(next.textContent?.includes('AI Visibility still shows the last results.')).toBe(scoped)
  })

  it('opens the latest last results, not the sweep, revision or end date the page was reached with', async () => {
    const reports = await renderNeedsMeasurement(lastResultsReport(6), '?queryClass=non-brand&measurementRunId=run-before-change&measurementRevision=6&measurementTo=2026-07-31T23%3A59%3A59.999Z')

    const link = screen.getByRole('link', { name: 'See the last results' })
    expect(['runId', 'revision', 'to'].filter(key => reports[0]!.searchParams.has(key))).toEqual([])
    const search = new URL(link.getAttribute('href')!, window.location.origin).searchParams
    expect(['measurementRunId', 'measurementRevision', 'measurementTo'].filter(key => search.has(key))).toEqual([])
    expect([search.get('measurementScope'), search.get('measurementScopeKey')]).toEqual(['property', TARGET_KEY])
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

    expect(within(gemini).getByText('50.0%')).toBeTruthy()
    expect(within(gemini).getByText('0%')).toBeTruthy()
    expect(within(openai).getAllByText('100%')).toHaveLength(2)
  })

  it('discloses the answers a mention rate left out wherever that rate is shown', async () => {
    // One mention plus nine answers that asked which property was meant. The
    // server measures 1 of 1 and says nine were left out; the page must say so.
    const partial = (numerator: number, denominator: number, unattributed: number): Metric =>
      ({ ...available(numerator, denominator), unattributed }) as Metric
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('identity_ambiguous'),
        citationCoverage: available(0, 4),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: partial(1, 1, 9),
        citationCoverage: available(0, 10),
        providers: [
          { provider: 'gemini', mentionCoverage: partial(1, 1, 4), citationCoverage: available(0, 5) },
          { provider: 'openai', mentionCoverage: unavailable('identity_ambiguous'), citationCoverage: available(0, 5) },
        ],
      }),
    })

    const line = '9 of 10 answers could not be tied to one property'
    const hero = await screen.findByRole('region', { name: 'Coverage for this Property' })
    const nonBrandMention = within(hero).getAllByText('Mentioned')[0]!.closest('.aeo-hero-row')!
    expect(within(nonBrandMention as HTMLElement).getByText('1 of 1')).toBeTruthy()
    expect(within(nonBrandMention as HTMLElement).getByText(line)).toBeTruthy()

    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this Property, split by query class' })
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!
    const [, mentioned, cited] = [...nonBrand.querySelectorAll('td')]
    expect([...mentioned!.querySelectorAll('span span')].map(node => node.textContent)).toEqual(['100%', '1 of 1', line])
    expect(cited!.textContent).not.toContain('could not be tied')
    // Every answer ambiguous: the reason is named instead of a bare "Not measured".
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    expect(within(branded).getByText('No answer could be tied to one property')).toBeTruthy()

    const providers = screen.getByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('gemini').closest('tr')!
    expect(within(gemini).getByText('4 of 5 answers could not be tied to one property')).toBeTruthy()
    const openai = within(providers).getByText('openai').closest('tr')!
    expect(within(openai).getByText('No answer could be tied to one property')).toBeTruthy()
  })

  it('discloses the answers a citation rate could not check wherever that rate is shown, and never under Mentioned', async () => {
    // Ten saved non-brand answers, two with incomplete source capture: the server
    // measures citation over the eight it could check and says two were left out.
    const unchecked = (numerator: number, denominator: number, count: number): Metric =>
      ({ ...available(numerator, denominator), unchecked: count }) as Metric
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(4, 4),
        citationCoverage: unavailable('evidence_incomplete'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(5, 10),
        citationCoverage: unchecked(2, 8, 2),
        providers: [
          { provider: 'gemini', mentionCoverage: available(2, 5), citationCoverage: unchecked(1, 3, 2) },
          { provider: 'openai', mentionCoverage: available(3, 5), citationCoverage: available(1, 5) },
        ],
      }),
    })

    const line = '2 of 10 answers had sources that could not be checked'
    const hero = await screen.findByRole('region', { name: 'Coverage for this Property' })
    const nonBrandCited = within(hero).getAllByText('Cited')[0]!.closest('.aeo-hero-row')!
    expect(nonBrandCited.querySelector('.aeo-hero-row-detail')!.textContent).toBe(`2 of 8${line}`)
    const nonBrandMentioned = within(hero).getAllByText('Mentioned')[0]!.closest('.aeo-hero-row')!
    expect(nonBrandMentioned.querySelector('.aeo-hero-row-detail')!.textContent).toBe('5 of 10')

    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this Property, split by query class' })
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!
    const [, mentioned, cited] = [...nonBrand.querySelectorAll('td')]
    expect([...cited!.querySelectorAll('span span')].map(node => node.textContent)).toEqual(['25.0%', '2 of 8', line])
    expect([...mentioned!.querySelectorAll('span span')].map(node => node.textContent)).toEqual(['50.0%', '5 of 10'])
    // Every branded answer unchecked: unavailable, with its reason and no count line.
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    expect(branded.querySelectorAll('td')[2]!.textContent).toBe('Not measuredSource evidence is incomplete')

    const providers = screen.getByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('gemini').closest('tr')!
    expect(gemini.querySelectorAll('td')[2]!.textContent).toBe('33.3%1 of 32 of 5 answers had sources that could not be checked')
    expect(gemini.querySelectorAll('td')[1]!.textContent).toBe('40.0%2 of 5')
    const openai = within(providers).getByText('openai').closest('tr')!
    expect(openai.querySelectorAll('td')[2]!.textContent).toBe('20.0%1 of 5')
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
    fireEvent.click(within(evidence).getByText(`${ANSWER_SOURCES_LABEL} (1)`, { selector: 'summary' }))
    expect(within(evidence).getByText('Matches this Property')).toBeTruthy()
    expect(within(evidence).getByText(OWN_URL)).toBeTruthy()
    expect(screen.queryByText(/revision \d+/i)).toBeNull()
    expect(screen.getByLabelText('Query type').className).toContain('h-11')
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

    expect(within(row).getByText('Mentioned', { selector: 'div' })).toBeTruthy()
    expect(within(row).getByText('Not cited')).toBeTruthy()
    expect(within(row).queryByText('Not mentioned')).toBeNull()
    expect(within(row).queryByText('Cited', { selector: 'div' })).toBeNull()
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

  it('keeps sources behind disclosure with this Property first and unsafe URLs inactive', async () => {
    const guideUrl = 'https://guide.example/harbour-stays'
    const siblingUrl = 'https://locations.example/lighthouse-house'
    const invalidUrl = 'javascript:alert(1)'
    const reviewUrl = 'https://reviews.example/harbour'
    const evidence = await renderAnswers([
      answerRow({
        slot: 'a',
        queryText: 'where to stay by the water',
        mentioned: true,
        sources: [
          externalSource(guideUrl), ownSource(),
          { ...externalSource(siblingUrl), classification: 'sibling', matchedTargetIds: ['lighthouse-house'] },
          { ...externalSource(invalidUrl), classification: 'invalid', normalizedUrl: null },
          externalSource(reviewUrl),
        ],
      }),
    ])

    expect(within(evidence).queryByText(OWN_URL)).toBeNull()
    const toggle = within(evidence).getByRole('button', { name: 'Read the answer for where to stay by the water' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    const summary = within(evidence).getByText(`${ANSWER_SOURCES_LABEL} (5)`, { selector: 'summary' })
    const disclosure = summary.closest('details')!
    expect(disclosure.open).toBe(false)
    fireEvent.click(summary)

    const sources = within(disclosure).getByRole('table')
    expect(within(sources).getAllByRole('row').slice(1).map(row => row.querySelector('td:last-child')!.textContent))
      .toEqual([OWN_URL, guideUrl, siblingUrl, invalidUrl, reviewUrl])
    expect(within(sources).getByText(EVIDENCE_LABELS.assigned.label)).toBeTruthy()
    expect(within(sources).getByText(EVIDENCE_LABELS.sibling.label)).toBeTruthy()
    expect(within(sources).getByText(EVIDENCE_LABELS.invalid.label)).toBeTruthy()
    expect(within(sources).getAllByText(EVIDENCE_LABELS.external.label)).toHaveLength(2)
    const links = within(sources).getAllByRole('link')
    expect(links.map(link => link.getAttribute('href'))).toEqual([OWN_URL, guideUrl, siblingUrl, reviewUrl])
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(within(sources).queryByRole('link', { name: invalidUrl })).toBeNull()
    fireEvent.click(summary)
    expect(disclosure.open).toBe(false)
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

    // The rate is never shown without the count it came from. The figure is
    // the shared one-decimal format with its percent sign set apart.
    expect(within(hero).getByText('20.0')).toBeTruthy()
    expect(within(hero).getByText('15.0')).toBeTruthy()
    expect(within(hero).getAllByText('100')).toHaveLength(2)
    expect(within(hero).getAllByText('%')).toHaveLength(4)
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

    // One destination, one control. Per-market buttons all resolved to this
    // same unscoped URL, so the market a reader picked was silently dropped.
    const links = within(market).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]!.textContent).toBe('Open measurement overview')
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
    const answer = screen.getByText(/Harborline Homes and The Sutton/)
    const sources = screen.getByText(`${ANSWER_SOURCES_LABEL} (1)`, { selector: 'summary' })
    expect(answer.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sources.closest('details')!.open).toBe(false)
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

// Two fictional queries repeat down almost every row, which exercises the
// production-shaped layout that collapses the Queries cell into a count.
const REPEATED_QUERY_A = 'best apartments in north district'
const REPEATED_QUERY_B = 'luxury apartments in north district'
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

it('formats the lazily loaded property answer', async () => {
  await renderPropertyPageFromApi(async url => {
    const response = propertyPageResponses()(url)
    return pathOf(url).includes('/measurement-question-result')
      ? jsonResponse({ ...await response.json(), answer: `## ${NEARBY_QUESTION}\n\n**${TARGET_KEY}**\n\n- ${OWN_URL}` })
      : response
  })
  const row = within(await answersTable()).getByText(NEARBY_QUESTION).closest('tr')!
  fireEvent.click(within(row).getByRole('button'))
  expect(await screen.findByRole('heading', { name: NEARBY_QUESTION, level: 4 })).toBeTruthy()
  expect(document.querySelector('.answer-markdown strong')?.textContent).toBe(TARGET_KEY)
  expect(document.querySelector('.answer-markdown li')?.textContent).toBe(OWN_URL)
})

const ADMIN: SignedInAccount = { name: 'ops', role: 'admin' }
const VIEWER: SignedInAccount = { name: 'reader', role: 'viewer' }

/** The draft target the server seeds from the published Harbor House target. */
function draftTarget(overrides: { aliases?: string[]; identityAliases?: string[] } = {}) {
  return {
    stableKey: TARGET_KEY,
    label: 'Harbor House',
    status: 'included' as const,
    aliases: overrides.aliases ?? ['Harbor House'],
    ...(overrides.identityAliases ? { identityAliases: overrides.identityAliases } : {}),
    urlMatchers: ['https://locations.example/harbor-house/*'],
    source: 'sitemap' as const,
    discoveryIdentity: 'sitemap:harbor-house',
  }
}

function draftResponse(target: ReturnType<typeof draftTarget>, options: { etag?: string; baseActiveRevision?: number } = {}) {
  const actor = { kind: 'user' as const, id: 'user-ops', label: 'ops' }
  return {
    draft: {
      id: 'draft-1',
      projectId: 'project_citypoint',
      schemaVersion: 2 as const,
      baseActiveVersionId: 'version-7',
      baseActiveRevision: options.baseActiveRevision ?? 7,
      authoring: { defaultContext: { providers: ['openai'], locations: [] }, targets: [target], assignments: [], groups: [] },
      createdBy: actor,
      updatedBy: actor,
      createdAt: '2026-08-03T12:00:00.000Z',
      updatedAt: '2026-08-03T12:00:00.000Z',
    },
    etag: options.etag ?? '"mpd_1"',
  }
}

const MUTATION_OK = { changed: true, warnings: [], counts: { targets: 1, includedTargets: 1, assignments: 0, unclassifiedAssignments: 0, groups: 0, competitors: 0 } }

interface RecordedWrite { path: string; headers: Record<string, string>; body: unknown }

type DraftAction = 'create' | 'upsert-target'

/**
 * A draft server in miniature: no draft until `create`, then one whose target
 * `upsert-target` replaces. Every write is recorded so a test can prove what
 * was sent, and that nothing was published. `replace` is another session's
 * write; `fail` answers one action with an API error instead.
 */
function draftServer(
  initial: ReturnType<typeof draftResponse> | null,
  options: { fail?: { action: DraftAction; status: number }; project?: ReturnType<typeof projectRead> } = {},
) {
  let current = initial
  const writes: RecordedWrite[] = []
  const handler = (url: string, init?: RequestInit) => {
    const path = pathOf(url)
    if (init?.method === 'POST') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      writes.push({ path, headers: (init.headers ?? {}) as Record<string, string>, body })
      if (options.fail && path.endsWith(`/draft/actions/${options.fail.action}`)) {
        return jsonResponse({ error: { code: 'SYNTHETIC_FAILURE', message: `Synthetic ${options.fail.status} from ${options.fail.action}` } }, options.fail.status)
      }
      if (path.endsWith('/draft/actions/create')) {
        current = draftResponse(draftTarget())
        return jsonResponse({ ...MUTATION_OK, etag: '"mpd_1"' })
      }
      if (path.endsWith('/draft/actions/upsert-target')) {
        const target = (body as { target: ReturnType<typeof draftTarget> }).target
        current = draftResponse(target, { etag: '"mpd_2"' })
        return jsonResponse({ ...MUTATION_OK, etag: '"mpd_2"' })
      }
      throw new Error(`Unexpected write: ${path}`)
    }
    if (path.endsWith('/measurement-plan/draft')) return jsonResponse(current ?? { draft: null, etag: null })
    if (options.project && PROJECT_READ.test(path)) return jsonResponse(options.project)
    return propertyPageResponses()(url)
  }
  const replace = (next: ReturnType<typeof draftResponse> | null) => { current = next }
  return { handler, writes, replace }
}

/** The app's own query client, so a failed save reaches the global error toast if it is not suppressed. */
function appQueryClient(): QueryClient {
  const client = createQueryClient()
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false } })
  return client
}

async function namesSection(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: PROPERTY_NAMES_COPY.heading })
}

/** Edit opens only once the draft and project reads have settled. */
async function openNamesEditor(section: HTMLElement) {
  const edit = within(section).getByRole('button', { name: PROPERTY_NAMES_COPY.edit }) as HTMLButtonElement
  await waitFor(() => expect(edit.disabled).toBe(false))
  fireEvent.click(edit)
}

function namesBox(section: HTMLElement): HTMLTextAreaElement {
  return within(section).getByRole('textbox', { name: PROPERTY_NAMES_COPY.names }) as HTMLTextAreaElement
}

function qualifiedBox(section: HTMLElement): HTMLTextAreaElement {
  return within(section).getByRole('textbox', { name: PROPERTY_NAMES_COPY.qualifiedNames }) as HTMLTextAreaElement
}

function saveNames(section: HTMLElement) {
  fireEvent.click(within(section).getByRole('button', { name: PROPERTY_NAMES_COPY.save }))
}

const withoutBrand = (index: number, value: string) => measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.withoutBrand, field: 'aliases', index, value })

describe('Names that count as this Property', () => {
  it('lists the published names read-only for a viewer and never reads the draft', async () => {
    const plan = planResponse()
    plan.active.plan.targets[0] = { ...plan.active.plan.targets[0]!, identityAliases: ['Harbor House Bayfront'] } as typeof plan.active.plan.targets[0]
    const paths: string[] = []
    await renderPropertyPageFromApi((url) => {
      paths.push(pathOf(url))
      return pathOf(url).endsWith('/measurement-plan') ? jsonResponse(plan) : propertyPageResponses()(url)
    }, { account: VIEWER })

    const section = await namesSection()
    expect(within(section).getByRole('heading', { name: PROPERTY_NAMES_COPY.names })).toBeTruthy()
    expect(within(section).getByText('Harbor House')).toBeTruthy()
    expect(within(section).getByText('Harbor House Bayfront')).toBeTruthy()
    expect(within(section).getByText('2 names')).toBeTruthy()
    expect(within(section).queryByRole('button', { name: PROPERTY_NAMES_COPY.edit })).toBeNull()
    expect(paths.some(path => path.endsWith('/measurement-plan/draft'))).toBe(false)
  })

  it('explains what counts the way the mention matcher reads an answer', async () => {
    await renderPropertyPageFromApi(propertyPageResponses(), { account: VIEWER })

    const section = await namesSection()
    expect(within(section).getByRole('button', { name: PROPERTY_NAMES_COPY.help })).toBeTruthy()
    expect(PROPERTY_NAMES_COPY.help).toContain('Source titles and source links never count, but a link in the answer whose text is one of these names does.')
    // A link written into the sentence keeps its text as prose; a source link
    // in parentheses is dropped whatever its text says.
    expect(answerProseForMentions('Try [Harbor House](https://locations.example/harbor-house) today.')).toContain('Harbor House')
    expect(answerProseForMentions('Try it ([Harbor House](https://locations.example/harbor-house)).')).not.toContain('Harbor House')
  })

  it('warns inline as an admin types, then saves into a new draft without publishing', async () => {
    const server = draftServer(null)
    const { projectName } = await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    await openNamesEditor(section)
    const names = namesBox(section)
    const qualified = qualifiedBox(section)
    expect(names.value).toBe('Harbor House')
    expect(qualified.value).toBe('')
    // The project's brand name is "Locations", which "Harbor House" lacks.
    const brandless = withoutBrand(0, 'Harbor House')
    expect(within(section).getByText(brandless)).toBeTruthy()

    fireEvent.change(names, { target: { value: 'Locations Harbor House\nHH\n' } })
    fireEvent.change(qualified, { target: { value: 'Harbor District' } })
    expect(within(section).queryByText(brandless)).toBeNull()
    expect(within(section).getByText(measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.short, field: 'aliases', index: 1, value: 'HH' }))).toBeTruthy()
    expect(within(section).getByText(measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index: 0, value: 'Harbor District' }))).toBeTruthy()
    expect(within(section).getByText(PROPERTY_NAMES_COPY.qualifiedNote)).toBeTruthy()
    expect(within(section).getByText(PROPERTY_NAMES_COPY.draftOnly)).toBeTruthy()

    fireEvent.change(qualified, { target: { value: 'Locations Harbor House Bayfront' } })
    saveNames(section)

    expect(await within(section).findByText(PROPERTY_NAMES_COPY.saved, { exact: false })).toBeTruthy()
    expect(within(section).getByRole('link', { name: PROPERTY_NAMES_COPY.review }).getAttribute('href'))
      .toBe(`/projects/${encodeURIComponent(projectName)}/portfolio`)
    // Create a draft against the published revision, then replace this
    // Property's names in it under the draft's ETag. Nothing else is written.
    expect(server.writes.map(write => write.path.split('/').at(-1))).toEqual(['create', 'upsert-target'])
    expect(server.writes[0]!.body).toEqual({ expectedActiveRevision: 7 })
    expect(server.writes[1]!.headers['if-match']).toBe('"mpd_1"')
    expect(server.writes[1]!.body).toEqual({
      target: { ...draftTarget(), aliases: ['Locations Harbor House', 'HH'], identityAliases: ['Locations Harbor House Bayfront'] },
    })
    expect(server.writes.some(write => write.path.includes('publish'))).toBe(false)
  })

  it('drops unsaved names when it moves to another Property, so a save never writes them there', async () => {
    // Two Properties with no names look identical to the save check, so an
    // editor that kept the first one's text would write it onto the second.
    const server = draftServer(null)
    const restoreFetch = mockFetch((url, init) => server.handler(url, init))
    onTestFinished(restoreFetch)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const editor = (targetKey: string) => (
      <QueryClientProvider client={queryClient}>
        <AccountProvider account={ADMIN}>
          <PropertyNamesSection projectName="Citypoint Dental NYC" targetKey={targetKey} published={{ aliases: [] }} activeRevision={7} publishedBrandNames={['Locations']} />
        </AccountProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(editor('harbor-house'))

    const first = await namesSection()
    await openNamesEditor(first)
    fireEvent.change(namesBox(first), { target: { value: 'Locations Harbor House' } })

    rerender(editor('bayfront-suites'))
    const second = await namesSection()
    expect(within(second).queryByRole('textbox', { name: PROPERTY_NAMES_COPY.names })).toBeNull()
    await openNamesEditor(second)
    expect(namesBox(second).value).toBe('')
    saveNames(second)

    expect(await within(second).findByText(PROPERTY_NAMES_COPY.noChanges)).toBeTruthy()
    expect(server.writes).toEqual([])
  })

  it('starts no draft when a save changes nothing', async () => {
    // An open draft moves every Property's next step to finishing setup, so a
    // save with nothing to change must leave the project with no draft.
    const server = draftServer(null)
    await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    await openNamesEditor(section)
    saveNames(section)

    expect(await within(section).findByText(PROPERTY_NAMES_COPY.noChanges)).toBeTruthy()
    expect(server.writes).toEqual([])
    expect(within(section).queryByText(PROPERTY_NAMES_COPY.pending, { exact: false })).toBeNull()
  })

  it('flags names saved in the draft but not published, and edits from the draft', async () => {
    const pending = draftTarget({ aliases: ['Locations Harbor House'], identityAliases: ['Locations Harbor House Bayfront'] })
    const server = draftServer(draftResponse(pending))
    await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    expect(await within(section).findByText(PROPERTY_NAMES_COPY.pending, { exact: false })).toBeTruthy()
    // The list still shows what is published, because that is what is measured.
    expect(within(section).getByText('Harbor House')).toBeTruthy()
    await openNamesEditor(section)
    expect(namesBox(section).value).toBe('Locations Harbor House')
    expect(qualifiedBox(section).value).toBe('Locations Harbor House Bayfront')

    // Saving what the draft already holds writes nothing.
    saveNames(section)
    expect(await within(section).findByText(PROPERTY_NAMES_COPY.noChanges)).toBeTruthy()
    expect(server.writes).toEqual([])

    // Clearing every qualified name drops the field rather than storing an empty list.
    await openNamesEditor(section)
    fireEvent.change(qualifiedBox(section), { target: { value: '\n' } })
    saveNames(section)
    expect(await within(section).findByText(PROPERTY_NAMES_COPY.saved, { exact: false })).toBeTruthy()
    expect(server.writes.map(write => write.body)).toEqual([{ target: draftTarget({ aliases: ['Locations Harbor House'] }) }])
    expect(server.writes[0]!.body).not.toHaveProperty('target.identityAliases')
  })

  it('waits for the draft read before opening, so it never edits from the published names under a pending draft', async () => {
    let releaseDraft!: () => void
    const draftRead = new Promise<void>(resolve => { releaseDraft = resolve })
    const server = draftServer(draftResponse(draftTarget({ aliases: ['Locations Harbor House'] })))
    await renderPropertyPageFromApi(async (url, init) => {
      if (init?.method !== 'POST' && pathOf(url).endsWith('/measurement-plan/draft')) await draftRead
      return server.handler(url, init)
    }, { account: ADMIN })

    const section = await namesSection()
    const edit = within(section).getByRole('button', { name: PROPERTY_NAMES_COPY.edit }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    fireEvent.click(edit)
    expect(within(section).queryByRole('textbox', { name: PROPERTY_NAMES_COPY.names })).toBeNull()

    releaseDraft()
    await openNamesEditor(section)
    expect(namesBox(section).value).toBe('Locations Harbor House')
  })

  it('keeps names another session saved while the editor was open', async () => {
    resetToasts()
    const server = draftServer(draftResponse(draftTarget({ aliases: ['Locations Harbor House'] })))
    await renderPropertyPageFromApi(server.handler, { account: ADMIN, queryClient: appQueryClient() })

    const section = await namesSection()
    await openNamesEditor(section)
    expect(namesBox(section).value).toBe('Locations Harbor House')

    // Another admin, or an agent through the draft API, adds a name meanwhile.
    server.replace(draftResponse(draftTarget({ aliases: ['Locations Harbor House', 'Locations Harbor Tower'] }), { etag: '"mpd_3"' }))
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House\nLocations Harbor House Larkfield' } })
    saveNames(section)

    expect((await within(section).findByRole('alert')).textContent).toContain(PROPERTY_NAMES_COPY.conflict)
    expect(server.writes).toEqual([])
    expect(namesBox(section).value).toBe('Locations Harbor House\nLocations Harbor Tower')
    expect(getToasts()).toEqual([])

    // Saving again builds on the names now in the draft, under its current ETag.
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House\nLocations Harbor Tower\nLocations Harbor House Larkfield' } })
    saveNames(section)
    expect(await within(section).findByText(PROPERTY_NAMES_COPY.saved, { exact: false })).toBeTruthy()
    expect(server.writes).toHaveLength(1)
    expect(server.writes[0]!.headers['if-match']).toBe('"mpd_3"')
    expect(server.writes[0]!.body).toEqual({
      target: draftTarget({ aliases: ['Locations Harbor House', 'Locations Harbor Tower', 'Locations Harbor House Larkfield'] }),
    })
  })

  it('shows a refused save once, inline, with no toast', async () => {
    resetToasts()
    const server = draftServer(draftResponse(draftTarget({ aliases: ['Locations Harbor House'] })), { fail: { action: 'upsert-target', status: 412 } })
    await renderPropertyPageFromApi(server.handler, { account: ADMIN, queryClient: appQueryClient() })

    const section = await namesSection()
    await openNamesEditor(section)
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House\nLocations Harbor House Larkfield' } })
    saveNames(section)

    expect((await within(section).findByRole('alert')).textContent).toContain(PROPERTY_NAMES_COPY.conflict)
    await waitFor(() => expect(namesBox(section).value).toBe('Locations Harbor House'))
    expect(within(section).getAllByRole('alert')).toHaveLength(1)
    expect(getToasts()).toEqual([])
  })

  it('shows a failed save once, inline, with no toast', async () => {
    resetToasts()
    const server = draftServer(null, { fail: { action: 'create', status: 500 } })
    await renderPropertyPageFromApi(server.handler, { account: ADMIN, queryClient: appQueryClient() })

    const section = await namesSection()
    await openNamesEditor(section)
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House' } })
    saveNames(section)

    expect((await within(section).findByRole('alert')).textContent).toBe(PROPERTY_NAMES_COPY.failed)
    expect(server.writes.map(write => write.path.split('/').at(-1))).toEqual(['create'])
    expect(getToasts()).toEqual([])
  })

  it('checks names against the project brand names the draft API uses, not the published ones', async () => {
    // The project was renamed after the last publish: the plan still says
    // "Locations", while the draft API and the next publish read "Newco".
    const server = draftServer(null, { project: projectRead({ displayName: 'Newco', canonicalDomain: 'newco.example' }) })
    await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    await openNamesEditor(section)
    fireEvent.change(namesBox(section), { target: { value: 'Newco Harbor House\nLocations Harbor House' } })

    expect(within(section).queryByText(withoutBrand(0, 'Newco Harbor House'))).toBeNull()
    expect(within(section).getByText(withoutBrand(1, 'Locations Harbor House'))).toBeTruthy()
  })

  it('refuses to write into a draft started from an older published setup', async () => {
    const server = draftServer(draftResponse(draftTarget(), { baseActiveRevision: 6 }))
    await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    await openNamesEditor(section)
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House' } })
    saveNames(section)

    expect((await within(section).findByRole('alert')).textContent).toContain(PROPERTY_NAMES_COPY.staleDraft)
    expect(server.writes).toEqual([])
  })
})

describe('Cited on other queries', () => {
  const OTHER_KEY = 'marina-point'

  function otherRow(overrides: Partial<OtherQueryRow> & { queryText: string }): OtherQueryRow {
    return {
      observationId: `obs-${overrides.queryText}`,
      expectedSlotId: `slot-${overrides.queryText}`,
      executionId: `exec-${overrides.queryText}`,
      provider: 'gemini',
      location: null,
      queryClass: 'non-brand',
      assignedTargetKeys: [OTHER_KEY],
      sources: [{ sourceUrl: `${OWN_URL}/amenities`, normalizedUrl: `${OWN_URL}/amenities`, matchedUrlIds: [`${TARGET_KEY}:url:0`] }],
      sourceCount: 1,
      sourcesTruncated: false,
      evidenceComplete: true,
      ...overrides,
    }
  }

  function planWithMarina() {
    const plan = planResponse()
    plan.active.plan.targets.push({
      stableKey: OTHER_KEY,
      label: 'Marina Point',
      aliases: ['Marina Point'],
      urlMatchers: [{ kind: 'prefix' as const, host: 'locations.example', pathPrefix: '/marina-point', pathCase: 'insensitive' as const }],
      mentionNotApplicable: false,
      discoveryIdentity: 'sitemap:marina-point',
    })
    return plan
  }

  it('lists citations of this Property’s pages from queries assigned elsewhere, apart from its rates', async () => {
    const requests: URL[] = []
    const rows = [
      otherRow({ queryText: 'quiet stays by the marina' }),
      otherRow({ queryText: 'family hotels near the pier', provider: 'openai', evidenceComplete: false }),
    ]
    const { projectName } = await renderPropertyPageFromApi(url => {
      const request = new URL(url)
      const path = pathOf(url)
      if (path.endsWith('/measurement-plan')) return jsonResponse(planWithMarina())
      if (path.includes('/measurement-property-evidence') && request.searchParams.get('shape') === 'other-queries') {
        requests.push(request)
        return jsonResponse(otherQueriesResponse(rows))
      }
      if (path.includes('/measurement-question-result')) {
        requests.push(request)
        return jsonResponse({
          property: { targetKey: OTHER_KEY, label: 'Marina Point' },
          measurement: { state: 'complete', displayedRunId: RUN_ID, planRevision: 7, completedAt: '2026-08-02T12:05:00.000Z' },
          question: {
            resultId: 'obs-quiet stays by the marina', queryId: 'query-marina', text: 'quiet stays by the marina', class: 'non-brand',
            provider: 'gemini', requestedModel: null, servedModel: null, location: null, status: 'answered',
          },
          mentioned: true, cited: false, recommendedInstead: [],
          answer: 'Marina Point is quiet, and Harbor House next door has a pool.',
          sources: [], captureStatus: 'complete', retrievalStatus: 'used', retrievalContract: 'native-auto-v1',
        })
      }
      return propertyPageResponses()(url)
    })

    const section = await screen.findByRole('region', { name: OTHER_QUERIES_COPY.heading })
    expect(await within(section).findByText(`2 answers · non-brand queries · ${OTHER_QUERIES_COPY.notCounted}`)).toBeTruthy()
    const evidence = requests.find(request => request.pathname.includes('/measurement-property-evidence'))!
    expect(Object.fromEntries(evidence.searchParams)).toMatchObject({ targetKey: TARGET_KEY, queryClass: 'non-brand', shape: 'other-queries', runId: RUN_ID })

    const table = within(section).getByRole('table')
    const quiet = within(table).getByText('quiet stays by the marina').closest('tr')!
    // Who the query was asked for links to that Property's own page, on the same class.
    expect(within(quiet).getByRole('link', { name: 'Marina Point' }).getAttribute('href'))
      .toBe(`/projects/${encodeURIComponent(projectName)}/properties/${OTHER_KEY}?queryClass=non-brand`)
    expect(within(quiet).getByText(`${OWN_URL}/amenities`, { exact: false })).toBeTruthy()
    expect(within(quiet).queryByText(OTHER_QUERIES_COPY.partlySaved)).toBeNull()
    const pier = within(table).getByText('family hotels near the pier').closest('tr')!
    expect(within(pier).getByText(OTHER_QUERIES_COPY.partlySaved)).toBeTruthy()

    // The answer belongs to the Property it was asked for, so it is read through that one.
    fireEvent.click(within(quiet).getByRole('button', { name: 'Read the answer for quiet stays by the marina' }))
    expect(await within(section).findByText(/Harbor House next door has a pool/)).toBeTruthy()
    const answer = requests.find(request => request.pathname.includes('/measurement-question-result'))!
    expect(Object.fromEntries(answer.searchParams)).toEqual({ targetKey: OTHER_KEY, resultId: 'obs-quiet stays by the marina' })

    // The rates above still read only this Property's own queries.
    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this Property, split by query class' })
    expect(within(within(contrast).getByText('When they don\'t').closest('tr')!).getByText('50.0%')).toBeTruthy()
  })

  it('reads the class the page shows, and says so when nothing was cited elsewhere', async () => {
    const classes: (string | null)[] = []
    await renderPropertyPageFromApi(url => {
      const request = new URL(url)
      if (pathOf(url).includes('/measurement-property-evidence') && request.searchParams.get('shape') === 'other-queries') {
        classes.push(request.searchParams.get('queryClass'))
        return jsonResponse(otherQueriesResponse([], 'branded'))
      }
      return propertyPageResponses()(url)
    }, { search: '?queryClass=branded' })

    const section = await screen.findByRole('region', { name: OTHER_QUERIES_COPY.heading })
    expect(await within(section).findByText(OTHER_QUERIES_COPY.empty)).toBeTruthy()
    expect(within(section).getByText(`0 answers · branded queries · ${OTHER_QUERIES_COPY.notCounted}`)).toBeTruthy()
    expect(classes).toEqual(['branded'])
  })
})

describe('Add query about this location', () => {
  const ADD_QUERY = 'Add query about this location'
  const NO_WORKSPACE = 'Could not load tracked queries. Try again.'
  // The server files a query by its text: one that names the location it is
  // added to is Branded for that location, any other is Non-brand
  // (`proposeQueryClassForTarget`). The fixtures give each text its real class.
  const MARKET_QUERY = { text: 'quiet hotels with a harbor view', queryClass: 'non-brand' as const }
  const NAMED_QUERY = { text: 'is Harbor House a good place to stay', queryClass: 'branded' as const }
  const WORKSPACE_VERSION = `qtw_${'a'.repeat(64)}`
  const PREVIEW_TOKEN = `qtp_${'b'.repeat(64)}`
  const REVIEWED_AT = '2026-08-03T12:15:00.000Z'
  const ACTIVE = { revision: 7, compiledChecksum: 'b'.repeat(64) }
  const NEARBY_EDGE = { executionNodeKey: 'node-nearby', targetKey: TARGET_KEY, queryId: 'query-nearby' }
  const workload = { existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 2, nextSweepProviderCalls: 2, addedNodes: 1, addedProviderCalls: 1, removedNodes: 0, removedProviderCalls: 0 }
  const OTHER_LOCATION = { id: 'other-house', label: 'Other House', kind: 'property', targetCount: 1 }

  /** Harbor House has a query in one market, North coast, which sits in the North group. */
  function trackingWorkspace(overrides: { markets?: unknown[]; scopeOptions?: unknown[] } = {}) {
    return queryTrackingWorkspaceResponseSchema.parse({
      mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, active: ACTIVE,
      defaultContexts: [{ providers: ['openai'], models: {}, location: null }],
      targets: [{ stableKey: TARGET_KEY, label: 'Harbor House' }],
      groups: [{ stableKey: 'north', label: 'North', targetKeys: [TARGET_KEY] }],
      markets: [{ stableKey: 'north-coast', label: 'North coast', groupKey: 'north', usageEdges: [NEARBY_EDGE] }],
      scopeOptions: [
        { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
        { id: 'north', label: 'North', kind: 'group', targetCount: 1 },
        { id: 'north-coast', label: 'North coast', kind: 'market', targetCount: 1, parentGroupIds: ['north'] },
        { id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'] },
      ],
      tracked: [],
      savedSources: { research: [], discovery: [] },
      ...overrides,
    })
  }

  /** The plan the server publishes for the commit: the new query assigned to Harbor House, in the class its text gets. */
  function planAfterPublish(query: typeof MARKET_QUERY | typeof NAMED_QUERY) {
    const { active } = planResponse()
    return {
      active: {
        ...active,
        revision: 8,
        plan: {
          ...active.plan,
          querySnapshots: [...active.plan.querySnapshots, { queryId: 'query-new', queryText: query.text, provenance: { source: 'manual' as const, sourceId: null, capturedAt: REVIEWED_AT } }],
          assignments: [...active.plan.assignments, { targetKey: TARGET_KEY, queryId: 'query-new', queryClass: query.queryClass, executionNodeKey: 'node-new' }],
        },
      },
    }
  }

  /** The page's own reads plus the tracking API, with every request path and every review or publish recorded. */
  async function renderWithTracking(options: {
    account?: SignedInAccount
    workspace?: () => Response | Promise<Response>
    plan?: () => ReturnType<typeof planResponse>
    publishes?: typeof MARKET_QUERY | typeof NAMED_QUERY
  } = {}) {
    const paths: string[] = []
    const writes: Array<{ operation: string; body: unknown }> = []
    const publishes = options.publishes ?? MARKET_QUERY
    const diff = { added: [{ queryId: 'query-new', queryText: publishes.text, assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false }
    let published = false
    const page = propertyPageResponses()
    const rendered = await renderPropertyPageFromApi((url, init) => {
      const path = pathOf(url)
      paths.push(path)
      if (path.endsWith('/query-tracking')) return options.workspace?.() ?? jsonResponse(trackingWorkspace())
      const operation = path.match(/\/query-tracking\/(preview|commit)$/)?.[1]
      if (operation) {
        writes.push({ operation, body: JSON.parse(String(init?.body)) })
        if (operation === 'preview') {
          return jsonResponse(queryTrackingPreviewResponseSchema.parse({ mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, previewToken: PREVIEW_TOKEN, reviewedAt: REVIEWED_AT, active: ACTIVE, tracked: [], diff, workload }))
        }
        published = true
        return jsonResponse(queryTrackingCommitResponseSchema.parse({ committed: true, mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, reviewedAt: REVIEWED_AT, active: { ...ACTIVE, revision: 8 }, diff, workload }))
      }
      if (path.endsWith('/measurement-plan')) return jsonResponse(published ? planAfterPublish(publishes) : options.plan?.() ?? planResponse())
      return page(url)
    }, { account: options.account ?? ADMIN })
    const section = await screen.findByRole('region', { name: /assigned to this Property/ })
    await within(section).findByRole('table', { name: 'Queries assigned to this Property' })
    const reads = (suffix: string) => paths.filter(path => path.endsWith(suffix)).length
    return { ...rendered, section, writes, workspaceReads: () => reads('/query-tracking'), planReads: () => reads('/measurement-plan') }
  }

  // A real click focuses the button; `fireEvent.click` does not.
  async function openSheet(section: HTMLElement) {
    const button = within(section).getByRole('button', { name: ADD_QUERY })
    button.focus()
    fireEvent.click(button)
    return within(await screen.findByRole('dialog', { name: 'Add queries' }))
  }

  /** Type one query in the open sheet, review it and publish. Resolves once the sheet has closed. */
  async function publish(sheet: Awaited<ReturnType<typeof openSheet>>, text: string) {
    fireEvent.change(sheet.getByLabelText('Queries'), { target: { value: text } })
    fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
    await sheet.findByRole('heading', { name: 'Review 1 change' })
    fireEvent.click(sheet.getByRole('button', { name: 'Publish 1 change' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  it('reads no tracking workspace until a writer opens the sheet, then starts on this location', async () => {
    const { section, workspaceReads } = await renderWithTracking()
    const button = within(section).getByRole('button', { name: ADD_QUERY }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    // Give a read that did start time to reach the mocked fetch.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(workspaceReads()).toBe(0)

    const sheet = await openSheet(section)
    expect(sheet.getByRole('radio', { name: 'Location' }).getAttribute('aria-checked')).toBe('true')
    expect(sheet.getByText('Harbor House · Location')).toBeTruthy()
    // One line names the markets; how the query is asked is the help right after it.
    const countsIn = sheet.getByText('Counts in: North coast')
    expect(within(countsIn.nextElementSibling as HTMLElement).getByRole('button', { name: "Asked with these markets' engines and search locations." })).toBeTruthy()
    expect(sheet.queryByText(/^Engines and search locations come from/)).toBeNull()
    // This page has no Add query form to hand off to.
    expect(sheet.queryByRole('button', { name: 'Hand-picked locations, templates or saved research' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Add queries' }).textContent).not.toMatch(/propert|—/i)
    // The press read the workspace once, and opening the sheet does not read it again.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(workspaceReads()).toBe(1)

    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('says it is opening while the tracking workspace is read', async () => {
    let respond: (response: Response) => void = () => {}
    const { section } = await renderWithTracking({ workspace: () => new Promise<Response>(resolve => { respond = resolve }) })
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))

    expect((await within(section).findByRole('button', { name: 'Opening…' })).textContent).toBe('Opening…')
    expect(within(section).queryByRole('button', { name: ADD_QUERY })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    respond(jsonResponse(trackingWorkspace()))
    expect(await screen.findByRole('dialog', { name: 'Add queries' })).toBeTruthy()
    // The open sheet hides the page behind it from assistive tech.
    expect(within(section).getByRole('button', { name: ADD_QUERY, hidden: true })).toBeTruthy()
  })

  it('keeps saying it is opening while offline, and opens once the read can run', async () => {
    const { section, workspaceReads } = await renderWithTracking()
    onlineManager.setOnline(false)
    onTestFinished(() => onlineManager.setOnline(true))
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))

    expect(await within(section).findByRole('button', { name: 'Opening…' })).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(workspaceReads()).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()

    onlineManager.setOnline(true)
    expect(await screen.findByRole('dialog', { name: 'Add queries' })).toBeTruthy()
    expect(workspaceReads()).toBe(1)
  })

  it('shows a viewer no button and reads no tracking workspace', async () => {
    const { section, workspaceReads } = await renderWithTracking({ account: VIEWER })

    expect(within(section).getByText('1 assigned')).toBeTruthy()
    expect(screen.queryByRole('button', { name: ADD_QUERY })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(workspaceReads()).toBe(0)
  })

  it('publishes each line for this location in its markets, closes, and lists the new query', async () => {
    onTestFinished(resetToasts)
    const { section, writes } = await renderWithTracking({ publishes: MARKET_QUERY })
    const sheet = await openSheet(section)
    fireEvent.change(sheet.getByLabelText('Queries'), { target: { value: MARKET_QUERY.text } })
    fireEvent.click(sheet.getByRole('button', { name: 'Review' }))

    await sheet.findByRole('heading', { name: 'Review 1 change' })
    // Type stays on Automatic, so the server classes the query: no `queryClass` is sent.
    const mutation = {
      additions: [{ input: { source: 'manual', text: MARKET_QUERY.text }, audience: { targetKeys: [TARGET_KEY], marketKeys: ['north-coast'] } }],
      removals: [],
    }
    expect(writes).toEqual([{ operation: 'preview', body: { ...mutation, expectedWorkspaceVersion: WORKSPACE_VERSION } }])
    expect(queryTrackingPreviewRequestSchema.safeParse(writes[0]!.body).success).toBe(true)
    // Nothing is published until Publish, so the list is still the one the page loaded with.
    expect(within(section).queryByText(MARKET_QUERY.text)).toBeNull()

    fireEvent.click(sheet.getByRole('button', { name: 'Publish 1 change' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes[1]).toEqual({ operation: 'commit', body: { ...mutation, expectedWorkspaceVersion: WORKSPACE_VERSION, previewToken: PREVIEW_TOKEN, reviewedAt: REVIEWED_AT } })
    const questions = within(section).getByRole('table', { name: 'Queries assigned to this Property' })
    expect(await within(questions).findByText(MARKET_QUERY.text)).toBeTruthy()
    expect(within(questions).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(within(section).getByText('2 assigned')).toBeTruthy()
    // It is in the list the page shows, so there is nothing to point to.
    expect(within(section).queryByRole('status')).toBeNull()
    await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual(['Tracked queries updated']))
  })

  it('says where a query that names this location went, and shows it on request', async () => {
    onTestFinished(resetToasts)
    const { section, writes } = await renderWithTracking({ publishes: NAMED_QUERY })
    expect(within(section).getByRole('heading', { name: 'Non-brand queries assigned to this Property' })).toBeTruthy()
    await publish(await openSheet(section), NAMED_QUERY.text)

    // The sheet never sends a class of its own, which would file this query as Non-brand.
    expect(writes[1]!.body).toMatchObject({ additions: [{ input: { source: 'manual', text: NAMED_QUERY.text }, audience: { targetKeys: [TARGET_KEY], marketKeys: ['north-coast'] } }] })
    expect(JSON.stringify(writes.map(write => write.body))).not.toContain('queryClass')
    // The server filed it as Branded, so the Non-brand list is unchanged and says where it is.
    expect((await within(section).findByRole('status')).textContent).toBe('1 query you added is listed under Branded queries.')
    expect(within(section).getByRole('heading', { name: 'Non-brand queries assigned to this Property' })).toBeTruthy()
    expect(within(section).queryByText(NAMED_QUERY.text)).toBeNull()
    expect(within(section).getByText('1 assigned')).toBeTruthy()

    fireEvent.click(within(section).getByRole('button', { name: 'Show branded queries' }))
    expect(await within(section).findByRole('heading', { name: 'Branded queries assigned to this Property' })).toBeTruthy()
    const questions = within(section).getByRole('table', { name: 'Queries assigned to this Property' })
    expect(within(questions).getByText(NAMED_QUERY.text)).toBeTruthy()
    expect(within(questions).queryByText(NEARBY_QUESTION)).toBeNull()
    expect(within(section).getByText('1 assigned')).toBeTruthy()
    expect((screen.getByLabelText('Query type') as HTMLSelectElement).value).toBe('branded')
    // The query is in view now, so the line is gone.
    expect(within(section).queryByRole('status')).toBeNull()
  })

  it('says when the tracking workspace cannot be read, and reads it again on the next press', async () => {
    let failing = true
    const { section, workspaceReads } = await renderWithTracking({
      workspace: () => failing ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500) : jsonResponse(trackingWorkspace()),
    })
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))

    expect((await within(section).findByRole('alert')).textContent).toBe(NO_WORKSPACE)
    expect(screen.queryByRole('dialog')).toBeNull()
    failing = false
    const sheet = await openSheet(section)
    expect(sheet.getByText('Harbor House · Location')).toBeTruthy()
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(workspaceReads()).toBe(2)
  })

  it('opens nothing when the cache is refreshed after a failed read, only on a press', async () => {
    let failing = true
    const { section, workspaceReads, queryClient } = await renderWithTracking({
      workspace: () => failing ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500) : jsonResponse(trackingWorkspace()),
    })
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))
    expect((await within(section).findByRole('alert')).textContent).toBe(NO_WORKSPACE)

    // What every successful project write does: refresh the project's reads.
    failing = false
    await queryClient.invalidateQueries()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workspaceReads()).toBe(1)
    expect(within(section).getByRole('alert').textContent).toBe(NO_WORKSPACE)

    await openSheet(section)
    expect(workspaceReads()).toBe(2)
  })

  it('opens no sheet when the tracking workspace does not hold this location, and reads the setup again', async () => {
    const { section, planReads } = await renderWithTracking({
      workspace: () => jsonResponse(trackingWorkspace({ scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }, OTHER_LOCATION] })),
    })
    const planReadsBefore = planReads()
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))

    expect((await within(section).findByRole('alert')).textContent).toBe('This location was not found in tracked queries. Try again.')
    await waitFor(() => expect(planReads()).toBe(planReadsBefore + 1))
    // Another location is never offered in this one's place.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(section).getByRole('button', { name: ADD_QUERY })).toBeTruthy()
  })

  it('points to no Add query form when the project has no markets', async () => {
    const { section } = await renderWithTracking({
      workspace: () => jsonResponse(trackingWorkspace({ markets: [], scopeOptions: [{ id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1 }] })),
    })
    const sheet = await openSheet(section)
    fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))

    expect(sheet.getByText(/no markets/).textContent).toBe('This project has no markets yet.')
  })

  it('carries a failed read to no other location the page moves to', async () => {
    const twoLocations = () => {
      const plan = planResponse()
      plan.active.plan.targets.push({ ...plan.active.plan.targets[0]!, stableKey: OTHER_LOCATION.id, label: OTHER_LOCATION.label, aliases: [OTHER_LOCATION.label] })
      return plan
    }
    const { section, router, projectName } = await renderWithTracking({
      plan: twoLocations,
      workspace: () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500),
    })
    fireEvent.click(within(section).getByRole('button', { name: ADD_QUERY }))
    expect((await within(section).findByRole('alert')).textContent).toBe(NO_WORKSPACE)

    await act(async () => { await router.navigate({ to: '/projects/$projectName/properties/$targetKey', params: { projectName, targetKey: OTHER_LOCATION.id } }) })
    expect(await screen.findByRole('heading', { name: OTHER_LOCATION.label, level: 1 })).toBeTruthy()
    const moved = screen.getByRole('region', { name: /assigned to this Property/ })
    expect(within(moved).getByRole('button', { name: ADD_QUERY })).toBeTruthy()
    expect(within(moved).queryByRole('alert')).toBeNull()
  })

  it.each([
    { state: 'setup is not advanced', plan: legacyPlanResponse, link: 'Republish setup' },
    { state: 'setup does not hold this location', plan: () => { const plan = planResponse(); plan.active.plan.targets = []; return plan }, link: 'Open measurement setup' },
  ])('offers no button when $state', async ({ plan, link }) => {
    await renderPropertyPageFromApi(url => pathOf(url).endsWith('/measurement-plan') ? jsonResponse(plan()) : propertyPageResponses()(url), { account: ADMIN })

    expect(await screen.findByRole('link', { name: link })).toBeTruthy()
    expect(screen.queryByRole('button', { name: ADD_QUERY })).toBeNull()
  })
})
