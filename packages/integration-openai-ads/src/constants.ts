export const OPENAI_ADS_API_BASE = 'https://api.ads.openai.com/v1'

export const OPENAI_ADS_REQUEST_TIMEOUT_MS = 30_000

// Backstop against a pagination loop (e.g. a server that always returns
// has_more=true). 100 pages is far beyond any observed account size.
export const OPENAI_ADS_MAX_PAGES = 100
