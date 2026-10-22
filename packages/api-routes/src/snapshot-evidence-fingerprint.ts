import { createHash } from 'node:crypto'
import type { querySnapshots } from '@canonry/canonry-db'

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
 * Sentiment's identity verdicts (`mentionIdentity`, `wrongSubjectTargetKeys`)
 * count only once set: a verdict changes which mentions the answer counts, so
 * it moves the fingerprint, while its absence (every answer stored before
 * verdicts existed) leaves the hash, and every cursor minted before, unchanged.
 */
export function snapshotEvidenceFingerprint(snapshots: readonly SnapshotRow[]): string {
  const canonical = [...snapshots]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ dispatchMode: _dispatchMode, providerBatchId: _providerBatchId, stopReason: _stopReason, usage: _usage, mentionIdentity, wrongSubjectTargetKeys, ...evidence }) => JSON.stringify({
      ...evidence,
      ...(mentionIdentity === null ? {} : { mentionIdentity }),
      ...(wrongSubjectTargetKeys === null ? {} : { wrongSubjectTargetKeys }),
    }))
    .join('\n')
  return createHash('sha256').update(canonical).digest('base64url')
}
