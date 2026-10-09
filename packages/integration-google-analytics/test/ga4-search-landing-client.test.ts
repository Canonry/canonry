import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetGa4ConcurrencyStateForTests, fetchSearchLandingPages } from '../src/ga4-client.js'
import { GA4_DIMENSIONS, GA4_MAX_PAGES, GA4_MAX_RETRIES, GA4_METRICS } from '../src/constants.js'
import { GA4ApiError } from '../src/types.js'
import type { GA4ReportRow, GA4RunReportResponse } from '../src/types.js'

// A live runReport's response shape with synthetic values and paths; provenance in test/fixtures/README.md.
const FIXTURE = JSON.parse(readFileSync(
  new URL('./fixtures/ga4-search-console-landing-pages.json', import.meta.url),
  'utf8',
)) as { _note: string; request: Record<string, unknown>; response: GA4RunReportResponse & { rows: GA4ReportRow[]; totals: GA4ReportRow[] } }

const CAPTURED_ROWS = FIXTURE.response.rows
// 08:00 in Los Angeles on 2026-10-08: GA4's "Last 28 days" is 2026-09-10..2026-10-07,
// exactly the dates of the captured request.
const NOW = '2026-10-08T15:00:00.000Z'

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type RunReportBody = {
  dateRanges: Array<{ startDate: string; endDate: string }>
  limit: number
  offset: number
  [key: string]: unknown
}

/**
 * Serves the captured response the way GA4 pages it: the requested
 * `limit`/`offset` slice of `rows`, with `rowCount` naming every row and
 * `totals` on every page (`laterTotals` replaces it after the first page).
 */
function serveCapture(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  options: { rows?: GA4ReportRow[]; rowCount?: number; laterTotals?: GA4ReportRow[] } = {},
): RunReportBody[] {
  const rows = options.rows ?? CAPTURED_ROWS
  const requests: RunReportBody[] = []
  fetchSpy.mockImplementation(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RunReportBody
    requests.push(body)
    return jsonResponse({
      ...FIXTURE.response,
      rows: rows.slice(body.offset, body.offset + body.limit),
      rowCount: options.rowCount ?? rows.length,
      totals: body.offset > 0 && options.laterTotals ? options.laterTotals : FIXTURE.response.totals,
    })
  })
  return requests
}

function metricRow(page: string, values: [string, string, string, string, string]): GA4ReportRow {
  return { dimensionValues: [{ value: page }], metricValues: values.map((value) => ({ value })) }
}

describe('fetchSearchLandingPages', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetGa4ConcurrencyStateForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.useRealTimers()
    _resetGa4ConcurrencyStateForTests()
  })

  it('keeps the capture provenance next to the data', () => {
    expect(FIXTURE._note).toMatch(/shape captured from a live GA4 Data API runReport/)
    expect(FIXTURE._note).toMatch(/values, totals, rowCount and landing page paths are synthetic/)
    expect(FIXTURE.response.kind).toBe('analyticsData#runReport')
    expect(FIXTURE.response.totals[0]?.dimensionValues[0]?.value).toBe('RESERVED_TOTAL')
  })

  it('sends one Search Console request per window and parses the captured report with GA4\'s own Total', async () => {
    const requests = serveCapture(fetchSpy)

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(requests).toHaveLength(3)
    const expectedBody = (days: number) => ({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: GA4_DIMENSIONS.landingPagePlusQueryString }],
      metrics: [
        { name: GA4_METRICS.organicGoogleSearchClicks },
        { name: GA4_METRICS.organicGoogleSearchImpressions },
        { name: GA4_METRICS.organicGoogleSearchClickThroughRate },
        { name: GA4_METRICS.organicGoogleSearchAveragePosition },
        { name: GA4_METRICS.activeUsers },
      ],
      metricAggregations: ['TOTAL'],
      // Clicks, then impressions, so a capped window drops 0-click pages
      // with no impressions before 0-click pages with some.
      orderBys: [
        { metric: { metricName: GA4_METRICS.organicGoogleSearchClicks }, desc: true },
        { metric: { metricName: GA4_METRICS.organicGoogleSearchImpressions }, desc: true },
        { dimension: { dimensionName: GA4_DIMENSIONS.landingPagePlusQueryString } },
      ],
      limit: 10_000,
      offset: 0,
    })
    expect(requests).toEqual([expectedBody(7), expectedBody(28), expectedBody(90)])
    // No date, source, medium or channel dimension and no filter: GA4 rejects
    // them beside the Search Console metrics.
    expect(requests.every((request) => request.dimensionFilter === undefined)).toBe(true)
    // The captured request carried the same dimension, metrics and aggregation.
    expect(FIXTURE.request).toMatchObject({
      dimensions: expectedBody(28).dimensions,
      metrics: expectedBody(28).metrics,
      metricAggregations: ['TOTAL'],
    })

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    expect(report.windows.map((window) => window.window)).toEqual(['7d', '28d', '90d'])
    const window = report.windows[1]!
    expect(window).toMatchObject({
      window: '28d',
      periodStart: '2026-09-10',
      periodEnd: '2026-10-07',
      timeZone: 'America/Los_Angeles',
      reportRowCount: 14,
      rowsCapped: false,
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
    })
    // The report's own Total row (the RESERVED_TOTAL row), parsed as served.
    expect(window.total).toEqual({
      clicks: 837,
      impressions: 41422,
      ctr: Number('0.020206653469170971'),
      averagePosition: Number('7.31567765921491'),
      activeUsers: 1093,
    })
    // Never the row sum: these 14 rows add up to 812 clicks, not 837.
    expect(window.rows.reduce((sum, row) => sum + row.clicks, 0)).toBe(812)
    expect(window.rows).toHaveLength(14)
    expect(window.rows[0]).toEqual({
      landingPage: '/',
      clicks: 612,
      impressions: 13940,
      ctr: Number('0.043902439024390241'),
      averagePosition: Number('7.2103299856527974'),
      activeUsers: 734,
    })
    // An integer-valued position ("11") and a page with no active users.
    expect(window.rows.find((row) => row.landingPage === '/products/item-5')).toMatchObject({ averagePosition: 11, ctr: 0.08 })
    expect(window.rows.find((row) => row.landingPage === '/blog/post-7')).toMatchObject({ clicks: 3, activeUsers: 0 })
    // Order is GA4's (clicks descending), landing pages exactly as reported.
    expect(window.rows.map((row) => row.landingPage)).toEqual(CAPTURED_ROWS.map((row) => row.dimensionValues[0]!.value))

    expect(report.windows[0]).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-07' })
    expect(report.windows[2]).toMatchObject({ periodStart: '2026-07-10', periodEnd: '2026-10-07' })
  })

  it('pages with limit/offset until every row is read and keeps the first page\'s Total', async () => {
    const requests = serveCapture(fetchSpy, {
      // A later page that disagreed would be ignored: the Total is read once.
      laterTotals: [metricRow('RESERVED_TOTAL', ['9999', '9999', '0.5', '1', '9999'])],
    })

    const report = await fetchSearchLandingPages('fake-token', '123456', { pageSize: 7 })

    expect(requests).toHaveLength(6)
    expect(requests.map((request) => [request.dateRanges[0]!.startDate, request.offset, request.limit])).toEqual(
      expect.arrayContaining([
        ['7daysAgo', 0, 7], ['7daysAgo', 7, 7],
        ['28daysAgo', 0, 7], ['28daysAgo', 7, 7],
        ['90daysAgo', 0, 7], ['90daysAgo', 7, 7],
      ]),
    )
    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    const window = report.windows[1]!
    expect(window.rows.map((row) => row.landingPage)).toEqual(CAPTURED_ROWS.map((row) => row.dimensionValues[0]!.value))
    expect(window.rows[7]).toEqual({
      landingPage: '/guides/page-3',
      clicks: 9,
      impressions: 2930,
      ctr: Number('0.0030716723549488053'),
      averagePosition: Number('4.7300341296928323'),
      activeUsers: 10,
    })
    expect(window.total.clicks).toBe(837)
    expect(window.total.activeUsers).toBe(1093)
    expect(window).toMatchObject({ reportRowCount: 14, rowsCapped: false })
  })

  it('stops at the row cap and says the window was capped', async () => {
    const requests = serveCapture(fetchSpy, { rowCount: 87 })

    const report = await fetchSearchLandingPages('fake-token', '123456', { pageSize: 10, maxRows: 10 })

    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.limit === 10 && request.offset === 0)).toBe(true)
    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    for (const window of report.windows) {
      expect(window.rows).toHaveLength(10)
      expect(window).toMatchObject({ reportRowCount: 87, rowsCapped: true })
      expect(window.total.clicks).toBe(837)
    }
  })

  it('caps instead of throwing when the row cap needs more pages than the page limit allows', async () => {
    const rows = Array.from({ length: GA4_MAX_PAGES * 3 }, (_, index) => metricRow(`/page-${index}`, ['1', '10', '0.1', '5', '1']))
    const requests = serveCapture(fetchSpy, { rows })

    // 2 rows a page can read at most GA4_MAX_PAGES * 2 rows of the 10,000 asked for.
    const report = await fetchSearchLandingPages('fake-token', '123456', { pageSize: 2, maxRows: 10_000 })

    expect(requests).toHaveLength(3 * GA4_MAX_PAGES)
    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    for (const window of report.windows) {
      expect(window.rows).toHaveLength(GA4_MAX_PAGES * 2)
      expect(window).toMatchObject({ reportRowCount: GA4_MAX_PAGES * 3, rowsCapped: true })
    }
  })

  it('reads CTR and position as null, never 0, when a row or the Total has no impressions', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({
      ...FIXTURE.response,
      rows: [
        metricRow('/members?ref=newsletter', ['0', '0', '0', '0', '3']),
        metricRow('/out-of-range', ['4', '2', '2', '-1', '1']),
      ],
      rowCount: 2,
      totals: [metricRow('RESERVED_TOTAL', ['0', '0', '0', '0', '4'])],
    }))

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    const window = report.windows[0]!
    expect(window.rows).toEqual([
      { landingPage: '/members?ref=newsletter', clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 3 },
      // A CTR outside 0..1 or a non-positive position is not a reading.
      { landingPage: '/out-of-range', clicks: 4, impressions: 2, ctr: null, averagePosition: null, activeUsers: 1 },
    ])
    expect(window.total).toEqual({ clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 4 })
  })

  it('labels the window in the property time zone, not UTC', async () => {
    // 20:00 on 2026-10-07 in Los Angeles; already 2026-10-08 in UTC.
    vi.setSystemTime(new Date('2026-10-08T03:00:00.000Z'))
    serveCapture(fetchSpy)

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    expect(report.windows.map(({ window, periodStart, periodEnd }) => ({ window, periodStart, periodEnd }))).toEqual([
      { window: '7d', periodStart: '2026-09-30', periodEnd: '2026-10-06' },
      { window: '28d', periodStart: '2026-09-09', periodEnd: '2026-10-06' },
      { window: '90d', periodStart: '2026-07-09', periodEnd: '2026-10-06' },
    ])
  })

  it('falls back to UTC dates and a null time zone when GA4 names none', async () => {
    vi.setSystemTime(new Date('2026-10-08T03:00:00.000Z'))
    fetchSpy.mockImplementation(async () => jsonResponse({ ...FIXTURE.response, rowCount: 14, metadata: {} }))

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    expect(report.windows[1]).toMatchObject({ timeZone: null, periodStart: '2026-09-10', periodEnd: '2026-10-07' })
  })

  it('reads metric columns by the response headers, not by position', async () => {
    const reordered = (row: GA4ReportRow): GA4ReportRow => ({
      dimensionValues: row.dimensionValues,
      metricValues: [row.metricValues[4]!, ...row.metricValues.slice(0, 4)],
    })
    fetchSpy.mockImplementation(async () => jsonResponse({
      ...FIXTURE.response,
      metricHeaders: [FIXTURE.response.metricHeaders![4]!, ...FIXTURE.response.metricHeaders!.slice(0, 4)],
      rows: CAPTURED_ROWS.slice(0, 1).map(reordered),
      rowCount: 1,
      totals: FIXTURE.response.totals.map(reordered),
    }))

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    expect(report.windows[0]!.rows[0]).toMatchObject({ landingPage: '/', clicks: 612, activeUsers: 734 })
    expect(report.windows[0]!.total).toMatchObject({ clicks: 837, activeUsers: 1093 })
  })

  it('refuses to sum rows when GA4 sends rows without a TOTAL row', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ ...FIXTURE.response, rowCount: 14, totals: undefined }))

    await expect(fetchSearchLandingPages('fake-token', '123456')).rejects.toThrow(/without a TOTAL row/)
  })

  it('is ready with zero rows and a zero Total for an empty report', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' }, kind: 'analyticsData#runReport' }))

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('ready')
    if (report.status !== 'ready') return
    for (const window of report.windows) {
      expect(window.rows).toEqual([])
      expect(window.total).toEqual({ clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 0 })
      expect(window).toMatchObject({ reportRowCount: 0, rowsCapped: false })
    }
  })

  it('is unavailable when every window is empty and GA4 names an empty reason (not captured live)', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ metadata: { timeZone: 'America/Los_Angeles', emptyReason: 'NO_SEARCH_CONSOLE_LINK' } }))

    await expect(fetchSearchLandingPages('fake-token', '123456')).resolves.toEqual({
      status: 'unavailable',
      reason: 'GA4 returned no Search Console rows (NO_SEARCH_CONSOLE_LINK)',
    })
  })

  it('is unavailable, with Google\'s message, when GA4 refuses the Search Console metrics (not captured live)', async () => {
    const message = 'Field organicGoogleSearchClicks is not available for this property. Link Search Console to use it.'
    fetchSpy.mockImplementation(async () => jsonResponse({ error: { code: 400, status: 'INVALID_ARGUMENT', message } }, 400))

    const report = await fetchSearchLandingPages('fake-token', '123456')

    expect(report.status).toBe('unavailable')
    if (report.status !== 'unavailable') return
    expect(report.reason).toContain('GA4 API error (400)')
    expect(report.reason).toContain(message)
    // A 400 is not retried.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('throws other client errors instead of reading them as unavailable', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ error: { code: 400, message: 'Invalid date range' } }, 400))
    await expect(fetchSearchLandingPages('fake-token', '123456')).rejects.toThrow(/Invalid date range/)

    fetchSpy.mockImplementation(async () => jsonResponse({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions' } }, 403))
    const denied = await fetchSearchLandingPages('fake-token', '123456').catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(GA4ApiError)
    expect((denied as GA4ApiError).status).toBe(403)
  })

  it('retries a 5xx through the shared GA4 retry budget, then throws', async () => {
    fetchSpy.mockImplementation(async () => new Response('backend error', { status: 503 }))

    const settled = fetchSearchLandingPages('fake-token', '123456').catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    const error = await settled

    expect(error).toBeInstanceOf(GA4ApiError)
    expect((error as GA4ApiError).status).toBe(503)
    // Three windows, each tried once plus GA4_MAX_RETRIES times.
    expect(fetchSpy).toHaveBeenCalledTimes(3 * (GA4_MAX_RETRIES + 1))
  })
})
