import { describe, test, expect } from 'vitest'
import {
  adsCtr,
  adsCpcMicros,
  adsInsightRowDtoSchema,
  adsSummaryDtoSchema,
  adsCampaignDtoSchema,
} from '../src/ads.js'

describe('adsCtr', () => {
  test('computes clicks over impressions', () => {
    // 23 clicks / 1736 impressions — real captured day
    expect(adsCtr(23, 1736)).toBeCloseTo(0.013249, 5)
  })

  test('returns null when impressions is zero (no divide-by-zero)', () => {
    expect(adsCtr(0, 0)).toBeNull()
    expect(adsCtr(5, 0)).toBeNull()
  })
})

describe('adsCpcMicros', () => {
  test('computes integer micros per click', () => {
    // $39.28 spend / 23 clicks = $1.7078… → 1_707_826 micros
    expect(adsCpcMicros(39_280_000, 23)).toBe(1_707_826)
  })

  test('returns null when clicks is zero', () => {
    expect(adsCpcMicros(39_280_000, 0)).toBeNull()
    expect(adsCpcMicros(0, 0)).toBeNull()
  })
})

describe('DTO schemas', () => {
  test('insight row accepts derived nulls for zero denominators', () => {
    const parsed = adsInsightRowDtoSchema.parse({
      level: 'campaign', entityId: 'cmpn_x', date: '2026-06-10',
      impressions: 0, clicks: 0, spendMicros: 0, ctr: null, cpcMicros: null,
    })
    expect(parsed.ctr).toBeNull()
  })

  test('campaign DTO defaults nested collections', () => {
    const parsed = adsCampaignDtoSchema.parse({ id: 'cmpn_x', name: 'C', status: 'active' })
    expect(parsed.adGroups).toEqual([])
  })

  test('summary requires window and totals', () => {
    const ok = adsSummaryDtoSchema.safeParse({
      connected: true, campaignCount: 2, adGroupCount: 16, adCount: 20,
      window: { from: '2026-06-07', to: '2026-06-10' },
      totals: { impressions: 18047, clicks: 235, spendMicros: 498_470_000, ctr: 0.013, cpcMicros: 2_121_148 },
    })
    expect(ok.success).toBe(true)
    expect(adsSummaryDtoSchema.safeParse({ connected: false }).success).toBe(false)
  })
})
