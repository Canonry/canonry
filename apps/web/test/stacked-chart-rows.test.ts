import { describe, expect, it } from 'vitest'
import { BASELINE_DATA_KEY, buildStackedChartRows } from '../src/lib/stacked-chart-rows.js'

const series = {
  series: [
    { key: 'chatgpt', label: 'ChatGPT', sessions: 5 },
    { key: 'source:l.instagram.com', label: 'l.instagram.com', sessions: 2 },
  ],
  days: [
    { date: '2026-10-02', sessions: 4, values: { chatgpt: 3, 'source:l.instagram.com': 1 } },
    { date: '2026-10-03', sessions: 3, values: { chatgpt: 2, 'source:l.instagram.com': 1 } },
  ],
}

describe('buildStackedChartRows', () => {
  it('lays the API values out under index keys, so a dotted group key is never a property path', () => {
    const { rows, series: chartSeries } = buildStackedChartRows(series)
    expect(chartSeries).toEqual([
      { dataKey: 's0', key: 'chatgpt', label: 'ChatGPT' },
      { dataKey: 's1', key: 'source:l.instagram.com', label: 'l.instagram.com' },
    ])
    expect(rows).toEqual([
      { date: '2026-10-02', [BASELINE_DATA_KEY]: null, s0: 3, s1: 1 },
      { date: '2026-10-03', [BASELINE_DATA_KEY]: null, s0: 2, s1: 1 },
    ])
  })

  it('reads a synced baseline day with none of the stacked traffic as 0, and a day without a baseline as blank', () => {
    const { rows } = buildStackedChartRows(series, [
      { date: '2026-10-01', value: 120 },
      { date: '2026-10-02', value: 140 },
    ])
    expect(rows.map(row => [row.date, row[BASELINE_DATA_KEY], row.s0, row.s1])).toEqual([
      ['2026-10-01', 120, 0, 0],
      ['2026-10-02', 140, 3, 1],
      ['2026-10-03', null, 2, 1],
    ])
  })

  it('renders nothing from an API response that predates the series', () => {
    expect(buildStackedChartRows(undefined)).toEqual({ rows: [], series: [] })
  })
})
