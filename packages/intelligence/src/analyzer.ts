import { detectRegressions } from './regressions.js'
import { detectGains } from './gains.js'
import { detectFirstCitations } from './first-citations.js'
import { detectProviderPickups } from './provider-pickups.js'
import { detectPersistentGaps, PERSISTENT_GAP_THRESHOLD } from './persistent-gaps.js'
import { detectCompetitorGains, detectCompetitorLosses } from './competitor-changes.js'
import { computeHealth, computeHealthTrend } from './health.js'
import { analyzeCause } from './causes.js'
import { generateInsights } from './insights.js'
import type { RunData, AnalysisResult, CauseAnalysis } from './types.js'

export interface AnalyzeRunsOptions {
  /** Tracked competitor domains for the project. Empty = competitor signals skipped. */
  trackedCompetitors?: readonly string[]
  /**
   * Optional run history (oldest → newest, including the current run).
   * Required for persistent-gap detection. When omitted or shorter than the
   * gap threshold, persistent-gap is skipped.
   */
  history?: RunData[]
  /** Override the persistent-gap streak threshold. Default = 3. */
  persistentGapThreshold?: number
}

export function analyzeRuns(
  currentRun: RunData,
  previousRun: RunData,
  opts: AnalyzeRunsOptions = {},
): AnalysisResult {
  const trackedCompetitors = opts.trackedCompetitors ?? []
  const history = opts.history ?? []
  const persistentGapThreshold = opts.persistentGapThreshold ?? PERSISTENT_GAP_THRESHOLD

  const regressions = detectRegressions(currentRun, previousRun)
  const gains = detectGains(currentRun, previousRun)
  const firstCitations = detectFirstCitations(currentRun, previousRun)
  const providerPickups = detectProviderPickups(currentRun, previousRun)
  const competitorGains = detectCompetitorGains(currentRun, previousRun, { trackedCompetitors })
  const competitorLosses = detectCompetitorLosses(currentRun, previousRun, { trackedCompetitors })
  const persistentGaps = history.length >= persistentGapThreshold
    ? detectPersistentGaps(history, persistentGapThreshold)
    : []

  const health = computeHealth(currentRun)
  const trend = history.length > 0 ? computeHealthTrend(history) : undefined

  const causes = new Map<string, CauseAnalysis>()
  for (const reg of regressions) {
    const cause = analyzeCause(reg, currentRun.snapshots)
    causes.set(`${reg.query}:${reg.provider}`, cause)
  }

  const insights = generateInsights({
    regressions,
    gains,
    firstCitations,
    providerPickups,
    persistentGaps,
    competitorGains,
    competitorLosses,
    health,
    causes,
  })

  return {
    regressions,
    gains,
    firstCitations,
    providerPickups,
    persistentGaps,
    competitorGains,
    competitorLosses,
    health,
    trend,
    insights,
  }
}
