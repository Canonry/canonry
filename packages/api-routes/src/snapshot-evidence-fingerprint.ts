import { createHash } from 'node:crypto'
import type { querySnapshots } from '@ainyc/canonry-db'

type SnapshotRow = typeof querySnapshots.$inferSelect

/**
 * The fingerprint a measurement paging cursor pins: a hash over the displayed
 * run's stored answers, so a cursor minted before those answers changed is
 * refused rather than walked over different evidence.
 *
 * It covers what an answer SAID and where it points, not how it was obtained.
 * The dispatch provenance columns (`dispatchMode`, `providerBatchId`,
 * `stopReason`, `usage`) are left out, so the upgrade that added them, and any
 * later repricing, never invalidates a cursor an agent is mid-way through.
 */
export function snapshotEvidenceFingerprint(snapshots: readonly SnapshotRow[]): string {
  const canonical = [...snapshots]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ dispatchMode: _dispatchMode, providerBatchId: _providerBatchId, stopReason: _stopReason, usage: _usage, ...evidence }) => JSON.stringify(evidence))
    .join('\n')
  return createHash('sha256').update(canonical).digest('base64url')
}
