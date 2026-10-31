import type { Snapshot } from './types.js'

/**
 * Key composition for transition detection. Location is included so two
 * siblings of a multi-location fan-out (e.g. Florida snapshot in the previous
 * run, Michigan snapshot in the current run, same query × provider) do not
 * collapse into a single timeline. `null`/`undefined` location is normalized
 * to a single sentinel so locationless runs match other locationless runs.
 */
export function snapshotKey(snap: Pick<Snapshot, 'query' | 'provider' | 'location'>): string {
  const loc = snap.location ?? '__none__'
  return JSON.stringify([snap.query, snap.provider, loc])
}
