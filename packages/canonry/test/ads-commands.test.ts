import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdsOperationResponse } from '@ainyc/canonry-contracts'

const mockCreateAdsCampaign = vi.fn()
const mockUpdateAdsCampaign = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    createAdsCampaign: mockCreateAdsCampaign,
    updateAdsCampaign: mockUpdateAdsCampaign,
  }),
}))

const { adsCampaignCreate, adsCampaignUpdate } = await import('../src/commands/ads.js')
const { ADS_CLI_COMMANDS } = await import('../src/cli-commands/ads.js')

const RECEIPT: AdsOperationResponse = {
  replayed: false,
  operation: {
    id: 'op_1',
    operationKey: 'weekend:campaign:1',
    kind: 'campaign_create',
    state: 'succeeded',
    entityType: 'campaign',
    entityId: 'cmpn_1',
    upstreamUpdatedAt: 123,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:01.000Z',
  },
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
    }))
    mockCreateAdsCampaign.mockResolvedValue(RECEIPT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await adsCampaignCreate('canonry-audit', { input: inputPath, format: 'json' })

    expect(mockCreateAdsCampaign).toHaveBeenCalledWith('canonry-audit', {
      operationKey: 'weekend:campaign:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['3000001'],
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

  it('registers the complete create, update, pause, and receipt CLI surface', () => {
    const paths = new Set(ADS_CLI_COMMANDS.map((command) => command.path.join(' ')))
    for (const command of [
      'ads operation',
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
