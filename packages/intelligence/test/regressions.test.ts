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
        { keyword: 'roof repair', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/roof', position: 2 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'roof repair', provider: 'chatgpt', cited: false },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      keyword: 'roof repair',
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
        { keyword: 'k1', provider: 'gemini', cited: true },
        { keyword: 'k2', provider: 'gemini', cited: false },
      ],
    })
    expect(detectRegressions(run, run)).toEqual([])
  })

  it('returns empty when both runs have empty snapshots', () => {
    const empty = makeRun({ snapshots: [] })
    expect(detectRegressions(empty, empty)).toEqual([])
  })

  it('detects regressions across multiple providers for the same keyword', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'seo tips', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/1', position: 1 },
        { keyword: 'seo tips', provider: 'gemini', cited: true, citationUrl: 'https://a.com/2', position: 3 },
        { keyword: 'seo tips', provider: 'claude', cited: true, citationUrl: 'https://a.com/3', position: 2 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'seo tips', provider: 'chatgpt', cited: false },
        { keyword: 'seo tips', provider: 'gemini', cited: false },
        { keyword: 'seo tips', provider: 'claude', cited: true, citationUrl: 'https://a.com/3', position: 2 },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.provider).sort()).toEqual(['chatgpt', 'gemini'])
  })

  it('does not flag a keyword that was never cited in the previous run', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('does not flag keywords that gained citation', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('handles a keyword present in previous run but absent from current run', () => {
    // If a keyword was tracked before but is no longer in the current run snapshots,
    // it should NOT produce a regression (the keyword was removed, not lost)
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        // k2 is absent entirely
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('handles a keyword present in current run but not in previous run', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: false }, // new keyword, was never cited
      ],
    })

    expect(detectRegressions(curr, prev)).toEqual([])
  })

  it('preserves undefined previousCitationUrl and previousPosition', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true }, // no citationUrl or position
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].previousCitationUrl).toBeUndefined()
    expect(result[0].previousPosition).toBeUndefined()
  })

  it('handles large runs with many keywords and providers', () => {
    const keywords = Array.from({ length: 50 }, (_, i) => `keyword-${i}`)
    const providers = ['chatgpt', 'gemini', 'claude', 'perplexity']

    // Previous: all cited
    const prevSnapshots = keywords.flatMap(kw =>
      providers.map(p => ({ keyword: kw, provider: p, cited: true })),
    )
    // Current: every other keyword lost all citations
    const currSnapshots = keywords.flatMap((kw, i) =>
      providers.map(p => ({ keyword: kw, provider: p, cited: i % 2 === 0 })),
    )

    const prev = makeRun({ runId: 'run_001', snapshots: prevSnapshots })
    const curr = makeRun({ runId: 'run_002', snapshots: currSnapshots })

    const result = detectRegressions(curr, prev)
    // 25 odd-indexed keywords × 4 providers = 100 regressions
    expect(result).toHaveLength(25 * 4)
    // All regressions should be for odd-indexed keywords
    for (const r of result) {
      const idx = parseInt(r.keyword.split('-')[1])
      expect(idx % 2).toBe(1)
    }
  })

  it('isolates regressions by provider — same keyword, different provider is independent', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k1', provider: 'gemini', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false }, // regression
        { keyword: 'k1', provider: 'gemini', cited: true },   // gain, not regression
      ],
    })

    const result = detectRegressions(curr, prev)
    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe('chatgpt')
  })
})
