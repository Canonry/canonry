export const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta'
export const GA4_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GA4_DEFAULT_SYNC_DAYS = 30
export const GA4_MAX_SYNC_DAYS = 90

/**
 * Resolve a caller-supplied sync window into the window that will actually be
 * fetched, and say whether the two differ.
 *
 * Every fetch in `ga4-client.ts` bounds `days` to `[1, GA4_MAX_SYNC_DAYS]`.
 * That clamp is invisible from the outside: `--days 500` used to return
 * `{"days": 500, "synced": true}` while writing exactly 90 days, so a caller
 * had no way to tell truncated history from a property that only had 90 days
 * of data. Resolving the window through one helper is what lets the sync
 * response report the EFFECTIVE count alongside what was asked for — and
 * keeps the bound from drifting between the six fetch sites and the route.
 *
 * A non-finite `days` (e.g. `parseInt('abc')`) falls back to the default
 * rather than propagating `NaN` into the response contract.
 */
export function resolveGa4SyncDays(days?: number | null): {
  /** What the caller asked for, after defaulting. Never `NaN`. */
  requestedDays: number
  /** What will actually be fetched — `requestedDays` bounded to `[1, GA4_MAX_SYNC_DAYS]`. */
  effectiveDays: number
  /** True when the bound moved the window, i.e. the caller did not get the range they asked for. */
  clamped: boolean
} {
  const requestedDays = days != null && Number.isFinite(days)
    ? Math.trunc(days)
    : GA4_DEFAULT_SYNC_DAYS
  const effectiveDays = Math.min(Math.max(1, requestedDays), GA4_MAX_SYNC_DAYS)
  return { requestedDays, effectiveDays, clamped: effectiveDays !== requestedDays }
}

// HTTP request timeout (30 s) — prevents the process from hanging indefinitely
// on a slow or unresponsive GA4 Data API endpoint.
export const GA4_REQUEST_TIMEOUT_MS = 30_000

// Safety limit: max pagination iterations to prevent infinite loops.
export const GA4_MAX_PAGES = 50

// GA4 Data API caps concurrent requests per property at 10. We hold the in-flight
// budget well under that — a sync fires 5-7 top-level fetches (`fetchAggregateSummary`
// + 3x `fetchWindowSummary` + traffic + AI + social) in parallel, each of which
// then paginates serially, so bursts of 6+ concurrent calls were routinely
// crossing the limit and surfacing as 429 QUOTA_EXCEEDED.
export const GA4_MAX_CONCURRENT_REQUESTS = 4

// Retry budget for transient failures (429, 5xx). With initialDelay=1s and
// doubling: 1s, 2s, 4s — total worst-case sleep ~7s before giving up. Honors
// the GA4 API's `Retry-After` header when present, overriding the computed delay.
export const GA4_MAX_RETRIES = 3
export const GA4_INITIAL_RETRY_DELAY_MS = 1000

/**
 * GA4 dimension names used in `runReport` requests. Centralized so a typo or
 * naming change (e.g. the `sessionDefaultChannelGroup` vs. `…Grouping` drift
 * that broke CI when source/test diverged) is impossible — every call site
 * and every test imports the same identifier.
 *
 * ESLint blocks raw use of these string values outside this file via
 * `canonry-guards/no-inline-ga4-dimension` in the workspace config.
 */
export const GA4_DIMENSIONS = {
  date: 'date',
  landingPagePlusQueryString: 'landingPagePlusQueryString',
  sessionSource: 'sessionSource',
  sessionMedium: 'sessionMedium',
  sessionManualSource: 'sessionManualSource',
  sessionManualMedium: 'sessionManualMedium',
  firstUserSource: 'firstUserSource',
  firstUserMedium: 'firstUserMedium',
  sessionDefaultChannelGrouping: 'sessionDefaultChannelGrouping',
  sessionDefaultChannelGroup: 'sessionDefaultChannelGroup',
  hostName: 'hostName',
  eventName: 'eventName',
} as const

/** GA4 metric names used in `runReport` requests. Same rationale as `GA4_DIMENSIONS`. */
export const GA4_METRICS = {
  sessions: 'sessions',
  totalUsers: 'totalUsers',
  eventCount: 'eventCount',
  /** Share of sessions that were engaged. A real GA4 metric — request it directly. */
  engagementRate: 'engagementRate',
  /**
   * First-time users, a real GA4 metric requested directly.
   *
   * Not an input to a returning-users figure: a visitor can be first-seen and
   * return inside the same range, so subtracting this from totalUsers does not
   * reconstruct one.
   */
  newUsers: 'newUsers',
  /**
   * GA4's "Active users". In the Search Console landing-page report it is the
   * plain metric from the same request as the Search Console metrics: that
   * reproduced GA4's own report exactly, while filtering it to google / organic
   * sessions did not (captured live, 2026-10-08).
   */
  activeUsers: 'activeUsers',
  /**
   * Search Console metrics a GA4 property exposes once it is linked to Search
   * Console. Compatible only with the landing page, device and country
   * dimensions: `date`, `sessionSource`, `sessionMedium` and
   * `sessionDefaultChannelGroup` are INCOMPATIBLE (checkCompatibility, captured
   * live), so the report is one request per window with no daily rows and no
   * source filter.
   */
  organicGoogleSearchClicks: 'organicGoogleSearchClicks',
  organicGoogleSearchImpressions: 'organicGoogleSearchImpressions',
  organicGoogleSearchClickThroughRate: 'organicGoogleSearchClickThroughRate',
  organicGoogleSearchAveragePosition: 'organicGoogleSearchAveragePosition',
} as const

/**
 * Most landing-page rows stored per window of the Search Console landing-page
 * report. Rows are requested by clicks, then impressions (both descending), so
 * a capped window keeps the pages with the most search traffic, and the stored
 * window says it was capped.
 */
export const GA4_SEARCH_LANDING_MAX_ROWS = 10_000

/** Rows requested per page of the Search Console landing-page report. */
export const GA4_SEARCH_LANDING_PAGE_SIZE = 10_000
