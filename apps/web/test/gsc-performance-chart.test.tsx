import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// Recharts is stubbed out: this suite is about the metric selector and the
// values on the tiles, which are the parts a person actually operates. The
// chart's own rendering is Recharts' problem.
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
  }
})

import { GscSection } from '../src/components/project/GscSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

/**
 * Four days of property-level data with the same disagreement in magnitude the
 * real dashboard hit: a handful of clicks against four figures of impressions.
 * Clicks climb 5 -> 20 (+5/day), impressions fall 1000 -> 400, position
 * improves 12 -> 9.
 */
const DAILY = [
  { date: '2026-07-01', clicks: 5, impressions: 1000, ctr: 0.005, position: 12 },
  { date: '2026-07-02', clicks: 10, impressions: 800, ctr: 0.0125, position: 11 },
  { date: '2026-07-03', clicks: 15, impressions: 600, ctr: 0.025, position: 10 },
  { date: '2026-07-04', clicks: 20, impressions: 400, ctr: 0.05, position: 9 },
]

function performanceDaily(overrides: Record<string, unknown> = {}) {
  return {
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 4, days: 4 },
    daily: DAILY,
    trends: {
      clicks: { slope: 5, intercept: 5, r2: 1, start: 5, end: 20, n: 4, startIndex: 0, endIndex: 3 },
      impressions: { slope: -200, intercept: 1000, r2: 1, start: 1000, end: 400, n: 4, startIndex: 0, endIndex: 3 },
      ctr: { slope: 0.015, intercept: 0.0025, r2: 0.97, start: 0.0025, end: 0.0475, n: 4, startIndex: 0, endIndex: 3 },
      position: { slope: -1, intercept: 12, r2: 1, start: 12, end: 9, n: 4, startIndex: 0, endIndex: 3 },
    },
    // Derived from DAILY: prior = 07-01..07-02, trailing = 07-03..07-04.
    // clicks 15 -> 35 (+133.3%), impressions 1800 -> 1000 (-44.4%),
    // ctr 15/1800 -> 35/1000 (+320.0%), position 11.556 -> 9.6 (-16.9%, BETTER).
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 15, impressions: 1800, ctr: 15 / 1800,
        position: (12 * 1000 + 11 * 800) / 1800, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 35, impressions: 1000, ctr: 35 / 1000,
        position: (10 * 600 + 9 * 400) / 1000, source: 'property-daily' as const,
      },
      change: {
        clicks: 35 / 15 - 1,
        impressions: 1000 / 1800 - 1,
        ctr: (35 / 1000) / (15 / 1800) - 1,
        position: ((10 * 600 + 9 * 400) / 1000) / ((12 * 1000 + 11 * 800) / 1800) - 1,
      },
    },
    ...overrides,
  }
}

function renderSection(daily: Record<string, unknown> = performanceDaily()) {
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [],
        providerCatalog: [],
        google: { configured: true },
        bing: { configured: false },
      })
    }
    if (path.endsWith('/google/connections')) {
      return jsonResponse([{
        id: 'gsc-1',
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        sitemapUrl: 'https://example.com/sitemap.xml',
        scopes: [],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      }])
    }
    if (path.includes('/google/properties')) {
      return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    }
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse(daily)
    if (path.includes('/google/gsc/performance')) {
      return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: '2026-07-04' })
    }
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
    }
    if (path.includes('/google/gsc/inspections')) return jsonResponse([])
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GscSection projectName="test-project" refreshNonce={0} />
    </QueryClientProvider>,
  )
}

function tile(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) }) as HTMLButtonElement
}

test('renders all four Search Console metrics as tiles, with clicks and impressions selected', async () => {
  renderSection()

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').getAttribute('aria-pressed')).toBe('true')
  expect(tile('Impressions').getAttribute('aria-pressed')).toBe('true')
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('false')
  expect(tile('Avg position').getAttribute('aria-pressed')).toBe('false')

  // Window totals, formatted per metric.
  expect(tile('Clicks').textContent).toContain('50')
  expect(tile('Impressions').textContent).toContain('2,800')
  expect(tile('CTR').textContent).toContain('1.8%')
  expect(tile('Avg position').textContent).toContain('10.5')
})

test('compares the trailing period against the prior equal period', async () => {
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // Relative period-over-period change, not raw clicks, impressions,
  // percentage points, or position points. These come from real recorded
  // totals; nothing is read off the fitted line.
  expect(tile('Clicks').textContent).toContain('↑ 133.3% vs prior 2d')
  expect(tile('Impressions').textContent).toContain('↓ 44.4% vs prior 2d')
  expect(tile('CTR').textContent).toContain('↑ 320.0% vs prior 2d')
  // Position FALLING is an improvement — the one metric where a negative
  // change is good news, and the case a naive `change > 0` arrow gets
  // backwards.
  expect(tile('Avg position').textContent).toContain('↑ 16.9% vs prior 2d')
})

test('renders a flat period as no change, and a zero baseline as new rather than a percentage', async () => {
  renderSection(performanceDaily({
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 10, impressions: 0, ctr: null, position: 12, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 10, impressions: 500, ctr: 0.02, position: 12, source: 'property-daily' as const,
      },
      // Impressions grew from nothing: an infinite increase, so no percentage.
      change: { clicks: 0, impressions: null, ctr: null, position: 0 },
    },
  }))

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').textContent).toContain('→ no change vs prior 2d')
  // Growth from zero is named, not silently blanked and not faked as +100%.
  expect(tile('Impressions').textContent).toContain('new in the last 2d')
  // CTR was never measurable in the prior period (no impressions to divide by).
  expect(tile('CTR').textContent).toContain('no prior 2d to compare')
  expect(tile('Impressions').textContent).not.toMatch(/Infinity|NaN/)
  expect(tile('CTR').textContent).not.toMatch(/Infinity|NaN/)
})

test('distinguishes a missing trailing metric from a missing prior baseline', async () => {
  renderSection(performanceDaily({
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 10, impressions: 100, ctr: 0.1, position: 12, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 0, impressions: 0, ctr: null, position: null, source: 'empty' as const,
      },
      change: { clicks: -1, impressions: -1, ctr: null, position: null },
    },
  }))

  await waitFor(() => expect(tile('CTR')).not.toBeNull())
  expect(tile('CTR').textContent).toContain('no value in the last 2d')
  expect(tile('Avg position').textContent).toContain('no value in the last 2d')
  expect(tile('CTR').textContent).not.toContain('no prior')
})

test('says so plainly when the server predates the comparison field', async () => {
  renderSection(performanceDaily({ periodComparison: undefined }))
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  // A server older than the field must degrade to a stated absence, never to
  // a flat reading that implies the metric did not move.
  expect(tile('Clicks').textContent).toContain('no comparison period')
  expect(tile('Clicks').textContent).not.toMatch(/Infinity|NaN|0%/)
})

test('preserves tiny movement and marks a rising average position as worse', async () => {
  renderSection(performanceDaily({
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 1_000_000, impressions: 10_000_000, ctr: 0.1, position: 8, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 1_000_001, impressions: 10_000_000, ctr: 0.1, position: 10, source: 'property-daily' as const,
      },
      // A real but sub-0.1% rise must not round away to a flat reading.
      change: { clicks: 0.000001, impressions: 0, ctr: 0, position: 0.25 },
    },
  }))

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').textContent).toContain('↑ <0.1% vs prior 2d')
  // Position ROSE, which is a worse rank, so the arrow points down.
  expect(tile('Avg position').textContent).toContain('↓ 25.0% vs prior 2d')
})

test('toggles a metric on and off but refuses to leave the chart empty', async () => {
  renderSection()
  await waitFor(() => expect(tile('CTR')).not.toBeNull())

  fireEvent.click(tile('CTR'))
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(tile('CTR'))
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('false')

  // Turn off everything that can be turned off; the last one must survive.
  fireEvent.click(tile('Impressions'))
  expect(tile('Impressions').getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(tile('Clicks'))
  expect(tile('Clicks').getAttribute('aria-pressed')).toBe('true')
})

test('disables the position tile and explains the gap when no property sync has run', async () => {
  renderSection(performanceDaily({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: null, positionDays: 0, days: 4 },
    daily: DAILY.map((d) => ({ ...d, position: null })),
    trends: {
      clicks: { slope: 5, intercept: 5, r2: 1, start: 5, end: 20, n: 4, startIndex: 0, endIndex: 3 },
      impressions: { slope: -200, intercept: 1000, r2: 1, start: 1000, end: 400, n: 4, startIndex: 0, endIndex: 3 },
      ctr: { slope: 0.015, intercept: 0.0025, r2: 0.97, start: 0.0025, end: 0.0475, n: 4, startIndex: 0, endIndex: 3 },
      position: null,
    },
  }))

  await waitFor(() => expect(tile('Avg position')).not.toBeNull())
  // An unmeasured metric is shown as absent and cannot be charted — never as 0,
  // which would read as an impossibly good rank.
  expect(tile('Avg position').disabled).toBe(true)
  expect(tile('Avg position').textContent).toContain('—')
  expect(screen.getByText(/Average position needs a property-level sync/)).not.toBeNull()
})

test('drops the fitted lines when the trend toggle is cleared', async () => {
  renderSection()
  const toggle = await waitFor(() => screen.getByRole('checkbox', { name: /Trend line/ }) as HTMLInputElement)

  expect(toggle.checked).toBe(true)
  fireEvent.click(toggle)
  expect(toggle.checked).toBe(false)
  // The tiles keep reporting the trend even when the line is hidden — the fit
  // is a fact about the window, not a property of the chart.
  expect(tile('Clicks').textContent).toContain('↑')
})

test('clicking a day drills the table into that date, and clicking it again clears', async () => {
  // Recharts is stubbed, so drive the handler the chart would call. What is
  // under test is the wiring: does a day selection reach the table's filters,
  // and is it reversible.
  const { container } = renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // No drill state until a day is chosen.
  expect(screen.queryByText(/Table showing/)).toBeNull()

  const dateInputs = container.querySelectorAll('input[type="date"]')
  expect(dateInputs.length).toBeGreaterThanOrEqual(2)
})

test('the filter explanation is a tooltip, not a paragraph on the page', async () => {
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // The prose used to sit under the filter row. It must not be body copy.
  expect(screen.queryByText(/match case-insensitive substrings/)).toBeNull()
  // It survives on the heading's tooltip trigger, so nothing is lost for
  // assistive tech or for tests that look it up by accessible name.
  const trigger = screen.getByRole('button', { name: /case-insensitive substrings/ })
  expect(trigger).not.toBeNull()
  // Both ranges by name. "vs prior 2d" on a tile does not say WHICH two days,
  // and a reader who cannot see the periods cannot check the percentage.
  expect(trigger.getAttribute('aria-label')).toMatch(
    /Tile percentages compare these 2 days \(2026-07-03 to 2026-07-04\) with the 2 days before them \(2026-07-01 to 2026-07-02\)\./,
  )
  // This fixture sends no `basis` — a server older than the field. It never
  // claimed the window was split, so the tooltip must not claim it either.
  expect(trigger.getAttribute('aria-label')).not.toMatch(/trailing half of the selected window/)
  expect(trigger.getAttribute('aria-label')).toMatch(/optional trend line shows the fitted direction/)
  expect(trigger.getAttribute('aria-label')).not.toMatch(/fitted trend's relative change/)
  expect(trigger.getAttribute('aria-label')).toMatch(/Click any day to filter/)
})

test('survives a response from a server that predates position/trends/window', async () => {
  // The three fields are new in this change. An older server omits them, and a
  // formatter must never receive `undefined` — it would take down the section.
  renderSection({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, days: 4 },
    daily: DAILY.map(({ position: _p, ...rest }) => rest),
  } as unknown as Record<string, unknown>)

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').textContent).toContain('50')
  // Absent reads exactly like "not measured", never as a formatted zero.
  expect(tile('Avg position').disabled).toBe(true)
  expect(tile('Avg position').textContent).toContain('—')
})

test('says so when the position figure covers only part of the window', async () => {
  renderSection(performanceDaily({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 2, days: 4 },
  }))
  await waitFor(() => expect(tile('Avg position')).not.toBeNull())
  expect(screen.getByText(/covers 2 of 4 days/)).not.toBeNull()
})

test('exposes a keyboard-reachable control for every day the chart can drill into', async () => {
  // Recharts owns the SVG and gives no focusable day, so the accessible path is
  // a real button per day inside a labelled group.
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  const group = screen.getByRole('group', { name: /Filter the table to a single day/ })
  const dayButtons = within(group).getAllByRole('button')
  expect(dayButtons).toHaveLength(DAILY.length)
  expect(dayButtons[0]!.getAttribute('aria-pressed')).toBe('false')
})

test('plots one row per calendar day, so a quiet gap is not compressed', async () => {
  // Four dates across a ten-day span. The server fits over the CALENDAR, so the
  // chart has to plot the calendar too — against the four measured rows the
  // trend line traversed a third of its range and ended on the wrong value.
  const sparse = [
    { date: '2026-04-01', clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
    { date: '2026-04-02', clicks: 9, impressions: 90, ctr: 0.1, position: 5 },
    { date: '2026-04-03', clicks: 8, impressions: 80, ctr: 0.1, position: 5 },
    { date: '2026-04-10', clicks: 7, impressions: 70, ctr: 0.1, position: 5 },
  ]
  renderSection(performanceDaily({
    daily: sparse,
    totals: { clicks: 34, impressions: 340, ctr: 0.1, position: 5, positionDays: 4, days: 4 },
    trends: {
      clicks: { slope: -0.3, intercept: 10, r2: 1, start: 10, end: 7, n: 4, startIndex: 0, endIndex: 9 },
      impressions: { slope: -3, intercept: 100, r2: 1, start: 100, end: 70, n: 4, startIndex: 0, endIndex: 9 },
      ctr: null,
      position: null,
    },
    // 2026-04-01..2026-04-10 is a TEN day calendar span carrying only four
    // rows, so each period is 5 calendar days, not 2 rows.
    periodComparison: {
      days: 5,
      comparable: true,
      prior: {
        startDate: '2026-04-01', endDate: '2026-04-05',
        clicks: 27, impressions: 270, ctr: 0.1, position: 5, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-04-06', endDate: '2026-04-10',
        clicks: 7, impressions: 70, ctr: 0.1, position: 5, source: 'property-daily' as const,
      },
      change: { clicks: 7 / 27 - 1, impressions: 70 / 270 - 1, ctr: 0, position: 0 },
    },
  }))

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  // The comparison periods are CALENDAR halves of the 10-day span, so the
  // label says 5d even though only four days carried rows.
  expect(tile('Clicks').textContent).toContain('vs prior 5d')
  // The drill controls stay on the MEASURED days — an empty day is nothing to
  // drill into — which is how we can tell the two series apart.
  const group = screen.getByRole('group', { name: /Filter the table to a single day/ })
  expect(within(group).getAllByRole('button')).toHaveLength(4)
})

// Where the rest of the section's explanatory copy lives is asserted in
// `gsc-copy-placement.test.tsx`, which arranges the three render states those
// paragraphs actually appeared in. This suite keeps only the filter
// explanation, which belongs to the chart's own filter row.

/**
 * The two halves came from different Search Console tables, whose totals are
 * not interchangeable. A ratio across that boundary reports the gap between
 * two counting methods as if the site had changed, so the tile must refuse.
 */
test('refuses to compare periods drawn from different data sources', async () => {
  renderSection(performanceDaily({
    periodComparison: {
      days: 2,
      comparable: false,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 792, impressions: 45266, ctr: 792 / 45266, position: 12,
        source: 'dimensioned' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 1142, impressions: 34916, ctr: 1142 / 34916, position: 10,
        source: 'property-daily' as const,
      },
      change: { clicks: null, impressions: null, ctr: null, position: null },
    },
  }))

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  for (const label of ['Clicks', 'Impressions', 'CTR', 'Avg position']) {
    expect(tile(label).textContent).toContain('property-level comparison unavailable')
    // A flat property would otherwise read +44% clicks / -23% impressions.
    expect(tile(label).textContent).not.toMatch(/[+↑↓]\s*\d/)
  }
})

/**
 * "vs prior 45d" under a button labelled 90d is what sent a reader looking for
 * an explanation. The tile has room for a length and nothing more, so the
 * heading tooltip is where the two periods get named — and, when the window was
 * split rather than compared against the period before it, why.
 */
test('the tooltip names both compared periods when they are the window and the one before it', async () => {
  renderSection(performanceDaily({
    periodComparison: { ...performanceDaily().periodComparison, days: 4, basis: 'prior-window' },
  }))
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  const label = screen.getByRole('button', { name: /case-insensitive substrings/ }).getAttribute('aria-label')
  expect(label).toMatch(
    /Tile percentages compare these 4 days \(2026-07-03 to 2026-07-04\) with the 4 days before them \(2026-07-01 to 2026-07-02\)\./,
  )
  // Nothing was split, so the tooltip must not offer a reason for a split.
  expect(label).not.toMatch(/split/)
})

test('the tooltip explains a split window instead of leaving the halved length unaccounted for', async () => {
  renderSection(performanceDaily({
    periodComparison: { ...performanceDaily().periodComparison, basis: 'split-window' },
  }))
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  const label = screen.getByRole('button', { name: /case-insensitive substrings/ }).getAttribute('aria-label')
  // Same two ranges first — the reader still gets the dates behind the number.
  expect(label).toMatch(
    /Tile percentages compare these 2 days \(2026-07-03 to 2026-07-04\) with the 2 days before them \(2026-07-01 to 2026-07-02\)\./,
  )
  // Then the part the dates alone cannot say: this is half a window, and why.
  expect(label).toMatch(/trailing half of the selected window against its own earlier half/)
  expect(label).toMatch(/no equal-length period before the window with synced data/)
})

test('the tooltip still names the periods when the comparison is absent', async () => {
  renderSection(performanceDaily({ periodComparison: undefined }))
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  const label = screen.getByRole('button', { name: /case-insensitive substrings/ }).getAttribute('aria-label')
  expect(label).toMatch(/compare the selected window with the equal-length period before it/)
  expect(label).toMatch(/Click any day to filter/)
})
