import { describe, it, expect } from 'vitest'
import { detectRegressions } from '../src/regressions.js'
import type { RunData } from '../src/types.js'

function makeRun(overrides: Partial<RunData> & Pick<RunData, 'snapshots'>): RunData {
  return {
    runId: 'run_default',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('detectRegressions', () => {
  it('detects a single lost citation', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'roof repair', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/roof', position: 2 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'roof repair', provider: 'chatgpt', cited: false },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      query: 'roof repair',
      provider: 'chatgpt',
      previousCitationUrl: 'https://example.com/roof',
      previousPosition: 2,
      currentRunId: 'run_002',
      previousRunId: 'run_001',
    })
  })

  it('returns empty when nothing changed', () => {
    const run = makeRun({
      snapshots: [
        { query: 'k1', provider: 'gemini', cited: true },
        { query: 'k2', provider: 'gemini', cited: false },
      ],
    })
    expect(detectRegressions(run, run)).toEqual([])
  })

  it('returns empty when both runs have empty snapshots', () => {
    const empty = makeRun({ snapshots: [] })
    expect(detectRegressions(empty, empty)).toEqual([])
  })

  it('detects regressions across multiple providers for the same query', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'seo tips', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/1', position: 1 },
        { query: 'seo tips', provider: 'gemini', cited: true, citationUrl: 'https://a.com/2', position: 3 },
        { query: 'seo tips', provider: 'claude', cited: true, citationUrl: 'https://a.com/3', position: 2 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'seo tips', provider: 'chatgpt', cited: false },
        { query: 'seo tips', provider: 'gemini', cited: false },
        { query: 'seo tips', provider: 'claude', cited: true, citationUrl: 'https://a.com/3', position: 2 },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.provider).sort()).toEqual(['chatgpt', 'gemini'])
  })

  it('does not flag a query that was never cited in the previous run', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('does not flag queries that gained citation', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('handles a query present in previous run but absent from current run', () => {
    // If a query was tracked before but is no longer in the current run snapshots,
    // it should NOT produce a regression (the query was removed, not lost)
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k2', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        // k2 is absent entirely
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('handles a query present in current run but not in previous run', () => {
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
        { query: 'k2', provider: 'chatgpt', cited: false }, // new query, was never cited
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('preserves undefined previousCitationUrl and previousPosition', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true }, // no citationUrl or position
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].previousCitationUrl).toBeUndefined()
    expect(result[0].previousPosition).toBeUndefined()
  })

  it('handles large runs with many queries and providers', () => {
    const queries = Array.from({ length: 50 }, (_, i) => `query-${i}`)
    const providers = ['chatgpt', 'gemini', 'claude', 'perplexity']

    // Previous: all cited
    const prevSnapshots = queries.flatMap(q =>
      providers.map(p => ({ query: q, provider: p, cited: true })),
    )
    // Current: every other query lost all citations
    const currSnapshots = queries.flatMap((q, i) =>
      providers.map(p => ({ query: q, provider: p, cited: i % 2 === 0 })),
    )

    const prev = makeRun({ runId: 'run_001', snapshots: prevSnapshots })
    const curr = makeRun({ runId: 'run_002', snapshots: currSnapshots })

    const result = detectRegressions(curr, prev)
    // 25 odd-indexed queries × 4 providers = 100 regressions
    expect(result).toHaveLength(25 * 4)
    // All regressions should be for odd-indexed queries
    for (const r of result) {
      const idx = parseInt(r.query.split('-')[1])
      expect(idx % 2).toBe(1)
    }
  })

  it('does not flag a regression when the previous and current runs are different locations', () => {
    // Multi-location fan-out: an answer-visibility sweep produces one run per
    // configured location. The intelligence service must compare each run
    // against the previous run *at the same location* — comparing Michigan
    // (cited) to Florida (not-cited) generates a phantom regression.
    // Defense-in-depth lives in the pure detector: if the service feeds
    // mismatched-location pairs, the detector bails out and produces nothing
    // rather than reporting false transitions.
    const prev = makeRun({
      runId: 'run_001',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true, location: 'michigan' },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      location: 'florida',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false, location: 'florida' },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('detects a regression when locations match across runs', () => {
    // Same-location chronology — the legitimate signal we want to preserve.
    const prev = makeRun({
      runId: 'run_001',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true, location: 'michigan' },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false, location: 'michigan' },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]!.query).toBe('roofers')
  })

  it('treats locationless snapshots as the same chronology', () => {
    // Projects without configured locations have all snapshots with
    // location=undefined/null. They form one continuous timeline.
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false },
      ],
    })

    expect(detectRegressions(curr, prev)).toHaveLength(1)
  })

  it('does not match a locationless snapshot against a labeled-location snapshot', () => {
    // A project that adds its first location starts a new chronology — old
    // locationless runs are not a baseline for the new labeled-location run.
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      location: 'michigan',
      snapshots: [
        { query: 'roofers', provider: 'gemini', cited: false, location: 'michigan' },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('isolates regressions by provider — same query, different provider is independent', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k1', provider: 'gemini', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false }, // regression
        { query: 'k1', provider: 'gemini', cited: true },   // gain, not regression
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe('chatgpt')
  })
})
