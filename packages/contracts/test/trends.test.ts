import { describe, expect, it } from 'vitest'
import { buildLevelTrendFigure, trendWindowSpan, type TrendReading } from '../src/trends.js'

const level = (readings: TrendReading[], span: { startDate: string; endDate: string } | null, better: 'higher' | 'lower' | 'neither' = 'higher') =>
  buildLevelTrendFigure({ key: 'indexed', label: 'Indexed', unit: 'count', better, readings, span })

describe('trendWindowSpan', () => {
  it('ends on the latest reading and reaches back the window length, counting both ends', () => {
    expect(trendWindowSpan(['2026-08-16', '2026-11-01', '2026-10-02'], '90d')).toEqual({ startDate: '2026-08-04', endDate: '2026-11-01' })
    expect(trendWindowSpan(['2026-11-01T09:30:00.000Z'], '7d')).toEqual({ startDate: '2026-10-26', endDate: '2026-11-01' })
  })

  it('starts all on the earliest reading and ignores dates that are not calendar dates', () => {
    expect(trendWindowSpan(['2026-10-02', 'not-a-date', '2026-02-30', '2026-08-16'], 'all')).toEqual({ startDate: '2026-08-16', endDate: '2026-10-02' })
  })

  it('names no span without a reading', () => {
    expect(trendWindowSpan([], '30d')).toBeNull()
    expect(trendWindowSpan(['garbage'], 'all')).toBeNull()
    expect(trendWindowSpan([], { startDate: '2026-03-01', endDate: '2026-03-31' })).toBeNull()
  })

  it('takes a caller\u2019s date range as the span, filling an open end from the readings', () => {
    const dates = ['2026-08-16', '2026-11-01']
    expect(trendWindowSpan(dates, { startDate: '2026-03-01', endDate: '2026-03-31' })).toEqual({ startDate: '2026-03-01', endDate: '2026-03-31' })
    expect(trendWindowSpan(dates, { startDate: '2026-09-01' })).toEqual({ startDate: '2026-09-01', endDate: '2026-11-01' })
    expect(trendWindowSpan(dates, { endDate: '2026-10-01' })).toEqual({ startDate: '2026-08-16', endDate: '2026-10-01' })
  })
})

describe('buildLevelTrendFigure', () => {
  const span = { startDate: '2026-08-04', endDate: '2026-11-01' }

  it('reads the latest value and changes it from the first reading inside the window, in the unit and as a ratio', () => {
    const figure = level([
      { date: '2026-07-01', value: 150 },
      { date: '2026-08-16', value: 215 },
      { date: '2026-10-01', value: 260 },
      { date: '2026-11-01', value: 289 },
    ], span)
    expect(figure).toEqual({
      key: 'indexed',
      label: 'Indexed',
      unit: 'count',
      better: 'higher',
      value: 289,
      asOf: '2026-11-01',
      // The ratio goes out at fraction wire precision: 74 / 215 = 0.344186046…
      change: { difference: 74, ratio: 0.34418605, tone: 'better', basis: { type: 'first-in-window', date: '2026-08-16', observedAt: null, label: null } },
      series: [
        { date: '2026-08-16', observedAt: null, label: null, value: 215 },
        { date: '2026-10-01', observedAt: null, label: null, value: 260 },
        { date: '2026-11-01', observedAt: null, label: null, value: 289 },
      ],
      // The first reading ever, outside the window, is when recording began.
      recordedFrom: '2026-07-01',
    })
  })

  it('colours the change by which direction is good news, and never for neither or no movement', () => {
    const falling = [{ date: '2026-08-16', value: 13 }, { date: '2026-11-01', value: 5 }]
    expect(level(falling, span, 'lower').change?.tone).toBe('better')
    expect(level(falling, span, 'higher').change?.tone).toBe('worse')
    expect(level(falling, span, 'neither').change?.tone).toBe('neutral')
    expect(level([{ date: '2026-08-16', value: 5 }, { date: '2026-11-01', value: 5 }], span, 'higher').change)
      .toEqual({ difference: 0, ratio: 0, tone: 'neutral', basis: { type: 'first-in-window', date: '2026-08-16', observedAt: null, label: null } })
  })

  it('moves a share in fractions at wire precision, without float noise', () => {
    const share = buildLevelTrendFigure({
      key: 'top-10-concentration', label: 'Top-10 concentration', unit: 'fraction', better: 'neither', span,
      readings: [{ date: '2026-08-16', value: 0.5 }, { date: '2026-11-01', value: 0.42 }],
    })
    // 0.42 - 0.5 is -0.07999999999999996 in floating point.
    expect(share.change).toMatchObject({ difference: -0.08, ratio: -0.16, tone: 'neutral' })
  })

  it('has no ratio from a zero basis and no change from a single reading', () => {
    expect(level([{ date: '2026-09-01', value: 0 }, { date: '2026-11-01', value: 4 }], span).change)
      .toEqual({ difference: 4, ratio: null, tone: 'better', basis: { type: 'first-in-window', date: '2026-09-01', observedAt: null, label: null } })
    const single = level([{ date: '2026-11-01', value: 43 }], span)
    expect(single.value).toBe(43)
    expect(single.change).toBeNull()
  })

  it('keeps the last of several readings on one date and drops missing or non-finite ones', () => {
    const figure = level([
      { date: '2026-10-01T08:00:00.000Z', value: 70 },
      { date: '2026-10-01T18:00:00.000Z', value: 72 },
      { date: '2026-10-15', value: null },
      { date: '2026-10-20', value: Number.NaN },
      { date: '2026-10-31', value: 75 },
    ], span)
    expect(figure.series).toEqual([{ date: '2026-10-01', observedAt: null, label: null, value: 72 }, { date: '2026-10-31', observedAt: null, label: null, value: 75 }])
    expect(figure.change?.difference).toBe(3)
  })

  it('keeps every reading taken at a moment, with its moment, and changes from the first one', () => {
    const figure = level([
      { date: '2026-10-01T18:00:00.000Z', observedAt: '2026-10-01T18:00:00.000Z', label: null, value: 72 },
      { date: '2026-10-01T08:00:00.000Z', observedAt: '2026-10-01T08:00:00.000Z', label: null, value: 70 },
      { date: '2026-10-20T01:52:51.000Z', observedAt: '2026-10-20T01:52:51.000Z', label: null, value: 75 },
    ], span)
    // Two scans on one UTC day are two readings, ordered by when they ran.
    expect(figure.series).toEqual([
      { date: '2026-10-01', observedAt: '2026-10-01T08:00:00.000Z', label: null, value: 70 },
      { date: '2026-10-01', observedAt: '2026-10-01T18:00:00.000Z', label: null, value: 72 },
      { date: '2026-10-20', observedAt: '2026-10-20T01:52:51.000Z', label: null, value: 75 },
    ])
    expect(figure.change).toEqual({ difference: 5, ratio: 0.07142857, tone: 'better', basis: { type: 'first-in-window', date: '2026-10-01', observedAt: '2026-10-01T08:00:00.000Z', label: null } })
  })

  it('carries a reading\u2019s label to its point and to the change it is measured from', () => {
    const figure = level([
      { date: '2026-09-01', label: 'Jul-Sep 2026', value: 18 },
      { date: '2026-10-01', label: 'Aug-Oct 2026', value: 17 },
    ], span)
    expect(figure.series.map(point => point.label)).toEqual(['Jul-Sep 2026', 'Aug-Oct 2026'])
    expect(figure.change?.basis).toEqual({ type: 'first-in-window', date: '2026-09-01', observedAt: null, label: 'Jul-Sep 2026' })
  })

  it('reports an empty window without inventing a value, while keeping when recording began', () => {
    const figure = level([{ date: '2026-06-01', value: 9 }], span)
    expect(figure).toMatchObject({ value: null, asOf: null, change: null, series: [], recordedFrom: '2026-06-01' })
    expect(level([], null)).toMatchObject({ value: null, change: null, series: [], recordedFrom: null })
  })
})
