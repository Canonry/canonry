import { CitationStates, type ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { scoreTone } from './score-tones.js'

export interface VisibilityScoreSnapshot {
  queryId: string
  provider: string
  citationState: string
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
 * query has `citationState === 'cited'`. The score is the rounded percentage
 * of cited queries.
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
 */
export function buildVisibilityScore(
  snapshots: readonly VisibilityScoreSnapshot[],
  options: VisibilityScoreOptions,
): ScoreSummaryDto {
  const tooltip = 'An LLM used a page on your domain as a source for its answer.'

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
  for (const snap of snapshots) {
    if (!queryCited.has(snap.queryId)) queryCited.set(snap.queryId, false)
    if (snap.citationState === CitationStates.cited) queryCited.set(snap.queryId, true)
  }
  const totalCount = queryCited.size
  const citedCount = [...queryCited.values()].filter(Boolean).length
  const score = totalCount > 0 ? Math.round((citedCount / totalCount) * 100) : 0

  const runProviders = new Set(snapshots.map(s => s.provider))
  const runApiProviderCount = options.configuredApiProviders.filter(p => runProviders.has(p)).length
  const isPartialProviderRun =
    options.configuredApiProviders.length > 1
    && runApiProviderCount < options.configuredApiProviders.length

  return {
    label: 'Citation Coverage',
    value: `${score}`,
    delta: `${citedCount} of ${totalCount} queries cited`,
    tone: isPartialProviderRun ? 'caution' : scoreTone(score),
    description: `${citedCount} of ${totalCount} tracked queries found your domain in at least one AI answer engine.`,
    tooltip,
    trend: [],
    progress: score,
    providerCoverage: isPartialProviderRun
      ? `${runApiProviderCount} of ${options.configuredApiProviders.length} providers`
      : undefined,
  }
}
