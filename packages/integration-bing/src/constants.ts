export const BING_WMT_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json'

// URL submission limits
export const BING_SUBMIT_URL_BATCH_LIMIT = 500
export const BING_SUBMIT_URL_DAILY_LIMIT = 10000

// HTTP request timeout (30 s) — prevents the process from hanging indefinitely
// on a slow or unresponsive Bing Webmaster Tools endpoint.
export const BING_REQUEST_TIMEOUT_MS = 30_000
