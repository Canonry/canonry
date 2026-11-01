import crypto from 'node:crypto'
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm'
import type { DatabaseClient, RawEventSampleEventType } from '@canonry/canonry-db'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  aiUserFetchVerificationManifestsHourly,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  RawEventSampleEventTypes,
  rawEventSamples,
  trafficEventReceipts,
  trafficSources,
} from '@canonry/canonry-db'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { buildTrafficProbeReport } from '@canonry/canonry-integration-traffic'
import {
  enforceRawEventSampleRetention,
  retainedRawEventSampleTimestamp,
} from './raw-event-sample-retention.js'
import { recordJourneyBatch } from './journeys.js'

// Signatures expire after five minutes. Keep receipts for one additional
// replay window so clock skew and an edge retry cannot double-count, without
// retaining a full day of high-volume event ids.
export const DIRECT_PUSH_RECEIPT_TTL_MS = 10 * 60_000

/** The stored sample type for a classified request; the first matching kind wins. */
export function rawEventSampleEventType(sample: { crawler: unknown; aiUserFetch: unknown; aiReferral: unknown }): RawEventSampleEventType {
  if (sample.crawler) return RawEventSampleEventTypes.crawler
  if (sample.aiUserFetch) return RawEventSampleEventTypes.aiUserFetch
  if (sample.aiReferral) return RawEventSampleEventTypes.aiReferral
  return RawEventSampleEventTypes.unknown
}

type TrafficSourceRow = typeof trafficSources.$inferSelect
type TrafficSourceIngestUpdate = Partial<Pick<
  TrafficSourceRow,
  | 'lastCursor'
  | 'lastError'
  | 'lastSyncedAt'
  | 'lastWorkerVersion'
  | 'queueBacklogCount'
  | 'queueBacklogObservedAt'
  | 'status'
  | 'updatedAt'
>>

export interface WriteTrafficEventBatchOptions {
  db: DatabaseClient
  projectId: string
  sourceId: string
  events: readonly NormalizedTrafficRequest[]
  receivedAt: string
  receiptTtlMs: number
  sampleLimit: number
  /** Re-evaluated inside the write transaction so archive/revoke races fail closed. */
  validateSource: (source: TrafficSourceRow | undefined) => void
  /** Adapter-owned progress fields committed atomically with receipts and rollups. */
  sourceUpdate: TrafficSourceIngestUpdate
  /** Install secret for AI visitor journey keys; absent writes no journey rows. */
  journeyKeySecret?: string
  /** A journey write failed and was rolled back; the traffic batch still commits. */
  onJourneyError?: (error: unknown) => void
}

export interface WriteTrafficEventBatchResult {
  acceptedEvents: number
  duplicateEvents: number
  selfTrafficExcluded: number
  crawlerHits: number
  aiUserFetchHits: number
  aiReferralHits: number
  unknownHits: number
  crawlerBucketRows: number
  aiUserFetchBucketRows: number
  aiReferralBucketRows: number
  sampleRows: number
}

function observedUtcHourBounds(observedAt: string): { start: string; end: string } | null {
  const instant = new Date(observedAt)
  if (Number.isNaN(instant.getTime())) return null
  instant.setUTCMinutes(0, 0, 0)
  const start = instant.toISOString()
  instant.setUTCHours(instant.getUTCHours() + 1)
  return { start, end: instant.toISOString() }
}

/**
 * Claim transport-neutral event ids and write their shared rollups atomically.
 *
 * Direct push and the Queue pull consumer use the same boundary: the
 * adapter supplies normalized events, its receipt horizon, source validation,
 * and progress fields. A receipt exists iff every rollup write committed, so an
 * upstream redelivery is safe after a process crash or acknowledgement loss.
 */
export function writeTrafficEventBatch(
  opts: WriteTrafficEventBatchOptions,
): WriteTrafficEventBatchResult {
  const expiresAt = new Date(Date.parse(opts.receivedAt) + opts.receiptTtlMs).toISOString()
  let acceptedEvents = 0
  let duplicateEvents = 0
  let crawlerBucketRows = 0
  let aiUserFetchBucketRows = 0
  let aiReferralBucketRows = 0
  let sampleRows = 0
  let selfTrafficExcluded = 0
  let crawlerHits = 0
  let aiUserFetchHits = 0
  let aiReferralHits = 0
  let unknownHits = 0

  opts.db.transaction((tx) => {
    // Serialize writers for one source before checking its hourly sample
    // count. Receipt uniqueness protects rollups independently, while this
    // source-row lock keeps concurrent one-event pushes under the shared raw
    // sample cap. The no-op write participates in the transaction and leaves
    // the stored timestamp unchanged.
    tx
      .update(trafficSources)
      .set({ updatedAt: sql`${trafficSources.updatedAt}` })
      .where(eq(trafficSources.id, opts.sourceId))
      .run()

    const source = tx
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, opts.sourceId))
      .get()
    opts.validateSource(source)

    const rawSampleCutoff = enforceRawEventSampleRetention(
      tx,
      opts.sourceId,
      opts.receivedAt,
    )

    // Opportunistic, source-local sweep. The expiry index keeps this bounded,
    // and scoping prevents one noisy source from doing cleanup work for all.
    tx
      .delete(trafficEventReceipts)
      .where(and(
        eq(trafficEventReceipts.sourceId, opts.sourceId),
        lte(trafficEventReceipts.expiresAt, opts.receivedAt),
      ))
      .run()

    const claimedEvents: NormalizedTrafficRequest[] = []
    for (const event of opts.events) {
      const claim = tx
        .insert(trafficEventReceipts)
        .values({
          sourceId: opts.sourceId,
          eventId: event.eventId,
          receivedAt: opts.receivedAt,
          expiresAt,
        })
        .onConflictDoNothing()
        .run()
      if (claim.changes === 1) claimedEvents.push(event)
      else duplicateEvents += 1
    }
    acceptedEvents = claimedEvents.length

    if (claimedEvents.length > 0) {
      // Build every eligible sample from this bounded batch. The durable
      // source/hour cap below, not the transport batch size, decides which
      // samples persist. This keeps one-event push and Queue batches
      // on the same storage boundary.
      const report = buildTrafficProbeReport(claimedEvents, { sampleLimit: claimedEvents.length })
      // AI visitor journeys from the newly claimed events, in this transaction.
      recordJourneyBatch(tx, { projectId: opts.projectId, sourceId: opts.sourceId, events: claimedEvents, secret: opts.journeyKeySecret, now: opts.receivedAt }, {
        onError: error => opts.onJourneyError?.(error),
        outerActive: () => opts.db.$client.inTransaction,
      })
      selfTrafficExcluded = report.totals.selfTrafficExcluded
      crawlerHits = report.totals.crawlerHits
      aiUserFetchHits = report.totals.aiUserFetchHits
      aiReferralHits = report.totals.aiReferralHits
      unknownHits = report.totals.unknownHits

      for (const bucket of report.crawlerEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(crawlerEventsHourly)
          .values({
            projectId: opts.projectId,
            sourceId: opts.sourceId,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: opts.receivedAt,
            updatedAt: opts.receivedAt,
          })
          .onConflictDoUpdate({
            target: [
              crawlerEventsHourly.projectId,
              crawlerEventsHourly.sourceId,
              crawlerEventsHourly.tsHour,
              crawlerEventsHourly.botId,
              crawlerEventsHourly.verificationStatus,
              crawlerEventsHourly.pathNormalized,
              crawlerEventsHourly.status,
            ],
            set: {
              hits: sql`${crawlerEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: opts.receivedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(crawlerVerificationManifestsHourly)
            .values({
              projectId: opts.projectId,
              sourceId: opts.sourceId,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: opts.receivedAt,
              updatedAt: opts.receivedAt,
            })
            .onConflictDoUpdate({
              target: [
                crawlerVerificationManifestsHourly.projectId,
                crawlerVerificationManifestsHourly.sourceId,
                crawlerVerificationManifestsHourly.tsHour,
                crawlerVerificationManifestsHourly.botId,
                crawlerVerificationManifestsHourly.verificationStatus,
                crawlerVerificationManifestsHourly.pathNormalized,
                crawlerVerificationManifestsHourly.status,
                crawlerVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${crawlerVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: opts.receivedAt,
              },
            })
            .run()
        }
        crawlerBucketRows += 1
      }

      for (const bucket of report.aiUserFetchEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiUserFetchEventsHourly)
          .values({
            projectId: opts.projectId,
            sourceId: opts.sourceId,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: opts.receivedAt,
            updatedAt: opts.receivedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiUserFetchEventsHourly.projectId,
              aiUserFetchEventsHourly.sourceId,
              aiUserFetchEventsHourly.tsHour,
              aiUserFetchEventsHourly.botId,
              aiUserFetchEventsHourly.verificationStatus,
              aiUserFetchEventsHourly.pathNormalized,
              aiUserFetchEventsHourly.status,
            ],
            set: {
              hits: sql`${aiUserFetchEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: opts.receivedAt,
            },
          })
          .run()
        // Nothing was consulted for this bucket, so there is no provenance to
        // record. A sentinel row would count these hits as ATTRIBUTED and drive
        // verificationUnattributedHits to 0; the ABSENCE of a sidecar row is what
        // makes a read report them as unattributed.
        if (bucket.verificationManifest) {
          tx
            .insert(aiUserFetchVerificationManifestsHourly)
            .values({
              projectId: opts.projectId,
              sourceId: opts.sourceId,
              tsHour: bucket.tsHour,
              botId: bucket.botId,
              verificationStatus: bucket.verificationStatus,
              pathNormalized: bucket.pathNormalized,
              status,
              manifestId: bucket.verificationManifest.id,
              manifestJson: bucket.verificationManifest,
              hits: bucket.hits,
              createdAt: opts.receivedAt,
              updatedAt: opts.receivedAt,
            })
            .onConflictDoUpdate({
              target: [
                aiUserFetchVerificationManifestsHourly.projectId,
                aiUserFetchVerificationManifestsHourly.sourceId,
                aiUserFetchVerificationManifestsHourly.tsHour,
                aiUserFetchVerificationManifestsHourly.botId,
                aiUserFetchVerificationManifestsHourly.verificationStatus,
                aiUserFetchVerificationManifestsHourly.pathNormalized,
                aiUserFetchVerificationManifestsHourly.status,
                aiUserFetchVerificationManifestsHourly.manifestId,
              ],
              set: {
                hits: sql`${aiUserFetchVerificationManifestsHourly.hits} + ${bucket.hits}`,
                manifestJson: bucket.verificationManifest,
                updatedAt: opts.receivedAt,
              },
            })
            .run()
        }
        aiUserFetchBucketRows += 1
      }

      for (const bucket of report.aiReferralEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiReferralEventsHourly)
          .values({
            projectId: opts.projectId,
            sourceId: opts.sourceId,
            tsHour: bucket.tsHour,
            product: bucket.product,
            operator: bucket.operator,
            sourceDomain: bucket.sourceDomain,
            evidenceType: bucket.evidenceType,
            landingPathNormalized: bucket.landingPathNormalized,
            status,
            sessionsOrHits: bucket.hits,
            paidSessionsOrHits: bucket.paidHits,
            organicSessionsOrHits: bucket.organicHits,
            usersEstimated: null,
            createdAt: opts.receivedAt,
            updatedAt: opts.receivedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiReferralEventsHourly.projectId,
              aiReferralEventsHourly.sourceId,
              aiReferralEventsHourly.tsHour,
              aiReferralEventsHourly.product,
              aiReferralEventsHourly.sourceDomain,
              aiReferralEventsHourly.evidenceType,
              aiReferralEventsHourly.landingPathNormalized,
              aiReferralEventsHourly.status,
            ],
            set: {
              sessionsOrHits: sql`${aiReferralEventsHourly.sessionsOrHits} + ${bucket.hits}`,
              paidSessionsOrHits: sql`${aiReferralEventsHourly.paidSessionsOrHits} + ${bucket.paidHits}`,
              organicSessionsOrHits: sql`${aiReferralEventsHourly.organicSessionsOrHits} + ${bucket.organicHits}`,
              updatedAt: opts.receivedAt,
            },
          })
          .run()
        aiReferralBucketRows += 1
      }

      const hourlySampleLimit = Math.max(0, Math.floor(opts.sampleLimit))
      const remainingSamplesByHour = new Map<string, number>()
      for (const sample of report.samples) {
        const sampleTimestamp = retainedRawEventSampleTimestamp(sample.observedAt, rawSampleCutoff)
        if (!sampleTimestamp) continue
        const hour = observedUtcHourBounds(sampleTimestamp)
        if (!hour || hourlySampleLimit === 0) continue
        let remaining = remainingSamplesByHour.get(hour.start)
        if (remaining === undefined) {
          const existing = tx
            .select({ total: sql<number>`COUNT(*)` })
            .from(rawEventSamples)
            .where(and(
              eq(rawEventSamples.sourceId, opts.sourceId),
              gte(rawEventSamples.ts, hour.start),
              lt(rawEventSamples.ts, hour.end),
            ))
            .get()
          remaining = Math.max(0, hourlySampleLimit - Number(existing?.total ?? 0))
        }
        if (remaining === 0) {
          remainingSamplesByHour.set(hour.start, 0)
          continue
        }

        const eventType = rawEventSampleEventType(sample)
        const refererHost = (() => {
          if (!sample.referer) return null
          try {
            return new URL(sample.referer).hostname
          } catch {
            return null
          }
        })()
        tx
          .insert(rawEventSamples)
          .values({
            id: crypto.randomUUID(),
            projectId: opts.projectId,
            sourceId: opts.sourceId,
            ts: sampleTimestamp,
            eventType,
            ipHash: null,
            userAgent: sample.userAgent,
            pathNormalized: sample.pathNormalized,
            status: sample.status,
            refererHost,
            classifierDetailsJson: {
              crawler: sample.crawler,
              aiUserFetch: sample.aiUserFetch,
              aiReferral: sample.aiReferral,
            },
            createdAt: opts.receivedAt,
          })
          .run()
        sampleRows += 1
        remainingSamplesByHour.set(hour.start, remaining - 1)
      }
    }

    tx
      .update(trafficSources)
      .set(opts.sourceUpdate)
      .where(eq(trafficSources.id, opts.sourceId))
      .run()
  })

  return {
    acceptedEvents,
    duplicateEvents,
    selfTrafficExcluded,
    crawlerHits,
    aiUserFetchHits,
    aiReferralHits,
    unknownHits,
    crawlerBucketRows,
    aiUserFetchBucketRows,
    aiReferralBucketRows,
    sampleRows,
  }
}
