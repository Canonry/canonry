import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { gaOverviewComparisonRanges } from '@canonry/canonry-contracts'
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
    vi.useRealTimers()
  })

  function mockBatch(totals: Row[], organic: Row[]) {
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(...((JSON.parse(String(init?.body ?? '{}')) as { requests?: ReportRequest[] }).requests ?? []))
      return new Response(JSON.stringify({
        reports: [
          { dimensionHeaders: [{ name: 'dateRange' }], rows: totals, rowCount: totals.length },
          { dimensionHeaders: [{ name: 'dateRange' }], rows: organic, rowCount: organic.length },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  const period = (name: string, ...values: string[]): Row => ({
    dimensionValues: [{ value: name }],
    metricValues: values.map(value => ({ value })),
  })

  it('asks for both periods as named ranges, with every window figure by its GA4 name', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T09:00:00Z'), toFake: ['Date'] })
    mockBatch([], [])

    await fetchWindowMetrics('fake-token', '123456', '30d')

    expect(requests).toHaveLength(2)
    const expected = gaOverviewComparisonRanges('30d', new Date('2026-10-23T09:00:00Z'))
    for (const request of requests) {
      expect(request.dateRanges).toEqual([
        { ...expected.current, name: 'current' },
        { ...expected.previous, name: 'previous' },
      ])
      expect(request.dimensions).toEqual([])
    }
    // GA4's "Last 30 days": the 30 complete days ending yesterday, and the 30 before.
    expect(expected).toEqual({
      current: { startDate: '2026-09-23', endDate: '2026-10-22' },
      previous: { startDate: '2026-08-24', endDate: '2026-09-22' },
    })
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
