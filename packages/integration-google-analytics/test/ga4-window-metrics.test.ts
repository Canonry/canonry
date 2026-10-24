import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchWindowMetrics } from '../src/ga4-client.js'

/**
 * GA4's own totals for an overview window and the period before it: one batch
 * whose two reports each carry both periods as named date ranges, so GA4
 * computes distinct users and every rate over each whole period.
 */

type Row = { dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }
type ReportRequest = {
  metrics?: Array<{ name: string }>
  dimensions?: Array<{ name: string }>
  dimensionFilter?: unknown
  dateRanges?: Array<{ startDate: string; endDate: string; name?: string }>
}

describe('fetchWindowMetrics', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let requests: ReportRequest[]

  beforeEach(() => {
    requests = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  /** GA4 states the property's reporting time zone in every report's metadata. */
  function mockBatch(totals: Row[], organic: Row[], timeZone?: string) {
    const metadata = timeZone ? { metadata: { currencyCode: 'USD', timeZone } } : {}
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(...((JSON.parse(String(init?.body ?? '{}')) as { requests?: ReportRequest[] }).requests ?? []))
      return new Response(JSON.stringify({
        reports: [
          { dimensionHeaders: [{ name: 'dateRange' }], rows: totals, rowCount: totals.length, ...metadata },
          { dimensionHeaders: [{ name: 'dateRange' }], rows: organic, rowCount: organic.length, ...metadata },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  const period = (name: string, ...values: string[]): Row => ({
    dimensionValues: [{ value: name }],
    metricValues: values.map(value => ({ value })),
  })

  it('asks for both periods as named ranges, with every window figure by its GA4 name', async () => {
    mockBatch([], [])

    await fetchWindowMetrics('fake-token', '123456', '30d')

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      // GA4's "Last 30 days": the 30 complete days ending yesterday, and the
      // 30 before. Relative dates, so GA4 counts them in the property's zone.
      expect(request.dateRanges).toEqual([
        { startDate: '30daysAgo', endDate: 'yesterday', name: 'current' },
        { startDate: '60daysAgo', endDate: '31daysAgo', name: 'previous' },
      ])
      expect(request.dimensions).toEqual([])
    }
    expect((requests[0]!.metrics ?? []).map(metric => metric.name)).toEqual([
      'activeUsers',
      'newUsers',
      'totalUsers',
      'sessions',
      'screenPageViews',
      'eventCount',
      'keyEvents',
      'engagementRate',
      'bounceRate',
      'userEngagementDuration',
    ])
    expect((requests[1]!.metrics ?? []).map(metric => metric.name)).toEqual(['sessions'])
    expect(JSON.stringify(requests[1]!.dimensionFilter)).toContain('Organic Search')
  })

  it('dates both periods in the time zone GA4 reports for the property', async () => {
    // 02:00 UTC on October 23 is still the 22nd in New York: the property's
    // last complete day is the 21st, and the stored dates must say so.
    const lateEvening = new Date('2026-10-23T02:00:00Z')
    mockBatch([], [], 'America/New_York')
    const newYork = await fetchWindowMetrics('fake-token', '123456', '7d', { now: lateEvening })
    expect(newYork.current).toMatchObject({ startDate: '2026-10-15', endDate: '2026-10-21' })
    expect(newYork.previous).toMatchObject({ startDate: '2026-10-08', endDate: '2026-10-14' })

    // A response with no zone falls back to the UTC date.
    mockBatch([], [])
    const unstated = await fetchWindowMetrics('fake-token', '123456', '7d', { now: lateEvening })
    expect(unstated.current).toMatchObject({ startDate: '2026-10-16', endDate: '2026-10-22' })
  })

  it('reads each period from its own named row, whatever order GA4 sends them in', async () => {
    mockBatch(
      [
        period('previous', '900', '410', '930', '1500', '3100', '11000', '40', '0.58', '0.42', '61200'),
        period('current', '1000', '450', '1030', '1700', '3500', '12500', '52', '0.6', '0.4', '70000'),
      ],
      [period('previous', '800'), period('current', '950')],
    )

    const metrics = await fetchWindowMetrics('fake-token', '123456', '7d')

    expect(metrics.windowKey).toBe('7d')
    expect(metrics.current).toMatchObject({
      activeUsers: 1000,
      newUsers: 450,
      totalUsers: 1030,
      sessions: 1700,
      views: 3500,
      eventCount: 12500,
      keyEvents: 52,
      engagementRate: 0.6,
      bounceRate: 0.4,
      engagementSeconds: 70000,
      organicSessions: 950,
    })
    expect(metrics.previous).toMatchObject({ activeUsers: 900, sessions: 1500, organicSessions: 800, engagementSeconds: 61200 })
  })

  it('leaves a period GA4 sent nothing for unknown, and a period with no organic row at zero organic', async () => {
    // A new property has no previous period at all: that is unknown, not a
    // measured empty period. A period with traffic but no Organic Search row
    // simply had none.
    mockBatch([period('current', '10', '4', '10', '12', '30', '90', '0', '0.5', '0.5', '300')], [])

    const metrics = await fetchWindowMetrics('fake-token', '123456', '7d')

    expect(metrics.current.organicSessions).toBe(0)
    expect(metrics.previous).toMatchObject({
      activeUsers: null,
      sessions: null,
      engagementRate: null,
      engagementSeconds: null,
      organicSessions: null,
    })
  })
})
