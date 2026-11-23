import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeoAdapterOutcomes, SeoCapabilities, SeoTargetKinds, type SeoAdapterRequest, type SeoMarketRankingContext } from '@canonry/canonry-contracts'
import { createCloroSeoAdapter } from '../src/index.js'

// Redacted shape of a live `POST /v1/monitor/google` answer (mobile, 2 pages), checked 2026-11-18.
// On mobile most links come back empty, with Google's `/goto` redirect beside them.
const credentials = { apiKey: 'private-key', creditMicros: 800 }
const domain = { kind: SeoTargetKinds.domain, value: 'example.com', includeSubdomains: true }
const market = (marketKey: string, queryId: string): SeoMarketRankingContext => ({ marketKey, marketLabel: `${marketKey}, Dallas`, regionKey: 'dallas', regionLabel: 'Dallas', queryId, queryText: 'best apartments in Dallas', queryClass: 'non-brand' })
const request: SeoAdapterRequest = {
  capability: SeoCapabilities['market-rankings'], target: domain, keywords: ['best apartments in Dallas'],
  locationCode: 1026339, languageCode: 'en', limit: 100, tag: 'local-task-1',
  // Two markets share this search but track different rivals.
  search: { device: 'mobile', depth: 20, locationLabel: 'Dallas, Texas, United States', markets: [
    { context: market('uptown', 'q1'), competitors: ['rival.com'] },
    { context: market('downtown', 'q2'), competitors: ['downtown-rival.com', 'rival.com'] },
  ] },
}
const redirect = 'https://www.google.com/goto?url=CAES&gsessionid=x'
const organic = [
  { position: 1, page: 1, link: null, displayedLink: '', redirectLink: redirect, title: 'Forum thread' },
  { position: 2, page: 1, link: null, displayedLink: 'https://www.rival.com', redirectLink: redirect },
  { position: 3, page: 1, link: 'https://www.downtown-rival.com/dallas', displayedLink: 'https://www.downtown-rival.com' },
  { position: 5, page: 1, link: redirect, displayedLink: 'https://www.example.com › dallas' },
  { position: 12, page: 2, link: 'https://blog.example.com/best-dallas', displayedLink: 'https://blog.example.com' },
  { position: 14, page: 2, link: 'https://rival.com/again', displayedLink: 'https://rival.com' },
]
function answer(results: unknown[] | null, headers: Record<string, string> = { 'X-Credits-Charged': '7', 'X-Request-ID': 'request-1' }, status = 200): Response {
  return Response.json({ success: true, result: { organicResults: results } }, { status, headers })
}
const page = 'https://www.example.com/dallas/best'
function resolvedTo(url: string, status = 200): Response {
  return status === 200
    ? Response.json({ url }, { headers: { 'X-Credits-Charged': '0', 'X-Request-ID': 'goto-1' } })
    : new Response('{}', { status })
}
/** Answers the search with `search` and each `/goto` lookup with `goto`. */
function cloro(search: () => Response, goto: () => Response | Promise<Response> = () => resolvedTo(page)) {
  return vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/goto') ? goto() : search()))
}
afterEach(() => { vi.unstubAllGlobals() })

describe('cloro market rankings', () => {
  it('prices a sync search per page of 10 results and never calls cloro to estimate', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createCloroSeoAdapter(credentials)
    // 3 credits for page 1, 2 for each further page, 2 for sync, 1 for a redirect lookup: 6, 8 and 24 credits.
    expect(adapter.estimate({ ...request, search: { ...request.search!, depth: 10 } })).toEqual({ maxCostMicros: 4_800, catalogRevision: 'cloro-google-sync-2026-11-18' })
    expect(adapter.estimate(request).maxCostMicros).toBe(6_400)
    expect(adapter.estimate({ ...request, search: { ...request.search!, depth: 100 } }).maxCostMicros).toBe(19_200)
    expect(adapter.capabilities).toEqual([SeoCapabilities['market-rankings']])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('searches a city by its Google canonical name and a country by its criterion id', async () => {
    const fetchMock = cloro(() => answer(organic))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createCloroSeoAdapter(credentials)
    await adapter.execute(request)
    await adapter.execute({ ...request, locationCode: 2826, languageCode: 'en-GB', search: { ...request.search!, depth: 10, device: 'desktop', locationLabel: 'Location 2826' } })
    const searches = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => !url.endsWith('/goto'))
    const [url, init] = searches[0]!
    expect(url).toBe('https://api.cloro.dev/v1/monitor/google')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer private-key' })
    expect(JSON.parse(init.body as string)).toEqual({ query: 'best apartments in Dallas', country: 'US', location: 'Dallas,Texas,United States', hl: 'en', device: 'mobile', pages: 2 })
    expect(JSON.parse(searches[1]![1].body as string)).toEqual({ query: 'best apartments in Dallas', country: 'GB', hl: 'en-GB', device: 'desktop' })
  })

  it('refuses a location cloro cannot target before any paid call', () => {
    const adapter = createCloroSeoAdapter(credentials)
    for (const locationLabel of ['Dallas-Ft. Worth, TX', 'Dallas', 'Location 1026339']) {
      expect(() => adapter.estimate({ ...request, search: { ...request.search!, locationLabel } })).toThrow(/Google canonical name/)
    }
    expect(() => adapter.estimate({ ...request, capability: SeoCapabilities['keyword-metrics'] })).toThrow(/market rankings only/)
    expect(() => adapter.estimate({ ...request, search: { ...request.search!, depth: 25 } })).toThrow(/depth/)
    expect(() => adapter.estimate({ ...request, keywords: ['a', 'b'] })).toThrow(/one tracked query/)
  })

  it('reports the best organic position of the site and of each market\'s own rivals, and the charged credits', async () => {
    const fetchMock = cloro(() => answer(organic))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createCloroSeoAdapter(credentials).execute(request)
    expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.completed, error: null, tasks: [
      { remoteTaskId: 'request-1', statusCode: 200, costMicros: 5_600 },
      { remoteTaskId: 'goto-1', statusCode: 200, costMicros: 0 },
    ] })
    // Only the site's own redirect is resolved; rivals keep their domain only.
    const lookups = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.endsWith('/goto'))
    expect(lookups).toHaveLength(1)
    expect(lookups[0]![0]).toBe('https://api.cloro.dev/v1/monitor/google/goto')
    expect(JSON.parse(lookups[0]![1].body as string)).toEqual({ url: redirect })
    const expected = {
      searchText: 'best apartments in Dallas', locationLabel: 'Dallas, Texas, United States', target: domain, searchStatus: 'completed',
      // Position 5 hides its address behind a redirect: the site comes from the displayed link, the page from /goto.
      // cloro gives the organic position only, so the absolute rank stays empty.
      rankOrganic: 5, rankAbsolute: null, url: page, depth: 20,
      provenance: { provider: 'cloro', dataset: 'cloro-serp/google/market-rankings', engine: 'google', locationCode: 1026339, languageCode: 'en', device: 'mobile', sourceUpdatedAt: null },
    }
    expect(result.results.marketRankings).toMatchObject([
      { ...market('uptown', 'q1'), ...expected, competitors: [{ domain: 'rival.com', rankOrganic: 2 }] },
      { ...market('downtown', 'q2'), ...expected, competitors: [{ domain: 'rival.com', rankOrganic: 2 }, { domain: 'downtown-rival.com', rankOrganic: 3 }] },
    ])
  })

  it('keeps a direct link as the ranking page and reads an absent site as not ranked within the depth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(organic.filter(item => item.position !== 5))))
    const ranked = await createCloroSeoAdapter(credentials).execute(request)
    expect(ranked.results.marketRankings[0]).toMatchObject({ rankOrganic: 12, url: 'https://blog.example.com/best-dallas' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(organic.filter(item => !item.displayedLink.includes('example.com')))))
    const absent = await createCloroSeoAdapter(credentials).execute(request)
    expect(absent.outcome).toBe(SeoAdapterOutcomes.completed)
    expect(absent.results.marketRankings[0]).toMatchObject({ searchStatus: 'completed', rankOrganic: null, rankAbsolute: null, url: null, depth: 20 })
  })

  it('marks a search partial, with the depth it reached, when cloro returns fewer pages than asked', async () => {
    // A depth-20 search that came back with page 1 only: results 1 to 5 were checked, 6 to 20 were not.
    const firstPage = organic.filter(item => item.page === 1)
    vi.stubGlobal('fetch', cloro(() => answer(firstPage)))
    const found = await createCloroSeoAdapter(credentials).execute(request)
    expect(found).toMatchObject({ outcome: SeoAdapterOutcomes.partial, error: 'Some SEO provider results could not be collected.', tasks: [{ costMicros: 5_600 }, { costMicros: 0 }] })
    expect(found.results.marketRankings.map(row => [row.searchStatus, row.rankOrganic, row.depth])).toEqual([['partial', 5, 5], ['partial', 5, 5]])
    // Without the site on page 1, the row is not a top-20 miss: it checked 3 results only.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(firstPage.filter(item => item.position !== 5))))
    const missing = await createCloroSeoAdapter(credentials).execute(request)
    expect(missing.outcome).toBe(SeoAdapterOutcomes.partial)
    expect(missing.results.marketRankings[0]).toMatchObject({ searchStatus: 'partial', rankOrganic: null, url: null, depth: 3 })
  })

  it('gives the runner a deadline that covers a whole cloro search', () => {
    // Two 6-minute requests (the search and one redirect lookup) and two 30-second waits before retries.
    expect(createCloroSeoAdapter(credentials).requestTimeoutMs).toBe(780_000)
  })

  it('keeps the ranking when the redirect does not resolve, with the lookup on the receipts', async () => {
    for (const [goto, receipt] of [
      [() => resolvedTo('', 502), { statusCode: 502, costMicros: 0 }],
      [() => Promise.reject(new TypeError('socket hang up')), { statusCode: null, costMicros: null }],
      [() => resolvedTo(redirect), { statusCode: 200, costMicros: 0 }],
    ] as const) {
      vi.stubGlobal('fetch', cloro(() => answer(organic), goto))
      const result = await createCloroSeoAdapter(credentials).execute(request)
      expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.completed, tasks: [{ costMicros: 5_600 }, receipt] })
      expect(result.results.marketRankings[0]).toMatchObject({ rankOrganic: 5, url: null })
    }
  })

  it('fails a search that checked nothing but keeps the charge', async () => {
    for (const results of [null, [], [{ position: 1, link: null, displayedLink: '' }]]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(results)))
      const result = await createCloroSeoAdapter(credentials).execute(request)
      expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.failed, tasks: [{ costMicros: 5_600 }], results: { marketRankings: [] } })
      expect(result.retryable).toBeUndefined()
    }
  })

  it('records a refusal as free and retries only a throttle', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(answer(organic))
      .mockResolvedValueOnce(resolvedTo(page))
    vi.stubGlobal('fetch', fetchMock)
    expect((await createCloroSeoAdapter(credentials).execute(request)).outcome).toBe(SeoAdapterOutcomes.completed)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const status of [400, 401, 403, 500]) {
      const refused = vi.fn().mockResolvedValue(new Response('{"error":"private upstream text"}', { status }))
      vi.stubGlobal('fetch', refused)
      const result = await createCloroSeoAdapter(credentials).execute(request)
      expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.failed, error: 'SEO provider rejected the request.', tasks: [{ statusCode: status, costMicros: 0 }] })
      expect(refused).toHaveBeenCalledTimes(1)
    }
  })

  it('asks for reconciliation when the charge is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket hang up')))
    const lost = await createCloroSeoAdapter(credentials).execute(request)
    expect(lost).toMatchObject({ outcome: SeoAdapterOutcomes.unknown, tasks: [{ remoteTaskId: null, statusCode: null, costMicros: null }] })
    vi.stubGlobal('fetch', cloro(() => answer(organic, { 'X-Request-ID': 'request-2' })))
    const unpriced = await createCloroSeoAdapter(credentials).execute(request)
    expect(unpriced).toMatchObject({ outcome: SeoAdapterOutcomes.completed, tasks: [{ remoteTaskId: 'request-2', costMicros: null }, { remoteTaskId: 'goto-1', costMicros: 0 }] })
  })

  it('sends nothing when the refresh is cancelled first', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const result = await createCloroSeoAdapter(credentials).execute(request, { signal: controller.signal })
    expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.failed, tasks: [{ costMicros: 0 }] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keys the funding ledger to the API key without exposing it', () => {
    const first = createCloroSeoAdapter(credentials).accountKey
    expect(createCloroSeoAdapter({ ...credentials, apiKey: ' private-key ' }).accountKey).toBe(first)
    expect(createCloroSeoAdapter({ ...credentials, apiKey: 'other-key' }).accountKey).not.toBe(first)
    expect(first).not.toContain('private-key')
  })
})
