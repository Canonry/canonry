import { describe, expect, it } from 'vitest'
import {
  buildMentionMovementSummary,
  buildMovementComparison,
  buildMovementSummary,
  type MovementSummarySnapshot,
} from '../src/movement-summary.js'

function snap(
  queryId: string,
  citationState: 'cited' | 'not-cited' | 'pending' = 'cited',
  answerMentioned = false,
): MovementSummarySnapshot {
  return { queryId, citationState, answerMentioned }
}

describe('buildMovementSummary', () => {
  it('returns hasPreviousRun=false and current cited coverage on the first run', () => {
    const result = buildMovementSummary([snap('q1'), snap('q2')], [])
    expect(result).toMatchObject({ hasPreviousRun: false, gained: 2, lost: 0, tone: 'positive' })
  })

  it('returns neutral tone when the first run has zero cited queries', () => {
    const result = buildMovementSummary([snap('q1', 'not-cited')], [])
    expect(result).toMatchObject({ gained: 0, lost: 0, tone: 'neutral' })
  })

  it('counts gains and losses only within the shared query basket', () => {
    const latest = [snap('q1'), snap('q2'), snap('q3', 'not-cited')]
    const previous = [snap('q1'), snap('q2', 'not-cited'), snap('q3')]
    const result = buildMovementSummary(latest, previous)
    expect(result).toMatchObject({ gained: 1, lost: 1, tone: 'neutral', hasPreviousRun: true })
  })

  it('returns positive tone when comparable gains exceed losses', () => {
    const latest = [snap('q1'), snap('q2'), snap('q3'), snap('q4', 'not-cited')]
    const previous = [snap('q1', 'not-cited'), snap('q2', 'not-cited'), snap('q3', 'not-cited'), snap('q4')]
    const result = buildMovementSummary(latest, previous)
    expect(result).toMatchObject({ gained: 3, lost: 1, tone: 'positive' })
  })

  it('returns negative tone when comparable losses exceed gains', () => {
    const latest = [snap('q1'), snap('q2', 'not-cited'), snap('q3', 'not-cited')]
    const previous = [snap('q1'), snap('q2'), snap('q3')]
    const result = buildMovementSummary(latest, previous)
    expect(result).toMatchObject({ gained: 0, lost: 2, tone: 'negative' })
  })

  it('does not count a newly tracked cited query as a citation gain', () => {
    const result = buildMovementSummary(
      [snap('shared'), snap('added')],
      [snap('shared')],
    )
    expect(result).toMatchObject({ gained: 0, lost: 0, tone: 'neutral' })
  })

  it('does not count a removed cited query as a citation loss', () => {
    const result = buildMovementSummary(
      [snap('shared')],
      [snap('shared'), snap('removed')],
    )
    expect(result).toMatchObject({ gained: 0, lost: 0, tone: 'neutral' })
  })

  it('treats a query as cited when any provider snapshot is cited', () => {
    const result = buildMovementSummary([
      snap('q1', 'not-cited'),
      snap('q1', 'cited'),
    ], [])
    expect(result.gained).toBe(1)
  })

  it('ignores snapshots with empty queryId', () => {
    const result = buildMovementSummary([snap(''), snap('q1')], [])
    expect(result.gained).toBe(1)
  })

  describe('with queryLookup option', () => {
    const lookup = new Map([
      ['q1', 'best dentist nyc'],
      ['q2', 'invisalign brooklyn'],
      ['q3', 'emergency dental'],
    ])

    it('returns sorted gained and lost query strings', () => {
      const latest = [snap('q1'), snap('q2'), snap('q3', 'not-cited')]
      const previous = [snap('q1'), snap('q2', 'not-cited'), snap('q3')]
      const result = buildMovementSummary(latest, previous, { queryLookup: lookup })
      expect(result.gainedQueries).toEqual(['invisalign brooklyn'])
      expect(result.lostQueries).toEqual(['emergency dental'])
    })

    it('omits lists when no lookup is passed', () => {
      const result = buildMovementSummary(
        [snap('q1'), snap('q2')],
        [snap('q1', 'not-cited'), snap('q2')],
      )
      expect(result.gainedQueries).toBeUndefined()
      expect(result.lostQueries).toBeUndefined()
    })

    it('keeps counts when a query text cannot be resolved', () => {
      const result = buildMovementSummary(
        [snap('q1'), snap('q9-unknown')],
        [snap('q1', 'not-cited'), snap('q9-unknown', 'not-cited')],
        { queryLookup: lookup },
      )
      expect(result.gained).toBe(2)
      expect(result.gainedQueries).toEqual(['best dentist nyc'])
    })

    it('returns empty arrays when nothing moved', () => {
      const result = buildMovementSummary([snap('q1')], [snap('q1')], { queryLookup: lookup })
      expect(result.gainedQueries).toEqual([])
      expect(result.lostQueries).toEqual([])
    })
  })
})

describe('buildMentionMovementSummary', () => {
  it('computes mention movement independently of citation movement', () => {
    const latest = [
      snap('q1', 'cited', false),
      snap('q2', 'not-cited', true),
    ]
    const previous = [
      snap('q1', 'cited', true),
      snap('q2', 'not-cited', false),
    ]

    expect(buildMovementSummary(latest, previous)).toMatchObject({ gained: 0, lost: 0 })
    expect(buildMentionMovementSummary(latest, previous)).toMatchObject({ gained: 1, lost: 1 })
  })

  it('treats a query as mentioned when any provider answer mentions it', () => {
    const result = buildMentionMovementSummary([
      snap('q1', 'not-cited', false),
      snap('q1', 'not-cited', true),
    ], [])
    expect(result.gained).toBe(1)
  })

  it('excludes newly added queries from mention gains', () => {
    const result = buildMentionMovementSummary(
      [snap('shared', 'not-cited', false), snap('added', 'not-cited', true)],
      [snap('shared', 'not-cited', false)],
    )
    expect(result).toMatchObject({ gained: 0, lost: 0 })
  })
})

describe('buildMovementComparison', () => {
  const lookup = new Map([
    ['q1', 'alpha query'],
    ['q2', 'beta query'],
    ['q3', 'gamma query'],
  ])

  it('marks identical non-empty baskets comparable', () => {
    const result = buildMovementComparison(
      [snap('q1'), snap('q2')],
      [snap('q1'), snap('q2')],
      { queryLookup: lookup, previousRunAt: '2026-06-01T00:00:00.000Z' },
    )
    expect(result).toEqual({
      hasPreviousRun: true,
      comparable: true,
      querySetChanged: false,
      previousRunAt: '2026-06-01T00:00:00.000Z',
      currentQueryCount: 2,
      previousQueryCount: 2,
      comparableQueryCount: 2,
      addedQueryCount: 0,
      removedQueryCount: 0,
      addedQueries: [],
      removedQueries: [],
    })
  })

  it('reports added and removed queries without conflating them with movement', () => {
    const result = buildMovementComparison(
      [snap('q1'), snap('q2')],
      [snap('q1'), snap('q3')],
      { queryLookup: lookup },
    )
    expect(result).toMatchObject({
      hasPreviousRun: true,
      comparable: false,
      querySetChanged: true,
      currentQueryCount: 2,
      previousQueryCount: 2,
      comparableQueryCount: 1,
      addedQueryCount: 1,
      removedQueryCount: 1,
      addedQueries: ['beta query'],
      removedQueries: ['gamma query'],
    })
  })

  it('reports no comparison on a first run', () => {
    const result = buildMovementComparison([snap('q1')], [], { queryLookup: lookup })
    expect(result).toMatchObject({
      hasPreviousRun: false,
      comparable: false,
      querySetChanged: false,
      currentQueryCount: 1,
      previousQueryCount: 0,
      comparableQueryCount: 0,
      addedQueryCount: 0,
      removedQueryCount: 0,
    })
  })

  it('handles an empty current basket (every query removed) without marking it comparable', () => {
    const result = buildMovementComparison(
      [],
      [snap('q1'), snap('q2')],
      { queryLookup: lookup, previousRunAt: '2026-06-01T00:00:00.000Z' },
    )
    expect(result).toEqual({
      hasPreviousRun: true,
      comparable: false,
      querySetChanged: true,
      previousRunAt: '2026-06-01T00:00:00.000Z',
      currentQueryCount: 0,
      previousQueryCount: 2,
      comparableQueryCount: 0,
      addedQueryCount: 0,
      removedQueryCount: 2,
      addedQueries: [],
      removedQueries: ['alpha query', 'beta query'],
    })
  })

  it('keeps the count when a changed query has no resolvable text (count >= list length)', () => {
    const result = buildMovementComparison(
      [snap('q1'), snap('q2'), snap('q9-unknown')],
      [snap('q1')],
      { queryLookup: lookup },
    )
    // q2 + q9-unknown are both added; only q2 resolves to text.
    expect(result.addedQueryCount).toBe(2)
    expect(result.addedQueries).toEqual(['beta query'])
  })

  it('sorts added and removed query text alphabetically regardless of input order', () => {
    const sortLookup = new Map([
      ['keep', 'shared query'],
      ['add-z', 'zebra'],
      ['add-m', 'mango'],
      ['add-a', 'apple'],
      ['rm-y', 'yak'],
      ['rm-b', 'bear'],
    ])
    const result = buildMovementComparison(
      [snap('keep'), snap('add-z'), snap('add-m'), snap('add-a')],
      [snap('keep'), snap('rm-y'), snap('rm-b')],
      { queryLookup: sortLookup },
    )
    expect(result.addedQueries).toEqual(['apple', 'mango', 'zebra'])
    expect(result.removedQueries).toEqual(['bear', 'yak'])
  })
})
