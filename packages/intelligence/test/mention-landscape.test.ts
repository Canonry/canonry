import { describe, expect, it } from 'vitest'
import {
  buildMentionLandscape,
  type MentionLandscapeQueryLookup,
  type MentionLandscapeSnapshot,
} from '../src/mention-landscape.js'

function snap(overrides: Partial<MentionLandscapeSnapshot> = {}): MentionLandscapeSnapshot {
  return {
    queryId: 'q1',
    answerText: 'Acme Inc is a popular CRM at acme.com',
    answerMentioned: true,
    ...overrides,
  }
}

function lookup(entries: Array<[string, string]>): MentionLandscapeQueryLookup {
  return { byId: new Map(entries) }
}

const PROJECT_NAME = 'Acme'
const PROJECT_DOMAINS = ['acme.com']

describe('buildMentionLandscape', () => {
  it('returns zeroed rows for empty snapshots while preserving competitor list', () => {
    const result = buildMentionLandscape([], ['rival.com', 'foe.com'], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.projectMentionCount).toBe(0)
    expect(result.totalAnswerSnapshots).toBe(0)
    expect(result.competitors.map(c => c.domain).sort()).toEqual(['foe.com', 'rival.com'])
  })

  it('skips snapshots with null answerText (excluded from denominator and counts)', () => {
    const snapshots = [snap({ answerText: null, answerMentioned: true })]
    const result = buildMentionLandscape(snapshots, ['rival.com'], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.totalAnswerSnapshots).toBe(0)
    expect(result.projectMentionCount).toBe(0)
  })

  it('counts a project mention when answerMentioned is true on a snapshot with answerText', () => {
    const snapshots = [snap({ answerMentioned: true })]
    const result = buildMentionLandscape(snapshots, [], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.projectMentionCount).toBe(1)
    expect(result.totalAnswerSnapshots).toBe(1)
  })

  it('does not count a project mention when answerMentioned is false', () => {
    const snapshots = [snap({ answerText: 'no mention here', answerMentioned: false })]
    const result = buildMentionLandscape(snapshots, [], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.projectMentionCount).toBe(0)
    expect(result.totalAnswerSnapshots).toBe(1)
  })

  it('falls back to determineAnswerMentioned when answerMentioned is null', () => {
    // answerMentioned null on a row whose text mentions the project — should fall back to true.
    const snapshots = [snap({ answerText: 'Try Acme Inc — see acme.com', answerMentioned: null })]
    const result = buildMentionLandscape(snapshots, [], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.projectMentionCount).toBe(1)
  })

  it('counts competitor mentions when the answer text contains the competitor brand', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerText: 'Try Rival Co — see rival.com', answerMentioned: false }),
    ]
    const result = buildMentionLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([['q1', 'best CRM']]),
    )
    const rival = result.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.mentionCount).toBe(1)
    expect(rival.mentionedQueries).toEqual(['best CRM'])
  })

  it('omits a competitor mention from queries set when queryId is not in the lookup', () => {
    const snapshots = [
      snap({ queryId: 'unknown', answerText: 'Rival Co at rival.com', answerMentioned: false }),
    ]
    const result = buildMentionLandscape(snapshots, ['rival.com'], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    const rival = result.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.mentionCount).toBe(1)
    expect(rival.mentionedQueries).toEqual([])
  })

  it('labels pressure correctly across all four bands', () => {
    const competitorTexts = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        snap({ queryId: `q${i}`, answerText: 'See rival.com Rival Co', answerMentioned: false }),
      )
    const filler = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        snap({ queryId: `f${i}`, answerText: 'unrelated text', answerMentioned: false }),
      )

    // High: 5 of 10 = 0.5
    let result = buildMentionLandscape(
      [...competitorTexts(5), ...filler(5)],
      ['rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([]),
    )
    expect(result.competitors[0]?.pressureLabel).toBe('High')

    // Moderate: 2 of 10 = 0.2
    result = buildMentionLandscape(
      [...competitorTexts(2), ...filler(8)],
      ['rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([]),
    )
    expect(result.competitors[0]?.pressureLabel).toBe('Moderate')

    // Low: 1 of 10 = 0.1
    result = buildMentionLandscape(
      [...competitorTexts(1), ...filler(9)],
      ['rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([]),
    )
    expect(result.competitors[0]?.pressureLabel).toBe('Low')

    // None: 0 mentions
    result = buildMentionLandscape(filler(5), ['rival.com'], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.competitors[0]?.pressureLabel).toBe('None')
  })

  it('computes sharePct against totalMentionedSlots (project + all competitors)', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerText: 'Acme is great. acme.com', answerMentioned: true }),
      snap({ queryId: 'q2', answerText: 'Rival Co is at rival.com', answerMentioned: false }),
      snap({ queryId: 'q3', answerText: 'Rival Co again rival.com', answerMentioned: false }),
    ]
    const result = buildMentionLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.projectMentionCount).toBe(1)
    expect(result.competitors[0]?.sharePct).toBe(67) // 2 of 3 total
  })

  it('sorts competitor rows by mention count descending', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerText: 'Rival Co at rival.com', answerMentioned: false }),
      snap({ queryId: 'q2', answerText: 'Rival Co at rival.com', answerMentioned: false }),
      snap({ queryId: 'q3', answerText: 'Foe at foe.com Foe', answerMentioned: false }),
    ]
    const result = buildMentionLandscape(
      snapshots,
      ['foe.com', 'rival.com'],
      PROJECT_NAME,
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.competitors.map(c => c.domain)).toEqual(['rival.com', 'foe.com'])
  })

  it('returns sharePct of 0 when nobody is mentioned', () => {
    const snapshots = [snap({ answerText: 'nothing here', answerMentioned: false })]
    const result = buildMentionLandscape(snapshots, ['rival.com'], PROJECT_NAME, PROJECT_DOMAINS, lookup([]))
    expect(result.competitors[0]?.sharePct).toBe(0)
  })
})
