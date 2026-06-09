import { describe, expect, test, vi } from 'vitest'

import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

import { VercelLogsApiError } from '../src/client.js'
import { drainVercelTrafficEvents } from '../src/drain.js'
import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from '../src/types.js'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** A Vercel retention rejection — HTTP 400 with the `ExceedsBillingLimitError` body. */
function retentionError(): VercelLogsApiError {
  return new VercelLogsApiError(
    'Vercel request-logs endpoint returned HTTP 400',
    400,
    '{"error":{"name":"ExceedsBillingLimitError","message":"Requested window exceeds plan retention"}}',
  )
}

function makeEvent(eventId: string): NormalizedTrafficRequest {
  return {
    sourceType: 'vercel',
    evidenceKind: 'raw-request',
    confidence: 'observed',
    eventId,
    observedAt: '2026-05-21T12:00:00.000Z',
    method: 'GET',
    requestUrl: 'https://example.com/',
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: 'GPTBot/1.0',
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'vercel_deployment', labels: {} },
    providerLabels: {},
  }
}

function page(events: NormalizedTrafficRequest[], hasMore: boolean): VercelTrafficEventsPage {
  return { events, rawEntryCount: events.length, skippedEntryCount: 0, hasMore, endpoint: '' }
}

const baseOptions = {
  token: 't',
  projectId: 'prj_x',
  teamId: 'team_x',
  pagesPerSubWindow: 50,
  maxSubWindows: 1_000,
}

describe('drainVercelTrafficEvents', () => {
  test('returns nothing for an empty window without pulling', async () => {
    const pull = vi.fn(async () => page([], false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 1_000,
      endDate: 1_000,
    })
    expect(result.events).toEqual([])
    expect(result.subWindowCount).toBe(0)
    expect(pull).not.toHaveBeenCalled()
  })

  test('drains a sparse window cleanly, deduping repeated events across sub-windows', async () => {
    const events = [makeEvent('a'), makeEvent('b')]
    const pull = vi.fn(async () => page(events, false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
    })
    // Start-small opens at the 5-min initial span and grows, so a sparse 4h
    // window drains across a few growing sub-windows (not one full-span pull);
    // the same two events repeat and are deduped by eventId.
    expect(result.events).toEqual(events)
    expect(result.drainedThroughMs).toBe(4 * HOUR)
    expect(result.subWindowCount).toBeGreaterThan(0)
  })

  test('sub-divides when a span overflows the page budget and still fully drains', async () => {
    // Any slice longer than one hour overflows; shorter slices drain one event
    // keyed to their start. Start-small opens at 5 min and grows, so subdivision
    // kicks in once the growing span overshoots an hour; the whole window drains.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > HOUR) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
    })
    expect(result.subWindowCount).toBeGreaterThan(4)
    expect(result.drainedThroughMs).toBe(4 * HOUR)
    expect(result.events.length).toBeGreaterThan(1)
    expect(result.events.map((e) => e.eventId)).toContain('ev-0')
  })

  test('deduplicates events shared across adjacent sub-windows', async () => {
    // Every drained slice re-emits the same boundary event.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > HOUR) return page([], true)
      return page([makeEvent('shared-boundary')], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventId).toBe('shared-boundary')
  })

  test('drains a dense one-second slice with the large floor page budget', async () => {
    // Every pull at the normal 50-page budget overflows no matter how short
    // the slice, so the drain narrows all the way to the one-second floor.
    // There it re-pulls with the larger floor budget, which drains the slice
    // cleanly.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      if ((o.maxPages ?? 0) > baseOptions.pagesPerSubWindow) {
        return page([makeEvent(`floor-${Number(o.startDate)}`)], false)
      }
      return page([], true)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 3 * SECOND,
    })
    expect(result.events.map((e) => e.eventId).sort()).toEqual(
      [`floor-0`, `floor-${SECOND}`, `floor-${2 * SECOND}`].sort(),
    )
  })

  test('samples and advances when a one-second slice overflows even the floor budget', async () => {
    // hasMore stays true regardless of maxPages, so even the large floor-budget
    // re-pull cannot fully drain each one-second slice. Rather than fail — which
    // would freeze lastSyncedAt and wedge the source forever on this second —
    // the drain ingests the sample it pulled, records the truncation, and
    // advances past the slice.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) =>
      page([makeEvent(`trunc-${Number(o.startDate)}`)], true),
    )
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 3 * SECOND,
    })
    // Three one-second floor slices, each truncated + sampled + advanced past.
    expect(result.truncatedSliceCount).toBe(3)
    expect(result.truncatedSliceStartsMs).toEqual([0, SECOND, 2 * SECOND])
    expect(result.events).toHaveLength(3)
  })

  test('throws on the first irreducible floor slice when abortOnTruncation is set', async () => {
    // Replace-mode callers (backfill) opt into fail-fast: the drain must throw
    // on the FIRST one-second slice it cannot drain rather than sampling and
    // advancing through the rest of a window it will reject anyway.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) =>
      page([makeEvent(`trunc-${Number(o.startDate)}`)], true),
    )
    await expect(
      drainVercelTrafficEvents({
        ...baseOptions,
        pull,
        startDate: 0,
        endDate: 3 * SECOND,
        abortOnTruncation: true,
      }),
    ).rejects.toThrow(/1-second slice starting .* holds more than 1000 pages/)
  })

  test('drains a dense minute via one-second slicing without hitting the floor budget', async () => {
    // The gjelina-hotel regression: a single minute holds more than the normal
    // page budget at the minute level, but each one-second slice drains
    // cleanly. The previous one-minute floor would have escalated to the
    // floor-budget re-pull (or failed loudly) on every dense minute; the
    // one-second floor handles it via ordinary subdivision instead.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      if ((o.maxPages ?? 0) > baseOptions.pagesPerSubWindow) {
        throw new Error('floor-budget re-pull should not be needed for sub-minute slicing')
      }
      const span = Number(o.endDate) - Number(o.startDate)
      // Any slice wider than one second overflows; one-second slices drain cleanly.
      if (span > 1_000) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: MINUTE,
    })
    // 60 one-second sub-windows drain, one event each.
    expect(result.events).toHaveLength(60)
  })

  test('keeps congested one-second slicing under the sub-window cap', async () => {
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      if ((o.maxPages ?? 0) > baseOptions.pagesPerSubWindow) {
        throw new Error('floor-budget re-pull should not be needed when one-second slices fit')
      }
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > SECOND) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      maxSubWindows: 5_000,
      startDate: 0,
      endDate: HOUR,
    })
    expect(result.events).toHaveLength(60 * 60)
    expect(result.subWindowCount).toBeLessThan(5_000)

    const widerOverflowPulls = pull.mock.calls.filter(([o]) => {
      const span = Number(o.endDate) - Number(o.startDate)
      return span > SECOND
    })
    expect(widerOverflowPulls.length).toBeLessThan(100)
  })

  test('reuses the floor page budget during sustained one-second overflow', async () => {
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > SECOND) return page([], true)
      if ((o.maxPages ?? 0) <= baseOptions.pagesPerSubWindow) return page([], true)
      return page([makeEvent(`floor-${Number(o.startDate)}`)], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      maxSubWindows: 5_000,
      startDate: 0,
      endDate: HOUR,
    })
    expect(result.events).toHaveLength(60 * 60)
    expect(result.subWindowCount).toBeLessThan(5_000)

    const normalFloorPulls = pull.mock.calls.filter(([o]) => {
      const span = Number(o.endDate) - Number(o.startDate)
      return span === SECOND && o.maxPages === baseOptions.pagesPerSubWindow
    })
    expect(normalFloorPulls.length).toBeLessThan(100)
  })

  test('throws when the window is not drained within the sub-window cap', async () => {
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > HOUR) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    await expect(
      drainVercelTrafficEvents({
        ...baseOptions,
        pull,
        maxSubWindows: 3,
        startDate: 0,
        endDate: 100 * HOUR,
      }),
    ).rejects.toThrow(/within 3 sub-windows/)
  })

  test('clamps the start forward when the window predates Vercel retention', async () => {
    const RETENTION_BOUNDARY = 40 * HOUR
    // Vercel rejects any window starting before the retention boundary; a
    // window starting at or after it drains cleanly with one event.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      if (Number(o.startDate) < RETENTION_BOUNDARY) throw retentionError()
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 100 * HOUR,
    })
    expect(result.retentionClamped).toBe(true)
    // Clamped onto the servable side, within one tolerance step of the boundary.
    expect(result.effectiveStartMs).toBeGreaterThanOrEqual(RETENTION_BOUNDARY)
    expect(result.effectiveStartMs).toBeLessThan(RETENTION_BOUNDARY + HOUR)
    // Drained from the clamped start forward; start-small slices the post-clamp
    // window into several events, the first sitting at the clamp boundary, not 0.
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.drainedThroughMs).toBe(100 * HOUR)
    expect(result.events[0].eventId).toBe(`ev-${result.effectiveStartMs}`)
  })

  test('does not clamp when the whole window is within retention', async () => {
    const events = [makeEvent('a'), makeEvent('b')]
    const pull = vi.fn(async () => page(events, false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 5_000,
      endDate: 5_000 + 4 * HOUR,
    })
    expect(result.retentionClamped).toBe(false)
    expect(result.effectiveStartMs).toBe(5_000)
    expect(result.events).toEqual(events)
    expect(result.drainedThroughMs).toBe(5_000 + 4 * HOUR)
    // Happy path: every pull is a normal forward pull; no retention probe fired
    // (retentionClamped stays false). Start-small means several such pulls, not one.
    expect(pull.mock.calls.every(([o]) => Number(o.startDate) >= 5_000)).toBe(true)
  })

  test('rethrows a non-retention 400 instead of clamping', async () => {
    const pull = vi.fn(async () => {
      throw new VercelLogsApiError('maxPages must be a positive integer', 400)
    })
    await expect(
      drainVercelTrafficEvents({ ...baseOptions, pull, startDate: 0, endDate: 4 * HOUR }),
    ).rejects.toThrow(/maxPages/)
  })

  test('drains nothing when the entire window predates retention', async () => {
    // Every window — even the final minute — is rejected for retention.
    const pull = vi.fn(async () => {
      throw retentionError()
    })
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 100 * HOUR,
    })
    expect(result.retentionClamped).toBe(true)
    expect(result.effectiveStartMs).toBe(100 * HOUR)
    expect(result.events).toEqual([])
    expect(result.subWindowCount).toBe(0)
  })

  test('reports a full drain through endDate with no deadline set', async () => {
    const pull = vi.fn(async () => page([makeEvent('a')], false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
    })
    expect(result.deadlineReached).toBe(false)
    expect(result.drainedThroughMs).toBe(4 * HOUR)
  })

  test('stops before the first pull and makes no progress when the deadline has already passed', async () => {
    const pull = vi.fn(async () => page([makeEvent('x')], false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
      deadlineMs: 100,
      now: () => 1_000, // already past the deadline
    })
    expect(result.deadlineReached).toBe(true)
    expect(result.drainedThroughMs).toBe(0) // == startDate: nothing drained
    expect(result.events).toEqual([])
    expect(pull).not.toHaveBeenCalled()
  })

  test('stops at the deadline after partial progress and reports the boundary it reached', async () => {
    // Slices wider than an hour overflow and get subdivided; one-hour-or-less
    // slices drain cleanly. The injected clock advances one tick per sub-window
    // check, so the deadline trips after several hours have drained but well
    // before the full 100-hour window is done.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > HOUR) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    let tick = 0
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 100 * HOUR,
      deadlineMs: 25,
      now: () => (tick += 1),
    })
    expect(result.deadlineReached).toBe(true)
    expect(result.drainedThroughMs).toBeGreaterThan(0) // made progress
    expect(result.drainedThroughMs).toBeLessThan(100 * HOUR) // but did not finish
    expect(result.events.length).toBeGreaterThan(0)
  })

  test('start-small makes forward progress on a dense backlog instead of wedging', async () => {
    // The gjelina wedge: a dense multi-hour backlog where every span wider than a
    // minute overflows the page budget. Opening at the full window would spend the
    // whole deadline halving a 24h span without ever completing a sub-window (zero
    // progress, permanent wedge). Starting at the 5-min initial span, the drain
    // reaches a drainable slice within a few pulls and the cursor advances.
    const pull = vi.fn(async (o: ListVercelTrafficEventsOptions) => {
      const span = Number(o.endDate) - Number(o.startDate)
      if (span > MINUTE) return page([], true)
      return page([makeEvent(`ev-${Number(o.startDate)}`)], false)
    })
    let tick = 0
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 24 * HOUR,
      deadlineMs: 8, // trips after a handful of loop checks
      now: () => (tick += 1),
    })
    expect(result.deadlineReached).toBe(true)
    // The first pull span is the 5-min initial cap, not the full 24h window.
    const firstSpan = Number(pull.mock.calls[0][0].endDate) - Number(pull.mock.calls[0][0].startDate)
    expect(firstSpan).toBeLessThanOrEqual(5 * MINUTE)
    // Progress was made before the deadline (the old full-window start would be 0).
    expect(result.drainedThroughMs).toBeGreaterThan(0)
    expect(result.events.length).toBeGreaterThan(0)
  })
})
