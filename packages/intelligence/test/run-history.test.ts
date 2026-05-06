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

function snap(_runId: string, queryId: string, citationState: string = 'cited'): RunHistorySnapshot {
  return { queryId, citationState }
}

describe('buildRunHistory', () => {
  it('returns empty array for empty runs', () => {
    expect(buildRunHistory([], new Map())).toEqual([])
  })

  it('returns one point per run with the correct fields', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const snapshots = new Map([['r1', [snap('r1', 'q1', 'cited')]]])
    const result = buildRunHistory(runs, snapshots)
    expect(result).toEqual([
      {
        runId: 'r1',
        createdAt: '2026-01-01T00:00:00Z',
        citedCount: 1,
        totalCount: 1,
        citationRate: 100,
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

  it('returns a zero-rate point for runs with no snapshots', () => {
    const runs = [run('r1', '2026-01-01T00:00:00Z')]
    const result = buildRunHistory(runs, new Map())
    expect(result[0]).toEqual({
      runId: 'r1',
      createdAt: '2026-01-01T00:00:00Z',
      citedCount: 0,
      totalCount: 0,
      citationRate: 0,
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
