import { describe, test, expect } from 'vitest'
import {
  adsCtr,
  adsCpcMicros,
  adsInsightRowDtoSchema,
  adsSummaryDtoSchema,
  adsCampaignDtoSchema,
  adsConnectionStatusDtoSchema,
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
      impressions: 0, clicks: 0, spendMicros: 0, conversions: 0, ctr: null, cpcMicros: null,
    })
    expect(parsed.ctr).toBeNull()
    expect(parsed.conversions).toBe(0)
  })

  test('insight row requires an integer conversions count', () => {
    // Missing → invalid (the field is required so a zero is always explicit).
    expect(adsInsightRowDtoSchema.safeParse({
      level: 'campaign', entityId: 'cmpn_x', date: '2026-06-10',
      impressions: 10, clicks: 1, spendMicros: 1000, ctr: 0.1, cpcMicros: 1000,
    }).success).toBe(false)
    // Fractional → invalid (the column is an integer; rounding happens at ingest).
    expect(adsInsightRowDtoSchema.safeParse({
      level: 'campaign', entityId: 'cmpn_x', date: '2026-06-10',
      impressions: 10, clicks: 1, spendMicros: 1000, conversions: 2.5, ctr: 0.1, cpcMicros: 1000,
    }).success).toBe(false)
  })

  test('campaign DTO defaults nested collections', () => {
    const parsed = adsCampaignDtoSchema.parse({ id: 'cmpn_x', name: 'C', status: 'active' })
    expect(parsed.adGroups).toEqual([])
  })

  test('summary requires window and totals incl. conversions', () => {
    const ok = adsSummaryDtoSchema.safeParse({
      connected: true, campaignCount: 2, adGroupCount: 16, adCount: 20,
      window: { from: '2026-06-07', to: '2026-06-10' },
      totals: { impressions: 18047, clicks: 235, spendMicros: 498_470_000, conversions: 9, ctr: 0.013, cpcMicros: 2_121_148 },
    })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.data.totals.conversions).toBe(9)
    // totals without conversions is now invalid (the field is required).
    expect(adsSummaryDtoSchema.safeParse({
      connected: true, campaignCount: 0, adGroupCount: 0, adCount: 0,
      window: { from: null, to: null },
      totals: { impressions: 0, clicks: 0, spendMicros: 0, ctr: null, cpcMicros: null },
    }).success).toBe(false)
    expect(adsSummaryDtoSchema.safeParse({ connected: false }).success).toBe(false)
  })

  test('connection status carries an optional conversionTrackingConfigured flag', () => {
    // Optional: a disconnected status omits it.
    expect(adsConnectionStatusDtoSchema.parse({ connected: false }).conversionTrackingConfigured).toBeUndefined()
    // Present when connected.
    const parsed = adsConnectionStatusDtoSchema.parse({ connected: true, conversionTrackingConfigured: true })
    expect(parsed.conversionTrackingConfigured).toBe(true)
  })
})
