import {
  factorStatusFromScore,
  roundPreservingTotal,
  SiteAuditFactorStatuses,
  type SiteAuditFactorSummaryDto,
} from '@ainyc/canonry-contracts'

/**
 * The factor fields the site rollup reads: a `@canonry/aeo-audit` scored factor
 * as the crawl reports it, or a page factor canonry already stored.
 */
export interface SiteAuditFactorScore {
  id: string
  name: string
  weight: number
  score: number
  sharePct?: number | null
}

/** One crawled page as the rollup sees it: its audit's factors, or null when the page was not audited. */
export interface SiteAuditFactorPage {
  audit: { factors: readonly SiteAuditFactorScore[] } | null
}

/**
 * The share of the page score the engine recorded for a factor, or null when
 * it recorded none. Never a stand-in derived from `weight`: weights are
 * relative and do not add up to 100, so a weight is not a share of anything.
 */
export function recordedSharePct(factor: Pick<SiteAuditFactorScore, 'sharePct'>): number | null {
  return typeof factor.sharePct === 'number' && Number.isFinite(factor.sharePct) ? factor.sharePct : null
}

interface FactorRollup {
  name: string
  weight: number
  scores: number[]
  pass: number
  partial: number
  fail: number
  shareTotal: number
}

/**
 * Aggregate the site scorecard from crawl observations, not a second full report.
 *
 * `sharePct` is each factor's share of the SITE score. The site score is the
 * mean of the audited pages' scores, and each page's score is its factor scores
 * weighted by the shares the engine recorded for that page, so a factor's share
 * of the site score is the mean of its page shares over the audited pages, with
 * 0 on a page where it did not apply or was not scored. Those means add up to
 * 100 because every page's shares do, and they are rounded to tenths by largest
 * remainder (in the rollup's own order) so the column still adds up to 100.
 *
 * When any audited page did not record a share, no factor gets one: a mean
 * over the pages that did would describe a different site.
 */
export function computeFactorAverages(pages: readonly SiteAuditFactorPage[]): SiteAuditFactorSummaryDto[] {
  const byId = new Map<string, FactorRollup>()
  let auditedPages = 0
  let everyShareRecorded = true
  for (const page of pages) {
    if (!page.audit) continue
    auditedPages++
    for (const factor of page.audit.factors) {
      const current = byId.get(factor.id) ?? { name: factor.name, weight: factor.weight, scores: [], pass: 0, partial: 0, fail: 0, shareTotal: 0 }
      byId.set(factor.id, current)
      current.scores.push(factor.score)
      switch (factorStatusFromScore(factor.score)) {
        case SiteAuditFactorStatuses.pass: current.pass++; break
        case SiteAuditFactorStatuses.partial: current.partial++; break
        case SiteAuditFactorStatuses.fail: current.fail++; break
      }
      const share = recordedSharePct(factor)
      if (share === null) everyShareRecorded = false
      else current.shareTotal += share
    }
  }
  const rollups = [...byId.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
  const shares = everyShareRecorded && auditedPages > 0
    ? roundPreservingTotal(rollups.map((rollup) => rollup.shareTotal / auditedPages), 1)
    : null
  return rollups.map((rollup, index) => {
    const avgScore = Math.round(rollup.scores.reduce((sum, score) => sum + score, 0) / rollup.scores.length)
    return {
      id: rollup.id,
      name: rollup.name,
      weight: rollup.weight,
      sharePct: shares?.[index] ?? null,
      avgScore,
      status: factorStatusFromScore(avgScore),
      pagesPassing: rollup.pass,
      pagesPartial: rollup.partial,
      pagesFailing: rollup.fail,
    }
  })
}
