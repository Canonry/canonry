import { describe, it, expect } from 'vitest'
import { generateInsights, QUERY_LEVEL_PROVIDER } from '../src/insights.js'
import type { Regression, Gain, HealthScore, CauseAnalysis, GenerateInsightsInput } from '../src/index.js'

const defaultHealth: HealthScore = {
  overallCitedRate: 0.5,
  totalPairs: 10,
  citedPairs: 5,
  providerBreakdown: {},
}

function makeInput(overrides: Partial<GenerateInsightsInput> = {}): GenerateInsightsInput {
  return {
    regressions: [],
    gains: [],
    firstCitations: [],
    providerPickups: [],
    persistentGaps: [],
    competitorGains: [],
    competitorLosses: [],
    health: defaultHealth,
    causes: new Map(),
    ...overrides,
  }
}

describe('generateInsights', () => {
  it('returns empty array when no signals are provided', () => {
    expect(generateInsights(makeInput())).toEqual([])
  })

  it('creates one insight per regression with correct structure', () => {
    const regressions: Regression[] = [
      {
        query: 'roof repair',
        provider: 'chatgpt',
        previousCitationUrl: 'example.com',
        currentRunId: 'run_002',
        previousRunId: 'run_001',
      },
    ]

    const insights = generateInsights(makeInput({ regressions }))
    expect(insights).toHaveLength(1)

    const ins = insights[0]!
    expect(ins.type).toBe('regression')
    expect(ins.severity).toBe('high')
    expect(ins.query).toBe('roof repair')
    expect(ins.provider).toBe('chatgpt')
    expect(ins.recommendation?.action).toBe('audit')
    expect(ins.recommendation?.target).toBe('example.com')
    expect(ins.recommendation?.reason).toBe('chatgpt cited example.com for "roof repair" in the previous run but not in this one. Run agent-readiness to check for content or schema issues.')
    expect(ins.id).toMatch(/^ins_/)
  })

  it('creates one insight per gain with correct structure', () => {
    const gains: Gain[] = [
      {
        query: 'roof coating',
        provider: 'gemini',
        citationUrl: 'example.com',
        runId: 'run_002',
      },
    ]

    const insights = generateInsights(makeInput({ gains }))
    expect(insights).toHaveLength(1)

    const ins = insights[0]!
    expect(ins.type).toBe('gain')
    expect(ins.severity).toBe('low')
    expect(ins.recommendation?.action).toBe('monitor')
    expect(ins.recommendation?.reason).toBe('gemini now cites example.com for "roof coating"; the previous run did not. Monitor to confirm the citation persists.')
  })

  // Cited through a grounding source only: no project domain is in the
  // stored source list, so the reason names no host it cannot back.
  it('names no host in regression and gain reasons when the cited domain is unknown', () => {
    const insights = generateInsights(makeInput({
      regressions: [{ query: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' }],
      gains: [{ query: 'k2', provider: 'gemini', runId: 'r2' }],
    }))
    expect(insights.map(ins => ins.recommendation?.reason)).toEqual([
      'chatgpt cited your domain for "k1" in the previous run but not in this one. Run agent-readiness to check for content or schema issues.',
      'gemini now cites your domain for "k2"; the previous run did not. Monitor to confirm the citation persists.',
    ])
  })

  it('attaches cause analysis to regression insights', () => {
    const regressions: Regression[] = [
      { query: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' },
    ]
    const causes = new Map<string, CauseAnalysis>([
      ['k1:chatgpt', { cause: 'competitor_gain', competitorDomain: 'rival.com', details: 'Competitor rival.com displaced us' }],
    ])

    const insights = generateInsights(makeInput({ regressions, causes }))
    expect(insights[0]!.cause?.cause).toBe('competitor_gain')
    expect(insights[0]!.cause?.competitorDomain).toBe('rival.com')
  })

  it('emits a first-citation insight per (query, provider) that started citing a previously-uncited query', () => {
    const insights = generateInsights(makeInput({
      firstCitations: [
        { query: 'k1', provider: 'gemini', citationUrl: 'https://a.com', runId: 'r2' },
        { query: 'k1', provider: 'openai', runId: 'r2' },
      ],
    }))
    expect(insights).toHaveLength(2)
    for (const ins of insights) {
      expect(ins.type).toBe('first-citation')
      expect(ins.severity).toBe('medium')
      expect(ins.query).toBe('k1')
      expect(ins.recommendation?.action).toBe('monitor')
    }
    expect(insights.map(i => i.provider).sort()).toEqual(['gemini', 'openai'])
  })

  it('emits a provider-pickup insight per (query, provider) joining an already-cited query', () => {
    const insights = generateInsights(makeInput({
      providerPickups: [
        { query: 'k1', provider: 'claude', runId: 'r2' },
      ],
    }))
    expect(insights).toHaveLength(1)
    expect(insights[0]!.type).toBe('provider-pickup')
    expect(insights[0]!.severity).toBe('low')
    expect(insights[0]!.provider).toBe('claude')
    expect(insights[0]!.title).toContain('claude')
    expect(insights[0]!.title).toContain('k1')
  })

  it('emits a persistent-gap insight per stale query and uses the query-level provider sentinel', () => {
    const insights = generateInsights(makeInput({
      persistentGaps: [{ query: 'k1', streak: 4, threshold: 3 }],
    }))
    expect(insights).toHaveLength(1)
    expect(insights[0]!.type).toBe('persistent-gap')
    expect(insights[0]!.severity).toBe('medium')
    expect(insights[0]!.provider).toBe(QUERY_LEVEL_PROVIDER)
    expect(insights[0]!.title).toContain('4 runs')
    expect(insights[0]!.recommendation?.action).toBe('audit')
  })

  it('emits competitor-gained / competitor-lost insights with cause metadata', () => {
    const insights = generateInsights(makeInput({
      competitorGains: [{ query: 'k1', competitorDomain: 'rival.com' }],
      competitorLosses: [{ query: 'k2', competitorDomain: 'rival.com' }],
    }))
    expect(insights).toHaveLength(2)

    const gained = insights.find(i => i.type === 'competitor-gained')!
    expect(gained.severity).toBe('medium')
    expect(gained.provider).toBe(QUERY_LEVEL_PROVIDER)
    expect(gained.cause?.cause).toBe('competitor_gain')
    expect(gained.cause?.competitorDomain).toBe('rival.com')

    const lost = insights.find(i => i.type === 'competitor-lost')!
    expect(lost.severity).toBe('low')
    expect(lost.cause?.cause).toBe('competitor_loss')
  })

  it('generates unique ids across heterogeneous signal types', () => {
    const insights = generateInsights(makeInput({
      regressions: [{ query: 'k1', provider: 'chatgpt', currentRunId: 'r2', previousRunId: 'r1' }],
      firstCitations: [{ query: 'k2', provider: 'gemini', runId: 'r2' }],
      persistentGaps: [{ query: 'k3', streak: 3, threshold: 3 }],
      competitorGains: [{ query: 'k4', competitorDomain: 'rival.com' }],
    }))
    const ids = insights.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
