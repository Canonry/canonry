import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GoogleAdsPerformanceDto } from '@ainyc/canonry-contracts'

// Recharts is stubbed: this suite is about the VALUES the section renders.
// The SVG is Recharts' problem, and jsdom cannot lay it out anyway.
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: ({ children, data }: { children?: React.ReactNode; data?: readonly unknown[] }) => <div data-testid="ads-native-chart" data-points={JSON.stringify(data)}>{children}</div>,
    Line: ({ dataKey, yAxisId }: { dataKey?: string; yAxisId?: string | number }) => <span data-testid="ads-native-line" data-key={dataKey} data-axis={yAxisId} />,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
    ReferenceLine: () => null,
  }
})

import { GoogleAdsPerformanceSection } from '../src/components/project/GoogleAdsPerformanceSection.js'
import { compileAppStyles, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

const EMPTY_TOTALS = {
  impressions: 0,
  clicks: 0,
  costMicros: 0,
  conversions: 0,
  conversionValueMicros: null,
  ctr: null,
  cpcMicros: null,
  conversionRate: null,
  costPerConversionMicros: null,
}

/**
 * Fourteen closed days ending 2026-08-14. The snapshot was captured mid-day on
 * 08-15, so 08-15 is the OPEN day and is excluded; 08-05 is a day the provider
 * returned no row for, densified as measured zero delivery.
 */
const DAILY: GoogleAdsPerformanceDto['daily'] = [
  { date: '2026-08-03', origin: 'provider', impressions: 900, clicks: 60, costMicros: 84_000_000, conversions: 2.5, ctr: 60 / 900 },
  { date: '2026-08-04', origin: 'provider', impressions: 1_100, clicks: 80, costMicros: 96_000_000, conversions: 3, ctr: 80 / 1_100 },
  { date: '2026-08-05', origin: 'filled', impressions: 0, clicks: 0, costMicros: 0, conversions: 0, ctr: null },
]

function performanceDto(overrides: Partial<GoogleAdsPerformanceDto> = {}): GoogleAdsPerformanceDto {
  return {
    window: '14d',
    startDate: '2026-08-01',
    endDate: '2026-08-14',
    days: 14,
    totals: {
      impressions: 12_480,
      clicks: 913,
      costMicros: 1_284_500_000,
      conversions: 37.5,
      conversionValueMicros: 9_120_000_000,
      ctr: 913 / 12_480,
      cpcMicros: 1_406_900,
      conversionRate: 37.5 / 913,
      costPerConversionMicros: 34_253_333,
    },
    daily: DAILY,
    campaigns: [
      {
        campaignId: 'campaign_brand',
        name: 'Brand search',
        status: 'enabled',
        totals: {
          impressions: 8_000,
          clicks: 700,
          costMicros: 900_000_000,
          conversions: 30,
          conversionValueMicros: 7_000_000_000,
          ctr: 0.0875,
          cpcMicros: 1_285_714,
          conversionRate: 30 / 700,
          costPerConversionMicros: 30_000_000,
        },
      },
      {
        // Served nothing in the window. CTR has a ZERO denominator, so it is
        // undefined, not 0%.
        campaignId: 'campaign_dormant',
        name: 'Retargeting (paused)',
        status: 'paused',
        totals: { ...EMPTY_TOTALS },
      },
      {
        // The metrics snapshot names a campaign the inventory snapshot does not.
        campaignId: 'campaign_9911',
        name: null,
        status: 'unknown',
        totals: {
          ...EMPTY_TOTALS,
          impressions: 4_480,
          clicks: 213,
          costMicros: 384_500_000,
          conversions: 7.5,
          ctr: 213 / 4_480,
        },
      },
    ],
    comparison: {
      days: 14,
      prior: {
        startDate: '2026-07-18',
        endDate: '2026-07-31',
        days: 14,
        totals: { ...EMPTY_TOTALS, impressions: 9_984, clicks: 1_014, costMicros: 917_500_000, conversions: 0 },
      },
      change: {
        impressions: 0.25,
        clicks: -0.1,
        costMicros: 0.4,
        // Prior period recorded zero conversions: growth from nothing has no
        // percentage, so the API sends null rather than a fabricated number.
        conversions: null,
        ctr: 0.3888,
        conversionRate: null,
      },
    },
    comparisonUnavailableReason: null,
    source: {
      snapshotId: 'snapshot_google_ads_1',
      capturedAt: '2026-08-15T09:30:00.000Z',
      customerId: '5550001234',
      currencyCode: 'USD',
      timeZone: 'America/Los_Angeles',
      asOfDate: '2026-08-14',
      openDate: '2026-08-15',
      truncated: false,
      campaignsQueried: 3,
      campaignsInInventory: 3,
    },
    ...overrides,
  }
}

function renderSection(dto: GoogleAdsPerformanceDto, requested: string[] = [], windows: Partial<Record<string, GoogleAdsPerformanceDto>> = {}) {
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    requested.push(path)
    if (path.startsWith('/api/v1/projects/example/google-ads/performance')) return jsonResponse(windows[new URL(path, window.location.origin).searchParams.get('window') ?? ''] ?? dto)
    return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(
    <QueryClientProvider client={queryClient}>
      <GoogleAdsPerformanceSection projectName="example" />
    </QueryClientProvider>,
  )
  return { requested, dispose() { cleanup(); restore(); queryClient.clear() } }
}

function campaignRow(name: string) {
  return screen.getByText(name).closest('tr')!
}

function campaignCell(name: string, column: string) {
  const table = screen.getByRole('table', { name: 'Google Ads campaign performance for the selected window' })
  const index = within(table).getAllByRole('columnheader').findIndex(header => header.textContent === column)
  expect(index).toBeGreaterThanOrEqual(0)
  return within(campaignRow(name)).getAllByRole('cell')[index]!
}
function metricTile(label: string) {
  const text = screen.getAllByText(label).find(element => element.tagName === 'SPAN' || element.tagName === 'DT')!
  expect(text).toBeDefined()
  return text.closest('button') ?? text.parentElement!
}
function plottedSeries() {
  return screen.getAllByTestId('ads-native-line').map(element => [element.getAttribute('data-key'), element.getAttribute('data-axis')])
}

describe('GoogleAdsPerformanceSection', () => {
  test('renders stored totals, period deltas, the daily series, and per-campaign figures', async () => {
    const requested: string[] = []
    renderSection(performanceDto(), requested)

    await waitFor(() => expect(screen.getByText('$1,284.50')).toBeTruthy())

    // KPI row: spend as a formatted currency string, counts as counts, and
    // conversions keeping their fractional part.
    expect(screen.getByText('913')).toBeTruthy()
    expect(screen.getByText('12,480')).toBeTruthy()
    expect(screen.getByText('37.5')).toBeTruthy()

    // Deltas come from `comparison.change`, never recomputed here. Only the
    // four KPI tiles carry them; clicks and impressions live in the rate strip,
    // which is a definition list and shows values without change.
    expect(screen.getByText('↑ 40.0% vs prior 14d')).toBeTruthy()
    // Impressions (+25%) and clicks (-10%) moved into the rate strip, which
    // carries values only, so their deltas are no longer rendered.
    expect(screen.queryByText('↑ 25.0% vs prior 14d')).toBeNull()
    expect(screen.queryByText('↓ 10.0% vs prior 14d')).toBeNull()
    expect(screen.queryByText('↑ 25% vs prior 14d')).toBeNull()
    expect(screen.queryByText('↓ 10% vs prior 14d')).toBeNull()

    // Window label reads the closed range, and the open capture day is named
    // as excluded rather than silently dropped.
    expect(screen.getByText(/Aug 1, 2026 to Aug 14, 2026/)).toBeTruthy()
    expect(screen.getByText(/Aug 15, 2026 still open, excluded/)).toBeTruthy()

    // Daily series, including the densified day marked as measured zero.
    // The screen-reader list mirrors the PLOTTED series, so it reads
    // "Spend …, Conversions …" for the default selection. It must follow the
    // tile toggles rather than hard-coding two metrics.
    expect(screen.getByText(/Aug 3, 2026:\s*Spend \$84\.00, Conversions 2\.5/)).toBeTruthy()
    expect(screen.getByText(/Aug 4, 2026:\s*Spend \$96\.00, Conversions 3/)).toBeTruthy()
    expect(screen.getByText(/Aug 5, 2026:\s*Spend \$0\.00, Conversions 0.*no delivery reported/)).toBeTruthy()

    // Campaign table.
    const brand = campaignRow('Brand search')
    expect(within(brand).getByText('Enabled')).toBeTruthy()
    expect(within(brand).getByText('8,000')).toBeTruthy()
    expect(within(brand).getByText('700')).toBeTruthy()
    expect(within(brand).getByText('$900.00')).toBeTruthy()
    expect(within(brand).getByText('30')).toBeTruthy()
    expect(within(brand).getByText('8.8%')).toBeTruthy()

    // A campaign the inventory snapshot does not name falls back to its id.
    expect(within(campaignRow('campaign_9911')).getByText('Unknown')).toBeTruthy()

    expect(requested.some((path) => path.includes('/google-ads/performance?window=14d'))).toBe(true)
    // Stored data only: nothing else is read, so nothing can spend the budget.
    expect(requested.every((path) => path.startsWith('/api/v1/projects/example/google-ads/performance'))).toBe(true)
  })

  test('renders a zero-denominator ratio as unavailable, never as 0%', async () => {
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getByText('$1,284.50')).toBeTruthy())

    // The dormant campaign served nothing: clicks / impressions is 0 / 0.
    const dormant = campaignRow('Retargeting (paused)')
    // CTR and Cost/conv are both unavailable for a campaign that served
    // nothing, so assert at least one rather than a unique match.
    expect(campaignCell('Retargeting (paused)', 'CTR').textContent).toBe('not available')
    expect(campaignCell('Retargeting (paused)', 'Cost / conv.').textContent).toBe('not available')
    expect(within(dormant).queryByText('0.0%')).toBeNull()
    expect(within(dormant).queryByText('0%')).toBeNull()

    // Same rule on the conversions delta: the prior period recorded zero, so
    // the change ratio is null and must not read as flat. Conversions,
    // conversion rate and cost/conv are all null in this fixture, so assert the
    // count rather than a unique match.
    // Two, not three: cost/conv has no comparison field at all, so it renders
    // no delta line rather than an "unavailable" one.
    expect(within(metricTile('Conversions')).getByText('not available vs prior 14d')).toBeTruthy()
    expect(within(metricTile('Conv. rate')).getByText('not available vs prior 14d')).toBeTruthy()
    expect(within(metricTile('Cost / conv.')).queryByText(/vs prior/)).toBeNull()
    expect(screen.queryByText('no change vs prior 14d')).toBeNull()
  })

  test('renders the onboarding empty state when no snapshot has ever been stored', async () => {
    renderSection(performanceDto({
      totals: { ...EMPTY_TOTALS },
      daily: [],
      campaigns: [],
      comparison: null,
      comparisonUnavailableReason: 'no-snapshot',
      source: null,
    }))

    await waitFor(() => expect(screen.getByText('No Google Ads snapshot stored yet')).toBeTruthy())
    expect(screen.getByText('Connect a Google Ads account in Conversion Integrity below, choose the customer, then run a Google Ads sync. Spend, clicks, impressions, and conversions appear here once the first snapshot is stored.')).toBeTruthy()

    // No tiles, no chart, no table: an empty snapshot is not a measured zero.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Spend')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  test('renders the window without deltas and says why when no comparison exists', async () => {
    renderSection(performanceDto({
      comparison: null,
      comparisonUnavailableReason: 'insufficient-history',
    }))

    await waitFor(() => expect(screen.getByText('$1,284.50')).toBeTruthy())

    expect(screen.getByText('Period change is hidden: the stored snapshot does not cover a prior period of equal length yet.')).toBeTruthy()
    // Not a single delta is printed, and above all not a 0%.
    expect(screen.queryByText(/vs prior/)).toBeNull()
    expect(screen.queryByText(/no change/)).toBeNull()
  })

  test('says so visibly when the provider returned a bounded result', async () => {
    renderSection(performanceDto({
      source: { ...performanceDto().source!, truncated: true, campaignsQueried: 41, campaignsInInventory: 41 },
    }))

    await waitFor(() => expect(screen.getByText(/bounded result/)).toBeTruthy())
    // The row cap says nothing about campaign coverage. With every campaign
    // queried there is no shortfall to report, and claiming "41 of 41" would be
    // a caveat about nothing.
    expect(screen.queryByText(/campaigns, so they are a subset/)).toBeNull()
  })

  test('warns that totals are a subset when the 50-campaign cap left campaigns out', async () => {
    // The defect this guards: the campaign query cap is a DIFFERENT limit from
    // the row cap. An account over the cap is summed from the queried subset
    // while `truncated` stays false, so gating the caveat on `truncated` renders
    // a subtotal as the account total with no warning at all.
    renderSection(performanceDto({
      source: { ...performanceDto().source!, truncated: false, campaignsQueried: 50, campaignsInInventory: 120 },
    }))

    await waitFor(() => expect(screen.getByText(/50 of 120 campaigns, so they are a subset/)).toBeTruthy())
    expect(screen.queryByText(/bounded result/)).toBeNull()
  })

  test('reports no coverage shortfall when every campaign was queried', async () => {
    renderSection(performanceDto({
      source: { ...performanceDto().source!, truncated: false, campaignsQueried: 12, campaignsInInventory: 12 },
    }))

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    expect(screen.queryByText(/so they are a subset/)).toBeNull()
  })

  test('does not claim a coverage shortfall when no inventory snapshot is stored', async () => {
    // campaignsInInventory 0 means the inventory snapshot is missing, which
    // proves nothing about coverage. "3 of 0 campaigns" would be nonsense.
    renderSection(performanceDto({
      source: { ...performanceDto().source!, truncated: false, campaignsQueried: 3, campaignsInInventory: 0 },
    }))

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    expect(screen.queryByText(/so they are a subset/)).toBeNull()
  })


  test('distinguishes wasted spend from an undefined cost per conversion', async () => {
    const dto = performanceDto()
    renderSection({ ...dto, totals: { ...dto.totals, costMicros: 42_000_000, conversions: 0, costPerConversionMicros: null }, campaigns: [
      { campaignId: 'waste', name: 'Spend without conversions', status: 'enabled', totals: { ...EMPTY_TOTALS, impressions: 100, clicks: 8, costMicros: 42_000_000 } },
      { campaignId: 'idle', name: 'No spend or conversions', status: 'paused', totals: { ...EMPTY_TOTALS } },
    ] })
    await screen.findByText('$42.00', { selector: 'span' })
    expect(within(metricTile('Cost / conv.')).getByText('no conversions')).toBeTruthy()
    const waste = campaignCell('Spend without conversions', 'Cost / conv.')
    const badge = within(waste).getByText('no conversions')
    const rules = parseCompiledCss(await compileAppStyles([...badge.classList]))
    expect(compiledElementProperty(rules, badge, 'color')).toBe('var(--color-caution-text)')
    expect(campaignCell('No spend or conversions', 'Cost / conv.').textContent).toBe('not available')
    expect(within(campaignRow('No spend or conversions')).queryByText('no conversions')).toBeNull()
  })

  test('efficiency figures reach the operator, not just the CLI', async () => {
    const cases = [
      { key: 'missing', ratio: null, expected: 'not available' },
      { key: 'measured-zero', ratio: 0, expected: '0%' },
      { key: 'tiny-positive', ratio: 0.0004, expected: '<0.1%' },
      { key: 'ordinary-rate', ratio: 0.073, expected: '7.3%' },
      { key: 'rounded-rate', ratio: 0.0875, expected: '8.8%' },
      { key: 'short-of-one', ratio: 0.9996, expected: '>99.9%' },
      { key: 'multiple-conversions-per-click', ratio: 1.25, expected: '125.0%' },
    ]
    for (const entry of cases) {
      const dto = performanceDto()
      // These API-derived rates and micros deliberately disagree with raw counts.
      const mounted = renderSection({ ...dto, totals: { ...dto.totals, ctr: 0.0875, conversionRate: entry.ratio, cpcMicros: 9_876_543, costPerConversionMicros: 17_250_000 } })
      try {
        await screen.findByText('$1,284.50')
        expect(within(metricTile('Cost / conv.')).getByText('$17.25'), entry.key).toBeTruthy()
        expect(within(metricTile('Conv. rate')).getByText(entry.expected), entry.key).toBeTruthy()
        expect(within(metricTile('CTR')).getByText('8.8%'), entry.key).toBeTruthy()
        expect(within(metricTile('CPC')).getByText('$9.88'), entry.key).toBeTruthy()
        expect(screen.getAllByText('Cost / conv.')).toHaveLength(2)
        expect(screen.getAllByText('CTR')).toHaveLength(2)
      } finally { mounted.dispose() }
    }
  })

  test('does not invent a currency when the account currency is unresolved', async () => {
    renderSection(performanceDto({
      source: { ...performanceDto().source!, currencyCode: null },
    }))

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    // The magnitude still shows; the unit does not. A '$' on a EUR account is a
    // wrong number, not a missing one.
    expect(screen.queryByText(/\$/)).toBeNull()
    expect(screen.getByText('1,284.50')).toBeTruthy()
  })



  test('screen-reader series follow the plotted selection', async () => {
    for (const entry of [
      { label: 'Clicks', key: 'clicks', axis: 'clicks', first: '60', second: '80' },
      { label: 'Impressions', key: 'impressions', axis: 'impressions', first: '900', second: '1,100' },
    ]) {
      const mounted = renderSection(performanceDto())
      try {
        await screen.findByText('$1,284.50')
        const toggle = screen.getByRole('button', { name: new RegExp(`^${entry.label}`) })
        expect(toggle.getAttribute('aria-pressed')).toBe('false')
        expect(plottedSeries()).toEqual([['costMicros', 'spend'], ['conversions', 'conversions']])
        fireEvent.click(toggle)
        expect(toggle.getAttribute('aria-pressed')).toBe('true')
        expect(plottedSeries()).toEqual([['costMicros', 'spend'], ['conversions', 'conversions'], [entry.key, entry.axis]])
        expect(screen.getByText(`Aug 3, 2026: Spend $84.00, Conversions 2.5, ${entry.label} ${entry.first}`)).toBeTruthy()
        expect(screen.getByText(`Aug 4, 2026: Spend $96.00, Conversions 3, ${entry.label} ${entry.second}`)).toBeTruthy()
        expect(JSON.parse(screen.getByTestId('ads-native-chart').getAttribute('data-points')!)).toEqual([
          { date: '2026-08-03', origin: 'provider', impressions: 900, clicks: 60, costMicros: 84_000_000, conversions: 2.5, ctr: 60 / 900 },
          { date: '2026-08-04', origin: 'provider', impressions: 1_100, clicks: 80, costMicros: 96_000_000, conversions: 3, ctr: 80 / 1_100 },
          { date: '2026-08-05', origin: 'filled', impressions: 0, clicks: 0, costMicros: 0, conversions: 0, ctr: null },
        ])
        fireEvent.click(screen.getByRole('button', { name: /^Spend/ }))
        fireEvent.click(screen.getByRole('button', { name: /^Conversions/ }))
        expect(plottedSeries()).toEqual([[entry.key, entry.axis]])
        expect(toggle.hasAttribute('disabled')).toBe(true)
        fireEvent.click(toggle)
        expect(plottedSeries()).toEqual([[entry.key, entry.axis]])
        expect(screen.getByText(`Aug 3, 2026: ${entry.label} ${entry.first}`)).toBeTruthy()
      } finally { mounted.dispose() }
    }
  })

  test('names the time zone that decides when a day closes', async () => {
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    expect(screen.getByText(/days close in America\/Los_Angeles/)).toBeTruthy()
  })

  test('does not claim a sync is running when no day has closed', async () => {
    renderSection(performanceDto({ source: null, comparisonUnavailableReason: 'insufficient-history' }))

    await waitFor(() => expect(screen.getByText('No closed days yet')).toBeTruthy())
    expect(screen.queryByText(/syncing/i)).toBeNull()
  })


  test('shows a loading state before the stored snapshot arrives', () => {
    renderSection(performanceDto())

    expect(screen.getByText('Loading Google Ads performance…')).toBeTruthy()
    expect(screen.queryByText('$1,284.50')).toBeNull()
  })
})

describe('google ads ratio formatting', () => {

  test('a change of exactly zero is a measured no-change, unlike an absent one', async () => {
    const cases = [
      { ratio: 0, days: 7, window: '7d' as const, start: '2026-08-08', priorStart: '2026-08-01', priorEnd: '2026-08-07', text: 'no change vs prior 7d', color: 'var(--color-text-muted)' },
      { ratio: null, days: 7, window: '7d' as const, start: '2026-08-08', priorStart: '2026-08-01', priorEnd: '2026-08-07', text: 'not available vs prior 7d', color: 'var(--color-text-muted)' },
      { ratio: 0.0004, days: 7, window: '7d' as const, start: '2026-08-08', priorStart: '2026-08-01', priorEnd: '2026-08-07', text: '↑ <0.1% vs prior 7d', color: 'var(--color-positive-text)' },
      { ratio: -0.25, days: 30, window: '30d' as const, start: '2026-07-16', priorStart: '2026-06-16', priorEnd: '2026-07-15', text: '↓ 25.0% vs prior 30d', color: 'var(--color-negative-text)' },
    ]
    for (const entry of cases) {
      const dto = performanceDto()
      const selected: GoogleAdsPerformanceDto = { ...dto, window: entry.window, days: entry.days, startDate: entry.start,
        comparison: { days: entry.days, prior: { startDate: entry.priorStart, endDate: entry.priorEnd, days: entry.days, totals: { ...EMPTY_TOTALS } }, change: { ...dto.comparison!.change, costMicros: entry.ratio, conversions: entry.ratio } } }
      const requested: string[] = []
      const mounted = renderSection(dto, requested, { [entry.window]: selected })
      try {
        await screen.findByText('$1,284.50')
        fireEvent.click(within(screen.getByRole('group', { name: 'Google Ads time period' })).getByRole('button', { name: entry.window }))
        await waitFor(() => expect(within(metricTile('Conversions')).getByText(entry.text)).toBeTruthy())
        const change = within(metricTile('Conversions')).getByText(entry.text)
        const spendChange = within(metricTile('Spend')).getByText(entry.text)
        const rules = parseCompiledCss(await compileAppStyles([...change.classList, ...spendChange.classList]))
        expect(compiledElementProperty(rules, change, 'color')).toBe(entry.color)
        expect(compiledElementProperty(rules, spendChange, 'color')).toBe('var(--color-text-muted)')
        expect(requested).toEqual(['/api/v1/projects/example/google-ads/performance?window=14d', `/api/v1/projects/example/google-ads/performance?window=${entry.window}`])
        expect(within(metricTile('Cost / conv.')).queryByText(/vs prior/)).toBeNull()
      } finally { mounted.dispose() }
    }
  })
})
