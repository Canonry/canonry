import { describe, it, expect } from 'vitest'
import { detectGains } from '../src/gains.js'
import type { RunData } from '../src/types.js'

function makeRun(overrides: Partial<RunData> & Pick<RunData, 'snapshots'>): RunData {
  return {
    runId: 'run_default',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('detectGains', () => {
  it('detects a single new citation', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'roof coating', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'roof coating', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/coating', position: 3, snippet: 'Great coating...' },
      ],
    })

    const result = detectGains(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      query: 'roof coating',
      provider: 'chatgpt',
      citationUrl: 'https://a.com/coating',
      position: 3,
      snippet: 'Great coating...',
      runId: 'run_002',
    })
  })

  it('returns empty when no gains occurred', () => {
    const run = makeRun({
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k2', provider: 'chatgpt', cited: false },
      ],
    })
    expect(detectGains(run, run)).toEqual([])
  })

  it('returns empty for empty snapshot runs', () => {
    const empty = makeRun({ snapshots: [] })
    expect(detectGains(empty, empty)).toEqual([])
  })

  it('detects gains across multiple providers simultaneously', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: false },
        { query: 'k1', provider: 'claude', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
        { query: 'k1', provider: 'gemini', cited: true, citationUrl: 'https://a.com' },
        { query: 'k1', provider: 'claude', cited: false },
      ],
    })

    const result = detectGains(curr, prev)
    expect(result).toHaveLength(2)
    expect(result.map(g => g.provider).sort()).toEqual(['chatgpt', 'gemini'])
  })

  it('does not flag queries that were already cited (stable citations)', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    expect(detectGains(curr, prev)).toEqual([])
  })

  it('does not flag lost citations as gains', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
      ],
    })
    expect(detectGains(curr, prev)).toEqual([])
  })

  it('detects gain for a query new in current run (not in previous)', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'existing', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'existing', provider: 'chatgpt', cited: true },
        { query: 'brand-new', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/new' },
      ],
    })

    const result = detectGains(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].query).toBe('brand-new')
  })

  it('preserves undefined optional fields', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false }],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [{ query: 'k1', provider: 'chatgpt', cited: true }], // no url/position/snippet
    })

    const result = detectGains(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].citationUrl).toBeUndefined()
    expect(result[0].position).toBeUndefined()
    expect(result[0].snippet).toBeUndefined()
  })

  it('handles simultaneous gains and regressions in the same run (only returns gains)', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },  // will regress
        { query: 'k2', provider: 'chatgpt', cited: false },  // will gain
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k2', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
      ],
    })

    const result = detectGains(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].query).toBe('k2')
  })

  it('does not flag a gain when the previous and current runs are different locations', () => {
    // Symmetric to the regression case: Florida (not cited) followed by
    // Michigan (cited) is not a "gain" — those are two different chronologies.
    // Defense-in-depth in the detector: bail when run-level location differs.
    const prev = makeRun({
      runId: 'run_001',
      location: 'florida',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false, location: 'florida' },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true, location: 'michigan' },
      ],
    })

    expect(detectGains(curr, prev)).toEqual([])
  })

  it('detects a gain when locations match across runs', () => {
    const prev = makeRun({
      runId: 'run_001',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false, location: 'michigan' },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true, location: 'michigan' },
      ],
    })

    expect(detectGains(curr, prev)).toHaveLength(1)
  })
})
