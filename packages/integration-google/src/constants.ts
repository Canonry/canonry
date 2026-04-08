export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
export const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing'
export const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3'
export const URL_INSPECTION_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
export const GSC_MAX_ROWS_PER_REQUEST = 25000
export const GSC_DATA_LAG_DAYS = 3
export const URL_INSPECTION_DAILY_LIMIT = 2000
export const INDEXING_API_BASE = 'https://indexing.googleapis.com/v3'
export const INDEXING_API_DAILY_LIMIT = 200

// HTTP request timeout (30 s) — prevents the process from hanging indefinitely
// on a slow or unresponsive Google API endpoint.
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000

// Safety limit: max pagination iterations to prevent infinite loops if the API
// returns inconsistent results.
export const GSC_MAX_PAGES = 40
