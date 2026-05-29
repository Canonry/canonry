import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchDailyMetrics, listMonthlyKeywords } from '../src/performance-client.js'

describe('fetchDailyMetrics', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  // Real shape captured from production (May 2026): split date objects,
  // string-encoded values, and zero-days that OMIT the value field entirely.
  function metricsResponse() {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        multiDailyMetricTimeSeries: [{
          dailyMetricTimeSeries: [
            {
              dailyMetric: 'WEBSITE_CLICKS',
              timeSeries: {
                datedValues: [
                  { date: { year: 2026, month: 5, day: 1 }, value: '12' },
                  { date: { year: 2026, month: 5, day: 2 } },          // zero day — no value key
                  { date: { year: 2026, month: 5, day: 3 }, value: '4' },
                ],
              },
            },
            {
              dailyMetric: 'CALL_CLICKS',
              timeSeries: {
                datedValues: [
                  { date: { year: 2026, month: 5, day: 1 } },          // all zero
                ],
              },
            },
          ],
        }],
      }),
    }
  }

  it('parses string values, fills omitted zero-days as 0, and flattens dates to YYYY-MM-DD', async () => {
    fetchSpy.mockResolvedValueOnce(metricsResponse())
    const rows = await fetchDailyMetrics('valid-token', 'locations/123', {
      metrics: ['WEBSITE_CLICKS', 'CALL_CLICKS'],
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2026-05-03T00:00:00Z'),
    })
    expect(rows).toEqual([
      { metric: 'WEBSITE_CLICKS', date: '2026-05-01', value: 12 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-02', value: 0 },
      { metric: 'WEBSITE_CLICKS', date: '2026-05-03', value: 4 },
      { metric: 'CALL_CLICKS', date: '2026-05-01', value: 0 },
    ])
  })

  it('zero-pads month and day in the YYYY-MM-DD key', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        multiDailyMetricTimeSeries: [{
          dailyMetricTimeSeries: [{
            dailyMetric: 'WEBSITE_CLICKS',
            timeSeries: { datedValues: [{ date: { year: 2026, month: 1, day: 9 }, value: '3' }] },
          }],
        }],
      }),
    })
    const rows = await fetchDailyMetrics('t', 'locations/1', {
      metrics: ['WEBSITE_CLICKS'], startDate: new Date('2026-01-09T00:00:00Z'), endDate: new Date('2026-01-09T00:00:00Z'),
    })
    expect(rows[0]!.date).toBe('2026-01-09')
  })

  it('returns empty array when the API returns no series', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
    const rows = await fetchDailyMetrics('t', 'locations/1', {
      metrics: ['WEBSITE_CLICKS'], startDate: new Date('2026-05-01T00:00:00Z'), endDate: new Date('2026-05-02T00:00:00Z'),
    })
    expect(rows).toEqual([])
  })

  it('requests every metric via repeated dailyMetrics params', async () => {
    fetchSpy.mockResolvedValueOnce(metricsResponse())
    await fetchDailyMetrics('t', 'locations/123', {
      metrics: ['WEBSITE_CLICKS', 'CALL_CLICKS'],
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2026-05-03T00:00:00Z'),
    })
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('dailyMetrics=WEBSITE_CLICKS')
    expect(url).toContain('dailyMetrics=CALL_CLICKS')
    expect(url).toContain('dailyRange.startDate.year=2026')
    expect(url).toContain('fetchMultiDailyMetricsTimeSeries')
  })
})

describe('listMonthlyKeywords', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('parses the value/threshold union (string-encoded) into typed rows', async () => {
    // Real shapes: { value: "10939" } for high-volume, { threshold: "15" } for redacted.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        searchKeywordsCounts: [
          { searchKeyword: 'hotels', insightsValue: { value: '10939' } },
          { searchKeyword: '10028 ai', insightsValue: { threshold: '15' } },
        ],
      }),
    })
    const rows = await listMonthlyKeywords('t', 'locations/123', {
      startMonth: { year: 2026, month: 1 },
      endMonth: { year: 2026, month: 3 },
    })
    expect(rows).toEqual([
      { keyword: 'hotels', valueCount: 10939, valueThreshold: null },
      { keyword: '10028 ai', valueCount: null, valueThreshold: 15 },
    ])
  })

  it('paginates across nextPageToken', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({
          searchKeywordsCounts: [{ searchKeyword: 'a', insightsValue: { value: '5' } }],
          nextPageToken: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => JSON.stringify({
          searchKeywordsCounts: [{ searchKeyword: 'b', insightsValue: { threshold: '15' } }],
        }),
      })
    const rows = await listMonthlyKeywords('t', 'locations/123', {
      startMonth: { year: 2026, month: 1 },
      endMonth: { year: 2026, month: 3 },
    })
    expect(rows.map(r => r.keyword)).toEqual(['a', 'b'])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]![0]).toContain('pageToken=page2')
  })

  it('returns empty array when no keyword data', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
    const rows = await listMonthlyKeywords('t', 'locations/1', {
      startMonth: { year: 2026, month: 1 }, endMonth: { year: 2026, month: 3 },
    })
    expect(rows).toEqual([])
  })

  it('sends monthlyRange params', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
    await listMonthlyKeywords('t', 'locations/1', {
      startMonth: { year: 2025, month: 11 }, endMonth: { year: 2026, month: 5 },
    })
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('monthlyRange.startMonth.year=2025')
    expect(url).toContain('monthlyRange.startMonth.month=11')
    expect(url).toContain('monthlyRange.endMonth.year=2026')
    expect(url).toContain('monthlyRange.endMonth.month=5')
    expect(url).toContain('searchkeywords/impressions/monthly')
  })
})
