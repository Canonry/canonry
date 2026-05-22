import type { NormalizedTrafficRequest, VercelTrafficEnvironment } from '@ainyc/canonry-contracts'

import { VercelLogsApiError } from './client.js'
import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from './types.js'

/**
 * Smallest sub-window the drain will subdivide a span down to. A slice this
 * short that still overflows the normal page budget is re-pulled once with the
 * larger `FLOOR_SLICE_MAX_PAGES` budget rather than failing (see the drain
 * loop).
 */
const MIN_SUB_WINDOW_MS = 60_000

/**
 * Page budget for a re-pull of a one-minute floor slice. When even a
 * `MIN_SUB_WINDOW_MS` slice overflows the caller's normal `pagesPerSubWindow`
 * budget, the drain cannot subdivide time any further, so it re-pulls that one
 * slice with this larger budget and ingests it whole. A single minute of real
 * request traffic is bounded, so this is deliberately generous headroom; a
 * minute denser than this is pathological and fails loudly.
 */
const FLOOR_SLICE_MAX_PAGES = 1_000

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
  const tailStartMs = Math.max(unservableStartMs, endMs - MIN_SUB_WINDOW_MS)
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
 * is halved and retried; after a clean drain the span doubles back up. Events
 * are deduped by `eventId`, so the instant shared by adjacent sub-windows is
 * never double-counted.
 *
 * If the requested window begins before Vercel's plan retention ceiling — the
 * `ExceedsBillingLimitError` 400 — the start is clamped forward to the
 * earliest instant Vercel will serve and the result is flagged
 * `retentionClamped`, rather than failing the whole drain.
 *
 * A `MIN_SUB_WINDOW_MS` slice that still overflows the normal page budget is
 * re-pulled once with the larger `FLOOR_SLICE_MAX_PAGES` budget. Throws only if
 * even that re-pull overflows, or if `maxSubWindows` is reached before the
 * window is fully drained.
 */
export async function drainVercelTrafficEvents(
  options: DrainVercelTrafficEventsOptions,
): Promise<DrainVercelTrafficEventsResult> {
  const startMs = toMs(options.startDate)
  const endMs = toMs(options.endDate)

  const events: NormalizedTrafficRequest[] = []
  const seenEventIds = new Set<string>()
  if (endMs <= startMs) {
    return { events, subWindowCount: 0, effectiveStartMs: startMs, retentionClamped: false }
  }

  let cursorMs = startMs
  let spanMs = endMs - startMs
  let subWindowCount = 0
  let effectiveStartMs = startMs
  let retentionClamped = false
  let retentionResolved = false

  while (cursorMs < endMs) {
    if (subWindowCount >= options.maxSubWindows) {
      throw new Error(
        `Vercel window not drained within ${options.maxSubWindows} sub-windows — narrow the time range`,
      )
    }

    const subEndMs = Math.min(cursorMs + spanMs, endMs)
    let page: VercelTrafficEventsPage
    try {
      page = await options.pull({
        token: options.token,
        projectId: options.projectId,
        teamId: options.teamId,
        environment: options.environment,
        startDate: cursorMs,
        endDate: subEndMs,
        maxPages: options.pagesPerSubWindow,
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
        spanMs = Math.max(endMs - cursorMs, MIN_SUB_WINDOW_MS)
        continue
      }
      throw error
    }
    subWindowCount += 1

    if (page.hasMore) {
      const subSpanMs = subEndMs - cursorMs
      if (subSpanMs > MIN_SUB_WINDOW_MS) {
        // Sub-window still overflows: halve the span and retry from the same cursor.
        spanMs = Math.max(Math.floor(subSpanMs / 2), MIN_SUB_WINDOW_MS)
        continue
      }
      // The slice is already at the one-minute floor and the normal page budget
      // still overflowed. Time cannot be sliced thinner, so re-pull this floor
      // slice once with the much larger FLOOR_SLICE_MAX_PAGES budget and drain
      // it whole. A single one-minute slice is bounded by real request volume,
      // so the large budget is generous headroom; only a pathologically dense
      // minute exceeds it, and that genuinely cannot be drained.
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
      if (page.hasMore) {
        throw new Error(
          `Vercel ${MIN_SUB_WINDOW_MS / 60_000}-minute slice holds more than `
            + `${FLOOR_SLICE_MAX_PAGES} pages and cannot be drained further`,
        )
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
      spanMs = Math.min(spanMs * 2, remainingMs)
    }
  }

  return { events, subWindowCount, effectiveStartMs, retentionClamped }
}
