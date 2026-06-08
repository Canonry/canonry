import { describe, it, expect } from 'vitest'
import type { BrandMetricsDto } from '@ainyc/canonry-contracts'
import {
  buildTrendRows,
  trendToTone,
  formatQueryChangeCaption,
  latestSeriesValue,
  CITED_KEY,
  MENTIONED_KEY,
} from '../src/lib/visibility-trend-helpers.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 0, total: 4, mentionRate, mentionedCount: 0 }
}

function bucket(date: string, byProvider: BrandMetricsDto['buckets'][number]['byProvider'], rates = { citationRate: 0.5, mentionRate: 0.25 }) {
  return {
    startDate: date,
    endDate: date,
    citationRate: rates.citationRate,
    cited: 2,
    total: 4,
    queryCount: 4,
    mentionRate: rates.mentionRate,
    mentionedCount: 1,
    byProvider,
  }
}

function dto(buckets: BrandMetricsDto['buckets']): BrandMetricsDto {
  return {
    window: 'all',
    buckets,
    overall: provider(0.5, 0.25),
    byProvider: {},
    trend: 'stable',
    mentionTrend: 'stable',
    queryChanges: [],
  }
}

describe('buildTrendRows — overall mode', () => {
  it('plots the single metric the toggle selects (cited / mentioned), 0-100', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1) }, { citationRate: 0.25, mentionRate: 0.1 }),
      bucket('2026-04-08', { gemini: provider(0.5, 0.4) }, { citationRate: 0.5, mentionRate: 0.4 }),
    ])

    const cited = buildTrendRows(d, 'cited', 'overall')
    expect(cited.series).toEqual([CITED_KEY])
    expect(cited.rows.map(r => r[CITED_KEY])).toEqual([25, 50])
    expect(cited.rows[0]![MENTIONED_KEY]).toBeUndefined()

    const mentioned = buildTrendRows(d, 'mentioned', 'overall')
    expect(mentioned.series).toEqual([MENTIONED_KEY])
    expect(mentioned.rows.map(r => r[MENTIONED_KEY])).toEqual([10, 40])
    expect(mentioned.rows[0]![CITED_KEY]).toBeUndefined()
  })

  it('rounds to one decimal place', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(1 / 3, 0) }, { citationRate: 1 / 3, mentionRate: 0 })])
    expect(buildTrendRows(d, 'cited', 'overall').rows[0]![CITED_KEY]).toBe(33.3)
  })
})

describe('buildTrendRows — byProvider mode', () => {
  it('returns the sorted union of providers across all buckets', () => {
    const d = dto([
      bucket('2026-04-01', { openai: provider(0.5, 0.5), gemini: provider(0.25, 0.25) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5), claude: provider(1, 1) }),
    ])
    expect(buildTrendRows(d, 'cited', 'byProvider').series).toEqual(['claude', 'gemini', 'openai'])
  })

  it('emits null for a provider absent from a bucket (so the line bridges the gap)', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.5, 0.5) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5), claude: provider(1, 1) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    expect(rows[0]!.claude).toBeNull()
    expect(rows[0]!.gemini).toBe(50)
    expect(rows[1]!.claude).toBe(100)
    expect(rows[1]!.gemini).toBe(75)
  })

  it('selects the mention rate when metric is mentioned', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(0.5, 0.2) })])
    expect(buildTrendRows(d, 'mentioned', 'byProvider').rows[0]!.gemini).toBe(20)
  })

  it('degrades to no provider lines when buckets omit byProvider (older backend ≤4.67.0)', () => {
    // A backend that predates the per-bucket breakdown returns buckets with no
    // `byProvider` key. The helper must not throw on Object.keys(undefined).
    const legacy = {
      window: 'all' as const,
      buckets: [
        { startDate: '2026-04-01', endDate: '2026-04-08', citationRate: 0.2, cited: 1, total: 5, queryCount: 5, mentionRate: 0.4, mentionedCount: 2 },
      ],
      overall: provider(0.2, 0.4),
      byProvider: {},
      trend: 'stable' as const,
      mentionTrend: 'stable' as const,
      queryChanges: [],
    } as unknown as BrandMetricsDto

    const res = buildTrendRows(legacy, 'cited', 'byProvider')
    expect(res.series).toEqual([])
    expect(res.hasData).toBe(true)
    expect(res.rows).toEqual([{ date: '2026-04-01' }])
  })
})

describe('buildTrendRows — data flags', () => {
  it('reports no data for empty buckets without throwing', () => {
    const res = buildTrendRows(dto([]), 'cited', 'overall')
    expect(res.rows).toEqual([])
    expect(res.hasData).toBe(false)
    expect(res.singleBucket).toBe(false)
  })

  it('flags a single bucket', () => {
    const res = buildTrendRows(dto([bucket('2026-04-01', { gemini: provider(0.5, 0.5) })]), 'cited', 'overall')
    expect(res.hasData).toBe(true)
    expect(res.singleBucket).toBe(true)
  })
})

describe('latestSeriesValue', () => {
  it('returns the most recent plotted value (right end of the line)', () => {
    const d = dto([
      bucket('2026-04-01', { gemini: provider(0.25, 0.1), openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    // gemini is in both buckets → its latest cited value is bucket 2 (75).
    expect(latestSeriesValue(rows, 'gemini')).toBe(75)
  })

  it('skips trailing nulls so the value matches the visible line end', () => {
    const d = dto([
      bucket('2026-04-01', { openai: provider(0.5, 0.4) }),
      bucket('2026-04-08', { gemini: provider(0.75, 0.5) }),
    ])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    // openai only has data in bucket 1; bucket 2 is null. Latest = 50, not null.
    expect(latestSeriesValue(rows, 'openai')).toBe(50)
  })

  it('returns null for a series that never appears', () => {
    const d = dto([bucket('2026-04-01', { gemini: provider(0.5, 0.5) })])
    const { rows } = buildTrendRows(d, 'cited', 'byProvider')
    expect(latestSeriesValue(rows, 'claude')).toBeNull()
  })

  it('returns null for empty rows', () => {
    expect(latestSeriesValue([], 'gemini')).toBeNull()
  })
})

describe('trendToTone', () => {
  it('maps direction to tone', () => {
    expect(trendToTone('improving')).toBe('positive')
    expect(trendToTone('declining')).toBe('negative')
    expect(trendToTone('stable')).toBe('neutral')
  })
})

describe('formatQueryChangeCaption', () => {
  it('returns null when there are no changes', () => {
    expect(formatQueryChangeCaption([])).toBeNull()
  })

  it('formats a single change with a signed delta and MM/DD date', () => {
    expect(formatQueryChangeCaption([{ date: '2026-03-17', delta: 7, label: '+7 kp' }]))
      .toBe('Query set changed: +7 on 03/17')
  })

  it('lists two changes inline (MM/DD)', () => {
    const caption = formatQueryChangeCaption([
      { date: '2026-04-03', delta: 2, label: '+2 kp' },
      { date: '2026-05-01', delta: 3, label: '+3 kp' },
    ])
    expect(caption).toBe('Query set changed: +2 on 04/03, +3 on 05/01')
  })

  it('collapses three or more changes into a count + the most recent', () => {
    const caption = formatQueryChangeCaption([
      { date: '2026-04-03', delta: 2, label: '+2 kp' },
      { date: '2026-05-01', delta: 3, label: '+3 kp' },
      { date: '2026-05-17', delta: 1, label: '+1 kp' },
    ])
    expect(caption).toBe('Query set changed 3 times (latest +1 on 05/17)')
  })

  it('renders a negative delta (queries removed)', () => {
    expect(formatQueryChangeCaption([{ date: '2026-06-02', delta: -4, label: '-4 kp' }]))
      .toBe('Query set changed: -4 on 06/02')
  })
})
