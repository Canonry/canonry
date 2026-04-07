import { detectRegressions } from './regressions.js'
import { detectGains } from './gains.js'
import { computeHealth, computeHealthTrend } from './health.js'
import { analyzeCause } from './causes.js'
import { generateInsights } from './insights.js'
import type { RunData, AnalysisResult, CauseAnalysis } from './types.js'

export function analyzeRuns(currentRun: RunData, previousRun: RunData, allRuns?: RunData[]): AnalysisResult {
  // 1. Detect regressions and gains
  const regressions = detectRegressions(currentRun, previousRun)
  const gains = detectGains(currentRun, previousRun)

  // 2. Compute health
  const health = computeHealth(currentRun)
  const trend = allRuns ? computeHealthTrend(allRuns) : undefined

  // 3. Analyze causes for each regression
  const causes = new Map<string, CauseAnalysis>()
  for (const reg of regressions) {
    const cause = analyzeCause(reg, currentRun.snapshots)
    causes.set(`${reg.keyword}:${reg.provider}`, cause)
  }

  // 4. Generate insights
  const insights = generateInsights(regressions, gains, health, causes)

  return {
    regressions,
    gains,
    health,
    trend,
    insights,
  }
}
