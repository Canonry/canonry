import { describe, it, expect } from 'vitest'
import { detectFirstCitations } from '../src/first-citations.js'
import type { RunData } from '../src/types.js'

function makeRun(runId: string, snapshots: RunData['snapshots']): RunData {
  return { runId, projectId: 'p1', completedAt: '2026-04-01T00:00:00Z', snapshots }
}

describe('detectFirstCitations', () => {
  it('flags a query that had no cited provider before and is now cited', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: false },
      { query: 'k1', provider: 'openai', cited: false },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: true, citationUrl: 'https://a.com', position: 1 },
      { query: 'k1', provider: 'openai', cited: false },
    ])

    const result = detectFirstCitations(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]!.query).toBe('k1')
    expect(result[0]!.provider).toBe('gemini')
    expect(result[0]!.citationUrl).toBe('https://a.com')
    expect(result[0]!.runId).toBe('r2')
  })

  it('emits one entry per cited provider when multiple providers light up at once', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: false },
      { query: 'k1', provider: 'openai', cited: false },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: true },
      { query: 'k1', provider: 'openai', cited: true },
    ])

    const result = detectFirstCitations(curr, prev)
    expect(result.map(r => r.provider).sort()).toEqual(['gemini', 'openai'])
  })

  it('does NOT flag a query that already had a cited provider in the previous run', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: true },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: true },
      { query: 'k1', provider: 'openai', cited: true },
    ])

    expect(detectFirstCitations(curr, prev)).toEqual([])
  })

  it('returns empty when nothing is cited in the current run', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: false }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: false }])
    expect(detectFirstCitations(curr, prev)).toEqual([])
  })
})
