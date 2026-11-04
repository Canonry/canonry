import { withRetry, isRetryableHttpError, retryAfterDelayMs, escapeRegExp, describeFetchError } from '@canonry/canonry-contracts'
import crypto from 'node:crypto'
import { BING_WMT_API_BASE, BING_SUBMIT_URL_BATCH_LIMIT, BING_SUBMIT_URL_DAILY_LIMIT, BING_REQUEST_TIMEOUT_MS, BING_MAX_RETRIES, BING_RETRY_BASE_DELAY_MS, BING_RETRY_MAX_DELAY_MS, BING_THROTTLE_COOLDOWN_MS } from './constants.js'
import type {
  BingSite,
  BingUrlInfo,
  BingCrawlStats,
  BingCrawlIssue,
  BingQueryStats,
  BingRankAndTrafficStats,
  BingDetailedQueryStats,
  BingUrlTrafficInfo,
  BingFeed,
  BingSubmissionQuota,
  BingCrawlSettings,
  BingBlockedUrl,
  BingQueryParameter,
  BingCountryRegionSettings,
  BingFetchedUrl,
  BingFetchedUrlDetails,
  BingSiteRole,
  BingLinkCounts,
  BingLinkDetails,
  BingKeyword,
  BingKeywordHistory,
  BingUrlFilterProperties,
} from './types.js'
import { BingApiError } from './types.js'

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

function bingClientLog(level: 'info' | 'warn' | 'error', action: string, ctx?: Record<string, unknown>): void {
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

/**
 * Pull Bing's `ErrorCode` out of an error body.
 *
 * Bing sometimes wraps the payload (`{"d":{...}}`) and sometimes does not, and
 * a throttle body is small, so a tolerant parse beats a schema here — the
 * caller only needs the number, and a miss degrades to "not a throttle".
 */
function parseBingErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as unknown
    const root = parsed != null && typeof parsed === 'object' && 'd' in parsed
      ? (parsed as { d: unknown }).d
      : parsed
    if (root != null && typeof root === 'object' && 'ErrorCode' in root) {
      const code = (root as { ErrorCode: unknown }).ErrorCode
      if (typeof code === 'number') return code
    }
  } catch {
    // Non-JSON body (an HTML error page, say) — nothing to read.
  }
  return null
}

async function bingFetchOnce<T>(apiKey: string, endpoint: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const method = opts?.method ?? 'GET'
  const separator = endpoint.includes('?') ? '&' : '?'
  const url = `${BING_WMT_API_BASE}/${endpoint}${separator}apikey=${encodeURIComponent(apiKey)}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(BING_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(describeFetchError(error, url), { cause: error })
  }

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
    // Sanitize: avoid leaking API key from error messages if it appears in the body
    let detail = body.length <= 500 ? body : `${body.slice(0, 500)}... [truncated]`
    detail = detail.replace(new RegExp(escapeRegExp(apiKey), 'g'), '***')

    // Bing reports throttling as a 400 with the condition in the body, so the
    // status alone cannot tell a throttle from a bad request. Pull out its
    // ErrorCode and let BingApiError classify it.
    const bingErrorCode = parseBingErrorCode(body)
    const err = new BingApiError(`Bing API error (${res.status}): ${detail}`, res.status, bingErrorCode)
    bingClientLog('error', err.isThrottle ? 'http.throttled' : 'http.error', {
      endpoint,
      method,
      httpStatus: res.status,
      bingErrorCode,
    })
    throw err
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

/**
 * Per-key throttle cooldowns, keyed by a digest so the secret is never a Map
 * key. Module-level because the limit is on the ACCOUNT: every project, run,
 * and route on this instance shares one entry per credential.
 */
const throttleCooldownUntil = new Map<string, number>()

/** Injectable clock — tests move time instead of waiting ten minutes. */
let cooldownNow: () => number = () => Date.now()

function cooldownKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
}

function throttleCooldownRemainingMs(apiKey: string): number {
  const until = throttleCooldownUntil.get(cooldownKey(apiKey))
  if (until == null) return 0
  const remaining = until - cooldownNow()
  if (remaining <= 0) {
    throttleCooldownUntil.delete(cooldownKey(apiKey))
    return 0
  }
  return remaining
}

function openThrottleCooldown(apiKey: string): void {
  throttleCooldownUntil.set(cooldownKey(apiKey), cooldownNow() + BING_THROTTLE_COOLDOWN_MS)
  bingClientLog('error', 'http.cooldown-open', { cooldownMs: BING_THROTTLE_COOLDOWN_MS })
}

/** Test seam: reset cooldown state and optionally pin the clock. */
export function __resetBingThrottleCooldownForTest(now?: () => number): void {
  throttleCooldownUntil.clear()
  cooldownNow = now ?? (() => Date.now())
}

/**
 * Every Bing call goes through here, so retry is the default rather than
 * something each call site remembers.
 *
 * Bing throttles per host and per API key, and a host limit is shared by every
 * project on the instance — so a refresh that inspects a few dozen URLs will
 * hit it no matter how careful one project is. Without backoff those calls
 * simply failed: a live instance logged 229 throttle failures in three days,
 * the first ten calls succeeding and the rest giving up immediately.
 *
 * `isRetryableHttpError` recognizes the throttle through `BingApiError`, which
 * carries Bing's own ErrorCode, and honours a `Retry-After` when one is sent.
 * Auth, validation, and not-found still fail on the first attempt.
 *
 * **What is retried depends on the method**, because not every Bing call is
 * safe to replay. `SubmitUrl` / `SubmitUrlBatch` spend a daily quota
 * (`BING_SUBMIT_URL_DAILY_LIMIT`) and `AddSite` mutates the account:
 *
 *   - A **throttle** is retried on any method. Bing rejects a throttled request
 *     at the gate rather than acting on it, so a repeat cannot double-submit.
 *     This is the case the retry exists for.
 *   - A **5xx or network failure** is retried only on GET. Those are ambiguous
 *     — the request may have been processed and the response lost — so
 *     replaying a POST could submit the same URLs twice and burn quota that
 *     cannot be reclaimed. A read costs nothing to repeat.
 */
async function bingFetch<T>(apiKey: string, endpoint: string, opts?: { method?: string; body?: unknown; idempotent?: boolean }): Promise<T> {
  // A few Bing reads only accept POST (`GetChildrenUrlInfo`); they pass
  // `idempotent: true` so a 5xx is retried like any other read.
  const isIdempotent = opts?.idempotent ?? (opts?.method ?? 'GET') === 'GET'

  const cooling = throttleCooldownRemainingMs(apiKey)
  if (cooling > 0) {
    bingClientLog('warn', 'http.cooldown-skip', { endpoint, remainingMs: cooling })
    throw new BingApiError(
      `Bing API key is in a throttle cooldown for another ${Math.ceil(cooling / 1000)}s; ` +
        'the account was still throttled after a full retry budget, so this call was not attempted.',
      429,
    )
  }

  try {
    return await withRetry(() => bingFetchOnce<T>(apiKey, endpoint, opts), {
      maxRetries: BING_MAX_RETRIES,
      baseDelayMs: BING_RETRY_BASE_DELAY_MS,
      maxDelayMs: BING_RETRY_MAX_DELAY_MS,
      isRetryable: (err) => {
        if (err instanceof BingApiError && err.isThrottle) return true
        return isIdempotent && isRetryableHttpError(err)
      },
      computeDelayMs: (_attempt, err, defaultMs) => retryAfterDelayMs(err) ?? defaultMs,
      onRetry: ({ attempt, err, delayMs }) => {
        bingClientLog('warn', 'http.retry', {
          endpoint,
          attempt,
          delayMs: Math.round(delayMs),
          throttled: err instanceof BingApiError ? err.isThrottle : false,
        })
      },
    })
  } catch (err) {
    // Still throttled after every retry: that is a statement about the ACCOUNT,
    // not about this URL. Continuing to call is what keeps the limit asserted,
    // so the key goes quiet for a while and every caller fails fast meanwhile.
    if (err instanceof BingApiError && err.isThrottle) openThrottleCooldown(apiKey)
    throw err
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

// ── Reads added for full API coverage ─────────────────────────────────────
//
// Every shape below was taken from a captured live response (see the test
// fixtures). Bing returns `{"d": ...}`; `bingFetch` unwraps it. List reads
// normalise a missing body to `[]` so callers never branch on `undefined`.

function query(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
}

async function siteList<T>(apiKey: string, method: string, siteUrl: string, extra: Record<string, string | number | boolean> = {}): Promise<T[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  const data = await bingFetch<T[]>(apiKey, `${method}?${query({ siteUrl, ...extra })}`)
  return data ?? []
}

async function siteObject<T>(apiKey: string, method: string, siteUrl: string, extra: Record<string, string | number | boolean> = {}): Promise<T> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  return bingFetch<T>(apiKey, `${method}?${query({ siteUrl, ...extra })}`)
}

function validateText(value: string, label: string): void {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new BingApiError(`${label} is required and must be a non-empty string`, 400)
  }
}

function validatePage(page: number): void {
  if (!Number.isInteger(page) || page < 0) {
    throw new BingApiError('page must be a non-negative integer', 400)
  }
}

/** Daily site clicks and impressions (`GetRankAndTrafficStats`), about six months back. */
export async function getRankAndTrafficStats(apiKey: string, siteUrl: string): Promise<BingRankAndTrafficStats[]> {
  return siteList<BingRankAndTrafficStats>(apiKey, 'GetRankAndTrafficStats', siteUrl)
}

/** Weekly stats per search query (`GetQueryStats`). */
export async function getQueryStats(apiKey: string, siteUrl: string): Promise<BingQueryStats[]> {
  return siteList<BingQueryStats>(apiKey, 'GetQueryStats', siteUrl)
}

/** Weekly stats per page (`GetPageStats`). Bing puts the page URL in `Query`. */
export async function getPageStats(apiKey: string, siteUrl: string): Promise<BingQueryStats[]> {
  return siteList<BingQueryStats>(apiKey, 'GetPageStats', siteUrl)
}

/** Pages that showed for one query (`GetQueryPageStats`). Bing puts the page URL in `Query`. */
export async function getQueryPageStats(apiKey: string, siteUrl: string, searchQuery: string): Promise<BingQueryStats[]> {
  validateText(searchQuery, 'query')
  return siteList<BingQueryStats>(apiKey, 'GetQueryPageStats', siteUrl, { query: searchQuery })
}

/** Queries one page showed for (`GetPageQueryStats`). */
export async function getPageQueryStats(apiKey: string, siteUrl: string, page: string): Promise<BingQueryStats[]> {
  validateUrl(page)
  return siteList<BingQueryStats>(apiKey, 'GetPageQueryStats', siteUrl, { page })
}

/** Daily clicks and impressions for one query (`GetQueryTrafficStats`). */
export async function getQueryTrafficStats(apiKey: string, siteUrl: string, searchQuery: string): Promise<BingRankAndTrafficStats[]> {
  validateText(searchQuery, 'query')
  return siteList<BingRankAndTrafficStats>(apiKey, 'GetQueryTrafficStats', siteUrl, { query: searchQuery })
}

/** Weekly clicks, impressions and position for one query on one page (`GetQueryPageDetailStats`). */
export async function getQueryPageDetailStats(apiKey: string, siteUrl: string, searchQuery: string, page: string): Promise<BingDetailedQueryStats[]> {
  validateText(searchQuery, 'query')
  validateUrl(page)
  return siteList<BingDetailedQueryStats>(apiKey, 'GetQueryPageDetailStats', siteUrl, { query: searchQuery, page })
}

/** Clicks and impressions for one URL (`GetUrlTrafficInfo`). */
export async function getUrlTrafficInfo(apiKey: string, siteUrl: string, url: string): Promise<BingUrlTrafficInfo> {
  validateUrl(url)
  return siteObject<BingUrlTrafficInfo>(apiKey, 'GetUrlTrafficInfo', siteUrl, { url })
}

/** Clicks and impressions for the URLs under a directory (`GetChildrenUrlTrafficInfo`), 0-indexed pages. */
export async function getChildrenUrlTrafficInfo(apiKey: string, siteUrl: string, url: string, page = 0): Promise<BingUrlTrafficInfo[]> {
  validateUrl(url)
  validatePage(page)
  return siteList<BingUrlTrafficInfo>(apiKey, 'GetChildrenUrlTrafficInfo', siteUrl, { url, page })
}

/** Index details for the URLs under a directory (`GetChildrenUrlInfo`). Bing only accepts this as a POST. */
export async function getChildrenUrlInfo(
  apiKey: string,
  siteUrl: string,
  url: string,
  page = 0,
  filterProperties: BingUrlFilterProperties = { CrawlDateFilter: 0, DiscoveredDateFilter: 0, DocFlagsFilters: 0, HttpCodeFilters: 0 },
): Promise<BingUrlInfo[]> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrl(url)
  validatePage(page)
  // A read sent as POST: safe to retry, so it is not marked as a write.
  const data = await bingFetch<BingUrlInfo[]>(apiKey, 'GetChildrenUrlInfo', {
    method: 'POST',
    body: { siteUrl, url, page, filterProperties },
    idempotent: true,
  })
  return data ?? []
}

/** Submitted sitemaps and feeds (`GetFeeds`). */
export async function getFeeds(apiKey: string, siteUrl: string): Promise<BingFeed[]> {
  return siteList<BingFeed>(apiKey, 'GetFeeds', siteUrl)
}

/**
 * Ask Bing to read a sitemap or feed (`SubmitFeed`). A sitemap Bing already
 * lists is simply read again; a new one is added to the site's list.
 */
export async function submitFeed(apiKey: string, siteUrl: string, feedUrl: string): Promise<void> {
  validateApiKey(apiKey)
  validateSiteUrl(siteUrl)
  validateUrl(feedUrl)
  await bingFetch<unknown>(apiKey, 'SubmitFeed', {
    method: 'POST',
    body: { siteUrl, feedUrl },
  })
}

/** Details for one sitemap, or the children of a sitemap index (`GetFeedDetails`). */
export async function getFeedDetails(apiKey: string, siteUrl: string, feedUrl: string): Promise<BingFeed[]> {
  validateUrl(feedUrl)
  return siteList<BingFeed>(apiKey, 'GetFeedDetails', siteUrl, { feedUrl })
}

/** URL submissions left today and this month (`GetUrlSubmissionQuota`). */
export async function getUrlSubmissionQuota(apiKey: string, siteUrl: string): Promise<BingSubmissionQuota> {
  return siteObject<BingSubmissionQuota>(apiKey, 'GetUrlSubmissionQuota', siteUrl)
}

/** Content submissions left today and this month (`GetContentSubmissionQuota`). */
export async function getContentSubmissionQuota(apiKey: string, siteUrl: string): Promise<BingSubmissionQuota> {
  return siteObject<BingSubmissionQuota>(apiKey, 'GetContentSubmissionQuota', siteUrl)
}

export async function getCrawlSettings(apiKey: string, siteUrl: string): Promise<BingCrawlSettings> {
  return siteObject<BingCrawlSettings>(apiKey, 'GetCrawlSettings', siteUrl)
}

/** Pages and directories blocked from Bing results (`GetBlockedUrls`). */
export async function getBlockedUrls(apiKey: string, siteUrl: string): Promise<BingBlockedUrl[]> {
  return siteList<BingBlockedUrl>(apiKey, 'GetBlockedUrls', siteUrl)
}

/** URL normalization parameters (`GetQueryParameters`). */
export async function getQueryParameters(apiKey: string, siteUrl: string): Promise<BingQueryParameter[]> {
  return siteList<BingQueryParameter>(apiKey, 'GetQueryParameters', siteUrl)
}

/** Geo-targeting settings (`GetCountryRegionSettings`). */
export async function getCountryRegionSettings(apiKey: string, siteUrl: string): Promise<BingCountryRegionSettings[]> {
  return siteList<BingCountryRegionSettings>(apiKey, 'GetCountryRegionSettings', siteUrl)
}

/** Blocked sitelinks (`GetDeepLinkBlocks`). Bing documents no element contract, so rows stay as returned. */
export async function getDeepLinkBlocks(apiKey: string, siteUrl: string): Promise<Array<Record<string, unknown>>> {
  return siteList<Record<string, unknown>>(apiKey, 'GetDeepLinkBlocks', siteUrl)
}

/** Pages whose result preview is blocked (`GetActivePagePreviewBlocks`). Rows stay as returned. */
export async function getActivePagePreviewBlocks(apiKey: string, siteUrl: string): Promise<Array<Record<string, unknown>>> {
  return siteList<Record<string, unknown>>(apiKey, 'GetActivePagePreviewBlocks', siteUrl)
}

/** Pages registered as linking to the site (`GetConnectedPages`). Needs an owner-level key. */
export async function getConnectedPages(apiKey: string, siteUrl: string): Promise<Array<Record<string, unknown>>> {
  return siteList<Record<string, unknown>>(apiKey, 'GetConnectedPages', siteUrl)
}

/** Users with access to the site (`GetSiteRoles`). Needs an owner-level key. */
export async function getSiteRoles(apiKey: string, siteUrl: string, includeAllSubdomains = false): Promise<BingSiteRole[]> {
  return siteList<BingSiteRole>(apiKey, 'GetSiteRoles', siteUrl, { includeAllSubdomains })
}

/** Fetch as Bingbot history (`GetFetchedUrls`). */
export async function getFetchedUrls(apiKey: string, siteUrl: string): Promise<BingFetchedUrl[]> {
  return siteList<BingFetchedUrl>(apiKey, 'GetFetchedUrls', siteUrl)
}

/** What Bingbot received for one fetched URL (`GetFetchedUrlDetails`). */
export async function getFetchedUrlDetails(apiKey: string, siteUrl: string, url: string): Promise<BingFetchedUrlDetails> {
  validateUrl(url)
  return siteObject<BingFetchedUrlDetails>(apiKey, 'GetFetchedUrlDetails', siteUrl, { url })
}

/** Pages on the site with inbound links (`GetLinkCounts`), one 0-indexed page of results. */
export async function getLinkCounts(apiKey: string, siteUrl: string, page = 0): Promise<BingLinkCounts> {
  validatePage(page)
  const data = await siteObject<BingLinkCounts | undefined>(apiKey, 'GetLinkCounts', siteUrl, { page })
  return { Links: data?.Links ?? [], TotalPages: data?.TotalPages ?? 0 }
}

/** Inbound links to one page (`GetUrlLinks`), one 0-indexed page of results. */
export async function getUrlLinks(apiKey: string, siteUrl: string, link: string, page = 0): Promise<BingLinkDetails> {
  validateUrl(link)
  validatePage(page)
  const data = await siteObject<BingLinkDetails | undefined>(apiKey, 'GetUrlLinks', siteUrl, { link, page })
  return { Details: data?.Details ?? [], TotalPages: data?.TotalPages ?? 0 }
}

export interface BingKeywordMarket {
  /** Two-letter market country, lowercase as Bing takes it (`us`). */
  country: string
  /** Market language tag (`en-US`). */
  language: string
}

function validateMarket(market: BingKeywordMarket): void {
  validateText(market.country, 'country')
  validateText(market.language, 'language')
}

function validateDay(day: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new BingApiError(`${label} must be a YYYY-MM-DD date`, 400)
  }
}

/** Bing search volume for one keyword over a date range (`GetKeyword`). Not tied to a site. */
export async function getKeyword(apiKey: string, keyword: string, market: BingKeywordMarket, startDate: string, endDate: string): Promise<BingKeyword | null> {
  validateApiKey(apiKey)
  validateText(keyword, 'keyword')
  validateMarket(market)
  validateDay(startDate, 'startDate')
  validateDay(endDate, 'endDate')
  const data = await bingFetch<BingKeyword | undefined>(apiKey, `GetKeyword?${query({ q: keyword, country: market.country, language: market.language, startDate, endDate })}`)
  return data ?? null
}

/** Weekly Bing search volume history for one keyword (`GetKeywordStats`). Not tied to a site. */
export async function getKeywordHistory(apiKey: string, keyword: string, market: BingKeywordMarket): Promise<BingKeywordHistory[]> {
  validateApiKey(apiKey)
  validateText(keyword, 'keyword')
  validateMarket(market)
  const data = await bingFetch<BingKeywordHistory[]>(apiKey, `GetKeywordStats?${query({ q: keyword, country: market.country, language: market.language })}`)
  return data ?? []
}

/** Related keywords with their Bing search volume (`GetRelatedKeywords`). Not tied to a site. */
export async function getRelatedKeywords(apiKey: string, keyword: string, market: BingKeywordMarket, startDate: string, endDate: string): Promise<BingKeyword[]> {
  validateApiKey(apiKey)
  validateText(keyword, 'keyword')
  validateMarket(market)
  validateDay(startDate, 'startDate')
  validateDay(endDate, 'endDate')
  const data = await bingFetch<BingKeyword[]>(apiKey, `GetRelatedKeywords?${query({ q: keyword, country: market.country, language: market.language, startDate, endDate })}`)
  return data ?? []
}

/**
 * Convert a WCF JSON date (`/Date(ms)/`, `/Date(ms-0700)/`) to ISO 8601.
 * Null for a missing value and for Bing's "never" sentinel (any value <= 0).
 */
export function parseBingDate(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /\/Date\((-?\d+)(?:[-+]\d+)?\)\//.exec(value)
  if (!match) return null
  const ms = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

/**
 * The calendar day of a Bing stats row. Bing stamps daily and weekly rows at
 * UTC midnight (some contracts at Pacific midnight, still the same UTC day),
 * so the UTC date of the instant is the day Bing meant.
 */
export function bingDateToDay(value: string | null | undefined): string | null {
  const iso = parseBingDate(value)
  return iso ? iso.slice(0, 10) : null
}


/**
 * The Bing keyword-research market for a project's stored country and
 * language: Bing takes a lowercase country (`us`) and a full language tag
 * (`en-US`). A language that is already a tag is kept as is.
 */
export function bingKeywordMarket(country: string, language: string): BingKeywordMarket {
  const cc = (country || 'US').trim()
  const lang = (language || 'en').trim()
  return {
    country: cc.toLowerCase(),
    language: lang.includes('-') ? lang : `${lang.toLowerCase()}-${cc.toUpperCase()}`,
  }
}

/**
 * Bing sends `-1` (and sometimes `0`) for "no position". A real position is
 * a positive number; everything else reads as no value.
 */
export function bingPositionOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Whether a crawl issue keeps a URL out of Bing results. `IssueType` is a
 * space-separated list of flag names; anything other than None / SeoIssues /
 * SeoConcerns blocks serving, and a missing value is treated as blocking.
 */
export function isBlockingCrawlIssue(issueType: string | null | undefined): boolean {
  if (!issueType) return true
  const trimmed = issueType.trim()
  if (!trimmed) return true
  return trimmed.split(/\s+/).some((flag) => !/^(?:None|Seo(?:Issues|Concerns))$/i.test(flag))
}

