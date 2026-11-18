import type { ProjectOverviewCompetitorDto, RetrievalStatus, ScoreSummaryDto } from '@canonry/canonry-contracts'
import { hostMatchesAnyDomain, hostMatchesDomain, RetrievalStatuses } from '@canonry/canonry-contracts'
import { pressureTone } from './score-tones.js'

export interface CompetitorPressureSnapshot {
  queryId: string
  /**
   * Whether this answer ran a retrieval step. Null / absent for rows written
   * before retrieval was recorded: they stay in the cited denominators. The
   * builders below read it to leave `not-used` answers out of the cited
   * populations (#1161).
   */
  retrievalStatus?: RetrievalStatus | null
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
  /** Answer-derived auto names (already minus blocked), echoed for display. */
  autoAliasNames?: readonly string[]
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
 *
 * An answer the provider wrote with no retrieval step at all
 * (`retrievalStatus = 'not-used'`) cites nothing by construction, so it
 * leaves the cited numerator AND denominator rather than counting as a
 * searched miss, and is counted in `excludedNoRetrieval`. Rows that predate
 * retrieval recording (`retrievalStatus` null / absent) are NOT excluded — an
 * unobserved absence is not an observed one.
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

  const checkedSnapshots = snapshots.filter(snap => snap.retrievalStatus !== RetrievalStatuses['not-used'])
  const excludedNoRetrieval = snapshots.length - checkedSnapshots.length
  if (checkedSnapshots.length === 0) {
    // Every answer in the run was written without a web search: there is no
    // searched citation to score, so the gauge reads "None" rather than a
    // ratio that would claim a measured miss.
    return {
      label: 'Competitor Pressure',
      value: 'None',
      delta: 'No searched answers to score',
      tone: pressureTone('None'),
      description: 'Every answer in the latest run was written without a web search, so no searched citation was measured.',
      tooltip,
      trend: [],
      ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
    }
  }

  let overlapCount = 0
  for (const snap of checkedSnapshots) {
    if (snap.citedDomains.some(domain => hostMatchesAnyDomain(domain, competitorDomains))) {
      overlapCount++
    }
  }
  const ratio = overlapCount / checkedSnapshots.length
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
    // Present only when nonzero, so a smaller cited denominator is always
    // visible next to the rate it shrank.
    ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
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
 * lookup is provided; falls back to queryId when missing. A query whose
 * answers were all written with no web search leaves the denominator
 * (`excludedNoRetrieval`); rows that predate retrieval recording stay in.
 */
export function buildOverviewCompetitors(
  snapshots: readonly CompetitorPressureSnapshot[],
  competitors: readonly CompetitorRow[],
  queryLookup?: OverviewCompetitorsQueryLookup,
): ProjectOverviewCompetitorDto[] {
  // A query stays in the cited denominator only when at least one snapshot
  // for it ran a search (#1161): a query whose answers were all written
  // with no retrieval step never had a chance to cite, so it leaves the
  // population rather than counting as a searched miss. Rows that predate
  // retrieval recording stay in. The count rides in `excludedNoRetrieval`.
  const allQueryIds = new Set<string>()
  const checkedQueryIds = new Set<string>()
  for (const snap of snapshots) {
    if (!snap.queryId) continue
    allQueryIds.add(snap.queryId)
    if (snap.retrievalStatus === RetrievalStatuses['not-used']) continue
    checkedQueryIds.add(snap.queryId)
  }
  const excludedNoRetrieval = allQueryIds.size - checkedQueryIds.size

  const renderQuery = (queryId: string): string =>
    queryLookup?.byId.get(queryId) ?? queryId

  return competitors.map((competitor, index) => {
    const citedQuerySet = new Set<string>()
    for (const snap of snapshots) {
      // A no-search answer never had a chance to cite; it must not mark its
      // query either way. Only searched snapshots decide the query.
      if (snap.retrievalStatus === RetrievalStatuses['not-used']) continue
      if (snap.citedDomains.some(domain => hostMatchesDomain(domain, competitor.domain))) {
        if (snap.queryId) citedQuerySet.add(snap.queryId)
      }
    }
    const citedQueries = [...citedQuerySet].map(renderQuery).sort()
    const ratio = checkedQueryIds.size > 0 ? citedQuerySet.size / checkedQueryIds.size : 0
    const pressureLabel: CompetitorPressureLabel =
      ratio >= 0.5 ? 'High'
      : ratio >= 0.2 ? 'Moderate'
      : citedQuerySet.size > 0 ? 'Low'
      : 'None'

    return {
      id: competitor.id || `comp_${index}`,
      domain: competitor.domain,
      ...(competitor.aliases ? { aliases: [...competitor.aliases] } : {}),
      ...(competitor.autoAliasNames?.length ? { autoAliasNames: [...competitor.autoAliasNames] } : {}),
      citationCount: citedQuerySet.size,
      totalQueries: checkedQueryIds.size,
      pressureLabel,
      citedQueries,
      // Present only when nonzero, so a smaller cited denominator is always
      // visible next to the rate it shrank.
      ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
    }
  })
}
