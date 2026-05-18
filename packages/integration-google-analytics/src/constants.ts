export const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta'
export const GA4_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GA4_DEFAULT_SYNC_DAYS = 30
export const GA4_MAX_SYNC_DAYS = 90

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
 * `no-restricted-syntax` in the workspace config.
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
} as const

/** GA4 metric names used in `runReport` requests. Same rationale as `GA4_DIMENSIONS`. */
export const GA4_METRICS = {
  sessions: 'sessions',
  totalUsers: 'totalUsers',
} as const
