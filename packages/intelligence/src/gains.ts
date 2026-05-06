import type { RunData, Gain } from './types.js'

export function detectGains(currentRun: RunData, previousRun: RunData): Gain[] {
  const gains: Gain[] = []

  // Build a set of previously cited pairs
  const previousCited = new Set<string>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited) {
      previousCited.add(`${snap.query}:${snap.provider}`)
    }
  }

  // Find current snapshots that ARE cited but were NOT previously
  for (const snap of currentRun.snapshots) {
    const key = `${snap.query}:${snap.provider}`
    if (snap.cited && !previousCited.has(key)) {
      gains.push({
        query: snap.query,
        provider: snap.provider,
        citationUrl: snap.citationUrl,
        position: snap.position,
        snippet: snap.snippet,
        runId: currentRun.runId,
      })
    }
  }

  return gains
}
