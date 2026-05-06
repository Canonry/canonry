import { describe, it, expect } from 'vitest'
import { detectProviderPickups } from '../src/provider-pickups.js'
import type { RunData } from '../src/types.js'

function makeRun(runId: string, snapshots: RunData['snapshots']): RunData {
  return { runId, projectId: 'p1', completedAt: '2026-04-01T00:00:00Z', snapshots }
}

describe('detectProviderPickups', () => {
  it('flags a provider that just started citing a query already cited by another provider', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: true },
      { query: 'k1', provider: 'openai', cited: false },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: true },
      { query: 'k1', provider: 'openai', cited: true, citationUrl: 'https://a.com' },
    ])

    const result = detectProviderPickups(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]!.query).toBe('k1')
    expect(result[0]!.provider).toBe('openai')
    expect(result[0]!.citationUrl).toBe('https://a.com')
  })

  it('does NOT flag a query that no provider cited in the previous run (that is a first-citation)', () => {
    const prev = makeRun('r1', [
      { query: 'k1', provider: 'gemini', cited: false },
      { query: 'k1', provider: 'openai', cited: false },
    ])
    const curr = makeRun('r2', [
      { query: 'k1', provider: 'gemini', cited: true },
      { query: 'k1', provider: 'openai', cited: true },
    ])

    expect(detectProviderPickups(curr, prev)).toEqual([])
  })

  it('does NOT flag a provider that was already citing the query', () => {
    const prev = makeRun('r1', [{ query: 'k1', provider: 'gemini', cited: true }])
    const curr = makeRun('r2', [{ query: 'k1', provider: 'gemini', cited: true }])
    expect(detectProviderPickups(curr, prev)).toEqual([])
  })
})
