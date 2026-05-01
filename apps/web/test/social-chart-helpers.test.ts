import { describe, expect, test } from 'vitest'
import {
  SOCIAL_OTHER_KEY,
  SOCIAL_TOTAL_KEY,
  aggregateSocialChartData,
  decodeSocialSourceLabel,
  truncateLabel,
} from '../src/lib/social-chart-helpers.js'
import type { GA4SocialReferralHistoryEntry } from '../src/api.js'

function makeRow(
  date: string,
  source: string,
  sessions: number,
  medium = 'social',
  channelGroup = 'Organic Social',
  users = sessions,
): GA4SocialReferralHistoryEntry {
  return { date, source, medium, channelGroup, sessions, users }
}

describe('aggregateSocialChartData', () => {
  test('returns empty result for empty history', () => {
    const agg = aggregateSocialChartData([])
    expect(agg.data).toEqual([])
    expect(agg.sources).toEqual([])
    expect(agg.otherCount).toBe(0)
  })

  test('keeps all sources when count is within topN', () => {
    const history = [
      makeRow('2026-04-01', 'facebook.com', 10),
      makeRow('2026-04-01', 'x.com', 4),
      makeRow('2026-04-02', 'facebook.com', 6),
    ]
    const agg = aggregateSocialChartData(history, 6)
    expect(agg.sources).toEqual(['facebook.com', 'x.com'])
    expect(agg.otherCount).toBe(0)
    expect(agg.data).toEqual([
      { date: '2026-04-01', [SOCIAL_TOTAL_KEY]: 14, 'facebook.com': 10, 'x.com': 4 },
      { date: '2026-04-02', [SOCIAL_TOTAL_KEY]: 6, 'facebook.com': 6 },
    ])
  })

  test('sorts dates chronologically regardless of input order', () => {
    const history = [
      makeRow('2026-04-03', 'facebook.com', 1),
      makeRow('2026-04-01', 'facebook.com', 1),
      makeRow('2026-04-02', 'facebook.com', 1),
    ]
    const agg = aggregateSocialChartData(history)
    expect(agg.data.map((d) => d.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03'])
  })

  test('folds smaller sources into Other when count exceeds topN', () => {
    const history = [
      makeRow('2026-04-01', 'top1', 100),
      makeRow('2026-04-01', 'top2', 90),
      makeRow('2026-04-01', 'top3', 80),
      makeRow('2026-04-01', 'small1', 10),
      makeRow('2026-04-01', 'small2', 5),
      makeRow('2026-04-01', 'small3', 1),
    ]
    const agg = aggregateSocialChartData(history, 3)
    expect(agg.sources).toEqual(['top1', 'top2', 'top3', SOCIAL_OTHER_KEY])
    expect(agg.otherCount).toBe(3)
    const row = agg.data[0]!
    expect(row['top1']).toBe(100)
    expect(row['top2']).toBe(90)
    expect(row['top3']).toBe(80)
    expect(row[SOCIAL_OTHER_KEY]).toBe(16)
    expect(row[SOCIAL_TOTAL_KEY]).toBe(286)
    expect(row['small1']).toBeUndefined()
  })

  test('ranks by total sessions across the window, not per-day max', () => {
    // x has higher single-day spike but lower total than y.
    const history = [
      makeRow('2026-04-01', 'x', 50),
      makeRow('2026-04-02', 'y', 30),
      makeRow('2026-04-03', 'y', 30),
      makeRow('2026-04-04', 'y', 30),
    ]
    const agg = aggregateSocialChartData(history, 1)
    expect(agg.sources).toEqual(['y', SOCIAL_OTHER_KEY])
    expect(agg.otherCount).toBe(1)
  })

  test('break ties on equal totals by source name (deterministic)', () => {
    const history = [
      makeRow('2026-04-01', 'beta', 5),
      makeRow('2026-04-01', 'alpha', 5),
    ]
    const agg = aggregateSocialChartData(history, 1)
    expect(agg.sources).toEqual(['alpha', SOCIAL_OTHER_KEY])
  })

  test('Other count is zero when topN exactly equals source count', () => {
    const history = [
      makeRow('2026-04-01', 'a', 1),
      makeRow('2026-04-01', 'b', 1),
    ]
    const agg = aggregateSocialChartData(history, 2)
    expect(agg.sources).toEqual(['a', 'b'])
    expect(agg.otherCount).toBe(0)
    expect(agg.data[0]![SOCIAL_OTHER_KEY]).toBeUndefined()
  })

  test('Total equals sum of top sources plus Other for every date', () => {
    const history = [
      makeRow('2026-04-01', 'top', 100),
      makeRow('2026-04-01', 'mid', 50),
      makeRow('2026-04-01', 'low', 10),
      makeRow('2026-04-02', 'top', 80),
      makeRow('2026-04-02', 'low', 5),
    ]
    const agg = aggregateSocialChartData(history, 1)
    for (const row of agg.data) {
      const top = (row['top'] as number) ?? 0
      const other = (row[SOCIAL_OTHER_KEY] as number) ?? 0
      expect(top + other).toBe(row[SOCIAL_TOTAL_KEY])
    }
  })
})

describe('decodeSocialSourceLabel', () => {
  test('replaces + with space (UTM-encoded campaigns)', () => {
    expect(decodeSocialSourceLabel('HVAC+Facebook+Groups+Q1+2026')).toBe('HVAC Facebook Groups Q1 2026')
  })

  test('leaves non-+ characters intact', () => {
    expect(decodeSocialSourceLabel('m.facebook.com')).toBe('m.facebook.com')
    expect(decodeSocialSourceLabel('news|category')).toBe('news|category')
  })
})

describe('truncateLabel', () => {
  test('returns label unchanged when shorter than max', () => {
    expect(truncateLabel('short', 10)).toBe('short')
  })

  test('appends ellipsis when too long', () => {
    expect(truncateLabel('this is a long label', 10)).toBe('this is a…')
  })

  test('handles edge cases', () => {
    expect(truncateLabel('', 10)).toBe('')
    expect(truncateLabel('abc', 3)).toBe('abc')
    expect(truncateLabel('abcd', 3)).toBe('ab…')
  })
})
