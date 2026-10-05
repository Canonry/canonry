import { describe, expect, it } from 'vitest'
import {
  pickWinningAttributionDimension,
  resolveWinningDimensions,
  summarizeAiReferralCounts,
} from '../src/ga-ai-referral-aggregation.js'

/**
 * Shape captured from a real GA4 sync. The three rows are ONE visit seen
 * through three attribution lenses. Note the manual-UTM lens reports no medium
 * while the other two report 'ai-assistant': that difference is what let the
 * same visit survive twice when medium was part of the dedup key.
 */
const ONE_VISIT_THREE_LENSES = [
  { date: '2026-08-15', source: 'chatgpt.com', medium: 'ai-assistant', sourceDimension: 'first_user', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 1 },
  { date: '2026-08-15', source: 'chatgpt.com', medium: '(not set)', sourceDimension: 'manual_utm', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 1 },
  { date: '2026-08-15', source: 'chatgpt.com', medium: 'ai-assistant', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 1 },
]

describe('AI referral attribution dedup', () => {
  it('counts one visit once when the lenses disagree about medium', () => {
    const winners = resolveWinningDimensions(ONE_VISIT_THREE_LENSES)
    expect(winners).toHaveLength(1)
    expect(winners[0].paidSessions + winners[0].organicSessions).toBe(1)
  })

  it('reports the same single session through the summarizer', () => {
    const s = summarizeAiReferralCounts(ONE_VISIT_THREE_LENSES)
    // The deduped total is the headline the report prints. Before the fix it
    // was 2 here and roughly double over a full month.
    expect(s.deduped.sessions).toBe(1)
    // The session-scoped total was always right; the two must now agree.
    expect(s.bySession.sessions).toBe(1)
  })

  it('keeps genuinely different sources apart', () => {
    const rows = [
      ...ONE_VISIT_THREE_LENSES,
      { date: '2026-08-15', source: 'claude.ai', medium: 'ai-assistant', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 4 },
    ]
    expect(summarizeAiReferralCounts(rows).deduped.sessions).toBe(5)
  })

  it('keeps different dates apart', () => {
    const rows = [
      ...ONE_VISIT_THREE_LENSES,
      ...ONE_VISIT_THREE_LENSES.map(r => ({ ...r, date: '2026-08-16' })),
    ]
    expect(summarizeAiReferralCounts(rows).deduped.sessions).toBe(2)
  })

  it('takes the largest lens rather than the sum when they disagree', () => {
    const rows = [
      { date: '2026-08-15', source: 'chatgpt.com', medium: 'ai-assistant', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 3 },
      { date: '2026-08-15', source: 'chatgpt.com', medium: '(not set)', sourceDimension: 'manual_utm', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 7 },
    ]
    expect(summarizeAiReferralCounts(rows).deduped.sessions).toBe(7)
  })

  it('breaks a tie toward the session lens so row order cannot change the answer', () => {
    const tied = new Map([['first_user', 5], ['manual_utm', 5], ['session', 5]])
    expect(pickWinningAttributionDimension(tied)).toBe('session')
    const reordered = new Map([['session', 5], ['manual_utm', 5], ['first_user', 5]])
    expect(pickWinningAttributionDimension(reordered)).toBe('session')
  })

  it('still partitions paid and organic within the winning lens', () => {
    const rows = [
      { date: '2026-08-15', source: 'chatgpt.com', medium: 'ai-assistant', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'paid', sessions: 2 },
      { date: '2026-08-15', source: 'chatgpt.com', medium: 'ai-assistant', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 3 },
    ]
    const s = summarizeAiReferralCounts(rows)
    expect(s.paidDeduped.sessions).toBe(2)
    expect(s.organicDeduped.sessions).toBe(3)
    expect(s.deduped.sessions).toBe(5)
  })
})

/**
 * Stored attribution dimensions overlap. These cases prevent a missing medium
 * from turning one visit into two across the session and manual-UTM lenses.
 */
describe('attribution dimension dedup agreement', () => {
  it('a manual-UTM lens with no medium does not add a second visit', () => {
    // Exactly the row shape that produced 308 sessions where the truth was 155.
    const totals = summarizeAiReferralCounts(ONE_VISIT_THREE_LENSES)
    expect(totals.deduped.sessions).toBe(1)
    // Keying on medium, the pre-fix behaviour, groups '(not set)' apart from
    // 'ai-assistant' and yields 2.
    const byMediumKey = new Map<string, number>()
    for (const r of ONE_VISIT_THREE_LENSES) {
      const key = `${r.date}\u0000${r.source}\u0000${r.medium}`
      byMediumKey.set(key, Math.max(byMediumKey.get(key) ?? 0, r.sessions))
    }
    expect([...byMediumKey.values()].reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('keeps both rows when one lens legitimately emits organic and paid for a source', () => {
    // The "keep every row of the winning lens" semantic. A per-key MAX would
    // drop one of these and silently lose the paid or organic split.
    const rows = [
      { date: '2026-08-15', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'organic', sessions: 15 },
      { date: '2026-08-15', source: 'chatgpt.com', medium: 'cpc', sourceDimension: 'session', channelGroup: 'AI Assistant', trafficClass: 'paid', sessions: 8 },
    ]
    const s = summarizeAiReferralCounts(rows)
    expect(s.organicDeduped.sessions).toBe(15)
    expect(s.paidDeduped.sessions).toBe(8)
    expect(s.deduped.sessions).toBe(23)
  })
})
