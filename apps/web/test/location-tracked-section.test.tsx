import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { queryTrackingResultsResponseSchema, queryTrackingWorkspaceResponseSchema } from '@ainyc/canonry-contracts'
import type { QueryClass, QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'
import type { MeasurementPlanResponse } from '@ainyc/canonry-api-client'
import { getApiV1ProjectsByNameQueryTrackingQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { PROPERTY_NAMES_COPY } from '../src/components/project/advanced-measurement/PropertyNamesEditor.js'
import { LocationSidePanel } from '../src/components/project/location/LocationSidePanel.js'
import { LocationPlaces, LocationTrackedSection } from '../src/components/project/location/LocationTrackedSection.js'
import { VISIBILITY_TOOLBAR_COPY } from '../src/components/project/VisibilityTrendSection.js'
import { formatObservedInstantMonthDay, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { visibleText } from './caution-note.js'
import { expectNoSentence, noteButton, openRowSheet } from './support/query-tracking-fixtures.js'

// The location page's tracked section, header line and side panel: what one location is tracked for, from the
// workspace read and one results read for the location, and what it is matched by, from the published setup.

// The strip and the Status badges date a sweep against today's year, so today is fixed. Only the clock is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetToasts()
})

type Assignment = QueryTrackingTrackedRow['assignments'][number]

const context = {
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-5', gemini: 'gemini-3' },
  location: { label: 'Lakeshore', city: 'Lakeshore', region: 'IL', country: 'US' },
}
const WORKSPACE_VERSION = `qtw_${'a'.repeat(64)}`
const MEASURED_AT = '2026-10-07T12:10:00.000Z'
const SWEPT_AT = '2026-10-07T12:20:00.000Z'
const CHANGED_AT = '2026-10-09T12:00:00.000Z'
/** A moment's day as the page prints it, in whatever timezone the test runs in: "Oct 7" in most. */
const day = (instant: string) => formatObservedInstantMonthDay(observedInstant(instant))
const pairing = (targetKey: string, marketKeys: string[], queryClass: QueryClass | null, groupKeys: string[] = []): Assignment =>
  ({ targetKey, groupKeys, marketKeys, queryClass, classificationSource: 'server', contexts: [context] }) as Assignment
function tracked(queryId: string, queryText: string, focus: QueryTrackingTrackedRow['focus'], assignments: Assignment[], overrides: Record<string, unknown> = {}) {
  return {
    queryId, queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
    state: 'tracked', lastMeasuredAt: MEASURED_AT,
    assignments, focus,
    queryClasses: [...new Set(assignments.map(assignment => assignment.queryClass).filter((value): value is QueryClass => value !== null))].sort(),
    ...overrides,
  }
}

const HARBOR_REVIEWS = 'Harbor Point reviews'
const HARBOR_NEW = 'is Harbor Point a good place to live'
const UPTOWN_BEST = 'best apartments uptown'
const UPTOWN_PETS = 'pet friendly apartments uptown'
const DOWNTOWN = 'best apartments downtown'
const PICKED = 'apartments with a pool'
const RIVER = 'River Point reviews'
const CAMPUS = 'studio apartments near campus'
const uptown = () => ['harbor', 'river', 'summit'].map(key => pairing(key, ['uptown'], 'non-brand', key === 'summit' ? [] : ['north']))

/**
 * Harbor Point sits in three markets and two groups. It has two queries of its own (one added since the last
 * sweep), takes three from two of its markets and one hand-picked query, which is asked Non-brand here and
 * Branded for another location. Pier House is in no market and has no query. No number the section prints
 * can be worked out from these rows: the server's counts are a larger portfolio's, and one market has no query.
 */
function portfolio(overrides: Record<string, unknown> = {}) {
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: 'advanced',
    workspaceVersion: WORKSPACE_VERSION,
    active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
    defaultContexts: [context],
    targets: [
      { stableKey: 'harbor', label: 'Harbor Point', marketKeys: ['uptown', 'downtown', 'lakeview'], counts: { propertyQueries: 4, marketQueries: 11, customQueries: 2, answersPerSweep: 51 } },
      { stableKey: 'river', label: 'River Point', marketKeys: ['uptown'], counts: { propertyQueries: 1, marketQueries: 7, customQueries: 1, answersPerSweep: 18 } },
      { stableKey: 'summit', label: 'Summit Lofts', marketKeys: ['uptown', 'lakeview'], counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 14 } },
      { stableKey: 'pier', label: 'Pier House', marketKeys: [], counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 0 } },
    ],
    groups: [
      { stableKey: 'north', label: 'North, Lakeshore', targetKeys: ['harbor', 'river'], counts: { queries: 19, markets: 1, answersPerSweep: 114 } },
      { stableKey: 'north-side', parentGroupKey: 'north', label: 'North Side', targetKeys: ['harbor'], counts: { queries: 6, markets: 0, answersPerSweep: 20 } },
    ],
    markets: [
      { stableKey: 'uptown', label: 'Uptown, Lakeshore', usageEdges: [], targetKeys: ['harbor', 'river', 'summit'], counts: { marketQueries: 7, propertyQueries: 9, answersPerSweep: 96 } },
      { stableKey: 'downtown', label: 'Downtown', usageEdges: [], targetKeys: ['harbor'], counts: { marketQueries: 3, propertyQueries: 4, answersPerSweep: 14 } },
      { stableKey: 'lakeview', label: 'Lakeview', usageEdges: [], targetKeys: ['harbor', 'summit'], counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
    ],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 4 },
      ...['harbor', 'river', 'summit', 'pier'].map(id => ({ id, label: id, kind: 'property', targetCount: 1 })),
    ],
    tracked: [
      tracked('q-uptown-pets', UPTOWN_PETS, { kind: 'market', key: 'uptown' }, uptown()),
      tracked('q-uptown-best', UPTOWN_BEST, { kind: 'market', key: 'uptown' }, uptown()),
      tracked('q-downtown', DOWNTOWN, { kind: 'market', key: 'downtown' }, [pairing('harbor', ['downtown'], 'non-brand', ['north'])]),
      tracked('q-harbor', HARBOR_REVIEWS, { kind: 'property', key: 'harbor' }, [pairing('harbor', ['uptown', 'downtown'], 'branded', ['north'])]),
      // Added after the last sweep, so it waits for its first answers.
      tracked('q-harbor-new', HARBOR_NEW, { kind: 'property', key: 'harbor' }, [pairing('harbor', ['uptown', 'downtown'], 'branded', ['north'])], { state: 'awaiting-sweep', lastMeasuredAt: null }),
      tracked('q-picked', PICKED, { kind: 'custom' }, [pairing('harbor', ['uptown'], 'non-brand', ['north']), pairing('river', [], 'branded')]),
      // Another location's query, and one asked nowhere: neither is this location's.
      tracked('q-river', RIVER, { kind: 'property', key: 'river' }, [pairing('river', ['uptown'], 'branded', ['north'])]),
      tracked('q-campus', CAMPUS, { kind: 'not-asked' }, [], { state: 'awaiting-sweep', lastMeasuredAt: null }),
    ],
    savedSources: { research: [], discovery: [] },
    summary: {
      asked: 41, notAsked: 7,
      byClass: { branded: 12, nonBrand: 27, mixed: 1, unknown: 1 },
      byFocus: { market: 24, property: 14, company: 0, custom: 3 },
      assignments: { total: 133, branded: 20, nonBrand: 110, unknown: 3 },
      answersPerSweep: 300,
      structure: { targets: 4, markets: 3, groups: 2, topLevelGroups: 1, competitors: 0 },
    },
    ...overrides,
  })
}

const engine = (provider: string, mentioned: boolean | null, cited: boolean | null) =>
  ({ provider, expectedAnswers: 3, answers: 3, mentionedAnswers: mentioned ? 2 : 0, citedAnswers: cited ? 1 : 0, uncheckedSourceAnswers: 0, mentioned, cited })
/** The sweep of Oct 7 as Harbor Point's results hold it. It measured every query asked for it but the one added since. */
function sweep(overrides: Record<string, unknown> = {}) {
  return queryTrackingResultsResponseSchema.parse({
    mode: 'advanced',
    scope: { kind: 'property', key: 'harbor' },
    run: { id: 'run-1', createdAt: '2026-10-07T12:00:00.000Z', completedAt: SWEPT_AT, status: 'completed', revision: 4, matchesCurrentTracking: true },
    engines: ['gemini', 'openai'],
    rows: [
      { queryId: 'q-harbor', queryText: HARBOR_REVIEWS, queryClass: 'branded', engines: [engine('gemini', true, true), engine('openai', true, false)] },
      { queryId: 'q-picked', queryText: PICKED, queryClass: 'non-brand', engines: [engine('gemini', false, false), engine('openai', true, null)] },
    ],
    pendingRows: 1,
    ...overrides,
  })
}

type PlanV2 = Extract<NonNullable<MeasurementPlanResponse['active']>['plan'], { schemaVersion: 2 }>
const planTarget = (overrides: Partial<PlanV2['targets'][number]> = {}): PlanV2['targets'][number] => ({
  stableKey: 'harbor', label: 'Harbor Point', aliases: ['Harbor Point', 'Harbor Pt'], identityAliases: ['Harbor Point Lakeshore'], mentionNotApplicable: false, discoveryIdentity: null,
  urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/harbor-point', pathCase: 'insensitive' }, { kind: 'exact', url: 'https://example.com/floor-plans/harbor', pathCase: 'insensitive' }],
  ...overrides,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = () => json({ error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }, 500)

/**
 * The header line, the tracked section and the side panel for one location, inside a router (their links
 * are router links), a query client and an account. Every request is recorded as "METHOD /path?search"
 * under the project, and a write as its operation and body.
 */
async function renderLocation(options: {
  targetKey?: string
  role?: 'admin' | 'viewer'
  workspace?: () => Response | Promise<Response>
  results?: () => Response | Promise<Response>
  write?: (operation: string, body: unknown) => Response
  client?: QueryClient
  trackingChangedAt?: string
  target?: PlanV2['targets'][number]
} = {}) {
  const requests: string[] = []
  const writes: Array<{ operation: string; body: unknown }> = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    const path = url.pathname.replace('/api/v1/projects/acme', '')
    requests.push(`${request.method} ${path}${url.search}`)
    if (request.method === 'GET' && path === '/query-tracking') return options.workspace?.() ?? json(portfolio())
    if (request.method === 'GET' && path === '/query-tracking/results') return options.results?.() ?? json(sweep())
    const operation = path.match(/^\/query-tracking\/(preview|commit)$/)?.[1]
    if (request.method === 'POST' && operation && options.write) {
      const body = await request.json() as unknown
      writes.push({ operation, body })
      return options.write(operation, body)
    }
    return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
  })
  const targetKey = options.targetKey ?? 'harbor'
  const rootRoute = createRootRoute({
    component: () => (
      <AccountProvider account={options.role ? { name: 'someone', role: options.role } : null}>
        <header><LocationPlaces projectName="acme" targetKey={targetKey} /></header>
        <main><LocationTrackedSection projectName="acme" targetKey={targetKey} canWrite={options.role !== 'viewer'} trackingChangedAt={options.trackingChangedAt} /></main>
        <aside><LocationSidePanel projectName="acme" target={options.target ?? planTarget()} activeRevision={4} publishedBrandNames={['Acme Homes']} setupAction={options.role === 'viewer' ? undefined : <a href="/setup">Open measurement setup</a>} /></aside>
        <Outlet />
      </AccountProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(['/', '/projects/$projectName/queries', '/projects/$projectName/properties/$targetKey']
      .map(path => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }))),
    history: createMemoryHistory({ initialEntries: [`/projects/acme/properties/${targetKey}?queryClass=non-brand`] }),
  })
  await router.load()
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, writes, client }
}

/** The reads the tracked section makes. A writer's names editor reads the draft and the project besides. */
const trackingReads = (requests: readonly string[]) => requests.filter(request => request.includes('/query-tracking'))
const main = () => screen.getByRole('main')
const region = (name: string) => within(main()).getByRole('region', { name })
const table = (name: string) => within(main()).findByRole('table', { name })
/** A table's body as it reads: one list of cells for each row. */
const cells = (element: HTMLElement) => [...element.querySelectorAll(':scope > tbody > tr')].map(row => [...row.querySelectorAll(':scope > td')].map(cell => cell.textContent))
/** The number grid, label to value as it reads. */
const strip = () => Object.fromEntries([...main().querySelector('dl')!.querySelectorAll('dt')].map(term => [term.firstChild!.textContent, term.nextElementSibling!.textContent]))
/** The count beside a section's heading, as it reads and as it is spoken. */
const headingCount = (name: string) => within(main()).getByRole('heading', { name, level: 2 }).nextElementSibling?.textContent
const rowOf = (queryText: string) => within(main()).getByRole('button', { name: queryText }).closest('tr')!
/** A market table's row, by its query: there the query is plain text, not the button that opens a row. */
const marketRowOf = (markets: HTMLElement, queryText: string) => within(markets).getByText(queryText).closest('tr')!
/** One row's chips, as each engine's pair names them. */
const chips = (queryText: string) => within(rowOf(queryText)).getAllByRole('button', { name: /^(OpenAI|Gemini)[,:]/ }).map(pair => pair.getAttribute('aria-label'))
const hrefOf = (link: HTMLElement) => new URL(link.getAttribute('href')!, 'http://localhost')

test('prints the server\'s numbers for the location, never a recount of the rows it lists', async () => {
  const { requests } = await renderLocation()
  const own = await table('Location queries')
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toHaveLength(2))

  // The grid is this location's `targets[]` entry: its counts, and the length of its market list.
  expect(strip()).toEqual({ 'Location queries': '4', 'Market queries': '11', Markets: '3', 'Answers counted': '51' })
  expect(within(main()).getByRole('button', { name: 'Answers per sweep that count for this location, its market queries included. Locations share answers, so they do not add up to the project total.' })).toBeTruthy()
  // Each heading carries the server's count, which the rows under it do not add up to: 2, 3 and 1 are listed.
  expect([headingCount('Queries about this location'), headingCount('From its markets'), headingCount('Hand-picked')]).toEqual(['4 queries', '11 queries', '2 queries'])
  expect(own.querySelectorAll('tbody tr')).toHaveLength(2)
  expect(within(main()).getByRole('table', { name: 'Market queries' }).querySelectorAll('tbody tr')).toHaveLength(3)
  expect(within(main()).getByRole('table', { name: 'Hand-picked queries' }).querySelectorAll('tbody tr')).toHaveLength(1)
  // Neither another location's query nor one asked nowhere is listed.
  expect(within(main()).queryByText(RIVER)).toBeNull()
  expect(within(main()).queryByText(CAMPUS)).toBeNull()
  // Two reads: the workspace under the Queries tab's key, and the results for this location.
  expect(trackingReads(requests)).toEqual(['GET /query-tracking', 'GET /query-tracking/results?scope=property&scopeKey=harbor'])
  expectNoSentence(main())
})

test('reads no workspace again after a visit to Queries left it in the cache', async () => {
  // The app's client keeps a read fresh for five minutes, so the key the Queries tab filled is not read again.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } } })
  client.setQueryData(getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: 'acme' } }), portfolio())
  const { requests } = await renderLocation({ client })
  await table('Location queries')
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toHaveLength(2))

  expect(trackingReads(requests)).toEqual(['GET /query-tracking/results?scope=property&scopeKey=harbor'])
})

test('lists a location query with its type and the last sweep\'s chips, and one added since as Not checked', async () => {
  await renderLocation()
  const own = await table('Location queries')
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toHaveLength(2))

  // Both types are listed together, each row with its own. Status carries the row's date.
  expect(within(own).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Type', 'OpenAI', 'Gemini', 'Status', 'Actions'])
  expect(rowOf(HARBOR_REVIEWS).querySelector('.tracked-cell-type')!.textContent).toBe('Branded')
  expect(chips(HARBOR_REVIEWS)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Mentioned, Cited'])
  expect(rowOf(HARBOR_REVIEWS).querySelector('.tracked-cell-status')!.textContent).toBe(`Measured ${day(MEASURED_AT)}`)
  // Added since the sweep: no result row, so neither chip claims a No.
  expect(chips(HARBOR_NEW)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked'])
  expect(rowOf(HARBOR_NEW).querySelector('.tracked-cell-status')!.textContent).toBe('First answers')
  // The legend sits beside the first table of chips, with no note while the sweep matches the tracking.
  const legend = within(region('Queries about this location')).getByRole('list')
  expect(visibleText(legend)).toBe('M MentionedC CitedMNoMNot checked')
  expect(within(main()).queryByText(/^Tracking changed/)).toBeNull()
  expect(within(main()).queryByText('Results unavailable')).toBeNull()
})

test('lists a market query under From its markets with its market, its other locations and its last sweep', async () => {
  await renderLocation()
  const markets = await table('Market queries')

  expect(within(markets).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Market', 'Query', 'Other locations', 'Last measured'])
  // In market order, then by query. A market is named once, in a cell that spans its queries and holds its link.
  expect(cells(markets)).toEqual([
    ['DowntownOpen market', DOWNTOWN, 'Other locationsNone', `Last measured${day(MEASURED_AT)}`],
    ['Uptown, LakeshoreOpen market', UPTOWN_BEST, 'Other locations+2', `Last measured${day(MEASURED_AT)}`],
    [UPTOWN_PETS, 'Other locations+2', `Last measured${day(MEASURED_AT)}`],
  ])
  expect(within(markets).getByText('Uptown, Lakeshore').closest('td')!.rowSpan).toBe(2)
  // The count is the market's own member list less this location. Its names are one step away and in its name.
  const others = within(marketRowOf(markets, UPTOWN_BEST)).getByRole('button', { name: '2 other locations: River Point · Summit Lofts' })
  expect(others.textContent).toBe('+2')
  // Each market opens in Queries, narrowed to it.
  const open = within(markets).getAllByRole('link')
  expect(open.map(link => link.getAttribute('aria-label'))).toEqual(['Open market Downtown', 'Open market Uptown, Lakeshore'])
  const search = hrefOf(open[1]!).searchParams
  expect(hrefOf(open[1]!).pathname).toBe('/projects/acme/queries')
  expect([search.get('measurementScope'), search.get('measurementScopeKey'), search.get('queryWorkspace')]).toEqual(['market', 'uptown', 'tracked'])
})

test('shows the first eight market queries, then the rest on request', async () => {
  const many = Array.from({ length: 11 }, (_, index) => tracked(`q-${index}`, `apartments query ${String(index + 1).padStart(2, '0')}`, { kind: 'market', key: index < 9 ? 'uptown' : 'downtown' }, [pairing('harbor', [index < 9 ? 'uptown' : 'downtown'], 'non-brand')]))
  await renderLocation({ workspace: () => json(portfolio({ tracked: many })) })
  const markets = await table('Market queries')

  // Downtown's two sort first, then six of Uptown's nine. The heading keeps the server's count.
  expect(markets.querySelectorAll('tbody tr')).toHaveLength(8)
  expect(headingCount('From its markets')).toBe('11 queries')
  expect(within(markets).getByText('Uptown, Lakeshore').closest('td')!.rowSpan).toBe(6)
  const more = within(region('From its markets')).getByRole('button', { name: '+ 3 more market queries' })
  expect(visibleText(more).trim()).toBe('+ 3 more')

  fireEvent.click(more)
  expect(markets.querySelectorAll('tbody tr')).toHaveLength(11)
  expect(within(markets).getByText('Uptown, Lakeshore').closest('td')!.rowSpan).toBe(9)
  // The button left with the press, and the first row it brought holds the focus.
  expect(within(region('From its markets')).queryByRole('button', { name: /more market queries$/ })).toBeNull()
  expect(document.activeElement).toBe(markets.querySelectorAll('tbody tr')[8])
})

test('lists a hand-picked query under the type it is asked under here, and no Hand-picked section without one', async () => {
  const { client } = await renderLocation()
  const picked = await table('Hand-picked queries')
  await waitFor(() => expect(chips(PICKED)).toHaveLength(2))

  // Asked Non-brand for this location and Branded for another: here it is Non-brand, with one pair of chips an engine.
  expect(rowOf(PICKED).querySelector('.tracked-cell-type')!.textContent).toBe('Non-brand')
  expect(chips(PICKED)).toEqual(['OpenAI: Mentioned, Citation not checked', 'Gemini: Not mentioned, Not cited'])
  expect(picked.querySelectorAll('tbody tr')).toHaveLength(1)

  cleanup()
  client.clear()
  await renderLocation({ workspace: () => json(portfolio({ tracked: portfolio().tracked.filter(row => row.queryId !== 'q-picked') })) })
  await table('Location queries')
  expect(within(main()).queryByRole('heading', { name: 'Hand-picked' })).toBeNull()
})

test('flags a location with no query of its own and in no market, and only then', async () => {
  await renderLocation({ targetKey: 'pier', results: () => json(sweep({ scope: { kind: 'property', key: 'pier' }, rows: [], pendingRows: 0 })) })
  await waitFor(() => expect(strip()).toEqual({ 'Location queries': '0', 'Market queries': '0', Markets: '0', 'Answers counted': '0' }))

  expect(visibleText(region('Queries about this location'))).toBe('Queries about this location0No location queries')
  noteButton('No location queries', 'No tracked query has this location as its Subject.', region('Queries about this location'))
  expect(visibleText(region('From its markets'))).toBe('From its markets0In no market')
  noteButton('In no market', 'This location is in no market, so no market query counts for it.', region('From its markets'))
  expect(within(main()).queryByRole('table')).toBeNull()
  // The header names no market and no group for it.
  expect(screen.getByRole('banner').textContent).toBe('')
  expectNoSentence(main())
})

test('says a location in a market has no market query without flagging it, and flags nothing on a tracked location', async () => {
  const { client } = await renderLocation({ targetKey: 'summit', workspace: () => json(portfolio({ tracked: [] })), results: () => json(sweep({ scope: { kind: 'property', key: 'summit' }, rows: [], pendingRows: 0 })) })
  await waitFor(() => expect(visibleText(region('From its markets'))).toBe('From its markets0No market queries'))

  // Plain text: there is nothing behind it to open. Summit Lofts is in two markets, so it is not flagged.
  expect(within(region('From its markets')).queryByRole('button')).toBeNull()
  expect(within(main()).queryByText('In no market')).toBeNull()

  cleanup()
  client.clear()
  await renderLocation()
  await table('Location queries')
  expect(within(main()).queryByText('No location queries')).toBeNull()
  expect(within(main()).queryByText('In no market')).toBeNull()
  expect(within(main()).queryByText('No market queries')).toBeNull()

  // The flag is the server's zero, never an empty list: with four queries counted and none listed, it stays off.
  cleanup()
  client.clear()
  await renderLocation({ workspace: () => json(portfolio({ tracked: portfolio().tracked.filter(row => row.focus?.kind !== 'property') })) })
  await table('Market queries')
  expect(headingCount('Queries about this location')).toBe('4 queries')
  expect(within(main()).queryByText('No location queries')).toBeNull()
})

test('names the location\'s markets as links to Queries and its groups, with a dot between names that hold commas', async () => {
  await renderLocation()
  const header = screen.getByRole('banner')
  await within(header).findByText('Markets:')

  const links = within(header).getAllByRole('link')
  expect(links.map(link => link.textContent)).toEqual(['Uptown, Lakeshore', 'Downtown', 'Lakeview'])
  expect(links.map(link => [hrefOf(link).pathname, hrefOf(link).searchParams.get('measurementScope'), hrefOf(link).searchParams.get('measurementScopeKey'), hrefOf(link).searchParams.get('queryWorkspace')])).toEqual([
    ['/projects/acme/queries', 'market', 'uptown', 'tracked'],
    ['/projects/acme/queries', 'market', 'downtown', 'tracked'],
    ['/projects/acme/queries', 'market', 'lakeview', 'tracked'],
  ])
  expect(header.textContent).toBe('Markets:Uptown, Lakeshore·Downtown·LakeviewGroups:North, Lakeshore · North Side')
  // The header and the section share the one workspace read.
  expect(header.querySelector('.skeleton-text')).toBeNull()
})

test('names one market and one group in the singular', async () => {
  await renderLocation({ targetKey: 'river', results: () => json(sweep({ scope: { kind: 'property', key: 'river' }, rows: [] })) })

  await within(screen.getByRole('banner')).findByText('Market:')
  expect(screen.getByRole('banner').textContent).toBe('Market:Uptown, LakeshoreGroup:North, Lakeshore')
})

test('opens a row\'s action sheet with this location as the place', async () => {
  const preview = { mode: 'advanced', workspaceVersion: WORKSPACE_VERSION, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-10-10T12:00:00.000Z', active: { revision: 4, compiledChecksum: 'c'.repeat(64) }, tracked: portfolio().tracked, diff: { added: [], removed: [{ queryId: 'q-picked', queryText: PICKED, assignmentCount: 1 }], reused: [], unchanged: [], noOp: false }, workload: { existingNodes: 2, existingProviderCalls: 6, nextSweepNodes: 1, nextSweepProviderCalls: 3, addedNodes: 0, addedProviderCalls: 0, removedNodes: 1, removedProviderCalls: 3 } }
  const { writes } = await renderLocation({ write: () => json(preview) })
  await table('Hand-picked queries')

  // A query about this location alone is asked nowhere else, so its sheet offers no choice of where.
  const own = await openRowSheet(HARBOR_REVIEWS, 'Stop tracking')
  expect(own.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
  fireEvent.click(own.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  // The hand-picked query is asked for another location too, so the sheet starts on this location only.
  const sheet = await openRowSheet(PICKED, 'Stop tracking')
  expect(sheet.getByRole('radio', { name: 'Only Harbor Point' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toEqual({ operation: 'preview', body: { additions: [], removals: [{ queryId: 'q-picked', audience: { targetKeys: ['harbor'] } }], expectedWorkspaceVersion: WORKSPACE_VERSION } })
})

test('copies a row\'s link to Queries, narrowed to this location with the row marked', async () => {
  const copied: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  await renderLocation()
  await table('Location queries')

  fireEvent.click(screen.getByRole('button', { name: `Actions for ${HARBOR_REVIEWS}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
  await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual(['Link copied']))

  const link = new URL(copied[0]!)
  expect(link.pathname).toBe('/projects/acme/queries')
  expect(Object.fromEntries(link.searchParams)).toMatchObject({ measurementScope: 'property', measurementScopeKey: 'harbor', queryWorkspace: 'tracked', trackingQueryId: 'q-harbor' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('shows a viewer the same lists and numbers with no row menu, and opens a row\'s detail for everyone', async () => {
  await renderLocation({ role: 'viewer' })
  const own = await table('Location queries')
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toHaveLength(2))

  expect(strip()).toEqual({ 'Location queries': '4', 'Market queries': '11', Markets: '3', 'Answers counted': '51' })
  expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull()
  expect(within(own).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Type', 'OpenAI', 'Gemini', 'Status'])
  expect(within(main()).getByRole('table', { name: 'Market queries' })).toBeTruthy()

  fireEvent.click(within(own).getByRole('button', { name: HARBOR_REVIEWS }))
  const links = within(own).getByRole('table', { name: 'Location links' })
  // Groups and markets are parted by a dot, and engines read by their display names.
  expect(cells(links)).toEqual([['Harbor Point', 'North, Lakeshore', 'Uptown, Lakeshore · Downtown', 'Branded']])
  expect(within(own).getByText('Lakeshore · OpenAI, Gemini')).toBeTruthy()
})

test('shows skeleton rows while the workspace loads, then Could not load with a Retry that reads it again', async () => {
  let attempts = 0
  let respond: (response: Response) => void = () => {}
  await renderLocation({ workspace: () => { attempts += 1; return attempts === 1 ? new Promise<Response>(resolve => { respond = resolve }) : json(portfolio()) } })

  expect(within(main()).getByRole('status', { name: 'Loading queries' })).toBeTruthy()
  expect(within(main()).queryByRole('table')).toBeNull()
  expect(screen.getByRole('banner').querySelector('.skeleton-text')).toBeTruthy()

  await waitFor(() => expect(attempts).toBe(1))
  respond(failure())
  const alert = await within(main()).findByRole('alert')
  expect(visibleText(alert)).toBe('Could not loadRetry')
  noteButton('Could not load', 'Tracked queries did not load.', alert)
  // The side panel is the published setup's own, so it is drawn whatever the workspace read does.
  expect(within(screen.getByRole('complementary')).getByRole('heading', { name: 'Site pages we match' })).toBeTruthy()

  fireEvent.click(within(alert).getByRole('button', { name: 'Retry tracked queries' }))
  expect(await table('Location queries')).toBeTruthy()
  expect(attempts).toBe(2)
  expect(within(main()).queryByRole('alert')).toBeNull()
})

test('keeps the lists it read when a refresh of the workspace fails, and says so', async () => {
  let failing = false
  const { client } = await renderLocation({ workspace: () => failing ? failure() : json(portfolio()) })
  await table('Location queries')

  failing = true
  await client.invalidateQueries({ queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: 'acme' } }) })
  const status = await within(main()).findByText('Refresh failed')
  noteButton('Refresh failed', 'The latest tracked queries did not load. These are the last ones read.', main())
  expect(status.closest('[role="status"]')).toBeTruthy()
  expect(within(main()).getByRole('table', { name: 'Location queries' })).toBeTruthy()

  failing = false
  fireEvent.click(within(main()).getByRole('button', { name: 'Retry tracked queries' }))
  await waitFor(() => expect(within(main()).queryByText('Refresh failed')).toBeNull())
})

test('reads every chip as Not checked when the results fail, and reads them again on Retry', async () => {
  let attempts = 0
  await renderLocation({ results: () => { attempts += 1; return attempts === 1 ? failure() : json(sweep()) } })
  await table('Location queries')
  const status = await within(main()).findByRole('status')

  expect(visibleText(status)).toBe('Results unavailableRetry')
  noteButton('Results unavailable', "The last sweep's results did not load, so every chip reads Not checked.", status)
  expect(chips(HARBOR_REVIEWS)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked'])
  // The lists and the numbers are the workspace's, so they stay.
  expect(strip()['Location queries']).toBe('4')
  expect(within(main()).queryByRole('alert')).toBeNull()

  fireEvent.click(within(status).getByRole('button', { name: 'Retry results' }))
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Mentioned, Cited']))
  expect(within(main()).queryByText('Results unavailable')).toBeNull()
})

test('reads a location that was not in the last sweep as Not checked, with no error', async () => {
  await renderLocation({ results: () => json(sweep({ rows: [], pendingRows: 4 })) })
  await table('Location queries')
  await waitFor(() => expect(chips(HARBOR_REVIEWS)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked']))

  expect(chips(PICKED)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked'])
  expect(within(main()).queryByText('Results unavailable')).toBeNull()
  expect(within(main()).queryByRole('alert')).toBeNull()
  expect(within(main()).queryByRole('status')).toBeNull()
})

test('says when tracking changed after the sweep the chips come from, beside the legend', async () => {
  await renderLocation({ trackingChangedAt: CHANGED_AT, results: () => json(sweep({ run: { ...sweep().run!, matchesCurrentTracking: false } })) })
  await table('Location queries')

  const label = VISIBILITY_TOOLBAR_COPY.trackingChangedLabel(day(CHANGED_AT))
  const note = await within(region('Queries about this location')).findByRole('button', { name: `${label}. ${VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(day(SWEPT_AT), null)}` })
  expect(note.textContent).toBe(`Tracking changed ${day(CHANGED_AT)}`)
  expect(within(main()).getAllByText(/^Tracking changed/)).toHaveLength(1)
  expectNoSentence(main())
})

test('lists the site pages as read-only for everyone and the names as chips, with the editor for a writer only', async () => {
  const { client } = await renderLocation()
  const panel = screen.getByRole('complementary')
  const pages = within(panel).getByRole('region', { name: 'Site pages we match' })

  expect(visibleText(pages)).toBe('Site pages we match2Read-onlyhttps://example.com/harbor-point/*https://example.com/floor-plans/harbor')
  expect(pages.querySelector('.section-head')!.textContent).toBe('Site pages we match2 pagesRead-only')
  noteButton('Read-only', 'Site pages are set in measurement setup.', pages)
  expect(within(pages).getAllByRole('listitem').map(item => item.textContent)).toEqual(['https://example.com/harbor-point/*', 'https://example.com/floor-plans/harbor'])
  const names = within(panel).getByRole('region', { name: PROPERTY_NAMES_COPY.heading })
  expect(names.querySelector('.section-head')!.textContent).toBe(`${PROPERTY_NAMES_COPY.heading}3 names${PROPERTY_NAMES_COPY.edit}`)
  expect(within(names).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Harbor Point', 'Harbor Pt', 'Harbor Point Lakeshore'])

  // "Edit names" opens the editor in place, inside the panel.
  const edit = within(names).getByRole('button', { name: PROPERTY_NAMES_COPY.edit }) as HTMLButtonElement
  await waitFor(() => expect(edit.disabled).toBe(false))
  fireEvent.click(edit)
  expect(within(names).getByRole('form', { name: 'Edit names' })).toBeTruthy()
  expect((within(names).getByRole('textbox', { name: PROPERTY_NAMES_COPY.names }) as HTMLTextAreaElement).value).toBe('Harbor Point\nHarbor Pt')

  cleanup()
  client.clear()
  await renderLocation({ role: 'viewer' })
  const viewed = within(screen.getByRole('complementary')).getByRole('region', { name: PROPERTY_NAMES_COPY.heading })
  expect(viewed.querySelector('.section-head')!.textContent).toBe(`${PROPERTY_NAMES_COPY.heading}3 names`)
  expect(within(viewed).queryByRole('button', { name: PROPERTY_NAMES_COPY.edit })).toBeNull()
  noteButton('Read-only', 'Site pages are set in measurement setup.', within(screen.getByRole('complementary')).getByRole('region', { name: 'Site pages we match' }))
})

test('offers the setup beside an empty list of site pages to a writer only', async () => {
  const { client } = await renderLocation({ target: planTarget({ urlMatchers: [] }) })
  const pages = () => within(screen.getByRole('complementary')).getByRole('region', { name: 'Site pages we match' })

  expect(visibleText(pages())).toBe('Site pages we match0Read-onlyNo site pagesOpen measurement setup')
  expect(pages().querySelector('.section-head')!.textContent).toBe('Site pages we match0 pagesRead-only')

  cleanup()
  client.clear()
  await renderLocation({ role: 'viewer', target: planTarget({ urlMatchers: [{ kind: 'host', host: 'harbor.example.com' }] }) })
  expect(pages().querySelector('.section-head')!.textContent).toBe('Site pages we match1 pageRead-only')
  expect(within(pages()).queryByRole('link')).toBeNull()
})
