import { describe, expect, test, vi } from 'vitest'

import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

import { drainVercelTrafficEvents } from '../src/drain.js'
import type { ListVercelTrafficEventsOptions, VercelTrafficEventsPage } from '../src/types.js'

const HOUR = 60 * 60_000

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

  test('throws when even a one-minute slice overflows the budget', async () => {
    const pull = vi.fn(async () => page([], true))
    await expect(
      drainVercelTrafficEvents({ ...baseOptions, pull, startDate: 0, endDate: 4 * HOUR }),
    ).rejects.toThrow(/minute slice/)
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
})
