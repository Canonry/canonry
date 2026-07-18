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
const mockGetAdsOperation = vi.fn()
const mockGetUnresolvedAdsOperations = vi.fn()
const mockReconcileAdsOperation = vi.fn()
const mockResumeAdsActivation = vi.fn()
const mockCreateAdsActivationGrant = vi.fn()
const mockRevokeAdsActivationGrant = vi.fn()
const mockActivateAdsCampaignTree = vi.fn()

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
    getAdsOperation: mockGetAdsOperation,
    getUnresolvedAdsOperations: mockGetUnresolvedAdsOperations,
    reconcileAdsOperation: mockReconcileAdsOperation,
    resumeAdsActivation: mockResumeAdsActivation,
    createAdsActivationGrant: mockCreateAdsActivationGrant,
    revokeAdsActivationGrant: mockRevokeAdsActivationGrant,
    activateAdsCampaignTree: mockActivateAdsCampaignTree,
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
  adsGeoSearch,
  adsOperationGet,
  adsOperationReconcile,
  adsOperationResumeActivation,
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

    expect(mockCreateAdsActivationGrant).toHaveBeenCalledWith('canonry-audit', request)
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
