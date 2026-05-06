import { randomUUID } from 'node:crypto'
import type {
  Regression,
  Gain,
  HealthScore,
  CauseAnalysis,
  Insight,
  FirstCitation,
  ProviderPickup,
  PersistentGap,
  CompetitorChange,
} from './types.js'

/** Sentinel `provider` value for query-level insights that don't tie to a single provider. */
export const QUERY_LEVEL_PROVIDER = 'all'

export interface GenerateInsightsInput {
  regressions: Regression[]
  gains: Gain[]
  firstCitations: FirstCitation[]
  providerPickups: ProviderPickup[]
  persistentGaps: PersistentGap[]
  competitorGains: CompetitorChange[]
  competitorLosses: CompetitorChange[]
  health: HealthScore
  causes: Map<string, CauseAnalysis>
}

export function generateInsights(input: GenerateInsightsInput): Insight[] {
  const insights: Insight[] = []
  const now = new Date().toISOString()
  const id = () => `ins_${randomUUID().slice(0, 8)}`

  for (const reg of input.regressions) {
    const cause = input.causes.get(`${reg.query}:${reg.provider}`)
    insights.push({
      id: id(),
      type: 'regression',
      severity: 'high',
      title: `Lost ${reg.provider} citation for "${reg.query}"`,
      query: reg.query,
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

  for (const gain of input.gains) {
    insights.push({
      id: id(),
      type: 'gain',
      severity: 'low',
      title: `New ${gain.provider} citation for "${gain.query}"`,
      query: gain.query,
      provider: gain.provider,
      recommendation: {
        action: 'monitor',
        target: gain.citationUrl,
        reason: `New citation appeared at position ${gain.position ?? 'unknown'}. Monitor to confirm it persists.`,
      },
      createdAt: now,
    })
  }

  for (const fc of input.firstCitations) {
    insights.push({
      id: id(),
      type: 'first-citation',
      severity: 'medium',
      title: `First citation for "${fc.query}" on ${fc.provider}`,
      query: fc.query,
      provider: fc.provider,
      recommendation: {
        action: 'monitor',
        target: fc.citationUrl,
        reason: `"${fc.query}" had not been cited by any provider before this run. Monitor to confirm the citation persists.`,
      },
      createdAt: now,
    })
  }

  for (const pp of input.providerPickups) {
    insights.push({
      id: id(),
      type: 'provider-pickup',
      severity: 'low',
      title: `${pp.provider} picked up "${pp.query}"`,
      query: pp.query,
      provider: pp.provider,
      recommendation: {
        action: 'monitor',
        target: pp.citationUrl,
        reason: `${pp.provider} started citing "${pp.query}" alongside other providers. Monitor to confirm the citation persists.`,
      },
      createdAt: now,
    })
  }

  for (const gap of input.persistentGaps) {
    insights.push({
      id: id(),
      type: 'persistent-gap',
      severity: 'medium',
      title: `"${gap.query}" uncited for ${gap.streak} runs`,
      query: gap.query,
      provider: QUERY_LEVEL_PROVIDER,
      recommendation: {
        action: 'audit',
        reason: `No provider has cited "${gap.query}" for ${gap.streak} consecutive runs. Audit content and schema for this topic.`,
      },
      createdAt: now,
    })
  }

  for (const cg of input.competitorGains) {
    insights.push({
      id: id(),
      type: 'competitor-gained',
      severity: 'medium',
      title: `${cg.competitorDomain} appeared on "${cg.query}"`,
      query: cg.query,
      provider: QUERY_LEVEL_PROVIDER,
      cause: {
        cause: 'competitor_gain',
        competitorDomain: cg.competitorDomain,
        details: `Tracked competitor ${cg.competitorDomain} just got cited on "${cg.query}".`,
      },
      recommendation: {
        action: 'audit',
        reason: `Investigate ${cg.competitorDomain}'s content for "${cg.query}" — they just earned a citation here.`,
      },
      createdAt: now,
    })
  }

  for (const cl of input.competitorLosses) {
    insights.push({
      id: id(),
      type: 'competitor-lost',
      severity: 'low',
      title: `${cl.competitorDomain} dropped from "${cl.query}"`,
      query: cl.query,
      provider: QUERY_LEVEL_PROVIDER,
      cause: {
        cause: 'competitor_loss',
        competitorDomain: cl.competitorDomain,
        details: `Tracked competitor ${cl.competitorDomain} lost their citation on "${cl.query}".`,
      },
      recommendation: {
        action: 'monitor',
        reason: `Opportunity: ${cl.competitorDomain} just lost "${cl.query}". Tighten your own coverage to fill the gap.`,
      },
      createdAt: now,
    })
  }

  return insights
}
