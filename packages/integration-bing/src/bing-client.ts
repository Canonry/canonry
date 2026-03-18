import { BING_WMT_API_BASE, BING_SUBMIT_URL_BATCH_LIMIT } from './constants.js'
import type {
  BingSite,
  BingUrlInfo,
  BingKeywordStats,
  BingCrawlStats,
  BingCrawlIssue,
} from './types.js'
import { BingApiError } from './types.js'

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
  })

  if (res.status === 401 || res.status === 403) {
    throw new BingApiError('Bing API key is invalid or unauthorized', res.status)
  }

  if (res.status === 429) {
    throw new BingApiError('Bing API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    throw new BingApiError(`Bing API error (${res.status}): ${body}`, res.status)
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
  const data = await bingFetch<BingSite[]>(apiKey, 'GetUserSites')
  return data ?? []
}

export async function addSite(apiKey: string, siteUrl: string): Promise<void> {
  await bingFetch<unknown>(apiKey, 'AddSite', {
    method: 'POST',
    body: { siteUrl },
  })
}

export async function getUrlInfo(apiKey: string, siteUrl: string, url: string): Promise<BingUrlInfo> {
  const encodedSite = encodeURIComponent(siteUrl)
  const encodedUrl = encodeURIComponent(url)
  return bingFetch<BingUrlInfo>(apiKey, `GetUrlInfo?siteUrl=${encodedSite}&url=${encodedUrl}`)
}

export async function submitUrl(apiKey: string, siteUrl: string, url: string): Promise<void> {
  await bingFetch<unknown>(apiKey, 'SubmitUrl', {
    method: 'POST',
    body: { siteUrl, url },
  })
}

export async function submitUrlBatch(apiKey: string, siteUrl: string, urls: string[]): Promise<void> {
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
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingKeywordStats[]>(apiKey, `GetQueryStats?siteUrl=${encodedSite}`)
  return data ?? []
}

export async function getCrawlStats(apiKey: string, siteUrl: string): Promise<BingCrawlStats[]> {
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingCrawlStats[]>(apiKey, `GetCrawlStats?siteUrl=${encodedSite}`)
  return data ?? []
}

export async function getCrawlIssues(apiKey: string, siteUrl: string): Promise<BingCrawlIssue[]> {
  const encodedSite = encodeURIComponent(siteUrl)
  const data = await bingFetch<BingCrawlIssue[]>(apiKey, `GetCrawlIssues?siteUrl=${encodedSite}`)
  return data ?? []
}
