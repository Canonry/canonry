import type { RunData, Regression, Snapshot } from './types.js'

/**
 * Key composition for transition detection. Location is included so two
 * siblings of a multi-location fan-out (e.g. Florida snapshot in the previous
 * run, Michigan snapshot in the current run, same query × provider) do not
 * collapse into a single timeline. `null`/`undefined` location is normalized
 * to a single sentinel so locationless runs match other locationless runs.
 */
function snapshotKey(snap: Pick<Snapshot, 'query' | 'provider' | 'location'>): string {
  const loc = snap.location ?? '__none__'
  return JSON.stringify([snap.query, snap.provider, loc])
}

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
