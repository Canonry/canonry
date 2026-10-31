import { describe, expect, it } from 'vitest'
import { sentimentFixtureSummary } from './fixtures/sentiment.js'
import {
  aggregateSentiment, rankCriticizedProperties, SENTIMENT_CRITICIZED_PROPERTY_LIMIT, sentimentBreakdownSchema, sentimentSummarySchema,
  type SentimentBreakdown, type SentimentOutcome,
} from '../src/sentiment.js'

type Tally = Partial<Record<SentimentOutcome, number>>
let assessment = 0
/** A breakdown row whose counts come from real aggregation of that many stored assessments. */
function row(key: string, label: string, tally: Tally, dimension: SentimentBreakdown['dimension'] = 'property'): SentimentBreakdown {
  const items = Object.entries(tally).flatMap(([outcome, count]) => Array.from({ length: count ?? 0 }, () => {
    assessment++
    return { assessmentId: `assessment-${assessment}`, sourceSnapshotId: `snapshot-${assessment}`, outcome: outcome as SentimentOutcome }
  }))
  return sentimentBreakdownSchema.parse({ ...aggregateSentiment(items), reason: null, dimension, key, label, queryClass: 'branded' })
}
const counts = (rows: readonly SentimentBreakdown[], keys: readonly string[]) => keys.map(key => {
  const { mixed, unfavorable, favorable } = rows.find(item => item.key === key)!.coverage.counts
  return [key, mixed, unfavorable, favorable]
})

describe('rankCriticizedProperties', () => {
  it('caps the shown list at five Properties', () => {
    expect(SENTIMENT_CRITICIZED_PROPERTY_LIMIT).toBe(5)
  })

  it('keeps only Property rows with a mixed or unfavorable rating', () => {
    const rows = [
      row('praised', 'Praised Homes', { favorable: 4 }),
      row('unadmitted', 'Unadmitted Homes', {}),
      row('unjudged', 'Unjudged Homes', { factual: 2, 'subject-not-mentioned': 1, pending: 1, failed: 1 }),
      row('mixed-only', 'Mixed Homes', { mixed: 1, favorable: 9 }),
      row('unfavorable-only', 'Unfavorable Homes', { unfavorable: 1, favorable: 9 }),
    ]
    expect(rows.find(item => item.key === 'unadmitted')!.coverage.selected).toBe(0)
    // Mixed and unfavorable each count one criticism; the tie goes to the unfavorable rating.
    expect(rankCriticizedProperties(rows)).toEqual({ total: 2, keys: ['unfavorable-only', 'mixed-only'] })
  })

  it('never ranks provider, market or query rows, however criticized', () => {
    const rows = [
      row('openai', 'openai', { unfavorable: 9 }, 'provider'),
      row('north', 'North market', { unfavorable: 8, mixed: 8 }, 'market'),
      row('query-1', 'Example query', { unfavorable: 7 }, 'query'),
      row('harbor', 'Harbor Homes', { mixed: 1 }),
      row('bayside', 'Bayside Homes', { favorable: 3 }),
    ]
    expect(rankCriticizedProperties(rows)).toEqual({ total: 1, keys: ['harbor'] })
    // Without the second Property row there is no Property ranking at all, whatever the other dimensions hold.
    expect(rankCriticizedProperties(rows.filter(item => item.key !== 'bayside'))).toEqual({ total: 0, keys: [] })
  })

  it('is empty with fewer than two Property rows, even when the only Property is criticized', () => {
    expect(rankCriticizedProperties([])).toEqual({ total: 0, keys: [] })
    expect(rankCriticizedProperties([row('only', 'Only Homes', { unfavorable: 5, mixed: 2 })])).toEqual({ total: 0, keys: [] })
    // A second Property row counts toward the span even when it holds no rating at all.
    expect(rankCriticizedProperties([row('only', 'Only Homes', { unfavorable: 5, mixed: 2 }), row('quiet', 'Quiet Homes', {})])).toEqual({ total: 1, keys: ['only'] })
    expect(rankCriticizedProperties([row('praised', 'Praised Homes', { favorable: 3 }), row('quiet', 'Quiet Homes', {})])).toEqual({ total: 0, keys: [] })
  })

  it('ranks by criticism count, never by share', () => {
    // mixed / unfavorable / favorable: 0/1/0 is a 100% unfavorable share on one answer; 0/5/1 is five criticisms.
    const single = row('single', 'Single Homes', { unfavorable: 1 })
    const five = row('five', 'Five Homes', { unfavorable: 5, favorable: 1 })
    expect(rankCriticizedProperties([single, five])).toEqual({ total: 2, keys: ['five', 'single'] })
    expect(single.score.unfavorableRate).toBe(1)
    expect(five.score.unfavorableRate).toBe(5 / 6)
    // 2/2/1 (four criticisms, 40% unfavorable) ranks below 1/5/0 (six criticisms, 83.3% unfavorable) and
    // 1/1/0 (two criticisms, a 50% unfavorable share above 2/2/1's 40%) ranks below both.
    const four = row('four', 'Four Homes', { mixed: 2, unfavorable: 2, favorable: 1 })
    const six = row('six', 'Six Homes', { mixed: 1, unfavorable: 5 })
    const two = row('two', 'Two Homes', { mixed: 1, unfavorable: 1 })
    expect(rankCriticizedProperties([two, four, six])).toEqual({ total: 3, keys: ['six', 'four', 'two'] })
    expect([four, six, two].map(item => item.score.unfavorableDisplay)).toEqual(['40.0%', '83.3%', '50.0%'])
  })

  it('breaks ties by unfavorable count, then fewest favorable, then label, then key', () => {
    // Four criticisms each: more unfavorable first.
    const mostlyMixed = row('mostly-mixed', 'Mostly Mixed', { mixed: 3, unfavorable: 1 })
    const mostlyUnfavorable = row('mostly-unfavorable', 'Mostly Unfavorable', { mixed: 1, unfavorable: 3 })
    expect(rankCriticizedProperties([mostlyMixed, mostlyUnfavorable]).keys).toEqual(['mostly-unfavorable', 'mostly-mixed'])
    // Same criticism and unfavorable counts: fewer favorable first.
    const wellLiked = row('well-liked', 'Well Liked', { mixed: 2, unfavorable: 1, favorable: 5 })
    const unliked = row('unliked', 'Unliked', { mixed: 2, unfavorable: 1 })
    expect(rankCriticizedProperties([wellLiked, unliked]).keys).toEqual(['unliked', 'well-liked'])
    // Same counts: label order, not key order (the key order is the reverse here).
    const willow = row('a-willow', 'Willow Homes', { mixed: 1, unfavorable: 1, favorable: 1 })
    const aspen = row('z-aspen', 'Aspen Homes', { mixed: 1, unfavorable: 1, favorable: 1 })
    expect(rankCriticizedProperties([willow, aspen]).keys).toEqual(['z-aspen', 'a-willow'])
    // Same counts and label: key order.
    const second = row('property-b', 'Same Label', { unfavorable: 1 })
    const first = row('property-a', 'Same Label', { unfavorable: 1 })
    expect(rankCriticizedProperties([second, first]).keys).toEqual(['property-a', 'property-b'])
    // Non-judged outcomes never change the order.
    const noisy = row('noisy', 'Noisy', { mixed: 3, unfavorable: 1, factual: 9, pending: 4, failed: 2 })
    expect(rankCriticizedProperties([noisy, mostlyUnfavorable]).keys).toEqual(['mostly-unfavorable', 'noisy'])
  })

  it('counts every criticized Property in total but lists only the first five, in one total order', () => {
    const rows = [
      row('praised', 'Praised Homes', { favorable: 6 }),
      row('k-two', 'Two Homes', { mixed: 1, unfavorable: 1 }),
      row('k-mostly-mixed', 'Mostly Mixed Homes', { mixed: 3, unfavorable: 1 }),
      row('k-six', 'Six Homes', { mixed: 1, unfavorable: 5 }),
      row('k-willow', 'Willow Homes', { mixed: 1, unfavorable: 1, favorable: 1 }),
      row('quiet', 'Quiet Homes', {}),
      row('k-unliked', 'Unliked Homes', { mixed: 2, unfavorable: 1 }),
      row('k-aspen', 'Aspen Homes', { mixed: 1, unfavorable: 1, favorable: 1 }),
      row('k-mostly-unfavorable', 'Mostly Unfavorable Homes', { mixed: 1, unfavorable: 3 }),
      row('k-well-liked', 'Well Liked Homes', { mixed: 2, unfavorable: 1, favorable: 5 }),
      row('k-single', 'Single Homes', { unfavorable: 1 }),
      row('openai', 'openai', { unfavorable: 40 }, 'provider'),
    ]
    const order = ['k-six', 'k-mostly-unfavorable', 'k-mostly-mixed', 'k-unliked', 'k-well-liked', 'k-two', 'k-aspen', 'k-willow', 'k-single']
    const ranked = rankCriticizedProperties(rows)
    expect(ranked).toEqual({ total: 9, keys: order.slice(0, 5) })
    expect(counts(rows, ranked.keys)).toEqual([['k-six', 1, 5, 0], ['k-mostly-unfavorable', 1, 3, 0], ['k-mostly-mixed', 3, 1, 0], ['k-unliked', 2, 1, 0], ['k-well-liked', 2, 1, 5]])
    // The order is total, so ranking what remains continues it exactly: 1/1/0 before the two 1/1/1 rows (by label), then 0/1/0.
    const rest = rankCriticizedProperties(rows.filter(item => !ranked.keys.includes(item.key)))
    expect(rest).toEqual({ total: 4, keys: order.slice(5) })
    // Input order never matters, and the input rows are not reordered.
    const before = rows.map(item => item.key)
    expect(rankCriticizedProperties([...rows].reverse())).toEqual(ranked)
    expect(rows.map(item => item.key)).toEqual(before)
  })

  it('lists exactly five when exactly five are criticized', () => {
    const rows = [1, 2, 3, 4, 5].map(index => row(`p${index}`, `Property ${index}`, { unfavorable: index }))
    expect(rankCriticizedProperties(rows)).toEqual({ total: 5, keys: ['p5', 'p4', 'p3', 'p2', 'p1'] })
    expect(rankCriticizedProperties([...rows, row('p6', 'Property 6', { mixed: 6 })])).toEqual({ total: 6, keys: ['p6', 'p5', 'p4', 'p3', 'p2'] })
  })
})

describe('criticizedProperties on the summary contract', () => {
  it('is optional, so a summary from an older server still reads', () => {
    expect(sentimentSummarySchema.parse(sentimentFixtureSummary)).not.toHaveProperty('criticizedProperties')
    const criticizedProperties = { total: 7, keys: ['p1', 'p2', 'p3', 'p4', 'p5'] }
    expect(sentimentSummarySchema.parse({ ...sentimentFixtureSummary, criticizedProperties }).criticizedProperties).toEqual(criticizedProperties)
    expect(sentimentSummarySchema.parse({ ...sentimentFixtureSummary, criticizedProperties: { total: 0, keys: [] } }).criticizedProperties).toEqual({ total: 0, keys: [] })
  })

  it('rejects a malformed ranking', () => {
    for (const bad of [{ total: -1, keys: [] }, { total: 1.5, keys: [] }, { total: 1 }, { keys: [] }, { total: 1, keys: [1] }, { total: 1, keys: ['p1'], shares: [1] }]) {
      expect(sentimentSummarySchema.safeParse({ ...sentimentFixtureSummary, criticizedProperties: bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
