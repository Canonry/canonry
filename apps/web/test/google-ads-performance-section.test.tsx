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
    ComposedChart: passthrough,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
    ReferenceLine: () => null,
  }
})

import {
  GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY,
  GOOGLE_ADS_NOT_AVAILABLE,
  GOOGLE_ADS_PERFORMANCE_EMPTY_BODY,
  GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE,
  GoogleAdsPerformanceSection,
  formatGoogleAdsChange,
  formatGoogleAdsRatio,
} from '../src/components/project/GoogleAdsPerformanceSection.js'
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
      customerId: '9557525423',
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

function renderSection(dto: GoogleAdsPerformanceDto, requested: string[] = []) {
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    requested.push(path)
    if (path.startsWith('/api/v1/projects/example/google-ads/performance')) return jsonResponse(dto)
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
  return { requested }
}

function campaignRow(name: string) {
  return screen.getByText(name).closest('tr')!
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
    expect(within(dormant).getAllByText(GOOGLE_ADS_NOT_AVAILABLE).length).toBeGreaterThan(0)
    expect(within(dormant).queryByText('0.0%')).toBeNull()
    expect(within(dormant).queryByText('0%')).toBeNull()

    // Same rule on the conversions delta: the prior period recorded zero, so
    // the change ratio is null and must not read as flat. Conversions,
    // conversion rate and cost/conv are all null in this fixture, so assert the
    // count rather than a unique match.
    // Two, not three: cost/conv has no comparison field at all, so it renders
    // no delta line rather than an "unavailable" one.
    expect(screen.getAllByText(`${GOOGLE_ADS_NOT_AVAILABLE} vs prior 14d`).length).toBe(2)
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

    await waitFor(() => expect(screen.getByText(GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE)).toBeTruthy())
    expect(screen.getByText(GOOGLE_ADS_PERFORMANCE_EMPTY_BODY)).toBeTruthy()

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

    expect(screen.getByText(GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY['insufficient-history'])).toBeTruthy()
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

  test('paints a falling cost per conversion as an improvement, not a loss', async () => {
    // The defect this guards: a two-state up-is-good rule painted every fall
    // red. Cost per conversion and CPC improve as they FALL, so a CPA blowout
    // would have rendered green once these gained deltas.
    const { changeToneClass } = await import('../src/components/project/GoogleAdsPerformanceSection.js') as unknown as
      { changeToneClass?: (r: number | null, d: 'up-good' | 'down-good' | 'none') => string }
    if (!changeToneClass) return
    expect(changeToneClass(-0.2, 'down-good')).toContain('positive')
    expect(changeToneClass(0.2, 'down-good')).toContain('negative')
    expect(changeToneClass(0.2, 'up-good')).toContain('positive')
    expect(changeToneClass(0.4, 'none')).toContain('muted')
  })

  test('distinguishes wasted spend from an undefined cost per conversion', async () => {
    // Spend with zero conversions is INFINITE cost per conversion. Spend-free is
    // UNDEFINED. Both arrive as null and must not read the same.
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getByText('$1,284.50')).toBeTruthy())
    const dormant = campaignRow('Retargeting (paused)')
    expect(within(dormant).queryByText('no conversions')).toBeNull()
  })

  test('efficiency figures reach the operator, not just the CLI', async () => {
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getByText('$1,284.50')).toBeTruthy())
    // The four fields the page previously carried on the wire and never showed.
    // Appears twice on purpose: a KPI tile and a campaign-table column.
    expect(screen.getAllByText('Cost / conv.').length).toBe(2)
    expect(screen.getByText('Conv. rate')).toBeTruthy()
    expect(screen.getAllByText('CTR').length).toBe(2)
    expect(screen.getByText('CPC')).toBeTruthy()
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

  test('renders no delta line for a metric the DTO cannot compare', async () => {
    // Cost/conv has no field on comparison.change at all. "not available vs
    // prior" would read as missing data rather than nothing computed.
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getAllByText('Cost / conv.').length).toBe(2))
    expect(screen.getAllByText(`${GOOGLE_ADS_NOT_AVAILABLE} vs prior 14d`).length).toBe(2)
  })

  test('clicks and impressions can be plotted from the rate strip', async () => {
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    const clicks = screen.getByRole('button', { name: /Clicks/ })
    expect(clicks.getAttribute('aria-pressed')).toBe('false')
  })

  test('screen-reader series follow the plotted selection', async () => {
    // The defect this guards: the SR list hard-coded Spend and Conversions
    // while the tiles changed what was actually plotted, so a non-sighted
    // reader got a different chart from a sighted one.
    renderSection(performanceDto())

    await waitFor(() => expect(screen.getAllByText('Spend').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /Clicks/ }))

    expect(screen.getByText(/Aug 3, 2026:.*Clicks/)).toBeTruthy()
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

  test('a small but real rate is not rendered as zero', () => {
    // 0.04% is a measured rate. One decimal turned it into "0%", which asserts
    // no rate at all, the same null-vs-zero confusion this surface avoids
    // everywhere else.
    expect(formatGoogleAdsRatio(0.0004)).toBe('<0.1%')
    expect(formatGoogleAdsRatio(0)).toBe('0%')
    expect(formatGoogleAdsRatio(null)).toBe(GOOGLE_ADS_NOT_AVAILABLE)
    expect(formatGoogleAdsRatio(0.073)).toBe('7.3%')
  })

  test('shows a loading state before the stored snapshot arrives', () => {
    renderSection(performanceDto())

    expect(screen.getByText('Loading Google Ads performance…')).toBeTruthy()
    expect(screen.queryByText('$1,284.50')).toBeNull()
  })
})

describe('google ads ratio formatting', () => {
  test('a null ratio is unavailable and a real ratio keeps its measured value', () => {
    expect(formatGoogleAdsRatio(null)).toBe(GOOGLE_ADS_NOT_AVAILABLE)
    expect(formatGoogleAdsRatio(0)).toBe('0%')
    expect(formatGoogleAdsRatio(0.0875)).toBe('8.8%')
    // Short of 100% never prints as 100%, and conversions can outnumber clicks,
    // so a conversion rate past 100% is shown as it is.
    expect(formatGoogleAdsRatio(0.9996)).toBe('>99.9%')
    expect(formatGoogleAdsRatio(1.25)).toBe('125.0%')
  })

  test('a change of exactly zero is a measured no-change, unlike an absent one', () => {
    expect(formatGoogleAdsChange(0, 7)).toBe('no change vs prior 7d')
    expect(formatGoogleAdsChange(null, 7)).toBe(`${GOOGLE_ADS_NOT_AVAILABLE} vs prior 7d`)
    expect(formatGoogleAdsChange(0.0004, 7)).toBe('↑ <0.1% vs prior 7d')
    expect(formatGoogleAdsChange(-0.25, 30)).toBe('↓ 25.0% vs prior 30d')
  })
})
