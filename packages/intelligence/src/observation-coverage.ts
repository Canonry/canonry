import type { RunData, Snapshot } from './types.js'

/**
 * The set of things a run actually OBSERVED about citation, keyed however the
 * caller keys them.
 *
 * A run's snapshots record observations, not truth. A provider call that throws
 * writes no snapshot row at all — that is precisely what `status='partial'`
 * means — so a sweep can be missing whole (query × provider) pairs. **Absence
 * of a row is absence of evidence, never an observation of "not cited".** The
 * same holds for a row whose citation was not measured (`cited === null`, an
 * engine that returns no sources): it observed the answer, not whether it
 * cites anyone, so it is left out here too.
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
    if (snap.cited !== null) observed.add(keyOf(snap))
  }
  return observed
}
