import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import type { MeasurementPlanResponse, MeasurementSetupResponse, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-api-client'

import { AccountProvider } from '../src/contexts/account-context.js'
import { LOCATIONS_MARKETS_COPY, LocationsMarketsSection } from '../src/components/project/settings/LocationsMarketsSection.js'
import { nextStructureSort, projectStructure, sortStructureRows } from '../src/components/project/settings/structure-view-model.js'
import { visibleText } from './caution-note.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Settings, "Locations & markets": what a published setup holds, to read. Every number is a field one of
// the reads returned, or the length of a list it returned. In this fixture no number can be worked out
// from the rows: no query is listed, the totals are not the list lengths, and a group's market count is
// not the number of markets that name it.
const context = { providers: ['openai'], models: { openai: 'search-model' }, location: null }
function workspaceResponse(overrides: Partial<QueryTrackingWorkspaceResponse> = {}): QueryTrackingWorkspaceResponse {
  return {
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'b'.repeat(64) },
    defaultContexts: [context],
    targets: [
      { stableKey: 'harbor-point', label: 'Harbor Point', marketKeys: ['north-market', 'river-market', 'lake-market'], counts: { propertyQueries: 7, marketQueries: 11, customQueries: 0, answersPerSweep: 30 } },
      { stableKey: 'northbridge', label: 'Northbridge', marketKeys: ['north-market'], counts: { propertyQueries: 2, marketQueries: 9, customQueries: 0, answersPerSweep: 12 } },
      { stableKey: 'cedar-hollow', label: 'Cedar Hollow', marketKeys: [], counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 0 } },
    ],
    markets: [
      { stableKey: 'north-market', label: 'North Market', groupKey: 'north', usageEdges: [], targetKeys: ['harbor-point', 'northbridge'], counts: { marketQueries: 5, propertyQueries: 9, answersPerSweep: 20 } },
      { stableKey: 'river-market', label: 'River Market', groupKey: 'north', usageEdges: [], targetKeys: ['harbor-point'], counts: { marketQueries: 4, propertyQueries: 7, answersPerSweep: 14 } },
      { stableKey: 'lake-market', label: 'Lake Market', usageEdges: [], targetKeys: ['harbor-point'], counts: { marketQueries: 2, propertyQueries: 7, answersPerSweep: 9 } },
      { stableKey: 'empty-quarter', label: 'Empty Quarter', usageEdges: [], targetKeys: [], counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
    ],
    groups: [
      { stableKey: 'north', label: 'North', targetKeys: ['harbor-point', 'northbridge'], counts: { queries: 14, markets: 6, answersPerSweep: 40 } },
      { stableKey: 'north-side', parentGroupKey: 'north', label: 'North Side', targetKeys: ['northbridge'], counts: { queries: 3, markets: 0, answersPerSweep: 8 } },
    ],
    scopeOptions: [],
    tracked: [],
    savedSources: { research: [], discovery: [] },
    summary: {
      asked: 932, notAsked: 38,
      byClass: { branded: 384, nonBrand: 541, mixed: 7, unknown: 0 },
      byFocus: { market: 547, property: 371, company: 0, custom: 14 },
      assignments: { total: 2412, branded: 390, nonBrand: 2022, unknown: 0 },
      answersPerSweep: 2796,
      structure: { targets: 192, markets: 137, groups: 157, topLevelGroups: 20, competitors: 61 },
    },
    ...overrides,
  }
}

type PlanV2 = Extract<NonNullable<MeasurementPlanResponse['active']>['plan'], { schemaVersion: 2 }>
const competitor = (domain: string): PlanV2['groups'][number]['competitors'][number] => ({ stableKey: domain.replaceAll('.', '-'), label: domain, domain, aliases: [] })
const planV2: PlanV2 = {
  schemaVersion: 2,
  identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Acme Homes'] } },
  targets: [
    {
      stableKey: 'harbor-point', label: 'Harbor Point', aliases: ['Harbor Point', 'Harbor Pt'], mentionNotApplicable: false, discoveryIdentity: null,
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/harbor-point', pathCase: 'insensitive' }, { kind: 'exact', url: 'https://example.com/floor-plans', pathCase: 'insensitive' }],
    },
    { stableKey: 'northbridge', label: 'Northbridge', aliases: ['Northbridge'], mentionNotApplicable: false, discoveryIdentity: null, urlMatchers: [{ kind: 'host', host: 'northbridge.example.com' }] },
    { stableKey: 'cedar-hollow', label: 'Cedar Hollow', aliases: [], mentionNotApplicable: true, discoveryIdentity: null, urlMatchers: [] },
  ],
  groups: [
    { stableKey: 'north', label: 'North', targetKeys: ['harbor-point', 'northbridge'], competitors: [competitor('rival.example'), competitor('other.example')] },
    // The same competitor under another spelling of its host: one row, as the server counts one.
    { stableKey: 'north-side', label: 'North Side', parentGroupKey: 'north', targetKeys: ['northbridge'], competitors: [competitor('www.rival.example')] },
  ],
  querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [],
  compiledChecksum: 'b'.repeat(64),
}
const publishedPlan: MeasurementPlanResponse = { active: { revision: 4, checksum: 'a'.repeat(64), createdAt: '2026-08-01T12:00:00.000Z', plan: planV2 } }

function setupResponse(kind: 'simple' | 'simple-draft' | 'advanced' | 'advanced-draft' | 'v1'): MeasurementSetupResponse {
  const draft = kind.endsWith('draft') ? { etag: '"mpd_7"', updatedAt: '2026-08-02T12:00:00.000Z' } : null
  if (kind === 'simple' || kind === 'simple-draft') {
    return { state: draft ? 'setup_in_progress' : 'simple', nextAction: draft ? 'continue_setup' : 'start_setup', mode: draft ? 'draft-only' : 'simple', answerVisibilityProviderReady: true, activeRevision: null, activeSchemaVersion: null, draft }
  }
  if (kind === 'v1') return { state: 'operational', nextAction: 'view_measurement', mode: 'active-v1', answerVisibilityProviderReady: true, activeRevision: 2, activeSchemaVersion: 1, draft: null }
  return { state: draft ? 'setup_in_progress' : 'operational', nextAction: draft ? 'continue_setup' : 'view_measurement', mode: 'active-v2', answerVisibilityProviderReady: true, activeRevision: 4, activeSchemaVersion: 2, draft }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The section inside a router (its rows are router links), a query client and an account. `workspace` answers `GET /query-tracking`. */
async function renderSection(options: {
  setup?: MeasurementSetupResponse | undefined
  plan?: MeasurementPlanResponse | undefined
  workspace?: () => Response | Promise<Response>
  role?: 'admin' | 'viewer'
  setupFailed?: boolean
  planFailed?: boolean
  entry?: string
} = {}) {
  const requests: string[] = []
  const respond = options.workspace ?? (() => json(workspaceResponse()))
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    return url.pathname.endsWith('/projects/acme/query-tracking') ? respond() : json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
  })
  const onOpenSetup = vi.fn()
  const onRetryReads = vi.fn()
  const setup = 'setup' in options ? options.setup : setupResponse('advanced')
  const plan = 'plan' in options ? options.plan : publishedPlan
  const rootRoute = createRootRoute({
    component: () => (
      <AccountProvider account={options.role ? { name: 'someone', role: options.role } : null}>
        <LocationsMarketsSection projectName="acme" setup={setup} plan={plan} setupFailed={options.setupFailed === true} planFailed={options.planFailed === true} onRetryReads={onRetryReads} onOpenSetup={onOpenSetup} />
        <Outlet />
      </AccountProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(['/', '/projects/$projectName/settings', '/projects/$projectName/queries', '/projects/$projectName/properties/$targetKey']
      .map(path => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }))),
    history: createMemoryHistory({ initialEntries: [options.entry ?? '/projects/acme/settings'] }),
  })
  await router.load()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, onOpenSetup, onRetryReads, router, client }
}

const section = () => screen.getByRole('region', { name: 'Locations & markets' })
/** The number under a label of the grid, as it reads. */
const stat = (label: string) => within(section().querySelector('dl')!).getByText(label).closest('div')!.querySelector('dd')!.textContent
const table = (name: string) => within(section()).findByRole('table', { name })
/** A table's body as it reads: one list of cells for each row. */
const cells = (element: HTMLElement) => [...element.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
const names = (element: HTMLElement) => cells(element).map(row => row[0])
const tab = (name: string) => within(section()).getByRole('tab', { name })
const search = () => within(section()).getByRole<HTMLInputElement>('searchbox', { name: 'Search' })

describe('an advanced project', () => {
  test('prints the totals the server counted, never the length of a list', async () => {
    await renderSection()
    await table('Locations')
    expect([...section().querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Locations', 'Markets', 'Groups', 'Competitors', 'Open drafts'])
    expect(stat('Locations')).toBe('192')
    expect(stat('Markets')).toBe('137')
    expect(stat('Groups')).toBe('15720 top-level')
    expect(stat('Competitors')).toBe('61')
    expect(stat('Open drafts')).toBe('0')
  })

  test('lists each location with its markets, site pages, names and the server\'s own query counts', async () => {
    await renderSection()
    const locations = await table('Locations')
    expect([...locations.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Location', 'Markets', 'Site pages', 'Names', 'Location queries', 'Market queries'])
    // The first market's name, then how many more. No query is listed, so 7, 11, 2 and 9 can only be the server's counts.
    // A location the server lists in no market says so: the list came, and it is empty.
    expect(cells(locations)).toEqual([
      ['Harbor Point', 'North Market+2', '2', '2', '7', '11'],
      ['Northbridge', 'North Market', '1', '1', '2', '9'],
      ['Cedar Hollow', 'None', '0', '0', '0', '0'],
    ])
    // The site pages are the count's own tooltip and part of its name, in the form the location page prints them.
    expect(within(locations).getByRole('button', { name: '2 site pages: https://example.com/harbor-point/* · https://example.com/floor-plans' })).toBeTruthy()
    expect(within(locations).getByRole('button', { name: '1 site page: https://northbridge.example.com/*' })).toBeTruthy()
    expect(visibleText(locations)).not.toContain('https://')
    // Every market a location is in can be read, the first one too: its name may not fit the column.
    expect(within(locations).getByRole('button', { name: '3 markets: North Market · River Market · Lake Market' }).textContent).toBe('+2')
    // A name is on the page and in a list button, never in a `title`, which neither a tap nor the keys open.
    expect(section().querySelector('[title]')).toBeNull()
  })

  test('a list behind a count names its first 25, a page of rows, then how many more', async () => {
    const markets = Array.from({ length: 27 }, (_, index) => ({ stableKey: `market-${index + 1}`, label: `Market ${index + 1}`, usageEdges: [], targetKeys: ['harbor-point'], counts: { marketQueries: 1, propertyQueries: 1, answersPerSweep: 1 } }))
    const targets = [
      { stableKey: 'harbor-point', label: 'Harbor Point', marketKeys: markets.map(market => market.stableKey) },
      { stableKey: 'northbridge', label: 'Northbridge', marketKeys: markets.slice(0, 12).map(market => market.stableKey) },
    ]
    await renderSection({ workspace: () => json(workspaceResponse({ targets, markets })) })
    const locations = await table('Locations')
    const first25 = markets.slice(0, 25).map(market => market.label).join(' · ')
    expect(within(locations).getByRole('button', { name: `27 markets: ${first25} · +2 more` }).textContent).toBe('+26')
    // Twelve names are read whole.
    expect(within(locations).getByRole('button', { name: `12 markets: ${markets.slice(0, 12).map(market => market.label).join(' · ')}` }).textContent).toBe('+11')
  })

  test('a location opens its page and a market opens Queries on that market', async () => {
    await renderSection({ entry: '/projects/acme/settings?measurementProvider=openai' })
    const locations = await table('Locations')
    // The shared selection travels with the link, as it does from every other project tab.
    expect(within(locations).getByRole('link', { name: 'Harbor Point' }).getAttribute('href')).toBe('/projects/acme/properties/harbor-point?measurementProvider=openai')

    fireEvent.click(tab('Markets'))
    const link = within(await table('Markets')).getByRole('link', { name: 'River Market' })
    const target = new URL(link.getAttribute('href')!, 'http://localhost')
    expect(target.pathname).toBe('/projects/acme/queries')
    expect(Object.fromEntries(target.searchParams)).toEqual({ measurementProvider: 'openai', measurementScope: 'market', measurementScopeKey: 'river-market', queryWorkspace: 'tracked' })
  })

  test('lists each market with its locations, its group and a caution on a market that holds none', async () => {
    await renderSection()
    await table('Locations')
    fireEvent.click(tab('Markets'))
    const markets = await table('Markets')
    expect([...markets.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Market', 'Group', 'Locations', 'Market queries'])
    expect(cells(markets)).toEqual([
      ['North MarketHarbor Point · Northbridge', 'North', '2', '5'],
      ['River MarketHarbor Point', 'North', '1', '4'],
      ['Lake MarketHarbor Point', '', '1', '2'],
      ['Empty Quarter', '', 'No locations', '0'],
    ])
    // The line of names is cut where the column ends, so a market's count opens all of them.
    expect(within(markets).getByRole('button', { name: '2 locations: Harbor Point · Northbridge' }).textContent).toBe('2')
    // Icon and label on the page; the sentence is the note's tooltip and the rest of its name.
    expect(within(markets).getByRole('button', { name: 'No locations. No location is in this market, so nothing is measured for it.' })).toBeTruthy()
    expect(visibleText(markets)).not.toContain('nothing is measured')
  })

  test('lists each group with its parent, its locations, the server\'s market count and its competitors', async () => {
    await renderSection()
    await table('Locations')
    fireEvent.click(tab('Groups'))
    const groups = await table('Groups')
    // The counts come before Parent, so a phone's first screen holds a number.
    expect([...groups.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Group', 'Locations', 'Markets', 'Competitors', 'Parent'])
    // Two markets name North; the server says 6, and 6 is printed.
    expect(cells(groups)).toEqual([
      ['North', '2', '6', '2', ''],
      ['North Side', '1', '0', '1', 'North'],
    ])
  })

  test('Parent sorts the top-level groups together, first from A', async () => {
    const groups = [
      { stableKey: 'north-side', parentGroupKey: 'north', label: 'North Side', targetKeys: ['northbridge'], counts: { queries: 3, markets: 0, answersPerSweep: 8 } },
      { stableKey: 'south', label: 'South', targetKeys: [], counts: { queries: 0, markets: 0, answersPerSweep: 0 } },
      { stableKey: 'harbor-side', parentGroupKey: 'south', label: 'Harbor Side', targetKeys: [], counts: { queries: 0, markets: 0, answersPerSweep: 0 } },
      { stableKey: 'north', label: 'North', targetKeys: ['harbor-point', 'northbridge'], counts: { queries: 14, markets: 6, answersPerSweep: 40 } },
    ]
    await renderSection({ workspace: () => json(workspaceResponse({ groups })) })
    await table('Locations')
    fireEvent.click(tab('Groups'))
    const listed = await table('Groups')
    const parent = within(listed).getByRole('columnheader', { name: 'Parent' })
    const parents = () => cells(listed).map(row => [row[0], row[4]])

    fireEvent.click(within(parent).getByRole('button'))
    expect(parent.getAttribute('aria-sort')).toBe('ascending')
    expect(parents()).toEqual([['South', ''], ['North', ''], ['North Side', 'North'], ['Harbor Side', 'South']])

    fireEvent.click(within(parent).getByRole('button'))
    expect(parent.getAttribute('aria-sort')).toBe('descending')
    expect(parents()).toEqual([['Harbor Side', 'South'], ['North Side', 'North'], ['South', ''], ['North', '']])
  })

  test('lists each competitor domain once, with the groups that name it', async () => {
    await renderSection()
    await table('Locations')
    fireEvent.click(tab('Competitors'))
    const competitors = await table('Competitors')
    expect([...competitors.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Domain', 'Groups'])
    expect(cells(competitors)).toEqual([
      ['rival.example', '2'],
      ['other.example', '1'],
    ])
    // The count is the length of the list it opens.
    expect(within(competitors).getByRole('button', { name: '2 groups: North · North Side' }).textContent).toBe('2')
    expect(within(competitors).getByRole('button', { name: '1 group: North' }).textContent).toBe('1')
  })

  test('one search box filters the open tab and keeps its text from tab to tab', async () => {
    await renderSection()
    const locations = await table('Locations')
    fireEvent.change(search(), { target: { value: 'river' } })
    // A location is found by a market that holds it.
    expect(names(locations)).toEqual(['Harbor Point'])

    fireEvent.click(tab('Markets'))
    expect(search().value).toBe('river')
    expect(names(await table('Markets'))).toEqual(['River MarketHarbor Point'])

    fireEvent.click(tab('Groups'))
    const groups = await table('Groups')
    expect(cells(groups)).toEqual([['No matches']])

    fireEvent.click(within(section()).getByRole('button', { name: 'Clear search' }))
    expect(names(groups)).toEqual(['North', 'North Side'])

    // A group is found by a competitor it names, in the form the Competitors tab prints: the way to every group behind a count.
    fireEvent.change(search(), { target: { value: 'other.example' } })
    expect(names(groups)).toEqual(['North'])
    fireEvent.change(search(), { target: { value: 'rival.example' } })
    expect(names(groups)).toEqual(['North', 'North Side'])
  })

  test('a column of numbers sorts largest first, then smallest, and says so', async () => {
    await renderSection()
    const locations = await table('Locations')
    const header = (name: string) => within(locations).getByRole('columnheader', { name })
    expect(header('Location queries').getAttribute('aria-sort')).toBe('none')

    fireEvent.click(within(header('Location queries')).getByRole('button'))
    expect(header('Location queries').getAttribute('aria-sort')).toBe('descending')
    expect(names(locations)).toEqual(['Harbor Point', 'Northbridge', 'Cedar Hollow'])

    fireEvent.click(within(header('Location queries')).getByRole('button'))
    expect(header('Location queries').getAttribute('aria-sort')).toBe('ascending')
    expect(names(locations)).toEqual(['Cedar Hollow', 'Northbridge', 'Harbor Point'])

    // A name column starts at A, and only one column is sorted at a time.
    fireEvent.click(within(header('Location')).getByRole('button'))
    expect(header('Location').getAttribute('aria-sort')).toBe('ascending')
    expect(header('Location queries').getAttribute('aria-sort')).toBe('none')
    expect(names(locations)).toEqual(['Cedar Hollow', 'Harbor Point', 'Northbridge'])
  })

  test('shows 25 rows a page', async () => {
    const targets = Array.from({ length: 30 }, (_, index) => ({ stableKey: `place-${index + 1}`, label: `Place ${index + 1}`, marketKeys: [], counts: { propertyQueries: index, marketQueries: 0, customQueries: 0, answersPerSweep: 0 } }))
    await renderSection({ workspace: () => json(workspaceResponse({ targets })) })
    const locations = await table('Locations')
    expect(names(locations)).toHaveLength(25)
    expect(within(section()).getByText('1 to 25 of 30 locations')).toBeTruthy()
    // The page buttons come ahead of the table, a Tab or two from the search and not a page of rows away.
    const next = within(section()).getByRole('button', { name: 'Next' })
    expect(search().compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(next.compareDocumentPosition(locations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(next)
    expect(names(locations)).toEqual(['Place 26', 'Place 27', 'Place 28', 'Place 29', 'Place 30'])
    expect(within(section()).getByText('26 to 30 of 30 locations')).toBeTruthy()
    // A new order starts again from its first page.
    fireEvent.click(within(within(locations).getByRole('columnheader', { name: 'Location queries' })).getByRole('button'))
    expect(names(locations)[0]).toBe('Place 30')
    expect(names(locations)).toHaveLength(25)
  })

  test('the arrow keys move between the four tabs', async () => {
    await renderSection()
    await table('Locations')
    const tabs = within(section()).getAllByRole('tab')
    expect(tabs.map(item => [item.textContent, item.getAttribute('aria-selected'), item.tabIndex])).toEqual([['Locations', 'true', 0], ['Markets', 'false', -1], ['Groups', 'false', -1], ['Competitors', 'false', -1]])

    fireEvent.keyDown(tab('Locations'), { key: 'ArrowRight' })
    expect(tab('Markets').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Markets'))
    expect(within(section()).getByRole('tabpanel', { name: 'Markets' })).toBeTruthy()

    fireEvent.keyDown(tab('Markets'), { key: 'End' })
    expect(document.activeElement).toBe(tab('Competitors'))
    fireEvent.keyDown(tab('Competitors'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Locations'))
  })

  test('a writer opens the wizard from Bulk setup, and from an open draft', async () => {
    const { onOpenSetup } = await renderSection({ setup: setupResponse('advanced-draft'), role: 'admin' })
    await table('Locations')
    expect(stat('Open drafts')).toBe('1Open draft')
    fireEvent.click(within(section()).getByRole('button', { name: 'Open draft' }))
    fireEvent.click(within(section()).getByRole('button', { name: 'Bulk setup' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(2)
  })

  test('a viewer reads all four tabs and is offered nothing that writes', async () => {
    await renderSection({ setup: setupResponse('advanced-draft'), role: 'viewer' })
    expect(names(await table('Locations'))).toEqual(['Harbor Point', 'Northbridge', 'Cedar Hollow'])
    fireEvent.click(tab('Markets'))
    expect(names(await table('Markets'))).toHaveLength(4)
    fireEvent.click(tab('Groups'))
    expect(names(await table('Groups'))).toEqual(['North', 'North Side'])
    fireEvent.click(tab('Competitors'))
    expect(names(await table('Competitors'))).toEqual(['rival.example', 'other.example'])

    // The draft is still counted. Only the way into the wizard is gone.
    expect(stat('Open drafts')).toBe('1')
    expect(within(section()).queryByRole('button', { name: /Bulk setup|Open draft/ })).toBeNull()
    expect(within(section()).getByRole('button', { name: 'View only. Your account cannot change this setup.' })).toBeTruthy()
  })

  test('holds the page with a skeleton while the workspace is out', async () => {
    await renderSection({ workspace: () => new Promise<Response>(() => {}) })
    expect(within(section()).getByRole('status').textContent).toBe('Loading')
    expect(within(section()).queryByRole('table')).toBeNull()
    expect(within(section()).queryByRole('button')).toBeNull()
  })

  test('a failed workspace read says so and reads again on Retry', async () => {
    let failing = true
    const { requests, onRetryReads } = await renderSection({ workspace: () => failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500) : json(workspaceResponse()) })
    const alert = await within(section()).findByRole('alert')
    expect(visibleText(alert)).toBe('Could not loadRetry')
    expect(within(alert).getByRole('button', { name: 'Could not load. Locations and markets did not load.' })).toBeTruthy()

    failing = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(names(await table('Locations'))).toHaveLength(3)
    expect(requests.filter(request => request.endsWith('/query-tracking'))).toHaveLength(2)
    // The page's own reads did not fail, so they are not read again.
    expect(onRetryReads).not.toHaveBeenCalled()
  })

  test('holds the skeleton while the published plan is out, though the workspace has answered', async () => {
    const { requests, client } = await renderSection({ plan: undefined })
    await waitFor(() => expect(requests).toHaveLength(1))
    await waitFor(() => expect(client.isFetching()).toBe(0))
    // Names and site pages come from the plan: the tables wait for it, so no column fills in a moment later.
    expect(within(section()).getByRole('status').textContent).toBe('Loading')
    expect(within(section()).queryByRole('table')).toBeNull()
  })

  test('a failed setup read says so and hands Retry to the page', async () => {
    const { onRetryReads } = await renderSection({ setup: undefined, plan: undefined, setupFailed: true })
    const alert = within(section()).getByRole('alert')
    expect(visibleText(alert)).toBe('Could not loadRetry')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(onRetryReads).toHaveBeenCalledTimes(1)
  })

  test('a failed plan read on a published setup says so and hands Retry to the page', async () => {
    const { requests, onRetryReads } = await renderSection({ plan: undefined, planFailed: true })
    const alert = await within(section()).findByRole('alert')
    expect(visibleText(alert)).toBe('Could not loadRetry')
    expect(within(section()).queryByRole('table')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(onRetryReads).toHaveBeenCalledTimes(1)
    // The workspace read did not fail, so it is not read again.
    expect(requests.filter(request => request.endsWith('/query-tracking'))).toHaveLength(1)
  })

  test('each tab with nothing to list says so, whatever the search box holds', async () => {
    const plan: MeasurementPlanResponse = { active: { ...publishedPlan.active!, plan: { ...planV2, groups: planV2.groups.map(group => ({ ...group, competitors: [] })) } } }
    await renderSection({ plan, workspace: () => json(workspaceResponse({ targets: [], markets: [], groups: [] })) })
    const body = async (name: string) => {
      fireEvent.click(tab(name))
      return cells(await table(name))
    }
    expect(cells(await table('Locations'))).toEqual([['No locations']])
    expect(await body('Markets')).toEqual([['No markets']])
    expect(await body('Groups')).toEqual([['No groups']])
    expect(await body('Competitors')).toEqual([['No competitors']])

    // An empty tab is empty, not a search with no match.
    fireEvent.change(search(), { target: { value: 'harbor' } })
    expect(await body('Competitors')).toEqual([['No competitors']])
    expect(await body('Markets')).toEqual([['No markets']])
    // With no rows there is no page to count.
    expect(within(section()).queryByText(/ of \d/)).toBeNull()
  })

  test('prints nothing for a number the reads did not return, and never works one out', async () => {
    // An older server: no totals, no counts and no lists on the rows. No plan is held either.
    const bare = workspaceResponse({
      targets: [{ stableKey: 'harbor-point', label: 'Harbor Point' }],
      markets: [{ stableKey: 'north-market', label: 'North Market', usageEdges: [] }],
      groups: [{ stableKey: 'north', label: 'North', targetKeys: ['harbor-point'] }],
      summary: undefined,
    })
    await renderSection({ plan: { active: null }, workspace: () => json(bare) })
    expect(cells(await table('Locations'))).toEqual([['Harbor Point', '', '', '', '', '']])
    // No total came, so no grid is drawn: the lists are never counted in its place.
    expect(section().querySelector('dl')).toBeNull()

    fireEvent.click(tab('Markets'))
    expect(cells(await table('Markets'))).toEqual([['North Market', '', '', '']])
    fireEvent.click(tab('Groups'))
    // A group's locations are the length of the list the server sent with it.
    expect(cells(await table('Groups'))).toEqual([['North', '1', '', '', '']])
  })
})

describe('a project with no published setup', () => {
  test('shows the title and one button that opens setup, with the sentence behind the info icon', async () => {
    const { requests, onOpenSetup } = await renderSection({ setup: setupResponse('simple'), plan: { active: null } })
    expect(visibleText(section())).toBe('Locations & marketsAdd locations')
    expect(within(section()).getByRole('button', { name: LOCATIONS_MARKETS_COPY.help })).toBeTruthy()
    // The heading's own name carries no sentence.
    expect(within(section()).getByRole('heading', { level: 2 }).textContent).toBe('Locations & markets')

    fireEvent.click(within(section()).getByRole('button', { name: 'Add locations' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
    // There is no structure to read, so the workspace is not asked for.
    expect(requests).toEqual([])
  })

  test.each([
    ['simple-draft', 'Continue setup'],
    ['v1', 'Republish setup'],
  ] as const)('keeps the wizard\'s own words for a %s setup', async (kind, label) => {
    await renderSection({ setup: setupResponse(kind), plan: { active: null } })
    expect(visibleText(section())).toBe(`Locations & markets${label}`)
  })

  test('offers a viewer no button, and says there is nothing to read', async () => {
    await renderSection({ setup: setupResponse('simple'), plan: { active: null }, role: 'viewer' })
    // "View only" sits in the header, where a published setup has it; the body is the empty state.
    expect(visibleText(section())).toBe('Locations & marketsView onlyNo locations')
    expect(within(section()).queryByRole('button', { name: /^(Add locations|Continue setup|Republish setup)$/ })).toBeNull()
    expect(within(section()).getByRole('button', { name: 'View only. Your account cannot change this setup.' })).toBeTruthy()
  })

  test('a failed plan read does not take the setup button away: this section reads no plan here', async () => {
    const { onRetryReads, onOpenSetup } = await renderSection({ setup: setupResponse('simple'), plan: undefined, planFailed: true })
    expect(within(section()).queryByRole('alert')).toBeNull()
    expect(visibleText(section())).toBe('Locations & marketsAdd locations')
    fireEvent.click(within(section()).getByRole('button', { name: 'Add locations' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
    expect(onRetryReads).not.toHaveBeenCalled()
  })

  test('waits for the setup read before offering anything', async () => {
    const { requests } = await renderSection({ setup: undefined, plan: undefined })
    expect(within(section()).getByRole('status').textContent).toBe('Loading')
    expect(within(section()).queryByRole('button')).toBeNull()
    expect(requests).toEqual([])
  })
})

describe('projectStructure', () => {
  const workspace = workspaceResponse()

  test('prints nothing for a number or a list a read did not return', () => {
    const bare = projectStructure({
      targets: [{ stableKey: 'harbor-point', label: 'Harbor Point' }],
      markets: [{ stableKey: 'north-market', label: 'North Market', usageEdges: [] }],
      groups: [{ stableKey: 'north', label: 'North', targetKeys: ['harbor-point'] }],
    }, null)
    expect(bare.locations).toEqual([{ key: 'harbor-point', label: 'Harbor Point', markets: undefined, sitePages: undefined, names: undefined, locationQueries: undefined, marketQueries: undefined, search: 'Harbor Point' }])
    expect(bare.markets).toEqual([{ key: 'north-market', label: 'North Market', members: undefined, group: undefined, locations: undefined, marketQueries: undefined, search: 'North Market' }])
    expect(bare.groups).toEqual([{ key: 'north', label: 'North', parent: undefined, locations: 1, markets: undefined, competitors: undefined, search: 'North' }])
    expect(bare.competitors).toEqual([])
  })

  test('joins the plan to the workspace by stable key, whatever order the plan lists them in', () => {
    const reordered = { targets: [...planV2.targets].reverse(), groups: [...planV2.groups].reverse() }
    const joined = projectStructure(workspace, reordered)
    expect(joined.locations.map(row => [row.key, row.names, row.sitePages?.length])).toEqual([['harbor-point', 2, 2], ['northbridge', 1, 1], ['cedar-hollow', 0, 0]])
    expect(joined.groups.map(row => [row.key, row.competitors])).toEqual([['north', 2], ['north-side', 1]])
    // A location the plan does not hold has no names or site pages to print: nothing is assumed.
    expect(projectStructure(workspace, { targets: [], groups: [] }).locations[0]).toMatchObject({ names: undefined, sitePages: undefined })
  })
})

describe('sortStructureRows', () => {
  const rows = [{ name: 'b', value: 2 as number | undefined }, { name: 'a', value: undefined }, { name: 'c', value: 10 }]

  test('keeps a row with no value last in both directions, and the listed order when unsorted', () => {
    expect(sortStructureRows(rows, row => row.value, 'desc').map(row => row.name)).toEqual(['c', 'b', 'a'])
    expect(sortStructureRows(rows, row => row.value, 'asc').map(row => row.name)).toEqual(['b', 'c', 'a'])
    expect(sortStructureRows(rows, undefined, undefined)).toBe(rows)
  })

  test('orders names as a reader does: no case, and 2 before 10', () => {
    const places = ['Place 10', 'place 2', 'Place 1'].map(name => ({ name }))
    expect(sortStructureRows(places, row => row.name, 'asc').map(row => row.name)).toEqual(['Place 1', 'place 2', 'Place 10'])
  })

  test('a second click flips the column; a new column starts at its natural end', () => {
    expect(nextStructureSort(undefined, 'names', true)).toEqual({ key: 'names', direction: 'desc' })
    expect(nextStructureSort({ key: 'names', direction: 'desc' }, 'names', true)).toEqual({ key: 'names', direction: 'asc' })
    expect(nextStructureSort({ key: 'names', direction: 'asc' }, 'location', false)).toEqual({ key: 'location', direction: 'asc' })
  })
})
