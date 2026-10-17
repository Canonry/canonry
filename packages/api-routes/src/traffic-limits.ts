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

/** Maximum Queue batches drained by one sync unless the host overrides it. */
export const DEFAULT_CLOUDFLARE_QUEUE_MAX_BATCHES = 10

/** Default number of Queue envelopes that one sync can drain. */
export const DEFAULT_CLOUDFLARE_QUEUE_DRAIN_BUDGET =
  CLOUDFLARE_QUEUE_BATCH_SIZE * DEFAULT_CLOUDFLARE_QUEUE_MAX_BATCHES

/** Floor/ceiling for the env override, so a typo cannot disable the bound. */
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
