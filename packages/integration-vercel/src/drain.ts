import type { NormalizedTrafficRequest, VercelTrafficEnvironment } from '@ainyc/canonry-contracts'

import { VercelLogsApiError } from './client.js'
import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from './types.js'

/**
 * Smallest sub-window the drain will subdivide a span down to. Vercel's
 * `request-logs` endpoint accepts millisecond-precision time bounds, so the
 * floor is a canonry-side choice that trades fewer API calls (wider slices)
 * against tolerance for dense bursts (narrower slices). One second is small
 * enough to drain real-world burst minutes (sites routinely hit 1000+ log
 * pages in a single minute; the previous one-minute floor failed the whole
 * sync on those minutes) yet still a meaningful traffic window. A floor-width
 * slice that still overflows the normal page budget is re-pulled once with
 * the larger `FLOOR_SLICE_MAX_PAGES` budget before the drain gives up.
 */
const MIN_SUB_WINDOW_MS = 1_000

/**
 * The span the drain STARTS each window at (and resets to after a retention
 * clamp), instead of beginning at the full window width. Starting at the full
 * span means the first pulls are whole-window overflow pulls that exhaust the
 * entire `pagesPerSubWindow` budget (50 slow pages) before the span has been
 * halved down to something drainable, so for a dense multi-hour backlog the
 * drain can burn its whole wall-clock budget WITHOUT completing a single
 * sub-window: zero cursor progress, and (because the deadline then commits
 * nothing) the source wedges permanently as every retry re-hits the same
 * window. Starting small bounds the first pull to a few pages so it completes
 * fast and the cursor advances; the span doubles back up on clean drains, so a
 * sparse window still drains in O(log) pulls.
 */
const INITIAL_SUB_WINDOW_MS = 5 * 60_000

/**
 * Page budget for a re-pull of a floor-width slice (`MIN_SUB_WINDOW_MS`). When
 * even the floor slice overflows the caller's normal `pagesPerSubWindow`
 * budget, the drain cannot subdivide time any further, so it re-pulls that one
 * slice with this larger budget and ingests it whole. A single one-second
 * slice of real request traffic is bounded; only a pathologically dense
 * second exceeds this and genuinely cannot be drained.
 */
const FLOOR_SLICE_MAX_PAGES = 1_000

/**
 * Once a slice has been narrowed all the way to the floor, keep draining
 * floor-width slices for this many successful pulls before probing a wider
 * span again. Without this cooldown, a sustained dense minute bounces
 * 1s -> 2s -> overflow -> 1s for every other second and can burn the route's
 * sub-window cap before the cursor advances.
 */
const FLOOR_CONGESTION_PROBE_INTERVAL = 60

/**
 * Window size used to probe Vercel's request-logs retention. Kept independent
 * of `MIN_SUB_WINDOW_MS` (the drain floor) so reducing the drain floor does
 * not narrow the retention probe to a sliver: the probe only needs a window
 * wide enough that a successful response reliably means "Vercel will serve
 * this range." One minute is small enough to keep the binary search cheap
 * but wide enough to be a meaningful test.
 */
const RETENTION_PROBE_WINDOW_MS = 60_000

/**
 * Stop the retention-boundary binary search once the servable and unservable
 * probes are within this distance. The returned start is always on the
 * servable side, so this only bounds the probe count (~10 for a 30-day
 * window) and the slack of pre-retention data left undrained (≤ this much).
 */
const RETENTION_BOUNDARY_TOLERANCE_MS = 60 * 60_000

export interface DrainVercelTrafficEventsOptions {
  /** Single-window pull — `listVercelTrafficEvents`, or a test double. */
  pull: (options: ListVercelTrafficEventsOptions) => Promise<VercelTrafficEventsPage>
  token: string
  projectId: string
  teamId: string
  environment?: VercelTrafficEnvironment
  /** Window bounds (epoch ms or Date). */
  startDate: Date | number
  endDate: Date | number
  /** Page budget for each sub-window pull. */
  pagesPerSubWindow: number
  /** Hard cap on sub-window pulls before the drain gives up. */
  maxSubWindows: number
  /**
   * Optional wall-clock deadline (epoch ms). Checked before each sub-window
   * pull: once `now() >= deadlineMs` the drain stops and returns what it has
   * drained so far with `deadlineReached: true` and `drainedThroughMs` set to
   * the last fully-drained instant. An additive incremental-sync caller commits
   * that partial window and advances `lastSyncedAt` to `drainedThroughMs`, so a
   * dense or slow window makes forward progress every run instead of grinding
   * unbounded (timing out the caller and orphaning a 'running' run). Left unset,
   * the drain runs until the window is fully drained or `maxSubWindows` is hit —
   * the original behaviour, which replace-mode backfill keeps.
   */
  deadlineMs?: number
  /** Injectable clock for the deadline check; defaults to `Date.now`. Tests override it. */
  now?: () => number
  /**
   * Fail immediately if a floor-width slice overflows even `FLOOR_SLICE_MAX_PAGES`
   * instead of sampling-and-advancing past it. Replace-mode callers (backfill)
   * set this: a truncated sample must never overwrite a full window's rollup, and
   * failing on the *first* irreducible slice avoids draining the rest of a window
   * that will be rejected anyway. The default (additive incremental sync) leaves
   * this unset so a single pathological second can't wedge the source.
   */
  abortOnTruncation?: boolean
}

export interface DrainVercelTrafficEventsResult {
  events: NormalizedTrafficRequest[]
  /** Number of sub-window pulls made, overflow retries included. */
  subWindowCount: number
  /**
   * Window start the drain actually pulled from (epoch ms). Equals the
   * requested `startDate` unless `retentionClamped` is true.
   */
  effectiveStartMs: number
  /**
   * True when the requested window began before Vercel's `request-logs`
   * retention ceiling. The start was clamped forward to the earliest instant
   * Vercel would serve; `[effectiveStartMs, endDate]` is fully drained but the
   * pre-retention remainder is unrecoverable — Vercel no longer holds it.
   */
  retentionClamped: boolean
  /**
   * Count of floor-width (`MIN_SUB_WINDOW_MS`) slices that still overflowed the
   * `FLOOR_SLICE_MAX_PAGES` budget. Time cannot be sliced thinner, so each such
   * slice was ingested up to the budget and the drain advanced past it instead
   * of failing the whole sync. A non-zero count means the events for those
   * seconds are a sample, not the complete set — the caller should surface it.
   */
  truncatedSliceCount: number
  /** Epoch-ms start of each truncated floor slice, for operator logging. */
  truncatedSliceStartsMs: number[]
  /**
   * Count of head slices the drain SKIPPED past undrained because the wall-clock
   * deadline elapsed while it was still narrowing a dense or slow slice at the
   * window start down to a drainable floor. Distinct from `truncatedSliceCount`
   * (those slices WERE pulled, just sampled): a deadline-skipped slice was never
   * drained at all — the drain advanced the cursor past it so the source can
   * never wedge on an un-narrowable head. Non-zero means that head span was
   * dropped; the caller should surface it.
   */
  deadlineSkippedSliceCount: number
  /** Epoch-ms start of each deadline-skipped head slice, for operator logging. */
  deadlineSkippedSliceStartsMs: number[]
  /**
   * Furthest instant (epoch ms) the drain fully completed. Equals `endDate` on
   * a normal full drain; on a `deadlineReached` stop it is the last cleanly
   * drained sub-window boundary, so `[startDate, drainedThroughMs]` is complete
   * and the caller can safely advance `lastSyncedAt` to it.
   */
  drainedThroughMs: number
  /**
   * True when the drain stopped early because it reached `deadlineMs` before
   * fully draining the window. `[drainedThroughMs, endDate]` is still undrained;
   * the caller resumes from `drainedThroughMs` on the next run.
   */
  deadlineReached: boolean
}

function toMs(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime()
}

/**
 * A retention rejection: Vercel answers HTTP 400 `ExceedsBillingLimitError`
 * when the requested window starts before the plan's `request-logs` retention
 * ceiling. Every other 400 (bad params, bad token) is a real error and must
 * still surface, so the body is matched explicitly.
 */
function isRetentionError(error: unknown): boolean {
  return (
    error instanceof VercelLogsApiError
    && error.status === 400
    && (error.body ?? '').includes('ExceedsBillingLimitError')
  )
}

/**
 * Probe whether Vercel will serve a window starting at `windowStartMs`. A
 * one-page pull is enough — a retention rejection lands on page 0. Returns
 * `false` only on a retention rejection; every other error is rethrown.
 */
async function isServable(
  options: DrainVercelTrafficEventsOptions,
  windowStartMs: number,
  windowEndMs: number,
): Promise<boolean> {
  try {
    await options.pull({
      token: options.token,
      projectId: options.projectId,
      teamId: options.teamId,
      environment: options.environment,
      startDate: windowStartMs,
      endDate: windowEndMs,
      maxPages: 1,
    })
    return true
  } catch (error) {
    if (isRetentionError(error)) return false
    throw error
  }
}

/**
 * Find the earliest start Vercel will serve, given that `[unservableStartMs,
 * endMs]` has already been rejected for retention. Binary-searches the
 * boundary and returns a start on the servable side (within
 * `RETENTION_BOUNDARY_TOLERANCE_MS`). Returns `endMs` when even the final
 * minute of the window predates retention — nothing is drainable.
 */
async function resolveRetainedStart(
  options: DrainVercelTrafficEventsOptions,
  unservableStartMs: number,
  endMs: number,
): Promise<number> {
  const tailStartMs = Math.max(unservableStartMs, endMs - RETENTION_PROBE_WINDOW_MS)
  if (!(await isServable(options, tailStartMs, endMs))) {
    return endMs
  }
  let lo = unservableStartMs // predates retention
  let hi = tailStartMs // within retention
  while (hi - lo > RETENTION_BOUNDARY_TOLERANCE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (await isServable(options, mid, endMs)) {
      hi = mid
    } else {
      lo = mid
    }
  }
  return hi
}

/**
 * Drain a Vercel `request-logs` time window in adaptive sub-windows.
 *
 * Vercel paginates `request-logs` by page number with no resumable cursor, so
 * a window holding more than `pagesPerSubWindow` pages cannot be pulled in one
 * pass. Instead of failing, this narrows the time window: on overflow the span
 * is halved and retried; after a clean drain the span usually doubles back up.
 * Floor-width congestion is held at the floor briefly before probing wider
 * again, so sustained burst seconds do not burn the sub-window cap by bouncing
 * 1s -> 2s -> overflow on every other pull. Events are deduped by `eventId`,
 * so the instant shared by adjacent sub-windows is never double-counted.
 *
 * If the requested window begins before Vercel's plan retention ceiling — the
 * `ExceedsBillingLimitError` 400 — the start is clamped forward to the
 * earliest instant Vercel will serve and the result is flagged
 * `retentionClamped`, rather than failing the whole drain.
 *
 * A `MIN_SUB_WINDOW_MS` slice that still overflows the normal page budget is
 * re-pulled once with the larger `FLOOR_SLICE_MAX_PAGES` budget. If even that
 * overflows, the slice cannot be sliced thinner: it is ingested as a truncated
 * sample and the drain advances past it (counted in `truncatedSliceCount`)
 * rather than wedging the source forever on one pathological second — unless
 * `abortOnTruncation` is set, in which case the drain throws on the first such
 * slice so a replace-mode caller fails fast instead of draining the rest of a
 * window it will reject. Throws also if `maxSubWindows` is reached before the
 * window is fully drained.
 *
 * If `deadlineMs` is set, the drain stops before starting a sub-window once the
 * wall clock reaches it, returning `deadlineReached: true` and `drainedThroughMs`
 * at the last fully-drained boundary. This bounds a single sync's wall-clock
 * cost: an additive caller commits the partial window and resumes next run, so a
 * dense or slow window converges over several syncs instead of one unbounded
 * grind. (One in-flight pull can overrun the deadline; the bound is approximate.)
 * Crucially, the deadline ALWAYS yields forward progress: if the budget elapsed
 * while still narrowing the head without completing one sub-window (a dense or
 * slow slice at the window start), the drain skips past that head span — counted
 * in `deadlineSkippedSliceCount` — rather than returning a start-equals-end
 * window the caller must fail. Without this a single un-narrowable head wedges
 * the source forever, since every retry re-pulls the same start.
 */
export async function drainVercelTrafficEvents(
  options: DrainVercelTrafficEventsOptions,
): Promise<DrainVercelTrafficEventsResult> {
  const startMs = toMs(options.startDate)
  const endMs = toMs(options.endDate)
  const now = options.now ?? (() => Date.now())

  const events: NormalizedTrafficRequest[] = []
  const seenEventIds = new Set<string>()
  if (endMs <= startMs) {
    return { events, subWindowCount: 0, effectiveStartMs: startMs, retentionClamped: false, truncatedSliceCount: 0, truncatedSliceStartsMs: [], deadlineSkippedSliceCount: 0, deadlineSkippedSliceStartsMs: [], drainedThroughMs: startMs, deadlineReached: false }
  }

  let cursorMs = startMs
  // Start small (not the full window) so the first pull completes and advances
  // the cursor even on a dense multi-hour backlog. See INITIAL_SUB_WINDOW_MS.
  let spanMs = Math.min(endMs - startMs, INITIAL_SUB_WINDOW_MS)
  let subWindowCount = 0
  let effectiveStartMs = startMs
  let retentionClamped = false
  let retentionResolved = false
  let floorSpanProbeCountdown = 0
  let floorPageBudgetCountdown = 0
  let truncatedSliceCount = 0
  let deadlineReached = false
  const truncatedSliceStartsMs: number[] = []
  const deadlineSkippedSliceStartsMs: number[] = []

  while (cursorMs < endMs) {
    // Wall-clock budget: stop before starting another sub-window once the
    // deadline passes. Normally `cursorMs` is the last fully-drained boundary,
    // so the caller commits `[startMs, cursorMs]` and resumes there next run
    // rather than letting one sync grind the whole window unbounded.
    if (options.deadlineMs !== undefined && now() >= options.deadlineMs) {
      deadlineReached = true
      // Guarantee forward progress. If the run actually attempted pulls
      // (`subWindowCount > 0`) but burned its whole budget narrowing the head
      // without completing a single sub-window — a dense or slow slice at the
      // window start that could not be reduced to a drainable floor in time —
      // `cursorMs` is still at the (post-retention-clamp) start. Returning that
      // wedges the source: the additive caller can't advance `lastSyncedAt`, so
      // every retry re-hits the same head forever. Skip past the head by the
      // initial span (the chunk first attempted, now known not to drain in one
      // pass) so the cursor always advances; the skipped span is dropped
      // (recorded here, surfaced by the caller — never silent) and the next run
      // resumes past it. The `subWindowCount > 0` guard matters: if the budget
      // was already spent before the first pull, nothing has been tried, so
      // skipping could drop drainable data — leave the cursor put and let the
      // caller retry with a fresh budget instead.
      if (cursorMs === effectiveStartMs && subWindowCount > 0 && cursorMs < endMs) {
        deadlineSkippedSliceStartsMs.push(cursorMs)
        cursorMs = Math.min(effectiveStartMs + INITIAL_SUB_WINDOW_MS, endMs)
      }
      break
    }
    if (subWindowCount >= options.maxSubWindows) {
      throw new Error(
        `Vercel window not drained within ${options.maxSubWindows} sub-windows — narrow the time range`,
      )
    }

    const subEndMs = Math.min(cursorMs + spanMs, endMs)
    const subSpanMs = subEndMs - cursorMs
    const useFloorPageBudget = subSpanMs <= MIN_SUB_WINDOW_MS && floorPageBudgetCountdown > 0
    const pageBudget = useFloorPageBudget ? FLOOR_SLICE_MAX_PAGES : options.pagesPerSubWindow
    let page: VercelTrafficEventsPage
    try {
      page = await options.pull({
        token: options.token,
        projectId: options.projectId,
        teamId: options.teamId,
        environment: options.environment,
        startDate: cursorMs,
        endDate: subEndMs,
        maxPages: pageBudget,
      })
    } catch (error) {
      // The requested window predates Vercel's request-logs retention. This
      // can only surface on the first pull — once the cursor is inside
      // retention it only advances forward — so resolve the boundary once,
      // clamp the cursor onto the servable side, and carry on.
      if (isRetentionError(error) && !retentionResolved) {
        retentionResolved = true
        const retainedStartMs = await resolveRetainedStart(options, cursorMs, endMs)
        retentionClamped = retainedStartMs > cursorMs
        cursorMs = retainedStartMs
        effectiveStartMs = retainedStartMs
        // Resume small (not the full remaining window) for the same reason the
        // initial span is capped: keep the first post-clamp pull drainable.
        spanMs = Math.max(Math.min(endMs - cursorMs, INITIAL_SUB_WINDOW_MS), MIN_SUB_WINDOW_MS)
        continue
      }
      throw error
    }
    subWindowCount += 1

    if (page.hasMore) {
      if (subSpanMs > MIN_SUB_WINDOW_MS) {
        // Sub-window still overflows: halve the span and retry from the same cursor.
        spanMs = Math.max(Math.floor(subSpanMs / 2), MIN_SUB_WINDOW_MS)
        if (spanMs === MIN_SUB_WINDOW_MS) {
          floorSpanProbeCountdown = FLOOR_CONGESTION_PROBE_INTERVAL
        }
        continue
      }
      // The slice is already at the floor (`MIN_SUB_WINDOW_MS`). If we only
      // used the normal page budget, re-pull this one floor slice once with
      // the much larger `FLOOR_SLICE_MAX_PAGES` budget and drain it whole. A
      // single floor-width slice is bounded by real request volume, so the
      // large budget is generous headroom.
      if (pageBudget < FLOOR_SLICE_MAX_PAGES) {
        page = await options.pull({
          token: options.token,
          projectId: options.projectId,
          teamId: options.teamId,
          environment: options.environment,
          startDate: cursorMs,
          endDate: subEndMs,
          maxPages: FLOOR_SLICE_MAX_PAGES,
        })
        subWindowCount += 1
        floorSpanProbeCountdown = FLOOR_CONGESTION_PROBE_INTERVAL
        floorPageBudgetCountdown = FLOOR_CONGESTION_PROBE_INTERVAL
      }
      if (page.hasMore) {
        // Even `FLOOR_SLICE_MAX_PAGES` pages did not drain this one-second
        // slice, and time cannot be sliced thinner.
        if (options.abortOnTruncation) {
          // Replace-mode caller (backfill): fail fast on the first irreducible
          // slice so we don't drain the rest of a window we'll reject anyway.
          throw new Error(
            `Vercel ${MIN_SUB_WINDOW_MS / 1000}-second slice starting `
              + `${new Date(cursorMs).toISOString()} holds more than `
              + `${FLOOR_SLICE_MAX_PAGES} pages and cannot be drained further`,
          )
        }
        // Additive caller (incremental sync): failing here would freeze
        // `lastSyncedAt` and wedge the source forever on this single
        // pathological second (e.g. a bot flood). Instead, ingest the sample
        // we pulled, record the truncation so the caller can surface it
        // (never silent), and let the cursor advance past the slice below.
        truncatedSliceCount += 1
        truncatedSliceStartsMs.push(cursorMs)
      }
    }

    for (const event of page.events) {
      if (!seenEventIds.has(event.eventId)) {
        seenEventIds.add(event.eventId)
        events.push(event)
      }
    }
    cursorMs = subEndMs
    // Clean drain: grow the span for the next stretch, capped at what is left.
    const remainingMs = endMs - cursorMs
    if (remainingMs > 0) {
      if (spanMs === MIN_SUB_WINDOW_MS && floorSpanProbeCountdown > 0) {
        floorSpanProbeCountdown -= 1
        if (floorPageBudgetCountdown > 0) floorPageBudgetCountdown -= 1
        spanMs = Math.min(MIN_SUB_WINDOW_MS, remainingMs)
      } else {
        spanMs = Math.min(spanMs * 2, remainingMs)
        if (spanMs > MIN_SUB_WINDOW_MS) {
          floorPageBudgetCountdown = 0
        }
      }
    }
  }

  return { events, subWindowCount, effectiveStartMs, retentionClamped, truncatedSliceCount, truncatedSliceStartsMs, deadlineSkippedSliceCount: deadlineSkippedSliceStartsMs.length, deadlineSkippedSliceStartsMs, drainedThroughMs: cursorMs, deadlineReached }
}
