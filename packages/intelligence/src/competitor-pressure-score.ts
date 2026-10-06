import type { ProjectOverviewCompetitorDto, ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { hostMatchesAnyDomain, hostMatchesDomain } from '@ainyc/canonry-contracts'
import { pressureTone } from './score-tones.js'

export interface CompetitorPressureSnapshot {
  queryId: string
  /**
   * The engine's source list. This is the ONLY input to the figures below,
   * because every one of them is named for the citation signal.
   *
   * `query_snapshots.competitor_overlap` is deliberately not read here. That
   * column is a MIXED signal — the run writer unions cited domains, grounding
   * sources AND answer-text brand matches into it — so a count taken from it is
   * neither a citation count nor a mention count, and labelling it either one
   * states a number for one signal under the other's name.
   */
  citedDomains: string[]
}

export interface CompetitorRow {
  id?: string
  domain: string
  /** Operator-curated answer-text names, echoed for display. Citation pressure never reads them. */
  aliases?: readonly string[]
}

export type CompetitorPressureLabel = 'None' | 'Low' | 'Moderate' | 'High'

/**
 * Computes the "Competitor Pressure" score gauge — how often configured
 * competitors are CITED alongside the project in the latest run. Pressure is
 * computed at the snapshot level (per provider × query): a snapshot counts
 * toward overlap when its cited source list intersects the configured set.
 * This is the citation signal only; the mention signal is Mention Share.
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

  let overlapCount = 0
  for (const snap of snapshots) {
    if (snap.citedDomains.some(domain => hostMatchesAnyDomain(domain, competitorDomains))) {
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
 * domain in `citedDomains` — the engine's source list, and nothing else, since
 * every field here is named for the citation signal. Pressure label uses
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
      if (snap.citedDomains.some(domain => hostMatchesDomain(domain, competitor.domain))) {
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
      ...(competitor.aliases ? { aliases: [...competitor.aliases] } : {}),
      citationCount: citedQuerySet.size,
      totalQueries: uniqueQueries.size,
      pressureLabel,
      citedQueries,
    }
  })
}
