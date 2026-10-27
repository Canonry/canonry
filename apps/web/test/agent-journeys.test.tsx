import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentJourneyContext, AgentJourneyDetailResponse, AgentJourneysResponse, JourneyDetailResponse, JourneySummaryResponse, JourneysResponse } from '@canonry/canonry-contracts'
import { AccountProvider, type ApiKeyAccess, type SignedInAccount } from '../src/contexts/account-context.js'
import { TrafficPage } from '../src/pages/TrafficPage.js'
import { JourneysPage } from '../src/pages/JourneysPage.js'
import { jsonResponse as json } from './mock-fetch.js'

// The browser boundary owns selection, paging and presentation of API values.
// Grouping, request classification and authorization are exercised by the API suite.
const context: AgentJourneyContext = {
  scope: { project: 'example', sourceId: null, agentId: null, verificationStatus: null, targetKey: null, mode: 'simple', planRevision: null, attribution: 'project', unavailableDimensions: ['market', 'query', 'query-class', 'model', 'task'] },
  windowStart: '2026-10-26T13:00:00.000Z', windowEnd: '2026-10-27T13:00:00.000Z', properties: [],
  coverage: {
    recordingEnabled: true, retentionDays: 30, idleMinutes: 30, dailyEventLimit: 10_000, windowBounded: true,
    cappedSourceDays: [{ sourceId: 'edge', day: '2026-10-27' }],
    sources: [{ sourceId: 'edge', sourceType: 'cloudflare', label: 'Website edge', limitations: ['Requests blocked before the collector may be absent.'] }],
    limitations: ['Shared provider addresses may combine different tasks.'],
  },
}
const journeys: AgentJourneysResponse = {
  ...context, observedRequests: 146, totalJourneys: 27, limit: 20, offset: 0,
  journeys: [{
    id: 'request-one', sourceId: 'edge', agentId: 'chatgpt-user', operator: 'OpenAI', product: 'ChatGPT-User',
    correlationBasis: 'ip-ua', correlation: 'inferred', startedAt: '2026-10-27T12:01:00.000Z', endedAt: '2026-10-27T12:07:00.000Z',
    firstHost: 'example.com', firstPath: '/rooms', lastPath: '/booking', requestCount: 55, errorCount: 2, verificationStatuses: ['verified'], targetKeys: [],
  }],
}
const detail: AgentJourneyDetailResponse = {
  ...context, journey: journeys.journeys[0], totalEvents: 55, limit: 50, offset: 0,
  events: [
    { id: 'request-one', ts: '2026-10-27T12:01:00.000Z', host: 'example.com', path: '/rooms', method: 'GET', status: 200, latencyMs: null, verificationStatus: 'verified', verificationManifest: null, targetKey: null, attribution: 'not-configured' },
    { id: 'request-two', ts: '2026-10-27T12:02:00.000Z', host: 'example.com', path: '/api/availability', method: 'GET', status: 302, latencyMs: 10, verificationStatus: 'verified', verificationManifest: null, targetKey: null, attribution: 'not-configured' },
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
  returnChannels: ['search', 'direct'] as const, cappedDays: 2,
}
const visit = {
  id: 'visit-one', sourceId: 'edge', startedAt: visitor.firstAiAt, endedAt: '2026-10-01T09:02:00.000Z',
  entryClass: 'ai' as const, entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false,
  landingPath: '/rooms', requestCount: 6, pageCount: 4,
}
const visitors: JourneysResponse = {
  project: 'example', windowStart: visitorSummary.windowStart, windowEnd: visitorSummary.windowEnd,
  lookbackDays: 30, retentionDays: 180, totalVisitors: 27, limit: 20, offset: 0,
  partialSources: visitorSummary.partialSources,
  visitors: [{ ...visitor, returnChannels: [...visitor.returnChannels], visits: [visit] }],
}
const visitorDetail: JourneyDetailResponse = {
  project: 'example', visitor: { ...visitor, returnChannels: [...visitor.returnChannels] }, totalVisits: 23, limit: 10, offset: 0,
  visits: [{ ...visit, events: [
    { ts: visit.startedAt, method: 'GET', path: '/rooms', status: 200, kind: 'page', aiTouch: true },
    { ts: '2026-10-01T09:01:00.000Z', method: 'GET', path: '/api/availability', status: 200, kind: 'data', aiTouch: false },
  ] }],
}
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
})

function trafficResponses(read: (url: URL) => Response): URL[] {
  const reads: URL[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/projects')) return json([
      { id: 'example-id', name: 'example', canonicalDomain: 'example.com' },
      { id: 'other-id', name: 'other', canonicalDomain: 'other.example' },
    ])
    if (url.pathname.endsWith('/traffic/sources')) return json({ sources: [] })
    reads.push(url)
    return read(url)
  })
  return reads
}

async function mount(account: SignedInAccount | null = null, apiKey?: ApiKeyAccess, location = '/journeys?project=example&tab=agents') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } })
  clients.push(client)
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/journeys', validateSearch: (search: Record<string, unknown>) => search, component: JourneysPage })
  const sources = createRoute({ getParentRoute: () => root, path: '/traffic', component: TrafficPage })
  const router = createRouter({ routeTree: root.addChildren([route, sources]), history: createMemoryHistory({ initialEntries: [location] }) })
  await router.load()
  render(<AccountProvider account={account} apiKey={apiKey}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></AccountProvider>)
  return router
}

test('opens and pages a timeline through the SDK, retaining its server window and server counts', async () => {
  const reads = trafficResponses(url => {
    if (url.pathname.endsWith('/request-one')) return json(url.searchParams.get('offset') === '50'
      ? { ...detail, offset: 50, events: [{ ...detail.events[0], id: 'request-last', path: '/booking', method: 'POST', status: 409, latencyMs: 42 }] }
      : detail)
    return json(journeys)
  })
  await mount()
  const table = await screen.findByRole('table', { name: 'Agent request sequences' })
  expect(screen.getByText('27 request sequences · 146 recorded requests')).not.toBeNull()
  expect(within(table).getByText('55')).not.toBeNull()
  expect(within(table).getByText('2 HTTP errors')).not.toBeNull()
  expect(within(table).getByText('Verified operator')).not.toBeNull()
  expect(within(table).getByText('Inferred sequence')).not.toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next journeys' }).disabled).toBe(false)
  expect(screen.getByRole('button', { name: 'Some requests missing. A source reached its daily recording limit. See capture coverage for affected days and sources.' })).not.toBeNull()
  const opener = within(table).getByRole('button', { name: /ChatGPT-User journey/ })
  expect(opener.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(opener)
  const timeline = await screen.findByRole('list', { name: 'ChatGPT-User recorded requests' })
  expect(opener.getAttribute('aria-expanded')).toBe('true')
  const steps = within(timeline).getAllByRole('listitem')
  expect(steps.map(step => step.textContent)).toEqual([expect.stringContaining('example.com/rooms'), expect.stringContaining('example.com/api/availability')])
  expect(within(steps[0]!).getByText('GET')).not.toBeNull()
  expect(within(steps[0]!).getByText('HTTP 200')).not.toBeNull()
  const requestDetails = within(steps[0]!).getByText('Request details')
  expect(requestDetails.closest('details')!.open).toBe(false)
  fireEvent.click(requestDetails)
  expect(within(steps[0]!).getByText('Not recorded')).not.toBeNull()
  expect(screen.getByText(/55 recorded requests/)).not.toBeNull()
  const first = reads.find(url => url.pathname.endsWith('/request-one'))!
  expect(Object.fromEntries(first.searchParams)).toEqual({ since: context.windowStart, until: context.windowEnd, limit: '50', offset: '0' })
  fireEvent.click(screen.getByRole('button', { name: 'Next requests' }))
  await screen.findByText('HTTP 409')
  const next = screen.getByRole('list', { name: 'ChatGPT-User recorded requests' })
  expect(within(next).getByText('POST')).not.toBeNull()
  const nextDetails = within(next).getByText('Request details')
  expect(nextDetails.closest('details')!.open).toBe(false)
  fireEvent.click(nextDetails)
  expect(within(next).getByText('42 ms')).not.toBeNull()
  const last = reads.filter(url => url.pathname.endsWith('/request-one')).at(-1)!
  expect(Object.fromEntries(last.searchParams)).toEqual({ since: context.windowStart, until: context.windowEnd, limit: '50', offset: '50' })
})

test('Advanced Property, source and verification filters reach list and detail without treating market as known', async () => {
  const properties = [{ key: 'hotel', label: 'Hotel' }, { key: 'cafe', label: 'Cafe' }]
  const reads = trafficResponses(url => {
    const scope: AgentJourneyContext['scope'] = { ...context.scope, mode: 'advanced', planRevision: 8, attribution: 'current-plan-url', targetKey: url.searchParams.get('targetKey'), sourceId: url.searchParams.get('sourceId'), verificationStatus: 'verified' }
    return json(url.pathname.endsWith('/request-one')
      ? { ...detail, scope, properties, events: [{ ...detail.events[0], targetKey: 'cafe', attribution: 'matched' }] }
      : { ...journeys, scope, properties })
  })
  await mount()
  await screen.findByRole('table', { name: 'Agent request sequences' })
  const filters = screen.getByText('Filter agents')
  expect(filters.closest('details')!.open).toBe(false)
  fireEvent.click(filters)
  fireEvent.click(screen.getByText('Property: All properties'))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a property' }), { target: { value: 'cafe' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cafe' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'edge' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Identity' }), { target: { value: 'verified' } })
  await waitFor(() => expect(reads.some(url => url.searchParams.get('targetKey') === 'cafe' && url.searchParams.get('sourceId') === 'edge' && url.searchParams.get('verificationStatus') === 'verified')).toBe(true))
  fireEvent.click(await screen.findByRole('button', { name: /ChatGPT-User journey/ }))
  const timeline = await screen.findByRole('list', { name: 'ChatGPT-User recorded requests' })
  fireEvent.click(within(timeline).getByText('Request details'))
  expect(within(timeline).getByText('Cafe')).not.toBeNull()
  const request = reads.find(url => url.pathname.endsWith('/request-one'))!
  expect(Object.fromEntries(request.searchParams)).toMatchObject({ sourceId: 'edge', verificationStatus: 'verified', targetKey: 'cafe', since: context.windowStart, until: context.windowEnd })
  expect(request.searchParams.has('marketKey')).toBe(false)
  fireEvent.click(screen.getByText('Capture coverage'))
  expect(screen.getByText('Property attribution uses URL matches in current plan revision 8.')).not.toBeNull()
  expect(screen.getByText(/do not establish the user’s task, market/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Only ChatGPT-User' }))
  await waitFor(() => expect(reads.at(-1)?.searchParams.get('agentId')).toBe('chatgpt-user'))
  expect(reads.at(-1)?.searchParams.get('offset')).toBe('0')
})

test('visitor list filters and pagination preserve the unfiltered cohort headline and API totals', async () => {
  const reads = trafficResponses(url => {
    if (url.pathname.endsWith('/journeys/summary')) return json(visitorSummary)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return json({ ...visitors, offset, totalVisitors: url.searchParams.get('returned') === 'true' ? 7 : 27, visitors: [{ ...visitors.visitors[0], device: offset ? 'Android · Chrome' : visitor.device }] })
  })
  await mount(null, undefined, '/journeys?project=example')
  const table = await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(await screen.findByText('33.3%')).not.toBeNull()
  const breakdown = screen.getByText('Referral and return breakdown')
  expect(breakdown.closest('details')!.open).toBe(false)
  fireEvent.click(breakdown)
  expect(screen.getByText('2.5 days')).not.toBeNull()
  expect(screen.getByText('41')).not.toBeNull()
  expect(within(table).getByText('23')).not.toBeNull()
  expect(screen.queryByRole('table', { name: 'Agent request sequences' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next visitors' }))
  await screen.findByRole('button', { name: /Android · Chrome visitor journey/ })
  const page = reads.filter(url => url.pathname.endsWith('/journeys')).at(-1)!
  expect(Object.fromEntries(page.searchParams)).toMatchObject({ limit: '20', offset: '20' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next visitors' }).disabled).toBe(true)
  const filters = screen.getByText('Filter visitors')
  expect(filters.closest('details')!.open).toBe(false)
  fireEvent.click(filters)
  fireEvent.change(screen.getByRole('combobox', { name: 'First AI engine' }), { target: { value: 'ChatGPT' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Return visits' }), { target: { value: 'true' } })
  await waitFor(() => expect(reads.some(url => url.pathname.endsWith('/journeys') && url.searchParams.get('engine') === 'ChatGPT' && url.searchParams.get('returned') === 'true')).toBe(true))
  await screen.findByText('7 visitors in this selection')
  expect(screen.queryByRole('button', { name: 'Next visitors' })).toBeNull()
  expect(screen.getByText('33.3%')).not.toBeNull()
  expect(screen.getByText('27')).not.toBeNull()
  expect(screen.getByText(/summary.*all engines/i)).not.toBeNull()
  for (const summaryRead of reads.filter(url => url.pathname.endsWith('/summary'))) {
    expect([...summaryRead.searchParams.keys()].sort()).toEqual(['since', 'until'])
  }
  expect(Object.fromEntries(reads.filter(url => url.pathname.endsWith('/journeys')).at(-1)!.searchParams)).toMatchObject({ engine: 'ChatGPT', returned: 'true', offset: '0' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: '7' } })
  await waitFor(() => {
    const lastSummary = reads.filter(url => url.pathname.endsWith('/summary')).at(-1)!
    expect(Date.parse(lastSummary.searchParams.get('until')!) - Date.parse(lastSummary.searchParams.get('since')!)).toBe(7 * 86_400_000)
  })
  expect(reads.filter(url => url.pathname.endsWith('/journeys')).at(-1)?.searchParams.get('offset')).toBe('0')
})

test('visitor detail pages retained visits beyond the cohort period and discloses incomplete identity and capture', async () => {
  const reads = trafficResponses(url => {
    if (url.pathname.endsWith('/journeys/summary')) return json(visitorSummary)
    if (url.pathname.endsWith('/visitor-one')) return json(url.searchParams.get('offset') === '10'
      ? { ...visitorDetail, offset: 10, visits: [{ ...visit, id: 'late-return', startedAt: visitor.lastSeenAt, endedAt: visitor.lastSeenAt, entryClass: 'direct', entryName: null, entryHost: null, landingPath: '/return-after-cohort', events: [{ ts: visitor.lastSeenAt, method: 'POST', path: '/return-after-cohort', status: null, kind: 'data', aiTouch: false }] }] }
      : visitorDetail)
    return json(visitors)
  })
  await mount(null, undefined, '/journeys?project=example&tab=visitors')
  const opener = await screen.findByRole('button', { name: /Mac · Safari visitor journey/ })
  expect(opener.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(opener)
  const timeline = await screen.findByRole('region', { name: 'Mac · Safari visitor timeline' })
  expect(opener.getAttribute('aria-expanded')).toBe('true')
  const visitSummary = await within(timeline).findByText('/rooms')
  expect(visitSummary.closest('details')!.open).toBe(false)
  expect(within(timeline).queryByRole('list', { name: 'ChatGPT visit requests' })).toBeNull()
  fireEvent.click(visitSummary)
  const requests = await within(timeline).findByRole('list', { name: 'ChatGPT visit requests' })
  const steps = within(requests).getAllByRole('listitem')
  expect(steps.map(step => step.textContent)).toEqual([expect.stringContaining('/rooms'), expect.stringContaining('/api/availability')])
  expect(within(steps[0]!).getByText('HTTP 200')).not.toBeNull()
  const requestDetails = within(steps[0]!).getByText('Request details')
  expect(requestDetails.closest('details')!.open).toBe(false)
  fireEvent.click(requestDetails)
  expect(within(steps[0]!).getByText('Page')).not.toBeNull()
  expect(within(steps[0]!).getByText('AI referral')).not.toBeNull()
  expect(within(timeline).getByRole('button', { name: 'All retained visits for this visitor, including outside the selected period. Engine and return filters do not narrow this history. These are recorded requests; HTTP responses do not establish a conversion.' })).not.toBeNull()
  const first = reads.find(url => url.pathname.endsWith('/visitor-one'))!
  expect(Object.fromEntries(first.searchParams)).toEqual({ limit: '10', offset: '0' })
  fireEvent.click(within(timeline).getByRole('button', { name: 'Next visits' }))
  const lateSummary = await within(timeline).findByText('/return-after-cohort')
  expect(lateSummary.closest('details')!.open).toBe(false)
  fireEvent.click(lateSummary)
  const late = await screen.findByRole('list', { name: 'Direct visit requests' })
  expect(within(late).getByText('/return-after-cohort')).not.toBeNull()
  expect(within(late).getByText('POST')).not.toBeNull()
  expect(within(late).getByText('HTTP not recorded')).not.toBeNull()
  fireEvent.click(within(late).getByText('Request details'))
  expect(within(late).getByText('Data / API')).not.toBeNull()
  expect(Object.fromEntries(reads.filter(url => url.pathname.endsWith('/visitor-one')).at(-1)!.searchParams)).toEqual({ limit: '10', offset: '10' })
  fireEvent.click(screen.getByText('Visitor capture coverage'))
  expect(screen.getByText(visitorSummary.partialSources[0]!.reason)).not.toBeNull()
  expect(screen.getByText('Browser-only match')).not.toBeNull()
  expect(within(timeline).getByRole('button', { name: 'Browser-only matching can combine everyone using the same browser version. This timeline may represent several people.' })).not.toBeNull()
  expect(within(timeline).getByText('Some steps are missing: request limit reached on 2 days.')).not.toBeNull()
  expect(screen.getByText('Requests are eligible for 30 days after an AI referral and retained for 180 days. A new visit starts after 30 minutes of inactivity.')).not.toBeNull()
  expect(screen.getByText(/Project-wide for Simple and Advanced projects/)).not.toBeNull()
  fireEvent.click(screen.getByText('Referral and return breakdown'))
  expect(screen.getByText(/Matching basis: 24 network \+ browser; 3 browser only/)).not.toBeNull()
  const engines = screen.getByRole('table', { name: 'Visitors by first AI engine' })
  expect(within(engines).getByRole('row', { name: 'ChatGPT 20 7' })).not.toBeNull()
})

test.each([
  ['visitors', 'viewer'], ['agents', 'viewer'], ['visitors', 'embed'], ['agents', 'embed'],
])('%s journeys make no private requests in %s mode', async (tab, mode) => {
  if (mode === 'embed') window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  const reads = trafficResponses(() => json(journeys))
  await mount(mode === 'viewer' ? { name: 'Viewer', role: 'viewer' } : null, undefined, `/journeys?project=example&tab=${tab}`)
  await screen.findByText('Journey details are unavailable for viewer accounts and embedded reports.')
  expect(screen.queryByRole('navigation', { name: 'Journey views' })).toBeNull()
  expect(reads).toEqual([])
})

test.each(['visitors', 'agents'])('project-scoped read keys can inspect the %s tab', async tab => {
  const reads = trafficResponses(url => json(url.pathname.endsWith('/journeys/summary') ? visitorSummary : tab === 'agents' ? journeys : visitors))
  await mount(null, { id: 'read-key', scopes: ['read'], projectId: 'example-id', readOnly: true }, `/journeys?project=example&tab=${tab}`)
  await screen.findByRole('table', { name: tab === 'agents' ? 'Agent request sequences' : 'AI-referred visitors' })
  expect(reads.some(url => url.pathname.endsWith(tab === 'agents' ? '/traffic/agent-journeys' : '/journeys'))).toBe(true)
})

test('URL tab and project changes mount only the active evidence and reset the prior project selection', async () => {
  const reads = trafficResponses(url => {
    if (url.pathname.endsWith('/journeys/summary')) return json(visitorSummary)
    if (url.pathname.endsWith('/visitor-one')) return json(visitorDetail)
    if (url.pathname.endsWith('/request-one')) return json(detail)
    return json(url.pathname.endsWith('/traffic/agent-journeys') ? journeys : visitors)
  })
  const router = await mount(null, undefined, '/journeys')
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  await waitFor(() => expect(router.state.location.search).toMatchObject({ project: 'example', tab: 'visitors' }))
  expect(screen.getByRole('link', { name: 'Visitor journeys' }).getAttribute('aria-current')).toBe('page')
  expect(reads.some(url => url.pathname.includes('/traffic/agent-journeys'))).toBe(false)
  fireEvent.click(screen.getByText('Filter visitors'))
  fireEvent.change(screen.getByRole('combobox', { name: 'Return visits' }), { target: { value: 'true' } })
  fireEvent.click(await screen.findByRole('button', { name: /Mac · Safari visitor journey/ }))
  const visitorTimeline = await screen.findByRole('region', { name: 'Mac · Safari visitor timeline' })
  fireEvent.click(await within(visitorTimeline).findByText('/rooms'))
  await screen.findByRole('list', { name: 'ChatGPT visit requests' })
  fireEvent.click(screen.getByRole('link', { name: 'Agent journeys' }))
  await screen.findByRole('table', { name: 'Agent request sequences' })
  expect(router.state.location.search).toMatchObject({ project: 'example', tab: 'agents' })
  expect(screen.queryByRole('table', { name: 'AI-referred visitors' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /ChatGPT-User journey/ }))
  await screen.findByRole('list', { name: 'ChatGPT-User recorded requests' })
  fireEvent.click(screen.getByRole('button', { name: 'Only ChatGPT-User' }))
  await waitFor(() => expect(reads.at(-1)?.searchParams.get('agentId')).toBe('chatgpt-user'))
  fireEvent.click(await screen.findByRole('button', { name: /ChatGPT-User journey/ }))
  await screen.findByRole('list', { name: 'ChatGPT-User recorded requests' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'other' } })
  await waitFor(() => expect(reads.some(url => url.pathname === '/api/v1/projects/other/traffic/agent-journeys')).toBe(true))
  expect(router.state.location.search).toMatchObject({ project: 'other', tab: 'agents' })
  const other = reads.find(url => url.pathname === '/api/v1/projects/other/traffic/agent-journeys')!
  expect(other.searchParams.get('agentId')).toBeNull()
  expect(other.searchParams.get('offset')).toBe('0')
  expect(screen.queryByRole('button', { name: 'Clear agent: ChatGPT-User' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'ChatGPT-User request timeline' })).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: 'Visitor journeys' }))
  await screen.findByRole('table', { name: 'AI-referred visitors' })
  expect(router.state.location.search).toMatchObject({ project: 'other', tab: 'visitors' })
  fireEvent.click(screen.getByText('Filter visitors'))
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Return visits' }).value).toBe('')
  expect(screen.queryByRole('region', { name: 'Mac · Safari visitor timeline' })).toBeNull()
  expect(reads.some(url => url.pathname === '/api/v1/projects/other/journeys' && !url.searchParams.has('returned'))).toBe(true)
})

test('visitor summary, list and detail failures recover independently without becoming empty evidence', async () => {
  const failures = new Set(['summary', 'list', 'detail'])
  trafficResponses(url => {
    const kind = url.pathname.endsWith('/summary') ? 'summary' : url.pathname.endsWith('/visitor-one') ? 'detail' : 'list'
    if (failures.has(kind)) return json({ error: { code: 'VALIDATION_ERROR', message: `Stored ${kind} unavailable.` } }, 400)
    return json(kind === 'summary' ? visitorSummary : kind === 'detail' ? visitorDetail : visitors)
  })
  await mount(null, undefined, '/journeys?project=example&tab=visitors')
  await screen.findByRole('button', { name: 'Retry summary' })
  await screen.findByRole('button', { name: 'Retry visitors' })
  expect(screen.queryByText('No retained visitor journeys in this selection.')).toBeNull()
  failures.delete('summary')
  fireEvent.click(screen.getByRole('button', { name: 'Retry summary' }))
  await screen.findByText('33.3%')
  expect(screen.getByRole('button', { name: 'Retry visitors' })).not.toBeNull()
  failures.delete('list')
  fireEvent.click(screen.getByRole('button', { name: 'Retry visitors' }))
  fireEvent.click(await screen.findByRole('button', { name: /Mac · Safari visitor journey/ }))
  await screen.findByRole('button', { name: 'Retry visitor timeline' })
  failures.delete('detail')
  fireEvent.click(screen.getByRole('button', { name: 'Retry visitor timeline' }))
  const timeline = screen.getByRole('region', { name: 'Mac · Safari visitor timeline' })
  fireEvent.click(await within(timeline).findByText('/rooms'))
  await screen.findByRole('list', { name: 'ChatGPT visit requests' })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('empty visitor cohorts keep unavailable rates distinct from zero and preserve source gaps', async () => {
  trafficResponses(url => json(url.pathname.endsWith('/summary')
    ? { ...visitorSummary, aiVisitors: 0, aiVisits: 4, returningVisitors: 0, returnRate: null, medianDaysToReturn: null, byEngine: [], keyBasis: { ipUa: 0, ua: 0 }, returnedVia: { ai: 0, search: 0, direct: 0, social: 0, paid: 0, referral: 0 } }
    : { ...visitors, totalVisitors: 0, visitors: [] }))
  await mount(null, undefined, '/journeys?project=example&tab=visitors')
  await screen.findByText('No retained visitor journeys in this selection.')
  const breakdown = screen.getByText('Referral and return breakdown')
  expect(breakdown.closest('details')!.open).toBe(false)
  fireEvent.click(breakdown)
  expect(screen.getAllByText('Not available')).toHaveLength(2)
  expect(screen.queryByText('0%')).toBeNull()
  expect(screen.getByText('4')).not.toBeNull()
  expect(screen.getByText('Started in period, including earlier visitors')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Next visitors' })).toBeNull()
  fireEvent.click(screen.getByText('Visitor capture coverage'))
  expect(screen.getByText(visitorSummary.partialSources[0]!.reason)).not.toBeNull()
  expect(screen.getByText(/Try a different period or filter/)).not.toBeNull()
})

test('the traffic source page does not mount a duplicate journey analysis or make private journey reads', async () => {
  const reads = trafficResponses(() => json(journeys))
  await mount(null, undefined, '/traffic')
  await screen.findByText('No traffic sources connected for example.')
  expect(screen.queryByRole('table', { name: 'Agent request sequences' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Agent journeys' })).toBeNull()
  expect(reads).toEqual([])
})

test('a failed read has retry, and disabled capture does not claim an absence of agent activity', async () => {
  let failed = true
  trafficResponses(() => failed ? json({ error: { code: 'VALIDATION_ERROR', message: 'Narrow the requested period.' } }, 400)
    : json({ ...journeys, journeys: [], totalJourneys: 0, observedRequests: 0, coverage: { ...context.coverage, recordingEnabled: false, cappedSourceDays: [] } }))
  await mount()
  await screen.findByRole('alert')
  expect(screen.queryByText('No recorded agent journeys in this selection.')).toBeNull()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry journeys' }))
  await screen.findByText('No recorded agent journeys in this selection.')
  expect(screen.getByRole('button', { name: 'Recording disabled. Agent request recording is not enabled on this instance. Saved journeys remain available.' })).not.toBeNull()
  expect(screen.getByText(/Try a different period or filter/)).not.toBeNull()
})
