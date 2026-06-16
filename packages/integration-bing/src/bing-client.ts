import { BING_WMT_API_BASE, BING_SUBMIT_URL_BATCH_LIMIT, BING_SUBMIT_URL_DAILY_LIMIT, BING_REQUEST_TIMEOUT_MS, BING_LINKS_MAX_PAGES } from './constants.js'
import type {
  BingSite,
  BingUrlInfo,
  BingKeywordStats,
  BingCrawlStats,
  BingCrawlIssue,
  BingInboundLink,
  BingLinkCount,
} from './types.js'
import { BingApiError } from './types.js'

/** Raw `GetLinkCounts` (`LinkCounts`) payload — the array lives under `Links`. */
interface BingLinkCountsResponse {
  Links?: BingLinkCount[] | null
  TotalPages?: number
}

/** Raw `GetUrlLinks` (`LinkDetails`) payload — the array lives under `Details`. */
interface BingLinkDetailsResponse {
  Details?: BingInboundLink[] | null
  TotalPages?: number
}

function validateApiKey(apiKey: string): void {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new BingApiError('API key is required and must be a non-empty string', 400)
  }
}

function validateSiteUrl(siteUrl: string): void {
  if (!siteUrl || typeof siteUrl !== 'string' || siteUrl.trim().length === 0) {
    throw new BingApiError('Site URL is required and must be a non-empty string', 400)
  }
  try {
    const url = new URL(siteUrl)
    if (!url.protocol.startsWith('http')) {
      throw new BingApiError('Site URL must be an HTTP or HTTPS URL', 400)
    }
  } catch {
    throw new BingApiError('Site URL must be a valid URL', 400)
  }
}

function validateUrl(urlParam: string): void {
  if (!urlParam || typeof urlParam !== 'string' || urlParam.trim().length === 0) {
    throw new BingApiError('URL is required and must be a non-empty string', 400)
  }
  try {
    const url = new URL(urlParam)
    if (!url.protocol.startsWith('http')) {
      throw new BingApiError('URL must be an HTTP or HTTPS URL', 400)
    }
  } catch {
    throw new BingApiError('URL must be a valid URL', 400)
  }
}

function validateUrls(urls: string[]): void {
  if (!Array.isArray(urls)) {
    throw new BingApiError('URLs must be an array', 400)
  }
  for (const url of urls) {
    validateUrl(url)
  }
}

function bingClientLog(level: 'info' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module: 'BingClient',
    action,
    ...ctx,
  }
  // Sanitize potential secrets
  if (entry.apiKey) entry.apiKey = '***'
  if (entry.apikey) entry.apikey = '***'

  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function bingFetch<T>(apiKey: string, endpoint: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const method = opts?.method ?? 'GET'
  const separator = endpoint.includes('?') ? '&' : '?'
  const url = `${BING_WMT_API_BASE}/${endpoint}${separator}apikey=${encodeURIComponent(apiKey)}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  }

  const res = await fetch(url, {
    method,
    headers,
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(BING_REQUEST_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    bingClientLog('error', 'http.auth-failed', { endpoint, method, httpStatus: res.status })
    throw new BingApiError('Bing API key is invalid or unauthorized', res.status)
  }

  if (res.status === 429) {
    bingClientLog('error', 'http.rate-limited', { endpoint, method, httpStatus: 429 })
    throw new BingApiError('Bing API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    bingClientLog('error', 'http.error', { endpoint, method, httpStatus: res.status })
    // Sanitize: avoid leaking API key from error messages if it appears in the body
    let detail = body.length <= 500 ? body : `${body.slice(0, 500)}... [truncated]`
    detail = detail.replace(new RegExp(escapeRegExp(apiKey), 'g'), '***')
    throw new BingApiError(`Bing API error (${res.status}): ${detail}`, res.status)
  }

  const text = await res.text()
  if (!text || text.trim() === '') {
    return undefined as T
  }

  try {
    const parsed = JSON.parse(text) as { d?: T } | T
    // Bing API wraps responses in { d: ... }
    if (parsed && typeof parsed === 'object' && 'd' in parsed) {
      return parsed.d as T
    }
    return parsed as T
  } catch {
    throw new BingApiError('Bing API returned invalid JSON', 502)
  }
}

export async function getSites(apiKey: string): Promise<BingSite[]> {
  validateApiKey(apiKey)
  const data = await bingFetch<BingSite[]>(apiKey, 'GetUserSites')
  return data ?? []
}

export async function addSite(apiKey: string, siteUrl: string): Promise<void> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  await bingFetch<unknown>(apiKey, 'AddSite', {
    method: 'POST',
    body: { siteUrl },
  })
}

export async function getUrlInfo(apiKey: string, siteUrl: string, url: string): Promise<BingUrlInfo> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrl(url)
  const encodedSite = encodeURIComponent(siteUrl)
  const encodedUrl = encodeURIComponent(url)
  return bingFetch<BingUrlInfo>(apiKey, `GetUrlInfo?siteUrl=${encodedSite}&url=${encodedUrl}`)
}

export async function submitUrl(apiKey: string, siteUrl: string, url: string): Promise<void> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrl(url)
  await bingFetch<unknown>(apiKey, 'SubmitUrl', {
    method: 'POST',
    body: { siteUrl, url },
  })
}

export async function submitUrlBatch(apiKey: string, siteUrl: string, urls: string[]): Promise<void> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrls(urls)
  if (urls.length > BING_SUBMIT_URL_DAILY_LIMIT) {
    throw new BingApiError(
      `URL batch exceeds daily limit of ${BING_SUBMIT_URL_DAILY_LIMIT}. Got ${urls.length} URLs.`,
      400,
    )
  }
  // Respect the 500 URL per batch limit
  for (let i = 0; i < urls.length; i += BING_SUBMIT_URL_BATCH_LIMIT) {
    const batch = urls.slice(i, i + BING_SUBMIT_URL_BATCH_LIMIT)
    await bingFetch<unknown>(apiKey, 'SubmitUrlbatch', {
      method: 'POST',
      body: { siteUrl, urlList: batch },
    })
  }
}

export async function getKeywordStats(apiKey: string, siteUrl: string): Promise<BingKeywordStats[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingKeywordStats[]>(apiKey, `GetQueryStats?siteUrl=${encodedSite}`)
  return data ?? []
}

export async function getCrawlStats(apiKey: string, siteUrl: string): Promise<BingCrawlStats[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingCrawlStats[]>(apiKey, `GetCrawlStats?siteUrl=${encodedSite}`)
  return data ?? []
}

export async function getCrawlIssues(apiKey: string, siteUrl: string): Promise<BingCrawlIssue[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingCrawlIssue[]>(apiKey, `GetCrawlIssues?siteUrl=${encodedSite}`)
  return data ?? []
}

/**
 * Lists the connected site's pages that have inbound links, with the inbound
 * count per page (Bing `GetLinkCounts`). Auto-paginates across `TotalPages`,
 * bounded by `opts.maxPages` (default {@link BING_LINKS_MAX_PAGES}) so a site
 * with a deep link graph can't exhaust the Bing daily request budget in one
 * call. Returns a flat list across all walked pages.
 */
export async function getLinkCounts(
  apiKey: string,
  siteUrl: string,
  opts: { maxPages?: number } = {},
): Promise<BingLinkCount[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  const encodedSite = encodeURIComponent(siteUrl)
  const maxPages = Math.max(1, opts.maxPages ?? BING_LINKS_MAX_PAGES)

  // Bing paginates these link endpoints with a 0-INDEXED `page` (first page = 0;
  // valid pages 0..TotalPages-1), so starting at 0 and looping while
  // page < totalPages covers every page with no last-page drop. Verified against
  // the merj reference client (typed `page: NonNegativeInt = 0`) and a recorded
  // GetLinkCounts response (request `?page=0`) — a live multi-page capture on a
  // real property is still the gold standard for full-coverage behavior.
  const out: BingLinkCount[] = []
  let page = 0
  let totalPages = 1
  while (page < totalPages && page < maxPages) {
    const data = await bingFetch<BingLinkCountsResponse>(apiKey, `GetLinkCounts?siteUrl=${encodedSite}&page=${page}`)
    for (const link of data?.Links ?? []) {
      if (link && typeof link.Url === 'string') {
        out.push({ Url: link.Url, Count: Number(link.Count ?? 0) })
      }
    }
    totalPages = Number(data?.TotalPages ?? 1) || 1
    page++
  }
  return out
}

/**
 * Returns the inbound links pointing at a specific page (`link`) on the
 * connected site (Bing `GetUrlLinks`). Each entry carries the external linking
 * URL plus its anchor text. Auto-paginates across `TotalPages`, bounded by
 * `opts.maxPages` (default {@link BING_LINKS_MAX_PAGES}).
 */
export async function getUrlLinks(
  apiKey: string,
  siteUrl: string,
  link: string,
  opts: { maxPages?: number } = {},
): Promise<BingInboundLink[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrl(link)
  const encodedSite = encodeURIComponent(siteUrl)
  const encodedLink = encodeURIComponent(link)
  const maxPages = Math.max(1, opts.maxPages ?? BING_LINKS_MAX_PAGES)

  // GetUrlLinks uses the same 0-indexed `page` as GetLinkCounts (see the note there).
  const out: BingInboundLink[] = []
  let page = 0
  let totalPages = 1
  while (page < totalPages && page < maxPages) {
    const data = await bingFetch<BingLinkDetailsResponse>(
      apiKey,
      `GetUrlLinks?siteUrl=${encodedSite}&link=${encodedLink}&page=${page}`,
    )
    for (const detail of data?.Details ?? []) {
      if (detail && typeof detail.Url === 'string') {
        out.push({ Url: detail.Url, AnchorText: detail.AnchorText })
      }
    }
    totalPages = Number(data?.TotalPages ?? 1) || 1
    page++
  }
  return out
}
