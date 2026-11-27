import { CitationStates, formatPercent, isCitationStateMeasured, percentOf, type CitationState, type ScoreSummaryDto } from '@canonry/canonry-contracts'
import { scoreTone } from './score-tones.js'

export interface VisibilityScoreSnapshot {
  queryId: string
  provider: string
  /** As read through `readCitationState`. */
  citationState: CitationState
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
 * Only answers whose sources were checked count. A query none of whose
 * answers carries sources (an engine without web access) is left out of the
 * denominator, and with no such query the gauge reads "Not measured".
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
  const answeredQueries = new Set<string>()
  for (const snap of snapshots) {
    answeredQueries.add(snap.queryId)
    if (!isCitationStateMeasured(snap.citationState)) continue
    if (!queryCited.has(snap.queryId)) queryCited.set(snap.queryId, false)
    if (snap.citationState === CitationStates.cited) queryCited.set(snap.queryId, true)
  }
  const totalCount = queryCited.size
  const notMeasuredCount = answeredQueries.size - totalCount

  if (totalCount === 0) {
    return {
      label: 'Citation Coverage',
      value: 'Not measured',
      delta: `${notMeasuredCount} ${notMeasuredCount === 1 ? 'query' : 'queries'} without sources`,
      tone: 'neutral',
      description: 'Your engines return no sources, so whether they cite your domain is not measured.',
      tooltip,
      trend: [],
    }
  }

  const citedCount = [...queryCited.values()].filter(Boolean).length
  const score = percentOf(citedCount, totalCount) ?? 0

  const runProviders = new Set(snapshots.map(s => s.provider))
  const runApiProviderCount = options.configuredApiProviders.filter(p => runProviders.has(p)).length
  const isPartialProviderRun =
    options.configuredApiProviders.length > 1
    && runApiProviderCount < options.configuredApiProviders.length
  const notMeasuredNote = notMeasuredCount > 0
    ? ` ${notMeasuredCount} more ${notMeasuredCount === 1 ? 'query has' : 'queries have'} only answers without sources, so ${notMeasuredCount === 1 ? 'its' : 'their'} citation is not measured.`
    : ''

  return {
    label: 'Citation Coverage',
    value: formatPercent(citedCount / totalCount),
    delta: `${citedCount} of ${totalCount} queries cited`,
    tone: isPartialProviderRun ? 'caution' : scoreTone(score),
    description: `${citedCount} of ${totalCount} tracked queries found your domain in at least one AI answer engine.${notMeasuredNote}`,
    tooltip,
    trend: [],
    progress: score,
    providerCoverage: isPartialProviderRun
      ? `${runApiProviderCount} of ${options.configuredApiProviders.length} engines`
      : undefined,
  }
}
