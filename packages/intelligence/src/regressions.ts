import type { RunData, Regression } from './types.js'

export function detectRegressions(currentRun: RunData, previousRun: RunData): Regression[] {
  const regressions: Regression[] = []

  // Build a map of previous citations: key = "query:provider"
  const previousCited = new Map<string, { citationUrl?: string; position?: number }>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited) {
      previousCited.set(`${snap.query}:${snap.provider}`, {
        citationUrl: snap.citationUrl,
        position: snap.position,
      })
    }
  }

  // Find current snapshots that are NOT cited but WERE cited previously
  for (const snap of currentRun.snapshots) {
    const key = `${snap.query}:${snap.provider}`
    if (!snap.cited && previousCited.has(key)) {
      const prev = previousCited.get(key)!
      regressions.push({
        query: snap.query,
        provider: snap.provider,
        previousCitationUrl: prev.citationUrl,
        previousPosition: prev.position,
        currentRunId: currentRun.runId,
        previousRunId: previousRun.runId,
      })
    }
  }

  return regressions
}
