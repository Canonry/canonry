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
        { query: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/1', position: 2 },
        { query: 'k2', provider: 'chatgpt', cited: false },
        { query: 'k2', provider: 'gemini', cited: true, citationUrl: 'https://a.com/2', position: 1 },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },            // regression
        { query: 'k2', provider: 'chatgpt', cited: true, position: 3 }, // gain
        { query: 'k2', provider: 'gemini', cited: true, position: 1 },  // stable
      ],
    })

    const result = analyzeRuns(curr, prev)

    expect(result.regressions).toHaveLength(1)
    expect(result.regressions[0].query).toBe('k1')
    expect(result.regressions[0].provider).toBe('chatgpt')

    expect(result.gains).toHaveLength(1)
    expect(result.gains[0].query).toBe('k2')
    expect(result.gains[0].provider).toBe('chatgpt')

    expect(result.health.overallCitedRate).toBeCloseTo(0.667, 2)
    expect(result.health.totalPairs).toBe(3)
    expect(result.health.citedPairs).toBe(2)
  })

  it('generates one insight per regression and per (gain, first-citation) for a previously-uncited query', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k2', provider: 'chatgpt', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false }, // regression
        { query: 'k2', provider: 'chatgpt', cited: true },  // gain + first-citation (k2 had no cited provider before)
      ],
    })

    const result = analyzeRuns(curr, prev)
    // Additive: regression + gain + first-citation (gain stays for backward compat with consumers).
    expect(result.insights).toHaveLength(3)

    const types = result.insights.map(i => i.type)
    expect(types).toContain('regression')
    expect(types).toContain('gain')
    expect(types).toContain('first-citation')

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
        { query: 'k1', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] },
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
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k2', provider: 'gemini', cited: false },
      ],
    })

    const result = analyzeRuns(run, run)
    expect(result.regressions).toEqual([])
    expect(result.gains).toEqual([])
    expect(result.insights).toEqual([])
    expect(result.health.overallCitedRate).toBe(0.5)
  })

  it('returns no trend when history is not provided', () => {
    const run = makeRun({ snapshots: [{ query: 'k1', provider: 'chatgpt', cited: true }] })
    const result = analyzeRuns(run, run)
    expect(result.trend).toBeUndefined()
  })

  it('computes trend when history is provided', () => {
    const run1 = makeRun({
      runId: 'run_001',
      snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false }],
    })
    const run2 = makeRun({
      runId: 'run_002',
      snapshots: [{ query: 'k1', provider: 'chatgpt', cited: true }],
    })

    const result = analyzeRuns(run2, run1, { history: [run1, run2] })
    expect(result.trend).toBeDefined()
    expect(result.trend!.previous).toBe(0)
    expect(result.trend!.current).toBe(1.0)
    expect(result.trend!.delta).toBe(1.0)
  })

  it('emits first-citation, provider-pickup, persistent-gap, and competitor signals when configured', () => {
    const r1 = makeRun({
      runId: 'r1',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: false },
        { query: 'k2', provider: 'gemini', cited: true },
        { query: 'k3', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] },
        { query: 'k4', provider: 'chatgpt', cited: false },
      ],
    })
    const r2 = makeRun({
      runId: 'r2',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: false },
        { query: 'k2', provider: 'gemini', cited: true },
        { query: 'k3', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] },
        { query: 'k4', provider: 'chatgpt', cited: false },
      ],
    })
    const r3 = makeRun({
      runId: 'r3',
      snapshots: [
        // k1: previously uncited, now cited on gemini → first-citation
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: true, citationUrl: 'https://a.com/k1' },
        // k2: previously cited on gemini, chatgpt picks it up → provider-pickup
        { query: 'k2', provider: 'gemini', cited: true },
        { query: 'k2', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com/k2' },
        // k3: rival.com no longer there → competitor-lost
        { query: 'k3', provider: 'chatgpt', cited: false },
        // k4: still uncited, 3 runs in a row → persistent-gap
        { query: 'k4', provider: 'chatgpt', cited: false },
        // k5: rival.com just appeared on this query → competitor-gained
        { query: 'k5', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] },
      ],
    })

    const result = analyzeRuns(r3, r2, {
      trackedCompetitors: ['rival.com'],
      history: [r1, r2, r3],
    })

    expect(result.firstCitations.map(f => `${f.query}:${f.provider}`)).toEqual(['k1:gemini'])
    expect(result.providerPickups.map(p => `${p.query}:${p.provider}`)).toEqual(['k2:chatgpt'])
    // Both k3 and k4 are uncited for 3 consecutive runs — both qualify as persistent-gaps
    expect(result.persistentGaps.map(g => g.query).sort()).toEqual(['k3', 'k4'])
    expect(result.competitorGains.map(c => `${c.query}:${c.competitorDomain}`)).toEqual(['k5:rival.com'])
    expect(result.competitorLosses.map(c => `${c.query}:${c.competitorDomain}`)).toEqual(['k3:rival.com'])

    const types = result.insights.map(i => i.type)
    expect(types).toContain('first-citation')
    expect(types).toContain('provider-pickup')
    expect(types).toContain('persistent-gap')
    expect(types).toContain('competitor-gained')
    expect(types).toContain('competitor-lost')
  })

  it('skips persistent-gap detection when history shorter than threshold', () => {
    const r1 = makeRun({ runId: 'r1', snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false }] })
    const r2 = makeRun({ runId: 'r2', snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false }] })

    const result = analyzeRuns(r2, r1, { history: [r1, r2] })
    expect(result.persistentGaps).toEqual([])
  })

  it('skips competitor signals when no competitors are tracked', () => {
    const r1 = makeRun({ runId: 'r1', snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] }] })
    const r2 = makeRun({ runId: 'r2', snapshots: [{ query: 'k1', provider: 'chatgpt', cited: false }] })

    const result = analyzeRuns(r2, r1, { history: [r1, r2] })
    expect(result.competitorGains).toEqual([])
    expect(result.competitorLosses).toEqual([])
  })

  it('handles complete citation loss across all providers', () => {
    const prev = makeRun({
      runId: 'run_001',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true },
        { query: 'k1', provider: 'gemini', cited: true },
        { query: 'k2', provider: 'chatgpt', cited: true },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: false },
        { query: 'k2', provider: 'chatgpt', cited: false },
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
        { query: 'k1', provider: 'chatgpt', cited: false },
        { query: 'k1', provider: 'gemini', cited: false },
      ],
    })
    const curr = makeRun({
      runId: 'run_002',
      snapshots: [
        { query: 'k1', provider: 'chatgpt', cited: true, citationUrl: 'https://a.com' },
        { query: 'k1', provider: 'gemini', cited: true, citationUrl: 'https://a.com' },
      ],
    })

    const result = analyzeRuns(curr, prev)
    expect(result.regressions).toEqual([])
    expect(result.gains).toHaveLength(2)
    expect(result.health.overallCitedRate).toBe(1.0)
  })
})
