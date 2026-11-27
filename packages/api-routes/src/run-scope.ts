import { and, isNull, type SQL } from 'drizzle-orm'
import { runs } from '@canonry/canonry-db'

/**
 * True for a spot check: a run that measured a slice on purpose, either a
 * list of queries (`queries`) or the groups/targets of a measurement plan
 * (`measurementScope`). It is a real observation of the queries it asked, so
 * per-query evidence keeps it, but it is never a whole-project sweep: a series
 * or a "latest sweep" pick that treats it as one reports a 2-query check as
 * the whole basket.
 */
export function isScopedRun(run: Pick<typeof runs.$inferSelect, 'queries' | 'measurementScope'>): boolean {
  return run.queries != null || run.measurementScope != null
}

/** Drizzle form of `!isScopedRun(run)`: whole-project sweeps only. */
export function notScopedRun(): SQL {
  return and(isNull(runs.queries), isNull(runs.measurementScope))!
}
