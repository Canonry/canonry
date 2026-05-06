import { describe, it, expect } from 'vitest'
import { detectCompetitorGains, detectCompetitorLosses } from '../src/competitor-changes.js'
import type { RunData } from '../src/types.js'

function makeRun(runId: string, snapshots: RunData['snapshots']): RunData {
  return { runId, projectId: 'p1', completedAt: '2026-04-01T00:00:00Z', snapshots }
}

describe('detectCompetitorGains', () => {
  it('flags queries where a tracked competitor newly appeared', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: false },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' },
    ])

    const result = detectCompetitorGains(curr, prev, { trackedCompetitors: ['rival.com'] })
    expect(result).toEqual([{ query: 'k1', competitorDomain: 'rival.com' }])
  })

  it('ignores untracked competitors', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'untracked.com' }])

    expect(detectCompetitorGains(curr, prev, { trackedCompetitors: ['rival.com'] })).toEqual([])
  })

  it('returns empty when competitor was already on the query', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    expect(detectCompetitorGains(curr, prev, { trackedCompetitors: ['rival.com'] })).toEqual([])
  })

  it('returns empty when no competitors are tracked', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    expect(detectCompetitorGains(curr, prev, { trackedCompetitors: [] })).toEqual([])
  })
})

describe('detectCompetitorLosses', () => {
  it('flags queries where a tracked competitor disappeared', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])

    const result = detectCompetitorLosses(curr, prev, { trackedCompetitors: ['rival.com'] })
    expect(result).toEqual([{ query: 'k1', competitorDomain: 'rival.com' }])
  })

  it('returns empty when competitor is still present', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false, competitorDomain: 'rival.com' }])
    expect(detectCompetitorLosses(curr, prev, { trackedCompetitors: ['rival.com'] })).toEqual([])
  })
})
