import { describe, it, expect } from 'vitest'
import { analyzeRuns } from '../src/analyzer.js'
import type { RunData } from '../src/types.js'

function makeRun(overrides: Partial<RunData> & Pick<RunData, 'snapshots'>): RunData {
  return {
    runId: 'run_default',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('analyzeRuns', () => {
  it('detects regressions, gains, and health in a single pass', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/1', position: 2 },
        { keyword: 'k2', provider: 'chatgpt', cited: false },
        { keyword: 'k2', provider: 'gemini', cited: true, citationUrl: 'https://a.com/2', position: 1 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },            // regression
        { keyword: 'k2', provider: 'chatgpt', cited: true, position: 3 }, // gain
        { keyword: 'k2', provider: 'gemini', cited: true, position: 1 },  // stable
      ],
    })

    const result = analyzeRuns(curr, prev)

    expect(result.regressions).toHaveLength(1)
    expect(result.regressions[0].keyword).toBe('k1')
    expect(result.regressions[0].provider).toBe('chatgpt')

    expect(result.gains).toHaveLength(1)
    expect(result.gains[0].keyword).toBe('k2')
    expect(result.gains[0].provider).toBe('chatgpt')

    expect(result.health.overallCitedRate).toBeCloseTo(0.667, 2)
    expect(result.health.totalPairs).toBe(3)
    expect(result.health.citedPairs).toBe(2)
  })

  it('generates one insight per regression and one per gain', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
        { keyword: 'k2', provider: 'chatgpt', cited: true },
      ],
    })

    const result = analyzeRuns(curr, prev)
    expect(result.insights).toHaveLength(2)

    const types = result.insights.map(i => i.type)
    expect(types).toContain('regression')
    expect(types).toContain('gain')

    const regInsight = result.insights.find(i => i.type === 'regression')!
    expect(regInsight.severity).toBe('high')
    expect(regInsight.recommendation?.action).toBe('audit')

    const gainInsight = result.insights.find(i => i.type === 'gain')!
    expect(gainInsight.severity).toBe('low')
    expect(gainInsight.recommendation?.action).toBe('monitor')
  })

  it('attaches competitor cause analysis to regression insights', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false, competitorDomain: 'rival.com' },
      ],
    })

    const result = analyzeRuns(curr, prev)
    const regInsight = result.insights.find(i => i.type === 'regression')!
    expect(regInsight.cause).toBeDefined()
    expect(regInsight.cause!.cause).toBe('competitor_gain')
    expect(regInsight.cause!.competitorDomain).toBe('rival.com')
  })

  it('returns no regressions or gains when runs are identical', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'gemini', cited: false },
      ],
    })

    const result = analyzeRuns(run, run)
    expect(result.regressions).toEqual([])
    expect(result.gains).toEqual([])
    expect(result.insights).toEqual([])
    expect(result.health.overallCitedRate).toBe(0.5)
  })

  it('returns no trend when allRuns is not provided', () => {
    const run = makeRun({ snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: true }] })
    const result = analyzeRuns(run, run)
    expect(result.trend).toBeUndefined()
  })

  it('computes trend when allRuns is provided', () => {
    const run1 = makeRun({
      runId: 'run_001',
      snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: false }],
    })
    const run2 = makeRun({
      runId: 'run_002',
      snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: true }],
    })

    const result = analyzeRuns(run2, run1, [run1, run2])
    expect(result.trend).toBeDefined()
    expect(result.trend!.previous).toBe(0)
    expect(result.trend!.current).toBe(1.0)
    expect(result.trend!.delta).toBe(1.0)
  })

  it('handles complete citation loss across all providers', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k1', provider: 'gemini', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
        { keyword: 'k1', provider: 'gemini', cited: false },
        { keyword: 'k2', provider: 'chatgpt', cited: false },
      ],
    })

    const result = analyzeRuns(curr, prev)
    expect(result.regressions).toHaveLength(3)
    expect(result.gains).toEqual([])
    expect(result.health.overallCitedRate).toBe(0)
    expect(result.insights).toHaveLength(3)
    expect(result.insights.every(i => i.type === 'regression')).toBe(true)
  })

  it('handles empty snapshot runs gracefully', () => {
    const empty = makeRun({ snapshots: [] })
    const result = analyzeRuns(empty, empty)

    expect(result.regressions).toEqual([])
    expect(result.gains).toEqual([])
    expect(result.health.overallCitedRate).toBe(0)
    expect(result.health.totalPairs).toBe(0)
    expect(result.insights).toEqual([])
  })

  it('handles complete citation gain (from nothing to everything)', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
        { keyword: 'k1', provider: 'gemini', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
        { keyword: 'k1', provider: 'gemini', cited: true, citationUrl: 'https://a.com' },
      ],
    })

    const result = analyzeRuns(curr, prev)
    expect(result.regressions).toEqual([])
    expect(result.gains).toHaveLength(2)
    expect(result.health.overallCitedRate).toBe(1.0)
  })
})
