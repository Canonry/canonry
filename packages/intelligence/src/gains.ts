import type { RunData, Gain } from './types.js'
import { observedKeys } from './observation-coverage.js'
import { snapshotKey } from './snapshot-key.js'

export function detectGains(currentRun: RunData, previousRun: RunData): Gain[] {
  // See `regressions.ts` — bail if the caller fed a cross-location pair.
  if ((currentRun.location ?? null) !== (previousRun.location ?? null)) {
    return []
  }
  const gains: Gain[] = []

  // What the baseline OBSERVED, separately from what it found cited. A pair
  // its provider errored on has no row at all, and no row is not a "not
  // cited" reading to have gained against. See `observation-coverage.ts`.
  const previousObserved = observedKeys(previousRun, snapshotKey)
  const previousCited = new Set<string>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited) {
      previousCited.add(snapshotKey(snap))
    }
  }

  for (const snap of currentRun.snapshots) {
    const key = snapshotKey(snap)
    if (snap.cited && previousObserved.has(key) && !previousCited.has(key)) {
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
