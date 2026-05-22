import { describe, expect, test, vi } from 'vitest'

import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

import { VercelLogsApiError } from '../src/client.js'
import { drainVercelTrafficEvents } from '../src/drain.js'
import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from '../src/types.js'

const HOUR = 60 * 60_000

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

  test('drains a window that fits in a single pull', async () => {
    const events = [makeEvent('a'), makeEvent('b')]
    const pull = vi.fn(async () => page(events, false))
    const result = await drainVercelTrafficEvents({
      ...baseOptions,
      pull,
      startDate: 0,
      endDate: 4 * HOUR,
    })
    expect(result.events).toEqual(events)
    expect(result.subWindowCount).toBe(1)
    expect(pull).toHaveBeenCalledTimes(1)
  })

  test('sub-divides a window that overflows the page budget', async () => {
    // Any slice longer than one hour overflows; shorter slices drain cleanly,
    // each emitting one event keyed to its start.
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
    expect(result.events.map((e) => e.eventId).sort()).toEqual(
      [`ev-0`, `ev-${HOUR}`, `ev-${2 * HOUR}`, `ev-${3 * HOUR}`].sort(),
    )
    expect(result.subWindowCount).toBeGreaterThan(4)
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

  test('drains a dense one-minute slice with the large floor page budget', async () => {
    // Every pull at the normal 50-page budget overflows no matter how short the
    // slice, so the drain narrows all the way to the one-minute floor. There it
    // re-pulls with the larger floor budget, which drains the slice cleanly.
    const MINUTE = 60_000
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
      endDate: 3 * MINUTE,
    })
    expect(result.events.map((e) => e.eventId).sort()).toEqual(
      [`floor-0`, `floor-${MINUTE}`, `floor-${2 * MINUTE}`].sort(),
    )
  })

  test('throws only when a one-minute slice overflows even the floor budget', async () => {
    // hasMore stays true regardless of maxPages, so even the large floor-budget
    // re-pull cannot drain the slice and the drain genuinely gives up.
    const pull = vi.fn(async () => page([], true))
    await expect(
      drainVercelTrafficEvents({ ...baseOptions, pull, startDate: 0, endDate: 4 * HOUR }),
    ).rejects.toThrow(/cannot be drained further/)
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
    // The drained window starts at the clamped start, not the requested 0.
    expect(result.events).toHaveLength(1)
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
    // No retention probe on the happy path — the first pull is the only call.
    expect(pull).toHaveBeenCalledTimes(1)
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
})
