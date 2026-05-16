import type { RunData, Gain, Snapshot } from './types.js'

/**
 * See `regressions.ts` — same key composition keeps multi-location fan-out
 * siblings on separate timelines.
 */
function snapshotKey(snap: Pick<Snapshot, 'query' | 'provider' | 'location'>): string {
  const loc = snap.location ?? '__none__'
  return JSON.stringify([snap.query, snap.provider, loc])
}

export function detectGains(currentRun: RunData, previousRun: RunData): Gain[] {
  // See `regressions.ts` — bail if the caller fed a cross-location pair.
  if ((currentRun.location ?? null) !== (previousRun.location ?? null)) {
    return []
  }
  const gains: Gain[] = []

  const previousCited = new Set<string>()
  for (const snap of previousRun.snapshots) {
    if (snap.cited) {
      previousCited.add(snapshotKey(snap))
    }
  }

  for (const snap of currentRun.snapshots) {
    const key = snapshotKey(snap)
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
