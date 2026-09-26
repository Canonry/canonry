import { describe, expect, it } from 'vitest'
import { analyzeGbp, GBP_KEYWORD_SEVERE_PCT, type GbpLocationSignals } from '../src/gbp-analyzer.js'

/**
 * A 79% keyword drop alerted `high` daily for a month on a real client while
 * website clicks ran 19.0/day then 17.3/day. The reach that vanished was people
 * searching an adjacent city and scrolling past.
 */
const base: GbpLocationSignals = {
  locationName: 'locations/1',
  displayName: 'A Hotel',
  metricRecent7d: {},
  metricPrior7d: {},
  metricDeltaPct: {},
  lodgingCapable: false,
  lodgingEmpty: false,
  descriptionMissing: false,
  placesAmenities: [],
  placeActionCount: 1,
  hasDirectMerchantCta: true,
  keywordRecentMonth: '2026-07',
  keywordPriorMonth: '2026-06',
  keywordPoints: [{ keyword: 'santa monica hotels', recent: 210, prior: 1019 }],
}

const keywordDrop = (drafts: ReturnType<typeof analyzeGbp>) =>
  drafts.find(d => d.type === 'gbp-keyword-drop')

describe('a keyword drop is only severe if it cost something', () => {
  it('downgrades to medium when the actions it should drive held up', () => {
    const drop = keywordDrop(
      analyzeGbp([{ ...base, metricDeltaPct: { WEBSITE_CLICKS: -9, CALL_CLICKS: 4, BUSINESS_DIRECTION_REQUESTS: 0 } }]),
    )
    // 1,019 → 210 is a 79.39% drop, shown through formatPercent rather than rounded to 79.
    expect(drop?.title).toContain('impressions down 79.4% month-over-month')
    expect(drop?.severity).toBe('medium')
  })

  it('stays high when the actions fell with it', () => {
    const drop = keywordDrop(
      analyzeGbp([{ ...base, metricDeltaPct: { WEBSITE_CLICKS: -55, CALL_CLICKS: -60, BUSINESS_DIRECTION_REQUESTS: -40 } }]),
    )
    expect(drop?.severity).toBe('high')
  })

  it('stays high when nothing is known about actions, because unknown is not health', () => {
    const drop = keywordDrop(analyzeGbp([{ ...base, metricDeltaPct: {} }]))
    expect(drop?.severity).toBe('high')
  })

  it('never UPGRADES on action data, because the windows do not match', () => {
    // Keyword series is monthly; action deltas are 7d vs prior 7d. A sub-severe
    // drop must not become severe just because a different window looks bad.
    const mild = keywordDrop(
      analyzeGbp([{
        ...base,
        keywordPoints: [{ keyword: 'k', recent: 900, prior: 1000 }],
        metricDeltaPct: { WEBSITE_CLICKS: -90 },
      }]),
    )
    expect(mild === undefined || mild.severity !== 'high').toBe(true)
    expect(GBP_KEYWORD_SEVERE_PCT).toBe(70)
  })
})
