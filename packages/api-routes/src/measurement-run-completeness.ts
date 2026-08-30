/**
 * Did a run actually produce the measurements it promised?
 *
 * A run pinned to a plan carries a manifest of expected provider slots. Rows
 * missing from that manifest are not a smaller measurement, they are an
 * unfinished one: a rate taken over what did land would be a rate over a
 * partial denominator, and an insight derived from it states a conclusion
 * about questions nobody answered. Nor may a plan-pinned run carry an extra
 * unbound snapshot: a row with no execution id cannot be reconciled to the
 * frozen denominator, even if every expected slot happened to arrive.
 *
 * A run with no manifest is reported complete. Planless runs measure the live
 * query set and have no promise to fall short of, so nothing about their
 * existing behaviour changes.
 */

import { eq } from 'drizzle-orm'
import { parseMeasurementRunManifestV1 } from '@ainyc/canonry-contracts'
import { querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'

export interface MeasurementRunCompleteness {
  /** Whether this run measured a published plan at all. */
  planned: boolean
  executed: number
  expected: number
  complete: boolean
}

/** Same identity the manifest itself uses to reject duplicate slots. */
function slotKey(executionId: string, provider: string): string {
  return [executionId, provider.trim().toLocaleLowerCase('en')].join(' ')
}

export function measurementRunCompleteness(db: DatabaseClient, runId: string): MeasurementRunCompleteness {
  const run = db.select({ manifest: runs.measurementManifest }).from(runs).where(eq(runs.id, runId)).get()
  if (!run?.manifest) return { planned: false, executed: 0, expected: 0, complete: true }

  let expectedSlots: Set<string>
  try {
    expectedSlots = new Set(
      parseMeasurementRunManifestV1(run.manifest).expectedSlots.map(slot => slotKey(slot.executionId, slot.provider)),
    )
  } catch {
    // An unreadable manifest is not a licence to treat the run as whole.
    return { planned: true, executed: 0, expected: 0, complete: false }
  }

  // A raw row count is a cardinality check, not a slot check: two rows
  // answering the same expected slot and zero rows answering another would
  // still clear a `>= expected` bar. Compare against the manifest's own slot
  // identity instead, so a slot only counts once it is actually filled. Rows
  // with no execution id predate plan execution and cannot be attributed to
  // any slot.
  const rows = db.select({ executionId: querySnapshots.measurementExecutionId, provider: querySnapshots.provider })
    .from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  const executedSlots = new Set<string>()
  let hasUnboundSnapshot = false
  for (const row of rows) {
    const executionId = row.executionId?.trim()
    if (!executionId) {
      hasUnboundSnapshot = true
      continue
    }
    const key = slotKey(executionId, row.provider)
    if (expectedSlots.has(key)) executedSlots.add(key)
  }

  return {
    planned: true,
    executed: executedSlots.size,
    expected: expectedSlots.size,
    complete: executedSlots.size === expectedSlots.size && !hasUnboundSnapshot,
  }
}
