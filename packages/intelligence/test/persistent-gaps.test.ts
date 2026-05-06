import { describe, it, expect } from 'vitest'
import { detectPersistentGaps, PERSISTENT_GAP_THRESHOLD } from '../src/persistent-gaps.js'
import type { RunData } from '../src/types.js'

function makeRun(runId: string, snapshots: RunData['snapshots']): RunData {
  return { runId, projectId: 'p1', completedAt: `2026-04-01T00:00:00Z`, snapshots }
}

describe('detectPersistentGaps', () => {
  it('flags a query uncited for >= threshold consecutive runs ending at the latest', () => {
    const r1 = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r2 = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r3 = makeRun('r3', [{ query: 'k1', provider: 'gemini', cited: false }])

    const result = detectPersistentGaps([r1, r2, r3])
    expect(result).toHaveLength(1)
    expect(result[0]!.query).toBe('k1')
    expect(result[0]!.streak).toBe(3)
    expect(result[0]!.threshold).toBe(PERSISTENT_GAP_THRESHOLD)
  })

  it('does NOT flag a query that was cited in the latest run even if previous runs were not', () => {
    const r1 = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r2 = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r3 = makeRun('r3', [{ query: 'k1', provider: 'gemini', cited: true }])

    expect(detectPersistentGaps([r1, r2, r3])).toEqual([])
  })

  it('breaks the streak as soon as any provider cited the query', () => {
    const r1 = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r2 = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: false },
      { query: 'k1', provider: 'openai', cited: true },
    ])
    const r3 = makeRun('r3', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r4 = makeRun('r4', [{ query: 'k1', provider: 'gemini', cited: false }])

    // Only 2 trailing runs are uncited (r3, r4) — below default threshold of 3
    expect(detectPersistentGaps([r1, r2, r3, r4])).toEqual([])
  })

  it('returns empty when fewer runs than threshold are provided', () => {
    const r1 = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r2 = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])
    expect(detectPersistentGaps([r1, r2])).toEqual([])
  })

  it('respects a custom threshold', () => {
    const r1 = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const r2 = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])
    const result = detectPersistentGaps([r1, r2], 2)
    expect(result).toHaveLength(1)
    expect(result[0]!.threshold).toBe(2)
  })
})
