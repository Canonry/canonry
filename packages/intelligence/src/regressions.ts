import type { RunData, Regression } from './types.js'
import { snapshotKey } from './snapshot-key.js'

export function detectRegressions(currentRun: RunData, previousRun: RunData): Regression[] {
  // Defense-in-depth: comparing two RunDatas with different locations would
  // treat sibling fan-out runs as a temporal sequence. The intelligence
  // service is the authoritative source for "previous run at same location",
  // but the pure detector also bails out if the caller feeds a mismatched
  // pair — better to produce nothing than false transitions.
  if ((currentRun.location ?? null) !== (previousRun.location ?? null)) {
    return []
  }
  const regressions: Regression[] = []

  const previousCited = new Map<string, { citationUrl?: string; position?: number }>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited) {
      previousCited.set(snapshotKey(snap), {
        citationUrl: snap.citationUrl,
        position: snap.position,
      })
    }
  }

  for (const snap of currentRun.snapshots) {
    const key = snapshotKey(snap)
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
