import { CitationStates, formatPercent, percentOf, RetrievalStatuses, type RetrievalStatus, type ScoreSummaryDto } from '@canonry/canonry-contracts'
import { scoreTone } from './score-tones.js'

export interface VisibilityScoreSnapshot {
  queryId: string
  provider: string
  citationState: string
  /** Absent / null for rows written before retrieval was recorded: they stay in the cited denominator. */
  retrievalStatus?: RetrievalStatus | null
}

export interface VisibilityScoreOptions {
  /**
   * Project's configured API providers (i.e. the providers section of canonry.yaml,
   * minus any `cdp:*` browser-flavored aliases). Used to detect partial-provider runs.
   */
  configuredApiProviders: readonly string[]
}

/**
 * Computes the "Citation Coverage" score gauge — the headline metric for the
 * project page. A query counts as cited when at least one snapshot for that
 * query has `citationState === 'cited'`. The score is the percentage of cited
 * queries, 0..100 at wire precision in `progress`, and `value` is the same share
 * through `formatPercent` ("66.7%").
 *
 * Label history: this gauge was previously labelled "Answer Visibility". The
 * old name conflicted with AGENTS.md vocabulary rules — "visibility" is the
 * legacy alias for the mention signal (answer-text presence), but this metric
 * reads `citationState`, not `answerMentioned`. The rename brings the label
 * in line with the data it counts. The mention-equivalent metric does not
 * exist yet; if/when it does it will be a parallel `buildMentionCoverage`.
 *
 * When the run only covers a subset of configured providers, tone shifts to
 * caution and a providerCoverage label is set, even if the score is high. The
 * dashboard renders that label inside the gauge.
 *
 * An answer the provider wrote with no retrieval step at all
 * (`retrievalStatus = 'not-used'`) cites nothing by construction, so its
 * query leaves the cited population rather than counting as a searched miss
 * when every snapshot for that query is unsearched; the count rides in
 * `excludedNoRetrieval`. Rows that predate retrieval recording
 * (`retrievalStatus` null / absent) are NOT excluded — an unobserved
 * absence is not an observed one. A query with at least one searched
 * snapshot stays in, cited when any searched snapshot is cited.
 */
export function buildVisibilityScore(
  snapshots: readonly VisibilityScoreSnapshot[],
  options: VisibilityScoreOptions,
): ScoreSummaryDto {
  const tooltip = 'An AI engine used a page on your domain as a source for its answer.'

  if (snapshots.length === 0) {
    return {
      label: 'Citation Coverage',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No citation data yet. Trigger a run to start tracking.',
      tooltip,
      trend: [],
    }
  }

  const queryCited = new Map<string, boolean>()
  const queryChecked = new Set<string>()
  for (const snap of snapshots) {
    // A no-search answer never had a chance to cite; it must not mark its
    // query either way. Only searched snapshots decide the query.
    if (snap.retrievalStatus === RetrievalStatuses['not-used']) continue
    queryChecked.add(snap.queryId)
    if (!queryCited.has(snap.queryId)) queryCited.set(snap.queryId, false)
    if (snap.citationState === CitationStates.cited) queryCited.set(snap.queryId, true)
  }
  const allQueryIds = new Set(snapshots.map(s => s.queryId))
  const excludedNoRetrieval = allQueryIds.size - queryChecked.size
  const totalCount = queryCited.size
  const citedCount = [...queryCited.values()].filter(Boolean).length

  if (totalCount === 0) {
    // Every answer in the run was written without a web search: there is no
    // searched citation to score, so the gauge reads "No data" rather than a
    // 0% that would claim a measured miss.
    return {
      label: 'Citation Coverage',
      value: 'No data',
      delta: 'No searched answers to score',
      tone: 'neutral',
      description: 'Every answer in the latest run was written without a web search, so no searched citation was measured.',
      tooltip,
      trend: [],
      ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
    }
  }

  const score = percentOf(citedCount, totalCount) ?? 0

  const runProviders = new Set(snapshots.map(s => s.provider))
  const runApiProviderCount = options.configuredApiProviders.filter(p => runProviders.has(p)).length
  const isPartialProviderRun =
    options.configuredApiProviders.length > 1
    && runApiProviderCount < options.configuredApiProviders.length

  return {
    label: 'Citation Coverage',
    value: formatPercent(citedCount / totalCount),
    delta: `${citedCount} of ${totalCount} queries cited`,
    tone: isPartialProviderRun ? 'caution' : scoreTone(score),
    description: `${citedCount} of ${totalCount} tracked queries found your domain in at least one AI answer engine.`,
    tooltip,
    trend: [],
    progress: score,
    providerCoverage: isPartialProviderRun
      ? `${runApiProviderCount} of ${options.configuredApiProviders.length} engines`
      : undefined,
    // Present only when nonzero, so a smaller cited denominator is always
    // visible next to the rate it shrank.
    ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
  }
}
