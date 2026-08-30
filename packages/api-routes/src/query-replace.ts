import crypto from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { measurementPlanDrafts, measurementPlans, measurementPlanVersions, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, normalizeQueryText, parseStoredMeasurementPlanAnyVersion, runInProgress, validationError } from '@ainyc/canonry-contracts'
import { parseStoredAuthoring } from './measurement-draft-repo.js'

/**
 * Pre-delete safety net: copy each query's `query` text into the
 * `query_text` column on every snapshot that references it. Snapshots
 * inserted since ~2026-04-08 already carry their `query_text` (the
 * job-runner populates it at insert time), so this is a no-op for new
 * data; it fills ANY snapshot that somehow ended up with NULL
 * `query_text` (older inserts, manual fixups, future code
 * paths that forget). Existing non-null wording is frozen evidence and is
 * never overwritten. After this, deleting the query row sets
 * `query_id` to NULL via the FK but leaves `query_text` intact — so
 * the timeline endpoint's text-fallback can still attribute the
 * snapshot if a query with the same text exists later.
 *
 * Without this safeguard, a catalog edit can leave historical attribution
 * ambiguous after the query row is removed.
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
      .where(and(eq(querySnapshots.queryId, q.id), isNull(querySnapshots.queryText)))
      .run()
  }
}

export interface QueryCatalogMutationScope {
  projectId: string
  projectName: string
}

/**
 * Return every existing catalog row a declarative replacement would change.
 * Insertions have no prior identity to freeze, while removals, duplicate
 * collapse, and raw-text relabels can each mutate a plan or draft reference.
 */
export function changedQueryIdsForReplace(diff: QueryReplaceDiff): string[] {
  const changed = new Set<string>()
  for (const duplicate of diff.duplicates) changed.add(duplicate.id)
  for (const removed of diff.removed) changed.add(removed.id)
  for (const kept of diff.kept) {
    if (kept.currentText !== kept.incomingText) changed.add(kept.id)
  }
  return [...changed]
}

/**
 * Guard the legacy mutable catalog surface without treating every Advanced
 * project as immutable. Published-plan snapshots and draft assignments are
 * the authoritative references: changing one of those rows must use the
 * measurement workspace; an actually unassigned catalog row remains safe to
 * clean up. This must be called from the same transaction as the write.
 */
export function assertQueryCatalogMutationAllowed(
  tx: Pick<DatabaseClient, 'select'>,
  scope: QueryCatalogMutationScope,
  affectedQueryIds: readonly string[],
): void {
  if (affectedQueryIds.length === 0) return

  const protectedIds = new Set<string>()
  const activePlan = tx.select({ activeVersionId: measurementPlans.activeVersionId })
    .from(measurementPlans)
    .where(eq(measurementPlans.projectId, scope.projectId))
    .get()

  if (activePlan) {
    const version = tx.select({ canonicalJson: measurementPlanVersions.canonicalJson })
      .from(measurementPlanVersions)
      .where(and(
        eq(measurementPlanVersions.projectId, scope.projectId),
        eq(measurementPlanVersions.id, activePlan.activeVersionId),
      ))
      .get()
    if (!version) {
      throw validationError('Tracked queries cannot be changed because the active measurement plan is unavailable. Reload and try again.')
    }

    let plan: ReturnType<typeof parseStoredMeasurementPlanAnyVersion>
    try {
      plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
    } catch {
      throw validationError('Tracked queries cannot be changed because the active measurement plan is unavailable. Reload and try again.')
    }
    for (const snapshot of plan.querySnapshots) protectedIds.add(snapshot.queryId)
    if (plan.schemaVersion === 1) {
      for (const selection of plan.targetQuerySelections) {
        for (const queryId of selection.queryIds) protectedIds.add(queryId)
      }
    } else {
      for (const assignment of plan.assignments) protectedIds.add(assignment.queryId)
    }
  }

  const draft = tx.select({ authoringJson: measurementPlanDrafts.authoringJson })
    .from(measurementPlanDrafts)
    .where(eq(measurementPlanDrafts.projectId, scope.projectId))
    .get()
  if (draft) {
    let authoring: ReturnType<typeof parseStoredAuthoring>
    try {
      authoring = parseStoredAuthoring(draft.authoringJson)
    } catch {
      throw validationError('Tracked queries cannot be changed because the measurement draft is unavailable. Reload and try again.')
    }
    for (const assignment of authoring.assignments) protectedIds.add(assignment.queryId)
  }

  if (affectedQueryIds.some(queryId => protectedIds.has(queryId))) {
    throw validationError(
      'This change would modify a tracked query assigned to an active measurement plan or draft. Edit it in the measurement workspace instead.',
      { displayToOperator: 'Use the measurement workspace to edit assigned queries safely.' },
    )
  }

  // A plan-backed run executes the revision pinned on that run, so cleanup of
  // a catalog row outside that revision is safe. A planless run reads the live
  // catalog even if an active plan was published after it queued; reject an
  // actual change while such a run is queued or running, but leave a true
  // declarative no-op idempotent.
  const activeRuns = tx.select({ measurementPlanVersionId: runs.measurementPlanVersionId })
    .from(runs)
    .where(and(
      eq(runs.projectId, scope.projectId),
      eq(runs.kind, RunKinds['answer-visibility']),
      inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
    ))
    .all()
  if (activeRuns.some(run => run.measurementPlanVersionId === null)) {
    throw runInProgress(scope.projectName)
  }
}

export interface QueryReplaceDiff {
  /** Rows kept because their normalized text is in the incoming list. `incomingText` is the raw incoming form (may differ from `currentText` in case/whitespace only). */
  kept: Array<{ id: string; currentText: string; incomingText: string }>
  /** Pre-existing rows whose normalized text equals a kept row's — their snapshots reparent onto `keptId`, then the row is deleted. */
  duplicates: Array<{ id: string; text: string; keptId: string }>
  /** Rows whose normalized text left the basket entirely — deleted after the text safety net. */
  removed: Array<{ id: string; text: string }>
  /** Incoming texts (first occurrence per normalized key) with no existing row. */
  insertedTexts: string[]
}

/**
 * Pure diff between a project's existing tracked-query rows and an incoming
 * declarative list. Matching is by `normalizeQueryText` (trim + lowercase).
 * Incoming duplicates collapse to their first occurrence — a declarative
 * list is a set; duplicate rows would double-probe the same query on every
 * sweep. Pre-existing rows that share a normalized text (possible because
 * the DB uniqueness is on the RAW text) resolve to one kept row; the extras
 * are classified `duplicates` so the caller can reparent their snapshots
 * instead of detaching them.
 *
 * Exported for the replace-preview endpoint, which must report exactly what
 * `replaceProjectQueries` will do — one diff, two consumers, no drift.
 */
export function diffProjectQueries(
  existing: Array<{ id: string; text: string }>,
  incomingTexts: string[],
): QueryReplaceDiff {
  const groups = new Map<string, Array<{ id: string; text: string }>>()
  for (const row of existing) {
    const key = normalizeQueryText(row.text)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const kept: QueryReplaceDiff['kept'] = []
  const duplicates: QueryReplaceDiff['duplicates'] = []
  const removed: QueryReplaceDiff['removed'] = []
  const insertedTexts: string[] = []
  const seenIncoming = new Set<string>()

  for (const text of incomingTexts) {
    const key = normalizeQueryText(text)
    if (seenIncoming.has(key)) continue
    seenIncoming.add(key)

    const group = groups.get(key)
    if (group) {
      groups.delete(key)
      const [canonical, ...extras] = group
      kept.push({ id: canonical!.id, currentText: canonical!.text, incomingText: text })
      for (const extra of extras) {
        duplicates.push({ id: extra.id, text: extra.text, keptId: canonical!.id })
      }
    } else {
      insertedTexts.push(text)
    }
  }

  for (const group of groups.values()) {
    for (const row of group) removed.push({ id: row.id, text: row.text })
  }

  return { kept, duplicates, removed, insertedTexts }
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
 * Semantics (see `diffProjectQueries` for the matching rules):
 * - Kept rows keep id, createdAt, and provenance. A casing/whitespace-only
 *   change updates the stored text in place.
 * - Pre-existing same-normalized-text duplicates collapse onto the kept
 *   row: their snapshots are REPARENTED to it (same tracked query
 *   semantically), then the extra rows are deleted.
 * - Rows whose text left the list are deleted, AFTER the
 *   `preserveSnapshotQueryText` safety net stamps their text onto any
 *   referencing snapshot missing it.
 *
 * Write ordering matters: duplicate/removed rows are deleted BEFORE kept
 * rows are renamed, so a rename onto a duplicate's exact raw text (e.g.
 * keeping `Best AEO Agency` while `best aeo agency` also exists, incoming
 * `best aeo agency`) cannot trip the UNIQUE(project_id, query) index.
 * After the dedup pass every kept row has a distinct normalized key, and a
 * rename target normalizes to its own row's key, so renames cannot collide
 * with each other or with the fresh inserts.
 *
 * Must run inside the caller's transaction.
 */
export function replaceProjectQueries(
  tx: Pick<DatabaseClient, 'select' | 'update' | 'insert' | 'delete'>,
  scope: QueryCatalogMutationScope,
  incomingTexts: string[],
  now: string,
): QueryReplaceDiff {
  const existing = tx.select({ id: queries.id, text: queries.query })
    .from(queries)
    .where(eq(queries.projectId, scope.projectId))
    .all()

  const diff = diffProjectQueries(existing, incomingTexts)
  assertQueryCatalogMutationAllowed(tx, scope, changedQueryIdsForReplace(diff))

  // 1. Duplicates: reparent their snapshots onto the kept row, then delete.
  //    No text safety net needed — the snapshots stay FK-attributed.
  if (diff.duplicates.length > 0) {
    for (const dup of diff.duplicates) {
      tx.update(querySnapshots)
        .set({ queryId: dup.keptId })
        .where(eq(querySnapshots.queryId, dup.id))
        .run()
    }
    tx.delete(queries).where(inArray(queries.id, diff.duplicates.map((d) => d.id))).run()
  }

  // 2. Genuinely removed rows: stamp their text onto referencing snapshots,
  //    then delete (FK sets those snapshots' query_id to NULL).
  if (diff.removed.length > 0) {
    const removedIds = diff.removed.map((r) => r.id)
    preserveSnapshotQueryText(tx, scope.projectId, removedIds)
    tx.delete(queries).where(inArray(queries.id, removedIds)).run()
  }

  // 3. Renames — safe only now that every conflicting raw text is gone.
  for (const keptRow of diff.kept) {
    if (keptRow.currentText !== keptRow.incomingText) {
      tx.update(queries).set({ query: keptRow.incomingText }).where(eq(queries.id, keptRow.id)).run()
    }
  }

  // 4. Brand-new texts.
  for (const text of diff.insertedTexts) {
    tx.insert(queries).values({
      id: crypto.randomUUID(),
      projectId: scope.projectId,
      query: text,
      provenance: 'cli',
      createdAt: now,
    }).run()
  }

  return diff
}
