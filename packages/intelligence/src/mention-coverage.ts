import type { ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { scoreTone } from './score-tones.js'

export interface MentionCoverageSnapshot {
  queryId: string
  provider: string
  /** True when the project's brand or domain appeared in the AI answer text. */
  answerMentioned: boolean | null | undefined
}

export interface MentionCoverageOptions {
  /**
   * Project's configured API providers (i.e. the providers section of canonry.yaml,
   * minus any `cdp:*` browser-flavored aliases). Used to detect partial-provider runs.
   */
  configuredApiProviders: readonly string[]
}

/**
 * Computes the "Mention Coverage" headline gauge — the primary dashboard
 * metric for AEO health. A query counts as mentioned when at least one
 * snapshot for that query has `answerMentioned === true` (i.e. the AI
 * actually said the brand's name or domain in its answer text). The score
 * is the rounded percentage of mentioned queries.
 *
 * This is the dashboard's *primary* metric — what most operators actually
 * care about. The mirror-image `buildVisibilityScore` (a.k.a. "Citation
 * Coverage") counts the citation/source signal and remains useful as a
 * secondary metric for analysts tracking source-list presence.
 *
 * When the run only covers a subset of configured providers, tone shifts
 * to caution and a providerCoverage label is set, even if the score is
 * high. The dashboard renders that label inside the gauge.
 */
export function buildMentionCoverage(
  snapshots: readonly MentionCoverageSnapshot[],
  options: MentionCoverageOptions,
): ScoreSummaryDto {
  const tooltip = 'Percentage of tracked queries where the AI answer text mentions your brand or domain. A query counts as mentioned if any configured provider includes your name in its answer body.'

  if (snapshots.length === 0) {
    return {
      label: 'Mention Coverage',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No mention data yet. Trigger a run to start tracking.',
      tooltip,
      trend: [],
    }
  }

  const queryMentioned = new Map<string, boolean>()
  for (const snap of snapshots) {
    if (!queryMentioned.has(snap.queryId)) queryMentioned.set(snap.queryId, false)
    if (snap.answerMentioned === true) queryMentioned.set(snap.queryId, true)
  }
  const totalCount = queryMentioned.size
  const mentionedCount = [...queryMentioned.values()].filter(Boolean).length
  const score = totalCount > 0 ? Math.round((mentionedCount / totalCount) * 100) : 0

  const runProviders = new Set(snapshots.map(s => s.provider))
  const runApiProviderCount = options.configuredApiProviders.filter(p => runProviders.has(p)).length
  const isPartialProviderRun =
    options.configuredApiProviders.length > 1
    && runApiProviderCount < options.configuredApiProviders.length

  return {
    label: 'Mention Coverage',
    value: `${score}`,
    delta: `${mentionedCount} of ${totalCount} queries mentioned`,
    tone: isPartialProviderRun ? 'caution' : scoreTone(score),
    description: `${mentionedCount} of ${totalCount} tracked queries had your brand or domain in the AI answer text.`,
    tooltip,
    trend: [],
    progress: score,
    providerCoverage: isPartialProviderRun
      ? `${runApiProviderCount} of ${options.configuredApiProviders.length} providers`
      : undefined,
  }
}
