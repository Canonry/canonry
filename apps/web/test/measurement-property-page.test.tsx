import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import { EVIDENCE_LABELS, OTHER_QUERIES_COPY } from '../src/pages/MeasurementPropertyPage.js'
import { nameIssueDetail, PROPERTY_NAMES_COPY, PropertyNamesSection } from '../src/components/project/advanced-measurement/PropertyNamesEditor.js'
import { AccountProvider, type SignedInAccount } from '../src/contexts/account-context.js'
import {
  answerProseForMentions,
  MeasurementTargetNameIssueCodes,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingResultsResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  RunKinds,
} from '@ainyc/canonry-contracts'
import { createQueryClient } from '../src/queries/query-client.js'
import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'
import { formatMonthDay } from '../src/lib/format-helpers.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { ANSWER_SOURCES_LABEL } from '../src/components/shared/AnswerMarkdown.js'
import { formatObservedInstantLabel, formatObservedInstantMonthDay, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { MANAGED_SWEEPS_COPY } from '../src/components/project/ManagedSweepStatus.js'
import {
  getApiV1ProjectsByNameMeasurementOverviewQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'
import { expectCautionNote, expectCautionNoteOnOneLine, visibleText } from './caution-note.js'
import { compileAppStyles, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'

const TARGET_KEY = 'harbor-house'
const RUN_ID = 'run-synthetic'
/** When every overview fixture's sweep completed, and the line the page prints for it in the reader's own timezone. */
const COMPLETED_AT = '2026-08-02T12:05:00.000Z'
const MEASURED_LINE = `Measured ${formatObservedInstantLabel(observedInstant(COMPLETED_AT))}`
/** The help behind "Unclear answers", in this page's words. */
const UNCLEAR_ANSWERS = 'Unclear answers. No answer could be tied to one location.'
const OWN_URL = 'https://locations.example/harbor-house'
const NEARBY_QUESTION = 'boutique hotels near the harbor'
/** The one query about Harbor House itself in the tracking workspace. */
const OWN_QUESTION = 'Harbor House reviews'
/** The panel now reads one row per ANSWER, so every request carries the shape. */
const EVIDENCE_SHAPE = 'answers' as const
/** Every results read of the page asks for the last sweep when the published setup has none of its own. */
const LAST_SWEEP = { fallback: 'last-sweep' } as const

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
      completedAt: COMPLETED_AT,
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

/**
 * A fallback read after a tracking change. Revision 7 is published and waits for its first sweep, so the
 * server answers with the sweep that ran with revision 6 and says so in four fields. It dates the change on
 * a day the plan fixture's own `createdAt` is not, so the page can only have read the date from these.
 */
const LAST_SWEEP_RUN = 'run-before-change'
const SWEPT_AT = '2026-10-07T12:05:00.000Z'
const CHANGED_AT = '2026-10-09T15:00:00.000Z'
const AWAITING_SWEEP: { activeRevision: number; measuredRevision: number | null; awaitingSweep: boolean; trackingChangedAt?: string } =
  { activeRevision: 7, measuredRevision: 6, awaitingSweep: true, trackingChangedAt: CHANGED_AT }
/** The days the page prints for them, in the reader's own timezone. */
const SWEPT_ON = formatObservedInstantMonthDay(observedInstant(SWEPT_AT))
const CHANGED_ON = formatObservedInstantMonthDay(observedInstant(CHANGED_AT))
/** What the header's one note says, after its label. */
const TRACKING_CHANGED_HELP = `Showing the ${SWEPT_ON} results, from before the change. New numbers after the next sweep. Queries removed since then still count here. Queries added since then do not.`
/** Why a type with queries now has no number from that sweep. */
const NOT_IN_LAST_SWEEP = `Not in last sweep. No queries of this type were asked for this location in the ${SWEPT_ON} sweep. First numbers after the next sweep.`

/**
 * `response` as a fallback read returns it: the last sweep's run and date, with the four fields. The published
 * setup still needs its first sweep, and an overview keeps saying so beside the older numbers.
 */
function fromLastSweep<T extends { measurement: object }>(response: T, fields: Partial<typeof AWAITING_SWEEP> = {}): T {
  return {
    ...response,
    ...('nextAction' in response ? { nextAction: { kind: 'run_measurement' } } : {}),
    measurement: { ...response.measurement, displayedRunId: LAST_SWEEP_RUN, completedAt: SWEPT_AT, ...AWAITING_SWEEP, ...fields },
  }
}

/** `response` as a fallback read returns it for a project no sweep has measured: no run, no date and no measured setup. */
function neverSwept<T extends { measurement: object }>(response: T): T {
  return { ...response, measurement: { state: 'not_measured', ...AWAITING_SWEEP, measuredRevision: null } }
}

/** A rate that disagrees with the counts beside it, so a figure worked out in the browser cannot match the server's. */
const skewed = (value: number, numerator: number, denominator: number): Metric => ({ state: 'available', value, numerator, denominator })

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

const WORKSPACE_VERSION = `qtw_${'a'.repeat(64)}`
const TRACKING_ACTIVE = { revision: 7, compiledChecksum: 'b'.repeat(64) }
const TRACKING_CONTEXT = { providers: ['openai'], models: {}, location: null }
const NEARBY_EDGE = { executionNodeKey: 'node-nearby', targetKey: TARGET_KEY, queryId: 'query-nearby' }
/** The server's counts for Harbor House. They are a larger portfolio's, so none can be worked out from the rows listed. */
const TRACKING_COUNTS = { propertyQueries: 5, marketQueries: 9, customQueries: 0, answersPerSweep: 28 }

/** A tracked query asked for Harbor House in its one market, measured by the last sweep. */
function trackedQuery(queryId: string, queryText: string, focus: { kind: 'market' | 'property'; key: string }, queryClass: 'branded' | 'non-brand', overrides: Record<string, unknown> = {}) {
  return {
    queryId, queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' },
    state: 'tracked', lastMeasuredAt: COMPLETED_AT,
    assignments: [{ targetKey: TARGET_KEY, groupKeys: ['north'], marketKeys: ['north-coast'], queryClass, classificationSource: 'server', contexts: [TRACKING_CONTEXT] }],
    focus, queryClasses: [queryClass],
    ...overrides,
  }
}

/**
 * The tracking workspace the page reads beside its plan. Harbor House sits in one market, North coast, in
 * the North group. It has one query of its own and takes the plan's nearby query from that market.
 */
function trackingWorkspace(overrides: { targets?: unknown[]; groups?: unknown[]; markets?: unknown[]; scopeOptions?: unknown[]; tracked?: unknown[] } = {}) {
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, active: TRACKING_ACTIVE,
    defaultContexts: [TRACKING_CONTEXT],
    targets: [{ stableKey: TARGET_KEY, label: 'Harbor House', marketKeys: ['north-coast'], counts: TRACKING_COUNTS }],
    groups: [{ stableKey: 'north', label: 'North', targetKeys: [TARGET_KEY] }],
    markets: [{ stableKey: 'north-coast', label: 'North coast', groupKey: 'north', usageEdges: [NEARBY_EDGE], targetKeys: [TARGET_KEY] }],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
      { id: 'north', label: 'North', kind: 'group', targetCount: 1 },
      { id: 'north-coast', label: 'North coast', kind: 'market', targetCount: 1, parentGroupIds: ['north'] },
      { id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1, parentGroupIds: ['north'] },
    ],
    tracked: [
      trackedQuery('query-own', OWN_QUESTION, { kind: 'property', key: TARGET_KEY }, 'branded'),
      trackedQuery('query-nearby', NEARBY_QUESTION, { kind: 'market', key: 'north-coast' }, 'non-brand'),
    ],
    savedSources: { research: [], discovery: [] },
    ...overrides,
  })
}

/** The last sweep's Mentioned and Cited for Harbor House's queries. It measured both. */
function trackingResults(overrides: Record<string, unknown> = {}) {
  const engines = (mentioned: boolean, cited: boolean) => [{ provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: mentioned ? 1 : 0, citedAnswers: cited ? 1 : 0, uncheckedSourceAnswers: 0, mentioned, cited }]
  return queryTrackingResultsResponseSchema.parse({
    mode: 'advanced', scope: { kind: 'property', key: TARGET_KEY },
    run: { id: RUN_ID, createdAt: '2026-08-02T12:00:00.000Z', completedAt: COMPLETED_AT, status: 'completed', revision: 7, matchesCurrentTracking: true },
    engines: ['openai'],
    rows: [
      { queryId: 'query-own', queryText: OWN_QUESTION, queryClass: 'branded', engines: engines(true, false) },
      { queryId: 'query-nearby', queryText: NEARBY_QUESTION, queryClass: 'non-brand', engines: engines(false, false) },
    ],
    pendingRows: 0,
    ...overrides,
  })
}

/** The two reads the tracked section makes, or undefined for any other request. The results read carries the location in its search. */
function trackingRead(url: string): Response | undefined {
  const { pathname } = new URL(url)
  if (pathname.endsWith('/query-tracking/results')) return jsonResponse(trackingResults())
  if (pathname.endsWith('/query-tracking')) return jsonResponse(trackingWorkspace())
  return undefined
}

/** The panel's own table, addressed by the caption every test shares. */
function answersTable() {
  return screen.findByRole('table', { name: 'Answers measured for this location' })
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
  // The tracked section's two reads are answered. Every other request goes where it went before: the cache below holds the page's own reads.
  const unmocked = globalThis.fetch
  onTestFinished(mockFetch((url, init) => trackingRead(url) ?? unmocked(url, init)))

  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    options.plan ?? planResponse(),
  )
  for (const [queryClass, response] of [['branded', options.branded], ['non-brand', options.nonBrand]] as const) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementOverviewQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass, ...LAST_SWEEP },
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
    ...LAST_SWEEP,
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
    const tracking = trackingRead(url)
    if (tracking) return tracking
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

/** The page's reads for a location no sweep has measured. */
function neverSweptResponses() {
  const blank = { mentionCoverage: unavailable('no_completed_run'), citationCoverage: unavailable('no_completed_run') }
  const page = propertyPageResponses({
    branded: neverSwept(overviewResponse('branded', blank, { measurementState: 'not_measured', nextAction: 'run_measurement' })),
    nonBrand: neverSwept(overviewResponse('non-brand', blank, { measurementState: 'not_measured', nextAction: 'run_measurement' })),
  })
  return (url: string) => {
    const path = pathOf(url)
    if (path.includes('/measurement-property-evidence')) {
      return jsonResponse(neverSwept(new URL(url).searchParams.get('shape') === 'answers' ? evidenceResponse([]) : otherQueriesResponse([])))
    }
    if (path.includes('/measurement-property-competitors')) {
      return jsonResponse(neverSwept({ ...competitorsResponse([]), basis: { state: 'unavailable', reason: 'no_completed_run' } }))
    }
    return page(url)
  }
}

/**
 * The page's reads after a tracking change: `base` as fallback reads answer it, from the sweep before the
 * change. The tracking results are that sweep's too, so the tracked section would say "Tracking changed"
 * itself if the page let it.
 */
function afterTrackingChange(base: (url: string) => Response, fields: Partial<typeof AWAITING_SWEEP> = {}) {
  return async (url: string) => {
    if (new URL(url).pathname.endsWith('/query-tracking/results')) {
      return jsonResponse(trackingResults({ run: { id: LAST_SWEEP_RUN, createdAt: '2026-10-07T12:00:00.000Z', completedAt: SWEPT_AT, status: 'completed', revision: 6, matchesCurrentTracking: false } }))
    }
    const response = base(url)
    return /\/measurement-(?:overview|property-evidence|property-competitors|question-result)/.test(pathOf(url))
      ? jsonResponse(fromLastSweep(await response.json() as { measurement: object }, fields))
      : response
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
    expect(fetched.filter(path => path.includes('/measurement-') || path.includes('/query-tracking'))).toEqual([])
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

    expect((await screen.findByRole('status')).textContent).toContain('Loading location')
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
      name: 'Mention and citation coverage for this location, by query type',
    })
    const nonBrand = within(contrast).getByText('Non-brand').closest('tr')!
    expect(within(nonBrand).getByText('75.0%')).toBeTruthy()
    // One failed read is one alert: a short label, with what failed in its help.
    expect(screen.getByRole('alert').textContent).toBe('Load failed')
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Load failed. Branded queries did not load.' })).toBeTruthy()
    // It sits with its Retry under the type's name, in the first column, which a phone shows whole.
    const [type, figures] = [...within(contrast).getByText('Branded').closest('tr')!.querySelectorAll('td')]
    expect(visibleText(type!)).toBe('BrandedLoad failedRetry')
    expect(figures!.textContent).toBe('Unavailable')

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
      name: 'Mention and citation coverage for this location, by query type',
    })
    const branded = within(contrast).getByText('Branded').closest('tr')!
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
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass: 'branded', ...LAST_SWEEP },
      }),
    })

    await screen.findByText('Refresh failed')
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
      name: 'Mention and citation coverage for this location, by query type',
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
          query: { scope: 'property', targetKey: TARGET_KEY, queryClass, ...LAST_SWEEP },
        }),
      })),
    ])

    expect(screen.queryByRole('button', { name: 'Retry location' })).toBeNull()
    expect(contrast).toBeTruthy()
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Refresh failed')).toHaveLength(2))
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
    expect((await screen.findByRole('alert')).textContent).toBe('Load failed')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(evidence).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry more answers' }).textContent).toBe('Retry')

    fireEvent.click(screen.getByRole('button', { name: 'Retry more answers' }))
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

  /** A location no sweep has measured. Settles every read, then returns each request the page made. */
  async function renderNeverSwept(account: SignedInAccount | null = null) {
    const requests: string[] = []
    const responses = neverSweptResponses()
    const { queryClient } = await renderPropertyPageFromApi(url => {
      requests.push(pathOf(url))
      return responses(url)
    }, { account })
    await screen.findByRole('region', { name: 'Measurement next step' })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    return requests
  }

  it('points a writer to AI Visibility for a location no sweep has measured, and reads no report for older results', async () => {
    const requests = await renderNeverSwept(ADMIN)

    const link = screen.getByRole('link', { name: 'Go to AI Visibility' })
    await waitFor(() => expect(new URL(link.getAttribute('href')!, window.location.origin).searchParams.get('queryClass')).toBe('non-brand'))
    const search = new URL(link.getAttribute('href')!, window.location.origin).searchParams
    expect([search.get('measurementScope'), search.get('measurementScopeKey')]).toEqual([null, null])
    // The strip is a short status and the link, with what to do in its help.
    const next = screen.getByRole('region', { name: 'Measurement next step' })
    expect(visibleText(next)).toBe('Awaiting next sweepGo to AI Visibility')
    expect(within(next).getByRole('button', { name: 'Awaiting next sweep. Run a sweep from AI Visibility to collect this location’s coverage and source evidence.' })).toBeTruthy()
    // Nothing is measured, so no tracking change is reported and there are no older results to link to.
    expect(screen.queryByText(/^Tracking changed/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'See the last results' })).toBeNull()
    expect(requests.filter(request => request.includes('/visibility-report'))).toEqual([])
    // The header's Add button stays the page's one filled action.
    const page = document.querySelector<HTMLElement>('.page-container')!
    expect([...page.querySelectorAll('a, button')].filter(control => control.classList.contains('bg-accent')).map(control => control.textContent)).toEqual(['Add query about this location'])
  })

  it('tells a viewer the location awaits a sweep, with no instruction to run one and no write control', async () => {
    await renderNeverSwept(VIEWER)

    const next = screen.getByRole('region', { name: 'Measurement next step' })
    expect(visibleText(next)).toBe('Awaiting next sweepView AI Visibility')
    expect(within(next).getByRole('button', { name: 'Awaiting next sweep. This location needs a new measurement before coverage and source evidence are available.' })).toBeTruthy()
    const answers = screen.getByRole('region', { name: 'Answers' })
    expect(await within(answers).findByRole('button', { name: 'Not measured. This location needs a new measurement before its answers are available.' })).toBeTruthy()
    const page = document.querySelector<HTMLElement>('.page-container')!
    expect([...page.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')!).filter(name => /\brun a\b/i.test(name))).toEqual([])
    expect(within(page).queryByRole('button', { name: 'Add query about this location' })).toBeNull()
    expect(within(page).queryByRole('button', { name: PROPERTY_NAMES_COPY.edit })).toBeNull()
  })

  it('names who runs sweeps on a managed deployment, and never tells the reader to run one', async () => {
    const previousConfig = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { ...previousConfig, dashboard: { managedSweeps: true } }
    onTestFinished(() => {
      if (previousConfig === undefined) delete window.__CANONRY_CONFIG__
      else window.__CANONRY_CONFIG__ = previousConfig
    })
    await renderNeverSwept(ADMIN)

    const next = screen.getByRole('region', { name: 'Measurement next step' })
    expect(within(next).getByRole('button', { name: `Awaiting next sweep. ${MANAGED_SWEEPS_COPY}` })).toBeTruthy()
    const answers = screen.getByRole('region', { name: 'Answers' })
    expect(await within(answers).findByRole('button', { name: `Not measured. ${MANAGED_SWEEPS_COPY}` })).toBeTruthy()
    const page = document.querySelector<HTMLElement>('.page-container')!
    expect([...page.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')!).filter(name => /\brun a\b/i.test(name))).toEqual([])
    expect(page.textContent).not.toMatch(/\brun a\b/i)
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
      name: 'Mention and citation coverage for this location, by query type',
    })
    const branded = within(contrast).getByText('Branded').closest('tr')!
    const nonBrand = within(contrast).getByText('Non-brand').closest('tr')!

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
      name: 'Mention and citation coverage for this location, by query type',
    })
    const branded = within(contrast).getByText('Branded').closest('tr')!

    expect(within(branded).getAllByText('Not measured')).toHaveLength(2)
    expect(within(branded).getAllByText('No queries tracked')).toHaveLength(2)
    expect(within(branded).queryByText(/%$/)).toBeNull()
    for (const reason of within(branded).getAllByText('No queries tracked')) {
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
    const gemini = within(providers).getByText('Gemini').closest('tr')!
    const openai = within(providers).getByText('OpenAI').closest('tr')!

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

    // Each count keeps its left-out answers behind a caution icon beside it, never as a line of its own.
    const line = '9 of 10 answers could not be tied to one location'
    const hero = await screen.findByRole('region', { name: 'Coverage for this location' })
    const nonBrandMention = within(hero).getAllByText('Mentioned')[0]!.closest<HTMLElement>('.aeo-hero-row')!
    expect(nonBrandMention.querySelector('.aeo-hero-row-detail')!.textContent).toBe('1 of 1')
    expectCautionNote(nonBrandMention, line, '1 of 1')

    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })
    const nonBrand = within(contrast).getByText('Non-brand').closest('tr')!
    const [, mentioned, cited] = [...nonBrand.querySelectorAll('td')]
    expect(mentioned!.textContent).toBe('100%1 of 1')
    await expectCautionNoteOnOneLine(expectCautionNote(mentioned!, line, '1 of 1'))
    expect(cited!.querySelector('.info-tooltip-trigger-caution')).toBeNull()
    // Every answer ambiguous: the reason is named instead of a bare "Not measured",
    // as a short label that opens its sentence.
    const branded = within(contrast).getByText('Branded').closest('tr')!
    expect(within(branded).getByText('Unclear answers')).toBeTruthy()
    expect(within(branded).getByRole('button', { name: UNCLEAR_ANSWERS })).toBeTruthy()

    const providers = screen.getByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('Gemini').closest('tr')!
    expect(gemini.querySelectorAll('td')[1]!.textContent).toBe('100%1 of 1')
    expectCautionNote(gemini.querySelectorAll('td')[1]!, '4 of 5 answers could not be tied to one location', '1 of 1')
    const openai = within(providers).getByText('OpenAI').closest('tr')!
    expect(within(openai).getByText('Unclear answers')).toBeTruthy()
    expect(within(openai).getByRole('button', { name: UNCLEAR_ANSWERS })).toBeTruthy()
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
    const hero = await screen.findByRole('region', { name: 'Coverage for this location' })
    const nonBrandCited = within(hero).getAllByText('Cited')[0]!.closest<HTMLElement>('.aeo-hero-row')!
    expect(nonBrandCited.querySelector('.aeo-hero-row-detail')!.textContent).toBe('2 of 8')
    expectCautionNote(nonBrandCited, line, '2 of 8')
    const nonBrandMentioned = within(hero).getAllByText('Mentioned')[0]!.closest('.aeo-hero-row')!
    expect(nonBrandMentioned.querySelector('.aeo-hero-row-detail')!.textContent).toBe('5 of 10')
    expect(nonBrandMentioned.querySelector('.info-tooltip-trigger-caution')).toBeNull()

    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })
    const nonBrand = within(contrast).getByText('Non-brand').closest('tr')!
    const [, mentioned, cited] = [...nonBrand.querySelectorAll('td')]
    expect(cited!.textContent).toBe('25.0%2 of 8')
    expectCautionNote(cited!, line, '2 of 8')
    expect([...mentioned!.querySelectorAll('span span')].map(node => node.textContent)).toEqual(['50.0%', '5 of 10'])
    // Every branded answer unchecked: unavailable, with its reason and no count line.
    const branded = within(contrast).getByText('Branded').closest('tr')!
    expect(branded.querySelectorAll('td')[2]!.textContent).toBe('Not measuredEvidence incomplete')

    const providers = screen.getByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('Gemini').closest('tr')!
    expect(gemini.querySelectorAll('td')[2]!.textContent).toBe('33.3%1 of 3')
    expectCautionNote(gemini.querySelectorAll('td')[2]!, '2 of 5 answers had sources that could not be checked', '1 of 3')
    expect(gemini.querySelectorAll('td')[1]!.textContent).toBe('40.0%2 of 5')
    expect(gemini.querySelectorAll('td')[1]!.querySelector('.info-tooltip-trigger-caution')).toBeNull()
    const openai = within(providers).getByText('OpenAI').closest('tr')!
    expect(openai.querySelectorAll('td')[2]!.textContent).toBe('20.0%1 of 5')
  })

  it('keeps the left-out answers beside the rate itself when the server sends no count to put them beside', async () => {
    // The wire allows a rate with a denominator and no numerator. That prints no
    // count line, and the answers left out must not go with it.
    const noCount = { state: 'available', value: 0.25, denominator: 8, unchecked: 2 } as unknown as Metric
    await renderPropertyPage({
      branded: overviewResponse('branded', { mentionCoverage: available(4, 4), citationCoverage: available(1, 4) }),
      nonBrand: overviewResponse('non-brand', { mentionCoverage: available(5, 10), citationCoverage: noCount }),
    })
    const line = '2 of 10 answers had sources that could not be checked'
    const hero = await screen.findByRole('region', { name: 'Coverage for this location' })
    const heroCited = within(hero).getAllByText('Cited')[0]!.closest<HTMLElement>('.aeo-hero-row')!
    expect(heroCited.querySelector('.aeo-hero-row-value')!.textContent).toBe('25.0%')
    expectCautionNote(heroCited, line, '')

    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })
    const cited = within(contrast).getByText('Non-brand').closest('tr')!.querySelectorAll('td')[2]!
    expect(cited.textContent).toBe('25.0%')
    await expectCautionNoteOnOneLine(expectCautionNote(cited, line, '25.0%'))
  })

  it('lists the tracked queries, site pages, and scoped evidence for the selected type', async () => {
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

    // Both types are listed whichever type the results below show: the location's own query is Branded, its market's Non-brand.
    const own = await screen.findByRole('table', { name: 'Location queries' })
    expect(within(own).getByRole('button', { name: OWN_QUESTION }).closest('tr')!.querySelector('.tracked-cell-type')!.textContent).toBe('Branded')
    const fromMarkets = screen.getByRole('table', { name: 'Market queries' })
    expect(within(fromMarkets).getByText(NEARBY_QUESTION)).toBeTruthy()

    // The whole pattern, with a place to break after each slash of its path and none inside the site.
    const urls = within(screen.getByRole('list', { name: 'Site pages matched to this location' })).getAllByRole('listitem')
    expect(urls.map(url => url.textContent)).toEqual(['https://locations.example/harbor-house/*'])
    expect(urls[0]!.innerHTML.replace(/ class="[^"]*"/g, '')).toBe('<span>https://locations.example</span>/<wbr>harbor-house/<wbr>*')

    // The cited URL and its classification moved inside the answer row, so this
    // assertion now expands the answer before reading them.
    const evidence = await answersTable()
    fireEvent.click(within(evidence).getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    fireEvent.click(within(evidence).getByText(`${ANSWER_SOURCES_LABEL} (1)`, { selector: 'summary' }))
    expect(within(evidence).getByText('This location')).toBeTruthy()
    expect(within(evidence).getByText(OWN_URL)).toBeTruthy()
    expect(screen.queryByText(/revision \d+/i)).toBeNull()
    const type = screen.getByLabelText('Query type') as HTMLSelectElement
    expect(type.className).toContain('h-11')
    // On screen it is "Type", with the two types by name.
    expect(type.labels[0]!.textContent).toBe('Type')
    expect([...type.options].map(option => option.textContent)).toEqual(['Non-brand', 'Branded'])
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
    expect(screen.queryByText('No answers')).toBeNull()
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
    expect(within(unread).getByRole('button', { name: 'No mention signal for this location.' })).toBeTruthy()
    // Was: asserted "Recovered from an earlier run without its answer text".
    // The wire says the signal is unreadable, never why, so naming a cause was a
    // provenance claim the response does not carry.
    expect(within(recovered).getByRole('button', { name: 'No mention signal for this location.' })).toBeTruthy()

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
      answerRow({ slot: 'b', queryText: 'best small hotels in the old port', cited: null, sources: [externalSource('https://guide.example/harbour-stays')] }),
    ])
    const unknown = answerFor(evidence, 'where to stay by the water')

    expect(within(unknown).queryByText('Not cited')).toBeNull()
    expect(within(unknown).getAllByText('Not measured').length).toBeGreaterThan(0)
    // Where the count would be, a short note says why there is none: nothing was captured here.
    const [, , , sources] = [...unknown.querySelectorAll('td')]
    expect(sources!.textContent).toBe(`${ANSWER_SOURCES_LABEL}Sources not saved`)
    const notSaved = 'Sources not saved. The sources for this answer were not fully captured, so none can be shown.'
    expect(within(sources!).getByRole('button', { name: notSaved })).toBeTruthy()
    // The opened row says the same thing, in the same words.
    fireEvent.click(within(unknown).getByRole('button', { name: 'Read the answer for where to stay by the water' }))
    expect(within(evidence).getAllByRole('button', { name: notSaved })).toHaveLength(2)

    // Some sources were captured: partial, and the ones captured are listed when the row is opened.
    const partial = answerFor(evidence, 'best small hotels in the old port')
    expect(partial.querySelectorAll('td')[3]!.textContent).toBe(`${ANSWER_SOURCES_LABEL}Sources partial`)
    expect(within(partial).getByRole('button', { name: 'Sources partial. Sources were not fully captured for this answer.' })).toBeTruthy()
    fireEvent.click(within(partial).getByRole('button', { name: 'Read the answer for best small hotels in the old port' }))
    expect(within(evidence).getByText(`${ANSWER_SOURCES_LABEL} (1)`, { selector: 'summary' })).toBeTruthy()
    expect(within(evidence).getAllByRole('button', { name: notSaved })).toHaveLength(2)
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
    expect(within(evidence).getByRole('button', { name: 'No sources. This answer returned no source URLs at all.' })).toBeTruthy()
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

    const hero = await screen.findByRole('region', { name: 'Coverage for this location' })
    // Non-brand is the demand a Property has to earn, so it reads first.
    expect(within(hero).getAllByText(/^(Non-brand|Branded)$/).map(label => label.textContent)).toEqual(['Non-brand', 'Branded'])

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

    const hero = await screen.findByRole('region', { name: 'Coverage for this location' })
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
    await screen.findByRole('region', { name: 'Queries about this location' })
    expect(screen.queryByText('Questions assigned')).toBeNull()
    expect(screen.queryByText('Owned URLs')).toBeNull()
    expect(screen.queryByText('Answer engines')).toBeNull()
    expect(document.querySelectorAll('.metric-card')).toHaveLength(0)

    // Provenance is the one fact no section states, so it survives as a line.
    expect(screen.getByText(`${MEASURED_LINE} · Non-brand only`)).toBeTruthy()
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

    await screen.findByRole('region', { name: 'Coverage for this location' })
    const engines = screen.getByRole('region', { name: 'By engine' })
    expect(engines.querySelector('table')).toBeNull()
    expect(within(engines).getByRole('button', { name: 'Not measured. No answer engine has measured non-brand queries for this location. No queries tracked.' })).toBeTruthy()
    // The server's own reason reaches the reader rather than a bare em dash.
    // It appears in the hero rows too, which is why this counts rather than
    // asserting a single node.
    expect(screen.getAllByText(/No queries tracked/).length).toBeGreaterThan(0)
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
    const market = await screen.findByRole('region', { name: 'Competitors by market' })
    expect(within(market).getByText('North')).toBeTruthy()
    expect(within(market).queryByText('South')).toBeNull()
    expect(within(market).getByText('2 competitors')).toBeTruthy()

    // One destination, one control. Per-market buttons all resolved to this
    // same unscoped URL, so the market a reader picked was silently dropped.
    const links = within(market).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]!.textContent).toBe('Open AI Visibility')
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
    await screen.findByRole('region', { name: 'Coverage for this location' })
    expect(screen.queryByText(/Never/)).toBeNull()
    expect(screen.queryByText(/No completed sweep yet/)).toBeNull()

    // And the hero says the class failed rather than spinning forever: the
    // retry is in the table below, so "Loading" is a promise nothing will keep.
    const hero = screen.getByRole('region', { name: 'Coverage for this location' })
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

    const market = await screen.findByRole('region', { name: 'Competitors by market' })
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

    const section = await screen.findByRole('region', { name: 'Named instead' })
    expect(within(section).getByText('Harborline Homes')).toBeTruthy()
    expect(within(section).getByText('The Sutton')).toBeTruthy()
    expect(within(section).getByText('OpenAI, Gemini')).toBeTruthy()
    // The basis is a labelled figure: the server's two counts and their type, with what they count in the help beside them.
    expect(within(section).getByText('Missed answers').nextElementSibling!.textContent).toBe('3 of 4 · Non-brand')
    expect(within(section).getByRole('button', { name: 'Answers to non-brand queries that did not name this location.' })).toBeTruthy()
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

    const section = await screen.findByRole('region', { name: 'Named instead' })

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

    const section = await screen.findByRole('region', { name: 'Named instead' })
    const deltaRow = within(section).getByText('Delta Suites').closest('tr')!

    // The count is the SERVER total (5), not the length of the sample array (2).
    expect(within(deltaRow).getByText('5')).toBeTruthy()

    const deltaToggle = within(deltaRow).getByRole('button', { name: `${REPEATED_QUERIES_TEXT} +3 more` })
    fireEvent.click(deltaToggle)
    expect(await screen.findByText(`${REPEATED_QUERIES_TEXT} +3 more`)).toBeTruthy()
  })

  it('says so plainly when no rival was named, rather than showing an empty table', async () => {
    // Answers were measured and none named a rival: the basis is there, the list is empty.
    await renderNamedInsteadWith([])

    const section = await screen.findByRole('region', { name: 'Named instead' })
    expect(visibleText(section)).toBe('Named insteadNone named')
    expect(within(section).getByRole('button', { name: 'None named. No rival was named in the answers this location missed.' })).toBeTruthy()
    expect(section.querySelector('table')).toBeNull()
  })

  it.each([
    { reason: 'no_population', why: 'No queries tracked.' },
    { reason: 'no_completed_run', why: 'No completed sweep yet.' },
    { reason: 'evidence_incomplete', why: 'Evidence incomplete.' },
  ])('says Not measured, never None named, when no answer was read ($reason)', async ({ reason, why }) => {
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-competitors')) return jsonResponse({ ...competitorsResponse([]), basis: { state: 'unavailable', reason } })
      return propertyPageResponses()(url)
    })

    const section = await screen.findByRole('region', { name: 'Named instead' })
    expect(visibleText(section)).toBe('Named insteadNot measured')
    expect(within(section).getByRole('button', { name: `Not measured. No answers to non-brand queries have been measured for this location. ${why}` })).toBeTruthy()
    expect(section.querySelector('table')).toBeNull()
  })

  it('keeps the section when its read fails, and reads it again on Retry', async () => {
    let attempts = 0
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-competitors')) {
        attempts += 1
        if (attempts === 1) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500)
      }
      return propertyPageResponses()(url)
    })

    const section = await screen.findByRole('region', { name: 'Named instead' })
    expect(visibleText(section)).toBe('Named insteadLoad failedRetry')
    expect(within(section).getByRole('alert').textContent).toBe('Load failed')
    expect(within(section).getByRole('button', { name: 'Load failed. The names given instead did not load.' })).toBeTruthy()
    fireEvent.click(within(section).getByRole('button', { name: 'Retry named instead' }))

    expect(await within(section).findByText('Harborline Homes')).toBeTruthy()
    expect(attempts).toBe(2)
    expect(within(section).queryByRole('alert')).toBeNull()
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
  // The row is headed by its query at level 4, under Answers, and the answer's own top heading sits one below it.
  expect(within(row).getByRole('heading', { name: NEARBY_QUESTION, level: 4 })).toBeTruthy()
  expect((await screen.findByRole('heading', { name: NEARBY_QUESTION, level: 5 })).closest('.answer-markdown')).toBeTruthy()
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

const withoutBrand = (index: number, value: string) => nameIssueDetail({ code: MeasurementTargetNameIssueCodes.withoutBrand, field: 'aliases', index, value })

/** A name warning: a short label naming the value, with the sentence for it as the note's help. */
function nameWarning(section: HTMLElement, label: string, message: string): HTMLElement | null {
  return within(section).queryByRole('button', { name: `${label}. ${message}` })
}

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
    expect(section.querySelector('.section-head')!.textContent).toBe(`${PROPERTY_NAMES_COPY.heading}2 names`)
    expect(visibleText(section.querySelector<HTMLElement>('.section-head')!)).toBe(`${PROPERTY_NAMES_COPY.heading}2`)
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
    expect(brandless).toBe('"Harbor House" does not include your brand name, so answers about other places with this name can count for this location.')
    expect(nameWarning(section, 'No brand name: Harbor House', brandless)).toBeTruthy()
    // The warning describes the field it is under, sentence included.
    expect(document.getElementById(names.getAttribute('aria-describedby')!.split(' ')[1]!)!.contains(nameWarning(section, 'No brand name: Harbor House', brandless))).toBe(true)

    fireEvent.change(names, { target: { value: 'Locations Harbor House\nHH\n' } })
    fireEvent.change(qualified, { target: { value: 'Harbor District' } })
    expect(nameWarning(section, 'No brand name: Harbor House', brandless)).toBeNull()
    expect(nameWarning(section, 'Too short: HH', nameIssueDetail({ code: MeasurementTargetNameIssueCodes.short, field: 'aliases', index: 1, value: 'HH' }))).toBeTruthy()
    const unqualified = nameIssueDetail({ code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index: 0, value: 'Harbor District' })
    expect(unqualified).toBe('"Harbor District" must include one of this location’s names plus more words, such as a street or city. Publishing is refused until it does.')
    expect(nameWarning(section, 'Must include a name: Harbor District', unqualified)).toBeTruthy()
    // Every helper is a label with its sentence one step away, and each field is described by its one hint.
    const help = (text: string) => within(section).getByRole('button', { name: text })
    expect(document.getElementById(names.getAttribute('aria-describedby')!.split(' ')[0]!)!.textContent).toBe(PROPERTY_NAMES_COPY.perLine)
    const [qualifiedHint, qualifiedIssues, ...more] = qualified.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!)
    expect(qualifiedHint!.contains(help(`${PROPERTY_NAMES_COPY.perLine}. ${PROPERTY_NAMES_COPY.qualifiedHint}`))).toBe(true)
    expect(PROPERTY_NAMES_COPY.qualifiedHint).toContain('With qualified names set, an answer that uses only a plain name counts as a mention only when it also cites this location’s own page.')
    expect(qualifiedIssues!.contains(nameWarning(section, 'Must include a name: Harbor District', unqualified))).toBe(true)
    expect(more).toEqual([])
    expect(help(`${PROPERTY_NAMES_COPY.draftOnly}. ${PROPERTY_NAMES_COPY.draftOnlyDetail}`)).toBeTruthy()
    // No name in a warning's help or anywhere else in the open editor says property.
    expect([...section.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')!).filter(name => /propert/i.test(name))).toEqual([])
    // What a sighted reader sees in the open editor around the two fields: labels only, and the values in the warnings.
    const shown = section.cloneNode(true) as HTMLElement
    for (const field of shown.querySelectorAll('textarea')) field.remove()
    expect(visibleText(shown)).toBe([
      PROPERTY_NAMES_COPY.heading, '1', PROPERTY_NAMES_COPY.names, PROPERTY_NAMES_COPY.perLine, 'Too short: HH',
      PROPERTY_NAMES_COPY.qualifiedNames, PROPERTY_NAMES_COPY.perLine, 'Must include a name: Harbor District',
      PROPERTY_NAMES_COPY.save, PROPERTY_NAMES_COPY.cancel, PROPERTY_NAMES_COPY.draftOnly,
    ].join(''))

    fireEvent.change(qualified, { target: { value: 'Locations Harbor House Bayfront' } })
    saveNames(section)

    expect((await within(section).findByRole('status')).textContent).toBe(`${PROPERTY_NAMES_COPY.saved}${PROPERTY_NAMES_COPY.review}`)
    expect(within(section).getByRole('button', { name: `${PROPERTY_NAMES_COPY.saved}. ${PROPERTY_NAMES_COPY.savedDetail}` })).toBeTruthy()
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
    expect((await within(section).findByRole('status')).textContent).toBe(`${PROPERTY_NAMES_COPY.pending}${PROPERTY_NAMES_COPY.review}`)
    expect(within(section).getByRole('button', { name: `${PROPERTY_NAMES_COPY.pending}. ${PROPERTY_NAMES_COPY.pendingDetail}` })).toBeTruthy()
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
    expect(within(section).getByRole('button', { name: `${PROPERTY_NAMES_COPY.failed}. ${PROPERTY_NAMES_COPY.failedDetail}` })).toBeTruthy()
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

    expect(nameWarning(section, 'No brand name: Newco Harbor House', withoutBrand(0, 'Newco Harbor House'))).toBeNull()
    expect(nameWarning(section, 'No brand name: Locations Harbor House', withoutBrand(1, 'Locations Harbor House'))).toBeTruthy()
  })

  it('refuses to write into a draft started from an older published setup', async () => {
    const server = draftServer(draftResponse(draftTarget(), { baseActiveRevision: 6 }))
    await renderPropertyPageFromApi(server.handler, { account: ADMIN })

    const section = await namesSection()
    await openNamesEditor(section)
    fireEvent.change(namesBox(section), { target: { value: 'Locations Harbor House' } })
    saveNames(section)

    // The draft must be restarted in setup first, so the link beside the note opens setup and does not say publish.
    expect((await within(section).findByRole('alert')).textContent).toBe(`${PROPERTY_NAMES_COPY.staleDraft}${PROPERTY_NAMES_COPY.openSetup}`)
    expect(within(section).getByRole('button', { name: `${PROPERTY_NAMES_COPY.staleDraft}. ${PROPERTY_NAMES_COPY.staleDraftDetail}` })).toBeTruthy()
    expect(within(section).getByRole('link', { name: PROPERTY_NAMES_COPY.openSetup }).getAttribute('href')).toMatch(/\/portfolio$/)
    expect(within(section).queryByRole('link', { name: PROPERTY_NAMES_COPY.review })).toBeNull()
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
    expect(await within(section).findByText('2 answers · Non-brand')).toBeTruthy()
    expect(within(section).getByRole('button', { name: `${OTHER_QUERIES_COPY.notCounted}. ${OTHER_QUERIES_COPY.notCountedHelp}` })).toBeTruthy()
    const evidence = requests.find(request => request.pathname.includes('/measurement-property-evidence'))!
    expect(Object.fromEntries(evidence.searchParams)).toMatchObject({ targetKey: TARGET_KEY, queryClass: 'non-brand', shape: 'other-queries', runId: RUN_ID, ...LAST_SWEEP })

    const table = within(section).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Location', 'Pages cited', 'Answer'])
    // The frame is positioned, so the screen-reader-only header cell is clipped with the table and cannot widen a phone page.
    const frame = table.parentElement!
    const frameRules = parseCompiledCss(await compileAppStyles([...frame.classList]))
    expect([compiledElementProperty(frameRules, frame, 'position'), compiledElementProperty(frameRules, frame, 'overflow-x')]).toEqual(['relative', 'auto'])
    const quiet = within(table).getByText('quiet stays by the marina').closest('tr')!
    // The engine reads by its display name, never the wire value.
    expect(quiet.querySelector('td')!.textContent).toBe('quiet stays by the marinaGemini')
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
    expect(Object.fromEntries(answer.searchParams)).toEqual({ targetKey: OTHER_KEY, resultId: 'obs-quiet stays by the marina', ...LAST_SWEEP })

    // The rates above still read only this Property's own queries.
    const contrast = screen.getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })
    expect(within(within(contrast).getByText('Non-brand').closest('tr')!).getByText('50.0%')).toBeTruthy()
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
    expect(await within(section).findByRole('button', { name: `${OTHER_QUERIES_COPY.empty}. ${OTHER_QUERIES_COPY.emptyHelp}` })).toBeTruthy()
    expect(within(section).getByText('0 answers · Branded')).toBeTruthy()
    // With no row there is nothing for "Not in rates" to qualify.
    expect(visibleText(section)).toBe(`${OTHER_QUERIES_COPY.heading}0 answers · Branded${OTHER_QUERIES_COPY.empty}`)
    expect(classes).toEqual(['branded'])
  })

  it('says the read failed in one alert and reads it again on Retry', async () => {
    let attempts = 0
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.endsWith('/measurement-plan')) return jsonResponse(planWithMarina())
      if (path.includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'other-queries') {
        attempts += 1
        return attempts === 1
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500)
          : jsonResponse(otherQueriesResponse([otherRow({ queryText: 'quiet stays by the marina' })]))
      }
      return propertyPageResponses()(url)
    })

    const section = await screen.findByRole('region', { name: OTHER_QUERIES_COPY.heading })
    expect((await within(section).findByRole('alert')).textContent).toBe(OTHER_QUERIES_COPY.loadError)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(section).getByRole('button', { name: `${OTHER_QUERIES_COPY.loadError}. ${OTHER_QUERIES_COPY.loadErrorHelp}` })).toBeTruthy()
    expect(visibleText(section)).toBe(`${OTHER_QUERIES_COPY.heading}${OTHER_QUERIES_COPY.loadError}Retry`)
    fireEvent.click(within(section).getByRole('button', { name: 'Retry other queries' }))

    expect(within(await within(section).findByRole('table')).getByText('quiet stays by the marina')).toBeTruthy()
    expect(attempts).toBe(2)
    expect(within(section).queryByRole('alert')).toBeNull()
  })
})

/** The text a sighted reader sees under `root`, one entry per text node, outside screen-reader-only text and form fields. */
function visibleRuns(root: HTMLElement): string[] {
  const runs: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text && !node.parentElement?.closest('.sr-only, textarea, select')) runs.push(text)
  }
  return runs
}

const serverError = () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500)

// Words the page must not show or say, tooltips and accessible names included. The page prints "Location".
const BANNED = /propert|assign|\bclass\b|classification|whole site|audience|\bscope\b|\bcontext\b|revision|question|—/i

/** The page says Location: no banned word on screen or in a tooltip or accessible name, and no visible sentence. */
function expectLocationCopy(page: HTMLElement) {
  // The badge sits beside the heading, outside its name.
  expect(within(page).getByRole('heading', { level: 1 }).nextElementSibling!.textContent).toBe('Location')
  expect(page.textContent).not.toMatch(BANNED)
  expect([...page.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')!).filter(name => BANNED.test(name))).toEqual([])
  // A visible sentence ends in a full stop or carries one mid-line. Every explanation is a tooltip now.
  expect(visibleRuns(page).filter(run => /[.!?](?:\s|$)/.test(run))).toEqual([])
}

describe('Location page copy', () => {
  const providers = [
    { provider: 'gemini', mentionCoverage: available(1, 2), citationCoverage: available(0, 2) },
    { provider: 'openai', mentionCoverage: available(2, 2), citationCoverage: available(2, 2) },
  ]
  const otherQuery: OtherQueryRow = {
    observationId: 'obs-marina', expectedSlotId: 'slot-marina', executionId: 'exec-marina', provider: 'gemini', queryText: 'quiet stays by the marina', location: null, queryClass: 'non-brand',
    assignedTargetKeys: [TARGET_KEY], sources: [{ sourceUrl: `${OWN_URL}/amenities`, normalizedUrl: `${OWN_URL}/amenities`, matchedUrlIds: [`${TARGET_KEY}:url:0`] }],
    sourceCount: 1, sourcesTruncated: false, evidenceComplete: true,
  }

  /** A measured location with every section filled, read as `account`. Resolves once each section has its rows. */
  async function renderMeasured(account: SignedInAccount) {
    const nonBrand = overviewResponse('non-brand', { mentionCoverage: available(3, 4), citationCoverage: available(2, 4), providers })
    nonBrand.properties.items[0]!.flags = 2
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'other-queries') return jsonResponse(otherQueriesResponse([otherQuery]))
      return propertyPageResponses({ nonBrand })(url)
    }, { account })
    await answersTable()
    await within(await screen.findByRole('region', { name: 'Named instead' })).findByRole('table')
    await within(await screen.findByRole('region', { name: OTHER_QUERIES_COPY.heading })).findByRole('table')
    await screen.findByRole('table', { name: 'Location queries' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'OpenAI: Mentioned, Not cited' })).toBeTruthy())
    return document.querySelector<HTMLElement>('.page-container')!
  }

  /** A location with nothing set and nothing measured for the type: no queries, names or site pages, and no market. */
  async function renderEmpty(account: SignedInAccount, search = '') {
    const plan = planResponse()
    plan.active.plan.targets[0] = { ...plan.active.plan.targets[0]!, aliases: [], urlMatchers: [] }
    plan.active.plan.groups = []
    plan.active.plan.assignments = []
    const workspace = trackingWorkspace({
      targets: [{ stableKey: TARGET_KEY, label: 'Harbor House', marketKeys: [], counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 0 } }],
      groups: [], markets: [], tracked: [],
    })
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.endsWith('/query-tracking')) return jsonResponse(workspace)
      if (new URL(url).pathname.endsWith('/query-tracking/results')) return jsonResponse(trackingResults({ rows: [] }))
      if (path.endsWith('/measurement-plan')) return jsonResponse(plan)
      if (path.includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'answers') return jsonResponse(evidenceResponse([]))
      if (path.includes('/measurement-property-competitors')) return jsonResponse({ ...competitorsResponse([]), basis: { state: 'unavailable', reason: 'no_population' } })
      return propertyPageResponses({
        nonBrand: overviewResponse('non-brand', { mentionCoverage: unavailable('no_population'), citationCoverage: unavailable('no_population') }),
        branded: overviewResponse('branded', { mentionCoverage: unavailable('identity_ambiguous'), citationCoverage: unavailable('evidence_incomplete') }),
      })(url)
    }, { account, search })
    await within(await screen.findByRole('region', { name: 'Answers' })).findByText('No answers')
    await within(await screen.findByRole('region', { name: OTHER_QUERIES_COPY.heading })).findByText(OTHER_QUERIES_COPY.empty)
    await screen.findByRole('region', { name: 'Named instead' })
    await within(await screen.findByRole('region', { name: 'Queries about this location' })).findByText('No location queries')
    return document.querySelector<HTMLElement>('.page-container')!
  }

  it.each([{ role: 'a writer', account: ADMIN }, { role: 'a viewer', account: VIEWER }])('says Location and shows $role no sentence on a measured page', async ({ account }) => {
    const page = await renderMeasured(account)

    expectLocationCopy(page)
    expect(within(page).getByText('2 unclear links')).toBeTruthy()
    // What the badge counts is one step away, and it names the label those links carry under Answers.
    expect(within(page).getByRole('button', { name: `Cited links that match more than one location. They are marked ${EVIDENCE_LABELS.ambiguous.label} under Answers.` }).classList.contains('info-tooltip-trigger-caution')).toBe(true)
    // Each table's columns, in one or two words.
    const headers = (name: string) => within(within(page).getByRole('table', { name })).getAllByRole('columnheader').map(header => header.textContent)
    expect(headers('Mention and citation coverage for this location, by query type')).toEqual(['Type', 'Mentioned', 'Cited'])
    expect(headers('Per-engine mention and citation coverage')).toEqual(['Engine', 'Mentioned', 'Cited'])
    expect(headers('Answers measured for this location')).toEqual(['Query', 'Mentioned', 'Cited', 'Sources', 'Sources detail'])
    // The tracked lists: a row menu for a writer only, and no menu column without one.
    expect(headers('Location queries')).toEqual(['Query', 'Type', 'OpenAI', 'Status', ...(account === ADMIN ? ['Actions'] : [])])
    expect(headers('Market queries')).toEqual(['Market', 'Query', 'Type', 'Last measured'])
    expect(within(page).queryAllByRole('button', { name: /^Actions for / }).map(button => button.getAttribute('aria-label'))).toEqual(account === ADMIN ? [`Actions for ${OWN_QUESTION}`] : [])
    // Engines read by their display names, in the answer rows and the rows cited on other queries.
    expect(answerFor(within(page).getByRole('table', { name: 'Answers measured for this location' }), NEARBY_QUESTION).querySelector('td')!.textContent).toBe(`${NEARBY_QUESTION}OpenAI`)
    expect(within(within(page).getByRole('region', { name: OTHER_QUERIES_COPY.heading })).getByText('quiet stays by the marina').closest('td')!.textContent).toBe('quiet stays by the marinaGemini')
    // When it was measured, and for which type.
    expect(within(page).getByText(`${MEASURED_LINE} · Non-brand only`)).toBeTruthy()
    expect(within(page).getByRole('region', { name: 'Site pages we match' }).querySelector('.section-head')!.textContent).toBe('Site pages we match1 pageRead-only')
    // Section headings are one to four words. What the location is tracked for and matched by comes first,
    // then Results, which heads every result section the page had, in the order it had them.
    expect(within(page).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
      'Coverage for this location', 'Queries about this location', 'From its markets', 'Site pages we match', PROPERTY_NAMES_COPY.heading, 'Results',
    ])
    const results = within(page).getByRole('heading', { name: 'Results', level: 2 })
    expect(within(page).getAllByRole('heading', { level: 3 }).filter(heading => results.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).map(heading => heading.textContent)).toEqual([
      'By type', 'By engine', 'Named instead', 'Competitors by market', 'Answers', OTHER_QUERIES_COPY.heading,
    ])
    // A location with one list of names shows it under the section's heading alone: the list's own label is for a screen reader.
    expect(within(page).getByRole('heading', { name: PROPERTY_NAMES_COPY.names, level: 3 }).className).toBe('sr-only')
    // Each answer is headed by its query, under Answers.
    expect(within(within(page).getByRole('region', { name: 'Answers' })).getAllByRole('heading', { level: 4 }).map(heading => heading.textContent)).toEqual([NEARBY_QUESTION])
    expect(within(page).queryByRole('button', { name: 'Add query about this location' }) !== null).toBe(account === ADMIN)
    expect(within(page).queryByRole('button', { name: PROPERTY_NAMES_COPY.edit }) !== null).toBe(account === ADMIN)
  })

  it('shows a writer short labels, one action and no sentence on a location with nothing set', async () => {
    const page = await renderEmpty(ADMIN)

    expectLocationCopy(page)
    // Each empty list is a flag: a short label, with what it means one step away. The one way to add is the header's button.
    const queries = within(page).getByRole('region', { name: 'Queries about this location' })
    expect(visibleText(queries)).toBe('Queries about this location0No location queries')
    expect(within(queries).getByRole('button', { name: 'No location queries. No tracked query has this location as its Subject.' })).toBeTruthy()
    const markets = within(page).getByRole('region', { name: 'From its markets' })
    expect(visibleText(markets)).toBe('From its markets0In no market')
    expect(within(markets).getByRole('button', { name: 'In no market. This location is in no market, so no market query counts for it.' })).toBeTruthy()
    expect(within(page.querySelector<HTMLElement>('.page-header')!).getByRole('button', { name: 'Add query about this location' })).toBeTruthy()
    const names = within(page).getByRole('region', { name: PROPERTY_NAMES_COPY.heading })
    expect(visibleText(names)).toBe(`${PROPERTY_NAMES_COPY.heading}0${PROPERTY_NAMES_COPY.edit}${PROPERTY_NAMES_COPY.noNames}`)
    expect(within(names).getByRole('button', { name: `${PROPERTY_NAMES_COPY.noNames}. ${PROPERTY_NAMES_COPY.noNamesDetail}` })).toBeTruthy()
    // Site pages are read-only here, and the one action beside an empty list of them is the setup that holds them.
    const pages = within(page).getByRole('region', { name: 'Site pages we match' })
    expect(visibleText(pages)).toBe('Site pages we match0Read-onlyNo site pagesOpen measurement setup')
    expect(within(pages).getByRole('link', { name: 'Open measurement setup' }).getAttribute('href')).toMatch(/\/portfolio$/)
    // A location in no market has no competitor section, and the rest say what is missing in a label.
    expect(within(page).queryByRole('region', { name: 'Competitors by market' })).toBeNull()
    expect(visibleText(within(page).getByRole('region', { name: 'By engine' }))).toBe('By engineNot measured')
    expect(visibleText(within(page).getByRole('region', { name: 'Named instead' }))).toBe('Named insteadNot measured')
    expect(visibleText(within(page).getByRole('region', { name: 'Answers' }))).toBe('AnswersNo answers')
    // The reason a type has no number is a label too, with its sentence in this page's words.
    const branded = within(within(page).getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })).getByText('Branded').closest('tr')!
    expect([...branded.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Branded', 'Not measuredUnclear answers', 'Not measuredEvidence incomplete'])
    expect(within(branded).getByRole('button', { name: UNCLEAR_ANSWERS })).toBeTruthy()

    // The open editor says the same about a location with no names, under the empty field.
    await openNamesEditor(names)
    const form = within(names).getByRole('form', { name: 'Edit names' })
    expect(namesBox(names).value).toBe('')
    expect(within(form).getByRole('button', { name: `${PROPERTY_NAMES_COPY.noNames}. ${PROPERTY_NAMES_COPY.noNamesDetail}` })).toBeTruthy()
    const shown = form.cloneNode(true) as HTMLElement
    for (const field of shown.querySelectorAll('textarea')) field.remove()
    expect(visibleText(shown)).toBe([
      PROPERTY_NAMES_COPY.names, PROPERTY_NAMES_COPY.perLine, PROPERTY_NAMES_COPY.noNames, PROPERTY_NAMES_COPY.qualifiedNames, PROPERTY_NAMES_COPY.perLine,
      PROPERTY_NAMES_COPY.save, PROPERTY_NAMES_COPY.cancel, PROPERTY_NAMES_COPY.draftOnly,
    ].join(''))
    expectLocationCopy(page)
  })

  it('shows a viewer the same empty labels with no action it cannot take', async () => {
    const page = await renderEmpty(VIEWER)

    expectLocationCopy(page)
    expect(visibleText(within(page).getByRole('region', { name: 'Queries about this location' }))).toBe('Queries about this location0No location queries')
    expect(visibleText(within(page).getByRole('region', { name: 'From its markets' }))).toBe('From its markets0In no market')
    expect(visibleText(within(page).getByRole('region', { name: PROPERTY_NAMES_COPY.heading }))).toBe(`${PROPERTY_NAMES_COPY.heading}0${PROPERTY_NAMES_COPY.noNames}`)
    expect(visibleText(within(page).getByRole('region', { name: 'Site pages we match' }))).toBe('Site pages we match0Read-onlyNo site pages')
    expect(within(page).queryByRole('link', { name: 'Open measurement setup' })).toBeNull()
    expect(within(page).queryByRole('button', { name: 'Add query about this location' })).toBeNull()
  })

  it('keeps the reason a type has no number one step away, beside the type control and under By engine', async () => {
    const page = await renderEmpty(VIEWER, '?queryClass=branded')

    const strip = within(page).getByLabelText('Query type').closest<HTMLElement>('.border-y')!
    expect(visibleText(strip)).toBe(`TypeNon-brandBranded${MEASURED_LINE} · Unclear answers`)
    expect(within(strip).getByRole('button', { name: UNCLEAR_ANSWERS })).toBeTruthy()
    expect(within(within(page).getByRole('region', { name: 'By engine' })).getByRole('button', {
      name: 'Not measured. No answer engine has measured branded queries for this location. No answer could be tied to one location.',
    })).toBeTruthy()
    expectLocationCopy(page)
  })

  it.each([{ role: 'a writer', account: ADMIN }, { role: 'a viewer', account: VIEWER }])('says Location and shows $role no sentence on a location no sweep has measured', async ({ account }) => {
    const { queryClient } = await renderPropertyPageFromApi(neverSweptResponses(), { account })
    await screen.findByRole('region', { name: 'Measurement next step' })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    const page = document.querySelector<HTMLElement>('.page-container')!

    expectLocationCopy(page)
    expect(visibleText(within(page).getByRole('region', { name: 'Measurement next step' }))).toBe(`Awaiting next sweep${account === ADMIN ? 'Go to' : 'View'} AI Visibility`)
    expect(visibleText(within(page).getByRole('region', { name: 'Answers' }))).toBe('AnswersNot measured')
    expect(visibleText(within(page).getByRole('region', { name: 'By engine' }))).toBe('By engineNot measured')
    // No answer was read, so no rival can have been named or not named.
    expect(visibleText(within(page).getByRole('region', { name: 'Named instead' }))).toBe('Named insteadNot measured')
    expect(within(page).queryByText(/^Tracking changed/)).toBeNull()
    // Nothing was measured, so there are no citations on other queries to list.
    expect(within(page).queryByRole('region', { name: OTHER_QUERIES_COPY.heading })).toBeNull()
  })

  it('opens every help bubble inside a 390px screen, however close its icon is to the left edge', async () => {
    const width = window.innerWidth
    const setWidth = (value: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value })
    setWidth(390)
    onTestFinished(() => { setWidth(width) })
    const page = await renderMeasured(ADMIN)
    await openNamesEditor(within(page).getByRole('region', { name: PROPERTY_NAMES_COPY.heading }))

    // jsdom lays nothing out, so every trigger sits at x = 0: the worst case for a bubble centred on its icon.
    const triggers = [...page.querySelectorAll<HTMLButtonElement>('button[aria-expanded][aria-label]')].filter(button => button.classList.contains('info-tooltip-trigger') || button.classList.contains('cursor-help'))
    expect(triggers.length).toBeGreaterThan(12)
    const leftEdges = triggers.map(trigger => {
      act(() => trigger.focus())
      const bubble = [...document.body.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].find(candidate => candidate.style.position === 'fixed')!
      // The bubble is 224px wide and drawn centred on `left`.
      const edge = parseFloat(bubble.style.left) - 112
      act(() => trigger.blur())
      return edge
    })
    expect(leftEdges.filter(edge => edge < 0)).toEqual([])
  })

  it('prints every figure the reads return, the tracked numbers first and the results in the order the page had them', async () => {
    // A row's Status and last sweep print a day of this year without its year, so today is fixed. Only the clock is faked.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
    onTestFinished(() => { vi.useRealTimers() })
    const page = await renderMeasured(VIEWER)
    const sweepDay = formatMonthDay(COMPLETED_AT).match(/\d+/g)!

    // Every number a reader sees, in page order: the rates never agree with a recount of the rows beside them
    // (four answers measured, one listed; three missed answers, four name counts; five location queries and
    // nine market queries counted, one of each listed), so each is the server's own.
    expect(visibleRuns(page).join(' ').match(/\d+(?:\.\d+)?%?/g)).toEqual([
      '2', // unclear links
      '75.0', '3', '4', '50.0', '2', '4', // Non-brand: Mentioned, Cited
      '50.0', '1', '2', '50.0', '1', '2', // Branded
      '5', '9', '1', '28', // Tracked for: location queries, market queries, markets, answers counted
      '5', ...sweepDay, // Queries about this location, and the day in its one row's Status
      '9', ...sweepDay, // From its markets, and its one row's last sweep
      '1', // site page
      '1', // name
      '50.0%', '1', '2', '50.0%', '1', '2', // By type: Branded
      '75.0%', '3', '4', '50.0%', '2', '4', // By type: Non-brand
      ...MEASURED_LINE.match(/\d+/g)!, // Measured Aug 2, 2026, as the reader's own timezone dates it
      '50.0%', '1', '2', '0%', '0', '2', // Gemini
      '100%', '2', '2', '100%', '2', '2', // OpenAI
      '2', // named
      '3', '1', '1', '1', // Harborline Homes: answers, queries. The Sutton: answers, queries.
      '3', '4', // Missed answers
      '2', // competitors
      '1', '1', // answers shown of total
      '1', // sources
      '1', // answer cited on other queries
    ])
  })

  it('names the filters it cannot apply as a short label, with the engine and the search location in its help', async () => {
    await renderPropertyPageFromApi(propertyPageResponses(), { search: '?queryClass=non-brand&measurementProvider=openai&measurementLocation=Harborside' })

    // It ends the header line that names the location's market and group.
    const subtitle = (await screen.findByText('Market:')).closest<HTMLElement>('.page-subtitle')!
    expect(visibleText(subtitle)).toBe('Market:North coastGroup:NorthFilters not applied')
    expect(within(subtitle).getByRole('button', {
      name: 'AI Visibility is filtered to the OpenAI answer engine, search location Harborside. This page shows the latest measurement for all markets and answer engines.',
    })).toBeTruthy()
  })

  it('counts one unclear link in the singular', async () => {
    const nonBrand = overviewResponse('non-brand', { mentionCoverage: available(3, 4), citationCoverage: available(2, 4) })
    nonBrand.properties.items[0]!.flags = 1
    await renderPropertyPageFromApi(propertyPageResponses({ nonBrand }))

    expect(await screen.findByText('1 unclear link')).toBeTruthy()
  })

  it('says once that a location has never been swept, beside the type control', async () => {
    const never = (queryClass: 'branded' | 'non-brand') => {
      const response = overviewResponse(queryClass, { mentionCoverage: unavailable('no_completed_run'), citationCoverage: unavailable('no_completed_run') }, { measurementState: 'not_measured', nextAction: 'run_measurement' })
      return { ...response, measurement: { ...response.measurement, completedAt: null } }
    }
    await renderPropertyPage({ branded: never('branded') as never, nonBrand: never('non-brand') as never })

    // The sweep date and the type's own reason are the same words here.
    const strip = (await screen.findByLabelText('Query type')).closest<HTMLElement>('.border-y')!
    expect(within(strip).getByText('No completed sweep yet')).toBeTruthy()
  })

  it('says the page could not load and reads all three again on Retry', async () => {
    let failing = true
    const reads: string[] = []
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.endsWith('/measurement-plan') || path.includes('/measurement-overview')) {
        reads.push(path.endsWith('/measurement-plan') ? 'plan' : new URL(url).searchParams.get('queryClass')!)
        if (failing) return serverError()
      }
      return propertyPageResponses()(url)
    })

    expect((await screen.findByRole('alert')).textContent).toBe('Could not load')
    expect(screen.getByRole('button', { name: 'Could not load. This location did not load.' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    failing = false
    reads.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Retry location' }))

    expect(await screen.findByRole('heading', { name: 'Harbor House', level: 1 })).toBeTruthy()
    expect([...reads].sort()).toEqual(['branded', 'non-brand', 'plan'])
  })

  const notPublished = 'A location page needs a published advanced measurement setup.'
  it.each<{ state: string; plan: () => unknown; label: string; detail: string; link: string; account?: SignedInAccount }>([
    { state: 'has an older published setup', plan: legacyPlanResponse, label: 'Setup not published', detail: notPublished, link: 'Republish setup' },
    { state: 'has no published setup', plan: () => ({ active: null }), label: 'Setup not published', detail: notPublished, link: 'Open measurement setup' },
    { state: 'has no published setup, for a viewer', plan: () => ({ active: null }), label: 'Setup not published', detail: notPublished, link: 'View measurement setup', account: VIEWER },
    { state: 'is not in the published setup', plan: () => { const plan = planResponse(); plan.active.plan.targets = []; return plan }, label: 'Location not found', detail: 'This location is not in the published setup. It may have been renamed or removed.', link: 'Open measurement setup' },
  ])('says so in a label with one link to setup when the location $state', async ({ plan, label, detail, link, account = ADMIN }) => {
    const paths: string[] = []
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      paths.push(pathOf(url))
      return pathOf(url).endsWith('/measurement-plan') ? jsonResponse(plan()) : propertyPageResponses()(url)
    }, { account })

    expect(await screen.findByRole('button', { name: `${label}. ${detail}` })).toBeTruthy()
    // With no location to list, the page reads neither its tracked queries nor their results.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(paths.filter(path => path.includes('/query-tracking'))).toEqual([])
    expect(screen.getByRole('status').textContent).toBe(label)
    expect(screen.getByRole('link', { name: link }).getAttribute('href')).toBe(`/projects/${encodeURIComponent(projectName)}/portfolio`)
    // One action beside the label, and the way back above it.
    expect(within(document.querySelector<HTMLElement>('.page-container')!).getAllByRole('link').map(each => each.textContent)).toEqual(['Back to AI Visibility', link])
  })

  it('offers the type retry in every section that reads the failed type, and announces the failure once', async () => {
    let brandedAttempts = 0
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'branded') {
        brandedAttempts += 1
        return brandedAttempts === 1
          ? serverError()
          : jsonResponse(overviewResponse('branded', { mentionCoverage: available(2, 2), citationCoverage: available(2, 2), providers }))
      }
      return propertyPageResponses()(url)
    }, { search: '?queryClass=branded' })

    const engines = await screen.findByRole('region', { name: 'By engine' })
    await within(engines).findByText('Load failed')
    const answers = screen.getByRole('region', { name: 'Answers' })
    expect(visibleText(answers)).toBe('AnswersLoad failedRetry')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Retry branded queries' })).toHaveLength(3)

    fireEvent.click(within(engines).getByRole('button', { name: 'Retry branded queries' }))
    expect(await within(engines).findByRole('table', { name: 'Per-engine mention and citation coverage' })).toBeTruthy()
    expect(brandedAttempts).toBe(2)
    expect(screen.queryByText('Load failed')).toBeNull()
  })

  it.each([
    {
      state: 'not measured', label: 'Not measured', detail: 'Run a measurement to collect the answers for this location.', alert: false,
      evidence: () => ({ ...evidenceResponse([]), measurement: { state: 'not_measured' as const, displayedRunId: RUN_ID } }),
    },
    {
      state: 'returned in an older format', label: 'Answers unavailable', alert: true,
      detail: 'This measurement was returned in an older format, so the answers cannot be shown here. The numbers above are unaffected.',
      evidence: () => { const { answers: _answers, ...older } = evidenceResponse(); return older },
    },
    { state: 'empty', label: 'No answers', detail: 'No answers matched this location in the displayed measurement.', alert: false, evidence: () => evidenceResponse([]) },
  ])('shows a label, not a sentence, when the answers are $state', async ({ label, detail, alert, evidence }) => {
    let reads = 0
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'answers') {
        reads += 1
        return jsonResponse(reads === 1 ? evidence() : evidenceResponse())
      }
      return propertyPageResponses()(url)
    })

    const answers = await screen.findByRole('region', { name: 'Answers' })
    expect(await within(answers).findByRole('button', { name: `${label}. ${detail}` })).toBeTruthy()
    // Only the failure has something to do about it: read the answers again.
    expect(visibleText(answers)).toBe(`Answers${label}${alert ? 'Retry' : ''}`)
    expect(within(answers).queryAllByRole('alert')).toHaveLength(alert ? 1 : 0)
    expect(within(answers).queryByRole('table')).toBeNull()
    if (!alert) return
    fireEvent.click(within(answers).getByRole('button', { name: 'Retry answers' }))
    expect(within(await answersTable()).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(reads).toBe(2)
  })

  it('says the answers did not load and reads them again on Retry', async () => {
    let attempts = 0
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'answers') {
        attempts += 1
        if (attempts === 1) return serverError()
      }
      return propertyPageResponses()(url)
    })

    const answers = await screen.findByRole('region', { name: 'Answers' })
    expect((await within(answers).findByRole('alert')).textContent).toBe('Load failed')
    fireEvent.click(within(answers).getByRole('button', { name: 'Retry answers' }))

    expect(within(await answersTable()).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(attempts).toBe(2)
  })

  it('says an opened answer did not load and reads it again on Retry', async () => {
    let attempts = 0
    await renderPropertyPageFromApi(url => {
      if (pathOf(url).includes('/measurement-question-result')) {
        attempts += 1
        if (attempts === 1) return serverError()
      }
      return propertyPageResponses()(url)
    })

    const evidence = await answersTable()
    fireEvent.click(within(evidence).getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    expect((await within(evidence).findByRole('alert')).textContent).toBe('Load failed')
    fireEvent.click(within(evidence).getByRole('button', { name: 'Retry answer' }))

    expect(await within(evidence).findByText(/Harborline Homes and The Sutton/)).toBeTruthy()
    expect(attempts).toBe(2)
  })

  it('says what was not saved for an answer with no stored text and no captured sources', async () => {
    await renderPropertyPageFromApi(async url => {
      const response = propertyPageResponses({ evidence: evidenceResponse([answerRow({ slot: 'nearby', cited: null, sources: [] })]) })(url)
      return pathOf(url).includes('/measurement-question-result') ? jsonResponse({ ...await response.json(), answer: null }) : response
    })

    const evidence = await answersTable()
    fireEvent.click(within(evidence).getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    expect(await within(evidence).findByRole('button', { name: 'Text not saved. This answer was measured, but its text was not stored.' })).toBeTruthy()
    // The row says it where its source count would be, and the opened detail says it again in the same words.
    expect(within(evidence).getAllByRole('button', { name: 'Sources not saved. The sources for this answer were not fully captured, so none can be shown.' })).toHaveLength(2)
    expect(visibleText(evidence.querySelector<HTMLElement>('.property-answer-detail')!)).toBe('Text not savedSources not saved')
  })
})

describe('What the location is tracked for', () => {
  it('heads the page with the location, its market as a link to Queries narrowed to it, and its group', async () => {
    const { projectName } = await renderPropertyPageFromApi(propertyPageResponses(), { account: VIEWER, search: '?queryClass=non-brand' })
    const header = (await screen.findByRole('heading', { name: 'Harbor House', level: 1 })).closest<HTMLElement>('.page-header')!

    const market = await within(header).findByRole('link', { name: 'North coast' })
    const href = new URL(market.getAttribute('href')!, window.location.origin)
    expect(href.pathname).toBe(`/projects/${encodeURIComponent(projectName)}/queries`)
    // Queries narrowed to that market, on its Tracked list. The type the results were on is carried along.
    expect(Object.fromEntries(href.searchParams)).toEqual({ measurementScope: 'market', measurementScopeKey: 'north-coast', queryWorkspace: 'tracked', queryClass: 'non-brand' })
    const subtitle = header.querySelector<HTMLElement>('.page-subtitle')!
    expect(visibleText(subtitle)).toBe('Market:North coastGroup:North')
    // From sm that line is as wide as the header, not the name's column beside the badges and the button, so a
    // long list of markets runs on under them.
    const rules = parseCompiledCss(await compileAppStyles([...header.classList, ...subtitle.classList]))
    expect(compiledElementProperty(rules, header, 'container-type')).toBe('inline-size')
    expect([compiledElementProperty(rules, subtitle, 'width'), compiledElementProperty(rules, subtitle, 'width', '@media (width >= 40rem)')]).toEqual([undefined, '100cqw'])
    // The state of the measurement stays in the header, with the one way back above the name.
    expect(within(header).getByText('Measured')).toBeTruthy()
    expect(within(header).getAllByRole('link').map(link => link.textContent)).toEqual(['Back to AI Visibility', 'North coast'])
  })

  it('puts what the location is matched by beside the tracked section only, and every result section under them at the page\'s full width', async () => {
    await renderPropertyPageFromApi(propertyPageResponses(), { account: ADMIN })
    await answersTable()
    await screen.findByRole('table', { name: 'Market queries' })
    const page = document.querySelector<HTMLElement>('.page-container')!

    // One grid holds the tracked section and the side panel: two columns, the panel 20rem, from a 68rem frame.
    const grid = within(page).getByRole('region', { name: 'Queries about this location' }).closest<HTMLElement>('.grid')!
    for (const name of ['From its markets', 'Site pages we match', PROPERTY_NAMES_COPY.heading]) expect(grid.contains(within(page).getByRole('region', { name }))).toBe(true)
    const rules = parseCompiledCss(await compileAppStyles([...grid.classList, ...grid.parentElement!.classList]))
    expect(compiledElementProperty(rules, grid.parentElement!, 'container-type')).toBe('inline-size')
    expect(compiledElementProperty(rules, grid, 'grid-template-columns')).toBeUndefined()
    expect(compiledElementProperty(rules, grid, 'grid-template-columns', '@container (width >= 68rem)')).toBe('minmax(0,1fr) 20rem')

    // The coverage rows lead, above the grid. Every result section follows it, outside it, so none is narrowed by the
    // panel: the answers table's phone layout starts under a 52rem frame, and the page column is 72rem.
    const results = within(page).getByRole('heading', { name: 'Results', level: 2 })
    const follows = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(within(page).getByRole('region', { name: 'Coverage for this location' }), grid)).toBe(true)
    expect(follows(grid, results)).toBe(true)
    for (const name of ['By type', 'By engine', 'Named instead', 'Competitors by market', 'Answers', OTHER_QUERIES_COPY.heading]) {
      const section = within(page).getByRole('region', { name })
      expect([grid.contains(section), follows(results, section)]).toEqual([false, true])
    }
    const answers = within(page).getByRole('region', { name: 'Answers' })
    expect(answers.parentElement).toBe(page)
    expect(compiledElementProperty(parseCompiledCss(await compileAppStyles(['page-container'])), page, 'max-width')).toBe('var(--container-6xl)')
  })

  it('dates the tracking change from the published setup, beside the legend, when the last sweep came before it', async () => {
    // The page's own reads name no tracking change here, so its header has no note and the tracked section keeps its own.
    await renderPropertyPageFromApi(url => new URL(url).pathname.endsWith('/query-tracking/results')
      ? jsonResponse(trackingResults({ run: { ...trackingResults().run!, matchesCurrentTracking: false } }))
      : propertyPageResponses()(url))

    // The setup was published on Aug 1 and the sweep ran on Aug 2: the server says which came first, never the dates.
    const changedOn = formatObservedInstantMonthDay(observedInstant(planResponse().active.createdAt))
    const sweptOn = formatObservedInstantMonthDay(observedInstant(COMPLETED_AT))
    await screen.findByRole('table', { name: 'Location queries' })
    const tracked = screen.getByRole('region', { name: 'Queries about this location' })
    const note = await within(tracked).findByRole('button', { name: `Tracking changed ${changedOn}. Showing the ${sweptOn} results, from before the change. New numbers after the next sweep.` })
    expect(note.textContent).toBe(`Tracking changed ${changedOn}`)
    expect(screen.getAllByText(/^Tracking changed/)).toHaveLength(1)
  })

  it('names no date for the tracking change on a managed dashboard, as AI Visibility and Queries name none there', async () => {
    const previousConfig = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { ...previousConfig, dashboard: { managedSweeps: true } }
    onTestFinished(() => {
      if (previousConfig === undefined) delete window.__CANONRY_CONFIG__
      else window.__CANONRY_CONFIG__ = previousConfig
    })
    await renderPropertyPageFromApi(url => new URL(url).pathname.endsWith('/query-tracking/results')
      ? jsonResponse(trackingResults({ run: { ...trackingResults().run!, matchesCurrentTracking: false } }))
      : propertyPageResponses()(url), { account: VIEWER })

    const sweptOn = formatObservedInstantMonthDay(observedInstant(COMPLETED_AT))
    await screen.findByRole('table', { name: 'Location queries' })
    const note = await within(screen.getByRole('region', { name: 'Queries about this location' })).findByRole('button', { name: `Tracking changed. Showing the ${sweptOn} results, from before the change. New numbers after the next sweep.` })
    expect(note.textContent).toBe('Tracking changed')
    expect(screen.getAllByText(/^Tracking changed/)).toHaveLength(1)
  })

  it('lists each location from the top: a market opened further on one location is cut again on the next', async () => {
    const OTHER = { stableKey: 'other-house', label: 'Other House' }
    const plan = planResponse()
    plan.active.plan.targets.push({ ...plan.active.plan.targets[0]!, ...OTHER, aliases: [OTHER.label] })
    // Both locations are in the one market and take its eleven queries.
    const both = [TARGET_KEY, OTHER.stableKey].map(targetKey => ({ targetKey, groupKeys: ['north'], marketKeys: ['north-coast'], queryClass: 'non-brand', classificationSource: 'server', contexts: [TRACKING_CONTEXT] }))
    const workspace = trackingWorkspace({
      targets: [TARGET_KEY, OTHER.stableKey].map(stableKey => ({ stableKey, label: stableKey === TARGET_KEY ? 'Harbor House' : OTHER.label, marketKeys: ['north-coast'], counts: TRACKING_COUNTS })),
      markets: [{ stableKey: 'north-coast', label: 'North coast', groupKey: 'north', usageEdges: [NEARBY_EDGE], targetKeys: [TARGET_KEY, OTHER.stableKey] }],
      tracked: Array.from({ length: 11 }, (_, index) => trackedQuery(`query-coast-${index}`, `north coast stays ${String(index + 1).padStart(2, '0')}`, { kind: 'market', key: 'north-coast' }, 'non-brand', { assignments: both })),
    })
    const { router, projectName } = await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.endsWith('/query-tracking')) return jsonResponse(workspace)
      if (path.endsWith('/measurement-plan')) return jsonResponse(plan)
      return propertyPageResponses()(url)
    }, { account: VIEWER })
    const listed = () => within(screen.getByRole('table', { name: 'Market queries' })).getAllByText(/^north coast stays \d+$/).length

    await screen.findByRole('table', { name: 'Market queries' })
    expect(listed()).toBe(8)
    fireEvent.click(screen.getByRole('button', { name: '+ 3 more queries in North coast' }))
    expect(listed()).toBe(11)
    expect(screen.getByRole('button', { name: 'Show fewer queries in North coast' })).toBeTruthy()

    await act(async () => { await router.navigate({ to: '/projects/$projectName/properties/$targetKey', params: { projectName, targetKey: OTHER.stableKey } }) })
    await screen.findByRole('heading', { name: OTHER.label, level: 1 })
    await screen.findByRole('table', { name: 'Market queries' })
    expect(listed()).toBe(8)
    expect(screen.getByRole('button', { name: '+ 3 more queries in North coast' })).toBeTruthy()
  })

  it('says the tracked queries could not load beside results that still render, and reads them again on Retry', async () => {
    let failing = true
    await renderPropertyPageFromApi(url => failing && new URL(url).pathname.endsWith('/query-tracking') ? serverError() : propertyPageResponses()(url), { account: VIEWER })

    const retry = await screen.findByRole('button', { name: 'Retry tracked queries' })
    expect(retry.closest('[role="alert"]')!.textContent).toBe('Could not loadRetry')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // The header names no market, and everything under Results is drawn as it was.
    expect(screen.queryByText('Market:')).toBeNull()
    expect(within(await answersTable()).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(screen.getByRole('table', { name: 'Mention and citation coverage for this location, by query type' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Site pages we match' })).toBeTruthy()

    failing = false
    fireEvent.click(retry)
    expect(await screen.findByRole('table', { name: 'Location queries' })).toBeTruthy()
    expect(await screen.findByText('Market:')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('After a tracking change', () => {
  const TYPE_TABLE = 'Mention and citation coverage for this location, by query type'
  const ENGINE_TABLE = 'Per-engine mention and citation coverage'
  const providers = [
    { provider: 'gemini', mentionCoverage: skewed(0.2, 3, 4), citationCoverage: skewed(0.1, 1, 4) },
    { provider: 'openai', mentionCoverage: skewed(0.6, 2, 4), citationCoverage: skewed(0.3, 2, 4) },
  ]
  const otherQuery: OtherQueryRow = {
    observationId: 'obs-marina', expectedSlotId: 'slot-marina', executionId: 'exec-marina', provider: 'gemini', queryText: 'quiet stays by the marina', location: null, queryClass: 'non-brand',
    assignedTargetKeys: [TARGET_KEY], sources: [{ sourceUrl: `${OWN_URL}/amenities`, normalizedUrl: `${OWN_URL}/amenities`, matchedUrlIds: [`${TARGET_KEY}:url:0`] }],
    sourceCount: 1, sourcesTruncated: false, evidenceComplete: true,
  }
  /** The last sweep's numbers for both types. No rate agrees with the counts beside it. */
  const measured = {
    nonBrand: overviewResponse('non-brand', { mentionCoverage: skewed(0.375, 5, 8), citationCoverage: skewed(0.125, 3, 8), providers }),
    branded: overviewResponse('branded', { mentionCoverage: skewed(0.9, 4, 6), citationCoverage: skewed(0.7, 2, 6) }),
  }
  /** A type the last sweep asked nothing of for this location. */
  const notAsked = (queryClass: 'branded' | 'non-brand') => overviewResponse(queryClass, { mentionCoverage: unavailable('no_population'), citationCoverage: unavailable('no_population') })
  /** The published setup with a query of each type for Harbor House. The fixture's own has only a non-brand one. */
  function planWithBothTypes() {
    const plan = planResponse()
    plan.active.plan.assignments.push({ targetKey: TARGET_KEY, queryId: 'query-own', queryClass: 'branded' as never, executionNodeKey: 'node-own' })
    return plan
  }

  /** Harbor House as fallback reads answer for it after a tracking change, with every request recorded. */
  async function renderAfterChange(options: {
    account?: SignedInAccount
    fields?: Partial<typeof AWAITING_SWEEP>
    overviews?: Parameters<typeof propertyPageResponses>[0]
    plan?: ReturnType<typeof planResponse>
    /** Reads this handler answers come before the page's own. */
    first?: (url: string) => Response | undefined
  } = {}) {
    const requests: URL[] = []
    const page = propertyPageResponses(options.overviews ?? measured)
    const responses = afterTrackingChange(url => {
      const path = pathOf(url)
      const first = options.first?.(url)
      if (first) return first
      if (path.endsWith('/measurement-plan') && options.plan) return jsonResponse(options.plan)
      if (path.includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'other-queries') return jsonResponse(otherQueriesResponse([otherQuery]))
      return page(url)
    }, options.fields)
    const rendered = await renderPropertyPageFromApi(url => {
      requests.push(new URL(url))
      return responses(url)
    }, { account: options.account ?? ADMIN })
    const header = (await screen.findByRole('heading', { name: 'Harbor House', level: 1 })).closest<HTMLElement>('.page-header')!
    await within(header).findByRole('status')
    await screen.findByRole('table', { name: 'Location queries' })
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0))
    return { ...rendered, requests, header, page: document.querySelector<HTMLElement>('.page-container')! }
  }

  /** The figure cells of one row of a results table, as a reader sees them. */
  const figures = (page: HTMLElement, table: string, row: string) => [...within(within(page).getByRole('table', { name: table })).getByText(row).closest('tr')!.querySelectorAll('td')].slice(1).map(cell => visibleText(cell as HTMLElement))
  /** Each coverage row at the top of the page: its value, then its count or its reason. */
  const heroRows = (page: HTMLElement) => [...within(page).getByRole('region', { name: 'Coverage for this location' }).querySelectorAll('.aeo-hero-row')]
    .map(row => [row.querySelector('.aeo-hero-row-value')!.textContent, row.querySelector('.aeo-hero-row-detail')!.textContent])

  it.each([{ role: 'a writer', account: ADMIN }, { role: 'a viewer', account: VIEWER }])('shows $role the last sweep in every section, under one note beside the state', async ({ account }) => {
    const { header, page, requests } = await renderAfterChange({ account })
    const answers = await answersTable()
    const named = within(page).getByRole('region', { name: 'Named instead' })
    const other = within(page).getByRole('region', { name: OTHER_QUERIES_COPY.heading })

    // One note on the page, in the header after the state, which is the sweep's own. Its date is the server's:
    // the plan fixture was published on another day. The sentence is its help and its name, never on screen.
    const note = within(header).getByRole('status')
    expect(visibleText(note)).toBe(`Tracking changed ${CHANGED_ON}`)
    expect(within(note).getByRole('button', { name: `Tracking changed ${CHANGED_ON}. ${TRACKING_CHANGED_HELP}` }).classList.contains('text-caution')).toBe(true)
    expect(note.previousElementSibling!.textContent).toBe('Measured')
    expect(within(page).getAllByText(/^Tracking changed/)).toHaveLength(1)
    expectLocationCopy(page)

    // Every figure is a field of the reads: none of these rates is its count over its total.
    expect(heroRows(page)).toEqual([['37.5%', '5 of 8'], ['12.5%', '3 of 8'], ['90.0%', '4 of 6'], ['70.0%', '2 of 6']])
    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['37.5%5 of 8', '12.5%3 of 8'])
    expect(figures(page, TYPE_TABLE, 'Branded')).toEqual(['90.0%4 of 6', '70.0%2 of 6'])
    expect(figures(page, ENGINE_TABLE, 'Gemini')).toEqual(['20.0%3 of 4', '10.0%1 of 4'])
    expect(figures(page, ENGINE_TABLE, 'OpenAI')).toEqual(['60.0%2 of 4', '30.0%2 of 4'])
    expect([...within(named).getByRole('table').querySelectorAll('tbody tr')].map(row => visibleText(row as HTMLElement))).toEqual(['Harborline Homes3OpenAI, Gemini1', 'The Sutton1Gemini1'])
    expect(within(named).getByText('Missed answers').nextElementSibling!.textContent).toBe('3 of 4 · Non-brand')
    expect(within(answers).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(within(other).getByText('quiet stays by the marina')).toBeTruthy()
    expect(within(page).getByText(`Measured ${formatObservedInstantLabel(observedInstant(SWEPT_AT))} · Non-brand only`)).toBeTruthy()
    // Nothing blanks, nothing points elsewhere for these numbers, and no report is read to find them.
    expect(visibleText(page)).not.toContain('Not measured')
    expect(within(page).queryByRole('region', { name: 'Measurement next step' })).toBeNull()
    expect(within(page).queryByRole('link', { name: 'See the last results' })).toBeNull()
    expect(requests.filter(request => request.pathname.includes('/visibility-report'))).toEqual([])

    // A row of that sweep opens, under Answers and under Cited on other queries.
    fireEvent.click(within(answers).getByRole('button', { name: `Read the answer for ${NEARBY_QUESTION}` }))
    fireEvent.click(within(other).getByRole('button', { name: 'Read the answer for quiet stays by the marina' }))
    await waitFor(() => expect(within(page).getAllByText(/Harborline Homes and The Sutton/)).toHaveLength(2))

    // Every results read asks for the last sweep, and the two lists name the sweep the numbers are from.
    const reads = requests.filter(request => /\/measurement-(?!plan)/.test(request.pathname)).map(request => [
      request.pathname.split('/').pop(),
      request.searchParams.get('shape') ?? request.searchParams.get('queryClass') ?? request.searchParams.get('resultId'),
      request.searchParams.get('fallback'),
      request.searchParams.get('runId') ?? 'no run',
    ].join(' · '))
    expect([...new Set(reads)].sort()).toEqual([
      'measurement-overview · branded · last-sweep · no run',
      'measurement-overview · non-brand · last-sweep · no run',
      'measurement-property-competitors · non-brand · last-sweep · no run',
      `measurement-property-evidence · answers · last-sweep · ${LAST_SWEEP_RUN}`,
      `measurement-property-evidence · other-queries · last-sweep · ${LAST_SWEEP_RUN}`,
      'measurement-question-result · obs-marina · last-sweep · no run',
      'measurement-question-result · obs-nearby · last-sweep · no run',
    ])

    // A viewer reads the same page with nothing to write with.
    expect(within(page).queryByRole('button', { name: 'Add query about this location' }) !== null).toBe(account === ADMIN)
    expect(within(page).queryAllByRole('button', { name: /^Actions for / }).length > 0).toBe(account === ADMIN)
    expect(within(page).queryByRole('button', { name: PROPERTY_NAMES_COPY.edit }) !== null).toBe(account === ADMIN)
  })

  it('names no date for the change when the server sends none', async () => {
    const { header, page } = await renderAfterChange({ fields: { trackingChangedAt: undefined } })

    const note = within(header).getByRole('status')
    expect(visibleText(note)).toBe('Tracking changed')
    expect(within(note).getByRole('button', { name: `Tracking changed. ${TRACKING_CHANGED_HELP}` })).toBeTruthy()
    expect(within(page).getAllByText(/^Tracking changed/)).toHaveLength(1)
  })

  it('names no date for the change on a managed dashboard, as AI Visibility and Queries name none there', async () => {
    const previousConfig = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { ...previousConfig, dashboard: { managedSweeps: true } }
    onTestFinished(() => {
      if (previousConfig === undefined) delete window.__CANONRY_CONFIG__
      else window.__CANONRY_CONFIG__ = previousConfig
    })
    const { header, page } = await renderAfterChange({ account: VIEWER })

    expect(visibleText(within(header).getByRole('status'))).toBe('Tracking changed')
    expect(within(page).getAllByText(/^Tracking changed/)).toHaveLength(1)
    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['37.5%5 of 8', '12.5%3 of 8'])
  })

  it('reads Not measured with no note for a location no sweep has measured', async () => {
    const { queryClient } = await renderPropertyPageFromApi(neverSweptResponses(), { account: ADMIN })
    await screen.findByRole('region', { name: 'Measurement next step' })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    const page = document.querySelector<HTMLElement>('.page-container')!

    // The server says a sweep is awaited here too. With no measured setup there is no older sweep on screen to mark.
    expect(within(page).queryByText(/^Tracking changed/)).toBeNull()
    expect(within(page.querySelector<HTMLElement>('.page-header')!).getByText('Not measured')).toBeTruthy()
    expect(heroRows(page)).toEqual(Array.from({ length: 4 }, () => ['Not measured', 'No completed sweep yet']))
    for (const type of ['Non-brand', 'Branded']) expect(figures(page, TYPE_TABLE, type)).toEqual(['Not measuredNo completed sweep yet', 'Not measuredNo completed sweep yet'])
    for (const section of ['By engine', 'Named instead', 'Answers']) expect(visibleText(within(page).getByRole('region', { name: section }))).toBe(`${section}Not measured`)
    expect(within(page).queryByText('Not in last sweep')).toBeNull()
    expect(within(within(page).getByRole('region', { name: 'Measurement next step' })).getByRole('link', { name: 'Go to AI Visibility' })).toBeTruthy()
  })

  it('says Not in last sweep, in all five places, for a location added since that sweep', async () => {
    // The last sweep's setup did not hold this location: no number of either type, no engine, no answer and
    // no basis, each under the reason "no population". The published setup asks it queries of both types.
    const { header, page } = await renderAfterChange({
      plan: planWithBothTypes(),
      overviews: { nonBrand: notAsked('non-brand'), branded: notAsked('branded') },
      first: url => {
        const path = pathOf(url)
        if (path.includes('/measurement-property-evidence')) return jsonResponse(new URL(url).searchParams.get('shape') === 'answers' ? evidenceResponse([]) : otherQueriesResponse([]))
        if (path.includes('/measurement-property-competitors')) return jsonResponse({ ...competitorsResponse([]), basis: { state: 'unavailable', reason: 'no_population' } })
        return undefined
      },
    })
    await within(await screen.findByRole('region', { name: 'Answers' })).findByText('Not in last sweep')
    await screen.findByRole('region', { name: 'Named instead' })

    // The header still says which sweep this is, and that sweep was measured.
    expect(visibleText(within(header).getByRole('status'))).toBe(`Tracking changed ${CHANGED_ON}`)
    expect(within(header).getByText('Measured')).toBeTruthy()
    // 1 and 2: the coverage rows and the type table, for each type.
    expect(heroRows(page)).toEqual(Array.from({ length: 4 }, () => ['Not measured', 'Not in last sweep']))
    for (const type of ['Non-brand', 'Branded']) expect(figures(page, TYPE_TABLE, type)).toEqual(['Not measuredNot in last sweep', 'Not measuredNot in last sweep'])
    // 3 to 5: By engine, Named instead and Answers, for the type on screen. None of them reports a measured nothing.
    for (const section of ['By engine', 'Named instead', 'Answers']) {
      const region = within(page).getByRole('region', { name: section })
      expect(visibleText(region)).toBe(`${section}Not measuredNot in last sweep`)
      expect(within(region).getByRole('button', { name: NOT_IN_LAST_SWEEP })).toBeTruthy()
    }
    // Beside the type control too, where the reason for a type with no number is said once.
    expect(visibleText(within(page).getByLabelText('Query type').closest<HTMLElement>('.border-y')!)).toBe(`TypeNon-brandBrandedMeasured ${formatObservedInstantLabel(observedInstant(SWEPT_AT))} · Not in last sweep`)
    // Twelve in all, each with the sweep's day and when numbers come in its help. It is a wait, not a fault.
    expect(within(page).getAllByRole('button', { name: NOT_IN_LAST_SWEEP })).toHaveLength(12)
    expect(within(page).queryByRole('alert')).toBeNull()
    for (const wrong of ['None named', 'No answers', 'No queries tracked', 'No completed sweep yet']) expect(within(page).queryByText(wrong)).toBeNull()
    expectLocationCopy(page)
    expect(within(page).queryByRole('region', { name: 'Measurement next step' })).toBeNull()
  })

  it('says Not in last sweep for the type added since, and keeps the other type\'s numbers apart', async () => {
    const { page } = await renderAfterChange({
      plan: planWithBothTypes(),
      overviews: { nonBrand: notAsked('non-brand'), branded: measured.branded },
      first: url => {
        const path = pathOf(url)
        if (path.includes('/measurement-property-evidence') && new URL(url).searchParams.get('shape') === 'answers') return jsonResponse(evidenceResponse([]))
        if (path.includes('/measurement-property-competitors')) return jsonResponse({ ...competitorsResponse([]), basis: { state: 'unavailable', reason: 'no_population' } })
        return undefined
      },
    })
    await within(await screen.findByRole('region', { name: 'Answers' })).findByText('Not in last sweep')

    // Non-brand waits for its first sweep. Branded is that sweep's own, and neither borrows from the other.
    expect(heroRows(page)).toEqual([['Not measured', 'Not in last sweep'], ['Not measured', 'Not in last sweep'], ['90.0%', '4 of 6'], ['70.0%', '2 of 6']])
    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['Not measuredNot in last sweep', 'Not measuredNot in last sweep'])
    expect(figures(page, TYPE_TABLE, 'Branded')).toEqual(['90.0%4 of 6', '70.0%2 of 6'])
    expect(within(page).queryByText('No queries tracked')).toBeNull()
  })

  it('keeps No queries tracked for a type this location has no query of, whatever the sweep on screen', async () => {
    // The published setup asks Harbor House no branded query, so the last sweep did not leave one out.
    const { page } = await renderAfterChange({ overviews: { nonBrand: measured.nonBrand, branded: notAsked('branded') } })

    expect(figures(page, TYPE_TABLE, 'Branded')).toEqual(['Not measuredNo queries tracked', 'Not measuredNo queries tracked'])
    expect(heroRows(page).slice(2)).toEqual([['Not measured', 'No queries tracked'], ['Not measured', 'No queries tracked']])
    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['37.5%5 of 8', '12.5%3 of 8'])
    expect(within(page).queryByText('Not in last sweep')).toBeNull()
  })

  it('keeps a reason of its own for a type the last sweep did ask', async () => {
    // Non-brand was asked in that sweep and its answers could not be read: that is not a sweep that left it out.
    const { page } = await renderAfterChange({
      overviews: { nonBrand: overviewResponse('non-brand', { mentionCoverage: unavailable('identity_ambiguous'), citationCoverage: unavailable('evidence_incomplete') }), branded: measured.branded },
    })

    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['Not measuredUnclear answers', 'Not measuredEvidence incomplete'])
    expect(heroRows(page).slice(0, 2)).toEqual([['Not measured', 'Unclear answers'], ['Not measured', 'Evidence incomplete']])
    expect(within(page).queryByText('Not in last sweep')).toBeNull()
  })

  it('moves to the new sweep when one completes, with no reload: new numbers, and the note clears', async () => {
    let swept = false
    const NEW_RUN = 'run-after-change'
    /** A read once a sweep of the published setup has completed: its own run, and nothing awaited. */
    const current = <T extends { measurement: object }>(response: T): T => ({ ...response, measurement: { ...response.measurement, displayedRunId: NEW_RUN, ...AWAITING_SWEEP, measuredRevision: 7, awaitingSweep: false } })
    const after = propertyPageResponses({
      nonBrand: current(overviewResponse('non-brand', { mentionCoverage: skewed(0.625, 6, 8), citationCoverage: skewed(0.25, 4, 8), providers })),
      branded: current(overviewResponse('branded', { mentionCoverage: skewed(0.8, 5, 6), citationCoverage: skewed(0.5, 3, 6) })),
    })
    const before = afterTrackingChange(propertyPageResponses(measured))
    const requests: URL[] = []
    const { queryClient, projectName } = await renderPropertyPageFromApi(url => {
      requests.push(new URL(url))
      return swept ? after(url) : before(url)
    }, { account: VIEWER })
    const header = (await screen.findByRole('heading', { name: 'Harbor House', level: 1 })).closest<HTMLElement>('.page-header')!
    expect(visibleText(await within(header).findByRole('status'))).toBe(`Tracking changed ${CHANGED_ON}`)
    await answersTable()
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    const page = document.querySelector<HTMLElement>('.page-container')!
    expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['37.5%5 of 8', '12.5%3 of 8'])

    swept = true
    requests.length = 0
    act(() => { invalidateQueriesForRunKind(queryClient, RunKinds['answer-visibility'], projectName) })

    await waitFor(() => expect(figures(page, TYPE_TABLE, 'Non-brand')).toEqual(['62.5%6 of 8', '25.0%4 of 8']))
    expect(figures(page, TYPE_TABLE, 'Branded')).toEqual(['80.0%5 of 6', '50.0%3 of 6'])
    expect(heroRows(page)).toEqual([['62.5%', '6 of 8'], ['25.0%', '4 of 8'], ['80.0%', '5 of 6'], ['50.0%', '3 of 6']])
    // Neither the header nor the tracked section says the tracking changed: the sweep on screen ran with it.
    await waitFor(() => expect(within(page).queryByText(/^Tracking changed/)).toBeNull())
    expect(within(header).queryByRole('status')).toBeNull()
    // The answers are read again, for the new sweep's run.
    await waitFor(() => expect(requests.filter(request => request.pathname.includes('/measurement-property-evidence')).map(request => request.searchParams.get('runId'))).toContain(NEW_RUN))
  })
})

describe('Add query about this location', () => {
  const ADD_QUERY = 'Add query about this location'
  const RETRY_ADD = 'Retry adding a query about this location'
  const NO_WORKSPACE = 'Could not load'
  // The server files a query by its text: one that names the location it is
  // added to is Branded for that location, any other is Non-brand
  // (`proposeQueryClassForTarget`). The fixtures give each text its real class.
  const MARKET_QUERY = { text: 'quiet hotels with a harbor view', queryClass: 'non-brand' as const }
  const NAMED_QUERY = { text: 'is Harbor House a good place to stay', queryClass: 'branded' as const }
  const PREVIEW_TOKEN = `qtp_${'b'.repeat(64)}`
  const REVIEWED_AT = '2026-08-03T12:15:00.000Z'
  const workload = { existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 2, nextSweepProviderCalls: 2, addedNodes: 1, addedProviderCalls: 1, removedNodes: 0, removedProviderCalls: 0 }
  const OTHER_LOCATION = { id: 'other-house', label: 'Other House', kind: 'property', targetCount: 1 }

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

  /** The workspace after the commit: the new query is about Harbor House, in the type its text gets, and waits for its first sweep. */
  function workspaceAfterPublish(query: typeof MARKET_QUERY | typeof NAMED_QUERY) {
    const before = trackingWorkspace()
    return trackingWorkspace({
      targets: [{ ...before.targets[0]!, counts: { ...TRACKING_COUNTS, propertyQueries: TRACKING_COUNTS.propertyQueries + 1 } }],
      tracked: [...before.tracked, trackedQuery('query-new', query.text, { kind: 'property', key: TARGET_KEY }, query.queryClass, { state: 'awaiting-sweep', lastMeasuredAt: null })],
    })
  }

  /**
   * The page's own reads plus the tracking API, with every request path and every review or publish recorded.
   * `workspace` answers every read of the tracking workspace: the page's own on load, and each press of the button.
   */
  async function renderWithTracking(options: {
    account?: SignedInAccount
    workspace?: () => Response | Promise<Response>
    plan?: () => ReturnType<typeof planResponse>
    publishes?: typeof MARKET_QUERY | typeof NAMED_QUERY
    queryClient?: QueryClient
    /** Answers the page's own reads once the commit has landed. Before it, and without it, they are a measured page's. */
    afterPublish?: (url: string) => Response | Promise<Response>
  } = {}) {
    const paths: string[] = []
    /** Every request as "METHOD /path" under the project, in the order it was made. */
    const requests: string[] = []
    const writes: Array<{ operation: string; body: unknown }> = []
    const publishes = options.publishes ?? MARKET_QUERY
    const diff = { added: [{ queryId: 'query-new', queryText: publishes.text, assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false }
    let published = false
    const page = propertyPageResponses()
    const rendered = await renderPropertyPageFromApi((url, init) => {
      const path = new URL(url).pathname
      paths.push(path)
      requests.push(`${init?.method ?? 'GET'} ${path.replace(/^.*\/projects\/[^/]+/, '')}`)
      if (path.endsWith('/query-tracking')) return options.workspace?.() ?? jsonResponse(published ? workspaceAfterPublish(publishes) : trackingWorkspace())
      const operation = path.match(/\/query-tracking\/(preview|commit)$/)?.[1]
      if (operation) {
        writes.push({ operation, body: JSON.parse(String(init?.body)) })
        if (operation === 'preview') {
          return jsonResponse(queryTrackingPreviewResponseSchema.parse({ mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, previewToken: PREVIEW_TOKEN, reviewedAt: REVIEWED_AT, active: TRACKING_ACTIVE, tracked: [], diff, workload }))
        }
        published = true
        return jsonResponse(queryTrackingCommitResponseSchema.parse({ committed: true, mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, reviewedAt: REVIEWED_AT, active: { ...TRACKING_ACTIVE, revision: 8 }, diff, workload }))
      }
      if (path.endsWith('/measurement-plan')) return jsonResponse(published ? planAfterPublish(publishes) : options.plan?.() ?? planResponse())
      return published && options.afterPublish ? options.afterPublish(url) : page(url)
    }, { account: options.account ?? ADMIN, queryClient: options.queryClient })
    // The button is in the page header, with the alert it shows when its read fails.
    const header = (await screen.findByRole('heading', { name: 'Harbor House', level: 1 })).closest<HTMLElement>('.page-header')!
    const reads = (suffix: string) => paths.filter(path => path.endsWith(suffix)).length
    return { ...rendered, header, writes, requests, workspaceReads: () => reads('/query-tracking'), resultsReads: () => reads('/query-tracking/results'), planReads: () => reads('/measurement-plan') }
  }

  /** The table of the queries about this location, once the page's own workspace read has landed. */
  const ownQueries = () => screen.findByRole('table', { name: 'Location queries' })
  const rowOf = (table: HTMLElement, queryText: string) => within(table).getByRole('button', { name: queryText }).closest('tr')!

  // A real click focuses the button; `fireEvent.click` does not.
  async function openSheet(header: HTMLElement, name = ADD_QUERY) {
    const button = within(header).getByRole('button', { name })
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

  it('makes two tracking reads on load, and reads the workspace again on the press that opens the sheet on this location', async () => {
    const { header, workspaceReads, resultsReads, queryClient } = await renderWithTracking()
    await ownQueries()
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    // What the page adds to its load: the workspace, under the Queries tab's key, and this location's results.
    expect([workspaceReads(), resultsReads()]).toEqual([1, 1])
    // It is the page's primary action: the one filled button, in the header.
    const button = within(header).getByRole('button', { name: ADD_QUERY }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.className).toContain('bg-accent')
    expect(screen.getAllByRole('button', { name: ADD_QUERY })).toHaveLength(1)

    const sheet = await openSheet(header)
    expect(sheet.getByRole('radio', { name: 'Location' }).getAttribute('aria-checked')).toBe('true')
    expect(sheet.getByText('Harbor House · Location')).toBeTruthy()
    // One line names the markets; how the query is asked is the help right after it.
    const countsIn = sheet.getByText('Counts in: North coast')
    expect(within(countsIn.nextElementSibling as HTMLElement).getByRole('button', { name: "Asked with these markets' engines and search locations." })).toBeTruthy()
    expect(sheet.queryByText(/^Engines and search locations come from/)).toBeNull()
    // This page has no Add query form to hand off to.
    expect(sheet.queryByRole('button', { name: 'More ways to add' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Add queries' }).textContent).not.toMatch(/propert|—/i)
    // The press read the workspace once more, and opening the sheet does not read it again.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect([workspaceReads(), resultsReads()]).toEqual([2, 1])

    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('reads the workspace on the press however fresh the page\'s own read of it is', async () => {
    // The app's client keeps a read fresh for five minutes. The sheet must not open on that copy: it reviews
    // against the workspace version it opens on.
    const { header, workspaceReads } = await renderWithTracking({ queryClient: createQueryClient() })
    await ownQueries()
    expect(workspaceReads()).toBe(1)

    await openSheet(header)
    expect(workspaceReads()).toBe(2)
  })

  it('says it is opening while the tracking workspace is read', async () => {
    let reads = 0
    let respond: (response: Response) => void = () => {}
    const { header } = await renderWithTracking({ workspace: () => { reads += 1; return reads === 1 ? jsonResponse(trackingWorkspace()) : new Promise<Response>(resolve => { respond = resolve }) } })
    await ownQueries()
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))

    expect((await within(header).findByRole('button', { name: 'Opening…' })).textContent).toBe('Opening…')
    expect(within(header).queryByRole('button', { name: ADD_QUERY })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    await waitFor(() => expect(reads).toBe(2))
    respond(jsonResponse(trackingWorkspace()))
    expect(await screen.findByRole('dialog', { name: 'Add queries' })).toBeTruthy()
    // The open sheet hides the page behind it from assistive tech.
    expect(within(header).getByRole('button', { name: ADD_QUERY, hidden: true })).toBeTruthy()
  })

  it('keeps saying it is opening while offline, and opens once the read can run', async () => {
    const { header, workspaceReads } = await renderWithTracking()
    await ownQueries()
    onlineManager.setOnline(false)
    onTestFinished(() => onlineManager.setOnline(true))
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))

    expect(await within(header).findByRole('button', { name: 'Opening…' })).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 50))
    // Only the page's own read so far: the press waits for the network.
    expect(workspaceReads()).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    onlineManager.setOnline(true)
    expect(await screen.findByRole('dialog', { name: 'Add queries' })).toBeTruthy()
    expect(workspaceReads()).toBe(2)
  })

  it('shows a viewer the tracked lists with no button, no row menu and no editor, from the same two reads', async () => {
    const { header, workspaceReads, resultsReads, requests, queryClient } = await renderWithTracking({ account: VIEWER })
    const own = await ownQueries()
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(within(own).getByRole('button', { name: OWN_QUESTION })).toBeTruthy()
    expect(within(screen.getByRole('table', { name: 'Market queries' })).getByText(NEARBY_QUESTION)).toBeTruthy()
    expect(screen.queryByRole('button', { name: ADD_QUERY })).toBeNull()
    expect(within(header).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
    expect(screen.queryByRole('button', { name: PROPERTY_NAMES_COPY.edit })).toBeNull()
    expect([workspaceReads(), resultsReads()]).toEqual([1, 1])
    // Every request of the load: the six reads the page made before it listed what a location is tracked for,
    // and those two. A third read by the tracked section, of anything, shows here.
    expect([...requests].sort()).toEqual([
      'GET /measurement-overview', 'GET /measurement-overview', 'GET /measurement-plan',
      'GET /measurement-property-competitors', 'GET /measurement-property-evidence', 'GET /measurement-property-evidence',
      'GET /query-tracking', 'GET /query-tracking/results',
    ])
  })

  it('publishes each line for this location in its markets, closes, and lists the new query with no sweep', async () => {
    onTestFinished(resetToasts)
    const { header, writes, requests, resultsReads } = await renderWithTracking({ publishes: MARKET_QUERY })
    const own = await ownQueries()
    const sheet = await openSheet(header)
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
    expect(within(own).queryByText(MARKET_QUERY.text)).toBeNull()

    fireEvent.click(sheet.getByRole('button', { name: 'Publish 1 change' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes[1]).toEqual({ operation: 'commit', body: { ...mutation, expectedWorkspaceVersion: WORKSPACE_VERSION, previewToken: PREVIEW_TOKEN, reviewedAt: REVIEWED_AT } })
    // The list and its count are read again from the workspace. No sweep ran, so the new row waits
    // for its first answers and its chips read Not checked, never No.
    const added = rowOf(own, MARKET_QUERY.text)
    await waitFor(() => expect(within(added).getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy())
    expect(added.querySelector('.tracked-cell-type')!.textContent).toBe('Non-brand')
    expect(added.querySelector('.tracked-cell-status')!.textContent).toBe('First answers')
    expect(within(rowOf(own, OWN_QUESTION)).getByRole('button', { name: 'OpenAI: Mentioned, Not cited' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Queries about this location' }).nextElementSibling!.textContent).toBe('6 queries')
    // The results were read again after the publish, with no run started: the two tracking writes are the only
    // requests that are not reads, and none is to a run.
    await waitFor(() => expect(resultsReads()).toBe(2))
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual(['POST /query-tracking/preview', 'POST /query-tracking/commit'])
    expect(requests.filter(request => /\/runs?\b/.test(request))).toEqual([])
    await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual(['Tracked queries updated']))
  })

  it('keeps the numbers after its own publish and says the tracking changed, with no reload and no sweep', async () => {
    onTestFinished(resetToasts)
    // Once revision 8 is published, the reads answer with the sweep that ran with revision 7.
    const { header, requests } = await renderWithTracking({
      publishes: MARKET_QUERY,
      afterPublish: afterTrackingChange(propertyPageResponses(), { activeRevision: 8, measuredRevision: 7 }),
    })
    const own = await ownQueries()
    const contrast = await screen.findByRole('table', { name: 'Mention and citation coverage for this location, by query type' })
    const nonBrand = () => [...within(contrast).getByText('Non-brand').closest('tr')!.querySelectorAll('td')].slice(1).map(cell => cell.textContent)
    await waitFor(() => expect(nonBrand()).toEqual(['75.0%3 of 4', '50.0%2 of 4']))
    expect(screen.queryByText(/^Tracking changed/)).toBeNull()

    await publish(await openSheet(header), MARKET_QUERY.text)

    // The publish reads the page again. The numbers are the same sweep's, now marked once, in the header: the
    // tracked section's results say the same and leave it to the header.
    expect((await within(header).findByRole('status')).textContent).toBe(`Tracking changed ${CHANGED_ON}`)
    expect(within(header).getByText('Measured')).toBeTruthy()
    expect(nonBrand()).toEqual(['75.0%3 of 4', '50.0%2 of 4'])
    expect(await within(await answersTable()).findByText(NEARBY_QUESTION)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Measurement next step' })).toBeNull()
    // The new query is listed and waits for its first answers.
    await waitFor(() => expect(within(rowOf(own, MARKET_QUERY.text)).getByRole('button', { name: 'OpenAI: Not checked' })).toBeTruthy())
    await waitFor(() => expect(screen.getAllByText(/^Tracking changed/)).toHaveLength(1))
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual(['POST /query-tracking/preview', 'POST /query-tracking/commit'])
    expect(requests.filter(request => /\/runs?\b/.test(request))).toEqual([])
  })

  it('lists a query that names this location with its type, whichever type the results show', async () => {
    onTestFinished(resetToasts)
    const { header, writes } = await renderWithTracking({ publishes: NAMED_QUERY })
    const own = await ownQueries()
    await publish(await openSheet(header), NAMED_QUERY.text)

    // The sheet never sends a class of its own, which would file this query as Non-brand.
    expect(writes[1]!.body).toMatchObject({ additions: [{ input: { source: 'manual', text: NAMED_QUERY.text }, audience: { targetKeys: [TARGET_KEY], marketKeys: ['north-coast'] } }] })
    expect(JSON.stringify(writes.map(write => write.body))).not.toContain('queryClass')
    // The server filed it as Branded. Both types share one list with a Type column, so it is in view
    // while the results below stay on Non-brand, and nothing has to point to it.
    await waitFor(() => expect(rowOf(own, NAMED_QUERY.text).querySelector('.tracked-cell-type')!.textContent).toBe('Branded'))
    expect((screen.getByLabelText('Query type') as HTMLSelectElement).value).toBe('non-brand')
    expect(screen.queryByText(/added under/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Show (branded|non-brand) queries$/ })).toBeNull()
  })

  it('says when the tracking workspace cannot be read, and reads it again on the next press', async () => {
    let failing = true
    const { header, workspaceReads } = await renderWithTracking({
      workspace: () => failing ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500) : jsonResponse(trackingWorkspace()),
    })
    // The page's own read failed too: the tracked section says so, and the results below still render.
    expect(await screen.findByRole('button', { name: 'Retry tracked queries' })).toBeTruthy()
    expect(await answersTable()).toBeTruthy()
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))

    expect((await within(header).findByRole('alert')).textContent).toBe(NO_WORKSPACE)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The same button is the one action: it reads Retry, and a press reads again.
    expect(within(header).getByRole('button', { name: RETRY_ADD }).textContent).toBe('Retry')
    expect(within(header).queryByRole('button', { name: ADD_QUERY })).toBeNull()
    expect(within(header).getByRole('button', { name: 'Could not load. Tracked queries did not load.' })).toBeTruthy()
    expect(workspaceReads()).toBe(2)
    failing = false
    const sheet = await openSheet(header, RETRY_ADD)
    expect(sheet.getByText('Harbor House · Location')).toBeTruthy()
    expect(within(header).queryByRole('alert', { hidden: true })).toBeNull()
    expect(workspaceReads()).toBe(3)
    // The press's read is the page's read: the tracked section has its lists too.
    expect(screen.getByRole('table', { name: 'Location queries', hidden: true })).toBeTruthy()
  })

  it('opens nothing when the cache is refreshed after a failed read, only on a press', async () => {
    let failing = true
    const { header, workspaceReads, queryClient } = await renderWithTracking({
      workspace: () => failing ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500) : jsonResponse(trackingWorkspace()),
    })
    await screen.findByRole('button', { name: 'Retry tracked queries' })
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))
    expect((await within(header).findByRole('alert')).textContent).toBe(NO_WORKSPACE)
    expect(workspaceReads()).toBe(2)

    // What every successful project write does: refresh the project's reads. The page's tracked section reads again.
    failing = false
    await queryClient.invalidateQueries()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workspaceReads()).toBe(3)
    expect(within(header).getByRole('alert').textContent).toBe(NO_WORKSPACE)

    await openSheet(header, RETRY_ADD)
    expect(workspaceReads()).toBe(4)
  })

  it('opens no sheet when the tracking workspace does not hold this location, and reads the setup again', async () => {
    const { header, planReads } = await renderWithTracking({
      workspace: () => jsonResponse(trackingWorkspace({ scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }, OTHER_LOCATION] })),
    })
    await ownQueries()
    const planReadsBefore = planReads()
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))

    expect((await within(header).findByRole('alert')).textContent).toBe('Location not found')
    expect(within(header).getByRole('button', { name: 'Location not found. This location was not found in tracked queries.' })).toBeTruthy()
    await waitFor(() => expect(planReads()).toBe(planReadsBefore + 1))
    // Another location is never offered in this one's place.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(header).getByRole('button', { name: RETRY_ADD }).textContent).toBe('Retry')
  })

  it('points to no Add query form when the project has no markets', async () => {
    const { header } = await renderWithTracking({
      workspace: () => jsonResponse(trackingWorkspace({ markets: [], scopeOptions: [{ id: TARGET_KEY, label: 'Harbor House', kind: 'property', targetCount: 1 }] })),
    })
    const sheet = await openSheet(header)
    fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))

    // Plain text: with no form to point to, the note has no help to open.
    expect(sheet.getByText('No markets yet').closest('button')).toBeNull()
  })

  it('carries a failed read to no other location the page moves to', async () => {
    const twoLocations = () => {
      const plan = planResponse()
      plan.active.plan.targets.push({ ...plan.active.plan.targets[0]!, stableKey: OTHER_LOCATION.id, label: OTHER_LOCATION.label, aliases: [OTHER_LOCATION.label] })
      return plan
    }
    const { header, router, projectName } = await renderWithTracking({
      plan: twoLocations,
      workspace: () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500),
    })
    fireEvent.click(within(header).getByRole('button', { name: ADD_QUERY }))
    expect((await within(header).findByRole('alert')).textContent).toBe(NO_WORKSPACE)

    await act(async () => { await router.navigate({ to: '/projects/$projectName/properties/$targetKey', params: { projectName, targetKey: OTHER_LOCATION.id } }) })
    const moved = (await screen.findByRole('heading', { name: OTHER_LOCATION.label, level: 1 })).closest<HTMLElement>('.page-header')!
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
