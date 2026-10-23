import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchTrafficByLandingPage, fetchDailyTotals, fetchAiReferrals, fetchSocialReferrals } from '../src/ga4-client.js'
import { resolveGa4SyncDays, GA4_DEFAULT_SYNC_DAYS, GA4_MAX_SYNC_DAYS } from '../src/constants.js'
import { GA_OVERVIEW_HISTORY_DAYS } from '@canonry/canonry-contracts'

describe('resolveGa4SyncDays', () => {
  it('passes a window inside the supported range through untouched', () => {
    expect(resolveGa4SyncDays(30)).toEqual({ requestedDays: 30, effectiveDays: 30, clamped: false })
    expect(resolveGa4SyncDays(1)).toEqual({ requestedDays: 1, effectiveDays: 1, clamped: false })
  })

  it('reports the boundary itself as unclamped', () => {
    // 90 is reachable, so asking for exactly the cap is NOT a truncation.
    expect(resolveGa4SyncDays(GA4_MAX_SYNC_DAYS)).toEqual({
      requestedDays: 90,
      effectiveDays: 90,
      clamped: false,
    })
  })

  it('clamps above the cap and flags it — the bug this exists to surface', () => {
    // The reported case: `--days 500` wrote 90 days and claimed 500.
    expect(resolveGa4SyncDays(500)).toEqual({
      requestedDays: 500,
      effectiveDays: 90,
      clamped: true,
    })
    // One day over is still a truncation.
    expect(resolveGa4SyncDays(91)).toEqual({ requestedDays: 91, effectiveDays: 90, clamped: true })
  })

  it('clamps below the floor and flags it', () => {
    // A floor clamp is also "you did not get the window you asked for".
    expect(resolveGa4SyncDays(0)).toEqual({ requestedDays: 0, effectiveDays: 1, clamped: true })
    expect(resolveGa4SyncDays(-7)).toEqual({ requestedDays: -7, effectiveDays: 1, clamped: true })
  })

  it('defaults an absent window without flagging a clamp', () => {
    for (const absent of [undefined, null]) {
      expect(resolveGa4SyncDays(absent)).toEqual({
        requestedDays: GA4_DEFAULT_SYNC_DAYS,
        effectiveDays: GA4_DEFAULT_SYNC_DAYS,
        clamped: false,
      })
    }
  })

  it('never emits NaN into the response contract', () => {
    // `parseInt('abc')` upstream in the CLI. NaN would fail the DTO's
    // `z.number().int()` and render as "NaN days"; fall back to the default.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const resolved = resolveGa4SyncDays(bad)
      expect(Number.isInteger(resolved.requestedDays)).toBe(true)
      expect(Number.isInteger(resolved.effectiveDays)).toBe(true)
    }
    expect(resolveGa4SyncDays(NaN).effectiveDays).toBe(GA4_DEFAULT_SYNC_DAYS)
  })

  it('truncates a fractional window to a whole number of days', () => {
    expect(resolveGa4SyncDays(30.9)).toEqual({ requestedDays: 30, effectiveDays: 30, clamped: false })
  })
})

describe('GA4 fetches honour the resolved window', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockFetchResponse(body: object, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** Span of the dateRange each `runReport` asked GA4 for, in whole days. */
  function capturedRangeSpans(): number[] {
    const spans: number[] = []
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined
      if (!init?.body) continue
      type Ranged = { dateRanges?: Array<{ startDate: string; endDate: string }> }
      // A batch call carries its reports under `requests`; read every one.
      const body = JSON.parse(init.body as string) as Ranged & { requests?: Ranged[] }
      for (const request of body.requests ?? [body]) {
        const range = request.dateRanges?.[0]
        if (!range) continue
        const ms = Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)
        spans.push(Math.round(ms / 86_400_000))
      }
    }
    return spans
  }

  // Each fetch clamps independently, so each is asserted independently — a
  // regression in one call site would otherwise hide behind the others.
  const fetches = [
    { name: 'fetchTrafficByLandingPage', run: () => fetchTrafficByLandingPage('fake-token', '123456', 500) },
    { name: 'fetchAiReferrals', run: () => fetchAiReferrals('fake-token', '123456', 500) },
    { name: 'fetchSocialReferrals', run: () => fetchSocialReferrals('fake-token', '123456', 500) },
  ]

  for (const { name, run } of fetches) {
    it(`${name} requests ${GA4_MAX_SYNC_DAYS} days when asked for 500`, async () => {
      fetchSpy.mockImplementation(async () => mockFetchResponse({ rows: [], rowCount: 0 }))

      await run()

      const spans = capturedRangeSpans()
      expect(spans.length).toBeGreaterThan(0)
      // Not 500 — the request GA4 actually receives is bounded.
      for (const span of spans) {
        expect(span).toBe(GA4_MAX_SYNC_DAYS)
      }
    })
  }

  it('requests the exact window asked for when it is inside the range', async () => {
    fetchSpy.mockImplementation(async () => mockFetchResponse({ reports: [{ rows: [] }, { rows: [] }] }))

    await fetchDailyTotals('fake-token', '123456', 14)

    // Both reports of the batch, the totals and the Organic Search one.
    expect(capturedRangeSpans()).toEqual([14, 14])
  })

  // Daily totals are the overview's history, not a breakdown the sync window
  // scopes: they keep the longest window and the period before it.
  it(`fetchDailyTotals keeps ${GA_OVERVIEW_HISTORY_DAYS} days by default and never more`, async () => {
    fetchSpy.mockImplementation(async () => mockFetchResponse({ reports: [{ rows: [] }, { rows: [] }] }))

    const byDefault = await fetchDailyTotals('fake-token', '123456')
    await fetchDailyTotals('fake-token', '123456', 500)

    expect(capturedRangeSpans()).toEqual(Array(4).fill(GA_OVERVIEW_HISTORY_DAYS))
    const ms = Date.parse(`${byDefault.endDate}T00:00:00Z`) - Date.parse(`${byDefault.startDate}T00:00:00Z`)
    expect(Math.round(ms / 86_400_000)).toBe(GA_OVERVIEW_HISTORY_DAYS)
  })
})
