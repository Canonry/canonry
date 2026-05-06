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
 * Computes the "Answer Visibility" score gauge — the headline metric for the
 * project page. A query is "visible" when at least one snapshot for that query
 * has citationState='cited'. Score is rounded percentage of visible queries.
 *
 * When the run only covers a subset of configured providers, tone shifts to
 * caution and a providerCoverage label is set, even if the score is high. The
 * dashboard renders that label inside the gauge.
 */
export function buildVisibilityScore(
  snapshots: readonly VisibilityScoreSnapshot[],
  options: VisibilityScoreOptions,
): ScoreSummaryDto {
  const tooltip = 'Percentage of tracked queries where your domain is cited by at least one AI answer engine. A query is "visible" if any configured provider includes your site in its response.'

  if (snapshots.length === 0) {
    return {
      label: 'Answer Visibility',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No visibility data yet. Trigger a run to start tracking.',
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
    label: 'Answer Visibility',
    value: `${score}`,
    delta: `${citedCount} of ${totalCount} queries visible`,
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
