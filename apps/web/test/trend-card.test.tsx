import React, { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TrendFigure } from '@canonry/canonry-contracts'

afterEach(cleanup)

// jsdom has no layout, so Recharts is stubbed. The chart's rows are kept on the
// stub so a test can see what would be drawn.
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
      <div data-testid="trend-chart" data-rows={JSON.stringify(data ?? [])}>{children}</div>
    ),
    Line: ({ dataKey }: { dataKey?: string }) => <div data-testid={`line-${dataKey}`} />,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  }
})

import {
  TrendCard,
  describeTrendChange,
  levelTrendChange,
  sharedLevelBasis,
  trendSpanLabel,
  type TrendCardFigure,
  type TrendCardGroup,
} from '../src/components/shared/TrendCard.js'

const days = (values: Array<number | null>) => values.map((current, index) => ({ date: `2026-10-0${index + 1}`, current }))

function figures(): TrendCardFigure[] {
  return [
    { key: 'sessions', label: 'Sessions', value: '4.5K', spokenValue: '4,512', series: days([10, 12, 15]),
      change: { kind: 'delta', amount: '6.4%', direction: 'up', tone: 'better', basis: 'vs prior 30 days' } },
    // Position: a smaller number is a better rank, so falling is good news.
    { key: 'position', label: 'Avg. position', value: '8.1', series: days([9.3, 8.7, 8.1]),
      change: { kind: 'delta', amount: '1.2', direction: 'down', tone: 'better', basis: 'vs prior 30 days' } },
    { key: 'bounce', label: 'Bounce rate', value: '41%', series: days([0.3, 0.35, 0.41]),
      change: { kind: 'delta', amount: '4.0 pts', direction: 'up', tone: 'worse', basis: 'vs prior 30 days' } },
    // One reading is a number, not a trend: there is nothing to chart.
    { key: 'pages', label: 'Pages', value: '12', series: days([12]), change: { kind: 'note', text: 'No earlier data' } },
  ]
}

function SingleCard({ groups, initial = 'sessions', withPrevious = false }: { groups: TrendCardGroup[]; initial?: string; withPrevious?: boolean }) {
  const [selected, setSelected] = useState(initial)
  return (
    <TrendCard
      name="Site traffic figures"
      groups={groups}
      selected={[selected]}
      onSelect={setSelected}
      span="Oct 1 to Oct 3, 2026"
      currentLabel="Last 3 days"
      previous={withPrevious ? { label: 'Previous period', available: true } : undefined}
      emptyChartMessage="Nothing to chart yet."
    />
  )
}

describe('TrendCard, one figure charted at a time', () => {
  test('a figure with two or more readings is a tab; beside tabs a single reading is an unavailable tab', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: figures() }]} />)

    // A tab list holds tabs only, so the plain number sits in it as a tab that cannot be chosen.
    const tabs = within(screen.getByRole('tablist', { name: 'Site traffic figures' })).getAllByRole('tab')
    expect(tabs.map(tab => [tab.getAttribute('aria-label'), tab.getAttribute('aria-disabled')])).toEqual([
      ['Sessions 4,512, up 6.4% vs prior 30 days, an improvement', null],
      // The arrow follows the number; the words say whether that is good news.
      ['Avg. position 8.1, down 1.2 vs prior 30 days, an improvement', null],
      ['Bounce rate 41%, up 4.0 pts vs prior 30 days, a decline', null],
      ['Pages 12, no earlier data', 'true'],
    ])
    fireEvent.click(tabs[3]!)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[3]!.getAttribute('aria-selected')).toBe('false')
  })

  test('a group of single readings is a plain list of numbers', () => {
    render(<SingleCard groups={[{ key: 'plain', figures: figures().slice(3) }]} initial="pages" />)

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText('Pages').closest('dt')?.nextElementSibling?.textContent).toContain('12')
    expect(screen.getByText('Nothing to chart yet.')).toBeTruthy()
  })

  test('selection moves with the arrow keys and only the selected tab is in the tab order', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: figures() }]} />)

    const tab = (name: RegExp) => screen.getByRole('tab', { name })
    expect(tab(/^Sessions/).getAttribute('aria-selected')).toBe('true')
    expect(tab(/^Sessions/).tabIndex).toBe(0)
    expect(tab(/^Avg\. position/).tabIndex).toBe(-1)

    fireEvent.keyDown(tab(/^Sessions/), { key: 'ArrowRight' })
    expect(tab(/^Avg\. position/).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(/^Avg\. position/))
    // Wraps from the first tab to the last and skips the plain figure.
    fireEvent.keyDown(tab(/^Avg\. position/), { key: 'ArrowLeft' })
    fireEvent.keyDown(tab(/^Sessions/), { key: 'ArrowLeft' })
    expect(tab(/^Bounce rate/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/^Bounce rate/), { key: 'Home' })
    expect(tab(/^Sessions/).getAttribute('aria-selected')).toBe('true')

    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab(/^Sessions/).id)
  })

  test('a selection that cannot chart leaves the first chartable tab reachable by Tab', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: figures() }]} initial="pages" />)

    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1])
  })

  test('colours a change by its tone, never by its direction', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: figures() }]} />)

    const amount = (text: string) => screen.getByText(text).closest('span')!
    expect(amount('6.4%').className).toContain('text-positive')
    // Down is good news for a rank.
    expect(amount('1.2').className).toContain('text-positive')
    expect(amount('4.0 pts').className).toContain('text-negative')
  })

  test('a group says its comparison once, in its header, instead of under every figure', () => {
    render(<SingleCard groups={[{ key: 'traffic', label: 'Google search', basis: 'vs prior 30 days', figures: figures().slice(0, 2) }]} />)

    expect(screen.getAllByText('vs prior 30 days')).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'Google search' })).toBeTruthy()
  })

  test('charts the selected figure and lists its readings for a screen reader', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: figures() }]} />)

    expect(JSON.parse(screen.getByTestId('trend-chart').getAttribute('data-rows')!)).toEqual(days([10, 12, 15]))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Oct 1, 2026', 'Oct 2, 2026', 'Oct 3, 2026'])
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Sessions per day, last 3 days')
    expect(screen.getByText('Oct 1 to Oct 3, 2026')).toBeTruthy()
  })

  test('a day reads in full in the table even when the axis abbreviates', () => {
    const sessions: TrendCardFigure = {
      key: 'sessions', label: 'Sessions', value: '4.5K', series: [{ date: '2026-10-01', current: 4512 }, { date: '2026-10-02', current: 3900 }],
      formatValue: value => `${(value / 1000).toFixed(1)}K`, formatExact: value => value.toLocaleString('en-US'),
    }
    render(<SingleCard groups={[{ key: 'traffic', figures: [sessions] }]} />)

    expect(within(screen.getByRole('table')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['4,512', '3,900'])
  })

  test('a hidden current line comes back when the figure has nothing to compare against', () => {
    const withPrevious: TrendCardFigure = { key: 'sessions', label: 'Sessions', value: '9', series: [{ date: '2026-10-01', current: 4, previous: 3 }, { date: '2026-10-02', current: 5, previous: 4 }] }
    const withoutPrevious: TrendCardFigure = { key: 'users', label: 'Users', value: '7', series: [{ date: '2026-10-01', current: 3, previous: null }, { date: '2026-10-02', current: 4, previous: null }] }
    render(<SingleCard groups={[{ key: 'traffic', figures: [withPrevious, withoutPrevious] }]} withPrevious />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Last 3 days' }))
    expect(screen.queryByTestId('line-current')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Users/ }))
    // With no earlier period the current line is the chart: drawn, checked and locked on.
    expect(screen.getByTestId('line-current')).toBeTruthy()
    const current = screen.getByRole('checkbox', { name: 'Last 3 days' }) as HTMLInputElement
    expect([current.checked, current.disabled]).toEqual([true, true])
  })

  test('the previous period still charts when the current one has no readings', () => {
    const lapsed: TrendCardFigure = { key: 'sessions', label: 'Sessions', value: '\u2014', interactive: true, series: [{ date: '2026-10-01', current: null, previous: 40 }, { date: '2026-10-02', current: null, previous: 42 }] }
    render(<SingleCard groups={[{ key: 'traffic', figures: [lapsed] }]} withPrevious />)

    expect(screen.queryByText('Nothing to chart yet.')).toBeNull()
    expect(screen.getByTestId('line-previous')).toBeTruthy()
  })

  test('readings that carry a label are named by it, as Common Crawl releases are', () => {
    const domains: TrendCardFigure = {
      key: 'referring-domains', label: 'Referring domains', value: '17',
      series: [{ date: '2026-07-01', current: 19, label: 'May-Jul 2026' }, { date: '2026-10-01', current: 17, label: 'Aug-Oct 2026' }],
    }
    render(<SingleCard groups={[{ key: 'backlinks', figures: [domains] }]} initial="referring-domains" />)

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Release' })).toBeTruthy()
    expect(within(table).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['May-Jul 2026', 'Aug-Oct 2026'])
    expect(trendSpanLabel({ date: '2026-07-01', label: 'May-Jul 2026' }, { date: '2026-10-01', label: 'Aug-Oct 2026' })).toBe('May-Jul 2026 to Aug-Oct 2026')
  })

  test('says what is missing when the selected figure has nothing to draw', () => {
    render(<SingleCard groups={[{ key: 'traffic', figures: [{ key: 'sessions', label: 'Sessions', value: '0', series: [], interactive: true }] }]} />)

    expect(screen.queryByTestId('trend-chart')).toBeNull()
    expect(screen.getByText('Nothing to chart yet.')).toBeTruthy()
  })
})

describe('TrendCard, several figures compared', () => {
  test('figures are toggles and the chart is the caller’s', () => {
    const onSelect = vi.fn()
    render(
      <TrendCard
        name="Search performance figures"
        mode="compare"
        groups={[{ key: 'search', figures: [
          { key: 'clicks', label: 'Clicks', value: '320', color: 'var(--chart-series-1)', interactive: true },
          { key: 'position', label: 'Avg. position', value: '—', color: 'var(--chart-series-2)', interactive: true, disabled: true },
        ] }]}
        selected={['clicks']}
        onSelect={onSelect}
        chart={<div data-testid="caller-chart" />}
      />,
    )

    const clicks = screen.getByRole('button', { name: /^Clicks/ })
    expect(clicks.getAttribute('aria-pressed')).toBe('true')
    // An unmeasured figure cannot be charted, so its toggle is off and disabled.
    const position = screen.getByRole('button', { name: /^Avg\. position/ })
    expect(position.getAttribute('aria-pressed')).toBe('false')
    expect(position.hasAttribute('disabled')).toBe(true)
    fireEvent.click(clicks)
    expect(onSelect).toHaveBeenCalledWith('clicks')
    expect(screen.getByTestId('caller-chart')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})

describe('trend card helpers', () => {
  const level = (overrides: Partial<TrendFigure>): TrendFigure => ({
    key: 'indexed', label: 'Indexed', unit: 'count', better: 'higher', value: 289, asOf: '2026-11-01',
    change: { difference: 74, ratio: 74 / 215, tone: 'better', basis: { type: 'first-in-window', date: '2026-08-16', observedAt: null, label: null } },
    series: [{ date: '2026-08-16', observedAt: null, label: null, value: 215 }, { date: '2026-11-01', observedAt: null, label: null, value: 289 }],
    recordedFrom: '2026-07-01',
    ...overrides,
  })

  test('a stored level changes in its own unit, from the first reading in the window', () => {
    expect(levelTrendChange(level({}).change, 'count')).toEqual({ kind: 'delta', amount: '74', direction: 'up', tone: 'better', basis: 'since Aug 16' })
    // A share moves in points, never as a ratio of a ratio.
    expect(levelTrendChange({ difference: -0.08, ratio: -0.16, tone: 'neutral', basis: { type: 'first-in-window', date: '2026-07-02', observedAt: null, label: null } }, 'fraction'))
      .toEqual({ kind: 'delta', amount: '8.0 pts', direction: 'down', tone: 'neutral', basis: 'since Jul 2' })
    expect(levelTrendChange({ difference: 0, ratio: 0, tone: 'neutral', basis: { type: 'first-in-window', date: '2026-07-02', observedAt: null, label: null } }, 'score'))
      .toEqual({ kind: 'delta', amount: '0', direction: 'flat', tone: 'neutral', basis: 'since Jul 2' })
    expect(levelTrendChange(null, 'count')).toBeUndefined()
    // A labelled basis is named by its label.
    expect(levelTrendChange({ difference: -2, ratio: -0.10526316, tone: 'worse', basis: { type: 'first-in-window', date: '2026-07-01', observedAt: null, label: 'May-Jul 2026' } }, 'count'))
      .toMatchObject({ basis: 'since May-Jul 2026' })
  })

  test('a group shares a basis only when every change is measured from the same day', () => {
    expect(sharedLevelBasis([level({}), level({ key: 'not-indexed' })])).toBe('since Aug 16')
    expect(sharedLevelBasis([level({}), level({ key: 'later', change: { ...level({}).change!, basis: { type: 'first-in-window', date: '2026-09-01', observedAt: null, label: null } } })])).toBeUndefined()
    expect(sharedLevelBasis([level({ change: null })])).toBeUndefined()
  })

  test('a span that crosses a year names both years', () => {
    // The same-year span ("Jul 13 to Jul 19, 2026") is pinned where the cards render it.
    expect(trendSpanLabel({ date: '2025-12-20' }, { date: '2026-01-05' })).toBe('Dec 20, 2025 to Jan 5, 2026')
  })

  test('no change and a note read as words too', () => {
    expect(describeTrendChange({ kind: 'delta', amount: '0', direction: 'flat', tone: 'neutral', basis: 'since Jul 2' })).toBe('no change since Jul 2')
    expect(describeTrendChange({ kind: 'note', text: 'No prior 30 days to compare' })).toBe('no prior 30 days to compare')
  })
})
