import { describe, it, expect } from 'vitest'
import { generateInsights } from '../src/insights.js'
import type { Regression, Gain, HealthScore, CauseAnalysis } from '../src/types.js'

describe('insights', () => {
  const regressions: Regression[] = [
    {
      keyword: 'roof repair phoenix',
      provider: 'chatgpt',
      previousCitationUrl: 'https://example.com/roof',
      previousPosition: 2,
      currentRunId: 'run_002',
      previousRunId: 'run_001',
    },
  ]

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

  const health: HealthScore = {
    overallCitedRate: 0.62,
    totalPairs: 76,
    citedPairs: 47,
    providerBreakdown: {},
  }

  const causes = new Map<string, CauseAnalysis>()
  causes.set('roof repair phoenix:chatgpt', { cause: 'competitor_gain', competitorDomain: 'roofco.com' })

  it('produces structured insight records', () => {
    const insights = generateInsights(regressions, gains, health, causes)
    expect(insights.length).toBeGreaterThan(0)
    expect(insights[0]).toHaveProperty('id')
    expect(insights[0]).toHaveProperty('type')
    expect(insights[0]).toHaveProperty('severity')
    expect(insights[0]).toHaveProperty('title')
  })

  it('assigns severity: high for regressions, low for gains', () => {
    const insights = generateInsights(regressions, gains, health, causes)
    const regressionInsight = insights.find(i => i.type === 'regression')
    const gainInsight = insights.find(i => i.type === 'gain')
    expect(regressionInsight?.severity).toBe('high')
    expect(gainInsight?.severity).toBe('low')
  })

  it('includes recommendation with action type and target URL', () => {
    const insights = generateInsights(regressions, gains, health, causes)
    const regressionInsight = insights.find(i => i.type === 'regression')
    expect(regressionInsight?.recommendation).toBeDefined()
    expect(regressionInsight?.recommendation?.action).toBe('audit')
    expect(regressionInsight?.recommendation?.target).toBe('https://example.com/roof')
  })
})
