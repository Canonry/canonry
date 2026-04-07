import { randomUUID } from 'node:crypto'
import type { Regression, Gain, HealthScore, CauseAnalysis, Insight } from './types.js'

export function generateInsights(
  regressions: Regression[],
  gains: Gain[],
  health: HealthScore,
  causes: Map<string, CauseAnalysis>
): Insight[] {
  const insights: Insight[] = []
  const now = new Date().toISOString()

  // Regression insights
  for (const reg of regressions) {
    const key = `${reg.keyword}:${reg.provider}`
    const cause = causes.get(key)

    insights.push({
      id: `ins_${randomUUID().slice(0, 8)}`,
      type: 'regression',
      severity: 'high',
      title: `Lost ${reg.provider} citation for "${reg.keyword}"`,
      keyword: reg.keyword,
      provider: reg.provider,
      recommendation: {
        action: 'audit',
        target: reg.previousCitationUrl,
        reason: `Page was previously cited at position ${reg.previousPosition ?? 'unknown'}. Run aeo-audit to check for content or schema issues.`,
      },
      cause,
      createdAt: now,
    })
  }

  // Gain insights
  for (const gain of gains) {
    insights.push({
      id: `ins_${randomUUID().slice(0, 8)}`,
      type: 'gain',
      severity: 'low',
      title: `New ${gain.provider} citation for "${gain.keyword}"`,
      keyword: gain.keyword,
      provider: gain.provider,
      recommendation: {
        action: 'monitor',
        target: gain.citationUrl,
        reason: `New citation appeared at position ${gain.position ?? 'unknown'}. Monitor to confirm it persists.`,
      },
      createdAt: now,
    })
  }

  return insights
}
