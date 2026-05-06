import { CitationStates, type ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { gapTone } from './score-tones.js'

export interface GapQueryScoreSnapshot {
  queryId: string
  citationState: string
  competitorOverlap: string[]
}

/**
 * Computes the "Gap Queries" score gauge — tracked queries where a competitor
 * is cited but the project is not. A query counts as a gap when:
 *   1. No snapshot for that query has citationState='cited' for the project
 *   2. At least one snapshot has a non-empty competitorOverlap
 *
 * The gauge value is the gap count itself (so the dashboard reads the magnitude
 * directly), with `progress` set to the 0–100 percentage of tracked queries
 * that are gaps.
 */
export function buildGapQueryScore(
  snapshots: readonly GapQueryScoreSnapshot[],
): ScoreSummaryDto {
  const tooltip = 'Tracked queries where a competitor is cited in the latest run but your domain is not.'

  if (snapshots.length === 0) {
    return {
      label: 'Gap Queries',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'Run a visibility sweep to identify queries where competitors are cited and your domain is not.',
      tooltip,
      trend: [],
    }
  }

  const byQuery = new Map<string, { cited: boolean; competitorOverlap: Set<string> }>()
  for (const snap of snapshots) {
    const key = snap.queryId
    const current = byQuery.get(key) ?? { cited: false, competitorOverlap: new Set<string>() }
    if (snap.citationState === CitationStates.cited) current.cited = true
    for (const domain of snap.competitorOverlap) current.competitorOverlap.add(domain)
    byQuery.set(key, current)
  }

  const totalCount = byQuery.size
  const gapCount = [...byQuery.values()].filter(
    entry => !entry.cited && entry.competitorOverlap.size > 0,
  ).length
  const gapQueryLabel = gapCount === 1 ? 'query' : 'queries'

  return {
    label: 'Gap Queries',
    value: `${gapCount}`,
    delta: `${gapCount} of ${totalCount} queries at risk`,
    tone: gapTone(gapCount, totalCount),
    description: gapCount > 0
      ? `${gapCount} tracked ${gapQueryLabel} currently cite competitors without citing your domain.`
      : 'No competitive query gaps detected in the latest visibility run.',
    tooltip,
    trend: [],
    progress: totalCount > 0 ? Math.round((gapCount / totalCount) * 100) : 0,
  }
}
