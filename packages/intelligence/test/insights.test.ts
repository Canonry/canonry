import { describe, it, expect } from 'vitest'
import { generateInsights } from '../src/insights.js'
import type { Regression, Gain, HealthScore, CauseAnalysis } from '../src/types.js'

const defaultHealth: HealthScore = {
  overallCitedRate: 0.5,
  totalPairs: 10,
  citedPairs: 5,
  providerBreakdown: {},
}

describe('generateInsights', () => {
  it('returns empty array when no regressions or gains', () => {
    const insights = generateInsights([], [], defaultHealth, new Map())
    expect(insights).toEqual([])
  })

  it('creates one insight per regression with correct structure', () => {
    const regressions: Regression[] = [
      {
        keyword: 'roof repair',
        provider: 'chatgpt',
        previousCitationUrl: 'https://example.com/roof',
        previousPosition: 2,
        currentRunId: 'run_002',
        previousRunId: 'run_001',
      },
    ]

    const insights = generateInsights(regressions, [], defaultHealth, new Map())
    expect(insights).toHaveLength(1)

    const ins = insights[0]
    expect(ins.type).toBe('regression')
    expect(ins.severity).toBe('high')
    expect(ins.keyword).toBe('roof repair')
    expect(ins.provider).toBe('chatgpt')
    expect(ins.title).toContain('chatgpt')
    expect(ins.title).toContain('roof repair')
    expect(ins.recommendation?.action).toBe('audit')
    expect(ins.recommendation?.target).toBe('https://example.com/roof')
    expect(ins.recommendation?.reason).toContain('position 2')
    expect(ins.id).toMatch(/^ins_/)
    expect(ins.createdAt).toBeTruthy()
  })

  it('creates one insight per gain with correct structure', () => {
    const gains: Gain[] = [
      {
        keyword: 'roof coating',
        provider: 'gemini',
        citationUrl: 'https://example.com/coating',
        position: 1,
        snippet: 'Great coating',
        runId: 'run_002',
      },
    ]

    const insights = generateInsights([], gains, defaultHealth, new Map())
    expect(insights).toHaveLength(1)

    const ins = insights[0]
    expect(ins.type).toBe('gain')
    expect(ins.severity).toBe('low')
    expect(ins.keyword).toBe('roof coating')
    expect(ins.provider).toBe('gemini')
    expect(ins.recommendation?.action).toBe('monitor')
    expect(ins.recommendation?.target).toBe('https://example.com/coating')
    expect(ins.recommendation?.reason).toContain('position 1')
  })

  it('attaches cause analysis to regression insights', () => {
    const regressions: Regression[] = [
      {
        keyword: 'k1',
        provider: 'chatgpt',
        currentRunId: 'run_002',
        previousRunId: 'run_001',
      },
    ]
    const causes = new Map<string, CauseAnalysis>([
      ['k1:chatgpt', { cause: 'competitor_gain', competitorDomain: 'rival.com', details: 'Competitor rival.com displaced us' }],
    ])

    const insights = generateInsights(regressions, [], defaultHealth, causes)
    expect(insights[0].cause).toBeDefined()
    expect(insights[0].cause!.cause).toBe('competitor_gain')
    expect(insights[0].cause!.competitorDomain).toBe('rival.com')
  })

  it('does not attach cause to gain insights', () => {
    const gains: Gain[] = [
      { keyword: 'k1', provider: 'chatgpt', runId: 'run_002' },
    ]
    const causes = new Map<string, CauseAnalysis>([
      ['k1:chatgpt', { cause: 'competitor_gain', competitorDomain: 'rival.com' }],
    ])

    const insights = generateInsights([], gains, defaultHealth, causes)
    expect(insights[0].cause).toBeUndefined()
  })

  it('handles multiple regressions and gains together', () => {
    const regressions: Regression[] = [
      { keyword: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
      { keyword: 'k2', provider: 'gemini', currentRunId: 'r2', previousRunId: 'r1' },
    ]
    const gains: Gain[] = [
      { keyword: 'k3', provider: 'chatgpt', runId: 'r2' },
      { keyword: 'k4', provider: 'claude', runId: 'r2' },
    ]

    const insights = generateInsights(regressions, gains, defaultHealth, new Map())
    expect(insights).toHaveLength(4)

    const regressionInsights = insights.filter(i => i.type === 'regression')
    const gainInsights = insights.filter(i => i.type === 'gain')
    expect(regressionInsights).toHaveLength(2)
    expect(gainInsights).toHaveLength(2)

    // Regressions come first in output
    expect(insights[0].type).toBe('regression')
    expect(insights[1].type).toBe('regression')
    expect(insights[2].type).toBe('gain')
    expect(insights[3].type).toBe('gain')
  })

  it('generates unique IDs for each insight', () => {
    const regressions: Regression[] = [
      { keyword: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
      { keyword: 'k2', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
    ]

    const insights = generateInsights(regressions, [], defaultHealth, new Map())
    const ids = insights.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('handles regression with undefined previousPosition gracefully', () => {
    const regressions: Regression[] = [
      { keyword: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
    ]

    const insights = generateInsights(regressions, [], defaultHealth, new Map())
    expect(insights[0].recommendation?.reason).toContain('unknown')
  })

  it('handles regression without a cause in the map', () => {
    const regressions: Regression[] = [
      { keyword: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
    ]

    const insights = generateInsights(regressions, [], defaultHealth, new Map())
    expect(insights[0].cause).toBeUndefined()
  })
})
