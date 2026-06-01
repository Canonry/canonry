import { describe, expect, it } from 'vitest'
import {
  buildRunHistory,
  DEFAULT_RUN_HISTORY_LIMIT,
  type RunHistoryRun,
  type RunHistorySnapshot,
} from '../src/run-history.js'

function run(id: string, createdAt: string, status: string = 'completed'): RunHistoryRun {
  return { id, createdAt, status }
}

function snap(
  _runId: string,
  queryId: string,
  citationState: string = 'cited',
  answerMentioned: boolean = false,
): RunHistorySnapshot {
  return { queryId, citationState, answerMentioned }
}

describe('buildRunHistory', () => {
  it('returns empty array for empty runs', () => {
    expect(buildRunHistory([], new Map())).toEqual([])
  })

  it('returns one point per run with the correct fields', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const snapshots = new Map([['r1', [snap('r1', 'q1', 'cited', true)]]])
    const result = buildRunHistory(runs, snapshots)
    expect(result).toEqual([
      {
        runId: 'r1',
        createdAt: '2026-01-01T00:00:00Z',
        citedCount: 1,
        totalCount: 1,
        citationRate: 100,
        mentionedCount: 1,
        mentionRate: 100,
        status: 'completed',
      },
    ])
  })

  it('orders points chronologically (oldest first)', () => {
    const runs = [
      run('r3', '2026-03-01T00:00:00Z'),
      run('r1', '2026-01-01T00:00:00Z'),
      run('r2', '2026-02-01T00:00:00Z'),
    ]
    const result = buildRunHistory(runs, new Map())
    expect(result.map(p => p.runId)).toEqual(['r1', 'r2', 'r3'])
  })

  it('caps at the provided limit (taking most recent first)', () => {
    const runs: RunHistoryRun[] = Array.from({ length: 20 }, (_, i) =>
      run(`r${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    )
    const result = buildRunHistory(runs, new Map(), 5)
    expect(result).toHaveLength(5)
    // The 5 most recent: r15, r16, r17, r18, r19 — sorted ascending
    expect(result.map(p => p.runId)).toEqual(['r15', 'r16', 'r17', 'r18', 'r19'])
  })

  it('defaults to DEFAULT_RUN_HISTORY_LIMIT', () => {
    expect(DEFAULT_RUN_HISTORY_LIMIT).toBe(12)
    const runs: RunHistoryRun[] = Array.from({ length: 20 }, (_, i) =>
      run(`r${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    )
    const result = buildRunHistory(runs, new Map())
    expect(result).toHaveLength(12)
  })

  it('treats a query as cited when ANY snapshot for that query is cited', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const snapshots = new Map([
      ['r1', [
        snap('r1', 'q1', 'not-cited'),
        snap('r1', 'q1', 'cited'),
      ]],
    ])
    const result = buildRunHistory(runs, snapshots)
    expect(result[0]?.citedCount).toBe(1)
    expect(result[0]?.citationRate).toBe(100)
  })

  it('treats a query as mentioned when ANY snapshot has answerMentioned, independent of cited', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const snapshots = new Map([
      ['r1', [
        snap('r1', 'q1', 'not-cited', true),
        snap('r1', 'q1', 'cited', false),
      ]],
    ])
    const result = buildRunHistory(runs, snapshots)
    expect(result[0]?.mentionedCount).toBe(1)
    expect(result[0]?.mentionRate).toBe(100)
    expect(result[0]?.citedCount).toBe(1)
    expect(result[0]?.citationRate).toBe(100)
  })

  it('computes mention and cited rates independently across queries', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    // q1: cited but not mentioned. q2: mentioned but not cited. q3: cited but
    // not mentioned. This drives the two signals to DIFFERENT values (cited
    // 2/3, mentioned 1/3) so a regression that read mentioned off the cited
    // map (or vice versa) can't hide behind a coincidentally-equal number.
    const snapshots = new Map([
      ['r1', [
        snap('r1', 'q1', 'cited', false),
        snap('r1', 'q2', 'not-cited', true),
        snap('r1', 'q3', 'cited', false),
      ]],
    ])
    const result = buildRunHistory(runs, snapshots)
    // Cited: q1, q3 → 2/3 = 67%. Mentioned: q2 only → 1/3 = 33%.
    expect(result[0]?.citedCount).toBe(2)
    expect(result[0]?.mentionedCount).toBe(1)
    expect(result[0]?.totalCount).toBe(3)
    expect(result[0]?.citationRate).toBe(67)
    expect(result[0]?.mentionRate).toBe(33)
  })

  it('returns a zero-rate point for runs with no snapshots', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const result = buildRunHistory(runs, new Map())
    expect(result[0]).toEqual({
      runId: 'r1',
      createdAt: '2026-01-01T00:00:00Z',
      citedCount: 0,
      totalCount: 0,
      citationRate: 0,
      mentionedCount: 0,
      mentionRate: 0,
      status: 'completed',
    })
  })

  it('passes through the run status field', () => {
    const runs = [
      run('r1', '2026-01-01T00:00:00Z', 'completed'),
      run('r2', '2026-02-01T00:00:00Z', 'partial'),
      run('r3', '2026-03-01T00:00:00Z', 'failed'),
    ]
    const result = buildRunHistory(runs, new Map())
    expect(result.map(p => p.status)).toEqual(['completed', 'partial', 'failed'])
  })

  it('rounds citation rate to integer percent', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const snapshots = new Map([
      ['r1', [
        snap('r1', 'q1', 'cited'),
        snap('r1', 'q2', 'cited'),
        snap('r1', 'q3', 'not-cited'),
      ]],
    ])
    const result = buildRunHistory(runs, snapshots)
    expect(result[0]?.citationRate).toBe(67)
  })
})
