import crypto from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { queries, querySnapshots } from '@ainyc/canonry-db'
import { normalizeQueryText } from '@ainyc/canonry-contracts'

/**
 * Pre-delete safety net: copy each query's `query` text into the
 * `query_text` column on every snapshot that references it. Snapshots
 * inserted since ~2026-04-08 already carry their `query_text` (the
 * job-runner populates it at insert time), so this is a no-op for new
 * data; the value is in covering ANY snapshot that somehow ended up
 * with NULL `query_text` (older inserts, manual fixups, future code
 * paths that forget). After this, deleting the query row sets
 * `query_id` to NULL via the FK but leaves `query_text` intact — so
 * the timeline endpoint's text-fallback can still attribute the
 * snapshot if a query with the same text exists later.
 *
 * Without this safeguard, `query replace` / `query remove` permanently
 * detaches the historical record from any query name — exactly the
 * azcoatings bug recovered by `cnry backfill snapshot-attribution`.
 *
 * Pass `queryIds` to scope to a specific subset; omit to cover every
 * query in the project (used by single-row delete paths).
 */
export function preserveSnapshotQueryText(
  tx: Pick<DatabaseClient, 'select' | 'update'>,
  projectId: string,
  queryIds?: string[],
): void {
  const candidates = queryIds && queryIds.length > 0
    ? tx.select({ id: queries.id, text: queries.query })
        .from(queries)
        .where(inArray(queries.id, queryIds))
        .all()
    : tx.select({ id: queries.id, text: queries.query })
        .from(queries)
        .where(eq(queries.projectId, projectId))
        .all()
  for (const q of candidates) {
    tx.update(querySnapshots)
      .set({ queryText: q.text })
      .where(eq(querySnapshots.queryId, q.id))
      .run()
  }
}

export interface ReplaceQueriesResult {
  /** Row ids kept because their normalized text is in the incoming list. */
  keptIds: string[]
  /** Texts inserted as brand-new rows. */
  insertedTexts: string[]
  /** Row ids deleted because their text left the list. */
  deletedIds: string[]
}

/**
 * Declarative replace of a project's tracked queries that PRESERVES row
 * identity for unchanged texts. Tracked-query rows are the FK anchor for
 * every historical `query_snapshots` row (`query_id` is ON DELETE SET
 * NULL), so a delete-all + reinsert of a textually identical list mints
 * new UUIDs and silently orphans all history — the FK-based dashboard
 * attribution collapses while text-fallback readers keep working. This
 * is the idempotency rule at the row level: applying the same input
 * twice must leave the same rows.
 *
 * Semantics:
 * - Matching is by `normalizeQueryText` (trim + lowercase). A row whose
 *   normalized text is in the incoming list is KEPT (id, createdAt, and
 *   provenance untouched). A casing/whitespace-only change updates the
 *   stored text in place on the kept row.
 * - Incoming duplicates (same normalized text twice) collapse to one
 *   row — a declarative list is a set; duplicate rows would double-probe
 *   the same query on every sweep.
 * - Rows whose text left the list are deleted, AFTER the
 *   `preserveSnapshotQueryText` safety net stamps their text onto any
 *   referencing snapshot missing it.
 *
 * Must run inside the caller's transaction.
 */
export function replaceProjectQueries(
  tx: Pick<DatabaseClient, 'select' | 'update' | 'insert' | 'delete'>,
  projectId: string,
  incomingTexts: string[],
  now: string,
): ReplaceQueriesResult {
  const existing = tx.select({ id: queries.id, text: queries.query })
    .from(queries)
    .where(eq(queries.projectId, projectId))
    .all()

  const unclaimed = new Map<string, { id: string; text: string }>()
  for (const row of existing) {
    const key = normalizeQueryText(row.text)
    // Duplicate normalized texts among existing rows: first row wins the
    // key; extras fall through to deletion below.
    if (!unclaimed.has(key)) unclaimed.set(key, row)
  }

  const keptIds: string[] = []
  const insertedTexts: string[] = []
  const seenIncoming = new Set<string>()

  for (const text of incomingTexts) {
    const key = normalizeQueryText(text)
    if (seenIncoming.has(key)) continue
    seenIncoming.add(key)

    const match = unclaimed.get(key)
    if (match) {
      unclaimed.delete(key)
      keptIds.push(match.id)
      if (match.text !== text) {
        tx.update(queries).set({ query: text }).where(eq(queries.id, match.id)).run()
      }
    } else {
      insertedTexts.push(text)
    }
  }

  const keptIdSet = new Set(keptIds)
  const deletedIds = existing
    .filter((row) => !keptIdSet.has(row.id))
    .map((row) => row.id)
  if (deletedIds.length > 0) {
    preserveSnapshotQueryText(tx, projectId, deletedIds)
    tx.delete(queries).where(inArray(queries.id, deletedIds)).run()
  }

  for (const text of insertedTexts) {
    tx.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: text,
      provenance: 'cli',
      createdAt: now,
    }).run()
  }

  return { keptIds, insertedTexts, deletedIds }
}
