import { z } from 'zod'

/**
 * Why a Cloudflare Queue sync stopped pulling.
 *
 * - `backlog-empty`: Cloudflare reported no messages waiting.
 * - `empty-pulls`: pulls kept returning nothing while Cloudflare still
 *   reported a backlog, so the rest was leased or not yet visible. With a
 *   full batch or more waiting, the drain waited longer after each empty pull
 *   and every wait came back empty; with less, two pulls in a row came back
 *   empty.
 * - `unleased-only`: a pull returned only entries without a lease, fewer than
 *   a full batch, so nothing else was waiting to be leased.
 * - `deadline`: the sync's time limit (`CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS`).
 * - `batch-cap`: the pull safety cap behind the time limit.
 * - `error`: a pull, write or acknowledgement failed.
 */
export const cloudflareQueueDrainStopReasonSchema = z.enum([
  'backlog-empty',
  'empty-pulls',
  'unleased-only',
  'deadline',
  'batch-cap',
  'error',
])
export type CloudflareQueueDrainStopReason = z.infer<typeof cloudflareQueueDrainStopReasonSchema>
export const CloudflareQueueDrainStopReasons = cloudflareQueueDrainStopReasonSchema.enum

const count = z.number().int().nonnegative()

/** What one Cloudflare Queue sync did, and why it stopped. */
export const cloudflareQueueDrainSummarySchema = z.object({
  type: z.literal('cloudflare-queue'),
  stopReason: cloudflareQueueDrainStopReasonSchema,
  /** Pulls that returned a response. A failed pull is not counted. */
  pulls: count,
  /** Pulls that returned no leased message. */
  emptyPulls: count,
  /** Leased messages received across all pulls. */
  messagesPulled: count,
  /** Leases acknowledged after their batch was saved (valid and malformed). */
  messagesAcknowledged: count,
  /** Malformed or foreign messages acknowledged and dropped. */
  poisonMessages: count,
  /** Entries Cloudflare returned without a lease; they stay eligible for redelivery. */
  skippedUnleasedMessages: count,
  /** Events stored for the first time. */
  acceptedEvents: count,
  /** Events already received earlier: redeliveries of messages that were saved before. */
  duplicateEvents: count,
  /** Backlog Cloudflare reported on the first pull. Null when no pull returned. */
  backlogAtFirstPull: count.nullable(),
  /** Backlog Cloudflare reported on the last pull. Null when no pull returned. */
  backlogAtLastPull: count.nullable(),
  elapsedMs: count,
})
export type CloudflareQueueDrainSummary = z.infer<typeof cloudflareQueueDrainSummarySchema>

/**
 * What a sync run did, by source kind. Recorded only by syncs that report
 * one; other runs omit it.
 */
export const runSyncSummarySchema = z.discriminatedUnion('type', [cloudflareQueueDrainSummarySchema])
export type RunSyncSummary = z.infer<typeof runSyncSummarySchema>
