import { and, eq, lt, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { rawEventSamples } from '@canonry/canonry-db'

export const RAW_EVENT_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60_000
export const RAW_EVENT_SAMPLE_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000

type RawEventSampleRetentionDb = Pick<DatabaseClient, 'delete'>

const CANONICAL_UTC_TIMESTAMP_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'

export function rawEventSampleRetentionCutoff(referenceAt: string): string {
  const referenceMs = Date.parse(referenceAt)
  if (!Number.isFinite(referenceMs)) throw new RangeError('referenceAt must be a valid timestamp')
  return new Date(referenceMs - RAW_EVENT_SAMPLE_RETENTION_MS).toISOString()
}

function deleteExpiredRawEventSamples(
  db: RawEventSampleRetentionDb,
  cutoff: string,
  sourceId?: string,
): void {
  const sourceScope = sourceId === undefined
    ? undefined
    : eq(rawEventSamples.sourceId, sourceId)

  // New writes are canonical UTC, so the common expiry path can use the
  // indexed TEXT comparison. Legacy offsets need instant-aware comparison;
  // invalid legacy timestamps have no trustworthy retention age and expire.
  db
    .delete(rawEventSamples)
    .where(and(sourceScope, sql`julianday(${rawEventSamples.ts}) IS NULL`))
    .run()
  db
    .delete(rawEventSamples)
    .where(and(
      sourceScope,
      sql`${rawEventSamples.ts} GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB}`,
      lt(rawEventSamples.ts, cutoff),
    ))
    .run()
  db
    .delete(rawEventSamples)
    .where(and(
      sourceScope,
      sql`${rawEventSamples.ts} NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB}`,
      sql`julianday(${rawEventSamples.ts}) < julianday(${cutoff})`,
    ))
    .run()
}

/** Delete expired evidence for one source and return the inclusive retention boundary. */
export function enforceRawEventSampleRetention(
  db: RawEventSampleRetentionDb,
  sourceId: string,
  referenceAt: string,
): string {
  const cutoff = rawEventSampleRetentionCutoff(referenceAt)
  deleteExpiredRawEventSamples(db, cutoff, sourceId)
  return cutoff
}

/** Delete expired evidence across every source for startup/daily maintenance. */
export function enforceGlobalRawEventSampleRetention(
  db: RawEventSampleRetentionDb,
  referenceAt: string,
): string {
  const cutoff = rawEventSampleRetentionCutoff(referenceAt)
  deleteExpiredRawEventSamples(db, cutoff)
  return cutoff
}

/** Return one canonical UTC timestamp when the sample is inside the retention window. */
export function retainedRawEventSampleTimestamp(
  observedAt: string,
  cutoff: string,
): string | null {
  const observedMs = Date.parse(observedAt)
  const cutoffMs = Date.parse(cutoff)
  if (!Number.isFinite(observedMs) || !Number.isFinite(cutoffMs) || observedMs < cutoffMs) {
    return null
  }
  return new Date(observedMs).toISOString()
}
