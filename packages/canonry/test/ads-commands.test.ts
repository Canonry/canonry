import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AdsAccountDto,
  AdsActivationGrantResponse,
  AdsActivateTreeResponse,
  AdsConversionEventSettingListResponse,
  AdsConversionPixelListResponse,
  AdsDeliveryDiagnosticsDto,
  AdsLiveDeliveryDto,
  AdsGeoSearchResponse,
  AdsOperationReconcileResponse,
  AdsOperationResponse,
  AdsSummaryDto,
  AdsUnresolvedOperationListResponse,
} from '@ainyc/canonry-contracts'

const mockCreateAdsCampaign = vi.fn()
const mockUpdateAdsCampaign = vi.fn()
const mockGetAdsAccount = vi.fn()
const mockSearchAdsGeo = vi.fn()
const mockGetAdsConversionPixels = vi.fn()
const mockGetAdsConversionEventSettings = vi.fn()
const mockGetAdsDeliveryDiagnostics = vi.fn()
const mockGetAdsLiveDelivery = vi.fn()
const mockGetAdsOperation = vi.fn()
const mockGetUnresolvedAdsOperations = vi.fn()
const mockReconcileAdsOperation = vi.fn()
const mockResumeAdsActivation = vi.fn()
const mockCreateAdsActivationGrant = vi.fn()
const mockRevokeAdsActivationGrant = vi.fn()
const mockActivateAdsCampaignTree = vi.fn()
const mockGetAdsSummary = vi.fn()

function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  return {
    run: fn().finally(() => spy.mockRestore()),
    lines: () => output.split('\n').filter(Boolean),
  }
}

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    createAdsCampaign: mockCreateAdsCampaign,
    updateAdsCampaign: mockUpdateAdsCampaign,
    getAdsAccount: mockGetAdsAccount,
    searchAdsGeo: mockSearchAdsGeo,
    getAdsConversionPixels: mockGetAdsConversionPixels,
    getAdsConversionEventSettings: mockGetAdsConversionEventSettings,
    getAdsDeliveryDiagnostics: mockGetAdsDeliveryDiagnostics,
    getAdsLiveDelivery: mockGetAdsLiveDelivery,
    getAdsOperation: mockGetAdsOperation,
    getUnresolvedAdsOperations: mockGetUnresolvedAdsOperations,
    reconcileAdsOperation: mockReconcileAdsOperation,
    resumeAdsActivation: mockResumeAdsActivation,
    createAdsActivationGrant: mockCreateAdsActivationGrant,
    revokeAdsActivationGrant: mockRevokeAdsActivationGrant,
    activateAdsCampaignTree: mockActivateAdsCampaignTree,
    getAdsSummary: mockGetAdsSummary,
  }),
}))

const {
  adsAccount,
  adsActivationGrantCreate,
  adsActivationGrantRevoke,
  adsCampaignActivateTree,
  adsCampaignCreate,
  adsCampaignUpdate,
  adsConversionEventSettings,
  adsConversionPixels,
  adsDeliveryDiagnostics,
  adsLiveDelivery,
  adsGeoSearch,
  adsOperationGet,
  adsOperationReconcile,
  adsOperationResumeActivation,
  adsOperationsUnresolved,
  adsSummary,
} = await import('../src/commands/ads.js')
const { ADS_CLI_COMMANDS } = await import('../src/cli-commands/ads.js')

const RECEIPT: AdsOperationResponse = {
  replayed: false,
  operation: {
    id: 'op_1',
    adAccountId: 'adacct_aaa',
    operationKey: 'weekend:campaign:1',
    kind: 'campaign_create',
    state: 'succeeded',
    entityType: 'campaign',
    entityId: 'cmpn_1',
    upstreamUpdatedAt: 123,
    errorCode: null,
    errorMessage: null,
    reconcileStrategy: 'create_fingerprint',
    reconcileParentId: null,
    reconcileFingerprint: 'a'.repeat(64),
    reconcileFields: { name: 'AEO Audit Lead Generation', status: 'paused' },
    reconcileAttempts: 0,
    lastReconciledAt: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:01.000Z',
  },
}

const UNRESOLVED: AdsUnresolvedOperationListResponse = {
  operations: [{
    ...RECEIPT.operation,
    id: 'op_pending',
    operationKey: 'weekend:campaign:pending',
    state: 'unknown',
    entityId: null,
    upstreamUpdatedAt: null,
    errorCode: 'ADS_UPSTREAM_OUTCOME_UNKNOWN',
    errorMessage: 'Provider outcome requires verification',
  }],
  count: 1,
  nextCursor: 'next-page-cursor',
}

const RECONCILED: AdsOperationReconcileResponse = {
  operation: {
    ...UNRESOLVED.operations[0]!,
    state: 'succeeded',
    entityId: 'cmpn_1',
    upstreamUpdatedAt: 456,
    errorCode: null,
    errorMessage: null,
    reconcileAttempts: 1,
    lastReconciledAt: '2026-07-17T00:01:00.000Z',
  },
  resolved: true,
}

const ACTIVATION_MANIFEST = {
  campaign: {
    id: 'cmpn_1',
    expectedUpdatedAt: 100,
    adGroups: [{
      id: 'adgrp_1',
      expectedUpdatedAt: 101,
      ads: [{ id: 'ad_1', expectedUpdatedAt: 102 }],
    }],
  },
}
const ACTIVATION_MANIFEST_HASH = 'b'.repeat(64)
const APPROVED_GRANT: AdsActivationGrantResponse = {
  grant: {
    id: 'grant_1',
    projectId: 'project_1',
    adAccountId: 'adacct_1',
    manifestHash: ACTIVATION_MANIFEST_HASH,
    manifest: ACTIVATION_MANIFEST,
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    expiresAt: '2026-07-19T00:00:00.000Z',
    approvedAt: '2026-07-18T20:00:00.000Z',
    createdAt: '2026-07-18T20:00:00.000Z',
    updatedAt: '2026-07-18T20:00:00.000Z',
    state: 'approved',
    operationId: null,
    executionStartedAt: null,
    consumedAt: null,
    revokedAt: null,
    revocationRequestedAt: null,
    expiredAt: null,
  },
}
const REVOKED_GRANT: AdsActivationGrantResponse = {
  grant: {
    ...APPROVED_GRANT.grant,
    state: 'revoked',
    revokedAt: '2026-07-18T20:15:00.000Z',
    updatedAt: '2026-07-18T20:15:00.000Z',
  },
}
const CANCELLATION_REQUESTED_GRANT: AdsActivationGrantResponse = {
  grant: {
    ...APPROVED_GRANT.grant,
    state: 'executing',
    operationId: 'op_activate_1',
    executionStartedAt: '2026-07-18T20:10:00.000Z',
    revocationRequestedAt: '2026-07-18T20:15:00.000Z',
    updatedAt: '2026-07-18T20:15:00.000Z',
  },
}
const ACTIVATED_TREE: AdsActivateTreeResponse = {
  grant: {
    ...APPROVED_GRANT.grant,
    state: 'consumed',
    operationId: 'op_activate_1',
    executionStartedAt: '2026-07-18T20:30:00.000Z',
    consumedAt: '2026-07-18T20:31:00.000Z',
    updatedAt: '2026-07-18T20:31:00.000Z',
  },
  operation: {
    ...RECEIPT.operation,
    id: 'op_activate_1',
    operationKey: 'weekend:activate-tree:1',
    kind: 'campaign_tree_activate',
    entityType: 'campaign',
    entityId: 'cmpn_1',
  },
  steps: [
    ['step_campaign', 'campaign', 'cmpn_1', 100, 103],
    ['step_group', 'ad_group', 'adgrp_1', 101, 104],
    ['step_ad', 'ad', 'ad_1', 102, 105],
  ].map(([id, entityType, entityId, expectedUpdatedAt, providerUpdatedAt], ordinal) => ({
    id: String(id),
    operationId: 'op_activate_1',
    ordinal,
    entityType: entityType as 'campaign' | 'ad_group' | 'ad',
    entityId: String(entityId),
    expectedUpdatedAt: Number(expectedUpdatedAt),
    state: 'active' as const,
    providerUpdatedAt: Number(providerUpdatedAt),
    errorCode: null,
    errorMessage: null,
    remediation: null,
    startedAt: '2026-07-18T20:30:00.000Z',
    finishedAt: '2026-07-18T20:31:00.000Z',
    createdAt: '2026-07-18T20:30:00.000Z',
    updatedAt: '2026-07-18T20:31:00.000Z',
  })),
}
const UNRESOLVED_ACTIVATION: AdsOperationResponse = {
  replayed: true,
  operation: {
    ...ACTIVATED_TREE.operation,
    state: 'pending',
    upstreamUpdatedAt: null,
    errorCode: null,
    errorMessage: null,
  },
}

const ACCOUNT: AdsAccountDto = {
  id: 'acct_1',
  name: 'Canonry',
  status: 'active',
  currencyCode: 'USD',
  timezone: 'America/New_York',
  url: 'https://ads.openai.com/accounts/acct_1',
  reviewStatus: 'approved',
  integrityReviewStatus: 'approved',
  integrityDecision: 'approved',
}

const GEO_RESULTS: AdsGeoSearchResponse = {
  count: 1,
  query: 'New York',
  results: [{
    id: 'geo_501',
    type: 'city',
    canonicalName: 'New York, New York, United States',
    countryCode: 'US',
    name: 'New York',
    regionCode: 'NY',
  }],
}

const PIXELS: AdsConversionPixelListResponse = {
  pixels: [{ id: 'source_1', clientType: 'pixel', name: 'Audit lead pixel', pixelId: 'px_1' }],
}

const EVENT_SETTINGS: AdsConversionEventSettingListResponse = {
  eventSettings: [{
    id: 'event_1',
    name: 'Audit booked',
    eventType: 'custom',
    customEventName: 'audit_booked',
    attributionWindowDays: 30,
    adAccountId: 'acct_1',
    sourceIds: ['source_1'],
    sources: [{ id: 'source_1', name: 'Audit lead pixel' }],
    archived: false,
    version: 1,
  }],
}

const LIVE_DELIVERY: AdsLiveDeliveryDto = {
  basis: 'live-provider-read',
  fetchedAt: '2026-06-10T12:00:00.000Z',
  adAccountId: 'adacct_aaa',
  storedSnapshotSyncedAt: '2026-06-09T00:00:00.000Z',
  metricsWindow: { lookbackDays: 7 },
  bounds: {
    maxCampaigns: 5,
    maxAdGroupsPerCampaign: 10,
    maxAdsPerAdGroup: 20,
    maxReaderCalls: 40,
    readerCalls: 6,
    maxPagesPerReaderCall: 100,
    maxUpstreamHttpRequests: 4_000,
    truncated: false,
  },
  entities: [{
    entityType: 'campaign',
    id: 'cmpn_1',
    parentId: null,
    presence: 'both',
    live: {
      name: 'Homeowners Free Estimate',
      status: 'active',
      reviewStatus: null,
      mode: 'standard',
      updatedAt: 200,
    },
    stored: {
      name: 'Homeowners Free Estimate',
      status: 'paused',
      reviewStatus: null,
      upstreamUpdatedAt: 100,
      syncedAt: '2026-06-09T00:00:00.000Z',
    },
    fieldDeltas: [{ field: 'status', live: 'active', stored: 'paused' }],
    liveMetrics: [{
      date: '2026-06-10',
      startTime: 1_760_000_000,
      endTime: 1_760_086_400,
      impressions: 162,
      clicks: 5,
      spend: 1.5,
      conversions: 0,
      ctr: null,
      cpc: null,
      cpm: null,
    }],
    metricDeltas: [{
      date: '2026-06-10',
      live: { impressions: 162, clicks: 5, spendMicros: 1_500_000, conversions: 0 },
      stored: { impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
      drifted: true,
    }],
    drifted: true,
  }],
  drift: { entitiesCompared: 1, driftedEntities: 1, statusDrifted: 1, metricsDrifted: 1 },
  errors: [],
}

const DELIVERY_DIAGNOSTICS: AdsDeliveryDiagnosticsDto = {
  snapshot: {
    status: 'complete',
    issue: null,
    lastSyncedAt: '2026-07-21T00:00:00.000Z',
    campaignCount: 1,
    adGroupCount: 1,
    adCount: 1,
    sourceSync: { runId: 'sync_1', status: 'completed' },
  },
  historicalCampaignRollups: {
    status: 'reported',
    window: { from: '2026-07-20', to: '2026-07-20' },
    totals: {
      impressions: 7,
      clicks: 1,
      spendMicros: 2_000_000,
      conversions: 0,
      ctr: 1 / 7,
      cpcMicros: 2_000_000,
    },
  },
  storedConfiguration: {
    basis: 'stored_ads_snapshot',
    connection: {
      status: 'active',
      reviewStatus: 'approved',
      integrityReviewStatus: 'approved',
      integrityDecision: 'allowed',
      conversionTrackingConfigured: true,
    },
    campaigns: [],
  },
  assessment: { state: 'observed_activity' },
}

describe('ads lifecycle commands', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-command-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('loads and validates campaign JSON before calling the generated client', async () => {
    const inputPath = path.join(tmpDir, 'campaign.json')
    fs.writeFileSync(inputPath, JSON.stringify({
      operationKey: 'weekend:campaign:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['3000001'],
      biddingType: 'clicks',
      conversionEventSettingIds: ['cevent_audit_booked'],
    }))
    mockCreateAdsCampaign.mockResolvedValue(RECEIPT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsCampaignCreate('canonry-audit', { input: inputPath, format: 'json' })

    expect(mockCreateAdsCampaign).toHaveBeenCalledWith('canonry-audit', {
      operationKey: 'weekend:campaign:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['3000001'],
      biddingType: 'clicks',
      conversionEventSettingIds: ['cevent_audit_booked'],
    })
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(RECEIPT)
  })

  it('rejects an update that omits expectedUpdatedAt before any API call', async () => {
    const inputPath = path.join(tmpDir, 'update.json')
    fs.writeFileSync(inputPath, JSON.stringify({
      operationKey: 'weekend:campaign:update:1',
      lifetimeSpendLimitMicros: 20_000_000,
    }))

    await expect(adsCampaignUpdate('canonry-audit', 'cmpn_1', {
      input: inputPath,
      format: 'json',
    })).rejects.toMatchObject({ code: 'ADS_INPUT_INVALID' })
    expect(mockUpdateAdsCampaign).not.toHaveBeenCalled()
  })

  it('reads live account metadata as JSON', async () => {
    mockGetAdsAccount.mockResolvedValue(ACCOUNT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsAccount('canonry-audit', { format: 'json' })

    expect(mockGetAdsAccount).toHaveBeenCalledWith('canonry-audit')
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(ACCOUNT)
  })

  it('reads the live provider state and the stored-snapshot delta as JSON', async () => {
    mockGetAdsLiveDelivery.mockResolvedValue(LIVE_DELIVERY)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsLiveDelivery('canonry-audit', { campaignId: 'cmpn_1', lookbackDays: 7, format: 'json' })

    expect(mockGetAdsLiveDelivery).toHaveBeenCalledWith('canonry-audit', {
      campaignId: 'cmpn_1',
      lookbackDays: 7,
    })
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(LIVE_DELIVERY)
  })

  it('renders live-vs-stored drift, provider call budget, and read failures', async () => {
    mockGetAdsLiveDelivery.mockResolvedValue({
      ...LIVE_DELIVERY,
      bounds: { ...LIVE_DELIVERY.bounds, truncated: true },
      errors: [{ surface: 'ad group list', entityId: 'cmpn_1', upstreamStatus: 503 }],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsLiveDelivery('canonry-audit')

    const output = log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('live provider read')
    expect(output).toContain('Drift:        1/1 entities (1 status, 1 metrics)')
    expect(output).toContain('TRUNCATED')
    expect(output).toContain('Read failed:  ad group list cmpn_1 [HTTP 503]')
    expect(output).toContain('live active / stored paused')
    // The budget line must not let a reader call read as one HTTP request.
    expect(output).toContain('6/40 reader calls, up to 4000 upstream HTTP requests')
    expect(output).toContain('2026-06-10: live 162 impr / 5 clicks')
    expect(output).toContain('DRIFT')
  })

  it('reads stored delivery diagnostics without a provider verdict', async () => {
    mockGetAdsDeliveryDiagnostics.mockResolvedValue(DELIVERY_DIAGNOSTICS)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsDeliveryDiagnostics('canonry-audit', { format: 'json' })

    expect(mockGetAdsDeliveryDiagnostics).toHaveBeenCalledWith('canonry-audit')
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(DELIVERY_DIAGNOSTICS)
  })

  it.each(['partial', 'unavailable'] as const)('suppresses stored structure details for a %s snapshot', async (status) => {
    mockGetAdsDeliveryDiagnostics.mockResolvedValue({
      ...DELIVERY_DIAGNOSTICS,
      snapshot: { ...DELIVERY_DIAGNOSTICS.snapshot, status, issue: 'no_ads_sync' },
      storedConfiguration: {
        ...DELIVERY_DIAGNOSTICS.storedConfiguration,
        campaigns: [{
          id: 'cmpn_1', name: 'Suppressed campaign', status: 'paused', biddingType: 'impressions',
          dailySpendLimitMicros: null, lifetimeSpendLimitMicros: null, conversionEventSettingIds: [],
          adGroups: [{
            id: 'adgrp_1', name: 'Suppressed ad group', status: 'paused', billingEventType: null,
            maxBidMicros: null, contextHints: [],
            ads: [{ id: 'ad_1', name: 'Suppressed ad', status: 'paused', reviewStatus: null }],
          }],
        }],
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsDeliveryDiagnostics('canonry-audit')

    const output = log.mock.calls.map(([line]) => String(line)).join('\n')
    expect(output).toContain('Structure details suppressed until a complete trusted snapshot exists.')
    expect(output).not.toContain('Suppressed campaign')
    expect(output).not.toContain('Suppressed ad group')
    expect(output).not.toContain('Suppressed ad')
  })

  it('renders stored structure details for a complete snapshot', async () => {
    mockGetAdsDeliveryDiagnostics.mockResolvedValue({
      ...DELIVERY_DIAGNOSTICS,
      storedConfiguration: {
        ...DELIVERY_DIAGNOSTICS.storedConfiguration,
        campaigns: [{
          id: 'cmpn_1', name: 'Complete campaign', status: 'paused', biddingType: 'impressions',
          dailySpendLimitMicros: null, lifetimeSpendLimitMicros: null, conversionEventSettingIds: [],
          adGroups: [{
            id: 'adgrp_1', name: 'Complete ad group', status: 'paused', billingEventType: null,
            maxBidMicros: null, contextHints: [],
            ads: [{ id: 'ad_1', name: 'Complete ad', status: 'paused', reviewStatus: null }],
          }],
        }],
      },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsDeliveryDiagnostics('canonry-audit')

    const output = log.mock.calls.map(([line]) => String(line)).join('\n')
    expect(output).toContain('Complete campaign')
    expect(output).toContain('Complete ad group')
    expect(output).toContain('Complete ad')
  })

  it('normalizes geo search input and streams location context as JSONL', async () => {
    mockSearchAdsGeo.mockResolvedValue(GEO_RESULTS)
    const output = captureStdout(() =>
      adsGeoSearch('canonry-audit', { q: '  New York  ', format: 'jsonl' }),
    )

    await output.run

    expect(mockSearchAdsGeo).toHaveBeenCalledWith('canonry-audit', { q: 'New York', limit: 20 })
    expect(JSON.parse(output.lines()[0]!)).toEqual({
      project: 'canonry-audit',
      query: 'New York',
      ...GEO_RESULTS.results[0],
    })
  })

  it('rejects missing and out-of-range geo search input before an API call', async () => {
    await expect(adsGeoSearch('canonry-audit', { q: ' ', limit: 101 })).rejects.toMatchObject({
      code: 'ADS_GEO_QUERY_INVALID',
    })
    expect(mockSearchAdsGeo).not.toHaveBeenCalled()
  })

  it('streams conversion planning collections as JSONL', async () => {
    mockGetAdsConversionPixels.mockResolvedValue(PIXELS)
    mockGetAdsConversionEventSettings.mockResolvedValue(EVENT_SETTINGS)
    const pixelOutput = captureStdout(() => adsConversionPixels('canonry-audit', { format: 'jsonl' }))

    await pixelOutput.run
    const eventOutput = captureStdout(() =>
      adsConversionEventSettings('canonry-audit', { format: 'jsonl' }),
    )
    await eventOutput.run

    expect(mockGetAdsConversionPixels).toHaveBeenCalledWith('canonry-audit')
    expect(mockGetAdsConversionEventSettings).toHaveBeenCalledWith('canonry-audit')
    expect(JSON.parse(pixelOutput.lines()[0]!)).toEqual({ project: 'canonry-audit', ...PIXELS.pixels[0] })
    expect(JSON.parse(eventOutput.lines()[0]!)).toEqual({
      project: 'canonry-audit',
      ...EVENT_SETTINGS.eventSettings[0],
    })
  })

  it('renders partial conversion rows safely for humans', async () => {
    mockGetAdsConversionPixels.mockResolvedValue({ pixels: [{ id: 'source_partial' }] })
    mockGetAdsConversionEventSettings.mockResolvedValue({ eventSettings: [{ id: 'event_partial' }] })
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))

    await adsConversionPixels('canonry-audit')
    await adsConversionEventSettings('canonry-audit')

    expect(lines).toEqual([
      'Unnamed conversion pixel (unknown client) [source_partial]',
      'Unnamed conversion event: unknown event, unknown attribution window, no source details [event_partial]',
    ])
  })

  it('streams unresolved operation receipts as JSONL', async () => {
    mockGetUnresolvedAdsOperations.mockResolvedValue(UNRESOLVED)
    const output = captureStdout(() => adsOperationsUnresolved('canonry-audit', { format: 'jsonl' }))

    await output.run

    expect(mockGetUnresolvedAdsOperations).toHaveBeenCalledWith('canonry-audit')
    expect(JSON.parse(output.lines()[0]!)).toEqual({
      project: 'canonry-audit',
      ...UNRESOLVED.operations[0],
    })
  })

  it('reconciles the original operation without caller-selected provider candidates', async () => {
    mockReconcileAdsOperation.mockResolvedValue(RECONCILED)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsOperationReconcile('canonry-audit', {
      operationKey: 'weekend:campaign:pending',
      format: 'json',
    })

    expect(mockReconcileAdsOperation).toHaveBeenCalledWith(
      'canonry-audit',
      'weekend:campaign:pending',
    )
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(RECONCILED)
  })

  it.each([
    {
      label: 'generic receipt',
      response: { replayed: true, operation: UNRESOLVED.operations[0]! },
      guidance: 'Do not retry with a new operation key. Reconcile the original receipt instead.',
    },
    {
      label: 'campaign-tree activation receipt',
      response: UNRESOLVED_ACTIVATION,
      guidance: 'Do not retry with a new operation key. Resume activation recovery for the original receipt instead.',
    },
  ])('branches recovery guidance for a $label', async ({ response, guidance }) => {
    mockGetAdsOperation.mockResolvedValue(response)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsOperationGet('canonry-audit', { operationKey: response.operation.operationKey })

    expect(log.mock.calls.at(-1)?.[0]).toBe(guidance)
  })

  it('resumes activation recovery by operation key without a request body', async () => {
    mockResumeAdsActivation.mockResolvedValue(ACTIVATED_TREE)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsOperationResumeActivation('canonry-audit', {
      operationKey: 'weekend:activate-tree:1',
    })

    expect(mockResumeAdsActivation).toHaveBeenCalledWith(
      'canonry-audit',
      'weekend:activate-tree:1',
    )
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Activation weekend:activate-tree:1: succeeded',
      'Steps:      3/3 active',
    ])
  })

  it('creates an activation grant from validated JSON and emits the response as JSON', async () => {
    const inputPath = path.join(tmpDir, 'activation-grant.json')
    const request = {
      manifest: ACTIVATION_MANIFEST,
      executorApiKeyId: 'key_executor',
      expiresAt: '2026-07-19T00:00:00.000Z',
    }
    fs.writeFileSync(inputPath, JSON.stringify(request))
    mockCreateAdsActivationGrant.mockResolvedValue(APPROVED_GRANT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsActivationGrantCreate('canonry-audit', { input: inputPath, format: 'json' })

    expect(mockCreateAdsActivationGrant).toHaveBeenCalledWith('canonry-audit', {
      ...request,
      versionPolicy: 'exact',
    })
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(APPROVED_GRANT)
  })

  it('revokes an activation grant without sending a request body', async () => {
    mockRevokeAdsActivationGrant.mockResolvedValue(REVOKED_GRANT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsActivationGrantRevoke('canonry-audit', 'grant_1')

    expect(mockRevokeAdsActivationGrant).toHaveBeenCalledWith('canonry-audit', 'grant_1')
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Revoked activation grant grant_1: revoked',
      `Manifest: ${ACTIVATION_MANIFEST_HASH}`,
      'Expires:  2026-07-19T00:00:00.000Z',
    ])
  })

  it('reports an in-flight activation cancellation without claiming it is already revoked', async () => {
    mockRevokeAdsActivationGrant.mockResolvedValue(CANCELLATION_REQUESTED_GRANT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsActivationGrantRevoke('canonry-audit', 'grant_1')

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Cancellation requested for activation grant grant_1: executing',
      'Requested: 2026-07-18T20:15:00.000Z',
      `Manifest: ${ACTIVATION_MANIFEST_HASH}`,
      'Expires:  2026-07-19T00:00:00.000Z',
    ])
  })

  it('activates the exact approved campaign tree from validated JSON', async () => {
    const inputPath = path.join(tmpDir, 'activate-tree.json')
    const request = {
      operationKey: 'weekend:activate-tree:1',
      grantId: 'grant_1',
      manifestHash: ACTIVATION_MANIFEST_HASH,
    }
    fs.writeFileSync(inputPath, JSON.stringify(request))
    mockActivateAdsCampaignTree.mockResolvedValue(ACTIVATED_TREE)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsCampaignActivateTree('canonry-audit', 'cmpn_1', { input: inputPath })

    expect(mockActivateAdsCampaignTree).toHaveBeenCalledWith('canonry-audit', 'cmpn_1', request)
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Activation weekend:activate-tree:1: succeeded',
      'Steps:      3/3 active',
    ])
  })

  it('emits a campaign-tree activation response as machine JSON', async () => {
    const inputPath = path.join(tmpDir, 'activate-tree-json.json')
    fs.writeFileSync(inputPath, JSON.stringify({
      operationKey: 'weekend:activate-tree:1',
      grantId: 'grant_1',
      manifestHash: ACTIVATION_MANIFEST_HASH,
    }))
    mockActivateAdsCampaignTree.mockResolvedValue(ACTIVATED_TREE)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsCampaignActivateTree('canonry-audit', 'cmpn_1', {
      input: inputPath,
      format: 'json',
    })

    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(ACTIVATED_TREE)
  })

  it('registers the planning reads and complete lifecycle CLI surface', () => {
    const paths = new Set(ADS_CLI_COMMANDS.map((command) => command.path.join(' ')))
    for (const command of [
      'ads account',
      'ads geo search',
      'ads conversions pixels',
      'ads conversions event-settings',
      'ads delivery-diagnostics',
      'ads operations unresolved',
      'ads operation',
      'ads operation reconcile',
      'ads operation resume-activation',
      'ads activation-grant create',
      'ads activation-grant revoke',
      'ads image upload',
      'ads campaign create',
      'ads campaign update',
      'ads campaign activate-tree',
      'ads campaign pause',
      'ads ad-group create',
      'ads ad-group update',
      'ads ad-group pause',
      'ads ad create',
      'ads ad update',
      'ads ad pause',
    ]) {
      expect(paths).toContain(command)
    }
  })
})

describe('ads summary', () => {
  const summary: AdsSummaryDto = {
    connected: true,
    displayName: 'Harbor Hotel',
    currencyCode: 'USD',
    lastSyncedAt: '2026-08-25T12:00:00.000Z',
    campaignCount: 1,
    adGroupCount: 2,
    adCount: 3,
    window: { from: '2026-08-01', to: '2026-08-24', inProgressDate: null },
    totals: { impressions: 440, clicks: 20, spendMicros: 6_000_000, conversions: 1, ctr: 20 / 440, cpcMicros: 300_000 },
  }

  async function summaryLines(dto: AdsSummaryDto): Promise<string[]> {
    mockGetAdsSummary.mockResolvedValue(dto)
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    try {
      await adsSummary('demo')
    } finally {
      log.mockRestore()
    }
    return lines
  }

  it('prints the 0..1 CTR through formatPercent', async () => {
    // 20 / 440 is 4.545...%: one decimal, half up on the tenth.
    expect(await summaryLines(summary)).toContain('Clicks:       20 (CTR 4.5%)')
  })

  it('omits the CTR when there were no impressions to divide by', async () => {
    const lines = await summaryLines({ ...summary, totals: { ...summary.totals, impressions: 0, clicks: 0, ctr: null } })
    expect(lines).toContain('Clicks:       0')
  })
})
