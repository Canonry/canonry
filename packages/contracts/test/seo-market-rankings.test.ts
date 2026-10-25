import { describe, expect, it } from 'vitest'
import {
  compareMarketRankingsBy, countMarketRankings, groupMarketRankings, marketRankingBands, marketRankingFromObservation,
  marketRankingWithoutResult, matchesMarketRankingFilter, matchesMarketRankingText,
} from '../src/seo-market-rankings.js'
import type { SeoMarketRankingCounts, SeoMarketRankingFilter, SeoMarketRankingObservation, SeoMarketRankingSort } from '../src/seo.js'

const target = { kind: 'domain' as const, value: 'example.com', includeSubdomains: true }
const provenance = { provider: 'dataforseo' as const, dataset: 'serp/market-rankings', engine: 'google' as const, locationCode: 1, languageCode: 'en', device: 'mobile' as const, collectedAt: '2026-10-25T00:00:00.000Z', sourceUpdatedAt: null }

/** One observation as the adapter stores it; market `m1` sits in region `r1` unless told otherwise. */
function observation(queryText: string, rankOrganic: number | null, overrides: Partial<SeoMarketRankingObservation> = {}): SeoMarketRankingObservation {
  return {
    marketKey: 'm1', marketLabel: 'Harbor, Coast', regionKey: 'r1', regionLabel: 'Coast Metro', queryId: queryText, queryText, queryClass: 'non-brand',
    searchText: queryText, locationLabel: 'Harbor, TX', target, rankOrganic, rankAbsolute: rankOrganic === null ? null : rankOrganic + 2,
    url: rankOrganic === null ? null : 'https://example.com/listing', depth: 50, competitors: [], provenance, ...overrides,
  }
}
const row = (queryText: string, rankOrganic: number | null, overrides: Partial<SeoMarketRankingObservation> = {}) => marketRankingFromObservation(observation(queryText, rankOrganic, overrides))
const failedRow = (queryText: string, status: 'failed' | 'not-run' = 'failed', marketKey = 'm1') => marketRankingWithoutResult({
  context: { marketKey, marketLabel: 'Harbor, Coast', regionKey: 'r1', regionLabel: 'Coast Metro', queryId: queryText, queryText, queryClass: 'non-brand' },
  searchText: queryText, locationLabel: 'Harbor, TX', target, depth: 50,
}, status)

describe('market-ranking rows', () => {
  it.each([
    [1, 'page-1'], [10, 'page-1'], [11, 'ranks-11-20'], [20, 'ranks-11-20'], [21, 'ranks-21-plus'], [50, 'ranks-21-plus'], [null, 'not-ranked'],
  ] as const)('reads Google rank %s as %s', (rank, outcome) => {
    expect(row('q', rank).outcome).toBe(outcome)
  })

  it.each([
    ['a rival above the site', 12, [{ domain: 'rival.com', rankOrganic: 3 }], true],
    ['a rival while the site is not in the results', null, [{ domain: 'rival.com', rankOrganic: 40 }], true],
    ['only rivals below the site', 3, [{ domain: 'rival.com', rankOrganic: 4 }], false],
    ['no rival in the results', null, [], false],
  ] as const)('marks a rival ahead with %s: %s', (_label, rank, competitors, ahead) => {
    expect(row('q', rank, { competitors: [...competitors] }).rivalAhead).toBe(ahead)
  })

  it('reads a whole page as completed at its depth and a partial page at the depth that came back', () => {
    expect(row('whole', null)).toMatchObject({ searchStatus: 'completed', checkedDepth: 50, depth: 50 })
    expect(row('partial', null, { checkedDepth: 30 })).toMatchObject({ searchStatus: 'partial', checkedDepth: 30, depth: 50, outcome: 'not-ranked' })
    // The stored partial depth never reads deeper than the search asked for.
    expect(row('clamped', 7, { checkedDepth: 60 })).toMatchObject({ searchStatus: 'completed', checkedDepth: 50, outcome: 'page-1' })
  })

  it('keeps a row for a search with no result, with nothing measured', () => {
    expect(failedRow('lost')).toMatchObject({ outcome: 'failed', searchStatus: 'failed', rankOrganic: null, url: null, checkedDepth: 0, rivalAhead: false, competitors: [], provenance: null, depth: 50 })
    expect(failedRow('skipped', 'not-run')).toMatchObject({ outcome: 'not-run', searchStatus: 'not-run', checkedDepth: 0, provenance: null })
  })
})

describe('countMarketRankings', () => {
  it('partitions rows by outcome, with needs work and rival ahead counted across them', () => {
    const rows = [
      row('a', 3), row('b', 9, { competitors: [{ domain: 'rival.com', rankOrganic: 2 }] }),
      row('c', 11), row('d', 14, { competitors: [{ domain: 'rival.com', rankOrganic: 1 }] }), row('e', 19),
      row('f', 22), row('g', 48),
      row('h', null, { competitors: [{ domain: 'rival.com', rankOrganic: 30 }] }), row('i', null), row('j', null), row('k', null, { checkedDepth: 20 }),
      failedRow('l'), failedRow('m'), failedRow('n', 'not-run'),
    ]
    const counts = countMarketRankings(rows)
    expect(counts).toEqual({ queries: 14, page1: 2, ranks11To20: 3, ranks21Plus: 2, notRanked: 4, failed: 2, notRun: 1, needsWork: 9, rivalAhead: 3 })
    // The outcomes partition the rows; needs work is everything off page 1 that came back.
    expect(counts.page1 + counts.ranks11To20 + counts.ranks21Plus + counts.notRanked + counts.failed + counts.notRun).toBe(counts.queries)
    expect(counts.needsWork).toBe(counts.ranks11To20 + counts.ranks21Plus + counts.notRanked)
  })

  it('counts nothing for no rows', () => {
    expect(countMarketRankings([])).toEqual({ queries: 0, page1: 0, ranks11To20: 0, ranks21Plus: 0, notRanked: 0, failed: 0, notRun: 0, needsWork: 0, rivalAhead: 0 })
  })
})

describe('market-ranking filters, text and order', () => {
  const rows = [
    row('page one', 4), row('close', 12, { competitors: [{ domain: 'rival.com', rankOrganic: 5 }] }), row('deeper', 33),
    row('missing', null), row('missing behind a rival', null, { competitors: [{ domain: 'rival.com', rankOrganic: 2 }] }),
    failedRow('lost'), failedRow('skipped', 'not-run'),
  ]
  const kept = (filter: SeoMarketRankingFilter) => rows.filter(item => matchesMarketRankingFilter(item, filter)).map(item => item.queryText)

  it.each([
    ['needs-work', ['close', 'deeper', 'missing', 'missing behind a rival']],
    ['page-1', ['page one']], ['ranks-11-20', ['close']], ['ranks-21-plus', ['deeper']],
    ['not-ranked', ['missing', 'missing behind a rival']], ['rival-ahead', ['close', 'missing behind a rival']],
    ['failed', ['lost']], ['not-run', ['skipped']],
  ] as const)('%s keeps %j', (filter, queries) => {
    expect(kept(filter)).toEqual(queries)
  })

  it('finds text in the query, the searched text or the market, ignoring case', () => {
    const searched = row('best homes in Harbor, Coast', 3, { searchText: 'best homes in Harbor', marketLabel: 'Harbor, Coast' })
    expect(['HARBOR', 'homes in harbor', 'coast', '  best  '].map(text => matchesMarketRankingText(searched, text))).toEqual([true, true, true, true])
    expect(matchesMarketRankingText(searched, 'bayside')).toBe(false)
    expect(matchesMarketRankingText(searched, '   ')).toBe(true)
  })

  it.each([
    // Best rank first, then rows not in the results with the strongest rival first, then no result.
    ['rank', ['page one', 'close', 'deeper', 'missing behind a rival', 'missing', 'lost', 'skipped']],
    // Rows not in the results first, then the worst rank; searches with no result stay last.
    ['-rank', ['missing behind a rival', 'missing', 'deeper', 'close', 'page one', 'lost', 'skipped']],
    ['query', ['close', 'deeper', 'lost', 'missing', 'missing behind a rival', 'page one', 'skipped']],
    ['-query', ['skipped', 'page one', 'missing behind a rival', 'missing', 'lost', 'deeper', 'close']],
  ] as const)('orders by %s', (sort: SeoMarketRankingSort, order) => {
    expect([...rows].reverse().sort(compareMarketRankingsBy(sort)).map(item => item.queryText)).toEqual(order)
  })

  it('orders by region, market and search text by default', () => {
    const spread = [row('b', 1, { regionLabel: 'West', marketLabel: 'Alpha' }), row('a', 1, { regionLabel: 'East', marketLabel: 'Zulu' }), row('c', 1, { regionLabel: 'East', marketLabel: 'Bravo' }), row('d', 1, { regionLabel: null, regionKey: null, marketLabel: 'Solo' })]
    expect(spread.sort(compareMarketRankingsBy('market')).map(item => item.queryText)).toEqual(['d', 'c', 'a', 'b'])
  })
})

describe('groupMarketRankings', () => {
  const rows = [
    row('a', 12, { marketKey: 'harbor', marketLabel: 'Harbor, Coast' }), row('b', 15, { marketKey: 'harbor', marketLabel: 'Harbor, Coast' }), row('c', 3, { marketKey: 'bayside', marketLabel: 'Bayside, Coast' }),
    row('d', 30, { marketKey: 'bayside', marketLabel: 'Bayside, Coast' }),
    row('e', 18, { marketKey: 'uptown', marketLabel: 'Uptown, Inland', regionKey: 'r2', regionLabel: 'Inland Metro' }), row('f', 25, { marketKey: 'uptown', marketLabel: 'Uptown, Inland', regionKey: 'r2', regionLabel: 'Inland Metro' }),
    row('g', null, { marketKey: 'solo', marketLabel: 'Solo Town', regionKey: null, regionLabel: null }),
    failedRow('h', 'failed', 'harbor'),
  ]
  const summary = (groups: ReturnType<typeof groupMarketRankings>) => groups.map(group => [group.kind, group.key, group.label, group.counts.queries, group.counts.ranks11To20, group.counts.ranks21Plus])

  it('groups the whole profile by region, with a market that has none standing alone, closest to page 1 first', () => {
    expect(summary(groupMarketRankings(rows, {}))).toEqual([
      ['region', 'r1', 'Coast Metro', 5, 2, 1],
      ['region', 'r2', 'Inland Metro', 2, 1, 1],
      ['market', 'solo', 'Solo Town', 1, 0, 0],
    ])
  })

  it('groups one region by market and one market not at all', () => {
    const coast = rows.filter(item => item.regionKey === 'r1')
    expect(summary(groupMarketRankings(coast, { regionKey: 'r1' }))).toEqual([
      ['market', 'harbor', 'Harbor, Coast', 3, 2, 0],
      ['market', 'bayside', 'Bayside, Coast', 2, 0, 1],
    ])
    expect(groupMarketRankings(coast.filter(item => item.marketKey === 'harbor'), { regionKey: 'r1', marketKey: 'harbor' })).toEqual([])
  })

  it('breaks ties by ranks 21 and deeper, then by label', () => {
    const tied = [row('a', 12, { marketKey: 'b', marketLabel: 'Beta', regionKey: null }), row('b', 12, { marketKey: 'a', marketLabel: 'Alpha', regionKey: null }), row('c', 12, { marketKey: 'c', marketLabel: 'Gamma', regionKey: null }), row('d', 30, { marketKey: 'c', marketLabel: 'Gamma', regionKey: null })]
    expect(groupMarketRankings(tied, {}).map(group => group.label)).toEqual(['Gamma', 'Alpha', 'Beta'])
  })
})

describe('marketRankingBands', () => {
  const totals = (overrides: Partial<SeoMarketRankingCounts> = {}): SeoMarketRankingCounts => ({ queries: 0, page1: 0, ranks11To20: 0, ranks21Plus: 0, notRanked: 0, failed: 0, notRun: 0, needsWork: 0, rivalAhead: 0, ...overrides })
  const labels = (depth: number | null, counts?: SeoMarketRankingCounts) => marketRankingBands(depth, counts).map(band => `${band.count}:${band.filter}:${band.label}`)

  it.each([
    [50, ['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'ranks21Plus:ranks-21-plus:21-50', 'notRanked:not-ranked:Not in top 50']],
    [30, ['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'ranks21Plus:ranks-21-plus:21-30', 'notRanked:not-ranked:Not in top 30']],
    // 20 results cannot rank 21 or deeper, and 10 cannot rank past page 1.
    [20, ['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'notRanked:not-ranked:Not in top 20']],
    [10, ['page1:page-1:Page 1', 'notRanked:not-ranked:Not in top 10']],
    [null, ['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'ranks21Plus:ranks-21-plus:21 and deeper', 'notRanked:not-ranked:Not ranked']],
  ])('labels the bands a depth of %s can fill', (depth, expected) => {
    expect(labels(depth)).toEqual(expected)
  })

  it('keeps a band its depth cannot fill when rows were counted in it', () => {
    expect(labels(20, totals({ ranks21Plus: 2 }))).toEqual(['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'ranks21Plus:ranks-21-plus:21 and deeper', 'notRanked:not-ranked:Not in top 20'])
    expect(labels(10, totals({ ranks11To20: 1 }))).toEqual(['page1:page-1:Page 1', 'ranks11To20:ranks-11-20:11-20', 'notRanked:not-ranked:Not in top 10'])
  })
})
