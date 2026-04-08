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
