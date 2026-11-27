import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TrendsResponse } from '@canonry/canonry-contracts'

// jsdom has no layout, so Recharts is stubbed; the axis tick formatter is kept
// so a test can read the labels the chart would print.
const ticks: { format?: (value: string) => string } = {}
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Line: () => null,
    CartesianGrid: () => null,
    XAxis: ({ tickFormatter }: { tickFormatter?: (value: string) => string }) => {
      ticks.format = tickFormatter
      return null
    },
    YAxis: () => null,
    Tooltip: () => null,
  }
})

import { BacklinksSection } from '../src/components/project/BacklinksSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

/** Two releases as the trends read returns them: dated by the window's last month, named by the window. */
function releaseTrend(): TrendsResponse {
  const reading = (date: string, label: string, value: number) => ({ date, observedAt: null, label, value })
  const figure = (key: string, label: string, unit: 'count' | 'fraction', from: number, to: number) => ({
    key, label, unit, better: unit === 'count' ? 'higher' as const : 'neither' as const, value: to, asOf: '2026-10-01',
    change: { difference: to - from, ratio: (to - from) / from, tone: unit === 'count' && to < from ? 'worse' as const : 'neutral' as const,
      basis: { type: 'first-in-window' as const, date: '2026-07-01', observedAt: null, label: 'May-Jul 2026' } },
    series: [reading('2026-07-01', 'May-Jul 2026', from), reading('2026-10-01', 'Aug-Oct 2026', to)],
    recordedFrom: '2026-07-01',
  })
  return {
    project: 'test-project', surface: 'backlinks', window: 'all', startDate: '2026-07-01', endDate: '2026-10-01',
    groups: [{ key: 'backlinks', label: 'Backlinks', figures: [
      figure('referring-domains', 'Referring domains', 'count', 19, 17),
      figure('hosts', 'Total linking hosts', 'count', 185, 93),
      figure('top-10-concentration', 'Top-10 concentration', 'fraction', 0.92973, 0.903226),
    ] }],
  }
}

test('the backlinks card names each release by its crawl window', async () => {
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]
    if (path === '/api/v1/backlinks/syncs/latest') return jsonResponse(null)
    if (path === '/api/v1/projects/test-project/runs') return jsonResponse([])
    if (path === '/api/v1/projects/test-project/trends') return jsonResponse(releaseTrend())
    if (path === '/api/v1/projects/test-project/backlinks/summary') return jsonResponse({
      projectId: 'p1', release: 'cc-main-2026-aug-sep-oct', targetDomain: 'example.com',
      totalLinkingDomains: 17, totalHosts: 93, top10HostsShare: '0.903226', queriedAt: '2026-10-26T06:06:36.303Z', source: 'commoncrawl',
    })
    if (path === '/api/v1/projects/test-project/backlinks/domains') return jsonResponse({
      source: 'commoncrawl', summary: null, total: 1, rows: [{ linkingDomain: 'linker.com', numHosts: 3 }],
    })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)

  render(<BacklinksSection projectName="test-project" />)

  const tab = await screen.findByRole('tab', { name: /^Referring domains/ })
  expect(tab.getAttribute('aria-label')).toBe('Referring domains 17, down 2 since May-Jul 2026, a decline')
  // The group names the release every change runs from, once.
  expect(screen.getByText('since May-Jul 2026')).toBeTruthy()
  expect(screen.getByText('May-Jul 2026 to Aug-Oct 2026')).toBeTruthy()
  // The axis and the chart's table name releases, never the day a window ends on.
  expect([ticks.format?.('2026-07-01'), ticks.format?.('2026-10-01')]).toEqual(['May-Jul 2026', 'Aug-Oct 2026'])
  const chartTable = screen.getByRole('table', { name: /^Referring domains per release/ })
  expect(within(chartTable).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['May-Jul 2026', 'Aug-Oct 2026'])
})
