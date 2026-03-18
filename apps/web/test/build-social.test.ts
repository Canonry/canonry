import { test, expect } from 'vitest'

import { buildCrossSignalInsights, type SocialData } from '../src/build-dashboard.js'
import type { CitationInsightVm } from '../src/view-models.js'

function makeEvidence(
  overrides: Partial<CitationInsightVm> & {
    keyword: string
    provider: string
    citationState: CitationInsightVm['citationState']
  },
): CitationInsightVm {
  return {
    id: `ev_${overrides.keyword}_${overrides.provider}`,
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    changeLabel: '',
    runHistory: [],
    location: null,
    model: null,
    ...overrides,
  }
}

function makeSocialData(overrides: Partial<SocialData> = {}): SocialData {
  return {
    dailyMentionCounts: [2, 3, 2, 4, 3, 3, 4],
    totalEngagement: 120,
    mentionsWithCanonicalLink: 10,
    totalMentions: 21,
    sentiment: { positive: 14, neutral: 5, negative: 2 },
    ...overrides,
  }
}

test('buildCrossSignalInsights returns empty array when no social data', () => {
  const evidence = [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })]
  expect(buildCrossSignalInsights(evidence, null)).toEqual([])
  expect(buildCrossSignalInsights(evidence, undefined)).toEqual([])
})

test('buildCrossSignalInsights: high AI visibility but low social discussion', () => {
  const evidence = [
    makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' }),
    makeEvidence({ keyword: 'kw2', provider: 'openai', citationState: 'cited' }),
  ]
  const social = makeSocialData({ totalMentions: 5, dailyMentionCounts: [1, 1, 1, 1, 1, 0, 0] })
  const insights = buildCrossSignalInsights(evidence, social)
  const hi = insights.find(i => i.id === 'cross_high_ai_low_social')
  expect(hi).toBeTruthy()
  expect(hi!.tone).toBe('caution')
  expect(hi!.title).toMatch(/low social discussion/i)
})

test('buildCrossSignalInsights: elevated negative sentiment', () => {
  const social = makeSocialData({ sentiment: { positive: 5, neutral: 5, negative: 10 } })
  const insights = buildCrossSignalInsights([], social)
  const neg = insights.find(i => i.id === 'cross_negative_sentiment')
  expect(neg).toBeTruthy()
  expect(neg!.tone).toBe('negative')
  expect(neg!.detail).toMatch(/50%/)
})

test('buildCrossSignalInsights: social spike detected', () => {
  const social = makeSocialData({
    dailyMentionCounts: [2, 2, 2, 2, 2, 2, 20], // last day spikes 10x
  })
  const insights = buildCrossSignalInsights([], social)
  const spike = insights.find(i => i.id === 'cross_social_spike')
  expect(spike).toBeTruthy()
  expect(spike!.tone).toBe('positive')
  expect(spike!.title).toMatch(/spike/i)
})

test('buildCrossSignalInsights: social traction without AI citation', () => {
  const evidence = [
    makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'not-cited' }),
    makeEvidence({ keyword: 'kw2', provider: 'openai', citationState: 'pending' }),
  ]
  const social = makeSocialData({ totalMentions: 50 })
  const insights = buildCrossSignalInsights(evidence, social)
  const noAi = insights.find(i => i.id === 'cross_social_no_ai')
  expect(noAi).toBeTruthy()
  expect(noAi!.tone).toBe('caution')
  expect(noAi!.detail).toMatch(/2 keyword/)
})

test('buildCrossSignalInsights: healthy state produces no insights', () => {
  const evidence = [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })]
  // Lots of mentions, positive sentiment, no spike
  const social = makeSocialData({
    totalMentions: 50,
    sentiment: { positive: 40, neutral: 8, negative: 2 },
    dailyMentionCounts: [7, 7, 7, 7, 7, 7, 8],
  })
  const insights = buildCrossSignalInsights(evidence, social)
  expect(insights.find(i => i.id === 'cross_high_ai_low_social')).toBeUndefined()
  expect(insights.find(i => i.id === 'cross_negative_sentiment')).toBeUndefined()
  expect(insights.find(i => i.id === 'cross_social_no_ai')).toBeUndefined()
  expect(insights.find(i => i.id === 'cross_social_spike')).toBeUndefined()
})
