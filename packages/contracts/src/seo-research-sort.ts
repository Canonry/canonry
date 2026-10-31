import { compareText } from './text-order.js'
import { SeoCompetitorSorts, SeoKeywordGapSorts, type SeoCompetitor, type SeoCompetitorSort, type SeoKeywordGap, type SeoKeywordGapSort } from './seo.js'

type Comparator<T> = (a: T, b: T) => number

/** Only the requested value reverses; missing numbers and identity tie-breaks keep their order. */
function numberOrder<T>(value: (row: T) => number | null, direction: 1 | -1, identity: Comparator<T>): Comparator<T> {
  return (a, b) => {
    const left = value(a); const right = value(b)
    if (left === null || right === null) return left === right ? identity(a, b) : left === null ? 1 : -1
    return direction * (left - right) || identity(a, b)
  }
}

function textOrder<T>(value: (row: T) => string, direction: 1 | -1, identity: Comparator<T>): Comparator<T> {
  return (a, b) => direction * compareText(value(a).toLowerCase(), value(b).toLowerCase()) || identity(a, b)
}

const competitorIdentity: Comparator<SeoCompetitor> = (a, b) => compareText(a.target.value, b.target.value) || compareText(a.domain, b.domain)
const gapIdentity: Comparator<SeoKeywordGap> = (a, b) => compareText(a.target.value, b.target.value)
  || compareText(a.competitor.value, b.competitor.value) || compareText(a.keyword, b.keyword)

/** Organic competitors ordered before pagination, with nulls last and fixed domain tie-breaks. */
export function compareSeoCompetitorsBy(sort: SeoCompetitorSort): Comparator<SeoCompetitor> {
  switch (sort) {
    case SeoCompetitorSorts.domain: return textOrder(row => row.domain, 1, competitorIdentity)
    case SeoCompetitorSorts['-domain']: return textOrder(row => row.domain, -1, competitorIdentity)
    case SeoCompetitorSorts.shared: return numberOrder(row => row.sharedKeywords, 1, competitorIdentity)
    case SeoCompetitorSorts['-shared']: return numberOrder(row => row.sharedKeywords, -1, competitorIdentity)
    case SeoCompetitorSorts.position: return numberOrder(row => row.averagePosition, 1, competitorIdentity)
    case SeoCompetitorSorts['-position']: return numberOrder(row => row.averagePosition, -1, competitorIdentity)
    case SeoCompetitorSorts.traffic: return numberOrder(row => row.estimatedOrganicTraffic, 1, competitorIdentity)
    case SeoCompetitorSorts['-traffic']: return numberOrder(row => row.estimatedOrganicTraffic, -1, competitorIdentity)
    default: {
      const unknown: never = sort
      return unknown
    }
  }
}

/** Keyword gaps ordered before pagination. Kind uses its wire value; identity ties stay ascending. */
export function compareSeoKeywordGapsBy(sort: SeoKeywordGapSort): Comparator<SeoKeywordGap> {
  switch (sort) {
    case SeoKeywordGapSorts.keyword: return textOrder(row => row.keyword, 1, gapIdentity)
    case SeoKeywordGapSorts['-keyword']: return textOrder(row => row.keyword, -1, gapIdentity)
    case SeoKeywordGapSorts.kind: return textOrder(row => row.kind, 1, gapIdentity)
    case SeoKeywordGapSorts['-kind']: return textOrder(row => row.kind, -1, gapIdentity)
    case SeoKeywordGapSorts['target-rank']: return numberOrder(row => row.targetRankOrganic, 1, gapIdentity)
    case SeoKeywordGapSorts['-target-rank']: return numberOrder(row => row.targetRankOrganic, -1, gapIdentity)
    case SeoKeywordGapSorts['competitor-rank']: return numberOrder(row => row.competitorRankOrganic, 1, gapIdentity)
    case SeoKeywordGapSorts['-competitor-rank']: return numberOrder(row => row.competitorRankOrganic, -1, gapIdentity)
    case SeoKeywordGapSorts['rank-gap']: return numberOrder(row => row.rankGap, 1, gapIdentity)
    case SeoKeywordGapSorts['-rank-gap']: return numberOrder(row => row.rankGap, -1, gapIdentity)
    case SeoKeywordGapSorts.volume: return numberOrder(row => row.searchVolume, 1, gapIdentity)
    case SeoKeywordGapSorts['-volume']: return numberOrder(row => row.searchVolume, -1, gapIdentity)
    default: {
      const unknown: never = sort
      return unknown
    }
  }
}
