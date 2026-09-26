import { describe, expect, it } from 'vitest'
import {
  buildGapQueryScore,
  buildMentionGapScore,
  type GapQueryScoreSnapshot,
} from '../src/gap-query-score.js'

function snap(overrides: Partial<GapQueryScoreSnapshot> = {}): GapQueryScoreSnapshot {
  return {
    queryId: 'q1',
    citationState: 'not-cited',
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: [],
    ...overrides,
  }
}

describe('buildGapQueryScore', () => {
  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildGapQueryScore([])
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
  })

  it('counts a query as a gap when not cited but a competitor is cited', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.value).toBe('1')
    expect(result.delta).toBe('1 of 1 queries at risk')
  })

  it('does not count a query as a gap when cited, even if competitors are present', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited', citedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('does not count a query as a gap when not cited but no competitors are in overlap', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: [] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('treats a query as cited when ANY snapshot for it is cited', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q1', citationState: 'cited', citedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('uses singular "query" in description when exactly 1 gap', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.description).toContain('1 tracked query currently cite')
  })

  it('uses plural "queries" in description when more than 1 gap', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citationState: 'not-cited', citedCompetitorDomains: ['foe.com'] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.description).toContain('2 tracked queries currently cite')
  })

  it('returns positive tone when there are zero gaps', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited', citedCompetitorDomains: [] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.tone).toBe('positive')
  })

  it('returns negative tone when gap ratio is 30% or more', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citationState: 'cited', citedCompetitorDomains: [] }),
      snap({ queryId: 'q3', citationState: 'cited', citedCompetitorDomains: [] }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.tone).toBe('negative') // 1/3 = 33% >= 30
  })

  it('returns caution tone when gap ratio is between 0 and 30%', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      ...Array.from({ length: 9 }, (_, i) =>
        snap({ queryId: `q${i + 2}`, citationState: 'cited' }),
      ),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.tone).toBe('caution')
  })

  it('reports progress as 0–100 percentage of gaps', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citationState: 'cited' }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect(result.progress).toBe(50)
  })

  it('keeps progress to two decimals and the value a count', () => {
    // 1 gap of 3 queries is 33.33%, not 33; the gauge value stays the gap count.
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'not-cited', citedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citationState: 'cited' }),
      snap({ queryId: 'q3', citationState: 'cited' }),
    ]
    const result = buildGapQueryScore(snapshots)
    expect([result.value, result.progress]).toEqual(['1', 33.33])
  })

  it('uses the "Citation Gaps" label so the dashboard can pair it with a mention card', () => {
    const result = buildGapQueryScore([snap({ citationState: 'cited' })])
    expect(result.label).toBe('Citation Gaps')
  })
})

describe('buildMentionGapScore', () => {
  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildMentionGapScore([])
    expect(result.label).toBe('Mention Gaps')
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
  })

  it('counts a query as a mention gap when not mentioned but a competitor is mentioned', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: false, mentionedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.value).toBe('1')
    expect(result.delta).toBe('1 of 1 queries at risk')
  })

  it('keeps mention-gap progress to two decimals', () => {
    // 2 gaps of 3 queries is 66.67%, not 67.
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: false, mentionedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', answerMentioned: false, mentionedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q3', answerMentioned: true, mentionedCompetitorDomains: [] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect([result.value, result.progress]).toEqual(['2', 66.67])
  })

  it('does not count a query as a gap when mentioned, even if competitors are present', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: true, mentionedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('does not count a query as a gap when not mentioned but no competitors are in overlap', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: false, mentionedCompetitorDomains: [] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('treats a query as mentioned when ANY snapshot for it is answerMentioned=true', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: false, mentionedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q1', answerMentioned: true, mentionedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.value).toBe('0')
  })

  it('treats null answerMentioned as "not mentioned" (legacy snapshot pre-mention-tracking)', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: null, mentionedCompetitorDomains: ['rival.com'] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.value).toBe('1')
  })

  it('uses negative tone when gap ratio is 30% or more', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: false, mentionedCompetitorDomains: ['rival.com'] }),
      snap({ queryId: 'q2', answerMentioned: true, mentionedCompetitorDomains: [] }),
      snap({ queryId: 'q3', answerMentioned: true, mentionedCompetitorDomains: [] }),
    ]
    const result = buildMentionGapScore(snapshots)
    expect(result.tone).toBe('negative')
  })

  it('mention and citation gap counts can diverge for the same query set', () => {
    // q1: cited but not mentioned + competitor present → mention gap only
    // q2: mentioned but not cited + competitor present → citation gap only
    const snapshots = [
      snap({
        queryId: 'q1',
        citationState: 'cited',
        answerMentioned: false,
        mentionedCompetitorDomains: ['rival.com'],
      }),
      snap({
        queryId: 'q2',
        citationState: 'not-cited',
        answerMentioned: true,
        citedCompetitorDomains: ['rival.com'],
      }),
    ]
    const cite = buildGapQueryScore(snapshots)
    const mention = buildMentionGapScore(snapshots)
    expect(cite.value).toBe('1')      // q2 is the citation gap
    expect(mention.value).toBe('1')   // q1 is the mention gap
  })

  it('does not let either competitor signal leak into the other gap', () => {
    const mentionOnly = snap({
      queryId: 'mention-only',
      answerMentioned: false,
      mentionedCompetitorDomains: ['rival.com'],
    })
    const citationOnly = snap({
      queryId: 'citation-only',
      citationState: 'not-cited',
      answerMentioned: false,
      citedCompetitorDomains: ['rival.com'],
    })

    expect(buildGapQueryScore([mentionOnly]).value).toBe('0')
    expect(buildMentionGapScore([mentionOnly]).value).toBe('1')
    expect(buildGapQueryScore([citationOnly]).value).toBe('1')
    expect(buildMentionGapScore([citationOnly]).value).toBe('0')
  })
})
