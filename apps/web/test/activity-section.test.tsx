import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'

afterEach(cleanup)

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  // The chart's rows, captured so `Line` can run the real dot renderer against
  // them. React renders a parent before its children, so this is populated by
  // the time any `Line` below is called.
  let chartRows: Record<string, unknown>[] = []
  // The chart's series as a hover lists them: Recharts leaves out a series
  // drawn with tooltipType="none" (the fitted trend lines).
  let chartSeries: { dataKey: string; name: string }[] = []
  // Hover sync stays observable: stacked panels must hover together.
  const ComposedChart = ({ children, data, syncId }: { children?: React.ReactNode; data?: Record<string, unknown>[]; syncId?: string }) => {
    chartRows = data ?? []
    chartSeries = React.Children.toArray(children).flatMap((child) => {
      if (!React.isValidElement(child)) return []
      const { dataKey, name, tooltipType } = child.props as { dataKey?: unknown; name?: unknown; tooltipType?: unknown }
      return typeof dataKey === 'string' && typeof name === 'string' && tooltipType !== 'none' ? [{ dataKey, name }] : []
    })
    return <div data-testid="composed-chart" data-sync={syncId}>{children}</div>
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
        // Any other line leaves a marker, so a test can tell which are drawn.
        : <div data-testid={`line-${dataKey}`} />,
    CartesianGrid: () => null,
    Bar: () => null,
    BarChart: ({ children }: { children?: React.ReactNode }) => {
      chartRows = []
      chartSeries = []
      return <div>{children}</div>
    },
    Cell: () => null,
    // Keep unlabeled bands observable, including their calendar boundaries.
    ReferenceArea: ({ label, x1, x2 }: { label?: { value?: string }; x1?: string; x2?: string }) =>
      <div data-testid="reference-area" data-from={x1} data-to={x2}>{label?.value}</div>,
    ReferenceLine: ({ x }: { x?: string }) => <span data-marker={x} />,
    XAxis: () => null,
    // How four-digit ticks read: whole in the gutter, or cut down to "000";
    // exact, or rounded off the gridline they label.
    YAxis: ({ tickFormatter }: { tickFormatter?: (value: number, index: number) => string }) =>
      <div data-testid="y-axis" data-tick-4000={tickFormatter ? tickFormatter(4000, 0) : '4,000'}
           data-tick-1050={tickFormatter ? tickFormatter(1050, 0) : '1,050'} />,
    // What a hover names on every bucket: each series' label as the chart's own
    // formatter returns it. Labels ride on attributes, so text queries never meet them.
    Tooltip: ({ formatter }: { formatter?: (value: unknown, name: string, item: { payload: Record<string, unknown> }) => unknown }) => (
      <div data-testid="chart-tooltip">
        {chartRows.flatMap((row, i) => chartSeries.map(({ dataKey, name }) => {
          const shown = formatter?.(row[dataKey], name, { payload: row })
          return (
            <span key={`${i}-${dataKey}`} data-bucket={String(row.bucket)} data-series={dataKey}
                  data-label={Array.isArray(shown) ? String(shown[1]) : name} />
          )
        }))}
      </div>
    ),
    // Rendered as a marker so a test can prove the legend exists at all. The
    // real Legend draws to canvas-ish SVG that jsdom cannot meaningfully assert.
    Legend: () => <div data-testid="chart-legend" />,
  }
})

import { ACTIVITY_COPY, ActivitySection, ClickThroughActivity, SEARCH_LANDING_COPY } from '../src/components/project/ActivitySection.js'
import { StackedSeriesChart } from '../src/components/project/ActivityParts.js'
import { AI_TRAFFIC_HISTORY_COPY, AiTrafficHistoryPanel } from '../src/components/project/AiTrafficHistoryPanel.js'

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

test('Server activity shows AI hits without likely fakes and names the excluded count only when there is one', async () => {
  const totals = (aiUserFetchHits: number, aiUserFetchLikelyFakeHits: number) => ({
    crawlerHits: 40, crawlerContentHits: 30, crawlerInfraHits: 10, crawlerSegments: { content: 30, sitemap: 5, robots: 5, asset: 0, other: 0 },
    aiUserFetchHits, aiUserFetchLikelyFakeHits, aiReferralHits: 3, aiReferralLandedHits: 2, aiReferralRedirectedHits: 1, sampleCount: 9,
  })
  const source = (id: string, displayName: string, totals24h: ReturnType<typeof totals>) => ({
    id, projectId: 'p1', sourceType: 'cloudflare', displayName, status: 'connected', lastSyncedAt: null, totals24h, latestRun: null,
  })
  onTestFinished(mockConnectedGa({
    '/traffic/status': () => jsonResponse({ sources: [source('edge', 'Website edge', totals(5, 12)), source('logs', 'Server logs', totals(8, 0))] }),
  }))
  // Source rows link to their detail page, so this render needs a router.
  const rootRoute = createRootRoute({ component: () => <ActivitySection projectName="test-project" /> })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/traffic' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/traffic/$projectName/$sourceId' }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('heading', { name: 'Server activity' })
  const table = await within(sectionByHeading('Server activity')).findByRole('table')
  const edge = within(table).getByRole('row', { name: /Website edge/ })
  const logs = within(table).getByRole('row', { name: /Server logs/ })
  // The headline is the API's count; likely fakes are never added to it.
  expect(within(edge).getAllByRole('cell')[3]!.textContent).toBe('5')
  expect(within(edge).getByRole('button', { name: 'Excludes 12 fake requests from bots posing as an AI assistant.' })).toBeTruthy()
  expect(within(logs).getAllByRole('cell')[3]!.textContent).toBe('8')
  expect(within(logs).queryByRole('button', { name: /fake requests/ })).toBeNull()
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

function socialPlatformRow(row: {
  key: string
  platform: string | null
  label: string
  sessions: number
  paidSessions: number
  conversions: number | null
  display: string
  rank: number | null
  enoughSessions: boolean
  sources?: unknown[]
}) {
  return {
    key: row.key,
    platform: row.platform,
    label: row.label,
    sessions: row.sessions,
    organicSessions: row.sessions - row.paidSessions,
    paidSessions: row.paidSessions,
    share: 0.3,
    conversions: row.conversions,
    conversionsPerThousandSessions: row.display === '\u2014' ? null : Number.parseFloat(row.display),
    conversionsPerThousandSessionsDisplay: row.display,
    enoughSessions: row.enoughSessions,
    rank: row.rank,
    paid: { sessions: row.paidSessions, conversions: 0, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '\u2014' },
    organic: { sessions: row.sessions - row.paidSessions, conversions: 0, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '\u2014' },
    channelGroups: ['Organic Social'],
    sources: row.sources ?? [],
  }
}

/**
 * Platforms across every GA4 channel, as the API sends them: sessions
 * descending, with the rank, the not-ranked flag and every rate set by the
 * server. The displays here differ from conversions / sessions on purpose, so
 * a client recount would show.
 */
function socialPlatformPerformance(overrides: Record<string, unknown> = {}) {
  const facebookSources = [
    { source: 'FB_Ads', medium: 'paidsocial', channelGroup: 'Paid Other', trafficClass: 'paid', sessions: 1500, share: 0.47, conversions: 6, conversionsPerThousandSessions: 4, conversionsPerThousandSessionsDisplay: '4.0' },
    { source: 'facebook.com', medium: 'referral', channelGroup: 'Organic Social', trafficClass: 'organic', sessions: 120, share: 0.04, conversions: 0, conversionsPerThousandSessions: 0, conversionsPerThousandSessionsDisplay: '0' },
  ]
  return {
    status: 'ready',
    unavailableReason: null,
    sessions: 3220,
    sharePct: 32.2,
    sharePctDisplay: '32.2%',
    paidSessions: 1500,
    paidShare: 0.466,
    conversions: 26,
    conversionRateAvailable: true,
    conversionRateUnavailableReason: null,
    countedEventNames: ['purchase'],
    minSessions: 1000,
    site: { sessions: 10000, conversions: 56, conversionsPerThousandSessions: 5.6, conversionsPerThousandSessionsDisplay: '5.6' },
    platforms: [
      socialPlatformRow({ key: 'facebook', platform: 'facebook', label: 'Facebook', sessions: 1620, paidSessions: 1500, conversions: 6, display: '3.7', rank: 2, enoughSessions: true, sources: facebookSources }),
      socialPlatformRow({ key: 'instagram', platform: 'instagram', label: 'Instagram', sessions: 1200, paidSessions: 0, conversions: 12, display: '9.9', rank: 1, enoughSessions: true }),
      socialPlatformRow({ key: 'shopmy', platform: 'shopmy', label: 'ShopMy', sessions: 400, paidSessions: 0, conversions: 8, display: '20.0', rank: null, enoughSessions: false }),
    ],
    daily: {
      series: [{ key: 'facebook', label: 'Facebook', sessions: 1620 }, { key: 'instagram', label: 'Instagram', sessions: 1200 }, { key: 'shopmy', label: 'ShopMy', sessions: 400 }],
      otherCount: 0,
      days: [{ date: '2026-03-31', sessions: 3220, values: { facebook: 1620, instagram: 1200, shopmy: 400 } }],
    },
    ...overrides,
  }
}

test('social platforms across every GA4 channel rank by the API conversions per 1,000 sessions', async () => {
  onTestFinished(mockConnectedGa({
    '/ga/traffic': () => jsonResponse(gaTrafficResponse({ socialPlatformPerformance: socialPlatformPerformance() })),
  }))

  renderActivitySection()

  const section = await waitFor(() => sectionByHeading('Social'))
  const figures = within(within(section).getByLabelText('Social sessions'))
  expect(figures.getByText('3,220')).toBeTruthy()
  expect(figures.getByText('32.2% of all sessions')).toBeTruthy()
  expect(within(figures.getByText('Top platform').closest('div') as HTMLElement).getByText('Facebook')).toBeTruthy()
  const best = figures.getByText('Best converting').closest('div') as HTMLElement
  expect(within(best).getByText('Instagram')).toBeTruthy()
  expect(within(best).getByText('9.9 per 1,000 sessions')).toBeTruthy()

  const platformsRow = disclosure(section, 'Social platforms')
  expect(within(platformsRow).getByText('3 platforms · 2 sources')).toBeTruthy()
  await openDisclosure(platformsRow)
  const table = await within(platformsRow).findByRole('table', { name: 'Social and creator platforms by sessions and conversions' })
  const bodyRows = within(table).getAllByRole('row').slice(1)
  // The whole-site row is pinned first; platforms follow the server rank, and
  // the platform with too few sessions comes last whatever its rate.
  expect(bodyRows[0]!.getAttribute('data-testid')).toBe('social-site-average')
  expect(within(bodyRows[0]!).getByText('10,000')).toBeTruthy()
  expect(within(bodyRows[0]!).getByText('5.6')).toBeTruthy()
  expect(bodyRows.slice(1).map(row => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
    'Instagram0 sources',
    'Facebook2 sources',
    'ShopMy0 sources',
  ])
  expect(within(bodyRows[1]!).getByText('9.9')).toBeTruthy()
  expect(within(bodyRows[1]!).getByText('1')).toBeTruthy()
  expect(within(bodyRows[3]!).getByText('20.0')).toBeTruthy()
  expect(within(bodyRows[3]!).getByText(ACTIVITY_COPY.notRanked)).toBeTruthy()

  // An ad GA4 filed under Paid Other reads as Paid, with GA4's channel verbatim.
  fireEvent.click(within(table).getByRole('button', { name: /Facebook/ }))
  const sources = within(table).getByRole('table', { name: 'Facebook sources' })
  const adRow = within(sources).getByText('FB_Ads').closest('tr') as HTMLElement
  expect(within(adRow).getByText('Paid Other')).toBeTruthy()
  expect(within(adRow).getByText('Paid')).toBeTruthy()
  expect(within(adRow).getByText('4.0')).toBeTruthy()
})

test('social platforms withhold ranks with the API reason, and keep sessions and conversions', async () => {
  const withheld = socialPlatformPerformance({ conversionRateAvailable: false, conversionRateUnavailableReason: 'sessions-before-leads' })
  withheld.platforms = withheld.platforms.map(row => ({ ...row, rank: null, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '\u2014' }))
  withheld.site = { ...withheld.site, conversionsPerThousandSessions: null, conversionsPerThousandSessionsDisplay: '\u2014' }
  onTestFinished(mockConnectedGa({
    '/ga/traffic': () => jsonResponse(gaTrafficResponse({ socialPlatformPerformance: withheld })),
  }))

  renderActivitySection()

  const section = await waitFor(() => sectionByHeading('Social'))
  const best = within(within(section).getByLabelText('Social sessions')).getByText('Best converting').closest('div') as HTMLElement
  expect(within(best).getByText(ACTIVITY_COPY.notMeasured)).toBeTruthy()
  const platformsRow = disclosure(section, 'Social platforms')
  await openDisclosure(platformsRow)
  expect(within(platformsRow).getByText(ACTIVITY_COPY.rateReasons['sessions-before-leads'])).toBeTruthy()
  const table = within(platformsRow).getByRole('table', { name: 'Social and creator platforms by sessions and conversions' })
  // Sessions order when nothing is ranked, and conversions still shown.
  const bodyRows = within(table).getAllByRole('row').slice(1)
  expect(bodyRows.slice(1).map(row => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
    'Facebook2 sources',
    'Instagram0 sources',
    'ShopMy0 sources',
  ])
  expect(within(bodyRows[2]!).getByText('12')).toBeTruthy()
  expect(within(table).queryByText(ACTIVITY_COPY.notRanked)).toBeNull()
})

test('top time picker reloads every GA surface, social included, from the same window', async () => {
  const seen = new Set<string>()
  const syncDays: number[] = []
  const serverStarts: string[] = []
  const platforms = {
    '7d': { label: 'LinkedIn', platform: 'linkedin', source: 'linkedin.com', sessions: 7 },
    '30d': { label: 'Facebook', platform: 'facebook', source: 'facebook.com', sessions: 30 },
    '90d': { label: 'X', platform: 'x', source: 'x.com', sessions: 90 },
    '180d': { label: 'Instagram', platform: 'instagram', source: 'instagram.com', sessions: 180 },
  } as const
  const surfaces = ['traffic', 'ai-referral-daily', 'session-history', 'overview'] as const

  onTestFinished(mockFetch((url, init) => {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname.endsWith('/traffic/sources')) return jsonResponse({ sources: [] })
    if (parsed.pathname.endsWith('/traffic/events')) {
      serverStarts.push(parsed.searchParams.get('since')!)
      return jsonResponse({ events: [], totals: {}, series: { points: [] } })
    }
    if (parsed.pathname.endsWith('/ga/sync')) {
      syncDays.push((JSON.parse(String(init?.body)) as { days: number }).days)
      return jsonResponse({ rowCount: 0, aiReferralCount: 0, socialReferralCount: 0, days: 180 })
    }
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

  renderActivitySection()
  await assertWindow('30d')
  const picker = screen.getByRole('group', { name: 'Traffic time period' })
  for (const window of ['7d', '90d', '180d'] as const) {
    fireEvent.click(within(picker).getByRole('button', { name: window }))
    await assertWindow(window)
  }
  expect(within(picker).getByRole('button', { name: '180d' }).getAttribute('aria-pressed')).toBe('true')
  expect(within(sectionByHeading('Site traffic')).getAllByText('vs prior 180 days').length).toBeGreaterThan(0)
  expect(Math.round((Date.now() - Date.parse(serverStarts.at(-1)!)) / 86_400_000)).toBe(180)
  fireEvent.click(within(sectionByHeading('Site traffic')).getByRole('button', { name: 'Sync' }))
  await waitFor(() => expect(syncDays).toEqual([180]))
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
test('AI traffic charts name their series and keep every y label whole', async () => {
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
  // The machines chart carries a legend; each visits panel names its count.
  expect(screen.getAllByTestId('chart-legend').length).toBe(1)
  expect(within(screen.getByRole('group', { name: 'Visits, server' })).getByText('Visits, server')).toBeTruthy()
  // GA4 recorded nothing here, so Both draws no empty GA4 panel.
  expect(screen.queryByRole('group', { name: 'Visits, GA4' })).toBeNull()
  // Four-digit ticks read compactly on every chart, so the gutter holds them,
  // and exactly: a 1,050 gridline is not labelled 1.1K.
  for (const axis of screen.getAllByTestId('y-axis')) {
    expect([axis.getAttribute('data-tick-4000'), axis.getAttribute('data-tick-1050')]).toEqual(['4.0K', '1.05K'])
  }
})

/**
 * Server visits before the API's `aiReferralCountingChangedAt` were counted by
 * an older rule that also counted a visitor's later pages, and can read many
 * times high. The chart keeps them, bands them where the server line is drawn,
 * and says so on the visitors total; GA4 never used that rule, so its view
 * carries no band.
 */
test('AI traffic history bands server visits counted by the older rule', async () => {
  const days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  for (const changedAt of ['2026-11-02T18:31:33.000Z', null]) {
    const restoreFetch = mockFetch((url) => {
      const path = url.split('?')[0]!
      if (path.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
      if (path.endsWith('/projects/test-project/traffic/events')) {
        return jsonResponse({
          events: [], eventRows: { total: 0, returned: 0, truncated: false },
          totals: { crawlerHits: 60, crawlerContentHits: 60, aiUserFetchHits: 6, aiReferralHits: 336, aiReferralLandedHits: 336 },
          series: {
            granularity: 'day', coverageStart: '2026-08-16T18:00:00.000Z', aiReferralCountingChangedAt: changedAt,
            trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
            points: days.map((bucket, i) => ({
              bucket, crawlerHits: 10, crawlerContentHits: 10, aiUserFetchHits: 1,
              aiReferralHits: i < 3 ? 100 : 2, aiReferralLandedHits: i < 3 ? 100 : 2, measured: true,
            })),
          },
        })
      }
      return jsonResponse({ sources: [{ id: 's1', status: 'connected' }] })
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
      </QueryClientProvider>,
    )
    const visitorsTile = (await screen.findByText(AI_TRAFFIC_HISTORY_COPY.visitors)).closest('div') as HTMLElement

    if (changedAt) {
      // Raw totals and their caveat remain; the historical band has no caption.
      expect(within(visitorsTile).getByText('336')).toBeTruthy()
      expect(within(visitorsTile).getByText(AI_TRAFFIC_HISTORY_COPY.visitorsOlderDetail)).toBeTruthy()
      const band = screen.getByTestId('reference-area')
      expect(band.getAttribute('data-from')).toBe('2026-10-31')
      expect(band.getAttribute('data-to')).toBe('2026-11-02')
      expect(band.textContent).toBe('')
      // The older count is its own faded series, keyed as reading high.
      const serverPanel = screen.getByRole('group', { name: 'Visits, server' })
      expect(within(serverPanel).getByTestId('dots-serverOlder')).toBeTruthy()
      expect(within(serverPanel).getByText('Older count, may read high')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
      expect(screen.queryAllByTestId('reference-area')).toEqual([])
    } else {
      expect(within(visitorsTile).getByText(AI_TRAFFIC_HISTORY_COPY.visitorsDetail)).toBeTruthy()
      expect(screen.queryAllByTestId('reference-area')).toEqual([])
      expect(screen.queryByTestId('dots-serverOlder')).toBeNull()
      expect(screen.queryByText('Older count, may read high')).toBeNull()
    }
    cleanup()
    restoreFetch()
  }
})

/**
 * Review finding: once the older and newer server counts became separate
 * lines, a count with one day in view had no neighbour to join and drew
 * nothing in Days, while the key still listed it. A lone day of either count
 * is a dot; a run of days stays a line.
 */
test('Days view draws a lone older or newer server day as a dot', async () => {
  const days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  for (const { changedAt, older, newer } of [
    // Changed on the first day shown: the older count holds that day alone.
    { changedAt: '2026-10-31T18:31:33.000Z', older: [['0', '0.4']], newer: [] },
    // Changed on the day before the last: the newer count holds the last day alone.
    { changedAt: '2026-11-04T18:31:33.000Z', older: [], newer: [['5', '1']] },
  ]) {
    const restoreFetch = mockFetch((url) => {
      const path = url.split('?')[0]!
      if (path.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
      if (path.endsWith('/projects/test-project/traffic/events')) {
        return jsonResponse({
          events: [], eventRows: { total: 0, returned: 0, truncated: false },
          totals: { crawlerHits: 60, crawlerContentHits: 60, aiUserFetchHits: 6, aiReferralHits: 60, aiReferralLandedHits: 60 },
          series: {
            granularity: 'day', coverageStart: '2026-08-16T18:00:00.000Z', aiReferralCountingChangedAt: changedAt,
            trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
            points: days.map(bucket => ({
              bucket, crawlerHits: 10, crawlerContentHits: 10, aiUserFetchHits: 1, aiReferralHits: 10, aiReferralLandedHits: 10, measured: true,
            })),
          },
        })
      }
      return jsonResponse({ sources: [{ id: 's1', status: 'connected' }] })
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
      </QueryClientProvider>,
    )
    const serverPanel = await screen.findByRole('group', { name: 'Visits, server' })
    const dots = (dataKey: string) => [...within(serverPanel).getByTestId(`dots-${dataKey}`).querySelectorAll('circle')]
      .map(circle => [circle.getAttribute('cx'), circle.getAttribute('fill-opacity')])
    expect(dots('serverOlder'), changedAt).toEqual(older)
    expect(dots('aiReferralLandedHits'), changedAt).toEqual(newer)
    cleanup()
    restoreFetch()
  }
})

/** The x of every count-change line the charts draw, in document order. */
const changeMarkers = () => [...document.querySelectorAll('[data-marker]')].map((marker) => marker.getAttribute('data-marker'))

/** What a hover names one series on each bucket, in bucket order. */
const hoverLabels = (dataKey: string) => [...document.querySelectorAll(`[data-testid="chart-tooltip"] [data-series="${dataKey}"]`)]
  .map((entry) => [entry.getAttribute('data-bucket'), entry.getAttribute('data-label')])

/**
 * Page fetches before the API's `aiUserFetchCountingChangedAt`, the end of the
 * last hour a browser agent's requests were counted under older rules, can read
 * high or low. The page fetches total says so, a line marks the last such day
 * wherever page fetches are drawn, and a hover names that day's fetches and the
 * ones before it the older count. A change at midnight leaves the day it begins
 * counted the new way. The visitors total, counted by its own rule, says nothing.
 */
test('AI traffic history marks page fetches counted before browser agents counted page loads only', async () => {
  const days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  const older = AI_TRAFFIC_HISTORY_COPY.olderPageFetchesSeries
  const current = AI_TRAFFIC_HISTORY_COPY.pageFetchesSeries
  for (const { changedAt, through } of [
    { changedAt: '2026-11-02T10:00:00.000Z', through: '2026-11-02' },
    { changedAt: '2026-11-03T00:00:00.000Z', through: '2026-11-02' },
    { changedAt: null, through: null },
  ]) {
    const restoreFetch = mockFetch((url) => {
      const path = url.split('?')[0]!
      if (path.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
      if (path.endsWith('/projects/test-project/traffic/events')) {
        return jsonResponse({
          events: [], eventRows: { total: 0, returned: 0, truncated: false },
          totals: { crawlerHits: 60, crawlerContentHits: 60, aiUserFetchHits: 69, aiReferralHits: 12, aiReferralLandedHits: 12 },
          series: {
            granularity: 'day', coverageStart: '2026-08-16T18:00:00.000Z', aiUserFetchCountingChangedAt: changedAt,
            trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
            points: days.map((bucket, i) => ({
              bucket, crawlerHits: 10, crawlerContentHits: 10, aiUserFetchHits: i < 3 ? 20 : 3,
              aiReferralHits: 2, aiReferralLandedHits: 2, measured: true,
            })),
          },
        })
      }
      return jsonResponse({ sources: [{ id: 's1', status: 'connected' }] })
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
      </QueryClientProvider>,
    )
    const fetchesTile = (await screen.findByText(AI_TRAFFIC_HISTORY_COPY.pageFetches)).closest('div') as HTMLElement
    const visitorsTile = screen.getByText(AI_TRAFFIC_HISTORY_COPY.visitors).closest('div') as HTMLElement

    expect(within(fetchesTile).getByText('69')).toBeTruthy()
    expect(within(fetchesTile).getByText(through ? AI_TRAFFIC_HISTORY_COPY.pageFetchesOlderDetail : AI_TRAFFIC_HISTORY_COPY.pageFetchesDetail)).toBeTruthy()
    expect(within(fetchesTile).getByRole('button', { name: AI_TRAFFIC_HISTORY_COPY.pageFetchesTooltip(through) })).toBeTruthy()
    expect(within(visitorsTile).getByText(AI_TRAFFIC_HISTORY_COPY.visitorsDetail)).toBeTruthy()
    // Marked with a line, not a band: the crawler series beside it never changed.
    expect(screen.queryAllByTestId('reference-area')).toEqual([])
    expect(changeMarkers(), String(changedAt)).toEqual(through ? [through] : [])
    expect(hoverLabels('aiUserFetchHits'), String(changedAt)).toEqual(through
      ? [['2026-10-31', older], ['2026-11-01', older], ['2026-11-02', older], ['2026-11-03', current], ['2026-11-04', current], ['2026-11-05', current]]
      : days.map((day) => [day, current]))
    if (through) {
      // Hidden page fetches take their marker with them.
      fireEvent.click(screen.getByRole('checkbox', { name: AI_TRAFFIC_HISTORY_COPY.pageFetchesSeries }))
      expect(changeMarkers()).toEqual([])
    }
    cleanup()
    restoreFetch()
  }
})

/**
 * GA4 counted AI sessions the same way the whole time, so its server-fitted
 * trend is drawn wherever the GA4 line is: Both and GA4, never Server.
 */
/**
 * Months read the long view the monthly report draws: visits by calendar month,
 * part months (recording began inside one, or it is still running) drawn
 * hollow off the line, and the newest complete month's figures in one strip,
 * all as the API reports them.
 */
test('AI traffic history shows visits by month', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'))
  onTestFinished(() => vi.useRealTimers())
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
  const restoreFetch = mockFetch((url) => {
    const [path, query = ''] = url.split('?') as [string, string?]
    if (path.endsWith('/ga/status')) return jsonResponse({ connected: true, propertyId: 'p', clientEmail: null, lastSyncedAt: null })
    if (path.endsWith('/ga/ai-referral-daily')) {
      if (!query.includes('startDate=')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
      return jsonResponse({
        days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0,
        months: [
          { month: '2026-03', sessions: null, complete: false, engines: [] },
          { month: '2026-04', sessions: 46, complete: false, engines: [] },
          ...[['2026-05', 86], ['2026-06', 90], ['2026-07', 88], ['2026-08', 148], ['2026-09', 175]].map(([month, sessions]) =>
            ({ month, sessions, complete: true, engines: [{ key: 'chatgpt', label: 'ChatGPT', sessions }] })),
          { month: '2026-10', sessions: 95, complete: true, engines: [{ key: 'chatgpt', label: 'ChatGPT', sessions: 91 }, { key: 'gemini', label: 'Gemini', sessions: 4 }] },
          { month: '2026-11', sessions: 24, complete: false, engines: [] },
        ],
        monthlyTrend: { slope: 9.7, intercept: 41.6, r2: 0.15, start: 99.8, end: 138.6, n: 5, startIndex: 3, endIndex: 7, startMonth: '2026-06', endMonth: '2026-10', changePct: 39.25 },
      })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      if (query.includes('granularity=month')) {
        return jsonResponse({
          events: [], eventRows: { total: 0, returned: 0, truncated: false },
          totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
          series: {
            granularity: 'month', coverageStart: '2026-05-21T00:00:00.000Z', partialBuckets: ['2026-05', '2026-11'],
            trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
            points: months.map((bucket, i) => ({
              bucket, crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0,
              aiReferralLandedHits: [0, 14, 127, 135, 216, 235, 120, 31][i], measured: i > 0,
            })),
          },
        })
      }
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 5, crawlerContentHits: 5, aiUserFetchHits: 1, aiReferralHits: 2, aiReferralLandedHits: 2 },
        series: {
          granularity: 'day', coverageStart: '2026-05-21T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-11-05', crawlerHits: 5, crawlerContentHits: 5, aiUserFetchHits: 1, aiReferralHits: 2, aiReferralLandedHits: 2, measured: true }],
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
  await screen.findByText('AI crawlers')

  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  const strip = (await screen.findByText('October 2026')).parentElement as HTMLElement
  expect(strip.textContent).toBe('October 202695visits, GA4120visits, server▲39.3%trend since Jun91from ChatGPT')
  const current = screen.getByRole('group', { name: 'Month so far' })
  expect(within(current).getByText('November 2026 so far')).toBeTruthy()
  expect(within(current).getByText('Hollow dots: partial months')).toBeTruthy()
  expect(current.textContent).toMatch(/24\s*visits, GA4/)
  expect(current.textContent).toMatch(/31\s*visits, server/)
  // Part months are hollow and off the line: May and November for the server.
  const serverPartial = screen.getByTestId('dots-serverPartial').querySelectorAll('circle')
  expect([...serverPartial].map(c => c.getAttribute('fill'))).toEqual(['none', 'none'])
  // April (GA4 history began inside it) and November for GA4.
  expect(screen.getByTestId('dots-ga4Partial').querySelectorAll('circle[fill="none"]').length).toBe(2)

  fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
  expect(screen.queryByTestId('dots-serverPartial')).toBeNull()
  expect(strip.textContent).toBe('October 202695visits, GA4▲39.3%trend since Jun91from ChatGPT')
  expect(current.textContent).toMatch(/24\s*visits, GA4/)
  expect(current.textContent).not.toContain('visits, server')
  fireEvent.click(screen.getByRole('button', { name: 'Server' }))
  expect(current.textContent).toMatch(/31\s*visits, server/)
  expect(current.textContent).not.toContain('visits, GA4')
  fireEvent.click(screen.getByRole('button', { name: 'Days' }))
  expect(screen.queryByRole('group', { name: 'Month so far' })).toBeNull()
})

/** Real SDK reads with independently supplied source responses. */
function renderMonthlyHistory(input: {
  dailyActive?: boolean
  serverConnected?: boolean
  gaStatus?: () => Response | Promise<Response>
  server: () => Response | Promise<Response>
  ga: () => Response | Promise<Response>
}) {
  onTestFinished(mockFetch((url) => {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname.endsWith('/ga/status')) return input.gaStatus?.() ?? jsonResponse(GA_STATUS)
    if (parsed.pathname.endsWith('/ga/ai-referral-daily')) {
      return parsed.searchParams.has('startDate') ? input.ga() : jsonResponse(EMPTY_AI_DAILY_RESPONSE)
    }
    if (parsed.pathname.endsWith('/traffic/sources')) {
      return jsonResponse({ sources: input.serverConnected === false ? [] : [{ id: 'server', status: 'connected' }] })
    }
    if (parsed.pathname.endsWith('/traffic/events')) {
      if (parsed.searchParams.get('granularity') === 'month') return input.server()
      const count = input.dailyActive === false ? 0 : 1
      return jsonResponse({
        events: [], totals: { crawlerContentHits: count, aiUserFetchHits: 0, aiReferralLandedHits: count },
        series: {
          coverageStart: input.serverConnected === false ? null : '2026-05-01T00:00:00.000Z',
          points: [{ bucket: '2026-11-05', crawlerContentHits: count, aiReferralLandedHits: count, measured: input.serverConnected !== false }],
        },
      })
    }
    throw new Error(`Unexpected history request: ${url}`)
  }))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}>
    <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
  </QueryClientProvider>)
}

test.each([true, false])('monthly history remains reachable with quiet daily traffic and server connected=%s', async (serverConnected) => {
  renderMonthlyHistory({
    dailyActive: false,
    serverConnected,
    server: () => jsonResponse({ series: { points: serverConnected ? [{ bucket: '2026-10', aiReferralLandedHits: 42, measured: true }] : [] } }),
    ga: () => jsonResponse({ months: [{ month: '2026-10', sessions: 23, complete: true, engines: [] }] }),
  })
  await screen.findByText(serverConnected ? 'No AI activity recorded in this period.' : 'No server-side traffic source connected yet.')
  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  const strip = (await screen.findByText('October 2026')).parentElement as HTMLElement
  await waitFor(() => expect(strip.textContent).toBe(serverConnected ? 'October 202623visits, GA442visits, server' : 'October 202623visits, GA4'))
  // With no server buckets, GA4 must still supply a plotted reading.
  expect(screen.getByTestId('dots-ga4Visits').querySelectorAll('circle')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Days' }))
  expect(screen.queryByText('October 2026')).toBeNull()
})

test('monthly history draws adjacent partial months for both sources', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-12-06T12:00:00.000Z'))
  onTestFinished(() => vi.useRealTimers())
  renderMonthlyHistory({
    server: () => jsonResponse({ series: {
      partialBuckets: ['2026-10', '2026-11'],
      points: [{ bucket: '2026-10', aiReferralLandedHits: 42 }, { bucket: '2026-11', aiReferralLandedHits: 11 }],
    } }),
    ga: () => jsonResponse({ months: [
      { month: '2026-10', sessions: 23, complete: false, engines: [] },
      { month: '2026-11', sessions: 7, complete: false, engines: [] },
    ] }),
  })
  await screen.findByText('AI crawlers')
  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  await waitFor(() => {
    expect(screen.getByTestId('dots-serverPartial').querySelectorAll('circle[fill="none"]')).toHaveLength(2)
    expect(screen.getByTestId('dots-ga4Partial').querySelectorAll('circle[fill="none"]')).toHaveLength(2)
  })
  expect(screen.getByTestId('dots-aiReferralLandedHits').querySelectorAll('circle')).toHaveLength(0)
  expect(screen.getByTestId('dots-ga4Visits').querySelectorAll('circle')).toHaveLength(0)
  // Stale incomplete months remain plotted, but are not the current month.
  expect(screen.queryByRole('group', { name: 'Month so far' })).toBeNull()
})

test('monthly summary follows the selected source when GA4 history ends earlier', async () => {
  renderMonthlyHistory({
    server: () => jsonResponse({ series: { points: [
      { bucket: '2026-09', aiReferralLandedHits: 30 },
      { bucket: '2026-10', aiReferralLandedHits: 42 },
    ] } }),
    ga: () => jsonResponse({ months: [{ month: '2026-09', sessions: 23, complete: true, engines: [] }] }),
  })
  await screen.findByText('AI crawlers')
  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  await screen.findByText('September 2026')
  fireEvent.click(screen.getByRole('button', { name: 'Server' }))
  expect((await screen.findByText('October 2026')).parentElement?.textContent).toBe('October 202642visits, server')
  fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
  expect(screen.getByText('September 2026').parentElement?.textContent).toBe('September 202623visits, GA4')
})

test.each(['server', 'ga', 'status'] as const)('monthly history reports and retries a failed %s read without claiming zero', async (source) => {
  let finishRequest!: (response: Response) => void
  const pendingResponse = new Promise<Response>((resolve) => { finishRequest = resolve })
  let attempts = 0
  const server = () => jsonResponse({ series: { points: source === 'status' ? [] : [{ bucket: '2026-10', aiReferralLandedHits: 42 }] } })
  const ga = () => jsonResponse({ months: [{ month: '2026-10', sessions: 23, complete: true, engines: [] }] })
  const read = (lane: 'server' | 'ga' | 'status') => {
    if (lane === source && attempts++ === 0) return pendingResponse
    if (lane === 'status') return jsonResponse(GA_STATUS)
    return lane === 'server' ? server() : ga()
  }
  renderMonthlyHistory({ server: () => read('server'), ga: () => read('ga'), gaStatus: () => read('status') })
  await screen.findByText('AI crawlers')
  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  const loading = source === 'status' ? 'Checking the GA4 connection…' : source === 'server' ? 'Loading monthly server visits…' : 'Loading monthly GA4 visits…'
  expect(await screen.findByText(loading)).toBeTruthy()
  expect(screen.queryByText('No monthly visits recorded yet.')).toBeNull()
  finishRequest(new Response('failed', { status: 500 }))
  expect((await screen.findByRole('alert')).textContent).toBe(source === 'status' ? 'Could not check the GA4 connection.' : source === 'server' ? 'Could not load monthly server visits.' : 'Could not load monthly GA4 visits.')
  expect(screen.queryByText('No monthly visits recorded yet.')).toBeNull()
  if (source === 'status') {
    // The unresolved connection must remain an error in GA4-only mode too.
    fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
    expect(screen.getByRole('alert').textContent).toBe('Could not check the GA4 connection.')
    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
  } else {
    const strip = (await screen.findByText('October 2026')).parentElement as HTMLElement
    expect(strip.textContent).toBe(source === 'server' ? 'October 202623visits, GA4' : 'October 202642visits, server')
    expect(screen.getByTestId(source === 'server' ? 'dots-ga4Visits' : 'dots-aiReferralLandedHits').querySelectorAll('circle')).toHaveLength(1)
  }
  fireEvent.click(screen.getByRole('button', { name: source === 'status' ? 'Retry GA4 connection check' : source === 'server' ? 'Retry monthly server visits' : 'Retry monthly GA4 visits' }))
  await waitFor(() => expect(screen.getByText('October 2026').parentElement?.textContent).toBe(source === 'status' ? 'October 202623visits, GA4' : 'October 202623visits, GA442visits, server'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(attempts).toBe(2)
})

test('AI traffic history draws the GA4 trend where the GA4 line is', async () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/ga/status')) return jsonResponse({ connected: true, propertyId: 'p', clientEmail: null, lastSyncedAt: null })
    if (path.endsWith('/ga/ai-referral-daily')) {
      return jsonResponse({
        days: days.map(date => ({ date, sessions: 5 })),
        trend: { slope: 0, intercept: 5, r2: 1, start: 5, end: 5, n: 4, startIndex: 0, endIndex: 3, startDate: '2026-10-01', endDate: '2026-10-04' },
      })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 4, crawlerContentHits: 4, aiUserFetchHits: 0, aiReferralHits: 4, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day', coverageStart: '2026-09-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: days.map(bucket => ({ bucket, crawlerHits: 1, crawlerContentHits: 1, aiUserFetchHits: 0, aiReferralHits: 1, aiReferralLandedHits: 1, measured: true })),
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

  await waitFor(() => expect(screen.getByTestId('line-ga4Trend')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Server' }))
  expect(screen.queryByTestId('line-ga4Trend')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
  expect(screen.getByTestId('line-ga4Trend')).toBeTruthy()
})

/**
 * The server count and GA4's differ many times over, so on one shared axis the
 * GA4 line flattened onto zero and its trend vanished. Both draws one panel
 * per count, each with its own y-axis, over the same buckets and hovering
 * together; picking one source draws only its panel.
 */
test('Both stacks one panel per count, each on its own scale, hovering together', async () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/ga/status')) return jsonResponse({ connected: true, propertyId: 'p', clientEmail: null, lastSyncedAt: null })
    if (path.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: days.map(date => ({ date, sessions: 4 })) })
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 4, crawlerContentHits: 4, aiUserFetchHits: 0, aiReferralHits: 400, aiReferralLandedHits: 400 },
        series: {
          granularity: 'day', coverageStart: '2026-09-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: days.map(bucket => ({ bucket, crawlerHits: 1, crawlerContentHits: 1, aiUserFetchHits: 0, aiReferralHits: 100, aiReferralLandedHits: 100, measured: true })),
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

  const gaPanel = await screen.findByRole('group', { name: 'Visits, GA4' })
  const serverPanel = screen.getByRole('group', { name: 'Visits, server' })
  // Each panel draws only its own count, so each axis scales to that count.
  expect(within(serverPanel).getByTestId('dots-aiReferralLandedHits')).toBeTruthy()
  expect(within(serverPanel).queryByTestId('dots-ga4Visits')).toBeNull()
  expect(within(gaPanel).getByTestId('dots-ga4Visits')).toBeTruthy()
  expect(within(gaPanel).queryByTestId('dots-aiReferralLandedHits')).toBeNull()
  // Server above GA4, hovering together.
  expect(serverPanel.compareDocumentPosition(gaPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  for (const panel of [serverPanel, gaPanel]) {
    expect(within(panel).getByTestId('composed-chart').getAttribute('data-sync')).toBe('ai-visits')
  }

  fireEvent.click(screen.getByRole('button', { name: 'Server' }))
  expect(screen.getByRole('group', { name: 'Visits, server' })).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Visits, GA4' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'GA4' }))
  expect(screen.getByRole('group', { name: 'Visits, GA4' })).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Visits, server' })).toBeNull()
})

/**
 * A month counted by the older arrival rule reads high beside one counted by
 * the newer rule, so the two are separate series: the older one faded, and no
 * line joins them across the change.
 */
test('monthly history keeps the older server count apart from the newer one', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'))
  onTestFinished(() => vi.useRealTimers())
  renderMonthlyHistory({
    server: () => jsonResponse({ series: {
      // Recording began inside August, and November is still running.
      partialBuckets: ['2026-08', '2026-11'],
      aiReferralCountingChangedAt: '2026-09-25T01:00:00.000Z',
      points: [
        { bucket: '2026-08', aiReferralLandedHits: 1900, measured: true },
        { bucket: '2026-09', aiReferralLandedHits: 3800, measured: true },
        { bucket: '2026-10', aiReferralLandedHits: 420, measured: true },
        { bucket: '2026-11', aiReferralLandedHits: 150, measured: true },
      ],
    } }),
    ga: () => jsonResponse({ months: [] }),
  })
  await screen.findByText('AI crawlers')
  fireEvent.click(screen.getByRole('button', { name: 'Months' }))
  const serverPanel = await screen.findByRole('group', { name: 'Visits, server' })
  const circles = (dataKey: string) => [...within(serverPanel).getByTestId(`dots-${dataKey}`).querySelectorAll('circle')]
  // September, counted the older way: a point of its own, faded.
  expect(circles('serverOlder').map(c => c.getAttribute('fill-opacity'))).toEqual(['0.4'])
  // October, counted the newer way: the solid series.
  expect(circles('aiReferralLandedHits').map(c => c.getAttribute('fill-opacity'))).toEqual(['1'])
  // Part months stay hollow, off both lines: August, counted the older way,
  // faded with it; November, still running, at full strength.
  const hollow = (dataKey: string) => circles(dataKey).map(c => [c.getAttribute('fill'), c.getAttribute('stroke-opacity')])
  expect(hollow('serverOlderPartial')).toEqual([['none', '0.4']])
  expect(hollow('serverPartial')).toEqual([['none', '1']])
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
    'Sessions 4.5K, up 6.4% vs prior 30 days, an improvement',
    'Users 2.5K, up 6.1% vs prior 30 days, an improvement',
    'Organic sessions 2.8K, up 7.0% vs prior 30 days, an improvement',
    // Whether a change is good news is said in words, never by colour alone.
    'Engagement rate 60.8%, down 0.5% vs prior 30 days, a decline',
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
  const bounce = await tabs.findByRole('tab', { name: 'Bounce rate 39.2%, down 1.8% vs prior 30 days, an improvement' })
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
