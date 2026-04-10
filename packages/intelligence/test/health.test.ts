import { describe, it, expect } from 'vitest'
import { computeHealth, computeHealthTrend } from '../src/health.js'
import type { RunData } from '../src/types.js'

function makeRun(overrides: Partial<RunData> & Pick<RunData, 'snapshots'>): RunData {
  return {
    runId: 'run_default',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('computeHealth', () => {
  it('computes correct overall rate and per-provider breakdown', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k1', provider: 'gemini', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: false },
        { keyword: 'k2', provider: 'gemini', cited: true },
      ],
    })

    const health = computeHealth(run)
    expect(health.overallCitedRate).toBe(0.75)
    expect(health.totalPairs).toBe(4)
    expect(health.citedPairs).toBe(3)
    expect(health.providerBreakdown.chatgpt).toEqual({ citedRate: 0.5, cited: 1, total: 2 })
    expect(health.providerBreakdown.gemini).toEqual({ citedRate: 1.0, cited: 2, total: 2 })
  })

  it('returns 0 rate for empty snapshots', () => {
    const run = makeRun({ snapshots: [] })
    const health = computeHealth(run)
    expect(health.overallCitedRate).toBe(0)
    expect(health.totalPairs).toBe(0)
    expect(health.citedPairs).toBe(0)
    expect(health.providerBreakdown).toEqual({})
  })

  it('returns 1.0 when all snapshots are cited', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: true },
        { keyword: 'k3', provider: 'chatgpt', cited: true },
      ],
    })

    const health = computeHealth(run)
    expect(health.overallCitedRate).toBe(1.0)
    expect(health.citedPairs).toBe(3)
  })

  it('returns 0 when no snapshots are cited', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: false },
        { keyword: 'k2', provider: 'gemini', cited: false },
      ],
    })

    const health = computeHealth(run)
    expect(health.overallCitedRate).toBe(0)
    expect(health.citedPairs).toBe(0)
  })

  it('handles a single provider correctly', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: false },
      ],
    })

    const health = computeHealth(run)
    expect(Object.keys(health.providerBreakdown)).toEqual(['chatgpt'])
    expect(health.providerBreakdown.chatgpt).toEqual({ citedRate: 0.5, cited: 1, total: 2 })
  })

  it('handles many providers', () => {
    const providers = ['chatgpt', 'gemini', 'claude', 'perplexity']
    const run = makeRun({
      snapshots: providers.map((p, i) => ({
        keyword: 'k1',
        provider: p,
        cited: i < 2, // first two cited
      })),
    })

    const health = computeHealth(run)
    expect(health.overallCitedRate).toBe(0.5)
    expect(Object.keys(health.providerBreakdown).sort()).toEqual(providers.sort())
    expect(health.providerBreakdown.chatgpt.citedRate).toBe(1.0)
    expect(health.providerBreakdown.claude.citedRate).toBe(0)
  })
})

describe('computeHealthTrend', () => {
  it('returns zeros for empty run list', () => {
    const trend = computeHealthTrend([])
    expect(trend).toEqual({ current: 0, previous: 0, delta: 0 })
  })

  it('treats single run as full delta from zero', () => {
    const run = makeRun({
      snapshots: [
        { keyword: 'k1', provider: 'chatgpt', cited: true },
        { keyword: 'k2', provider: 'chatgpt', cited: true },
      ],
    })

    const trend = computeHealthTrend([run])
    expect(trend.current).toBe(1.0)
    expect(trend.previous).toBe(0)
    expect(trend.delta).toBe(1.0)
  })

  it('computes positive delta when health improves', () => {
    const runs: RunData[] = [
      makeRun({
        runId: 'run_001',
        snapshots: [
          { keyword: 'k1', provider: 'chatgpt', cited: false },
          { keyword: 'k2', provider: 'chatgpt', cited: false },
        ],
      }),
      makeRun({
        runId: 'run_002',
        snapshots: [
          { keyword: 'k1', provider: 'chatgpt', cited: true },
          { keyword: 'k2', provider: 'chatgpt', cited: true },
        ],
      }),
    ]

    const trend = computeHealthTrend(runs)
    expect(trend.previous).toBe(0)
    expect(trend.current).toBe(1.0)
    expect(trend.delta).toBe(1.0)
  })

  it('computes negative delta when health declines', () => {
    const runs: RunData[] = [
      makeRun({
        runId: 'run_001',
        snapshots: [
          { keyword: 'k1', provider: 'chatgpt', cited: true },
          { keyword: 'k2', provider: 'chatgpt', cited: true },
        ],
      }),
      makeRun({
        runId: 'run_002',
        snapshots: [
          { keyword: 'k1', provider: 'chatgpt', cited: false },
          { keyword: 'k2', provider: 'chatgpt', cited: false },
        ],
      }),
    ]

    const trend = computeHealthTrend(runs)
    expect(trend.previous).toBe(1.0)
    expect(trend.current).toBe(0)
    expect(trend.delta).toBe(-1.0)
  })

  it('uses last two runs only, ignoring earlier runs', () => {
    const runs: RunData[] = [
      makeRun({ runId: 'oldest', snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: true }] }),
      makeRun({ runId: 'prev', snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: false }] }),
      makeRun({ runId: 'curr', snapshots: [{ keyword: 'k1', provider: 'chatgpt', cited: true }] }),
    ]

    const trend = computeHealthTrend(runs)
    expect(trend.previous).toBe(0)   // prev run: 0/1
    expect(trend.current).toBe(1.0)  // curr run: 1/1
    expect(trend.delta).toBe(1.0)
  })

  it('returns zero delta when health is stable', () => {
    const snapshot = [{ keyword: 'k1', provider: 'chatgpt', cited: true }]
    const runs = [
      makeRun({ runId: 'run_001', snapshots: snapshot }),
      makeRun({ runId: 'run_002', snapshots: snapshot }),
    ]

    const trend = computeHealthTrend(runs)
    expect(trend.delta).toBe(0)
    expect(trend.current).toBe(trend.previous)
  })
})
