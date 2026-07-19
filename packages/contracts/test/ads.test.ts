import { describe, test, expect } from 'vitest'
import {
  adsCtr,
  adsCpcMicros,
  adsInsightRowDtoSchema,
  adsSummaryDtoSchema,
  adsCampaignDtoSchema,
  adsAccountDtoSchema,
  adsGeoSearchQuerySchema,
  adsGeoSearchResponseSchema,
  adsConversionPixelListResponseSchema,
  adsConversionEventSettingListResponseSchema,
  adsConnectionStatusDtoSchema,
  adsCampaignCreateRequestSchema,
  adsCampaignUpdateRequestSchema,
  adsAdCreateRequestSchema,
  adsOperationDtoSchema,
} from '../src/ads.js'

const NOW = '2026-07-17T00:00:00.000Z'

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
  test('normalizes account review and integrity state without exposing provider nesting', () => {
    const parsed = adsAccountDtoSchema.parse({
      id: 'adacct_1',
      name: 'Canonry',
      status: 'active',
      currencyCode: 'USD',
      timezone: 'America/New_York',
      url: 'https://canonry.ai',
      reviewStatus: 'in_review',
      integrityReviewStatus: 'approved',
      integrityDecision: 'allowed',
    })
    expect(parsed.reviewStatus).toBe('in_review')
    expect(parsed.integrityDecision).toBe('allowed')
  })

  test('validates normalized geo search inputs and output', () => {
    expect(adsGeoSearchQuerySchema.parse({ q: '  San Francisco  ' })).toEqual({
      q: 'San Francisco',
      limit: 20,
    })
    expect(adsGeoSearchQuerySchema.safeParse({ q: '', limit: 20 }).success).toBe(false)
    expect(adsGeoSearchQuerySchema.safeParse({ q: 'US', limit: 101 }).success).toBe(false)

    const parsed = adsGeoSearchResponseSchema.parse({
      count: 1,
      query: 'San Francisco',
      results: [{
        id: '3000194',
        type: 'dma',
        canonicalName: 'San Francisco - Oakland - San Jose, United States',
        countryCode: 'US',
        name: 'San Francisco - Oakland - San Jose',
        regionCode: '807',
      }],
    })
    expect(parsed.results[0]?.id).toBe('3000194')
  })

  test('validates normalized pixel and conversion event setting lists', () => {
    const pixels = adsConversionPixelListResponseSchema.parse({
      pixels: [{ id: 'clidsrc_123', clientType: 'web', name: 'Canonry website', pixelId: '134534' }],
    })
    expect(pixels.pixels[0]?.pixelId).toBe('134534')

    const settings = adsConversionEventSettingListResponseSchema.parse({
      eventSettings: [{
        id: 'ces_123',
        name: 'Audit leads',
        eventType: 'lead_created',
        customEventName: null,
        attributionWindowDays: 30,
        adAccountId: 'adacct_1',
        sourceIds: ['clidsrc_123'],
        sources: [{ id: 'clidsrc_123', name: 'Canonry website' }],
        archived: false,
        version: 1,
      }],
    })
    expect(settings.eventSettings[0]?.sourceIds).toEqual(['clidsrc_123'])
  })

  test('keeps unconfirmed conversion-list metadata optional', () => {
    expect(adsConversionPixelListResponseSchema.parse({
      pixels: [{ id: 'clidsrc_partial' }],
    })).toEqual({ pixels: [{ id: 'clidsrc_partial' }] })

    expect(adsConversionEventSettingListResponseSchema.parse({
      eventSettings: [{ id: 'ces_partial' }],
    })).toEqual({ eventSettings: [{ id: 'ces_partial' }] })
  })

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
    expect(parsed.conversionEventSettingIds).toEqual([])
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
    expect(adsConnectionStatusDtoSchema.parse({
      connected: true,
      reviewStatus: 'in_review',
      integrityReviewStatus: 'approved',
      integrityDecision: 'allowed',
    })).toMatchObject({
      reviewStatus: 'in_review',
      integrityReviewStatus: 'approved',
      integrityDecision: 'allowed',
    })
  })
})

describe('ads lifecycle contracts', () => {
  test('campaign creation requires locations and budget while stripping caller-controlled status', () => {
    const input = {
      operationKey: 'weekend:campaign:1',
      name: 'AEO Audit Leads',
      startTime: 1_800_000_000,
      endTime: 1_800_086_400,
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
      status: 'active',
    }
    const parsed = adsCampaignCreateRequestSchema.parse(input)
    expect(parsed.locationIds).toEqual(['1000232'])
    expect('status' in parsed).toBe(false)
    expect(adsCampaignCreateRequestSchema.safeParse({
      operationKey: 'weekend:campaign:2',
      name: 'AEO Audit Leads',
      lifetimeSpendLimitMicros: 999_999,
      locationIds: [],
    }).success).toBe(false)
  })

  test('campaign update requires an optimistic timestamp, a real mutation, and non-empty geo targeting', () => {
    expect(adsCampaignUpdateRequestSchema.safeParse({
      operationKey: 'weekend:update:1', expectedUpdatedAt: 123,
    }).success).toBe(false)
    expect(adsCampaignUpdateRequestSchema.safeParse({
      operationKey: 'weekend:update:1', expectedUpdatedAt: 123, lifetimeSpendLimitMicros: 30_000_000,
    }).success).toBe(true)
    expect(adsCampaignUpdateRequestSchema.safeParse({
      operationKey: 'weekend:update:geo:null', expectedUpdatedAt: 123, locationIds: null,
    }).success).toBe(false)
    expect(adsCampaignUpdateRequestSchema.safeParse({
      operationKey: 'weekend:update:geo:empty', expectedUpdatedAt: 123, locationIds: [],
    }).success).toBe(false)
    expect(adsCampaignUpdateRequestSchema.safeParse({
      operationKey: 'weekend:update:geo:valid', expectedUpdatedAt: 123, locationIds: ['3000001'],
    }).success).toBe(true)
  })

  test('chat-card creation enforces HTTPS and the upstream copy limits', () => {
    const base = {
      operationKey: 'weekend:ad:1', adGroupId: 'adgrp_1', name: 'Audit card',
      creative: {
        title: 'See How AI Reads Your Site',
        body: 'Run a free AEO audit and get your top fixes.',
        targetUrl: 'https://canonry.ai/audit',
        fileId: 'file_1',
      },
    }
    expect(adsAdCreateRequestSchema.safeParse(base).success).toBe(true)
    expect(adsAdCreateRequestSchema.safeParse({
      ...base, creative: { ...base.creative, targetUrl: 'http://canonry.ai/audit' },
    }).success).toBe(false)
    expect(adsAdCreateRequestSchema.safeParse({
      ...base, creative: { ...base.creative, body: 'x'.repeat(101) },
    }).success).toBe(false)
  })

  test('operation receipts reject unknown states and kinds', () => {
    const base = {
      id: 'op_1', operationKey: 'weekend:campaign:1', kind: 'campaign_create',
      state: 'succeeded', entityType: 'campaign', entityId: 'cmpn_1', upstreamUpdatedAt: 123,
      errorCode: null, errorMessage: null, createdAt: NOW, updatedAt: NOW,
    }
    expect(adsOperationDtoSchema.safeParse(base).success).toBe(true)
    expect(adsOperationDtoSchema.safeParse({ ...base, state: 'maybe' }).success).toBe(false)
    expect(adsOperationDtoSchema.safeParse({ ...base, kind: 'campaign_archive' }).success).toBe(false)
  })
})
