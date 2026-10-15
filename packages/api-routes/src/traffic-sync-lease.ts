import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { trafficSources, type DatabaseClient } from '@canonry/canonry-db'

export interface TrafficSyncLeaseClaimInput {
  db: DatabaseClient
  sourceId: string
  owner: string
  /** Injected ISO instant: the helper never reads the process clock. */
  now: string
  ttlMs: number
}

export interface TrafficSyncLeaseReleaseInput {
  db: DatabaseClient
  sourceId: string
  owner: string
  /** Injected ISO instant: the helper never reads the process clock. */
  now: string
}

function leaseExpiresAt(now: string, ttlMs: number): string {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new RangeError('Traffic sync lease now must be an ISO instant')
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('Traffic sync lease ttlMs must be positive')
  return new Date(nowMs + ttlMs).toISOString()
}

/**
 * Atomically claim a source lease. A current owner may renew; a stale lease
 * may be recovered by a new owner. A live foreign owner is never overwritten.
 */
export function tryClaimTrafficSyncLease(input: TrafficSyncLeaseClaimInput): boolean {
  const expiresAt = leaseExpiresAt(input.now, input.ttlMs)
  return input.db.transaction((tx) => {
    const changed = tx.update(trafficSources).set({
      syncLeaseOwner: input.owner,
      syncLeaseExpiresAt: expiresAt,
    }).where(and(
      eq(trafficSources.id, input.sourceId),
      or(
        isNull(trafficSources.syncLeaseOwner),
        lte(trafficSources.syncLeaseExpiresAt, input.now),
        eq(trafficSources.syncLeaseOwner, input.owner),
      ),
    )).run()
    return changed.changes === 1
  }, { behavior: 'immediate' })
}

/** Release only the lease held by this owner; stale callers cannot clear a successor's lease. */
export function releaseTrafficSyncLease(input: TrafficSyncLeaseReleaseInput): boolean {
  return input.db.transaction((tx) => {
    const changed = tx.update(trafficSources).set({
      syncLeaseOwner: null,
      syncLeaseExpiresAt: null,
    }).where(and(
      eq(trafficSources.id, input.sourceId),
      eq(trafficSources.syncLeaseOwner, input.owner),
    )).run()
    return changed.changes === 1
  }, { behavior: 'immediate' })
}
