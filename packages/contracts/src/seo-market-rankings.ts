import { compareText } from './text-order.js'
import {
  SeoMarketRankingFilters, SeoMarketRankingGroupKinds, SeoMarketRankingOutcomes, SeoMarketRankingSearchStatuses, SeoMarketRankingSorts,
  type SeoMarketRanking, type SeoMarketRankingContext, type SeoMarketRankingCounts, type SeoMarketRankingFilter, type SeoMarketRankingGroup,
  type SeoMarketRankingObservation, type SeoMarketRankingOutcome, type SeoMarketRankingSort, type SeoTarget,
} from './seo.js'

const PAGE_ONE_LAST_RANK = 10
const CLOSE_LAST_RANK = 20

/** The best organic rank among the tracked competitors in one results page, or null when none ranked. */
function bestCompetitorRank(competitors: ReadonlyArray<{ rankOrganic: number }>): number | null {
  return competitors.reduce<number | null>((best, competitor) => best === null || competitor.rankOrganic < best ? competitor.rankOrganic : best, null)
}

function outcomeFor(rank: number | null): SeoMarketRankingOutcome {
  if (rank === null) return SeoMarketRankingOutcomes['not-ranked']
  if (rank <= PAGE_ONE_LAST_RANK) return SeoMarketRankingOutcomes['page-1']
  return rank <= CLOSE_LAST_RANK ? SeoMarketRankingOutcomes['ranks-11-20'] : SeoMarketRankingOutcomes['ranks-21-plus']
}

/**
 * The read row for a search that came back: whole (`checkedDepth` absent or equal to
 * `depth`) or partial. A tracked competitor is ahead when it ranks above the target,
 * or ranks while the target is not in the checked results.
 */
export function marketRankingFromObservation(observation: SeoMarketRankingObservation): SeoMarketRanking {
  const { checkedDepth: partialDepth, ...rest } = observation
  const checkedDepth = Math.min(partialDepth ?? observation.depth, observation.depth)
  const best = bestCompetitorRank(observation.competitors)
  return {
    ...rest, checkedDepth,
    searchStatus: checkedDepth < observation.depth ? SeoMarketRankingSearchStatuses.partial : SeoMarketRankingSearchStatuses.completed,
    outcome: outcomeFor(observation.rankOrganic),
    rivalAhead: best !== null && (observation.rankOrganic === null || best < observation.rankOrganic),
  }
}

/** What a search was asked to do, for a row that has no result. */
export interface MarketRankingSearchIntent {
  context: SeoMarketRankingContext
  searchText: string
  locationLabel: string
  target: SeoTarget
  depth: number
}

/** The read row for a search with no result: it failed at the source, or never ran. */
export function marketRankingWithoutResult(intent: MarketRankingSearchIntent, status: 'failed' | 'not-run'): SeoMarketRanking {
  return {
    ...intent.context, searchText: intent.searchText, locationLabel: intent.locationLabel, target: intent.target,
    rankOrganic: null, rankAbsolute: null, url: null, depth: intent.depth, checkedDepth: 0,
    searchStatus: status === 'failed' ? SeoMarketRankingSearchStatuses.failed : SeoMarketRankingSearchStatuses['not-run'],
    outcome: status === 'failed' ? SeoMarketRankingOutcomes.failed : SeoMarketRankingOutcomes['not-run'],
    rivalAhead: false, competitors: [], provenance: null,
  }
}

/** Whether a row passes an outcome filter. */
export function matchesMarketRankingFilter(row: SeoMarketRanking, filter: SeoMarketRankingFilter): boolean {
  switch (filter) {
    case SeoMarketRankingFilters['needs-work']:
      return row.outcome === SeoMarketRankingOutcomes['ranks-11-20'] || row.outcome === SeoMarketRankingOutcomes['ranks-21-plus'] || row.outcome === SeoMarketRankingOutcomes['not-ranked']
    case SeoMarketRankingFilters['rival-ahead']:
      return row.rivalAhead
    case SeoMarketRankingFilters['page-1']:
    case SeoMarketRankingFilters['ranks-11-20']:
    case SeoMarketRankingFilters['ranks-21-plus']:
    case SeoMarketRankingFilters['not-ranked']:
    case SeoMarketRankingFilters.failed:
    case SeoMarketRankingFilters['not-run']:
      return row.outcome === filter
    default: {
      const unknown: never = filter
      return unknown
    }
  }
}

/** Whether a row's query, searched text or market label contains the text, ignoring case. */
export function matchesMarketRankingText(row: SeoMarketRanking, text: string): boolean {
  const needle = text.trim().toLowerCase()
  return !needle || [row.queryText, row.searchText, row.marketLabel].some(value => value.toLowerCase().includes(needle))
}

const byMarket = (a: SeoMarketRanking, b: SeoMarketRanking) => compareText(a.regionLabel ?? '', b.regionLabel ?? '')
  || compareText(a.marketLabel, b.marketLabel) || compareText(a.searchText, b.searchText) || compareText(a.queryText, b.queryText)
const byQuery = (a: SeoMarketRanking, b: SeoMarketRanking) => compareText(a.queryText.toLowerCase(), b.queryText.toLowerCase()) || byMarket(a, b)
/** Ranked rows, then rows not in the results, then failed searches, then searches that never ran. */
const tier = (row: SeoMarketRanking) => row.rankOrganic !== null ? 0 : row.outcome === SeoMarketRankingOutcomes['not-ranked'] ? 1 : row.outcome === SeoMarketRankingOutcomes.failed ? 2 : 3
/** Within rows not in the results, the strongest tracked rival first and rows with no rival last. */
const rivalOrder = (a: SeoMarketRanking, b: SeoMarketRanking) => (bestCompetitorRank(a.competitors) ?? Number.MAX_SAFE_INTEGER) - (bestCompetitorRank(b.competitors) ?? Number.MAX_SAFE_INTEGER)

/** A comparator for one sort order. Every order ends in a full tie-break, so pages never shuffle. */
export function compareMarketRankingsBy(sort: SeoMarketRankingSort): (a: SeoMarketRanking, b: SeoMarketRanking) => number {
  switch (sort) {
    case SeoMarketRankingSorts.market: return byMarket
    case SeoMarketRankingSorts.query: return byQuery
    case SeoMarketRankingSorts['-query']: return (a, b) => byQuery(b, a)
    case SeoMarketRankingSorts.rank: return (a, b) => tier(a) - tier(b)
      || (a.rankOrganic !== null && b.rankOrganic !== null ? a.rankOrganic - b.rankOrganic : 0)
      || (tier(a) === 1 ? rivalOrder(a, b) : 0) || byQuery(a, b)
    case SeoMarketRankingSorts['-rank']: {
      // Queries not in the results first, then the worst rank; searches with no result stay last.
      const worst = (row: SeoMarketRanking) => row.outcome === SeoMarketRankingOutcomes['not-ranked'] ? 0 : row.rankOrganic !== null ? 1 : tier(row)
      return (a, b) => worst(a) - worst(b)
        || (a.rankOrganic !== null && b.rankOrganic !== null ? b.rankOrganic - a.rankOrganic : 0)
        || (worst(a) === 0 ? rivalOrder(a, b) : 0) || byQuery(a, b)
    }
    default: {
      const unknown: never = sort
      return unknown
    }
  }
}

/** One rank band a market-rankings summary reports. */
export interface MarketRankingBand {
  /** The count it reads from `SeoMarketRankingCounts`. */
  count: 'page1' | 'ranks11To20' | 'ranks21Plus' | 'notRanked'
  filter: SeoMarketRankingFilter
  label: string
}

/**
 * The rank bands, best first, labelled for a search depth: page 1, 11-20, 21 to the
 * depth, then not in the checked results. A band the depth cannot fill (11-20 needs
 * more than 10 results, 21 and deeper more than 20) is left out unless `totals` counts
 * rows in it. A null depth (nothing refreshed yet) keeps every band, with open labels.
 */
export function marketRankingBands(depth: number | null, totals?: SeoMarketRankingCounts): MarketRankingBand[] {
  const fills = (count: MarketRankingBand['count'], firstRank: number) => depth === null || depth >= firstRank || (totals?.[count] ?? 0) > 0
  const bands: MarketRankingBand[] = [{ count: 'page1', filter: SeoMarketRankingFilters['page-1'], label: 'Page 1' }]
  if (fills('ranks11To20', 11)) bands.push({ count: 'ranks11To20', filter: SeoMarketRankingFilters['ranks-11-20'], label: '11-20' })
  if (fills('ranks21Plus', 21)) bands.push({ count: 'ranks21Plus', filter: SeoMarketRankingFilters['ranks-21-plus'], label: depth === null || depth <= 21 ? '21 and deeper' : `21-${depth}` })
  bands.push({ count: 'notRanked', filter: SeoMarketRankingFilters['not-ranked'], label: depth === null ? 'Not ranked' : `Not in top ${depth}` })
  return bands
}

/** Rows counted by outcome. The outcome counts add up to `queries`; `needsWork` and `rivalAhead` overlap them. */
export function countMarketRankings(rows: readonly SeoMarketRanking[]): SeoMarketRankingCounts {
  const counts: SeoMarketRankingCounts = { queries: rows.length, page1: 0, ranks11To20: 0, ranks21Plus: 0, notRanked: 0, failed: 0, notRun: 0, needsWork: 0, rivalAhead: 0 }
  for (const row of rows) {
    switch (row.outcome) {
      case SeoMarketRankingOutcomes['page-1']: counts.page1++; break
      case SeoMarketRankingOutcomes['ranks-11-20']: counts.ranks11To20++; break
      case SeoMarketRankingOutcomes['ranks-21-plus']: counts.ranks21Plus++; break
      case SeoMarketRankingOutcomes['not-ranked']: counts.notRanked++; break
      case SeoMarketRankingOutcomes.failed: counts.failed++; break
      case SeoMarketRankingOutcomes['not-run']: counts.notRun++; break
      default: {
        const unknown: never = row.outcome
        return unknown
      }
    }
    if (row.rivalAhead) counts.rivalAhead++
  }
  counts.needsWork = counts.ranks11To20 + counts.ranks21Plus + counts.notRanked
  return counts
}

/**
 * The groups under a scope: regions for the whole profile (a market without a region
 * stands alone), markets within one region, none within one market. Needs-work order:
 * most ranks 11-20, then most ranks 21 and deeper, then label.
 */
export function groupMarketRankings(rows: readonly SeoMarketRanking[], scope: { regionKey?: string; marketKey?: string }): SeoMarketRankingGroup[] {
  if (scope.marketKey !== undefined) return []
  const groups = new Map<string, { key: string; label: string; kind: SeoMarketRankingGroup['kind']; rows: SeoMarketRanking[] }>()
  for (const row of rows) {
    const region = scope.regionKey === undefined && row.regionKey !== null
    const key = region ? row.regionKey! : row.marketKey
    const id = `${region ? 'region' : 'market'}\u0000${key}`
    const group = groups.get(id) ?? { key, label: region ? row.regionLabel ?? key : row.marketLabel, kind: region ? SeoMarketRankingGroupKinds.region : SeoMarketRankingGroupKinds.market, rows: [] }
    group.rows.push(row)
    groups.set(id, group)
  }
  return [...groups.values()]
    .map(group => ({ key: group.key, label: group.label, kind: group.kind, counts: countMarketRankings(group.rows) }))
    .sort((a, b) => b.counts.ranks11To20 - a.counts.ranks11To20 || b.counts.ranks21Plus - a.counts.ranks21Plus || compareText(a.label, b.label) || compareText(a.key, b.key))
}
