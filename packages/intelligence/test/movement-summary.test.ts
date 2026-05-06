import { describe, expect, it } from 'vitest'
import {
  buildMovementSummary,
  type MovementSummarySnapshot,
} from '../src/movement-summary.js'

function snap(queryId: string, citationState: 'cited' | 'not-cited' | 'pending' = 'cited'): MovementSummarySnapshot {
  return { queryId, citationState }
}

describe('buildMovementSummary', () => {
  it('returns hasPreviousRun=false when there are no previous snapshots', () => {
    const result = buildMovementSummary([snap('q1'), snap('q2')], [])
    expect(result.hasPreviousRun).toBe(false)
    expect(result.gained).toBe(2)
    expect(result.lost).toBe(0)
    expect(result.tone).toBe('positive')
  })

  it('returns neutral tone when first run has zero cited queries', () => {
    const result = buildMovementSummary([snap('q1', 'not-cited')], [])
    expect(result.gained).toBe(0)
    expect(result.lost).toBe(0)
    expect(result.tone).toBe('neutral')
  })

  it('counts gained queries: in latest but not in previous', () => {
    const latest = [snap('q1'), snap('q2'), snap('q3')]
    const previous = [snap('q1'), snap('q3')]
    const result = buildMovementSummary(latest, previous)
    expect(result.gained).toBe(1)
    expect(result.lost).toBe(0)
    expect(result.tone).toBe('positive')
  })

  it('counts lost queries: in previous but not in latest', () => {
    const latest = [snap('q1')]
    const previous = [snap('q1'), snap('q2'), snap('q3')]
    const result = buildMovementSummary(latest, previous)
    expect(result.gained).toBe(0)
    expect(result.lost).toBe(2)
    expect(result.tone).toBe('negative')
  })

  it('returns neutral tone when gained equals lost', () => {
    const latest = [snap('q1'), snap('q3')]
    const previous = [snap('q1'), snap('q2')]
    const result = buildMovementSummary(latest, previous)
    expect(result.gained).toBe(1)
    expect(result.lost).toBe(1)
    expect(result.tone).toBe('neutral')
  })

  it('returns positive tone when gained exceeds lost', () => {
    const latest = [snap('q1'), snap('q2'), snap('q3')]
    const previous = [snap('q4')]
    const result = buildMovementSummary(latest, previous)
    expect(result.gained).toBe(3)
    expect(result.lost).toBe(1)
    expect(result.tone).toBe('positive')
  })

  it('treats a query as cited when ANY snapshot for that query is cited', () => {
    const latest = [
      snap('q1', 'not-cited'), // gemini didn't cite
      snap('q1', 'cited'),     // openai did cite
    ]
    const result = buildMovementSummary(latest, [])
    expect(result.gained).toBe(1)
  })

  it('does not count a query as cited if all snapshots are not-cited', () => {
    const latest = [
      snap('q1', 'not-cited'),
      snap('q1', 'not-cited'),
    ]
    const result = buildMovementSummary(latest, [])
    expect(result.gained).toBe(0)
    expect(result.tone).toBe('neutral')
  })

  it('ignores snapshots with empty queryId', () => {
    const latest = [snap(''), snap('q1')]
    const result = buildMovementSummary(latest, [])
    expect(result.gained).toBe(1)
  })

  it('counts both gains and losses simultaneously', () => {
    const latest = [snap('q1'), snap('q2')]
    const previous = [snap('q1'), snap('q3')]
    const result = buildMovementSummary(latest, previous)
    expect(result.gained).toBe(1) // q2 new
    expect(result.lost).toBe(1)   // q3 dropped
    expect(result.tone).toBe('neutral')
    expect(result.hasPreviousRun).toBe(true)
  })

  it('returns zeros and neutral tone when both runs have no cited queries', () => {
    const result = buildMovementSummary(
      [snap('q1', 'not-cited')],
      [snap('q1', 'not-cited')],
    )
    expect(result.gained).toBe(0)
    expect(result.lost).toBe(0)
    expect(result.tone).toBe('neutral')
    expect(result.hasPreviousRun).toBe(true)
  })
})
