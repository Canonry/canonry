import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeoAdapterOutcomes, SeoCapabilities, SeoTargetKinds, type SeoAdapterRequest, type SeoMarketRankingContext } from '@canonry/canonry-contracts'
import { createDataForSeoAdapter } from '../src/index.js'

// Redacted shapes from the official v3 Google Labs keyword_overview,
// domain_rank_overview and ranked_keywords Live examples, checked 2026-10-22.
const credentials = { login: 'operator@example.com', password: 'private-password' }
const domain = { kind: SeoTargetKinds.domain, value: 'example.com', includeSubdomains: true }
const request: SeoAdapterRequest = {
  capability: SeoCapabilities['keyword-metrics'], target: null, keywords: ['coffee', 'tea'],
  locationCode: 2840, languageCode: 'en', limit: 100, tag: 'local-task-1',
}
const info = {
  keyword: 'coffee', keyword_info: {
    last_updated_time: '2026-09-15 10:00:00 +00:00', search_volume: 0, cpc: null,
    competition: 0, monthly_searches: [{ year: 2026, month: 8, search_volume: 0 }],
  },
  keyword_properties: { keyword_difficulty: 42, core_keyword: null },
  search_intent_info: { main_intent: 'informational' },
}
function response(tasks: unknown[], status = 20000): Response {
  return Response.json({ status_code: status, cost: 0.1, tasks })
}
function task(items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'remote-task', status_code: 20000, cost: 0.01224, result: [{ location_code: 2840, language_code: 'en', items }], ...extra }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('DataForSEO paid adapter boundary', () => {
  it('quotes the bounded request without network access and decodes zero separately from absent metrics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([task([info, { keyword: 'tea', keyword_info: null }])]))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createDataForSeoAdapter(credentials)
    expect(adapter.estimate(request).maxCostMicros).toBe(12_240)
    expect(adapter.estimate({ ...request, capability: SeoCapabilities['domain-intelligence'], target: domain }).maxCostMicros).toBe(12_120)
    expect(adapter.estimate({ ...request, capability: SeoCapabilities['ranked-keywords'], target: domain }).maxCostMicros).toBe(24_000)
    expect(fetchMock).not.toHaveBeenCalled()
    const result = await adapter.execute(request)
    expect(result.outcome).toBe(SeoAdapterOutcomes.completed)
    expect(result.tasks).toEqual([{ remoteTaskId: 'remote-task', statusCode: 20000, costMicros: 12_240 }])
    expect(result.results.keywordMetrics[0]).toMatchObject({
      keyword: 'coffee', searchVolume: 0, cpcUsd: null, adCompetition: 0, keywordDifficulty: 42,
      monthlySearches: [{ year: 2026, month: 8, searchVolume: 0 }],
      provenance: { sourceUpdatedAt: '2026-09-15 10:00:00 +00:00', device: 'unspecified' },
    })
    expect(result.results.keywordMetrics[1]).toMatchObject({ keyword: 'tea', searchVolume: null, adCompetition: null, keywordDifficulty: null })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual([{
      keywords: ['coffee', 'tea'], location_code: 2840, language_code: 'en', tag: 'local-task-1',
      include_clickstream_data: false, include_serp_info: true,
    }])
  })

  it('decodes organic domain metrics without inventing a source update timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([task([], {
      result: [{ target: 'example.com', location_code: 2840, language_code: 'en', items: [{
        location_code: 2840, language_code: 'en',
        metrics: { organic: { count: 20, etv: 120.5, estimated_paid_traffic_cost: 35.6, pos_1: 2, pos_2_3: 4, pos_4_10: 5, pos_11_20: 9 }, paid: { count: 1000 } },
      }] }],
    })])))
    const result = await createDataForSeoAdapter(credentials).execute({ ...request, capability: SeoCapabilities['domain-intelligence'], target: domain })
    expect(result.results.domainIntelligence[0]).toMatchObject({
      organicKeywords: 20, estimatedOrganicTraffic: 120.5, estimatedOrganicTrafficValueUsd: 35.6,
      top1: 2, top2To3: 4, top4To10: 5, top11To20: 9, provenance: { sourceUpdatedAt: null },
    })
  })

  it('preserves organic and absolute positions and constrains exact hosts before and after dispatch', async () => {
    const host = { kind: SeoTargetKinds.host, value: 'shop.example.com', includeSubdomains: false }
    const fetchMock = vi.fn().mockResolvedValue(response([task([], { result: [{
      target: 'example.com', location_code: 2840, language_code: 'en', items: [{
        keyword_data: info,
        ranked_serp_element: { last_updated_time: '2026-10-20 00:00:00 +00:00', serp_item: { type: 'organic', domain: host.value, url: 'https://shop.example.com/coffee', rank_group: 3, rank_absolute: 7, etv: 12.5 } },
      }],
    }] })]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute({ ...request, capability: SeoCapabilities['ranked-keywords'], target: host })
    expect(result.results.rankedKeywords[0]).toMatchObject({ rankOrganic: 3, rankAbsolute: 7, estimatedTraffic: 12.5 })
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)[0]).toMatchObject({
      target: 'example.com', item_types: ['organic'], filters: ['ranked_serp_element.serp_item.domain', '=', 'shop.example.com'], limit: 100,
    })
    expect(() => createDataForSeoAdapter(credentials).estimate({ ...request, capability: SeoCapabilities['domain-intelligence'], target: host })).toThrow('whole-domain')
  })

  it('does not retry successful siblings or substitute envelope cost for unknown task cost', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([
      task([info], { cost: null }), { id: 'rejected', status_code: 40202, cost: 0, result: null },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute(request)
    expect(result.outcome).toBe(SeoAdapterOutcomes.partial)
    expect(result.tasks.map(receipt => receipt.costMicros)).toEqual([null, 0])
    expect(result.results.keywordMetrics).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['lost response', () => Promise.reject(new Error('private-password'))],
    ['server failure', () => Promise.resolve(new Response('private-password', { status: 500 }))],
    ['invalid receipt', () => Promise.resolve(new Response('{bad-json', { status: 200 }))],
  ])('holds unknown cost after %s and never automatically resubmits', async (_label, fetchImpl) => {
    const fetchMock = vi.fn(fetchImpl)
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute(request)
    expect(result.outcome).toBe(SeoAdapterOutcomes.unknown)
    expect(result.tasks[0]?.costMicros).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('private-password')
  })

  it.each([
    ['HTTP throttle', () => new Response('', { status: 429, headers: { 'Retry-After': '2' } })],
    ['task throttle', () => response([{ id: null, status_code: 40202, cost: 0, result: null }])],
  ])('backs off and repeats only the confirmed unaccepted %s', async (_label, initial) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(initial()).mockResolvedValueOnce(response([task([info])]))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createDataForSeoAdapter(credentials).execute(request)
    await vi.runAllTimersAsync()
    expect((await pending).outcome).toBe(SeoAdapterOutcomes.completed)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry authentication rejection or validation failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createDataForSeoAdapter(credentials)
    expect((await adapter.execute(request)).tasks[0]?.costMicros).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(() => adapter.estimate({ ...request, keywords: Array.from({ length: 701 }, (_, i) => `keyword ${i}`) })).toThrow()
    expect(() => adapter.estimate({ ...request, keywords: ['one two three four five six seven eight nine ten eleven'] })).toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([402, 404])('treats documented HTTP %i request refusal as unaccepted without retrying', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute(request)
    expect(result.outcome).toBe(SeoAdapterOutcomes.failed)
    expect(result.tasks).toEqual([{ remoteTaskId: null, statusCode: status, costMicros: 0 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [40200, 0, SeoAdapterOutcomes.failed, 0],
    [40501, 0, SeoAdapterOutcomes.failed, 0],
    [40200, null, SeoAdapterOutcomes.unknown, null],
    [40200, 0.01, SeoAdapterOutcomes.unknown, null],
    [50401, 0, SeoAdapterOutcomes.unknown, null],
  ])('requires explicit zero cost and a request refusal for no-task status %i with cost %s', async (statusCode, cost, outcome, costMicros) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status_code: statusCode, cost, tasks: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute(request)
    expect(result.outcome).toBe(outcome)
    expect(result.tasks).toEqual([{ remoteTaskId: null, statusCode, costMicros }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels a rejected request during backoff without another POST or an unknown charge', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '3600' } }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createDataForSeoAdapter(credentials).execute(request, { signal: controller.signal })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    const result = await pending
    expect(result.outcome).toBe(SeoAdapterOutcomes.failed)
    expect(result.tasks[0]?.costMicros).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a known charge when a changed or wrong-market payload cannot be decoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([task([], { result: [{ location_code: 2826, language_code: 'en', items: [info] }] })]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createDataForSeoAdapter(credentials).execute(request)
    expect(result.outcome).toBe(SeoAdapterOutcomes.failed)
    expect(result.tasks[0]?.costMicros).toBe(12_240)
    expect(result.results.keywordMetrics).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares funding identity across aliases and password rotation but not different accounts', () => {
    const first = createDataForSeoAdapter(credentials).accountKey
    expect(createDataForSeoAdapter({ login: ' OPERATOR@EXAMPLE.COM ', password: 'rotated' }).accountKey).toBe(first)
    expect(createDataForSeoAdapter({ login: 'another@example.com', password: credentials.password }).accountKey).not.toBe(first)
    expect(first).not.toContain(credentials.login)
  })
})

// Shape of a live v3 SERP Google Organic Live Advanced response (one results page per task), checked against a real call 2026-10-25.
describe('DataForSEO market rankings', () => {
  const market = (marketKey: string, queryId: string): SeoMarketRankingContext => ({ marketKey, marketLabel: `${marketKey}, Metro`, regionKey: 'metro', regionLabel: 'Metro Area', queryId, queryText: 'best apartments in Harbor, Metro', queryClass: 'non-brand' })
  const ranking: SeoAdapterRequest = {
    capability: SeoCapabilities['market-rankings'], target: domain, keywords: ['best apartments in Harbor'], locationCode: 200623, languageCode: 'en', limit: 100, tag: 'local-task-2',
    // Two markets share this search but track different rivals: downtown's query also has a pinned one.
    search: { device: 'mobile', depth: 50, locationLabel: 'Harbor, TX', markets: [
      { context: market('harbor', 'q1'), competitors: ['rival.com'] },
      { context: market('downtown', 'q2'), competitors: ['downtown-rival.com', 'rival.com'] },
    ] },
  }
  const organic = (rank: number, absolute: number, host: string) => ({ type: 'organic', rank_group: rank, rank_absolute: absolute, domain: host, url: `https://${host}/listing`, title: host })
  function serp(items: unknown[], extra: Record<string, unknown> = {}): Response {
    return response([{ id: 'serp-task', status_code: 20000, cost: 0.01, result: [{
      keyword: 'best apartments in harbor', type: 'organic', se_domain: 'google.com', location_code: 200623, language_code: 'en',
      check_url: 'https://www.google.com/search?q=best+apartments+in+harbor', datetime: '2026-10-25 17:10:11 +00:00', item_types: ['local_pack', 'organic'],
      se_results_count: 1_250_000, pages_count: 5, items_count: items.length, spell: null, refinement_chips: null, items, ...extra,
    }] }])
  }

  it('searches one tracked query from its market location and reports the site\'s best organic position for every market it answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(serp([
      // A map block is not an organic position, and its unusual fields must not reject the page.
      { type: 'local_pack', rank_group: 0, rank_absolute: 1, domain: 'example.com', title: 'Map results' },
      organic(2, 3, 'www.rival.com'), organic(4, 6, 'apartments.example.com'), organic(5, 8, 'www.downtown-rival.com'), organic(7, 10, 'www.example.com'),
      organic(8, 11, 'notexample.com'), organic(9, 12, 'listings.rival.com'),
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createDataForSeoAdapter(credentials)
    expect(adapter.estimate(ranking)).toEqual({ maxCostMicros: 10_000, catalogRevision: 'dataforseo-google-serp-live-2026-10-25' })
    expect(adapter.estimate({ ...ranking, search: { ...ranking.search!, depth: 10 } }).maxCostMicros).toBe(2_000)
    const result = await adapter.execute(ranking)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.dataforseo.com/v3/serp/google/organic/live/advanced')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual([{ keyword: 'best apartments in Harbor', location_code: 200623, language_code: 'en', device: 'mobile', depth: 50, tag: 'local-task-2' }])
    expect(result).toMatchObject({ outcome: SeoAdapterOutcomes.completed, tasks: [{ remoteTaskId: 'serp-task', statusCode: 20000, costMicros: 10_000 }] })
    // The map result and a lookalike domain are not the site's organic position; the subdomain is.
    const expected = {
      searchText: 'best apartments in Harbor', locationLabel: 'Harbor, TX', target: domain, rankOrganic: 4, rankAbsolute: 6, url: 'https://apartments.example.com/listing', depth: 50,
      provenance: { provider: 'dataforseo', dataset: 'dataforseo-serp/google/market-rankings', engine: 'google', locationCode: 200623, languageCode: 'en', device: 'mobile', sourceUpdatedAt: '2026-10-25 17:10:11 +00:00' },
    }
    // Each market reports only its own rivals, each at its best position on the page.
    expect(result.results.marketRankings).toMatchObject([
      { ...market('harbor', 'q1'), ...expected, competitors: [{ domain: 'rival.com', rankOrganic: 2 }] },
      { ...market('downtown', 'q2'), ...expected, competitors: [{ domain: 'rival.com', rankOrganic: 2 }, { domain: 'downtown-rival.com', rankOrganic: 5 }] },
    ])
  })

  it('reads a site outside the checked results as not ranked and keeps the charge for a page that answers another search', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serp([organic(1, 1, 'www.rival.com')])))
    const unranked = await createDataForSeoAdapter(credentials).execute(ranking)
    expect(unranked.results.marketRankings[0]).toMatchObject({ rankOrganic: null, rankAbsolute: null, url: null, competitors: [{ domain: 'rival.com', rankOrganic: 1 }] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serp([organic(3, 3, 'www.example.com')], { keyword: 'apartments in another city' })))
    const other = await createDataForSeoAdapter(credentials).execute(ranking)
    expect(other).toMatchObject({ outcome: SeoAdapterOutcomes.failed, tasks: [{ costMicros: 10_000 }], results: { marketRankings: [] } })
  })

  it.each([
    ['two search texts', { keywords: ['one', 'two'] }],
    ['a depth outside steps of 10', { search: { ...ranking.search!, depth: 55 } }],
    ['no markets', { search: { ...ranking.search!, markets: [] } }],
    ['no target', { target: null }],
  ])('refuses %s before any request', (_label, change) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(() => createDataForSeoAdapter(credentials).estimate({ ...ranking, ...change })).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
