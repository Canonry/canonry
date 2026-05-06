import type { ProjectOverviewCompetitorDto, ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { pressureTone } from './score-tones.js'

export interface CompetitorPressureSnapshot {
  queryId: string
  competitorOverlap: string[]
  citedDomains: string[]
}

export interface CompetitorRow {
  id?: string
  domain: string
}

export type CompetitorPressureLabel = 'None' | 'Low' | 'Moderate' | 'High'

/**
 * Computes the "Competitor Pressure" score gauge — how often configured
 * competitors appear alongside the project in the latest run. Pressure is
 * computed at the snapshot level (per provider × query): a snapshot counts
 * toward overlap when its competitorOverlap intersects the configured set.
 *
 * Bands match the dashboard's existing thresholds:
 *   ratio >= 0.5 → High
 *   ratio >= 0.2 → Moderate
 *   ratio  > 0   → Low
 *   no overlap   → None
 */
export function buildCompetitorPressureScore(
  snapshots: readonly CompetitorPressureSnapshot[],
  competitorDomains: readonly string[],
  totalTrackedCompetitors: number,
): ScoreSummaryDto {
  const tooltip = 'How often competitor domains appear alongside yours in AI answers. High pressure means competitors are frequently cited for the same queries.'
  const description = totalTrackedCompetitors > 0
    ? `${totalTrackedCompetitors} competitor${totalTrackedCompetitors > 1 ? 's' : ''} tracked.`
    : 'No competitors configured.'

  if (snapshots.length === 0 || competitorDomains.length === 0) {
    return {
      label: 'Competitor Pressure',
      value: 'None',
      delta: 'No overlap detected',
      tone: pressureTone('None'),
      description,
      tooltip,
      trend: [],
    }
  }

  const competitorSet = new Set(competitorDomains)
  let overlapCount = 0
  for (const snap of snapshots) {
    if (snap.competitorOverlap.some(d => competitorSet.has(d))) {
      overlapCount++
    }
  }
  const ratio = overlapCount / snapshots.length
  const label: CompetitorPressureLabel =
    ratio >= 0.5 ? 'High'
    : ratio >= 0.2 ? 'Moderate'
    : overlapCount > 0 ? 'Low'
    : 'None'

  return {
    label: 'Competitor Pressure',
    value: label,
    delta: overlapCount > 0 ? `${overlapCount} overlapping citations` : 'No overlap detected',
    tone: pressureTone(label),
    description,
    tooltip,
    trend: [],
  }
}

export interface OverviewCompetitorsQueryLookup {
  byId: Map<string, string>
}

/**
 * Per-competitor rows for the overview competitor list. A competitor "cites"
 * a query when at least one snapshot for that query carries the competitor
 * domain in either `citedDomains` or `competitorOverlap`. Pressure label uses
 * the same bands as the gauge but computed per-competitor against the unique
 * query count. `citedQueries` returns query *text* (for presentation) when a
 * lookup is provided; falls back to queryId when missing.
 */
export function buildOverviewCompetitors(
  snapshots: readonly CompetitorPressureSnapshot[],
  competitors: readonly CompetitorRow[],
  queryLookup?: OverviewCompetitorsQueryLookup,
): ProjectOverviewCompetitorDto[] {
  const uniqueQueries = new Set<string>()
  for (const snap of snapshots) {
    if (snap.queryId) uniqueQueries.add(snap.queryId)
  }

  const renderQuery = (queryId: string): string =>
    queryLookup?.byId.get(queryId) ?? queryId

  return competitors.map((competitor, index) => {
    const citedQuerySet = new Set<string>()
    for (const snap of snapshots) {
      if (
        snap.competitorOverlap.includes(competitor.domain)
        || snap.citedDomains.includes(competitor.domain)
      ) {
        if (snap.queryId) citedQuerySet.add(snap.queryId)
      }
    }
    const citedQueries = [...citedQuerySet].map(renderQuery).sort()
    const ratio = uniqueQueries.size > 0 ? citedQuerySet.size / uniqueQueries.size : 0
    const pressureLabel: CompetitorPressureLabel =
      ratio >= 0.5 ? 'High'
      : ratio >= 0.2 ? 'Moderate'
      : citedQuerySet.size > 0 ? 'Low'
      : 'None'

    return {
      id: competitor.id || `comp_${index}`,
      domain: competitor.domain,
      citationCount: citedQuerySet.size,
      totalQueries: uniqueQueries.size,
      pressureLabel,
      citedQueries,
    }
  })
}
