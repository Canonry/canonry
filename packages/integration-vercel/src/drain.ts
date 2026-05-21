import type { NormalizedTrafficRequest, VercelTrafficEnvironment } from '@ainyc/canonry-contracts'

import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from './types.js'

/**
 * Smallest sub-window the drain will attempt. If a slice this short still
 * overflows the page budget, the window is pathologically dense and the drain
 * gives up rather than spin.
 */
const MIN_SUB_WINDOW_MS = 60_000

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
}

function toMs(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime()
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
 * Throws if a `MIN_SUB_WINDOW_MS` slice still overflows, or if `maxSubWindows`
 * is reached before the window is fully drained.
 */
export async function drainVercelTrafficEvents(
  options: DrainVercelTrafficEventsOptions,
): Promise<DrainVercelTrafficEventsResult> {
  const startMs = toMs(options.startDate)
  const endMs = toMs(options.endDate)

  const events: NormalizedTrafficRequest[] = []
  const seenEventIds = new Set<string>()
  if (endMs <= startMs) return { events, subWindowCount: 0 }

  let cursorMs = startMs
  let spanMs = endMs - startMs
  let subWindowCount = 0

  while (cursorMs < endMs) {
    if (subWindowCount >= options.maxSubWindows) {
      throw new Error(
        `Vercel window not drained within ${options.maxSubWindows} sub-windows — narrow the time range`,
      )
    }

    const subEndMs = Math.min(cursorMs + spanMs, endMs)
    const page = await options.pull({
      token: options.token,
      projectId: options.projectId,
      teamId: options.teamId,
      environment: options.environment,
      startDate: cursorMs,
      endDate: subEndMs,
      maxPages: options.pagesPerSubWindow,
    })
    subWindowCount += 1

    if (page.hasMore) {
      const subSpanMs = subEndMs - cursorMs
      if (subSpanMs <= MIN_SUB_WINDOW_MS) {
        throw new Error(
          `Vercel window holds more than ${options.pagesPerSubWindow} pages within a `
            + `${MIN_SUB_WINDOW_MS / 60_000}-minute slice — cannot subdivide further`,
        )
      }
      // Sub-window still overflows: halve the span and retry from the same cursor.
      spanMs = Math.max(Math.floor(subSpanMs / 2), MIN_SUB_WINDOW_MS)
      continue
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

  return { events, subWindowCount }
}
