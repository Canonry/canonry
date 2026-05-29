import { GBP_PERFORMANCE_BASE, GBP_DEFAULT_PAGE_SIZE, GBP_MAX_PAGES } from './constants.js'
import { gbpFetchGet } from './http.js'
import type { GbpFetchOptions } from './types.js'

// ---------- daily metrics ----------

interface GoogleDate { year: number; month: number; day: number }

interface DatedValue {
  date: GoogleDate
  /** String-encoded integer. ABSENT on zero days — treat missing as 0. */
  value?: string
}

interface FetchMultiDailyResponse {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: Array<{
      dailyMetric: string
      timeSeries: { datedValues?: DatedValue[] }
    }>
  }>
}

export interface GbpDailyMetricRow {
  metric: string
  /** YYYY-MM-DD */
  date: string
  value: number
}

export interface FetchDailyMetricsOptions extends GbpFetchOptions {
  metrics: readonly string[]
  startDate: Date
  endDate: Date
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatGoogleDate(d: GoogleDate): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
}

/**
 * Fetch daily performance metrics for a location across a date range.
 * Flattens Google's nested `multiDailyMetricTimeSeries` into one row per
 * (metric, date), parsing the string-encoded value and treating omitted
 * zero-days (no `value` key) as 0.
 */
export async function fetchDailyMetrics(
  accessToken: string,
  locationName: string,
  opts: FetchDailyMetricsOptions,
): Promise<GbpDailyMetricRow[]> {
  const params = new URLSearchParams()
  for (const m of opts.metrics) params.append('dailyMetrics', m)
  params.set('dailyRange.startDate.year', String(opts.startDate.getUTCFullYear()))
  params.set('dailyRange.startDate.month', String(opts.startDate.getUTCMonth() + 1))
  params.set('dailyRange.startDate.day', String(opts.startDate.getUTCDate()))
  params.set('dailyRange.endDate.year', String(opts.endDate.getUTCFullYear()))
  params.set('dailyRange.endDate.month', String(opts.endDate.getUTCMonth() + 1))
  params.set('dailyRange.endDate.day', String(opts.endDate.getUTCDate()))

  const url = `${GBP_PERFORMANCE_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`
  const res = await gbpFetchGet<FetchMultiDailyResponse>(url, accessToken, opts)

  const rows: GbpDailyMetricRow[] = []
  const series = res.multiDailyMetricTimeSeries?.[0]?.dailyMetricTimeSeries ?? []
  for (const s of series) {
    for (const dv of s.timeSeries?.datedValues ?? []) {
      rows.push({
        metric: s.dailyMetric,
        date: formatGoogleDate(dv.date),
        // Omitted value = zero traffic that day.
        value: dv.value !== undefined ? Number(dv.value) : 0,
      })
    }
  }
  return rows
}

// ---------- monthly search keywords ----------

interface SearchKeywordCount {
  searchKeyword: string
  insightsValue?: {
    /** Exact count (string-encoded). Present when above the privacy floor. */
    value?: string
    /** Privacy floor (string-encoded). Present when redacted. */
    threshold?: string
  }
}

interface MonthlyKeywordsResponse {
  searchKeywordsCounts?: SearchKeywordCount[]
  nextPageToken?: string
}

export interface GbpKeywordRow {
  keyword: string
  /** Exact impressions, or null when Google redacted to a threshold. */
  valueCount: number | null
  /** Privacy floor, or null when an exact value is available. */
  valueThreshold: number | null
}

export interface ListMonthlyKeywordsOptions extends GbpFetchOptions {
  startMonth: { year: number; month: number }
  endMonth: { year: number; month: number }
}

/**
 * List monthly search-keyword impressions for a location across a month range.
 * Fully paginated. Maps Google's `insightsValue` union into typed
 * `valueCount` / `valueThreshold` (exactly one non-null per row).
 */
export async function listMonthlyKeywords(
  accessToken: string,
  locationName: string,
  opts: ListMonthlyKeywordsOptions,
): Promise<GbpKeywordRow[]> {
  const collected: GbpKeywordRow[] = []
  let pageToken: string | undefined
  let page = 0
  do {
    const params = new URLSearchParams()
    params.set('monthlyRange.startMonth.year', String(opts.startMonth.year))
    params.set('monthlyRange.startMonth.month', String(opts.startMonth.month))
    params.set('monthlyRange.endMonth.year', String(opts.endMonth.year))
    params.set('monthlyRange.endMonth.month', String(opts.endMonth.month))
    params.set('pageSize', String(GBP_DEFAULT_PAGE_SIZE))
    if (pageToken) params.set('pageToken', pageToken)

    const url = `${GBP_PERFORMANCE_BASE}/${locationName}/searchkeywords/impressions/monthly?${params.toString()}`
    const res = await gbpFetchGet<MonthlyKeywordsResponse>(url, accessToken, opts)

    for (const c of res.searchKeywordsCounts ?? []) {
      const value = c.insightsValue?.value
      const threshold = c.insightsValue?.threshold
      collected.push({
        keyword: c.searchKeyword,
        valueCount: value !== undefined ? Number(value) : null,
        valueThreshold: value === undefined && threshold !== undefined ? Number(threshold) : null,
      })
    }
    pageToken = res.nextPageToken
    page++
  } while (pageToken && page < GBP_MAX_PAGES)
  return collected
}
