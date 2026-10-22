import { eq, lt } from 'drizzle-orm'
import {
  refreshSnapshotMentionIdentity,
  snapshotsWithSentimentResults,
  type SnapshotMentionIdentityRefresh,
} from '@canonry/canonry-api-routes'
import { dataRepairCompletions, type DatabaseClient } from '@canonry/canonry-db'

/** Raise to run the pass again after a change to how verdicts become mention identity. */
export const SENTIMENT_MENTION_IDENTITY_REPAIR_VERSION = 1
const REPAIR_NAME = 'sentiment-mention-identity'
/** Snapshots refreshed per transaction, so no write lock spans the whole history. */
const REPAIR_CHUNK_SIZE = 500

/**
 * Applies sentiment verdicts stored before snapshots recorded their mention
 * identity (migration 185), once per repair version. New verdicts apply as
 * they are stored (`SentimentWorker`). Each chunk commits on its own; a failed
 * pass leaves the version pending, so the next startup repeats the idempotent
 * refresh.
 */
export function repairSentimentMentionIdentityOnStartup(db: DatabaseClient): SnapshotMentionIdentityRefresh | null {
  const completed = db.select({ version: dataRepairCompletions.version }).from(dataRepairCompletions)
    .where(eq(dataRepairCompletions.name, REPAIR_NAME)).get()
  if (completed && completed.version >= SENTIMENT_MENTION_IDENTITY_REPAIR_VERSION) return null

  const snapshotIds = snapshotsWithSentimentResults(db)
  let examined = 0
  let updated = 0
  for (let offset = 0; offset < snapshotIds.length; offset += REPAIR_CHUNK_SIZE) {
    const chunk = snapshotIds.slice(offset, offset + REPAIR_CHUNK_SIZE)
    const result = db.transaction(tx => refreshSnapshotMentionIdentity(tx, chunk))
    examined += result.examined
    updated += result.updated
  }
  const completion = { version: SENTIMENT_MENTION_IDENTITY_REPAIR_VERSION, completedAt: new Date().toISOString() }
  db.insert(dataRepairCompletions).values({ name: REPAIR_NAME, ...completion }).onConflictDoUpdate({
    target: dataRepairCompletions.name,
    set: completion,
    setWhere: lt(dataRepairCompletions.version, SENTIMENT_MENTION_IDENTITY_REPAIR_VERSION),
  }).run()
  return { examined, updated }
}
