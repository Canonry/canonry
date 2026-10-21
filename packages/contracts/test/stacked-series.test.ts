import { describe, expect, it } from 'vitest'
import { STACKED_SERIES_OTHER_KEY, buildStackedDailySeries } from '../src/stacked-series.js'

const point = (date: string, key: string, sessions: number) => ({ date, key, label: key.toUpperCase(), sessions })

describe('buildStackedDailySeries', () => {
  it('gives every series a value on every day, so each day stacks to its total', () => {
    // b and c are absent on some days; a chart drew those days as gaps and broke the stack.
    const result = buildStackedDailySeries([
      point('2026-10-01', 'a', 4), point('2026-10-01', 'b', 2), point('2026-10-01', 'c', 1),
      point('2026-10-02', 'a', 3),
      point('2026-10-03', 'b', 5),
    ], { limit: 5, otherLabel: 'Other' })

    expect(result.series.map(s => s.key)).toEqual(['a', 'b', 'c'])
    expect(result.days).toEqual([
      { date: '2026-10-01', sessions: 7, values: { a: 4, b: 2, c: 1 } },
      { date: '2026-10-02', sessions: 3, values: { a: 3, b: 0, c: 0 } },
      { date: '2026-10-03', sessions: 5, values: { a: 0, b: 5, c: 0 } },
    ])
    for (const day of result.days) {
      expect(Object.values(day.values).reduce((sum, v) => sum + v, 0)).toBe(day.sessions)
    }
  })

  it('folds groups past the limit into other without losing a session', () => {
    const result = buildStackedDailySeries([
      point('2026-10-01', 'a', 10), point('2026-10-01', 'b', 8), point('2026-10-01', 'c', 3),
      point('2026-10-02', 'd', 2), point('2026-10-02', 'a', 1),
    ], { limit: 2, otherLabel: 'Other' })

    expect(result.series).toEqual([
      { key: 'a', label: 'A', sessions: 11 },
      { key: 'b', label: 'B', sessions: 8 },
      { key: STACKED_SERIES_OTHER_KEY, label: 'Other', sessions: 5 },
    ])
    expect(result.otherCount).toBe(2)
    expect(result.days[0]!.values).toEqual({ a: 10, b: 8, other: 3 })
    expect(result.days[1]!.values).toEqual({ a: 1, b: 0, other: 2 })
    const seriesTotal = result.series.reduce((sum, s) => sum + s.sessions, 0)
    const dayTotal = result.days.reduce((sum, d) => sum + d.sessions, 0)
    expect(seriesTotal).toBe(24)
    expect(dayTotal).toBe(24)
  })

  it('keeps a single leftover group under its own name rather than renaming it other', () => {
    const result = buildStackedDailySeries([
      point('2026-10-01', 'a', 3), point('2026-10-01', 'b', 2), point('2026-10-01', 'c', 1),
    ], { limit: 2, otherLabel: 'Other' })
    expect(result.series.map(s => s.key)).toEqual(['a', 'b', 'c'])
    expect(result.otherCount).toBe(0)
  })

  it('ranks ties by label, sums repeated points and sorts days ascending', () => {
    const result = buildStackedDailySeries([
      point('2026-10-02', 'zeta', 2), point('2026-10-01', 'alpha', 1), point('2026-10-01', 'alpha', 1),
    ], { limit: 5, otherLabel: 'Other' })
    expect(result.series.map(s => s.key)).toEqual(['alpha', 'zeta'])
    expect(result.days.map(d => d.date)).toEqual(['2026-10-01', '2026-10-02'])
    expect(result.days[0]!.values.alpha).toBe(2)
  })

  it('returns no series and no days for no input', () => {
    expect(buildStackedDailySeries([], { limit: 5, otherLabel: 'Other' })).toEqual({ series: [], otherCount: 0, days: [] })
  })
})
