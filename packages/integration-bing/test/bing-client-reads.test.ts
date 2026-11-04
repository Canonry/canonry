import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetBingThrottleCooldownForTest,
  bingDateToDay,
  getActivePagePreviewBlocks,
  getBlockedUrls,
  getChildrenUrlInfo,
  getChildrenUrlTrafficInfo,
  getConnectedPages,
  getContentSubmissionQuota,
  getCountryRegionSettings,
  getCrawlSettings,
  getCrawlStats,
  getDeepLinkBlocks,
  getFeedDetails,
  getFeeds,
  getFetchedUrlDetails,
  getFetchedUrls,
  getKeyword,
  getKeywordHistory,
  getLinkCounts,
  getPageQueryStats,
  getPageStats,
  getQueryPageDetailStats,
  getQueryPageStats,
  getQueryParameters,
  getQueryStats,
  getQueryTrafficStats,
  getRankAndTrafficStats,
  getRelatedKeywords,
  getSiteRoles,
  getUrlLinks,
  getUrlSubmissionQuota,
  getUrlTrafficInfo,
  parseBingDate,
  submitFeed,
} from '../src/bing-client.js'
import { BingApiError } from '../src/types.js'
import { BING_WMT_API_BASE } from '../src/constants.js'

// Every fixture is a captured live Bing response (anonymised: hosts, queries
// and pages replaced, everything else byte-for-byte, `__type` included), so
// these tests pin the real field names rather than our own idea of them.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

const SITE = 'https://example.com/'
const KEY = 'test-key'

interface Captured { url: URL; method: string; body: unknown }

let originalFetch: typeof globalThis.fetch
let calls: Captured[]

function respondWith(body: string, status = 200): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
    })
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
}

function lastCall(): Captured {
  const call = calls.at(-1)
  if (!call) throw new Error('no Bing call was made')
  return call
}

beforeEach(() => {
  __resetBingThrottleCooldownForTest()
  originalFetch = globalThis.fetch
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('search performance reads', () => {
  it('reads daily site traffic from GetRankAndTrafficStats', async () => {
    respondWith(fixture('GetRankAndTrafficStats.json'))
    const rows = await getRankAndTrafficStats(KEY, SITE)
    expect(lastCall().url.pathname).toBe('/webmaster/api.svc/json/GetRankAndTrafficStats')
    expect(lastCall().url.searchParams.get('siteUrl')).toBe(SITE)
    expect(lastCall().url.searchParams.get('apikey')).toBe(KEY)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ Clicks: expect.any(Number), Impressions: expect.any(Number), Date: expect.stringMatching(/^\/Date\(/) })
  })

  it('reads weekly query rows (with their Date) from GetQueryStats', async () => {
    respondWith(fixture('GetQueryStats.json'))
    const rows = await getQueryStats(KEY, SITE)
    expect(String(lastCall().url)).toContain(`${BING_WMT_API_BASE}/GetQueryStats?siteUrl=`)
    expect(rows[0]).toMatchObject({ Query: 'example query 1', Clicks: 71, Impressions: 358, AvgImpressionPosition: 5, AvgClickPosition: -1 })
    expect(bingDateToDay(rows[0]!.Date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reads weekly page rows from GetPageStats, where Bing puts the page URL in Query', async () => {
    respondWith(fixture('GetPageStats.json'))
    const rows = await getPageStats(KEY, SITE)
    expect(lastCall().url.pathname).toMatch(/GetPageStats$/)
    expect(rows[0]!.Query).toMatch(/^https:\/\/example\.com\//)
  })

  it('sends the query parameter for GetQueryPageStats and returns page URLs', async () => {
    respondWith(fixture('GetQueryPageStats.json'))
    const rows = await getQueryPageStats(KEY, SITE, 'garage heaters')
    expect(lastCall().url.searchParams.get('query')).toBe('garage heaters')
    expect(rows[0]!.Query).toMatch(/^https:\/\/example\.com\//)
  })

  it('sends the page parameter for GetPageQueryStats', async () => {
    respondWith(fixture('GetPageQueryStats.json'))
    const rows = await getPageQueryStats(KEY, SITE, 'https://example.com/pricing/')
    expect(lastCall().url.searchParams.get('page')).toBe('https://example.com/pricing/')
    expect(rows[0]!.Query).toMatch(/^example query/)
  })

  it('reads daily rows for one query from GetQueryTrafficStats', async () => {
    respondWith(fixture('GetQueryTrafficStats.json'))
    const rows = await getQueryTrafficStats(KEY, SITE, 'garage heaters')
    expect(lastCall().url.searchParams.get('query')).toBe('garage heaters')
    expect(rows[0]).toMatchObject({ Impressions: 6, Clicks: 0 })
  })

  it('reads Position (not AvgImpressionPosition) from GetQueryPageDetailStats', async () => {
    respondWith(fixture('GetQueryPageDetailStats.json'))
    const rows = await getQueryPageDetailStats(KEY, SITE, 'garage heaters', 'https://example.com/')
    expect(lastCall().url.searchParams.get('query')).toBe('garage heaters')
    expect(lastCall().url.searchParams.get('page')).toBe('https://example.com/')
    expect(rows[0]).toMatchObject({ Clicks: 70, Impressions: 93, Position: 1 })
  })

  it('rejects an empty query before calling Bing', async () => {
    respondWith('{"d":[]}')
    await expect(getQueryTrafficStats(KEY, SITE, '  ')).rejects.toBeInstanceOf(BingApiError)
    expect(calls).toHaveLength(0)
  })
})

describe('crawl and index reads', () => {
  it('reads every crawl stats field Bing returns', async () => {
    respondWith(fixture('GetCrawlStats.json'))
    const rows = await getCrawlStats(KEY, SITE)
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining([
      'AllOtherCodes', 'BlockedByRobotsTxt', 'Code2xx', 'Code301', 'Code302', 'Code4xx', 'Code5xx',
      'ConnectionTimeout', 'ContainsMalware', 'CrawledPages', 'CrawlErrors', 'Date', 'DnsFailures', 'InIndex', 'InLinks',
    ]))
  })

  it('reads URL traffic for one URL and its children', async () => {
    respondWith(fixture('GetUrlTrafficInfo.json'))
    const info = await getUrlTrafficInfo(KEY, SITE, SITE)
    expect(info).toMatchObject({ Url: SITE, Clicks: 0, Impressions: 0, IsPage: true })

    respondWith(fixture('GetChildrenUrlTrafficInfo.json'))
    expect(await getChildrenUrlTrafficInfo(KEY, SITE, SITE, 2)).toEqual([])
    expect(lastCall().url.searchParams.get('page')).toBe('2')
  })

  it('sends GetChildrenUrlInfo as a POST with a filter body', async () => {
    respondWith(fixture('GetChildrenUrlInfo.json'))
    expect(await getChildrenUrlInfo(KEY, SITE, SITE)).toEqual([])
    expect(lastCall().method).toBe('POST')
    expect(lastCall().body).toEqual({
      siteUrl: SITE,
      url: SITE,
      page: 0,
      filterProperties: { CrawlDateFilter: 0, DiscoveredDateFilter: 0, DocFlagsFilters: 0, HttpCodeFilters: 0 },
    })
  })

  it('retries GetChildrenUrlInfo on a 5xx like any read', async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts += 1
      if (attempts === 1) return new Response('upstream', { status: 503 })
      return new Response('{"d":[]}', { status: 200 })
    }) as typeof globalThis.fetch
    __resetBingThrottleCooldownForTest()
    // withRetry waits between attempts; a single retry at the base delay is acceptable here.
    await expect(getChildrenUrlInfo(KEY, SITE, SITE)).resolves.toEqual([])
    expect(attempts).toBe(2)
  }, 15_000)

  it('reads sitemaps from GetFeeds and GetFeedDetails', async () => {
    respondWith(fixture('GetFeeds.json'))
    const feeds = await getFeeds(KEY, SITE)
    expect(feeds[0]).toMatchObject({ Type: 'Sitemap Index', Status: 'Success', UrlCount: 32, Compressed: false, FileSize: 0 })
    expect(parseBingDate(feeds[0]!.Submitted)).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    respondWith(fixture('GetFeedDetails.json'))
    await getFeedDetails(KEY, SITE, feeds[0]!.Url)
    expect(lastCall().url.searchParams.get('feedUrl')).toBe(feeds[0]!.Url)
  })

  it('reads a sitemap Bing found on its own as never submitted', async () => {
    // Bing stamps a sitemap nobody submitted with the Windows epoch (1601).
    respondWith(fixture('GetFeeds.discovered.json'))
    const feeds = await getFeeds(KEY, SITE)
    expect(feeds.map((feed) => [feed.Url, parseBingDate(feed.Submitted)])).toEqual([
      ['https://example.com/sitemap.xml', '2026-08-19T03:34:38.451Z'],
      ['https://www.example.com/sitemap.xml', null],
    ])
  })

  it('submits a sitemap with SubmitFeed', async () => {
    respondWith(fixture('SubmitFeed.json'))
    await expect(submitFeed(KEY, SITE, 'https://example.com/sitemap.xml')).resolves.toBeUndefined()
    expect(lastCall().method).toBe('POST')
    expect(lastCall().url.pathname.endsWith('/SubmitFeed')).toBe(true)
    expect(lastCall().body).toEqual({ siteUrl: SITE, feedUrl: 'https://example.com/sitemap.xml' })
    await expect(submitFeed(KEY, SITE, 'not a url')).rejects.toBeInstanceOf(BingApiError)
  })
})

describe('site settings reads', () => {
  it('reads both submission quotas', async () => {
    respondWith(fixture('GetUrlSubmissionQuota.json'))
    expect(await getUrlSubmissionQuota(KEY, SITE)).toMatchObject({ DailyQuota: 100, MonthlyQuota: 2700 })
    respondWith(fixture('GetContentSubmissionQuota.json'))
    expect(await getContentSubmissionQuota(KEY, SITE)).toMatchObject({ DailyQuota: 100, MonthlyQuota: 2700 })
  })

  it('reads crawl settings with 24 hourly crawl rates', async () => {
    respondWith(fixture('GetCrawlSettings.json'))
    const settings = await getCrawlSettings(KEY, SITE)
    expect(settings.CrawlRate).toHaveLength(24)
    expect(settings).toMatchObject({ CrawlBoostAvailable: false, CrawlBoostEnabled: false })
  })

  it.each([
    ['GetBlockedUrls', getBlockedUrls],
    ['GetQueryParameters', getQueryParameters],
    ['GetCountryRegionSettings', getCountryRegionSettings],
    ['GetDeepLinkBlocks', getDeepLinkBlocks],
    ['GetActivePagePreviewBlocks', getActivePagePreviewBlocks],
    ['GetFetchedUrls', getFetchedUrls],
  ] as const)('reads %s as a list', async (method, read) => {
    respondWith(fixture(`${method}.json`))
    expect(await read(KEY, SITE)).toEqual([])
    expect(lastCall().url.pathname).toBe(`/webmaster/api.svc/json/${method}`)
  })

  it('surfaces NotAuthorized from owner-only reads as a non-throttle BingApiError', async () => {
    respondWith(fixture('GetSiteRoles.error.json'), 400)
    const err = await getSiteRoles(KEY, SITE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BingApiError)
    expect((err as BingApiError).bingErrorCode).toBe(14)
    expect((err as BingApiError).isThrottle).toBe(false)
    expect(lastCall().url.searchParams.get('includeAllSubdomains')).toBe('false')

    respondWith(fixture('GetConnectedPages.error.json'), 400)
    await expect(getConnectedPages(KEY, SITE)).rejects.toMatchObject({ bingErrorCode: 14 })
  })

  it('sends the url for GetFetchedUrlDetails', async () => {
    respondWith('{"d":{"__type":"FetchedUrlDetails:#Microsoft.Bing.Webmaster.Api","Url":"https://example.com/"}}')
    const details = await getFetchedUrlDetails(KEY, SITE, SITE)
    expect(lastCall().url.searchParams.get('url')).toBe(SITE)
    expect(details.Url).toBe(SITE)
  })
})

describe('link reads', () => {
  it('normalises an empty link page', async () => {
    respondWith(fixture('GetLinkCounts.json'))
    expect(await getLinkCounts(KEY, SITE)).toEqual({ Links: [], TotalPages: 0 })
    expect(lastCall().url.searchParams.get('page')).toBe('0')

    respondWith(fixture('GetUrlLinks.json'))
    expect(await getUrlLinks(KEY, SITE, SITE, 1)).toEqual({ Details: [], TotalPages: 0 })
    expect(lastCall().url.searchParams.get('link')).toBe(SITE)
    expect(lastCall().url.searchParams.get('page')).toBe('1')
  })
})

describe('keyword research reads', () => {
  const market = { country: 'us', language: 'en-US' }

  it('reads search volume for a keyword over a date range', async () => {
    respondWith(fixture('GetKeyword.json'))
    const keyword = await getKeyword(KEY, 'standing desk', market, '2026-09-01', '2026-10-31')
    const params = lastCall().url.searchParams
    expect(params.get('q')).toBe('standing desk')
    expect(params.get('country')).toBe('us')
    expect(params.get('language')).toBe('en-US')
    expect(params.get('startDate')).toBe('2026-09-01')
    expect(params.get('endDate')).toBe('2026-10-31')
    expect(params.get('siteUrl')).toBeNull()
    expect(keyword).toMatchObject({ Query: 'standing desk', Impressions: 3829, BroadImpressions: 6355 })
  })

  it('reads weekly keyword history and related keywords', async () => {
    respondWith(fixture('GetKeywordStats.json'))
    const history = await getKeywordHistory(KEY, 'standing desk', market)
    expect(history[0]).toMatchObject({ Query: 'standing desk', BroadImpressions: expect.any(Number), Impressions: expect.any(Number) })

    respondWith(fixture('GetRelatedKeywords.json'))
    const related = await getRelatedKeywords(KEY, 'standing desk', market, '2026-09-01', '2026-10-31')
    expect(related.length).toBeGreaterThan(0)
    expect(related[0]).toHaveProperty('BroadImpressions')
  })

  it('rejects a malformed date before calling Bing', async () => {
    respondWith('{"d":null}')
    await expect(getKeyword(KEY, 'standing desk', market, '2026/09/01', '2026-10-31')).rejects.toBeInstanceOf(BingApiError)
    expect(calls).toHaveLength(0)
  })
})

describe('WCF date parsing', () => {
  it('handles plain, offset, and sentinel dates', () => {
    expect(parseBingDate('/Date(1774656000000)/')).toBe('2026-03-28T00:00:00.000Z')
    expect(parseBingDate('/Date(1773298800000-0700)/')).toBe('2026-03-12T07:00:00.000Z')
    expect(parseBingDate('/Date(-62135568000000)/')).toBeNull()
    expect(parseBingDate(null)).toBeNull()
    expect(bingDateToDay('/Date(1774656000000)/')).toBe('2026-03-28')
    expect(bingDateToDay('/Date(1773298800000-0700)/')).toBe('2026-03-12')
  })
})
