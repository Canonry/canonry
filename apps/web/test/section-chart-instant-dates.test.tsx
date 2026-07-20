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

import { BacklinksSection } from '../src/components/project/BacklinksSection.js'
import { TechnicalAeoSection } from '../src/components/project/TechnicalAeoSection.js'
import { formatChartDateLabel, formatChartDateTick } from '../src/components/shared/ChartPrimitives.js'
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

// ---------------------------------------------------------------- backlinks

function backlinkHistory() {
  return [
    { release: 'bing-2026-07-14', totalLinkingDomains: 10, totalHosts: 20, top10HostsShare: '0.5', queriedAt: EARLIER_INSTANT, source: 'bing-webmaster' },
    { release: 'bing-2026-07-20', totalLinkingDomains: 12, totalHosts: 25, top10HostsShare: '0.5', queriedAt: INSTANT, source: 'bing-webmaster' },
  ]
}

function installBacklinksApi() {
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]!
    if (path === '/api/v1/projects/test-project/backlinks/sources') {
      return jsonResponse({
        projectId: 'p1',
        targetDomain: 'example.com',
        anyConnected: true,
        anyData: true,
        sources: [
          { source: 'commoncrawl', connected: false, hasData: false, latestRelease: null, totalLinkingDomains: 0, lastSyncedAt: null },
          { source: 'bing-webmaster', connected: true, hasData: true, latestRelease: 'bing-2026-07-20', totalLinkingDomains: 12, lastSyncedAt: INSTANT },
        ],
      })
    }
    if (path === '/api/v1/backlinks/syncs/latest') return jsonResponse(null)
    if (path === '/api/v1/projects/test-project/runs') return jsonResponse([])
    if (path === '/api/v1/projects/test-project/backlinks/history') return jsonResponse(backlinkHistory())
    if (path === '/api/v1/projects/test-project/backlinks/summary') {
      return jsonResponse({
        projectId: 'p1',
        release: 'bing-2026-07-20',
        targetDomain: 'example.com',
        totalLinkingDomains: 12,
        totalHosts: 25,
        top10HostsShare: '0.5',
        queriedAt: INSTANT,
        source: 'bing-webmaster',
      })
    }
    if (path === '/api/v1/projects/test-project/backlinks/domains') {
      return jsonResponse({
        source: 'bing-webmaster',
        summary: null,
        total: 1,
        rows: [{ linkingDomain: 'linker.com', numHosts: 3 }],
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
}

test('the referring-domains chart dates a sync by when it ran, in the viewer timezone', async () => {
  installBacklinksApi()
  render(<BacklinksSection projectName="test-project" />)
  await waitFor(() => expect(captured.data.length).toBe(2))

  const dates = renderedDates()
  // 2026-07-20T01:52:51Z is the evening of July 19 in New York — the honest
  // local answer to "when did this sync run".
  expect(dates[1]).toEqual({ tick: '7/19', label: 'Jul 19, 2026' })
  expect(dates[0]).toEqual({ tick: '7/14', label: 'Jul 14, 2026' })

  // The committed behaviour: the UTC calendar day, one day ahead of the viewer.
  expect(dates[1]!.tick).not.toBe('7/20')
  expect(dates[1]!.label).not.toBe('Jul 20, 2026')
})

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
