import { describe, expect, it } from 'vitest'
import { seoDatasetWithoutVendor, seoKeywordGapComparison, seoProfileInputSchema, seoQuoteSchema, seoSearchTextForQuery, seoSyncInputSchema } from '../src/seo.js'

describe('SEO public admission contracts', () => {
  it('requires bounded explicit profile scope and rejects upstream options that could expand spend', () => {
    const input = {
      name: 'Organic research', connectionId: 'primary', capabilities: ['keyword-metrics'],
      targets: [], keywords: ['coffee'], locationCode: 2840, languageCode: 'en', limit: 100,
      scope: { kind: 'property', key: 'store', expectedPlanRevision: 3 },
    }
    expect(seoProfileInputSchema.parse(input).scope).toEqual({ kind: 'property', key: 'store', expectedPlanRevision: 3 })
    expect(seoProfileInputSchema.safeParse({ ...input, includeClickstreamData: true }).success).toBe(false)
    expect(seoProfileInputSchema.safeParse({ ...input, limit: 1001 }).success).toBe(false)
    expect(seoProfileInputSchema.safeParse({ ...input, locationCode: undefined }).success).toBe(false)
    expect(seoProfileInputSchema.safeParse({ ...input, competitors: Array.from({ length: 6 }, (_, index) => ({ kind: 'domain', value: `rival${index}.com`, includeSubdomains: true })) }).success).toBe(false)
  })

  it('has no customer-controlled funding claims in either the intent or submission', () => {
    const quote = {
      token: 'opaque', expiresAt: '2026-10-22T18:00:00Z', profileId: 'p', profileRevision: 1,
      taskCount: 1, targets: [], capabilities: ['keyword-metrics'], availability: 'ready', reason: null,
    }
    expect(seoQuoteSchema.safeParse(quote).success).toBe(true)
    expect(seoQuoteSchema.safeParse({ ...quote, maxCostMicros: 123 }).success).toBe(false)
    expect(seoSyncInputSchema.safeParse({ quoteToken: 'opaque', idempotencyKey: 'stable', fundingMode: 'hosted' }).success).toBe(false)
  })
})

describe('organic keyword comparison', () => {
  it.each([
    [12, 3, 'outranked', 9],
    [3, 12, 'shared', -9],
    [1, 1, 'shared', 0],
    [null, 100, 'missing', null],
  ] as const)('compares target %s with competitor %s without inventing an absent rank', (target, competitor, kind, rankGap) => {
    expect(seoKeywordGapComparison(target, competitor)).toEqual({ kind, rankGap })
  })
})

describe('seoDatasetWithoutVendor', () => {
  it.each([
    // Stored ids as the DataForSEO adapter writes them, hyphen and underscore forms.
    ['dataforseo-labs/google/ranked-keywords', 'google/ranked-keywords'],
    ['dataforseo_labs/google/ranked_keywords', 'google/ranked_keywords'],
    ['DataForSEO/google/domain-intelligence', 'google/domain-intelligence'],
    // Already vendor-free, and a segment that only contains the name, stay as they are.
    ['google/keyword-metrics', 'google/keyword-metrics'],
    ['google/notdataforseo-labs', 'google/notdataforseo-labs'],
  ])('%s -> %s', (stored, shown) => {
    expect(seoDatasetWithoutVendor(stored)).toBe(shown)
  })
})

describe('seoSearchTextForQuery', () => {
  it.each([
    // The trailing region repeats the market label's region, so it is dropped, ignoring case and spacing.
    ['best apartments in Dallas, Dallas-Fort Worth', 'Dallas, Dallas-Fort Worth', 'query-without-market-region', 'best apartments in Dallas'],
    ['pet friendly  apartments Denver,   denver', 'Denver, Denver', 'query-without-market-region', 'pet friendly apartments Denver'],
    // Anything else is the tracked query as written.
    ['best apartments in Dallas, Texas', 'Dallas, Dallas-Fort Worth', 'query-without-market-region', 'best apartments in Dallas, Texas'],
    ['apartments in Fort Worth', 'Dallas, Dallas-Fort Worth', 'query-without-market-region', 'apartments in Fort Worth'],
    ['best apartments in Plano, Plano', 'Plano', 'query-without-market-region', 'best apartments in Plano, Plano'],
    [', Plano', 'Downtown, Plano', 'query-without-market-region', ', Plano'],
    ['best apartments in Dallas, Dallas-Fort Worth', 'Dallas, Dallas-Fort Worth', 'query', 'best apartments in Dallas, Dallas-Fort Worth'],
    ['best apartments in Dallas, Dallas-Fort Worth', null, 'query-without-market-region', 'best apartments in Dallas, Dallas-Fort Worth'],
  ] as const)('%s in %s (%s) is searched as %s', (query, market, rule, searched) => {
    expect(seoSearchTextForQuery(query, market, rule)).toBe(searched)
  })

  it('accepts market-rankings settings only in steps of 10 results with a known device', () => {
    const input = {
      name: 'Market rankings', connectionId: 'primary', capabilities: ['market-rankings'], targets: [], keywords: [],
      locationCode: 2840, languageCode: 'en', limit: 100, scope: { kind: 'project' },
      rankings: { locations: [{ key: 'metro', locationCode: 200623, label: 'Dallas-Ft. Worth, TX' }], depth: 50, device: 'mobile', searchText: 'query' },
    }
    expect(seoProfileInputSchema.parse(input).rankings).toEqual(input.rankings)
    for (const rankings of [{ ...input.rankings, depth: 55 }, { ...input.rankings, depth: 110 }, { ...input.rankings, device: 'tablet' }, { ...input.rankings, searchText: 'keyword' }]) {
      expect(seoProfileInputSchema.safeParse({ ...input, rankings }).success).toBe(false)
    }
  })
})
