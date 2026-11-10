import type { RunData, Snapshot } from './types.js'

/**
 * The set of things a run actually OBSERVED, keyed however the caller keys them.
 *
 * A run's snapshots record observations, not truth. A provider call that throws
 * writes no snapshot row at all — that is what `status='partial'`
 * means — so a sweep can be missing whole (query × provider) pairs. **Absence
 * of a row is absence of evidence, never an observation of "not cited".**
 *
 * Answers written without a web search (`retrievalStatus = 'not-used'`) cite
 * nothing by construction; they are not an observation of citation presence
 * or absence (#1161).
 *
 * Every detector that claims a TRANSITION ("started being cited", "dropped
 * off") must therefore confirm the relevant side observed the thing before
 * claiming it moved. Skipping that check reads a hole in the data as a change
 * in the world: measured against a baseline sweep where one provider errored,
 * it produced 6 false insights for a site where nothing had changed.
 *
 * `detectRegressions` and `detectPersistentGaps` get this right structurally —
 * the first iterates the current run's rows and requires a prior CITED
 * observation, the second breaks a streak on any run missing the query. The
 * detectors that key off "not in the previous set" need this helper.
 */
export function observedKeys<K>(run: RunData, keyOf: (snap: Snapshot) => K): Set<K> {
  const observed = new Set<K>()
  for (const snap of run.snapshots) {
    if (snap.retrievalStatus === 'not-used') continue
    observed.add(keyOf(snap))
  }
  return observed
}
