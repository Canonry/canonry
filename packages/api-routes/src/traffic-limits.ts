import { TrafficSourceTypes, type TrafficSourceType } from '@canonry/canonry-contracts'

/**
 * Bounds on incremental traffic sync, shared by the sync route and the doctor
 * checks so the discard cliff is stated once. A duplicated literal here would
 * drift from the route and make the health check quietly wrong about when data
 * starts being lost.
 */

// A watermark that drifted far behind (source idle while its schedule was
// paused/missing, or a drain that cannot keep up) would otherwise make the
// adaptive drain grind through days of sub-windows in a single sync. Clamp the
// start to at most this far before the sync instant. The skipped pre-cap span is
// surfaced as a warn, never silently dropped — a backfill recovers it.
export const VERCEL_MAX_SYNC_WINDOW_MS = 24 * 60 * 60_000

// Wall-clock budget for a single incremental Vercel sync's adaptive drain. The
// drain checks this before each sub-window pull; on hit it stops and reports how
// far it got, and the route commits that partial window + advances `lastSyncedAt`
// to it. Without this bound a dense or slow window runs for many minutes —
// timing out the caller and leaving an orphaned 'running' run.
export const DEFAULT_VERCEL_SYNC_DEADLINE_MS = 4 * 60_000

/** Maximum Queue envelopes requested in one Cloudflare HTTP pull. */
export const CLOUDFLARE_QUEUE_BATCH_SIZE = 100

/**
 * Wall-clock budget for one Cloudflare Queue sync's drain, checked before each
 * pull. The drain keeps pulling while Cloudflare reports a backlog and stops at
 * this deadline, so a busy Queue drains as fast as pulls allow instead of a
 * fixed number of messages per sync. Overridable with
 * `CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS`.
 */
export const DEFAULT_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS = 4 * 60_000

/** Safety cap on pulls per Queue sync, behind the deadline. Hosts may override it. */
export const DEFAULT_CLOUDFLARE_QUEUE_MAX_BATCHES = 300

/**
 * Waits before pulling again after consecutive empty pulls while Cloudflare
 * still reports at least a full batch waiting. Cloudflare answers pulls empty
 * now and then while messages wait (about 3 pulls in 10 on a busy Queue); a
 * drain that stopped after two empty pulls in a row left about 1,000 messages
 * behind on every sync, and requests reached the dashboard up to 45 minutes
 * late. The drain stops only after every wait came back empty, and never
 * waits past its deadline. Under a full batch, two empty pulls in a row still
 * end the drain without a wait.
 */
export const DEFAULT_CLOUDFLARE_QUEUE_EMPTY_PULL_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]

/**
 * Residual backlog after a sync that still reads as normal: messages that
 * arrived while the drain ran. More than this means the drain stopped at its
 * deadline or cap before the Queue was empty.
 */
export const CLOUDFLARE_QUEUE_RESIDUAL_WARN_COUNT = 1_000

/** Floor/ceiling for the env overrides, so a typo cannot disable the bound. */
const MIN_VERCEL_SYNC_DEADLINE_MS = 30_000
const MAX_VERCEL_SYNC_DEADLINE_MS = 15 * 60_000

/**
 * How far back a single incremental sync can reach, per source type. A source
 * whose watermark falls past this stops being able to catch up: each sync
 * clamps its start forward and the skipped span is lost until backfilled.
 *
 * Absence from this map means only that the adapter has no TIME-BASED cliff.
 * It is not a claim that the adapter cannot lose data. Of the current
 * adapters only WordPress persists a resumable cursor (`lastCursor`); Cloud Run
 * paginates with `nextPageToken` WITHIN a single pull and never stores it, so a
 * pull truncated by its page budget still advances `lastSyncedAt` past the
 * unfetched remainder. Lag on such a source is therefore not provably harmless,
 * and the sync-lag check must report it as lag rather than as "no loss
 * possible".
 */
export const TRAFFIC_SOURCE_MAX_CATCHUP_MS: Partial<Record<TrafficSourceType, number>> = {
  [TrafficSourceTypes.vercel]: VERCEL_MAX_SYNC_WINDOW_MS,
}

/**
 * Resolve the per-sync drain budget from the environment.
 *
 * This exists because the drain rate is the only lever that decides whether a
 * source catches up or falls further behind, and until now it was reachable
 * only from tests. A source whose drain advances less wall-clock per sync than
 * the interval between syncs loses ground every cycle and eventually crosses
 * the discard cliff, so an operator needs to raise this without shipping code.
 *
 * Returns undefined when unset or unparseable, leaving the caller's default in
 * place. Values are clamped rather than rejected so a bad env cannot take the
 * bound off entirely.
 */
export function resolveVercelSyncDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.CANONRY_VERCEL_SYNC_DEADLINE_MS
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(MAX_VERCEL_SYNC_DEADLINE_MS, Math.max(MIN_VERCEL_SYNC_DEADLINE_MS, Math.trunc(parsed)))
}

/**
 * Resolve the Cloudflare Queue drain deadline from the environment, like
 * `resolveVercelSyncDeadlineMs`: the drain rate is what decides whether a busy
 * Queue catches up before its retention drops messages, so an operator needs
 * to raise it without shipping code. Undefined when unset or unparseable;
 * clamped to 30 seconds through 15 minutes.
 */
export function resolveCloudflareQueueSyncDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(MAX_VERCEL_SYNC_DEADLINE_MS, Math.max(MIN_VERCEL_SYNC_DEADLINE_MS, Math.trunc(parsed)))
}
