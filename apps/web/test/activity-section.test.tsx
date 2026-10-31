import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

afterEach(cleanup)

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  // The chart's rows, captured so `Line` can run the real dot renderer against
  // them. React renders a parent before its children, so this is populated by
  // the time any `Line` below is called.
  let chartRows: Record<string, unknown>[] = []
  const ComposedChart = ({ children, data }: { children?: React.ReactNode; data?: Record<string, unknown>[] }) => {
    chartRows = data ?? []
    return <div>{children}</div>
  }
  return {
    ResponsiveContainer: passthrough,
    ComposedChart,
    Area: () => null,
    // A `dot` RENDERER is invoked once per row and its output mounted, so a test
    // can prove an isolated reading is actually drawn. Recharts does this into
    // SVG that jsdom cannot meaningfully assert on; object/false dots stay inert.
    Line: ({ dataKey, dot }: { dataKey?: string; dot?: unknown }) =>
      typeof dot === 'function'
        ? (
          <div data-testid={`dots-${dataKey}`}>
            {chartRows.map((_, i) =>
              (dot as (p: Record<string, unknown>) => React.ReactNode)({ cx: i, cy: 1, index: i, key: `dot-${i}` }))}
          </div>
        )
        : null,
    CartesianGrid: () => null,
    Bar: () => null,
    BarChart: passthrough,
    Cell: () => null,
    ReferenceArea: () => null,
    ReferenceLine: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    // Rendered as a marker so a test can prove the legend exists at all. The
    // real Legend draws to canvas-ish SVG that jsdom cannot meaningfully assert.
    Legend: () => <div data-testid="chart-legend" />,
  }
})

import { ACTIVITY_COPY, ActivitySection, ClickThroughActivity, SEARCH_LANDING_COPY } from '../src/components/project/ActivitySection.js'
import { StackedSeriesChart } from '../src/components/project/ActivityParts.js'
import { AiTrafficHistoryPanel } from '../src/components/project/AiTrafficHistoryPanel.js'

function renderActivitySection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ActivitySection projectName="test-project" />
    </QueryClientProvider>,
  )
}

import { mockFetch, jsonResponse } from './mock-fetch.js'

const GA_STATUS = {
  connected: true,
  propertyId: '999888',
  clientEmail: 'sa@test.iam.gserviceaccount.com',
  authMethod: 'service-account',
  lastSyncedAt: '2026-03-31T12:00:00.000Z',
  createdAt: '2026-03-31T12:00:00.000Z',
  updatedAt: '2026-03-31T12:00:00.000Z',
}

const EMPTY_SEARCH_LANDING = {
  source: 'ga4-search-console-link', status: 'never-synced', error: null, syncedAt: null, attemptedAt: null,
  window: '28d', windowStart: null, windowEnd: null, windowDays: null, timeZone: null,
  subjectToThresholding: false, dataLossFromOtherRow: false, total: null, reportRowCount: null, rowsCapped: false,
  totalRows: 0, limit: 1000, offset: 0, rows: [],
}

const EMPTY_SERIES = { series: [], otherCount: 0, days: [] }

const EMPTY_AI_DAILY_RESPONSE = { days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0, byEngine: EMPTY_SERIES }

const OVERVIEW_KEYS = ['activeUsers', 'newUsers', 'totalUsers', 'sessions', 'organicSessions', 'views', 'eventCount', 'keyEvents', 'engagementRate', 'bounceRate', 'averageEngagementTimeSeconds'] as const

function overviewValues(values: Partial<Record<typeof OVERVIEW_KEYS[number], number | null>> = {}) {
  return { ...Object.fromEntries(OVERVIEW_KEYS.map(key => [key, null])), ...values }
}

/**
 * A `/ga/overview` response as the API sends it. Totals, every change and the
 * days are the server's; the card only lays them out.
 */
function gaOverviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    window: '30d',
    current: { startDate: '2026-03-01', endDate: '2026-03-30' },
    previous: { startDate: '2026-01-30', endDate: '2026-02-28' },
    totals: overviewValues({ sessions: 4528, activeUsers: 2500, organicSessions: 2758, engagementRate: 0.6076, keyEvents: 146, bounceRate: 0.3924, views: 9913 }),
    previousTotals: overviewValues({ sessions: 4256, activeUsers: 2356, organicSessions: 2578, engagementRate: 0.6106, bounceRate: 0.3994, views: 9439 }),
    changePct: overviewValues({ sessions: 6.390977, activeUsers: 6.112054, organicSessions: 6.982157, engagementRate: -0.476486, bounceRate: -1.752629, views: 5.021718 }),
    days: [
      { date: '2026-03-29', previousDate: '2026-02-27', values: overviewValues({ sessions: 150, activeUsers: 90 }), previousValues: overviewValues({ sessions: 140, activeUsers: 85 }) },
      { date: '2026-03-30', previousDate: '2026-02-28', values: overviewValues({ sessions: 160, activeUsers: 95 }), previousValues: overviewValues({ sessions: 130, activeUsers: 80 }) },
    ],
    syncedAt: '2026-03-31T04:00:00.000Z',
    ...overrides,
  }
}

/** A collapsed Activity row, found by the label in its summary. */
function disclosure(container: HTMLElement, label: string): HTMLDetailsElement {
  return within(container).getByText(label, { selector: 'summary > span' }).closest('details') as HTMLDetailsElement
}

async function openDisclosure(row: HTMLDetailsElement) {
  fireEvent.click(row.querySelector('summary') as HTMLElement)
  await waitFor(() => expect(row.open).toBe(true))
}

/**
 * A `/ga/traffic` response as the API sends it, groups and shares included.
 * The UI renders these values; it never rebuilds them from the rows.
 */
function gaTrafficResponse(overrides: Record<string, unknown> = {}) {
  const bucket = (sessions: number, display: string) => ({ sessions, sharePct: Number.parseFloat(display), sharePctDisplay: display })
  return {
    totalSessions: 120,
    totalOrganicSessions: 70,
    totalDirectSessions: 30,
    totalUsers: 95,
    topPages: [],
    aiReferrals: [],
    aiEngines: [],
    aiReferralLandingPages: [],
    aiSessionsDeduped: 0,
    paidAiSessionsDeduped: 0,
    organicAiSessionsDeduped: 0,
    aiSessionsBySession: 0,
    paidAiSessionsBySession: 0,
    organicAiSessionsBySession: 0,
    socialReferrals: [],
    socialPlatforms: [],
    socialPlatformDaily: EMPTY_SERIES,
    socialSessions: 0,
    paidSocialSessions: 0,
    paidSocialShare: 0,
    channelBreakdown: {
      organic: bucket(70, '58%'),
      social: bucket(0, '0%'),
      direct: bucket(30, '25%'),
      ai: bucket(0, '0%'),
      other: bucket(20, '17%'),
    },
    organicSharePct: 58,
    aiSharePct: 0,
    aiSharePctBySession: 0,
    paidAiSharePct: 0,
    paidAiSharePctBySession: 0,
    organicAiSharePct: 0,
    organicAiSharePctBySession: 0,
    directSharePct: 25,
    socialSharePct: 0,
    organicSharePctDisplay: '58%',
    aiSharePctDisplay: '0%',
    aiSharePctBySessionDisplay: '0%',
    paidAiSharePctDisplay: '0%',
    paidAiSharePctBySessionDisplay: '0%',
    organicAiSharePctDisplay: '0%',
    organicAiSharePctBySessionDisplay: '0%',
    directSharePctDisplay: '25%',
    socialSharePctDisplay: '0%',
    otherSessions: 20,
    otherSharePct: 17,
    otherSharePctDisplay: '17%',
    lastSyncedAt: '2026-03-31T12:00:00.000Z',
    windowStart: '2026-03-02',
    windowEnd: '2026-03-31',
    windowDays: 30,
    periodStart: '2026-03-02',
    periodEnd: '2026-03-31',
    ...overrides,
  }
}

/** Serve one GA4-connected project; `routes` answers the GA reads a test cares about. */
function mockConnectedGa(routes: Record<string, () => Response>) {
  return mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    for (const [suffix, respond] of Object.entries(routes)) {
      if (urlPath.endsWith(suffix)) return respond()
    }
    if (urlPath.endsWith('/projects/test-project/ga/status')) return jsonResponse(GA_STATUS)
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) return jsonResponse(gaTrafficResponse())
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) return jsonResponse(EMPTY_AI_DAILY_RESPONSE)
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/overview')) return jsonResponse(gaOverviewResponse())
    if (urlPath.endsWith('/projects/test-project/ga/search-landing-pages')) return jsonResponse(EMPTY_SEARCH_LANDING)
    if (urlPath.endsWith('/projects/test-project/traffic/sources')) return jsonResponse({ sources: [] })
    if (urlPath.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 1, crawlerContentHits: 1, aiUserFetchHits: 1, aiReferralHits: 1, aiReferralLandedHits: 1 },
        series: {
          granularity: 'day',
          coverageStart: '2026-03-31T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-03-31', measured: true, crawlerHits: 1, crawlerContentHits: 1, aiUserFetchHits: 1, aiReferralHits: 1, aiReferralLandedHits: 1 }],
        },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

function sectionByHeading(name: string | RegExp): HTMLElement {
  return screen.getByRole('heading', { name }).closest('section') as HTMLElement
}

function shareCell(row: HTMLElement): string {
  const cells = within(row).getAllByRole('cell')
  return cells[cells.length - 1]!.textContent ?? ''
}

const CHATGPT_ROWS = [
  { source: 'chatgpt.com', medium: 'ai-assistant', trafficClass: 'organic', sourceDimension: 'session', sessions: 12, share: 0.3 },
  { source: 'chatgpt', medium: 'cpc', trafficClass: 'paid', sourceDimension: 'session', sessions: 4, share: 0.1 },
]
const UNATTRIBUTED_ROW = { source: 'assistant.example', medium: 'ai-assistant', trafficClass: 'organic', sourceDimension: 'session', sessions: 24, share: 0.6 }

const AI_TRAFFIC = {
  aiReferrals: [...CHATGPT_ROWS, UNATTRIBUTED_ROW],
  aiEngines: [
    { engine: 'chatgpt', label: 'ChatGPT', sessions: 16, organicSessions: 12, paidSessions: 4, share: 0.4, sources: CHATGPT_ROWS },
    { engine: null, label: 'Unattributed AI', sessions: 24, organicSessions: 24, paidSessions: 0, share: 0.6, sources: [UNATTRIBUTED_ROW] },
  ],
  aiReferralLandingPages: [
    { source: 'chatgpt.com', medium: 'ai-assistant', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/pricing', sessions: 12 },
  ],
  aiSessionsBySession: 40,
  paidAiSessionsBySession: 4,
  channelBreakdown: {
    organic: { sessions: 70, sharePct: 58, sharePctDisplay: '58%' },
    social: { sessions: 8, sharePct: 7, sharePctDisplay: '7%' },
    direct: { sessions: 30, sharePct: 25, sharePctDisplay: '25%' },
    ai: { sessions: 40, sharePct: 10, sharePctDisplay: '10%' },
    other: { sessions: 0, sharePct: 0, sharePctDisplay: '0%' },
  },
  // The cross-cutting share overlaps other channels; the channel row must not show it.
  aiSharePctDisplay: '35%',
}

test('puts the GA4 overview first, then AI traffic history, and loads GA4 without changing hook order', async () => {
  onTestFinished(mockConnectedGa({
    '/ga/traffic': () => jsonResponse(gaTrafficResponse({
      ...AI_TRAFFIC,
      topPages: [{ landingPage: '/pricing', sessions: 80, organicSessions: 50, directSessions: 20, users: 60, organicShare: 0.625 }],
    })),
    '/ga/ai-referral-daily': () => jsonResponse({
      ...EMPTY_AI_DAILY_RESPONSE,
      days: [{ date: '2026-03-31', sessions: 16, paidSessions: 4, organicSessions: 12, bySource: [] }],
      totalSessions: 16,
      byEngine: {
        series: [{ key: 'chatgpt', label: 'ChatGPT', sessions: 16 }],
        otherCount: 0,
        days: [{ date: '2026-03-31', sessions: 16, values: { chatgpt: 16 } }],
      },
    }),
  }))
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => consoleErrorSpy.mockRestore())

  renderActivitySection()

  await screen.findByText(ACTIVITY_COPY.aiChartLabel, { selector: 'summary > span' })
  // One period control, on the first traffic section's heading, above every panel it drives.
  const trafficPeriod = within(sectionByHeading('Site traffic')).getByRole('group', { name: 'Traffic time period' })
  expect(within(trafficPeriod).getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true')

  // The GA4 overview leads the traffic sections, as it did before 2026-10-21;
  // the AI history follows it, ahead of the GA4 detail sections.
  const order = ['Server activity', 'Site traffic', 'AI traffic history', 'Traffic by channel', 'Social', 'Top landing pages', SEARCH_LANDING_COPY.heading]
    .map(name => screen.getByRole('heading', { name, level: 2 }))
  for (let i = 1; i < order.length; i++) {
    expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  }
  const historySection = sectionByHeading('AI traffic history')
  expect(await within(historySection).findByRole('heading', { name: 'Machines reading your site' })).toBeTruthy()

  // The approved layout drops the sentence callouts; their figures live in the tables.
  expect(screen.queryByText(/Top AI referrer/)).toBeNull()
  expect(screen.queryByText(/Top social source/)).toBeNull()
  expect(await screen.findByText(SEARCH_LANDING_COPY.neverSynced)).toBeTruthy()

  expect(
    consoleErrorSpy.mock.calls.flat().some((arg) =>
      String(arg).includes('change in the order of Hooks')
      || String(arg).includes('Rendered more hooks than during the previous render'),
    ),
  ).toBe(false)
})

test('renders the five disjoint channel figures the API sent, AI share from the channel breakdown', async () => {
  onTestFinished(mockConnectedGa({ '/ga/traffic': () => jsonResponse(gaTrafficResponse(AI_TRAFFIC)) }))

  renderActivitySection()

  const channels = within(await screen.findByLabelText('Sessions by channel'))
  for (const label of ['Organic search', 'Social', 'Direct', 'AI (at least)', 'Other channels']) {
    expect(channels.getByText(label)).toBeTruthy()
  }
  expect(channels.getByText('25%')).toBeTruthy()
  expect(channels.getByText('10%')).toBeTruthy()
  expect(channels.getByText('40 sessions · 4 paid')).toBeTruthy()
  // The cross-cutting share overlaps Organic, Social and Direct; it never fills the AI figure.
  expect(channels.queryByText('35%')).toBeNull()
  // The AI figure's tooltip names GA4's AI Assistant channel as a source of its sessions.
  expect(channels.getByRole('button', { name: /AI Assistant channel/ })).toBeTruthy()
})

test('groups AI sources by engine, keeps unattributed AI last, and shows each share the API sent', async () => {
  onTestFinished(mockConnectedGa({
    '/ga/traffic': () => jsonResponse(gaTrafficResponse({
      ...AI_TRAFFIC,
      topPages: [{ landingPage: '/pricing', sessions: 80, organicSessions: 20, directSessions: 20, users: 60, organicShare: 0.25 }],
    })),
  }))

  renderActivitySection()

  const section = (await screen.findByRole('heading', { name: 'Traffic by channel' })).closest('section') as HTMLElement
  const row = disclosure(section, 'Where AI visitors came from')
  // Closed by default; the row itself carries the API's counts.
  expect(row.open).toBe(false)
  expect(within(row).getByText('1 engine · 3 sources')).toBeTruthy()
  expect(within(row).queryByRole('table')).toBeNull()
  await openDisclosure(row)
  const table = await within(row).findByRole('table', { name: 'AI referral sessions by engine' })
  const groupButtons = await within(table).findAllByRole('button', { expanded: false })
  expect(groupButtons.map(button => button.textContent)).toEqual(['ChatGPT2 sources', 'Unattributed AI1 source'])

  // Unattributed AI has more sessions, yet stays last: it is pinned under every sort.
  fireEvent.click(within(table).getByRole('button', { name: /Sessions/ }))
  expect(within(table).getAllByRole('button', { expanded: false }).map(button => button.textContent))
    .toEqual(['ChatGPT2 sources', 'Unattributed AI1 source'])

  const chatgpt = within(table).getByRole('button', { name: /ChatGPT/ })
  expect(shareCell(chatgpt.closest('tr') as HTMLElement)).toBe('40.0%')
  // Raw source rows stay out of the table until their group is opened.
  expect(within(table).queryByText('chatgpt.com')).toBeNull()
  fireEvent.click(chatgpt)
  expect(chatgpt.getAttribute('aria-expanded')).toBe('true')
  const sources = within(table).getByRole('table', { name: 'ChatGPT sources' })
  expect(shareCell(within(sources).getByText('chatgpt.com').closest('tr') as HTMLElement)).toBe('30.0%')
  expect(shareCell(within(sources).getByText('cpc').closest('tr') as HTMLElement)).toBe('10.0%')
  expect(within(within(sources).getByText('cpc').closest('tr') as HTMLElement).getByText('Paid')).toBeTruthy()

  const pages = sectionByHeading('Top landing pages')
  expect(shareCell(within(pages).getByText('/pricing').closest('tr') as HTMLElement)).toBe('25.0%')
})

test('social groups sources by platform from the API and opens the raw rows in place', async () => {
  const instagramRows = [
    { source: 'ig', medium: 'social', channelGroup: 'Organic Social', sessions: 47, share: 0.47 },
    { source: 'Instagram+Story', medium: 'social', channelGroup: 'Organic Social', sessions: 3, share: 0.03 },
    { source: 'ig', medium: 'paidsocial', channelGroup: 'Paid Social', sessions: 6, share: 0.06 },
  ]
  const pinterestRows = [
    { source: 'Pinterest', medium: 'PaidSocial', channelGroup: 'Paid Social', sessions: 44, share: 0.44 },
  ]
  onTestFinished(mockConnectedGa({
    '/ga/traffic': () => jsonResponse(gaTrafficResponse({
      socialReferrals: [...instagramRows, ...pinterestRows],
      socialPlatforms: [
        { platform: 'instagram', label: 'Instagram', sessions: 56, organicSessions: 50, paidSessions: 6, share: 0.56, sources: instagramRows },
        { platform: 'pinterest', label: 'Pinterest', sessions: 44, organicSessions: 0, paidSessions: 44, share: 0.44, sources: pinterestRows },
      ],
      socialPlatformDaily: {
        series: [{ key: 'instagram', label: 'Instagram', sessions: 56 }, { key: 'pinterest', label: 'Pinterest', sessions: 44 }],
        otherCount: 0,
        days: [
          { date: '2026-03-30', sessions: 40, values: { instagram: 40, pinterest: 0 } },
          { date: '2026-03-31', sessions: 60, values: { instagram: 16, pinterest: 44 } },
        ],
      },
      socialSessions: 100,
      paidSocialSessions: 50,
      paidSocialShare: 0.5,
      socialSharePctDisplay: '45.5%',
    })),
  }))

  renderActivitySection()

  const section = await waitFor(() => sectionByHeading('Social'))
  const figures = within(within(section).getByLabelText('Social sessions'))
  expect(figures.getByText('100')).toBeTruthy()
  expect(figures.getByText('45.5% of all sessions')).toBeTruthy()
  // Platforms are the API's groups, not distinct source spellings (there are four here).
  expect(within(figures.getByText('Platforms').closest('div') as HTMLElement).getByText('2')).toBeTruthy()
  expect(figures.getByText('50.0% of social')).toBeTruthy()
  expect(within(figures.getByText('Top platform').closest('div') as HTMLElement).getByText('Instagram')).toBeTruthy()

  // Each detail is a closed row whose summary carries the API's figure.
  const chartRow = disclosure(section, ACTIVITY_COPY.socialChartLabel)
  expect(within(chartRow).getByText('100 sessions')).toBeTruthy()
  await openDisclosure(chartRow)
  // The chart legend toggles each API series; there is no client-side Top-N.
  const legend = within(await within(chartRow).findByRole('group', { name: 'Social sessions by platform series' }))
  expect(legend.getAllByRole('checkbox').map(box => (box.closest('label') as HTMLElement).textContent)).toEqual(['Instagram', 'Pinterest'])

  const platformsRow = disclosure(section, 'Social platforms')
  expect(within(platformsRow).getByText('2 platforms · 4 sources')).toBeTruthy()
  await openDisclosure(platformsRow)
  const table = await within(platformsRow).findByRole('table', { name: 'Social sessions by platform' })
  const instagram = within(table).getByRole('button', { name: /Instagram/ })
  expect(instagram.textContent).toBe('Instagram3 sources')
  expect(within(table).queryByText('ig')).toBeNull()
  fireEvent.click(instagram)
  const sources = within(table).getByRole('table', { name: 'Instagram sources' })
  // A UTM-encoded source reads decoded and keeps the raw value in its title.
  const story = within(sources).getByText('Instagram Story')
  expect(story.getAttribute('title')).toBe('Instagram+Story')
  expect(within(sources).getAllByText('ig')).toHaveLength(2)
  expect(within(sources).getByText('Paid social')).toBeTruthy()
})

test('top time picker reloads every GA surface, social included, from the same window', async () => {
  const seen = new Set<string>()
  const platforms = {
    '7d': { label: 'LinkedIn', platform: 'linkedin', source: 'linkedin.com', sessions: 7 },
    '30d': { label: 'Facebook', platform: 'facebook', source: 'facebook.com', sessions: 30 },
    '90d': { label: 'X', platform: 'x', source: 'x.com', sessions: 90 },
  } as const
  const surfaces = ['traffic', 'ai-referral-daily', 'session-history', 'overview'] as const

  onTestFinished(mockFetch((url) => {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname.endsWith('/projects/test-project/ga/status')) return jsonResponse(GA_STATUS)
    if (parsed.pathname.endsWith('/projects/test-project/ga/search-landing-pages')) return jsonResponse(EMPTY_SEARCH_LANDING)
    if (parsed.pathname.endsWith('/ga/social-referral-history')) throw new Error('the Social section reads /ga/traffic only')
    const surface = surfaces.find(candidate => parsed.pathname.endsWith(`/ga/${candidate}`))
    if (!surface) throw new Error(`Unexpected fetch: ${url}`)
    const windowKey = parsed.searchParams.get('window') as keyof typeof platforms
    seen.add(`${surface}:${windowKey}`)
    if (surface === 'ai-referral-daily') return jsonResponse(EMPTY_AI_DAILY_RESPONSE)
    if (surface === 'session-history') return jsonResponse([])
    if (surface === 'overview') return jsonResponse(gaOverviewResponse({ window: windowKey }))
    const selected = platforms[windowKey]
    const row = { source: selected.source, medium: 'social', channelGroup: 'Organic Social', sessions: selected.sessions, share: 1 }
    return jsonResponse(gaTrafficResponse({
      socialReferrals: [row],
      socialPlatforms: [{ platform: selected.platform, label: selected.label, sessions: selected.sessions, organicSessions: selected.sessions, paidSessions: 0, share: 1, sources: [row] }],
      socialSessions: selected.sessions,
    }))
  }))

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const renderWindow = (windowKey: keyof typeof platforms) => (
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window={windowKey} />
    </QueryClientProvider>
  )
  // Social's figures stay in view while its tables are closed rows, so the
  // top platform figure is what proves the section reloaded for the window.
  const topPlatform = () => {
    const figures = within(sectionByHeading('Social')).getByLabelText('Social sessions')
    return (within(figures).getByText('Top platform').closest('div') as HTMLElement).querySelector('dd')?.textContent
  }
  const assertWindow = async (windowKey: keyof typeof platforms) => {
    await waitFor(() => {
      for (const surface of surfaces) expect(seen.has(`${surface}:${windowKey}`)).toBe(true)
      expect(topPlatform()).toBe(platforms[windowKey].label)
    })
  }

  const { rerender } = render(renderWindow('30d'))
  await assertWindow('30d')
  rerender(renderWindow('7d'))
  await assertWindow('7d')
  rerender(renderWindow('90d'))
  await assertWindow('90d')
})

/**
 * The panel is a SIBLING of the GA4 click-through panel, never a child. That
 * panel early-returns a connect prompt when no property is bound, so a
 * server-fed chart nested inside it would vanish for exactly the projects it
 * serves: server-side traffic needs no GA4 at all.
 *
 * Mounted standalone here, with no GA4 fetch stubbed at all, which is the
 * strongest form of that claim: the panel cannot be reading GA4 state.
 */
test('AI traffic history renders server data even when the GA4 overlay fails', async () => {
  const restoreFetch = mockFetch((url) => {
    // The GA4 overlay is decoration on a server-fed chart. If it 500s the panel
    // must still render every server number, because server-side traffic needs
    // no GA4 at all and this panel is the only place it is charted.
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) {
      return new Response('nope', { status: 500 })
    }
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, crawlerContentHits: 12, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day',
          points: [
            { bucket: '2026-08-01', crawlerHits: 20, crawlerContentHits: 8, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2 },
            { bucket: '2026-08-02', crawlerHits: 10, crawlerContentHits: 4, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2 },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch in this test: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('AI crawlers')).toBeTruthy()

  // The tiles must read the HONEST fields: content crawls (12), not the 30 that
  // counts robots and sitemaps; landed visits (4), not the 5 that counts
  // redirect hops. Scoped per tile, because the Last 24h strip repeats these
  // same figures for the newest day and an unscoped query is ambiguous.
  const tileFor = (label: string) =>
    screen.getByText(label).closest('div') as HTMLElement
  expect(within(tileFor('AI crawlers')).getByText('12')).toBeTruthy()
  expect(within(tileFor('AI page fetches')).getByText('7')).toBeTruthy()
  expect(within(tileFor('AI visitors')).getByText('4')).toBeTruthy()
  // The inflated figures must appear nowhere: not in a tile, not in the strip.
  expect(screen.queryByText('30')).toBeNull()
  expect(screen.queryByText('5')).toBeNull()

  // The source toggle exists and does not require GA4 to have loaded.
  expect(screen.getByRole('group', { name: /Visit measurement source/i })).toBeTruthy()
})

/**
 * Review finding: a failed request and a quiet window were both rendered as "no
 * activity". The API densifies the window, so a measured-but-empty range returns
 * zero-valued points, not none. These pin the three states apart.
 */
test('AI traffic history separates a failed request from a measured-empty window', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return new Response('boom', { status: 500 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // An error must never read as a measured zero.
  expect(await screen.findByText(/Could not load AI traffic history/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: /not a reading of zero activity/i })).toBeTruthy()
  expect(screen.queryByText(/No AI activity recorded/i)).toBeNull()
})

test('AI traffic history reports a measured-empty window as measured, not unconnected', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        // Densified: the window WAS measured, it just held nothing. coverageStart
        // is what makes that claim; without it the honest read is "never recorded".
        series: {
          granularity: 'day',
          coverageStart: '2026-07-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [
            { bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: true },
            { bucket: '2026-08-02', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: true },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No AI activity recorded in this period/i)).toBeTruthy()
  // Points exist, so this is NOT the "no source connected" case.
  expect(screen.queryByText(/No server-side traffic source connected/i)).toBeNull()
  expect(screen.queryByText(/Could not load/i)).toBeNull()
})

test('the traffic range picker survives a disconnected GA4', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/ga/status')) {
      return jsonResponse({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window="30d" />
    </QueryClientProvider>,
  )

  // The picker now lives in ActivitySection, so the GA panel must NOT own one.
  // Its disappearance on disconnect was the defect.
  await screen.findByText(/Connect Google Analytics 4/i)
  expect(screen.queryByRole('group', { name: /Traffic time period/i })).toBeNull()
})

/**
 * Regression: this panel took the whole Activity page down in production with
 * "Cannot read properties of undefined (reading 'toLocaleString')".
 *
 * Cause was version skew, not bad data. A deploy put this client in front of an
 * API that predates `crawlerContentHits` / `measured` on the series, and the
 * Last 24h strip dereferenced a field the schema says is required. The schema is
 * a promise about the code, not about the server that happens to be running.
 *
 * The fixture is deliberately an OLD-SHAPE payload: the four fields the API used
 * to return, and nothing else.
 */
test('AI traffic history survives an API older than the client', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day',
          // No crawlerContentHits. No measured. No trends. No coverageStart.
          points: [
            { bucket: '2026-08-01', crawlerHits: 20, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2 },
            { bucket: '2026-08-02', crawlerHits: 10, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2 },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // It must RENDER, not throw. The crawler tile degrades to 0 because the old
  // API cannot answer it; the fields that do exist still read correctly.
  expect(await screen.findByText('Latest day (UTC)')).toBeTruthy()
  const tileFor = (label: string) =>
    screen.getByText(label).closest('div') as HTMLElement
  expect(within(tileFor('AI page fetches')).getByText('7')).toBeTruthy()
  expect(within(tileFor('AI visitors')).getByText('4')).toBeTruthy()

  // A missing `measured` must not paint the whole range as unmeasured.
  expect(screen.queryByText('not measured')).toBeNull()
})

/**
 * One thing the mock specified that shipped late, pinned so it cannot quietly
 * revert: every chart carries a legend.
 * Without a legend the only thing naming a series is the hover tooltip, so a
 * glance cannot tell the lines apart.
 */
test('AI traffic charts carry a legend', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 20, crawlerContentHits: 12, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day', coverageStart: '2026-08-01',
          points: [
            { bucket: '2026-08-01', crawlerHits: 10, crawlerContentHits: 8, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2, measured: true },
            { bucket: '2026-08-02', crawlerHits: 10, crawlerContentHits: 4, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2, measured: true },
          ],
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  await screen.findByText('AI crawlers')
  // One per chart: machines, and people arriving.
  expect(screen.getAllByTestId('chart-legend').length).toBe(2)
})

/**
 * Review finding: an isolated GA4 reading rendered as NOTHING. The line runs
 * with `connectNulls={false}`, so a lone point has no neighbour to draw a
 * segment to, and dots were off entirely. GA4 days with no referrals are ABSENT
 * rather than zero, so `[null, 7, null]` is the ordinary shape of a quiet week,
 * and that day's visits simply vanished from a chart measuring visits.
 *
 * One fixture proves BOTH halves, because "draw the invisible point" could
 * otherwise be satisfied by turning every dot on, which is a different chart:
 * a RUN of three readings must contribute no dots (it draws as a line), and the
 * lone reading after the gap must contribute exactly one.
 */
test('AI traffic history draws isolated GA4 readings without speckling runs', async () => {
  const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/ga/status')) return jsonResponse({ connected: true, propertyId: 'p', clientEmail: null, lastSyncedAt: null })
    if (path.endsWith('/ga/ai-referral-daily')) {
      // A run of three, a gap, then ONE alone, then a gap.
      return jsonResponse({ days: [
        { date: '2026-08-01', sessions: 4 },
        { date: '2026-08-02', sessions: 4 },
        { date: '2026-08-03', sessions: 4 },
        { date: '2026-08-05', sessions: 9 },
      ] })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, crawlerContentHits: 30, aiUserFetchHits: 6, aiReferralHits: 6, aiReferralLandedHits: 6 },
        series: {
          granularity: 'day', coverageStart: '2026-07-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: days.map((bucket) => ({
            bucket, crawlerHits: 5, crawlerContentHits: 5, aiUserFetchHits: 1,
            aiReferralHits: 1, aiReferralLandedHits: 1, measured: true,
          })),
        },
      })
    }
    return jsonResponse({ sources: [{ id: 's1', status: 'connected' }] })
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // The GA4 overlay resolves after the server series, so wait for the settled
  // count rather than sampling the chart mid-flight.
  await waitFor(() => {
    const dots = screen.getByTestId('dots-ga4Visits')
    // Exactly one: the lone 2026-08-05. Zero is the reported bug; four would
    // mean the run got speckled too.
    expect(dots.querySelectorAll('circle').length).toBe(1)
  })
})

/**
 * Review finding: "nothing recorded" was rendered as "nothing connected".
 * `coverageStart === null` is equally true of a source connected an hour ago
 * that has not reported yet, so a CONNECTED source was told to connect one,
 * directly contradicting the connected badge above this panel.
 */
test('AI traffic history does not tell a connected source to connect a source', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/traffic/sources')) {
      return jsonResponse({ sources: [{ id: 'src-1', status: 'connected', sourceType: 'wordpress' }] })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      // Connected, but has never recorded anything: coverageStart is null.
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        series: {
          granularity: 'day', coverageStart: null,
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: false }],
        },
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No AI activity recorded yet/i)).toBeTruthy()
  // The contradiction: a connected source must never be told to connect one.
  expect(screen.queryByRole('button', { name: /Connect a traffic source/i })).toBeNull()
  expect(screen.queryByText(/No server-side traffic source connected/i)).toBeNull()
})

/**
 * The converse still has to work: with genuinely no source, say so.
 */
test('AI traffic history still reports a genuinely unconnected project', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/traffic/sources')) return jsonResponse({ sources: [] })
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        series: {
          granularity: 'day', coverageStart: null,
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: false }],
        },
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No server-side traffic source connected yet/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Connect a traffic source/i })).toBeTruthy()
})

test('a hidden chart series stays hidden when a new range reorders the series', () => {
  // The API ranks series by sessions, so the range decides which comes first.
  const ranked = (first: [string, string], second: [string, string]) => ({
    series: [{ key: first[0], label: first[1], sessions: 20 }, { key: second[0], label: second[1], sessions: 10 }],
    days: [{ date: '2026-03-31', sessions: 30, values: { [first[0]]: 20, [second[0]]: 10 } }],
  })
  const chatgpt: [string, string] = ['chatgpt', 'ChatGPT']
  const perplexity: [string, string] = ['perplexity', 'Perplexity']
  const { rerender } = render(<StackedSeriesChart input={ranked(chatgpt, perplexity)} label="AI sessions by engine" />)
  const checked = () => Object.fromEntries(
    within(screen.getByRole('group', { name: 'AI sessions by engine series' })).getAllByRole('checkbox')
      .map(box => [(box.closest('label') as HTMLElement).textContent, (box as HTMLInputElement).checked]),
  )

  fireEvent.click(screen.getByRole('checkbox', { name: 'ChatGPT' }))
  expect(checked()).toEqual({ ChatGPT: false, Perplexity: true })

  rerender(<StackedSeriesChart input={ranked(perplexity, chatgpt)} label="AI sessions by engine" />)
  expect(checked()).toEqual({ Perplexity: true, ChatGPT: false })
})

/**
 * The GA4 overview card. Every figure, change and day is the API's; the card
 * decides only which figure is charted and how a change is coloured.
 */
test('Site traffic shows GA4 figures with their change against the previous period', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({}))

  renderActivitySection()

  const tabs = within(await screen.findByRole('tablist', { name: 'Site traffic figures' }))
  expect(tabs.getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual([
    'Sessions 4.5K, up 6.4% on the previous period',
    'Users 2.5K, up 6.1% on the previous period',
    'Organic sessions 2.8K, up 7.0% on the previous period',
    'Engagement rate 60.8%, down 0.5% on the previous period',
    // The server sent no change: it reads as missing, never as 0%.
    'Key events 146, no earlier data',
  ])
  // The first figure is charted until another is picked.
  expect(tabs.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true')
  expect(within(sectionByHeading('Site traffic')).getByRole('img', { name: 'Sessions per day, last 30 days and the previous period' })).toBeTruthy()
  // A fall in engagement is bad news; a rise in sessions is good news.
  expect(within(tabs.getByRole('tab', { name: /^Sessions/ })).getByText('6.4%').className).toContain('text-positive')
  expect(within(tabs.getByRole('tab', { name: /^Engagement rate/ })).getByText('0.5%').className).toContain('text-negative')
})

test('a falling bounce rate reads as good news', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({}))

  renderActivitySection()

  const tabs = within(await screen.findByRole('tablist', { name: 'Site traffic figures' }))
  // Put Bounce rate in the fifth slot through its picker.
  fireEvent.change(screen.getByRole('combobox', { name: 'Figure 5' }), { target: { value: 'bounceRate' } })
  const bounce = await tabs.findByRole('tab', { name: 'Bounce rate 39.2%, down 1.8% on the previous period' })
  expect(within(bounce).getByText('1.8%').className).toContain('text-positive')
})

test('picking a figure charts it, and a picker swaps a figure already shown', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({}))

  const { unmount } = renderActivitySection()

  const tabs = within(await screen.findByRole('tablist', { name: 'Site traffic figures' }))
  fireEvent.click(tabs.getByRole('tab', { name: /^Users/ }))
  expect(tabs.getByRole('tab', { name: /^Users/ }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('img', { name: 'Users per day, last 30 days and the previous period' })).toBeTruthy()

  // Users is already in slot 2: choosing it for slot 1 swaps the two.
  fireEvent.change(screen.getByRole('combobox', { name: 'Figure 1' }), { target: { value: 'activeUsers' } })
  expect(tabs.getAllByRole('tab').slice(0, 2).map(tab => tab.getAttribute('aria-label')?.split(' ')[0])).toEqual(['Users', 'Sessions'])

  // The choice is this viewer's and outlasts the visit.
  unmount()
  renderActivitySection()
  const reopened = within(await screen.findByRole('tablist', { name: 'Site traffic figures' }))
  expect(reopened.getAllByRole('tab').slice(0, 2).map(tab => tab.getAttribute('aria-label')?.split(' ')[0])).toEqual(['Users', 'Sessions'])
})

test('a picker keeps keyboard focus when a figure is picked, swaps included', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({}))

  renderActivitySection()

  await screen.findByRole('tablist', { name: 'Site traffic figures' })
  const picker = screen.getByRole('combobox', { name: 'Figure 3' })
  picker.focus()
  fireEvent.change(picker, { target: { value: 'views' } })
  // The same select, still mounted and focused: not handed back to the page.
  expect(picker.isConnected).toBe(true)
  expect(document.activeElement).toBe(picker)

  // Sessions is in slot 1, so this swaps the two; focus still stays here.
  fireEvent.change(picker, { target: { value: 'sessions' } })
  expect(document.activeElement).toBe(picker)
  expect(screen.getByRole('combobox', { name: 'Figure 1' })).toHaveProperty('value', 'views')
})

test('a project synced before the overview existed is told the figures come with the next sync', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({
    '/ga/overview': () => jsonResponse(gaOverviewResponse({
      totals: overviewValues(),
      previousTotals: overviewValues(),
      changePct: overviewValues(),
      syncedAt: null,
    })),
  }))

  renderActivitySection()

  const site = await waitFor(() => sectionByHeading('Site traffic'))
  expect(await within(site).findByText('These figures fill in after the next GA4 sync.')).toBeTruthy()
  expect(within(site).getByRole('tab', { name: 'Sessions —, no earlier data' })).toBeTruthy()
})

/**
 * Regression for 2026-10-23: a site with no AI sessions lost its sessions
 * chart, because the only daily sessions chart lived inside the AI chart.
 */
test('Site traffic charts sessions per day when the site has no AI sessions at all', async () => {
  window.localStorage.clear()
  onTestFinished(() => window.localStorage.clear())
  onTestFinished(mockConnectedGa({}))

  renderActivitySection()

  const site = await waitFor(() => sectionByHeading('Site traffic'))
  expect(await within(site).findByRole('img', { name: 'Sessions per day, last 30 days and the previous period' })).toBeTruthy()
  const channels = sectionByHeading('Traffic by channel')
  for (const label of [ACTIVITY_COPY.aiChartLabel, 'Where AI visitors came from', 'Pages AI visitors landed on']) {
    const row = disclosure(channels, label)
    expect(row.open).toBe(false)
    expect(within(row).getByText(ACTIVITY_COPY.noneInPeriod)).toBeTruthy()
  }
})

test('a disconnected GA4 keeps the range picker and the AI traffic history on the tab', async () => {
  onTestFinished(mockConnectedGa({
    '/ga/status': () => jsonResponse({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null }),
  }))

  renderActivitySection()

  await screen.findByText(/Connect Google Analytics 4/i)
  expect(within(sectionByHeading('Site traffic')).getByRole('group', { name: 'Traffic time period' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'AI traffic history', level: 2 })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Traffic by channel' })).toBeNull()
})
