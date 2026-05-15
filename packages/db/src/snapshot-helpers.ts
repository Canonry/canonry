/**
 * `query_snapshots.queryId` became nullable in migration v58 (FK now
 * `ON DELETE SET NULL` — see schema.ts comment). Most existing consumers
 * group by queryId and aren't set up to handle orphan snapshots — the
 * remnants of a deleted tracked query. This helper drops those rows and
 * narrows the type so the caller keeps using `queryId` as `string`.
 *
 * A future "deleted-query audit" view that wants to surface orphans should
 * skip this filter and read `queryText` (the denormalized column) directly.
 */
export function filterTrackedSnapshots<T extends { queryId: string | null }>(
  rows: readonly T[],
): Array<T & { queryId: string }> {
  return rows.filter((r): r is T & { queryId: string } => r.queryId !== null)
}
