/**
 * Pure scorer for the content recommendation engine.
 *
 * Additive two-branch formula so zero-GSC `create` opportunities still rank
 * (multiplicative formulas collapse to 0 here, silencing the very gaps the
 * engine should surface most loudly):
 *
 *   score = (demand_score + competitor_score) * absence * gapSeverity
 *
 *   demand_score      = log(gscImpressions + 1) * (1 + aiReferralFactor)
 *   competitor_score  = log(competitorCount + 1) * recentMissRate * citationCount
 *   absence           = 1 - ourCitedRate
 *   gapSeverity       = action-typed multiplier (see SEVERITY_BY_ACTION)
 *
 * Every row exposes scoreBreakdown + drivers[] so the recommendation is
 * auditable. No LLM-generated prose; every driver is a derived label.
 */

import type { ContentAction, DemandSource } from '@ainyc/canonry-contracts'

export interface ScorerInput {
  // Demand signals
  gscImpressions: number
  aiReferralFactor: number

  // Competitor signals
  competitorCount: number
  recentMissRate: number
  citationCount: number

  // Our position
  ourCitedRate: number

  // Action context (for gap severity + driver labeling)
  action: ContentAction | null
  position: number | null
}

export interface ScoreBreakdown {
  demand: number
  competitor: number
  absence: number
  gapSeverity: number
}

export interface ScorerOutput {
  score: number
  scoreBreakdown: ScoreBreakdown
  drivers: string[]
  demandSource: DemandSource
}

const SEVERITY_BY_ACTION: Record<ContentAction, number> = {
  create: 1.0,
  'add-schema': 0.7,
  expand: 0.6,
  refresh: 0.4,
}

export function scoreContentTarget(input: ScorerInput): ScorerOutput {
  const demand = computeDemandComponent(input.gscImpressions, input.aiReferralFactor)
  const competitor = computeCompetitorComponent(
    input.competitorCount,
    input.recentMissRate,
    input.citationCount,
  )
  const absence = clamp01(1 - input.ourCitedRate)
  const gapSeverity = input.action ? SEVERITY_BY_ACTION[input.action] : 0

  const score = (demand + competitor) * absence * gapSeverity

  return {
    score,
    scoreBreakdown: { demand, competitor, absence, gapSeverity },
    drivers: buildDrivers(input),
    demandSource: classifyDemandSource(input.gscImpressions, input.competitorCount),
  }
}

function computeDemandComponent(gscImpressions: number, aiReferralFactor: number): number {
  const logImpressions = Math.log(Math.max(gscImpressions, 0) + 1)
  const aiBoost = 1 + Math.max(aiReferralFactor, 0)
  return logImpressions * aiBoost
}

function computeCompetitorComponent(
  competitorCount: number,
  recentMissRate: number,
  citationCount: number,
): number {
  if (competitorCount <= 0) return 0
  const logCompetitors = Math.log(competitorCount + 1)
  return logCompetitors * clamp01(recentMissRate) * Math.max(citationCount, 0)
}

function classifyDemandSource(gscImpressions: number, competitorCount: number): DemandSource {
  const hasGsc = gscImpressions > 0
  const hasCompetitor = competitorCount > 0
  if (hasGsc && hasCompetitor) return 'both'
  if (hasCompetitor) return 'competitor-evidence'
  return 'gsc'
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function buildDrivers(input: ScorerInput): string[] {
  const drivers: string[] = []

  if (input.competitorCount > 0) {
    const noun = input.competitorCount === 1 ? 'competitor' : 'competitors'
    drivers.push(`${input.competitorCount} ${noun} cited`)
  }

  if (input.gscImpressions > 0) {
    drivers.push(`${formatImpressions(input.gscImpressions)} GSC impressions`)
  }

  if (input.recentMissRate >= 0.5 && input.competitorCount > 0) {
    const pct = Math.round(clamp01(input.recentMissRate) * 100)
    drivers.push(`missed in ${pct}% of recent runs`)
  }

  if (input.action === 'create' && input.position === null) {
    drivers.push('no existing page')
  }

  if (input.position !== null && input.position > 30) {
    drivers.push(`page ranks #${input.position} (effectively invisible)`)
  } else if (input.position !== null && input.position > 10) {
    drivers.push(`page ranks #${input.position}`)
  }

  if (input.action === 'add-schema') {
    drivers.push('cited by LLMs but lacks structured data')
  }

  return drivers
}

function formatImpressions(impressions: number): string {
  if (impressions >= 1000) {
    return `${Math.round(impressions / 100) / 10}k`
  }
  return String(impressions)
}
