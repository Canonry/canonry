/**
 * Dates on the section charts that plot a REAL INSTANT.
 *
 * The visibility-trend work split the chart date formatters in two: the
 * calendar formatters (`formatChartDate*`) never localize, the observed-instant
 * formatters (`formatObservedInstant*`) always do. Two charts were left on the
 * calendar formatters while feeding them genuine timestamps:
 *
 *   - BacklinksSection    → history `queriedAt`  (`deps.now().toISOString()`)
 *   - TechnicalAeoSection → trend point `auditedAt` (`new Date().toISOString()`)
 *
 * Both would print the UTC calendar day, so a viewer behind UTC saw tomorrow.
 * Site Health now also leads with the shared trend card, whose readings carry
 * the same moments as `observedAt`; the card must date them the same way.
 * Backlinks' card plots releases by crawl window, not by query time, so it has
 * no moment to localize (`backlinks-trend-card.test.tsx`).
 * The timezone here is pinned WEST of UTC for exactly that reason — under the
 * default UTC runner every assertion below passes trivially, which is why the
 * first test guards it.
 */
process.env.TZ = 'America/New_York'

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

// A sweep/audit that ran just after midnight UTC — the evening BEFORE for a
// New York viewer. This is the exact shape of the reported production case.
const INSTANT = '2026-07-20T01:52:51.000Z'
const EARLIER_INSTANT = '2026-07-14T09:00:00.000Z'

type Formatter = (value: unknown) => unknown

// Recharts is stubbed (jsdom has no layout), but unlike the other section tests
// this stub CAPTURES the formatters and the chart data instead of dropping
// them. The formatters are the whole subject of this file — a stub that renders
// `null` would let a wrong formatter pass unnoticed.
const captured: {
  data: Array<Record<string, unknown>>
  tickFormatters: Formatter[]
  labelFormatters: Formatter[]
} = { data: [], tickFormatters: [], labelFormatters: [] }

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const chart = ({ children, data }: { children?: React.ReactNode; data?: Array<Record<string, unknown>> }) => {
    if (data) captured.data = data
    return <div>{children}</div>
  }
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: chart,
    BarChart: chart,
    XAxis: ({ tickFormatter }: { tickFormatter?: Formatter }) => {
      if (tickFormatter) captured.tickFormatters.push(tickFormatter)
      return null
    },
    Tooltip: ({ labelFormatter }: { labelFormatter?: Formatter }) => {
      if (labelFormatter) captured.labelFormatters.push(labelFormatter)
      return null
    },
    YAxis: () => null,
    CartesianGrid: () => null,
    Legend: () => null,
    Line: () => null,
    Area: () => null,
    Bar: () => null,
    Cell: () => null,
    ReferenceArea: () => null,
    ReferenceLine: () => null,
  }
})

import type { TrendFigure, TrendsResponse } from '@canonry/canonry-contracts'
import { TechnicalAeoSection } from '../src/components/project/TechnicalAeoSection.js'
import { formatChartDateLabel, formatChartDateMonthDay, formatChartDateTick } from '../src/components/shared/ChartPrimitives.js'
import { mockFetch, jsonResponse, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  captured.data = []
  captured.tickFormatters = []
  captured.labelFormatters = []
})

test('the pinned timezone really is west of UTC (guards every assertion below)', () => {
  // If this fails the rest of the file proves nothing: the localized and the
  // UTC-calendar renderings would agree and a regression would stay invisible.
  expect(new Date(INSTANT).getUTCDate() - new Date(INSTANT).getDate()).toBe(1)
})

/** Every x value the chart plots, run through the formatters the chart wired up. */
function renderedDates(dateKey = 'date') {
  expect(captured.tickFormatters.length).toBeGreaterThan(0)
  expect(captured.labelFormatters.length).toBeGreaterThan(0)
  const tick = captured.tickFormatters[0]!
  const label = captured.labelFormatters[0]!
  return captured.data.map((row) => ({
    tick: tick(row[dateKey]),
    label: label(row[dateKey]),
  }))
}

// ------------------------------------------------------------- trend cards

// A first reading that ALSO ran just after midnight UTC, so the "since" date
// and the span start shift a day for this viewer as well.
const FIRST_INSTANT = '2026-07-14T02:00:00.000Z'

/** A trends read whose readings are moments, the way the API returns scans. */
function instantTrend(surface: TrendsResponse['surface'], groupKey: string, figures: Array<Pick<TrendFigure, 'key' | 'label' | 'unit' | 'better'> & { values: [number, number] }>): TrendsResponse {
  return {
    project: 'test-project',
    surface,
    window: 'all',
    startDate: '2026-07-14',
    endDate: '2026-07-20',
    groups: [{
      key: groupKey,
      label: groupKey,
      figures: figures.map(({ values: [from, to], ...figure }) => ({
        ...figure,
        value: to,
        asOf: '2026-07-20',
        change: { difference: to - from, ratio: from === 0 ? null : (to - from) / from, tone: to > from ? 'better' : 'neutral', basis: { type: 'first-in-window', date: '2026-07-14', observedAt: FIRST_INSTANT, label: null } },
        series: [{ date: '2026-07-14', observedAt: FIRST_INSTANT, label: null, value: from }, { date: '2026-07-20', observedAt: INSTANT, label: null, value: to }],
        recordedFrom: '2026-07-14',
      })),
    }],
  }
}

/** The card's dates for this viewer: the axis ticks, the chart's table rows and the span under the chart. */
async function trendCardDates(spanText: RegExp) {
  await waitFor(() => expect(captured.data.length).toBe(2))
  // Moments sit on a time scale, so uneven gaps between scans or releases keep their length.
  expect(captured.data.map((row) => [row.date, row.at])).toEqual([[FIRST_INSTANT, Date.parse(FIRST_INSTANT)], [INSTANT, Date.parse(INSTANT)]])
  const tick = captured.tickFormatters[0]!
  const rows = [...document.querySelectorAll('table tbody th[scope="row"]')].map((cell) => cell.textContent)
  return { ticks: captured.data.map((row) => tick(row.at)), rows, span: (await screen.findByText(spanText)).textContent }
}

// ----------------------------------------------------------- technical AEO

function installTechnicalAeoApi() {
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]!
    if (path === '/api/v1/projects/test-project/technical-aeo') {
      return jsonResponse({
        project: 'test-project',
        hasData: true,
        runId: 'run-2',
        runStatus: 'completed',
        sitemapUrl: 'https://example.com/sitemap.xml',
        auditedAt: INSTANT,
        aggregateScore: 72,
        pagesDiscovered: 10,
        pagesAudited: 10,
        pagesSkipped: 0,
        pagesErrored: 0,
        deltaScore: 4,
        trend: 'up',
        previousScore: 68,
        previousAuditedAt: EARLIER_INSTANT,
        factors: [],
        crossCuttingIssues: [],
        prioritizedFixes: [],
      })
    }
    if (path === '/api/v1/projects/test-project/technical-aeo/trend') {
      return jsonResponse({
        project: 'test-project',
        points: [
          { runId: 'run-1', auditedAt: EARLIER_INSTANT, aggregateScore: 68, pagesAudited: 10 },
          { runId: 'run-2', auditedAt: INSTANT, aggregateScore: 72, pagesAudited: 10 },
        ],
      })
    }
    if (path === '/api/v1/projects/test-project/technical-aeo/pages') {
      return jsonResponse({ project: 'test-project', runId: 'run-2', auditedAt: INSTANT, total: 0, pages: [] })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
}

test('the site-score trend dates an audit by when it ran, in the viewer timezone', async () => {
  installTechnicalAeoApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName="test-project" />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(captured.data.length).toBe(2))

  const dates = renderedDates()
  expect(dates[1]).toEqual({ tick: '7/19', label: 'Jul 19, 2026' })
  expect(dates[0]).toEqual({ tick: '7/14', label: 'Jul 14, 2026' })

  expect(dates[1]!.tick).not.toBe('7/20')
  expect(dates[1]!.label).not.toBe('Jul 20, 2026')
})

test('the Site Health trend card dates a scan by when it ran, in the viewer timezone', async () => {
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]!
    if (path === '/api/v1/projects/test-project/trends') {
      return jsonResponse(instantTrend('site-health', 'site-health', [
        { key: 'score', label: 'Site score', unit: 'score', better: 'higher', values: [68, 72] },
        { key: 'pages-checked', label: 'Pages checked', unit: 'count', better: 'neither', values: [10, 10] },
      ]))
    }
    if (path === '/api/v1/projects/test-project/technical-aeo') {
      return jsonResponse({
        project: 'test-project', hasData: true, runId: 'run-2', runStatus: 'completed', sitemapUrl: 'https://example.com/sitemap.xml',
        auditedAt: INSTANT, aggregateScore: 72, pagesDiscovered: 10, pagesAudited: 10, pagesSkipped: 0, pagesErrored: 0,
        deltaScore: 4, trend: 'up', previousScore: 68, previousAuditedAt: FIRST_INSTANT, factors: [], crossCuttingIssues: [], prioritizedFixes: [],
      })
    }
    if (path === '/api/v1/projects/test-project/technical-aeo/pages') {
      return jsonResponse({ project: 'test-project', runId: 'run-2', auditedAt: INSTANT, total: 0, pages: [] })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName="test-project" projectId="p1" integrated />
    </QueryClientProvider>,
  )

  expect(await trendCardDates(/^Jul 13 to Jul 19, 2026$/)).toEqual({
    ticks: ['7/13', '7/19'],
    rows: ['Jul 13, 2026', 'Jul 19, 2026'],
    span: 'Jul 13 to Jul 19, 2026',
  })
  expect(screen.getByText('since Jul 13')).not.toBeNull()
})

// ------------------------------------------------------- the date-only sites

test('a date-only value still renders unshifted through the calendar formatters', () => {
  // GbpSection (`timeseries[].date`, `freshness.dataThroughDate`) and
  // ActivitySection (GA4 `date`, normalized to YYYY-MM-DD in ga4-client) are
  // day stamps with no clock reading. They correctly stay on the calendar
  // formatters, and must NOT localize — pinned here so a later sweep of these
  // call sites can't quietly convert them.
  expect(formatChartDateLabel('2026-07-20')).toBe('Jul 20, 2026')
  expect(formatChartDateTick('2026-07-20')).toBe('7/20')
  expect(formatChartDateLabel('2026-01-01')).toBe('Jan 1, 2026')
  expect(formatChartDateTick('2026-01-01')).toBe('1/1')
})

test('a same-year range start drops only the year and stays unshifted', () => {
  // The results toolbar names a range year once ("Sep 1 to Sep 8, 2026"), so its
  // start reads the calendar prefix with no year and no viewer timezone.
  expect(formatChartDateMonthDay('2026-09-01')).toBe('Sep 1')
  expect(formatChartDateMonthDay('2026-01-01T23:30:00.000Z')).toBe('Jan 1')
  expect(formatChartDateMonthDay('not-a-date')).toBe('not-a-date')
})

test('the converted charts are the only remaining consumers of the raw axis value', async () => {
  // Belt-and-braces on the wiring: the tooltip label formatter must be the same
  // localizing one the tick formatter is, or the axis and the tooltip disagree
  // about which day a point is.
  installTechnicalAeoApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName="test-project" />
    </QueryClientProvider>,
  )
  await screen.findByText('Site score over time')
  const tick = captured.tickFormatters[0]!
  const label = captured.labelFormatters[0]!
  expect(tick(INSTANT)).toBe('7/19')
  expect(label(INSTANT)).toBe('Jul 19, 2026')
})
