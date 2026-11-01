import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useParams } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentJourneyContext, AgentJourneyDetailResponse, AgentJourneysResponse, JourneyDetailResponse, JourneySummaryResponse, JourneysResponse } from '@canonry/canonry-contracts'
import { AccountProvider, type ApiKeyAccess, type SignedInAccount } from '../src/contexts/account-context.js'
import { TrafficPage } from '../src/pages/TrafficPage.js'
import { JourneysSection } from '../src/components/project/JourneysSection.js'
import { jsonResponse as json } from './mock-fetch.js'

// The browser owns selection, paging and layout of API values. Grouping,
// request classification and authorization are exercised by the API suite.
const context: AgentJourneyContext = {
  scope: { project: 'example', sourceId: null, agentId: null, trust: null, targetKey: null, mode: 'simple', planRevision: null, attribution: 'project', unavailableDimensions: ['market', 'query', 'query-class', 'model', 'task'] },
  windowStart: '2026-10-26T13:00:00.000Z', windowEnd: '2026-10-27T13:00:00.000Z', properties: [],
  coverage: {
    recordingEnabled: true, retentionDays: 30, idleMinutes: 30, dailyEventLimit: 10_000, windowBounded: true,
    cappedSourceDays: [{ sourceId: 'edge', day: '2026-10-27' }], likelyFakeRequests: 3,
    sources: [{ sourceId: 'edge', sourceType: 'cloudflare', label: 'Website edge', limitations: ['Requests blocked before the collector may be absent.'] }],
    limitations: ['Shared provider addresses may combine different tasks.'],
  },
}
const journeys: AgentJourneysResponse = {
  ...context, observedRequests: 146, totalJourneys: 27, limit: 20, offset: 0,
  journeys: [{
    id: 'request-one', sourceId: 'edge', agentId: 'chatgpt-user', operator: 'OpenAI', product: 'ChatGPT-User',
    correlationBasis: 'ip-ua', correlation: 'inferred', startedAt: '2026-10-27T12:01:00.000Z', endedAt: '2026-10-27T12:07:00.000Z',
    firstHost: 'example.com', firstPath: '/rooms', lastPath: '/booking', requestCount: 55, errorCount: 2, trustLevels: ['verified'], targetKeys: [],
  }],
}
const detail: AgentJourneyDetailResponse = {
  ...context, journey: journeys.journeys[0]!, totalEvents: 55, limit: 50, offset: 0,
  events: [
    { id: 'request-one', ts: '2026-10-27T12:01:00.000Z', host: 'example.com', path: '/rooms', method: 'GET', status: 200, latencyMs: null, verificationStatus: 'verified', verificationManifest: null, trust: 'verified', trustReasons: ['ip-in-published-list', 'documented-user-agent'], targetKey: null, attribution: 'not-configured' },
    { id: 'request-two', ts: '2026-10-27T12:02:00.000Z', host: 'example.com', path: '/api/availability', method: 'HEAD', status: 302, latencyMs: 10, verificationStatus: 'verified', verificationManifest: null, trust: 'verified', trustReasons: ['ip-in-published-list', 'documented-user-agent'], targetKey: null, attribution: 'not-configured' },
  ],
}
const visitorSummary: JourneySummaryResponse = {
  project: 'example', windowStart: '2026-09-27T13:00:00.000Z', windowEnd: context.windowEnd, lookbackDays: 30,
  aiVisitors: 27, aiVisits: 41, returningVisitors: 9, returnRate: 1 / 3, medianDaysToReturn: 2.5,
  returnedVia: { ai: 3, search: 8, direct: 4, social: 0, paid: 0, referral: 1 },
  byEngine: [{ engine: 'ChatGPT', visitors: 20, returningVisitors: 7 }, { engine: 'Perplexity', visitors: 7, returningVisitors: 2 }],
  keyBasis: { ipUa: 24, ua: 3 },
  partialSources: [{ sourceId: 'edge', sourceType: 'cloudflare', reason: 'This source has not enabled page-view forwarding.' }],
}
const visitor = {
  visitorKey: 'visitor-one', keyBasis: 'ua' as const, device: 'Mac · Safari', userAgent: 'Synthetic Safari browser',
  firstAiAt: '2026-10-01T09:00:00.000Z', firstAiEngine: 'ChatGPT', lastAiAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-29T10:00:00.000Z', visitCount: 23, aiVisitCount: 1, returned: true,
  // 23 visits: the first AI visit and 22 later ones, as the API counts them.
  returnChannels: ['search', ...Array<'direct'>(21).fill('direct')] as JourneysResponse['visitors'][number]['returnChannels'], cappedDays: 2,
}
const aiVisit = {
  id: 'visit-one', sourceId: 'edge', startedAt: visitor.firstAiAt, endedAt: '2026-10-01T09:02:00.000Z',
  entryClass: 'ai' as const, entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false,
  landingPath: '/rooms', requestCount: 6, pageCount: 4,
}
const searchVisit = {
  id: 'visit-two', sourceId: 'logs', startedAt: '2026-10-03T14:03:00.000Z', endedAt: '2026-10-03T14:15:00.000Z',
  entryClass: 'search' as const, entryName: 'Google', entryHost: 'google.com', paid: false,
  landingPath: '/', requestCount: 51, pageCount: 9,
}
const directVisit = { ...searchVisit, id: 'visit-three', startedAt: '2026-10-05T09:12:00.000Z', endedAt: '2026-10-05T09:12:00.000Z', entryClass: 'direct' as const, entryName: null, entryHost: null, requestCount: 1, pageCount: 1 }
const visitors: JourneysResponse = {
  project: 'example', windowStart: visitorSummary.windowStart, windowEnd: visitorSummary.windowEnd,
  lookbackDays: 30, retentionDays: 180, totalVisitors: 27, limit: 20, offset: 0,
  partialSources: visitorSummary.partialSources,
  visitors: [{ ...visitor, visits: [aiVisit, searchVisit, directVisit] }],
}
const visitorDetail: JourneyDetailResponse = {
  project: 'example', events: 'pages', visitor, totalVisits: 23, limit: 12, offset: 0,
  visits: [
    { ...aiVisit, events: [{ ts: aiVisit.startedAt, method: 'GET', path: '/rooms', status: 200, kind: 'page', aiTouch: true }] },
    { ...searchVisit, events: [
      { ts: '2026-10-03T14:03:00.000Z', method: 'GET', path: '/', status: 200, kind: 'page', aiTouch: false },
      { ts: '2026-10-03T14:10:00.000Z', method: 'GET', path: '/booking/confirmation', status: 200, kind: 'page', aiTouch: false },
      { ts: '2026-10-03T14:10:05.000Z', method: 'POST', path: '/api/hear-about-us', status: 200, kind: 'data', aiTouch: false },
      { ts: '2026-10-03T14:12:00.000Z', method: 'GET', path: '/gone', status: 404, kind: 'page', aiTouch: false },
    ] },
  ],
}
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
})

function responses(read: (url: URL) => Response): URL[] {
  const reads: URL[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/projects')) return json([{ id: 'example-id', name: 'example', canonicalDomain: 'example.com' }])
    if (url.pathname.endsWith('/traffic/sources')) return json({ sources: [] })
    reads.push(url)
    return read(url)
  })
  return reads
}
const visitorResponses = (overrides: { list?: (url: URL) => unknown; detail?: (url: URL) => unknown; summary?: unknown } = {}) => responses(url => {
  if (url.pathname.endsWith('/journeys/summary')) return json(overrides.summary ?? visitorSummary)
  if (url.pathname.endsWith('/journeys/visitor-one')) return json(overrides.detail?.(url) ?? visitorDetail)
  if (url.pathname.endsWith('/request-one')) return json(detail)
  if (url.pathname.endsWith('/traffic/agent-journeys')) return json(journeys)
  return json(overrides.list?.(url) ?? visitors)
})

function JourneysRoute() {
  const { projectName } = useParams({ strict: false }) as { projectName: string }
  return <JourneysSection projectName={projectName} />
}

async function mount(location = '/projects/example/journeys', account: SignedInAccount | null = null, apiKey?: ApiKeyAccess) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } })
  clients.push(client)
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/journeys', validateSearch: (search: Record<string, unknown>) => search, component: JourneysRoute })
  const traffic = createRoute({ getParentRoute: () => root, path: '/traffic', component: TrafficPage })
  const sourceDetail = createRoute({ getParentRoute: () => root, path: '/traffic/$projectName/$sourceId', component: () => <p>Source detail</p> })
  const router = createRouter({ routeTree: root.addChildren([route, traffic, sourceDetail]), history: createMemoryHistory({ initialEntries: [location] }) })
  await router.load()
  render(<AccountProvider account={account} apiKey={apiKey}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></AccountProvider>)
  return router
}
const lastRead = (reads: URL[], suffix: string) => reads.filter(url => url.pathname.endsWith(suffix)).at(-1)

test('the headline reads the API: visitors, came back with the rate in its tooltip, median return and return visits by channel', async () => {
  visitorResponses()
  await mount()
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(screen.getByText('AI-referred visitors').nextElementSibling?.textContent).toBe('27')
  const cameBack = screen.getByText('Came back', { selector: 'dt' }).nextElementSibling!
  expect(cameBack.textContent).toBe('9 of 27, a 33.3% return rate')
  expect(screen.getByRole('button', { name: '33.3% came back in a later visit.' })).not.toBeNull()
  expect(screen.getByText('Median time to return').nextElementSibling?.textContent).toBe('2.5 days')
  const channels = screen.getByText('Return visits by channel').nextElementSibling!
  expect(channels.textContent).toBe('Search 8Direct 4AI referral 3Referral 1')
  expect(within(channels as HTMLElement).queryByText(/Social|Paid/)).toBeNull()
  const note = screen.getByText('Later visits are not recorded for Cloudflare.').closest('li')!
  expect(within(note).getByRole('button', { name: 'This source has not enabled page-view forwarding.' })).not.toBeNull()
  expect(within(note).getByRole('link', { name: 'Review source' }).getAttribute('href')).toBe('/traffic/example/edge')
})

test('a median return under a day reads in hours', async () => {
  visitorResponses({ summary: { ...visitorSummary, medianDaysToReturn: 0.1 } })
  await mount()
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(screen.getByText('Median time to return').nextElementSibling?.textContent).toBe('2 hours')
})

test('a median return under an hour reads in minutes', async () => {
  visitorResponses({ summary: { ...visitorSummary, medianDaysToReturn: 0.0403 } })
  await mount()
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(screen.getByText('Median time to return').nextElementSibling?.textContent).toBe('58 minutes')
})

test('visitor rows show the first AI visit, its landing page without tracking codes, the way back, visits and last seen', async () => {
  visitorResponses({ list: () => ({ ...visitors, visitors: [{ ...visitors.visitors[0]!, visits: [{ ...aiVisit, landingPath: '/rooms?utm_source=chatgpt.com' }, searchVisit, directVisit] }] }) })
  await mount()
  const table = await screen.findByRole('table', { name: 'AI-referred visitors' })
  const cells = within(table).getAllByRole('row')[1]!.querySelectorAll('td')
  expect(within(cells[0]!).getByText('ChatGPT')).not.toBeNull()
  // The tracking query is dropped from view; the full path stays on hover.
  expect(cells[1]!.textContent).toBe('/rooms')
  expect(cells[1]!.querySelector('[title]')?.getAttribute('title')).toBe('/rooms?utm_source=chatgpt.com')
  // 22 later visits: two listed, the rest counted from the API's return channels.
  expect(cells[2]!.textContent).toBe('Google, Direct +20 more')
  expect(cells[3]!.textContent).toBe('23')
  expect(screen.getByText('1 to 1 of 27 visitors')).not.toBeNull()
})

test('back to back visits through one channel are said once, and a row without its AI visit says its landing page was not kept', async () => {
  const repeat = { ...visitor, visitorKey: 'repeat', visitCount: 4, returnChannels: ['search', 'search', 'direct'] as JourneysResponse['visitors'][number]['returnChannels'], visits: [aiVisit, searchVisit, { ...searchVisit, id: 'visit-two-again' }, directVisit] }
  // Retention can remove a first AI visit while later visits remain.
  const noAiVisit = { ...visitor, visitorKey: 'no-ai', firstAiEngine: 'Perplexity', visitCount: 1, returnChannels: [], returned: false, visits: [directVisit] }
  visitorResponses({ list: () => ({ ...visitors, totalVisitors: 2, visitors: [repeat, noAiVisit] }) })
  await mount()
  const table = await screen.findByRole('table', { name: 'AI-referred visitors' })
  const [first, second] = within(table).getAllByRole('row').slice(1)
  expect(first!.querySelectorAll('td')[2]!.textContent).toBe('Google ×2, Direct')
  expect(second!.querySelectorAll('td')[2]!.textContent).toBe('No return yet')
  expect(within(second!.querySelectorAll('td')[0]!).getByText('Perplexity')).not.toBeNull()
  expect(second!.querySelectorAll('td')[1]!.textContent).toBe('Not kept')
})

test('filters, paging and period go into the URL and the requests, while the headline stays unfiltered', async () => {
  const reads = visitorResponses({ list: url => ({ ...visitors, offset: Number(url.searchParams.get('offset') ?? 0), totalVisitors: url.searchParams.get('returned') === 'true' ? 7 : 27 }) })
  const router = await mount()
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  fireEvent.click(screen.getByRole('button', { name: 'Next visitors' }))
  await waitFor(() => expect(lastRead(reads, '/journeys')?.searchParams.get('offset')).toBe('20'))
  expect(router.state.location.search).toMatchObject({ journeyOffset: '20' })
  fireEvent.click(screen.getByText('Filter'))
  fireEvent.change(screen.getByRole('combobox', { name: 'First AI engine' }), { target: { value: 'ChatGPT' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Came back' }), { target: { value: 'true' } })
  await waitFor(() => expect(Object.fromEntries(lastRead(reads, '/journeys')!.searchParams)).toMatchObject({ engine: 'ChatGPT', returned: 'true', offset: '0' }))
  expect(router.state.location.search).toMatchObject({ journeyEngine: 'ChatGPT', journeyReturned: 'true' })
  expect((router.state.location.search as Record<string, unknown>).journeyOffset).toBeUndefined()
  await screen.findByText('1 to 1 of 7 visitors')
  expect(screen.getByText('AI-referred visitors').nextElementSibling?.textContent).toBe('27')
  for (const summary of reads.filter(url => url.pathname.endsWith('/summary'))) expect([...summary.searchParams.keys()].sort()).toEqual(['since', 'until'])
  fireEvent.click(screen.getByRole('radio', { name: '7d' }))
  await waitFor(() => {
    const summary = lastRead(reads, '/summary')!
    expect(Date.parse(summary.searchParams.get('until')!) - Date.parse(summary.searchParams.get('since')!)).toBe(7 * 86_400_000)
  })
  expect(router.state.location.search).toMatchObject({ journeyDays: '7' })
  expect(screen.getByRole('radio', { name: '7d' }).getAttribute('aria-checked')).toBe('true')
  // One tab stop; arrow keys move the period like any radio group.
  const periods = screen.getByRole('radiogroup', { name: 'First AI visit within' })
  expect(within(periods).getAllByRole('radio').map(radio => radio.tabIndex)).toEqual([0, -1, -1, -1])
  fireEvent.keyDown(within(periods).getByRole('radio', { name: '7d' }), { key: 'ArrowRight' })
  await waitFor(() => expect((router.state.location.search as Record<string, unknown>).journeyDays).toBeUndefined())
  expect(within(periods).getByRole('radio', { name: '30d' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }))
  await waitFor(() => expect(lastRead(reads, '/journeys')?.searchParams.has('engine')).toBe(false))
})

test('no visitor opens by default; an opened one lists its visits top to bottom, and a visit lists its pages and non-GET requests', async () => {
  const reads = visitorResponses()
  const router = await mount()
  const table = await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(screen.queryByRole('table', { name: 'Visits in time order' })).toBeNull()
  expect(reads.some(url => url.pathname.endsWith('/visitor-one'))).toBe(false)
  const opener = within(table).getByRole('button', { name: /^ChatGPT visitor, first AI visit / })
  fireEvent.click(opener)
  const visits = await screen.findByRole('table', { name: 'Visits in time order' })
  expect(opener.getAttribute('aria-expanded')).toBe('true')
  expect(router.state.location.search).toMatchObject({ journeyVisitor: 'visitor-one' })
  expect(Object.fromEntries(lastRead(reads, '/visitor-one')!.searchParams)).toEqual({ limit: '12', offset: '0', events: 'pages' })
  const rows = within(visits).getAllByRole('row').slice(1)
  expect(rows.map(row => [...row.querySelectorAll('td')].slice(1).map(cell => cell.textContent))).toEqual([
    ['ChatGPT · AI referral', '/rooms', '4'],
    ['Google · Search', '/', '9'],
  ])
  fireEvent.click(within(rows[1]!).getByRole('button'))
  const requests = await screen.findByRole('list', { name: 'Google visit requests' })
  // Requests print as recorded: a write keeps its method, an error its status.
  expect(within(requests).getAllByRole('listitem').map(item => [...item.children].slice(1).map(child => child.textContent))).toEqual([
    ['/'], ['/booking/confirmation'], ['POST /api/hear-about-us'], ['/gone', '404'],
  ])
  expect(within(requests).getByText('404').className).toContain('text-caution')
})

test('a visitor opened from a link who is not on this page of the list still opens, and closes', async () => {
  const offPage = { ...visitorDetail, visitor: { ...visitor, visitorKey: 'visitor-two' }, totalVisits: 1, visits: [{ ...searchVisit, entryName: null, paid: true, events: [] }] }
  const reads = responses(url => url.pathname.endsWith('/journeys/visitor-two') ? json(offPage)
    : url.pathname.endsWith('/journeys/summary') ? json(visitorSummary) : json(visitors))
  const router = await mount('/projects/example/journeys?journeyVisitor=visitor-two')
  await screen.findByText('This visitor is not on this page of the list.')
  const visits = await screen.findByRole('table', { name: 'Visits in time order' })
  expect(lastRead(reads, '/visitor-two')).toBeDefined()
  // An unnamed paid search says its class once.
  expect(within(visits).getAllByRole('row')[1]!.querySelectorAll('td')[1]!.textContent).toBe('Search · Paid')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect((router.state.location.search as Record<string, unknown>).journeyVisitor).toBeUndefined())
  expect(screen.queryByText('This visitor is not on this page of the list.')).toBeNull()
})

test('show all requests switches the server filter, and later visits page the open visitor', async () => {
  const reads = visitorResponses({ detail: url => url.searchParams.get('offset') === '12'
    ? { ...visitorDetail, offset: 12, visits: [{ ...directVisit, events: [{ ts: directVisit.startedAt, method: 'GET', path: '/', status: null, kind: 'page', aiTouch: false }] }] }
    : { ...visitorDetail, events: url.searchParams.get('events') === 'all' ? 'all' : 'pages' } })
  await mount('/projects/example/journeys?journeyVisitor=visitor-one')
  const visits = await screen.findByRole('table', { name: 'Visits in time order' })
  fireEvent.click(within(within(visits).getAllByRole('row')[1]!).getByRole('button'))
  fireEvent.click(await screen.findByRole('button', { name: 'Show all 6 requests' }))
  await waitFor(() => expect(lastRead(reads, '/visitor-one')?.searchParams.get('events')).toBe('all'))
  await screen.findByRole('button', { name: 'Show fewer requests' })
  fireEvent.click(screen.getByRole('button', { name: 'Later visits' }))
  await waitFor(() => expect(lastRead(reads, '/visitor-one')?.searchParams.get('offset')).toBe('12'))
  await waitFor(() => {
    const rows = within(screen.getByRole('table', { name: 'Visits in time order' })).getAllByRole('row').slice(1)
    expect(rows.map(row => row.querySelectorAll('td')[1]!.textContent)).toEqual(['Direct'])
  })
})

test('an open visitor discloses matching, capped days, identity and a missing later source', async () => {
  visitorResponses({ detail: () => ({ ...visitorDetail, totalVisits: 2, visits: [visitorDetail.visits[0]!, { ...visitorDetail.visits[1]!, sourceId: 'edge' }] }) })
  await mount('/projects/example/journeys?journeyVisitor=visitor-one')
  await screen.findByRole('table', { name: 'Visits in time order' })
  expect(screen.getByText('Matched by browser only')).not.toBeNull()
  expect(screen.getByText('2 visits')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'May combine people who use the same browser version.' })).not.toBeNull()
  expect(screen.getByText('Some requests are missing on 2 days.')).not.toBeNull()
  expect(screen.getByRole('button', { name: /^At most [\d,]+ requests per visitor are kept each day\.$/ })).not.toBeNull()
  expect(screen.getByText('Later visits are not recorded by Cloudflare.')).not.toBeNull()
  fireEvent.click(screen.getByText('Technical details'))
  expect(screen.getByText('Synthetic Safari browser')).not.toBeNull()
  expect(screen.getByText('visitor-one')).not.toBeNull()
  fireEvent.click(screen.getByText('About this data'))
  expect(within(screen.getByRole('table', { name: 'Visitors by first AI engine' })).getByRole('row', { name: 'ChatGPT 20 7' })).not.toBeNull()
  expect(screen.getByText('Matching: 24 visitors by network and browser, 3 visitors by browser only.')).not.toBeNull()
  expect(screen.getByText('41 AI-referred visits started in this period, including visits from earlier visitors.')).not.toBeNull()
})

test('agent visits open and page through the SDK with the server window and counts', async () => {
  const reads = responses(url => url.pathname.endsWith('/request-one')
    ? json(url.searchParams.get('offset') === '50' ? { ...detail, offset: 50, events: [{ ...detail.events[0]!, id: 'request-last', path: '/booking', method: 'POST', status: 409, latencyMs: 42 }] } : detail)
    : json(journeys))
  const router = await mount('/projects/example/journeys?journeyView=agents')
  const table = await screen.findByRole('table', { name: 'Agent visits' })
  expect(screen.getByText('Agent visits', { selector: 'dt' }).nextElementSibling?.textContent).toBe('27')
  expect(screen.getByText('Requests', { selector: 'dt' }).nextElementSibling?.textContent).toBe('146')
  expect(within(table).getByText('55')).not.toBeNull()
  expect(within(table).getByText('2 errors')).not.toBeNull()
  expect(within(table).getByText('Verified')).not.toBeNull()
  expect(within(table).queryByText('Inferred sequence')).toBeNull()
  // Likely fakes are counted by the API and never listed.
  expect(screen.getByText('Fake, not shown', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3')
  expect(screen.getByRole('button', { name: 'Bots posing as an AI assistant, such as scanners looking for secret files.' })).not.toBeNull()
  expect(screen.getByText('Some requests are missing: a source reached its daily limit.')).not.toBeNull()
  const opener = within(table).getByRole('button', { name: /ChatGPT-User visit/ })
  fireEvent.click(opener)
  const requests = await screen.findByRole('table', { name: 'ChatGPT-User recorded requests' })
  expect(opener.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(": IP on OpenAI's published list · User agent matches OpenAI's published one")).not.toBeNull()
  const rows = within(requests).getAllByRole('row').slice(1)
  expect(rows.map(row => [...row.querySelectorAll('td')].slice(1).map(cell => cell.textContent))).toEqual([
    ['example.com/rooms', '-', '200'], ['HEAD example.com/api/availability', '10 ms', '302'],
  ])
  expect(Object.fromEntries(lastRead(reads, '/request-one')!.searchParams)).toEqual({ since: context.windowStart, until: context.windowEnd, limit: '50', offset: '0' })
  fireEvent.click(screen.getByRole('button', { name: 'Later requests' }))
  await screen.findByText('409')
  expect(screen.getByText('42 ms')).not.toBeNull()
  expect(within(screen.getByRole('table', { name: 'ChatGPT-User recorded requests' })).getAllByRole('row')[1]!.querySelectorAll('td')[1]!.textContent).toBe('POST example.com/booking')
  expect(lastRead(reads, '/request-one')?.searchParams.get('offset')).toBe('50')
  fireEvent.click(screen.getByRole('radio', { name: '7d' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ journeyView: 'agents', agentHours: '168' }))
})

test('Advanced Property, source and trust filters reach list and detail without treating market as known', async () => {
  const properties = [{ key: 'hotel', label: 'Hotel' }, { key: 'cafe', label: 'Cafe' }]
  const reads = responses(url => {
    const scope: AgentJourneyContext['scope'] = { ...context.scope, mode: 'advanced', planRevision: 8, attribution: 'current-plan-url', targetKey: url.searchParams.get('targetKey'), sourceId: url.searchParams.get('sourceId'), trust: 'verified' }
    // The API has no likely fake count for a Property.
    const coverage = { ...context.coverage, likelyFakeRequests: url.searchParams.has('targetKey') ? null : 3 }
    return json(url.pathname.endsWith('/request-one')
      ? { ...detail, scope, coverage, properties, events: [{ ...detail.events[0]!, targetKey: 'cafe', attribution: 'matched' }] }
      : { ...journeys, scope, coverage, properties })
  })
  await mount('/projects/example/journeys?journeyView=agents')
  await screen.findByRole('table', { name: 'Agent visits' })
  expect(screen.getByText('Fake, not shown', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3')
  fireEvent.click(screen.getByText('Filter'))
  fireEvent.click(screen.getByText('Property: All properties'))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a property' }), { target: { value: 'cafe' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cafe' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'edge' } })
  const trust = screen.getByRole('combobox', { name: 'Trust' })
  // Likely fakes are never listed, so they are not a filter choice.
  expect(within(trust).getAllByRole('option').map(option => option.textContent)).toEqual(['All trust levels', 'Verified', 'Likely real', 'Unknown'])
  fireEvent.change(trust, { target: { value: 'verified' } })
  await waitFor(() => expect(reads.some(url => url.searchParams.get('targetKey') === 'cafe' && url.searchParams.get('sourceId') === 'edge' && url.searchParams.get('trust') === 'verified')).toBe(true))
  expect(screen.getByText('Trust:')).not.toBeNull()
  // A site-wide count would read as this Property's, so it is hidden.
  expect(screen.queryByText('Fake, not shown')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /ChatGPT-User visit/ }))
  const requests = await screen.findByRole('table', { name: 'ChatGPT-User recorded requests' })
  expect(within(requests).getByText('Cafe')).not.toBeNull()
  const request = lastRead(reads, '/request-one')!
  expect(Object.fromEntries(request.searchParams)).toMatchObject({ sourceId: 'edge', trust: 'verified', targetKey: 'cafe', since: context.windowStart, until: context.windowEnd })
  expect(request.searchParams.has('marketKey')).toBe(false)
  fireEvent.click(screen.getByText('About this data'))
  expect(screen.getByText('Property attribution uses URL matches in plan revision 8.')).not.toBeNull()
  expect(screen.getByText(/do not show the person's task, market/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Only ChatGPT-User' }))
  await waitFor(() => expect(reads.at(-1)?.searchParams.get('agentId')).toBe('chatgpt-user'))
  expect(reads.at(-1)?.searchParams.get('offset')).toBe('0')
})

test('the view switch lives in the URL and mounts only the active evidence', async () => {
  const reads = visitorResponses()
  const router = await mount()
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(screen.getByRole('button', { name: 'Visitors' }).getAttribute('aria-current')).toBe('page')
  expect(reads.some(url => url.pathname.includes('/traffic/agent-journeys'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Agent requests' }))
  await screen.findByRole('table', { name: 'Agent visits' })
  expect(router.state.location.search).toMatchObject({ journeyView: 'agents' })
  expect(screen.queryByRole('table', { name: 'AI-referred visitors' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Visitors' }))
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect((router.state.location.search as Record<string, unknown>).journeyView).toBeUndefined()
})

test.each(['viewer', 'embed'])('journeys make no private requests in %s mode', async mode => {
  if (mode === 'embed') window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  const reads = responses(() => json(journeys))
  await mount('/projects/example/journeys', mode === 'viewer' ? { name: 'Viewer', role: 'viewer' } : null)
  await screen.findByText('Journeys are unavailable for view-only accounts and embedded reports.')
  expect(screen.queryByRole('navigation', { name: 'Journey view' })).toBeNull()
  expect(reads).toEqual([])
})

test.each(['visitors', 'agents'])('project-scoped read keys can inspect the %s view', async view => {
  const reads = visitorResponses()
  await mount(`/projects/example/journeys${view === 'agents' ? '?journeyView=agents' : ''}`, null, { id: 'read-key', scopes: ['read'], projectId: 'example-id', readOnly: true })
  await screen.findByRole('table', { name: view === 'agents' ? 'Agent visits' : 'AI-referred visitors' })
  expect(reads.some(url => url.pathname.endsWith(view === 'agents' ? '/traffic/agent-journeys' : '/journeys'))).toBe(true)
})

test('summary, list and detail failures recover independently without becoming empty evidence', async () => {
  const failures = new Set(['summary', 'list', 'detail'])
  responses(url => {
    const kind = url.pathname.endsWith('/summary') ? 'summary' : url.pathname.endsWith('/visitor-one') ? 'detail' : 'list'
    if (failures.has(kind)) return json({ error: { code: 'VALIDATION_ERROR', message: `Stored ${kind} unavailable.` } }, 400)
    return json(kind === 'summary' ? visitorSummary : kind === 'detail' ? visitorDetail : visitors)
  })
  await mount()
  await screen.findByText(/Could not load the visitor summary/)
  await screen.findByText(/Could not load visitors/)
  expect(screen.queryByText('No AI-referred visitors in this period.')).toBeNull()
  failures.delete('summary')
  fireEvent.click(within(screen.getByText(/Could not load the visitor summary/).closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }))
  await screen.findByText('Median time to return')
  failures.delete('list')
  fireEvent.click(within(screen.getByText(/Could not load visitors/).closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }))
  fireEvent.click(await screen.findByRole('button', { name: /^ChatGPT visitor, first AI visit / }))
  await screen.findByText(/Could not load this visitor's visits/)
  failures.delete('detail')
  fireEvent.click(within(screen.getByText(/Could not load this visitor's visits/).closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }))
  await screen.findByRole('table', { name: 'Visits in time order' })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('an empty cohort keeps unavailable values distinct from zero and keeps source gaps visible', async () => {
  visitorResponses({
    summary: { ...visitorSummary, aiVisitors: 0, aiVisits: 4, returningVisitors: 0, returnRate: null, medianDaysToReturn: null, byEngine: [], keyBasis: { ipUa: 0, ua: 0 }, returnedVia: { ai: 0, search: 0, direct: 0, social: 0, paid: 0, referral: 0 } },
    list: () => ({ ...visitors, totalVisitors: 0, visitors: [] }),
  })
  await mount()
  await screen.findByText('No AI-referred visitors in this period.')
  expect(screen.getByText('Median time to return').nextElementSibling?.textContent).toBe('Not available')
  expect(screen.getByText('Return visits by channel').nextElementSibling?.textContent).toBe('None yet')
  expect(screen.queryByText(/return rate/)).toBeNull()
  expect(screen.queryByText('0%')).toBeNull()
  expect(screen.getByText('Later visits are not recorded for Cloudflare.')).not.toBeNull()
  fireEvent.click(screen.getByText('About this data'))
  expect(screen.getByText('4 AI-referred visits started in this period, including visits from earlier visitors.')).not.toBeNull()
})

test('the traffic source page does not mount a duplicate journey analysis or make private journey reads', async () => {
  const reads = responses(() => json(journeys))
  await mount('/traffic')
  await screen.findByText('No traffic sources connected for example.')
  expect(screen.queryByRole('table', { name: 'Agent visits' })).toBeNull()
  expect(reads).toEqual([])
})

test('a failed agent read has retry, and disabled capture does not claim an absence of agent activity', async () => {
  let failed = true
  responses(() => failed ? json({ error: { code: 'VALIDATION_ERROR', message: 'Narrow the requested period.' } }, 400)
    : json({ ...journeys, journeys: [], totalJourneys: 0, observedRequests: 0, coverage: { ...context.coverage, recordingEnabled: false, cappedSourceDays: [] } }))
  await mount('/projects/example/journeys?journeyView=agents')
  await screen.findByRole('alert')
  expect(screen.queryByText('No agent requests in this period.')).toBeNull()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No agent requests in this period.')
  expect(screen.getByText('Recording is off on this instance.')).not.toBeNull()
})
