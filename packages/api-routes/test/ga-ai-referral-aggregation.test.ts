import { describe, it, expect } from 'vitest'
import {
  buildAiReferralDailySeries,
  resolveWinningDimensions,
  summarizeAiReferralCounts,
} from '../src/ga-ai-referral-aggregation.js'
import type { AiReferralAggregationRow } from '../src/ga-ai-referral-aggregation.js'

const DIMENSIONS = ['session', 'first_user', 'manual_utm'] as const

/**
 * The real stored shape: one row per landing page, every row worth exactly 1
 * session, repeated identically across the three attribution dimensions. A day
 * with 35 sessions is 35 rows x 3 dimensions = 105 stored rows.
 */
function landingPageRows(input: {
  date: string
  source: string
  pages: number
  medium?: string
  trafficClass?: string
  channelGroup?: string
  dimensions?: readonly string[]
}): AiReferralAggregationRow[] {
  const rows: AiReferralAggregationRow[] = []
  for (const sourceDimension of input.dimensions ?? DIMENSIONS) {
    for (let page = 0; page < input.pages; page++) {
      rows.push({
        date: input.date,
        source: input.source,
        medium: input.medium ?? 'referral',
        trafficClass: input.trafficClass ?? 'organic',
        sourceDimension,
        channelGroup: input.channelGroup ?? 'Referral',
        sessions: 1,
      })
    }
  }
  return rows
}

describe('resolveWinningDimensions', () => {
  it('sums landing pages inside one dimension and never across dimensions', () => {
    const rows = landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 35 })
    expect(rows).toHaveLength(105)

    const winners = resolveWinningDimensions(rows)

    expect(winners).toHaveLength(1)
    expect(winners[0]!.organicSessions).toBe(35)
    expect(winners[0]!.paidSessions).toBe(0)
  })

  it('keeps the dimension reporting the most sessions when the lenses disagree', () => {
    const rows = [
      ...landingPageRows({ date: '2026-07-20', source: 'chatgpt', pages: 4, dimensions: ['session'] }),
      ...landingPageRows({ date: '2026-07-20', source: 'chatgpt', pages: 9, dimensions: ['first_user'] }),
    ]

    const winners = resolveWinningDimensions(rows)

    expect(winners).toHaveLength(1)
    // 9, the winning lens. Not 4 (the other lens), not 13 (their sum).
    expect(winners[0]!.organicSessions).toBe(9)
  })

  it('partitions the winning dimension by traffic class without letting class split the tuple', () => {
    const rows = [
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 20, trafficClass: 'paid', dimensions: ['session'] }),
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 15, trafficClass: 'organic', dimensions: ['session'] }),
      // A different lens saw the same visits as entirely organic.
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 30, trafficClass: 'organic', dimensions: ['first_user'] }),
    ]

    const winners = resolveWinningDimensions(rows)

    expect(winners).toHaveLength(1)
    // The session lens wins on 35 vs 30, and its classes partition that 35.
    expect(winners[0]!.paidSessions).toBe(20)
    expect(winners[0]!.organicSessions).toBe(15)
    expect(winners[0]!.paidSessions + winners[0]!.organicSessions).toBe(35)
  })
})

describe('buildAiReferralDailySeries', () => {
  it('reports the real per-date session count for a triplicated landing-page day', () => {
    const rows = landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 35 })

    const series = buildAiReferralDailySeries(rows)

    expect(series.days).toHaveLength(1)
    expect(series.days[0]!.date).toBe('2026-07-26')
    // 35 real sessions. NOT 1 (collapsing every landing page with MAX) and NOT
    // 105 (summing the three overlapping attribution lenses).
    expect(series.days[0]!.sessions).toBe(35)
    expect(series.days[0]!.sessions).not.toBe(1)
    expect(series.days[0]!.sessions).not.toBe(105)
    expect(series.days[0]!.bySource).toEqual([
      { source: 'chatgpt', sessions: 35, paidSessions: 0, organicSessions: 35 },
    ])
    expect(series.totalSessions).toBe(35)
  })

  it('reports each date of a multi-day window at its own real total', () => {
    const rows = [
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 35 }),
      ...landingPageRows({ date: '2026-07-25', source: 'chatgpt', pages: 18 }),
      // A date present in ONE dimension only. There is no other lens to beat,
      // so the single lens is the winner and its landing pages still sum.
      ...landingPageRows({ date: '2026-07-23', source: 'chatgpt', pages: 1, dimensions: ['session'] }),
    ]

    const series = buildAiReferralDailySeries(rows)

    expect(series.days.map((d) => [d.date, d.sessions])).toEqual([
      ['2026-07-23', 1],
      ['2026-07-25', 18],
      ['2026-07-26', 35],
    ])
    expect(series.totalSessions).toBe(54)
  })

  it('exercises the winning-dimension rule on a source present in two lenses with different totals', () => {
    const rows = [
      ...landingPageRows({ date: '2026-07-22', source: 'chatgpt', pages: 12, dimensions: ['session'] }),
      ...landingPageRows({ date: '2026-07-22', source: 'chatgpt', pages: 5, dimensions: ['manual_utm'] }),
      ...landingPageRows({ date: '2026-07-22', source: 'claude.ai', pages: 2, dimensions: ['first_user'] }),
      ...landingPageRows({ date: '2026-07-22', source: 'claude.ai', pages: 6, dimensions: ['session'] }),
    ]

    const series = buildAiReferralDailySeries(rows)

    expect(series.days).toHaveLength(1)
    expect(series.days[0]!.bySource).toEqual([
      { source: 'chatgpt', sessions: 12, paidSessions: 0, organicSessions: 12 },
      { source: 'claude.ai', sessions: 6, paidSessions: 0, organicSessions: 6 },
    ])
    // 12 + 6, the winning lens per source. Not 17 + 8 (summed lenses) and not
    // 5 + 2 (the losing lenses).
    expect(series.days[0]!.sessions).toBe(18)
    expect(series.sources).toEqual(['chatgpt', 'claude.ai'])
  })

  it('splits a day into mediums without double counting the source', () => {
    const rows = [
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', medium: 'referral', pages: 30 }),
      ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', medium: 'cpc', trafficClass: 'paid', pages: 5 }),
    ]

    const series = buildAiReferralDailySeries(rows)

    expect(series.days[0]!.sessions).toBe(35)
    expect(series.days[0]!.paidSessions).toBe(5)
    expect(series.days[0]!.organicSessions).toBe(30)
    expect(series.days[0]!.paidSessions + series.days[0]!.organicSessions).toBe(series.days[0]!.sessions)
  })

  it('returns an empty series for no rows', () => {
    expect(buildAiReferralDailySeries([])).toEqual({
      days: [],
      sources: [],
      totalSessions: 0,
      totalPaidSessions: 0,
      totalOrganicSessions: 0,
      byEngine: { series: [], otherCount: 0, days: [] },
    })
  })
})

describe('conservation between the daily series and the window summary', () => {
  const rows = [
    ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 35 }),
    ...landingPageRows({ date: '2026-07-25', source: 'chatgpt', pages: 18 }),
    ...landingPageRows({ date: '2026-07-24', source: 'claude.ai', pages: 2 }),
    ...landingPageRows({ date: '2026-07-23', source: 'chatgpt', pages: 1, dimensions: ['session'] }),
    ...landingPageRows({ date: '2026-07-22', source: 'chatgpt', medium: 'cpc', trafficClass: 'paid', pages: 9, dimensions: ['session', 'first_user'] }),
    // A lens disagreement, so the winner rule actually decides the total.
    ...landingPageRows({ date: '2026-07-21', source: 'perplexity.ai', pages: 3, dimensions: ['session'] }),
    ...landingPageRows({ date: '2026-07-21', source: 'perplexity.ai', pages: 11, dimensions: ['manual_utm'] }),
  ]

  it('reports the same window total as the traffic summary card', () => {
    const series = buildAiReferralDailySeries(rows)
    const summary = summarizeAiReferralCounts(rows)

    expect(series.totalSessions).toBe(summary.deduped.sessions)
    expect(series.totalPaidSessions).toBe(summary.paidDeduped.sessions)
    expect(series.totalOrganicSessions).toBe(summary.organicDeduped.sessions)
    // Guard the assertion itself against an all-zero fixture.
    expect(series.totalSessions).toBe(76)
  })

  it('reports the same per-source total as the summary for the same source', () => {
    const series = buildAiReferralDailySeries(rows)
    const chatgptFromSeries = series.days
      .flatMap((day) => day.bySource)
      .filter((entry) => entry.source === 'chatgpt')
      .reduce((sum, entry) => sum + entry.sessions, 0)
    const chatgptFromSummary = summarizeAiReferralCounts(
      rows.filter((row) => row.source === 'chatgpt'),
    ).deduped.sessions

    expect(chatgptFromSeries).toBe(chatgptFromSummary)
    expect(chatgptFromSeries).toBe(63)
  })

  it('keeps the days summing to the window total', () => {
    const series = buildAiReferralDailySeries(rows)
    const summed = series.days.reduce((sum, day) => sum + day.sessions, 0)
    expect(summed).toBe(series.totalSessions)

    for (const day of series.days) {
      const fromSources = day.bySource.reduce((sum, entry) => sum + entry.sessions, 0)
      expect(fromSources).toBe(day.sessions)
      expect(day.paidSessions + day.organicSessions).toBe(day.sessions)
    }
  })
})

describe('users are never published', () => {
  // GA counts users DISTINCT at the grain the report was asked for, and these
  // rows are keyed down to the landing page, so the stored `users` column does
  // not sum at ANY grain this series serves. There is no correct AI-referral
  // user figure to fetch either. These tests exist so a future edit cannot
  // quietly reintroduce one.
  const rows = [
    ...landingPageRows({ date: '2026-07-26', source: 'chatgpt', pages: 35 }),
    ...landingPageRows({ date: '2026-07-25', source: 'claude.ai', pages: 18, dimensions: ['session'] }),
  ]

  const USER_KEYS = ['users', 'totalUsers', 'paidUsers', 'organicUsers', 'visitors', 'totalVisitors']

  it('exposes no user count anywhere in the daily series', () => {
    const series = buildAiReferralDailySeries(rows)

    for (const key of USER_KEYS) {
      expect(series).not.toHaveProperty(key)
    }
    for (const day of series.days) {
      expect(day.sessions).toBeGreaterThan(0)
      for (const key of USER_KEYS) {
        expect(day).not.toHaveProperty(key)
        for (const entry of day.bySource) {
          expect(entry).not.toHaveProperty(key)
        }
      }
    }
  })

  it('leaks no user-shaped key through serialization', () => {
    const serialized = JSON.stringify(buildAiReferralDailySeries(rows))
    expect(serialized).not.toMatch(/user/i)
    expect(serialized).not.toMatch(/visitor/i)
  })

  it('carries no user figure on the shared winner set at all', () => {
    // The primitive both the chart and the summary fold is sessions-only, so
    // no surface built on it can publish a user count by accident.
    for (const winner of resolveWinningDimensions(rows)) {
      for (const key of USER_KEYS) {
        expect(winner).not.toHaveProperty(key)
      }
      expect(Object.keys(winner).sort()).toEqual(
        ['date', 'medium', 'organicSessions', 'paidSessions', 'source'],
      )
    }
  })

  it('exposes no user count on any window-total bucket', () => {
    // Every bucket used to carry a `.users` landing-page sum feeding the six
    // /ga/traffic user fields. 4.135.0 withdrew those fields and deleted the
    // math; the buckets are sessions-only now, and the sessions are unchanged.
    const summary = summarizeAiReferralCounts(rows)

    const buckets = [
      summary.deduped,
      summary.bySession,
      summary.paidDeduped,
      summary.organicDeduped,
      summary.paidBySession,
      summary.organicBySession,
    ]
    for (const bucket of buckets) {
      expect(Object.keys(bucket)).toEqual(['sessions'])
      for (const key of USER_KEYS) {
        expect(bucket).not.toHaveProperty(key)
      }
    }

    // The winning lens still sums 35 + 18 landing-page rows, as before.
    expect(summary.deduped.sessions).toBe(53)
    expect(summary.organicDeduped.sessions).toBe(53)
    expect(summary.paidDeduped.sessions).toBe(0)
  })
})
