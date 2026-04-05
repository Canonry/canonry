import { describe, it, expect } from 'vitest'
import { analyzeRuns } from '../src/analyzer.js'
import type { RunData } from '../src/types.js'

describe('analyzer', () => {
  const previousRun: RunData = {
    runId: 'run_001',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/roof', position: 2 },
      { keyword: 'roof coating', provider: 'chatgpt', cited: false },
      { keyword: 'roof coating', provider: 'gemini', cited: true, citationUrl: 'https://example.com/coating', position: 1 },
    ],
  }

  const currentRun: RunData = {
    runId: 'run_002',
    projectId: 'proj_1',
    completedAt: '2026-04-02T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false }, // regression
      { keyword: 'roof coating', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/coating', position: 3 }, // gain
      { keyword: 'roof coating', provider: 'gemini', cited: true, citationUrl: 'https://example.com/coating', position: 1 },
    ],
  }

  it('orchestrates full pipeline and returns analysis result', () => {
    const result = analyzeRuns(currentRun, previousRun)

    expect(result.regressions).toHaveLength(1)
    expect(result.gains).toHaveLength(1)
    expect(result.health.overallCitedRate).toBeCloseTo(0.667, 2)
    expect(result.insights.length).toBeGreaterThan(0)
  })

  it('returns correct regressions', () => {
    const result = analyzeRuns(currentRun, previousRun)
    expect(result.regressions[0].keyword).toBe('roof repair phoenix')
    expect(result.regressions[0].provider).toBe('chatgpt')
  })

  it('returns correct gains', () => {
    const result = analyzeRuns(currentRun, previousRun)
    expect(result.gains[0].keyword).toBe('roof coating')
    expect(result.gains[0].provider).toBe('chatgpt')
  })

  it('generates insights for both regressions and gains', () => {
    const result = analyzeRuns(currentRun, previousRun)
    const types = result.insights.map(i => i.type)
    expect(types).toContain('regression')
    expect(types).toContain('gain')
  })
})
