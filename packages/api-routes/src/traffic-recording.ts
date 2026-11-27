import { and, eq, notInArray } from 'drizzle-orm'
import { trafficSources, type DatabaseClient } from '@canonry/canonry-db'
import {
  CloudflareTrafficDeliveryModes,
  TrafficSourceStatuses,
  TrafficSourceTypes,
} from '@canonry/canonry-contracts'

/**
 * A Cloudflare Worker that pushes each batch to Canonry has no Canonry-side
 * pull watermark: nothing records how far its traffic is complete. A missing
 * mode is the legacy direct-push shape. Queue pull, and any future mode, is a
 * pull source with a watermark like the others.
 */
export function isCloudflareDirectPush(source: { sourceType: string; configJson: Record<string, unknown> }): boolean {
  if (source.sourceType !== TrafficSourceTypes.cloudflare) return false
  const deliveryMode = source.configJson.deliveryMode
  return deliveryMode === undefined
    || deliveryMode === CloudflareTrafficDeliveryModes['direct-push']
}

/**
 * How far the selected sources' traffic has been recorded, from their sync
 * watermarks (`last_synced_at`: every request before it has been pulled).
 *
 * - `anyThroughMs`: the newest watermark. Past it no selected source has
 *   reported anything, so a bucket that begins there was not measured, however
 *   long ago it was. A source whose syncs keep failing holds its watermark
 *   still, and without this its silent days read as a measured zero.
 * - `allThroughMs`: the oldest watermark. Past it at least one source has not
 *   reported yet, so a bucket that ends after it holds only part of the traffic.
 *
 * Each is null when unbounded: a direct-push Cloudflare source can report at
 * any moment, and a source that never synced has no watermark to read, so
 * neither limits the other sources. Both are null when no selected source has
 * a watermark, which leaves every bucket as it was.
 *
 * Project-wide, only sources that should be reporting count: an archived or
 * paused source stopping is not the project's recording stopping. One
 * selected source counts in any status, because its own history ends there.
 */
export interface TrafficRecordedThrough {
  anyThroughMs: number | null
  allThroughMs: number | null
}

export function trafficRecordedThrough(
  db: DatabaseClient,
  projectId: string,
  sourceId: string | null | undefined,
): TrafficRecordedThrough {
  const rows = db.select({
    sourceType: trafficSources.sourceType,
    configJson: trafficSources.configJson,
    lastSyncedAt: trafficSources.lastSyncedAt,
  }).from(trafficSources).where(sourceId
    ? and(eq(trafficSources.projectId, projectId), eq(trafficSources.id, sourceId))
    : and(
        eq(trafficSources.projectId, projectId),
        notInArray(trafficSources.status, [TrafficSourceStatuses.archived, TrafficSourceStatuses.paused]),
      )).all()

  const watermarks: number[] = []
  for (const row of rows) {
    if (isCloudflareDirectPush(row)) {
      watermarks.push(Number.POSITIVE_INFINITY)
      continue
    }
    const syncedMs = row.lastSyncedAt ? Date.parse(row.lastSyncedAt) : Number.NaN
    if (Number.isFinite(syncedMs)) watermarks.push(syncedMs)
  }
  if (watermarks.length === 0) return { anyThroughMs: null, allThroughMs: null }
  const bounded = (ms: number) => (Number.isFinite(ms) ? ms : null)
  return {
    anyThroughMs: bounded(Math.max(...watermarks)),
    allThroughMs: bounded(Math.min(...watermarks)),
  }
}
