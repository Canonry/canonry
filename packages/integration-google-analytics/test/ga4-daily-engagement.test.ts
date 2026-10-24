import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchDailyTotals } from '../src/ga4-client.js'
import { GA4_METRICS } from '../src/constants.js'

/**
 * The property-level daily series behind the GA4 overview: every daily figure
 * the overview shows, in one batch of two reports (GA4 takes at most ten
 * metrics per report), the second being sessions in the Organic Search channel.
 *
 * No returning-users figure is derived. GA4 exposes no such metric, and
 * subtracting newUsers from totalUsers does not reconstruct one, because a
 * visitor can be first-seen AND return inside the same range.
 */

type Row = { dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }
type ReportRequest = { metrics?: Array<{ name: string }>; dimensionFilter?: unknown; dateRanges?: Array<{ startDate: string; endDate: string }> }
type BatchBody = { requests?: ReportRequest[] }

describe('fetchDailyTotals overview metrics', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let bodies: BatchBody[]

  beforeEach(() => {
    bodies = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  /** GA4 states the property's reporting time zone in every report's metadata. */
  function mockBatch(totals: Row[], organic: Row[] = [], timeZone?: string) {
    const metadata = timeZone ? { metadata: { currencyCode: 'USD', timeZone } } : {}
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as BatchBody)
      return new Response(JSON.stringify({ reports: [{ rows: totals, rowCount: totals.length, ...metadata }, { rows: organic, rowCount: organic.length, ...metadata }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  }

  const day = (date: string, ...values: string[]): Row => ({
    dimensionValues: [{ value: date }],
    metricValues: values.map(value => ({ value })),
  })

  it('requests every daily figure by its GA4 name, plus the Organic Search sessions', async () => {
    mockBatch([])

    await fetchDailyTotals('fake-token', '123456', 7)

    expect(bodies).toHaveLength(1)
    const [totals, organic] = bodies[0]!.requests ?? []
    // The literal names are the GA4 Data API contract, asserted here on purpose:
    // a typo in a constant would otherwise pass a constant-only comparison.
    expect((totals?.metrics ?? []).map(metric => metric.name)).toEqual([
      'sessions',
      'totalUsers',
      'engagementRate',
      'newUsers',
      'activeUsers',
      'screenPageViews',
      'eventCount',
      'keyEvents',
      'userEngagementDuration',
      'bounceRate',
    ])
    expect((organic?.metrics ?? []).map(metric => metric.name)).toEqual(['sessions'])
    expect(JSON.stringify(organic?.dimensionFilter)).toContain('Organic Search')
    expect(GA4_METRICS.screenPageViews).toBe('screenPageViews')
    expect(GA4_METRICS.keyEvents).toBe('keyEvents')
    expect(GA4_METRICS.userEngagementDuration).toBe('userEngagementDuration')
    expect(GA4_METRICS.bounceRate).toBe('bounceRate')
  })

  it('reads each figure from its own position, counts whole and rates bounded', async () => {
    mockBatch(
      [day('20260731', '90', '40', '0.61', '12.0', '38', '210', '640', '2.5', '3120.5', '0.39')],
      [day('20260731', '51')],
    )

    const { rows } = await fetchDailyTotals('fake-token', '123456', 7)

    expect(rows).toEqual([{
      date: '2026-07-31',
      sessions: 90,
      users: 40,
      engagementRate: 0.61,
      newUsers: 12,
      activeUsers: 38,
      organicSessions: 51,
      views: 210,
      eventCount: 640,
      keyEvents: 2.5,
      engagementSeconds: 3120.5,
      bounceRate: 0.39,
    }])
    expect(Number.isInteger(rows[0]!.newUsers)).toBe(true)
  })

  it('reports an empty value as null, never as a measured zero', async () => {
    // `Number('')` is 0, not NaN, so without the guard an empty value would
    // land as a real zero reading instead of an absent one.
    mockBatch([day('20260731', '90', '40', '', '12', '', '210', '', '', '', '')])

    const [row] = (await fetchDailyTotals('fake-token', '123456', 7)).rows

    expect(row!.engagementRate).toBeNull()
    expect(row!.activeUsers).toBeNull()
    expect(row!.eventCount).toBeNull()
    expect(row!.keyEvents).toBeNull()
    expect(row!.engagementSeconds).toBeNull()
    expect(row!.bounceRate).toBeNull()
    expect(row!.views).toBe(210)
  })

  it('reports the figures GA4 omitted as null, not zero', async () => {
    // A response carrying only the first two figures must not read as "0%
    // engaged, no views": that is a real value, and this is the absence of one.
    mockBatch([day('20260730', '90', '40')])

    const [row] = (await fetchDailyTotals('fake-token', '123456', 7)).rows

    expect(row!.sessions).toBe(90)
    expect(row!.users).toBe(40)
    for (const key of ['engagementRate', 'newUsers', 'activeUsers', 'views', 'eventCount', 'keyEvents', 'engagementSeconds', 'bounceRate'] as const) {
      expect(row![key]).toBeNull()
    }
  })

  it('counts a day the Organic Search report omits as zero organic sessions', async () => {
    // GA4 sends no row for a day with nothing to report. The organic report
    // ran, so a day the totals carry and it omits had no organic session.
    mockBatch(
      [day('20260730', '90', '40'), day('20260731', '70', '30')],
      [day('20260731', '22')],
    )

    const { rows } = await fetchDailyTotals('fake-token', '123456', 7)

    expect(rows.map(row => [row.date, row.organicSessions])).toEqual([['2026-07-30', 0], ['2026-07-31', 22]])
  })

  it('asks for days in the property\'s time zone and returns the dates GA4 resolved them to', async () => {
    mockBatch([], [], 'America/New_York')

    const result = await fetchDailyTotals('fake-token', '123456', 7, { now: new Date('2026-10-23T02:00:00Z') })

    // Relative dates: GA4 resolves them in the property's reporting time zone.
    expect(bodies[0]!.requests!.map(request => request.dateRanges)).toEqual([
      [{ startDate: '7daysAgo', endDate: 'today' }],
      [{ startDate: '7daysAgo', endDate: 'today' }],
    ])
    // 02:00 UTC on October 23 is still the 22nd in New York: the sync must
    // replace the 15th through the 22nd, not the 16th through the 23rd.
    expect({ startDate: result.startDate, endDate: result.endDate }).toEqual({ startDate: '2026-10-15', endDate: '2026-10-22' })
  })
})
