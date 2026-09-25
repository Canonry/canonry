import { describe, expect, it } from 'vitest'
import { FACTOR_DEFINITIONS, scoreFactors } from '@canonry/aeo-audit/scoring'
import { computeFactorAverages, recordedSharePct } from '../src/site-audit-factors.js'

/**
 * One audited page exactly as the installed engine scores it: every core factor
 * at 80, except FAQ content at `faqScore`. FAQ is page-specific, so below 30 it
 * does not apply, reports a share of 0, and the other fifteen split its points.
 */
function enginePage(faqScore: number) {
  return scoreFactors(FACTOR_DEFINITIONS.map((definition) => ({
    ...definition,
    score: definition.id === 'faq-content' ? faqScore : 80,
    findings: [],
    recommendations: [],
  })))
}

function shareSum(shares: ReadonlyArray<number | null>): number {
  return Number(shares.reduce<number>((total, share) => total + (share ?? 0), 0).toFixed(6))
}

function sharesById(summaries: ReturnType<typeof computeFactorAverages>): Record<string, number | null> {
  return Object.fromEntries(summaries.map((summary) => [summary.id, summary.sharePct]))
}

/** The engine's split of 100 over all sixteen core weights (sum 111), by largest remainder. */
const ALL_APPLY_SHARES = {
  'structured-data': 10.9,
  'content-depth': 9,
  'citations': 7.2,
  'eeat-signals': 7.2,
  'faq-content': 7.2,
  'schema-completeness': 7.2,
  'content-freshness': 6.3,
  'entity-consistency': 6.3,
  'content-extractability': 5.4,
  'definition-blocks': 5.4,
  'named-entities': 5.4,
  'snippet-eligibility': 5.4,
  'ai-access-files': 4.5,
  'schema-validity': 4.5,
  'technical-seo': 4.5,
  'ai-crawler-access': 3.6,
}

describe('computeFactorAverages', () => {
  it('averages successful audit reports and preserves per-band counts', () => {
    const pages = [
      { audit: { factors: [{ id: 'sd', name: 'Structured Data', weight: 12, score: 90, sharePct: 100 }] } },
      { audit: { factors: [{ id: 'sd', name: 'Structured Data', weight: 12, score: 50, sharePct: 100 }] } },
      { audit: null },
    ]
    const [sd] = computeFactorAverages(pages)
    expect(sd).toMatchObject({ id: 'sd', avgScore: 70, pagesPassing: 1, pagesPartial: 1, pagesFailing: 0 })
  })

  it('reports the engine share, not the weight, for a real factor set, and the shares add up to exactly 100', () => {
    const page = enginePage(80)
    // The engine's own page shares, so this test fails if the installed engine changes them.
    expect(Object.fromEntries(page.factors.map((factor) => [factor.id, factor.sharePct]))).toEqual(ALL_APPLY_SHARES)

    const summaries = computeFactorAverages([{ audit: page }, { audit: enginePage(95) }, { audit: enginePage(40) }])
    expect(sharesById(summaries)).toEqual(ALL_APPLY_SHARES)
    expect(shareSum(summaries.map((summary) => summary.sharePct))).toBe(100)
    // The weights stay what the engine reports: relative, summing to 111, not a percentage of anything.
    expect(summaries.find((summary) => summary.id === 'structured-data')).toMatchObject({ weight: 12, sharePct: 10.9 })
    expect(summaries.reduce((total, summary) => total + summary.weight, 0)).toBe(111)
  })

  it('averages each factor share over the audited pages, counting 0 where it did not apply', () => {
    const faqPage = enginePage(80)
    const noFaqPage = enginePage(10)
    // On a page with no FAQ the other fifteen factors split all 100 points.
    expect(noFaqPage.factors.find((factor) => factor.id === 'faq-content')).toMatchObject({ applicable: false, sharePct: 0 })
    expect(noFaqPage.factors.find((factor) => factor.id === 'structured-data')?.sharePct).toBe(11.6)

    const summaries = computeFactorAverages([{ audit: faqPage }, { audit: noFaqPage }, { audit: noFaqPage }, { audit: noFaqPage }])
    // FAQ: (7.2 + 0 + 0 + 0) / 4 = 1.8. Structured data: (10.9 + 11.6 * 3) / 4 = 11.425.
    // The exact means add up to 100; the four tenths left after flooring go to
    // the largest remainders (6.675, 6.675, then the first two of the 7.65 tie
    // in rollup order), so the printed column adds up to 100 as well.
    expect(sharesById(summaries)).toEqual({
      'structured-data': 11.4,
      'content-depth': 9.5,
      'citations': 7.7,
      'eeat-signals': 7.7,
      'faq-content': 1.8,
      'schema-completeness': 7.6,
      'content-freshness': 6.7,
      'entity-consistency': 6.7,
      'content-extractability': 5.7,
      'definition-blocks': 5.7,
      'named-entities': 5.7,
      'snippet-eligibility': 5.7,
      'ai-access-files': 4.8,
      'schema-validity': 4.8,
      'technical-seo': 4.7,
      'ai-crawler-access': 3.8,
    })
    expect(shareSum(summaries.map((summary) => summary.sharePct))).toBe(100)
  })

  it('counts a factor missing from a page as no share of that page', () => {
    const summaries = computeFactorAverages([
      { audit: { factors: [
        { id: 'a', name: 'A', weight: 6, score: 100, sharePct: 60 },
        { id: 'b', name: 'B', weight: 4, score: 100, sharePct: 40 },
      ] } },
      { audit: { factors: [{ id: 'a', name: 'A', weight: 6, score: 100, sharePct: 100 }] } },
    ])
    expect(sharesById(summaries)).toEqual({ a: 80, b: 20 })
  })

  it('does not let an unaudited page dilute the shares', () => {
    const page = enginePage(80)
    const summaries = computeFactorAverages([{ audit: page }, { audit: null }, { audit: null }])
    expect(sharesById(summaries)).toEqual(ALL_APPLY_SHARES)
  })

  it('reports no share at all when an audited page did not record one, never the weight', () => {
    const legacyPage = { factors: FACTOR_DEFINITIONS.map((definition) => ({ ...definition, score: 80 })) }
    const mixed = computeFactorAverages([{ audit: enginePage(80) }, { audit: legacyPage }])
    expect(mixed.map((summary) => summary.sharePct)).toEqual(mixed.map(() => null))
    // The rest of the rollup is unaffected.
    expect(mixed.find((summary) => summary.id === 'structured-data')).toMatchObject({ weight: 12, avgScore: 80, pagesPassing: 2 })

    const legacyOnly = computeFactorAverages([{ audit: legacyPage }])
    expect(legacyOnly.every((summary) => summary.sharePct === null)).toBe(true)
  })

  it('returns an empty rollup when nothing was audited', () => {
    expect(computeFactorAverages([{ audit: null }])).toEqual([])
  })
})

describe('recordedSharePct', () => {
  it('keeps a recorded share, including a real 0, and reads anything else as not recorded', () => {
    expect(recordedSharePct({ sharePct: 10.9 })).toBe(10.9)
    expect(recordedSharePct({ sharePct: 0 })).toBe(0)
    expect(recordedSharePct({})).toBeNull()
    expect(recordedSharePct({ sharePct: null })).toBeNull()
    expect(recordedSharePct({ sharePct: Number.NaN })).toBeNull()
  })
})
