import { withRetry, isRetryableHttpError, retryAfterDelayMs, escapeRegExp } from '@ainyc/canonry-contracts'
import crypto from 'node:crypto'
import { BING_WMT_API_BASE, BING_SUBMIT_URL_BATCH_LIMIT, BING_SUBMIT_URL_DAILY_LIMIT, BING_REQUEST_TIMEOUT_MS, BING_MAX_RETRIES, BING_RETRY_BASE_DELAY_MS, BING_RETRY_MAX_DELAY_MS, BING_THROTTLE_COOLDOWN_MS } from './constants.js'
import type {
  BingSite,
  BingUrlInfo,
  BingKeywordStats,
  BingCrawlStats,
  BingCrawlIssue,
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
async function bingFetch<T>(apiKey: string, endpoint: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const isIdempotent = (opts?.method ?? 'GET') === 'GET'

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
