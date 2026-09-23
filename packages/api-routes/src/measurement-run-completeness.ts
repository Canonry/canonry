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

/** One expected manifest slot: an execution node answered by one provider. */
export interface MeasurementRunSlot {
  executionId: string
  /** Lowercased, the key the manifest and the snapshot index both use. */
  provider: string
  /** The model the manifest froze for this slot, or null when it froze none. */
  requestedModel: string | null
}

export interface MeasurementRunSlotState {
  planned: boolean
  /** False when the run has a manifest that cannot be parsed. */
  readable: boolean
  expected: MeasurementRunSlot[]
  /** Expected slots with no snapshot row. The set a fill executes. */
  missing: MeasurementRunSlot[]
  executed: number
  hasUnboundSnapshot: boolean
}

/** Same identity the manifest itself uses to reject duplicate slots. */
export function measurementSlotKey(executionId: string, provider: string): string {
  return [executionId, provider.trim().toLocaleLowerCase('en')].join(' ')
}

/**
 * Which of a run's expected slots have a snapshot and which do not. The single
 * source for both "is this run complete" and "what would a fill execute", so
 * the two can never disagree about a slot.
 *
 * A slot counts as recorded once any row answers it. A row whose cited-URL
 * capture failed still carries a real answer and mention, and asking again
 * would need a second row the slot index forbids, so it is not missing.
 */
export function measurementRunSlotState(db: DatabaseClient, runId: string): MeasurementRunSlotState {
  const run = db.select({ manifest: runs.measurementManifest }).from(runs).where(eq(runs.id, runId)).get()
  if (!run?.manifest) return { planned: false, readable: true, expected: [], missing: [], executed: 0, hasUnboundSnapshot: false }

  const expected = new Map<string, MeasurementRunSlot>()
  try {
    for (const slot of parseMeasurementRunManifestV1(run.manifest).expectedSlots) {
      const provider = slot.provider.trim().toLocaleLowerCase('en')
      expected.set(measurementSlotKey(slot.executionId, provider), {
        executionId: slot.executionId,
        provider,
        requestedModel: slot.requestedModel ?? null,
      })
    }
  } catch {
    // An unreadable manifest is not a licence to treat the run as whole.
    return { planned: true, readable: false, expected: [], missing: [], executed: 0, hasUnboundSnapshot: false }
  }

  // A raw row count is a cardinality check, not a slot check: two rows
  // answering the same expected slot and zero rows answering another would
  // still clear a `>= expected` bar. Compare against the manifest's own slot
  // identity instead, so a slot only counts once it is actually filled. Rows
  // with no execution id predate plan execution and cannot be attributed to
  // any slot.
  const rows = db.select({ executionId: querySnapshots.measurementExecutionId, provider: querySnapshots.provider })
    .from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  const recorded = new Set<string>()
  let hasUnboundSnapshot = false
  for (const row of rows) {
    const executionId = row.executionId?.trim()
    if (!executionId) {
      hasUnboundSnapshot = true
      continue
    }
    const key = measurementSlotKey(executionId, row.provider)
    if (expected.has(key)) recorded.add(key)
  }

  return {
    planned: true,
    readable: true,
    expected: [...expected.values()],
    missing: [...expected].filter(([key]) => !recorded.has(key)).map(([, slot]) => slot),
    executed: recorded.size,
    hasUnboundSnapshot,
  }
}

export function measurementRunCompleteness(db: DatabaseClient, runId: string): MeasurementRunCompleteness {
  const state = measurementRunSlotState(db, runId)
  if (!state.planned) return { planned: false, executed: 0, expected: 0, complete: true }
  if (!state.readable) return { planned: true, executed: 0, expected: 0, complete: false }
  return {
    planned: true,
    executed: state.executed,
    expected: state.expected.length,
    complete: state.missing.length === 0 && !state.hasUnboundSnapshot,
  }
}
