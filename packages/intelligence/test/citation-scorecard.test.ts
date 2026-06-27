import { describe, expect, it } from 'vitest'
import {
  buildCitationScorecard,
  type ScorecardQueryLookup,
  type ScorecardSnapshot,
} from '../src/citation-scorecard.js'

function snap(overrides: Partial<ScorecardSnapshot> = {}): ScorecardSnapshot {
  return {
    queryId: 'q1',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    citationState: 'cited',
    answerMentioned: null,
    ...overrides,
  }
}

function lookup(entries: Array<[string, string]>): ScorecardQueryLookup {
  return { byId: new Map(entries) }
}

describe('buildCitationScorecard', () => {
  it('returns an empty scorecard for empty input', () => {
    expect(buildCitationScorecard([], lookup([]))).toEqual({
      queries: [],
      providers: [],
      matrix: [],
      providerRates: [],
    })
  })

  it('builds a single-cell scorecard for a single cited snapshot', () => {
    const result = buildCitationScorecard([snap()], lookup([['q1', 'best CRM']]))
    expect(result.queries).toEqual(['best CRM'])
    expect(result.providers).toEqual(['gemini'])
    expect(result.matrix).toHaveLength(1)
    expect(result.matrix[0]).toHaveLength(1)
    expect(result.matrix[0]![0]).toEqual({
      citationState: 'cited',
      answerMentioned: null,
      model: 'gemini-2.5-flash',
    })
    expect(result.providerRates).toEqual([
      { provider: 'gemini', citedCount: 1, mentionedCount: 0, totalCount: 1, citationRate: 100, mentionRate: 0 },
    ])
  })

  it('treats non-cited citationState as not-cited in the cell', () => {
    const result = buildCitationScorecard(
      [snap({ citationState: 'not-cited' })],
      lookup([['q1', 'best CRM']]),
    )
    expect(result.matrix[0]![0]?.citationState).toBe('not-cited')
    expect(result.providerRates).toEqual([
      { provider: 'gemini', citedCount: 0, mentionedCount: 0, totalCount: 1, citationRate: 0, mentionRate: 0 },
    ])
  })

  it('treats unknown citationState values as not-cited', () => {
    const result = buildCitationScorecard(
      [snap({ citationState: 'pending' })],
      lookup([['q1', 'best CRM']]),
    )
    expect(result.matrix[0]![0]?.citationState).toBe('not-cited')
    expect(result.providerRates[0]?.citedCount).toBe(0)
  })

  it('drops snapshots whose queryId is not in the lookup', () => {
    const snapshots = [
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q-missing' }),
    ]
    const result = buildCitationScorecard(snapshots, lookup([['q1', 'best CRM']]))
    expect(result.queries).toEqual(['best CRM'])
    expect(result.providers).toEqual(['gemini'])
    expect(result.matrix).toHaveLength(1)
    expect(result.providerRates[0]?.totalCount).toBe(1)
  })

  it('sorts queries and providers alphabetically', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'openai' }),
      snap({ queryId: 'q2', provider: 'claude' }),
      snap({ queryId: 'q1', provider: 'gemini' }),
    ]
    const result = buildCitationScorecard(
      snapshots,
      lookup([
        ['q1', 'beta query'],
        ['q2', 'alpha query'],
      ]),
    )
    expect(result.queries).toEqual(['alpha query', 'beta query'])
    expect(result.providers).toEqual(['claude', 'gemini', 'openai'])
  })

  it('preserves answerMentioned and model in cells', () => {
    const result = buildCitationScorecard(
      [snap({ answerMentioned: true, model: 'gpt-4o' })],
      lookup([['q1', 'best CRM']]),
    )
    expect(result.matrix[0]![0]).toEqual({
      citationState: 'cited',
      answerMentioned: true,
      model: 'gpt-4o',
    })
  })

  it('rounds citation rate per provider to integer percent', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited' }),
      snap({ queryId: 'q2', citationState: 'cited' }),
      snap({ queryId: 'q3', citationState: 'not-cited' }),
    ]
    const result = buildCitationScorecard(
      snapshots,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.providerRates).toEqual([
      { provider: 'gemini', citedCount: 2, mentionedCount: 0, totalCount: 3, citationRate: 67, mentionRate: 0 },
    ])
  })

  it('tracks provider mention rate independently from citation rate', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited', answerMentioned: false }),
      snap({ queryId: 'q2', citationState: 'not-cited', answerMentioned: true }),
      snap({ queryId: 'q3', citationState: 'not-cited', answerMentioned: false }),
    ]
    const result = buildCitationScorecard(
      snapshots,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )

    expect(result.providerRates).toEqual([
      { provider: 'gemini', citedCount: 1, mentionedCount: 1, totalCount: 3, citationRate: 33, mentionRate: 33 },
    ])
  })

  it('overwrites the matrix cell with the last snapshot for a (query, provider) pair', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited', model: 'first' }),
      snap({ queryId: 'q1', citationState: 'not-cited', model: 'second' }),
    ]
    const result = buildCitationScorecard(snapshots, lookup([['q1', 'best CRM']]))
    expect(result.matrix[0]![0]?.model).toBe('second')
    expect(result.matrix[0]![0]?.citationState).toBe('not-cited')
    expect(result.providerRates[0]).toEqual({
      provider: 'gemini',
      citedCount: 1,
      mentionedCount: 0,
      totalCount: 2,
      citationRate: 50,
      mentionRate: 0,
    })
  })

  it('produces a queries × providers matrix with nulls where no snapshot exists', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'gemini' }),
      snap({ queryId: 'q2', provider: 'openai' }),
    ]
    const result = buildCitationScorecard(
      snapshots,
      lookup([['q1', 'a'], ['q2', 'b']]),
    )
    expect(result.matrix).toHaveLength(2)
    expect(result.matrix[0]).toHaveLength(2)
    expect(result.matrix[0]![0]).not.toBeNull() // a × gemini
    expect(result.matrix[0]![1]).toBeNull()      // a × openai
    expect(result.matrix[1]![0]).toBeNull()      // b × gemini
    expect(result.matrix[1]![1]).not.toBeNull() // b × openai
  })
})
