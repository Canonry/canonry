import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CHART_SERIES_COLORS } from '../src/components/shared/ChartPrimitives.js'
import {
  LandingPageCell,
  ReportBarChart,
  ReportCard,
  ReportLineChart,
  ReportNote,
  ReportSection,
  ReportTableBlock,
  ReportTiles,
  ShareBars,
} from '../src/pages/ReportPage.js'
import { readReportOutline } from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))
afterEach(cleanup)

/**
 * The shared report helpers every agency section is built from. The outline
 * each one produces is what the parity suite compares against the HTML report,
 * so the hooks are asserted through that same reader.
 */

test('ReportSection writes the id and heading hooks, and its body reads in document order', () => {
  render(
    <ReportSection id="gsc" eyebrow="Section 6" title="GSC Performance" intro="Search demand signals.">
      <ReportTiles
        columns={4}
        tiles={[
          { label: 'Total clicks', value: '1.0K' },
          { label: 'Avg CTR', value: '20.0%', subtitle: <span className="text-positive-400">Up 8%</span> },
        ]}
      />
      <ReportTableBlock
        title="Top queries"
        tooltip="Queries ranked by clicks."
        headers={['Query', { label: 'Clicks', numeric: true, tooltip: 'Clicks in the window.' }]}
        footnote={<ReportNote>From Search Console.</ReportNote>}
      >
        <tr><td>rich brand</td><td>800</td></tr>
      </ReportTableBlock>
      <ReportCard title="Search queries you should track">
        <ReportNote>High-impression candidates to add to AEO tracking.</ReportNote>
      </ReportCard>
    </ReportSection>,
  )
  expect(readReportOutline(document.body)).toEqual({
    sections: [{
      id: 'gsc',
      eyebrow: 'Section 6',
      title: 'GSC Performance',
      intro: 'Search demand signals.',
      items: [
        { tile: 'Total clicks' },
        { tile: 'Avg CTR' },
        { heading: 'Top queries' },
        { note: 'Queries ranked by clicks.' },
        { table: ['Query', 'Clicks'] },
        { note: 'From Search Console.' },
        { heading: 'Search queries you should track' },
        { note: 'High-impression candidates to add to AEO tracking.' },
      ],
    }],
  })
  expect(document.getElementById('gsc')?.tagName).toBe('SECTION')
  expect(screen.getByText('Up 8%').className).toContain('text-positive-400')
  // The table sits alone in its own horizontal scroll container.
  const table = screen.getByRole('table')
  expect(table.parentElement?.className).toBe('evidence-table-wrap')
  expect(screen.getByRole('columnheader', { name: /Clicks/ }).className).toContain('text-right')
  // Tooltips are real buttons named by their words, placed beside the heading and header, never inside the h3.
  expect(screen.getByRole('button', { name: 'Queries ranked by clicks.' }).closest('h3')).toBeNull()
  expect(screen.getByRole('button', { name: 'Clicks in the window.' })).toBeTruthy()
})

test('ShareBars on the share scale sizes each bar by its share, drops empty rows, and draws nothing when none are left', () => {
  const { container, rerender } = render(
    <ShareBars
      title="Channel mix"
      scale="share"
      rows={[
        { label: 'Organic Search', count: 8000, sharePct: 67, color: CHART_SERIES_COLORS[0], valueLabel: '8.0K sessions · 67%' },
        { label: 'Direct', count: 0, sharePct: 0, color: CHART_SERIES_COLORS[1], valueLabel: '0 sessions · 0%' },
        { label: 'Referral', count: 5, sharePct: 140, color: CHART_SERIES_COLORS[2], valueLabel: '5 sessions · 140%' },
      ]}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Channel mix' })).toBeTruthy()
  expect(screen.queryByText('Direct')).toBeNull()
  expect(screen.getByText('8.0K sessions · 67%')).toBeTruthy()
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-share-bar]'), bar => bar.style.width)).toEqual(['67%', '100%'])

  rerender(<ShareBars title="Channel mix" scale="share" rows={[{ label: 'Direct', count: 0, sharePct: 0, color: CHART_SERIES_COLORS[0], valueLabel: '0 sessions · 0%' }]} />)
  expect(container.innerHTML).toBe('')
})

test('ShareBars on the max scale sizes bars against the largest count and draws nothing when every count is zero', () => {
  const { container, rerender } = render(
    <ShareBars
      title="By source type"
      scale="max"
      rows={[
        { label: 'Forums & Q&A', count: 5, sharePct: 50, color: CHART_SERIES_COLORS[1], valueLabel: '5 (50%)' },
        { label: 'News & Media', count: 2, sharePct: 20, color: CHART_SERIES_COLORS[1], valueLabel: '2 (20%)' },
      ]}
    />,
  )
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-share-bar]'), bar => bar.style.width)).toEqual(['100%', '40%'])

  rerender(<ShareBars title="By source type" scale="max" rows={[{ label: 'News & Media', count: 0, sharePct: 0, color: CHART_SERIES_COLORS[1], valueLabel: '0 (0%)' }]} />)
  expect(container.innerHTML).toBe('')
})

test('charts are named like the HTML report charts and draw nothing without data', () => {
  const { container, rerender } = render(
    <>
      <ReportLineChart title="Clicks over time" data={[{ date: '2026-04-01', clicks: 100 }]} xKey="date" dataKey="clicks" color={CHART_SERIES_COLORS[1]} />
      <ReportBarChart title="Provider citation rate" rows={[{ label: 'gemini', value: 50, color: CHART_SERIES_COLORS[0], valueLabel: '50% (1/2)' }]} domainMax={100} track />
    </>,
  )
  expect(screen.getByRole('img', { name: 'Clicks over time line chart' })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Provider citation rate bar chart' })).toBeTruthy()
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Clicks over time', 'Provider citation rate'])

  rerender(
    <>
      <ReportLineChart title="Clicks over time" data={[]} xKey="date" dataKey="clicks" color={CHART_SERIES_COLORS[1]} />
      <ReportBarChart title="Provider citation rate" rows={[]} />
    </>,
  )
  expect(container.innerHTML).toBe('')
})

test('LandingPageCell shows the path and names the tracking query, with the full URL as its title', () => {
  render(<LandingPageCell page="/pricing?gclid=abc&utm_source=x" />)
  expect(screen.getByText('/pricing')).toBeTruthy()
  expect(screen.getByText('Google Ad · 2 params').getAttribute('title')).toBe('/pricing?gclid=abc&utm_source=x')
  cleanup()
  render(<LandingPageCell page="" />)
  expect(screen.getByText('/')).toBeTruthy()
})
