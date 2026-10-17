import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { normalizeQueryText } from '@canonry/canonry-contracts'
import type { DatabaseClient } from '@canonry/canonry-db'
import { queries, queryBasketVersions } from '@canonry/canonry-db'

/**
 * The set of queries a project was measuring, versioned.
 *
 * Analytics has to hold its query set constant to produce a trend — a bucket
 * whose queries differ from its neighbour is not a comparison. That constraint
 * used to be enforced with `query.createdAt < bucketStart`, a proxy for "was
 * this query in the same measurement set" that is wrong in ways that cost real
 * signal:
 *
 *   - re-adding a query mints a new row, so it looks brand new and its own
 *     history detaches from it
 *   - a rename is a delete plus an add, with the same effect
 *   - eligibility shifts silently whenever bucket boundaries move
 *   - nothing anywhere recorded WHICH set was being measured
 *
 * A revision makes membership explicit. Runs are stamped with the revision that
 * was current when they started, so a comparison is like-for-like by
 * construction, and a change of basket becomes a visible event rather than an
 * inference from timestamps.
 *
 * Revisions are minted LAZILY from the live query set rather than hooked onto
 * every mutation site. Query mutations live in at least three routes today and
 * a fourth would silently skip the hook — the failure would be an unversioned
 * basket that still looks fine. Deriving from the current set has no call site
 * to forget.
 */

/** Membership is by normalized text, so re-adding the same query rejoins its own history. */
export function queryBasketMembers(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .select({ query: queries.query })
    .from(queries)
    .where(eq(queries.projectId, projectId))
    .all()
  // Sorted + deduped so the checksum depends on the SET, never on insert order.
  return [...new Set(rows.map(row => normalizeQueryText(row.query)))].sort()
}

export function queryBasketChecksum(members: readonly string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(members)).digest('hex')
}

export interface QueryBasketRevision {
  revision: number
  checksum: string
  members: string[]
  createdAt: string
}

/** The newest recorded revision, or null when this project has never been stamped. */
export function latestQueryBasketRevision(
  db: DatabaseClient,
  projectId: string,
): QueryBasketRevision | null {
  const row = db
    .select()
    .from(queryBasketVersions)
    .where(eq(queryBasketVersions.projectId, projectId))
    .orderBy(desc(queryBasketVersions.revision))
    .limit(1)
    .get()
  if (!row) return null
  return {
    revision: row.revision,
    checksum: row.checksum,
    members: JSON.parse(row.membersJson) as string[],
    createdAt: row.createdAt,
  }
}

export function queryBasketRevisionAt(
  db: DatabaseClient,
  projectId: string,
  revision: number,
): QueryBasketRevision | null {
  const row = db
    .select()
    .from(queryBasketVersions)
    .where(and(eq(queryBasketVersions.projectId, projectId), eq(queryBasketVersions.revision, revision)))
    .get()
  if (!row) return null
  return {
    revision: row.revision,
    checksum: row.checksum,
    members: JSON.parse(row.membersJson) as string[],
    createdAt: row.createdAt,
  }
}

/**
 * The revision describing the project's CURRENT query set, minting one when the
 * set has changed since the last stamp.
 *
 * Idempotent: an unchanged basket returns the existing revision rather than
 * churning a new one on every run, so revision numbers count real changes and
 * a basket-change marker means something happened.
 *
 * Returns null for a project with no queries — there is no basket to version,
 * and stamping an empty one would make "no queries yet" look like a deliberate
 * measurement set.
 */
export function ensureCurrentQueryBasketRevision(
  db: DatabaseClient,
  projectId: string,
  now: string = new Date().toISOString(),
): QueryBasketRevision | null {
  const members = queryBasketMembers(db, projectId)
  if (members.length === 0) return null

  const checksum = queryBasketChecksum(members)
  const latest = latestQueryBasketRevision(db, projectId)
  if (latest && latest.checksum === checksum) return latest

  const revision = (latest?.revision ?? 0) + 1
  db.insert(queryBasketVersions).values({
    projectId,
    revision,
    membersJson: JSON.stringify(members),
    checksum,
    createdAt: now,
  }).run()
  return { revision, checksum, members, createdAt: now }
}
