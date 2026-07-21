import { describe, test, expect } from 'vitest'
import {
  adsCtr,
  adsCpcMicros,
  adsInsightRowDtoSchema,
  adsSummaryDtoSchema,
  adsCampaignDtoSchema,
  adsAdGroupDtoSchema,
  adsAccountDtoSchema,
  adsGeoSearchQuerySchema,
  adsGeoSearchResponseSchema,
  adsConversionPixelListResponseSchema,
  adsConversionEventSettingListResponseSchema,
  adsConnectionStatusDtoSchema,
  adsCampaignCreateRequestSchema,
  adsAdGroupCreateRequestSchema,
  adsCampaignUpdateRequestSchema,
  adsAdCreateRequestSchema,
  adsOperationDtoSchema,
  adsOperationReconcileRequestSchema,
  adsOperationReconcileResponseSchema,
  adsReconcileFieldsSchema,
  adsUnresolvedOperationListQuerySchema,
  adsUnresolvedOperationListResponseSchema,
  adsActivationManifestSchema,
  canonicalizeAdsActivationManifest,
  adsActivationGrantDtoSchema,
  adsOperationStepDtoSchema,
  adsActivationGrantCreateRequestSchema,
  adsActivationGrantResponseSchema,
  adsActivationGrantRevokeRequestSchema,
  adsActivateTreeRequestSchema,
  adsActivateTreeResponseSchema,
  AdsCampaignBiddingTypes,
  AdsAdGroupBillingEventTypes,
  AdsOperationKinds,
  AdsOperationStates,
  AdsReconcileStrategies,
  AdsActivationGrantStates,
  ADS_ACTIVATION_MAX_ENTITIES,
  AdsOperationStepStates,
} from '../src/ads.js'

const NOW = '2026-07-17T00:00:00.000Z'

const ACTIVATION_MANIFEST = {
  campaign: {
    id: 'cmpn_1',
    expectedUpdatedAt: 101,
    adGroups: [
      {
        id: 'adgrp_1',
        expectedUpdatedAt: 201,
        ads: [{ id: 'ad_1', expectedUpdatedAt: 301 }],
      },
      {
        id: 'adgrp_2',
        expectedUpdatedAt: 202,
        ads: [
          { id: 'ad_2', expectedUpdatedAt: 302 },
          { id: 'ad_3', expectedUpdatedAt: 303 },
        ],
      },
    ],
  },
}

const ACTIVATION_GRANT_BASE = {
  id: 'grant_1',
  projectId: 'proj_1',
  adAccountId: 'adacct_1',
  manifestHash: 'a'.repeat(64),
  manifest: ACTIVATION_MANIFEST,
  executorApiKeyId: 'key_executor',
  approverApiKeyId: 'key_approver',
  expiresAt: '2026-07-18T00:00:00.000Z',
  approvedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  revocationRequestedAt: null,
}

const ACTIVATION_OPERATION = {
  id: 'op_activate_1',
  adAccountId: 'adacct_1',
  operationKey: 'weekend:activate:1',
  kind: 'campaign_tree_activate',
  state: 'succeeded',
  entityType: 'campaign',
  entityId: 'cmpn_1',
  upstreamUpdatedAt: 101,
  errorCode: null,
  errorMessage: null,
  reconcileStrategy: null,
  reconcileParentId: null,
  reconcileFingerprint: null,
  reconcileFields: null,
  reconcileAttempts: 0,
  lastReconciledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const ACTIVATION_STEP_BASE = {
  id: 'step_1',
  operationId: 'op_activate_1',
  ordinal: 0,
  entityType: 'campaign',
  entityId: 'cmpn_1',
  expectedUpdatedAt: 101,
  createdAt: NOW,
  updatedAt: NOW,
}

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

  test('campaign and ad-group DTOs accept only the closed bidding vocabularies', () => {
    expect(Object.values(AdsCampaignBiddingTypes)).toEqual(['impressions', 'clicks'])
    expect(Object.values(AdsAdGroupBillingEventTypes)).toEqual(['impression', 'click'])

    for (const biddingType of Object.values(AdsCampaignBiddingTypes)) {
      expect(adsCampaignDtoSchema.safeParse({
        id: 'cmpn_x', name: 'Campaign', status: 'paused', biddingType,
      }).success).toBe(true)
    }
    expect(adsCampaignDtoSchema.safeParse({
      id: 'cmpn_x', name: 'Campaign', status: 'paused', biddingType: 'conversions',
    }).success).toBe(false)

    for (const billingEventType of Object.values(AdsAdGroupBillingEventTypes)) {
      expect(adsAdGroupDtoSchema.safeParse({
        id: 'adgrp_x', campaignId: 'cmpn_x', name: 'Group', status: 'paused', billingEventType,
      }).success).toBe(true)
    }
    expect(adsAdGroupDtoSchema.safeParse({
      id: 'adgrp_x', campaignId: 'cmpn_x', name: 'Group', status: 'paused', billingEventType: 'conversion',
    }).success).toBe(false)
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

  test('campaign creation preserves legacy omissions and supports both bidding modes', () => {
    const base = {
      operationKey: 'weekend:campaign:bidding',
      name: 'AEO Audit Leads',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
    }

    expect(adsCampaignCreateRequestSchema.parse(base)).not.toHaveProperty('biddingType')
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      biddingType: AdsCampaignBiddingTypes.impressions,
    }).success).toBe(true)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      biddingType: AdsCampaignBiddingTypes.clicks,
      conversionEventSettingIds: ['ces_lead'],
    }).success).toBe(true)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      biddingType: 'conversions',
      conversionEventSettingIds: ['ces_lead'],
    }).success).toBe(false)
  })

  test('click bidding requires non-empty unique conversion event setting IDs', () => {
    const base = {
      operationKey: 'weekend:campaign:clicks',
      name: 'AEO Audit Leads',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
      biddingType: AdsCampaignBiddingTypes.clicks,
    }

    expect(adsCampaignCreateRequestSchema.safeParse(base).success).toBe(false)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      conversionEventSettingIds: [],
    }).success).toBe(false)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      conversionEventSettingIds: ['ces_lead', 'ces_lead'],
    }).success).toBe(false)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      conversionEventSettingIds: ['ces_lead', 'ces_booked'],
    }).success).toBe(true)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      conversionEventSettingIds: Array.from({ length: 100 }, (_, index) => `ces_${index}`),
    }).success).toBe(true)
    expect(adsCampaignCreateRequestSchema.safeParse({
      ...base,
      conversionEventSettingIds: Array.from({ length: 101 }, (_, index) => `ces_${index}`),
    }).success).toBe(false)
  })

  test('ad-group creation preserves the legacy billing omission and accepts both billing events', () => {
    const base = {
      operationKey: 'weekend:ad-group:billing',
      campaignId: 'cmpn_1',
      name: 'Audit intent',
      contextHints: ['best AEO audit service'],
      maxBidMicros: 2_000_000,
    }

    expect(adsAdGroupCreateRequestSchema.parse(base)).not.toHaveProperty('billingEventType')
    for (const billingEventType of Object.values(AdsAdGroupBillingEventTypes)) {
      expect(adsAdGroupCreateRequestSchema.safeParse({ ...base, billingEventType }).success).toBe(true)
    }
    expect(adsAdGroupCreateRequestSchema.safeParse({
      ...base,
      billingEventType: 'conversion',
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
      id: 'op_1', adAccountId: 'adacct_aaa', operationKey: 'weekend:campaign:1', kind: 'campaign_create',
      state: 'succeeded', entityType: 'campaign', entityId: 'cmpn_1', upstreamUpdatedAt: 123,
      errorCode: null, errorMessage: null, createdAt: NOW, updatedAt: NOW,
      reconcileStrategy: 'create_fingerprint', reconcileParentId: null,
      reconcileFingerprint: 'a'.repeat(64), reconcileFields: { name: 'AEO Audit Leads', status: 'paused' },
      reconcileAttempts: 0, lastReconciledAt: null,
    }
    expect(adsOperationDtoSchema.safeParse(base).success).toBe(true)
    expect(adsOperationDtoSchema.safeParse({ ...base, state: AdsOperationStates.reconciling }).success).toBe(true)
    expect(adsOperationDtoSchema.safeParse({ ...base, state: 'maybe' }).success).toBe(false)
    expect(adsOperationDtoSchema.safeParse({ ...base, kind: 'campaign_archive' }).success).toBe(false)
  })

  test('reconciliation strategies and fields are closed and exclude raw requests or secrets', () => {
    expect(Object.values(AdsReconcileStrategies)).toEqual([
      'known_entity',
      'create_fingerprint',
      'manual_only',
    ])
    expect(adsReconcileFieldsSchema.safeParse({
      name: 'AEO Audit Leads',
      status: 'paused',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
      biddingType: AdsCampaignBiddingTypes.clicks,
      conversionEventSettingIds: ['ces_lead'],
    }).success).toBe(true)
    expect(adsReconcileFieldsSchema.safeParse({
      name: 'AEO Audit Leads',
      apiKey: 'sdk-secret',
    }).success).toBe(false)
    expect(adsReconcileFieldsSchema.safeParse({
      name: 'Audit card',
      targetUrl: 'https://canonry.ai/audit',
    }).success).toBe(false)
  })

  test('unresolved operation queries parse comma-separated closed states and bounded limits', () => {
    expect(adsUnresolvedOperationListQuerySchema.parse({})).toEqual({
      state: [AdsOperationStates.pending, AdsOperationStates.unknown, AdsOperationStates.reconciling],
      limit: 100,
    })
    expect(adsUnresolvedOperationListQuerySchema.parse({
      state: 'unknown,reconciling',
      limit: '25',
      cursor: 'opaque-cursor',
    })).toEqual({ state: ['unknown', 'reconciling'], limit: 25, cursor: 'opaque-cursor' })
    expect(adsUnresolvedOperationListQuerySchema.safeParse({ state: 'succeeded' }).success).toBe(false)
    expect(adsUnresolvedOperationListQuerySchema.safeParse({ state: 'unknown,unknown' }).success).toBe(false)
    expect(adsUnresolvedOperationListQuerySchema.safeParse({ limit: 201 }).success).toBe(false)
  })

  test('reconciliation request is empty and the response exposes only the durable result', () => {
    expect(adsOperationReconcileRequestSchema.parse({})).toEqual({})
    expect(adsOperationReconcileRequestSchema.safeParse({ candidateEntityId: 'cmpn_1' }).success).toBe(false)
    expect(adsOperationReconcileRequestSchema.safeParse({ retryMutation: true }).success).toBe(false)

    const operation = adsOperationDtoSchema.parse({
      id: 'op_1', adAccountId: null, operationKey: 'weekend:campaign:1', kind: 'campaign_create',
      state: 'succeeded', entityType: 'campaign', entityId: 'cmpn_1', upstreamUpdatedAt: 123,
      errorCode: null, errorMessage: null, reconcileStrategy: 'create_fingerprint',
      reconcileParentId: null, reconcileFingerprint: 'a'.repeat(64),
      reconcileFields: { name: 'AEO Audit Leads', status: 'paused' },
      reconcileAttempts: 1, lastReconciledAt: NOW, createdAt: NOW, updatedAt: NOW,
    })
    expect(adsOperationReconcileResponseSchema.parse({ operation, resolved: true }).resolved).toBe(true)
    expect(adsUnresolvedOperationListResponseSchema.parse({
      operations: [operation], count: 1, nextCursor: 'next-page',
    }).nextCursor).toBe('next-page')
  })
})

describe('approval-bound campaign-tree activation contracts', () => {
  test('defines a strict canonical manifest and a deterministic canonicalizer', () => {
    expect(adsActivationManifestSchema.parse(ACTIVATION_MANIFEST)).toEqual(ACTIVATION_MANIFEST)

    const unsortedManifest = {
      campaign: {
        ...ACTIVATION_MANIFEST.campaign,
        adGroups: [
          {
            ...ACTIVATION_MANIFEST.campaign.adGroups[1]!,
            ads: [...ACTIVATION_MANIFEST.campaign.adGroups[1]!.ads].reverse(),
          },
          ACTIVATION_MANIFEST.campaign.adGroups[0]!,
        ],
      },
    }
    expect(adsActivationManifestSchema.safeParse(unsortedManifest).success).toBe(false)
    const canonical = canonicalizeAdsActivationManifest(unsortedManifest)
    expect(canonical).toEqual(ACTIVATION_MANIFEST)
    expect(adsActivationManifestSchema.safeParse(canonical).success).toBe(true)

    expect(adsActivationManifestSchema.safeParse({
      ...ACTIVATION_MANIFEST,
      campaign: { ...ACTIVATION_MANIFEST.campaign, unexpected: true },
    }).success).toBe(false)
    expect(adsActivationManifestSchema.safeParse({
      campaign: { ...ACTIVATION_MANIFEST.campaign, adGroups: [] },
    }).success).toBe(false)
    expect(adsActivationManifestSchema.safeParse({
      campaign: {
        ...ACTIVATION_MANIFEST.campaign,
        adGroups: [{ ...ACTIVATION_MANIFEST.campaign.adGroups[0]!, ads: [] }],
      },
    }).success).toBe(false)
  })

  test('rejects duplicate ad groups, duplicate ads, and cross-group duplicate ads', () => {
    const firstGroup = ACTIVATION_MANIFEST.campaign.adGroups[0]!
    const secondGroup = ACTIVATION_MANIFEST.campaign.adGroups[1]!

    expect(adsActivationManifestSchema.safeParse({
      campaign: {
        ...ACTIVATION_MANIFEST.campaign,
        adGroups: [firstGroup, firstGroup],
      },
    }).success).toBe(false)
    expect(adsActivationManifestSchema.safeParse({
      campaign: {
        ...ACTIVATION_MANIFEST.campaign,
        adGroups: [{ ...firstGroup, ads: [firstGroup.ads[0]!, firstGroup.ads[0]!] }],
      },
    }).success).toBe(false)
    expect(adsActivationManifestSchema.safeParse({
      campaign: {
        ...ACTIVATION_MANIFEST.campaign,
        adGroups: [
          firstGroup,
          { ...secondGroup, ads: [firstGroup.ads[0]!, ...secondGroup.ads] },
        ],
      },
    }).success).toBe(false)
  })

  test('bounds one activation manifest to a safe provider and SQLite workload', () => {
    const manifestWithAds = (adCount: number) => ({
      campaign: {
        id: 'cmpn_bounded',
        expectedUpdatedAt: 1,
        adGroups: [{
          id: 'adgrp_bounded',
          expectedUpdatedAt: 2,
          ads: Array.from({ length: adCount }, (_, index) => ({
            id: `ad_${String(index).padStart(3, '0')}`,
            expectedUpdatedAt: index + 3,
          })),
        }],
      },
    })
    expect(adsActivationManifestSchema.safeParse(
      manifestWithAds(ADS_ACTIVATION_MAX_ENTITIES - 2),
    ).success).toBe(true)
    expect(adsActivationManifestSchema.safeParse(
      manifestWithAds(ADS_ACTIVATION_MAX_ENTITIES - 1),
    ).success).toBe(false)
  })

  test('models every grant state with exact terminal timestamps', () => {
    expect(Object.values(AdsActivationGrantStates)).toEqual([
      'approved',
      'executing',
      'consumed',
      'revoked',
      'expired',
      'unknown',
    ])

    const variants = [
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'approved',
        operationId: null,
        executionStartedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiredAt: null,
      },
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'executing',
        operationId: 'op_activate_1',
        executionStartedAt: NOW,
        consumedAt: null,
        revokedAt: null,
        expiredAt: null,
      },
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'consumed',
        operationId: 'op_activate_1',
        executionStartedAt: NOW,
        consumedAt: NOW,
        revokedAt: null,
        expiredAt: null,
      },
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'revoked',
        operationId: null,
        executionStartedAt: null,
        consumedAt: null,
        revokedAt: NOW,
        expiredAt: null,
      },
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'expired',
        operationId: null,
        executionStartedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiredAt: NOW,
      },
      {
        ...ACTIVATION_GRANT_BASE,
        state: 'unknown',
        operationId: 'op_activate_1',
        executionStartedAt: NOW,
        consumedAt: null,
        revokedAt: null,
        expiredAt: null,
      },
    ]

    for (const grant of variants) {
      expect(adsActivationGrantDtoSchema.safeParse(grant).success, grant.state).toBe(true)
    }

    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[0],
      executorApiKeyId: 'key_approver',
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[0],
      operationId: 'op_activate_1',
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[1],
      executionStartedAt: null,
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[2],
      consumedAt: null,
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[3],
      revokedAt: null,
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[4],
      expiredAt: null,
    }).success).toBe(false)
    expect(adsActivationGrantDtoSchema.safeParse({
      ...variants[5],
      operationId: null,
    }).success).toBe(false)
  })

  test('models every durable activation step and rollback state', () => {
    expect(Object.values(AdsOperationStepStates)).toEqual([
      'pending',
      'executing',
      'active',
      'failed',
      'rollback_executing',
      'rolled_back',
      'rollback_failed',
      'unknown',
    ])

    const variants = [
      {
        ...ACTIVATION_STEP_BASE,
        state: 'pending',
        providerUpdatedAt: null,
        errorCode: null,
        errorMessage: null,
        remediation: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'executing',
        providerUpdatedAt: null,
        errorCode: null,
        errorMessage: null,
        remediation: null,
        startedAt: NOW,
        finishedAt: null,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'active',
        providerUpdatedAt: 102,
        errorCode: null,
        errorMessage: null,
        remediation: null,
        startedAt: NOW,
        finishedAt: NOW,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'failed',
        providerUpdatedAt: null,
        errorCode: 'version_conflict',
        errorMessage: 'The campaign changed after approval',
        remediation: 'Review and approve a new activation manifest',
        startedAt: NOW,
        finishedAt: NOW,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'rollback_executing',
        providerUpdatedAt: 102,
        errorCode: null,
        errorMessage: null,
        remediation: 'Pausing the entity after a later step failed',
        startedAt: NOW,
        finishedAt: null,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'rolled_back',
        providerUpdatedAt: 103,
        errorCode: null,
        errorMessage: null,
        remediation: 'Entity paused after a later step failed',
        startedAt: NOW,
        finishedAt: NOW,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'rollback_failed',
        providerUpdatedAt: 102,
        errorCode: 'rollback_failed',
        errorMessage: 'The provider did not confirm a paused state',
        remediation: 'Pause the entity manually before retrying',
        startedAt: NOW,
        finishedAt: NOW,
      },
      {
        ...ACTIVATION_STEP_BASE,
        state: 'unknown',
        providerUpdatedAt: null,
        errorCode: 'ambiguous_outcome',
        errorMessage: 'The provider response was interrupted',
        remediation: 'Reconcile provider state before retrying',
        startedAt: NOW,
        finishedAt: NOW,
      },
    ]

    for (const step of variants) {
      expect(adsOperationStepDtoSchema.safeParse(step).success, step.state).toBe(true)
    }

    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[0],
      providerUpdatedAt: 102,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[1],
      finishedAt: NOW,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[2],
      providerUpdatedAt: null,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[3],
      remediation: null,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[4],
      finishedAt: NOW,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[5],
      providerUpdatedAt: null,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[6],
      errorCode: null,
    }).success).toBe(false)
    expect(adsOperationStepDtoSchema.safeParse({
      ...variants[7],
      startedAt: null,
    }).success).toBe(false)
  })

  test('binds approval and activation requests to exact strict payloads', () => {
    expect(AdsOperationKinds.campaign_tree_activate).toBe('campaign_tree_activate')

    expect(adsActivationGrantCreateRequestSchema.parse({
      manifest: ACTIVATION_MANIFEST,
      executorApiKeyId: 'key_executor',
      expiresAt: '2026-07-18T00:00:00.000Z',
    })).toMatchObject({ executorApiKeyId: 'key_executor', versionPolicy: 'exact' })
    expect(adsActivationGrantCreateRequestSchema.parse({
      manifest: ACTIVATION_MANIFEST,
      executorApiKeyId: 'key_executor',
      expiresAt: '2026-07-18T00:00:00.000Z',
      versionPolicy: 'refresh_semantically_unchanged',
    }).versionPolicy).toBe('refresh_semantically_unchanged')
    expect(adsActivationGrantCreateRequestSchema.safeParse({
      manifest: ACTIVATION_MANIFEST,
      executorApiKeyId: 'key_executor',
      expiresAt: '2026-07-18T00:00:00.000Z',
      operationKey: 'must:not:be:approved',
    }).success).toBe(false)

    expect(adsActivationGrantRevokeRequestSchema.parse({})).toEqual({})
    expect(adsActivationGrantRevokeRequestSchema.safeParse({ reason: 'changed my mind' }).success).toBe(false)

    expect(adsActivateTreeRequestSchema.parse({
      operationKey: 'weekend:activate:1',
      grantId: 'grant_1',
      manifestHash: 'a'.repeat(64),
    })).toEqual({
      operationKey: 'weekend:activate:1',
      grantId: 'grant_1',
      manifestHash: 'a'.repeat(64),
    })
    expect(adsActivateTreeRequestSchema.safeParse({
      operationKey: 'weekend:activate:1',
      grantId: 'grant_1',
      manifestHash: 'not-a-sha256',
    }).success).toBe(false)
  })

  test('returns the durable grant, operation receipt, and ordered step ledger', () => {
    const consumedGrant = adsActivationGrantDtoSchema.parse({
      ...ACTIVATION_GRANT_BASE,
      state: 'consumed',
      operationId: 'op_activate_1',
      executionStartedAt: NOW,
      consumedAt: NOW,
      revokedAt: null,
      expiredAt: null,
    })
    const { adAccountId: _adAccountId, ...unboundGrant } = consumedGrant
    expect(adsActivationGrantDtoSchema.safeParse(unboundGrant).success).toBe(false)
    const activeStep = adsOperationStepDtoSchema.parse({
      ...ACTIVATION_STEP_BASE,
      state: 'active',
      providerUpdatedAt: 102,
      errorCode: null,
      errorMessage: null,
      remediation: null,
      startedAt: NOW,
      finishedAt: NOW,
    })

    expect(adsActivationGrantResponseSchema.parse({ grant: consumedGrant }).grant).toMatchObject({
      state: 'consumed',
      adAccountId: 'adacct_1',
    })
    const response = adsActivateTreeResponseSchema.parse({
      grant: consumedGrant,
      operation: ACTIVATION_OPERATION,
      steps: [activeStep],
    })
    expect(response.operation.kind).toBe(AdsOperationKinds.campaign_tree_activate)
    expect(response.steps.map((step) => step.state)).toEqual(['active'])
  })
})
