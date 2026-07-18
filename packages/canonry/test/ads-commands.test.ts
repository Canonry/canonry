import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AdsAccountDto,
  AdsConversionEventSettingListResponse,
  AdsConversionPixelListResponse,
  AdsGeoSearchResponse,
  AdsOperationReconcileResponse,
  AdsOperationResponse,
  AdsUnresolvedOperationListResponse,
} from '@ainyc/canonry-contracts'

const mockCreateAdsCampaign = vi.fn()
const mockUpdateAdsCampaign = vi.fn()
const mockGetAdsAccount = vi.fn()
const mockSearchAdsGeo = vi.fn()
const mockGetAdsConversionPixels = vi.fn()
const mockGetAdsConversionEventSettings = vi.fn()
const mockGetUnresolvedAdsOperations = vi.fn()
const mockReconcileAdsOperation = vi.fn()

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
    getUnresolvedAdsOperations: mockGetUnresolvedAdsOperations,
    reconcileAdsOperation: mockReconcileAdsOperation,
  }),
}))

const {
  adsAccount,
  adsCampaignCreate,
  adsCampaignUpdate,
  adsConversionEventSettings,
  adsConversionPixels,
  adsGeoSearch,
  adsOperationReconcile,
  adsOperationsUnresolved,
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

  it('registers the planning reads and complete lifecycle CLI surface', () => {
    const paths = new Set(ADS_CLI_COMMANDS.map((command) => command.path.join(' ')))
    for (const command of [
      'ads account',
      'ads geo search',
      'ads conversions pixels',
      'ads conversions event-settings',
      'ads operations unresolved',
      'ads operation',
      'ads operation reconcile',
      'ads image upload',
      'ads campaign create',
      'ads campaign update',
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
