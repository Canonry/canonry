import { afterEach, describe, expect, it } from 'vitest'
import * as publicApi from '../src/index.js'
import type {
  OpenAiAdsCreateAdGroupRequest,
  OpenAiAdsCreateAdRequest,
  OpenAiAdsCreateCampaignRequest,
  OpenAiAdsUpdateAdGroupRequest,
  OpenAiAdsUpdateAdRequest,
  OpenAiAdsUpdateCampaignRequest,
} from '../src/index.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function installFetchTrap(): unknown[] {
  const calls: unknown[] = []
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return new Response('{}')
  }
  return calls
}

describe('public package API', () => {
  it('exposes the read-only account, geo, and conversion planning surface', () => {
    expect(publicApi).toMatchObject({
      getAdAccount: expect.any(Function),
      searchGeoLocations: expect.any(Function),
      listConversionPixels: expect.any(Function),
      listConversionEventSettings: expect.any(Function),
    })
  })

  it('exports the closed click and impression bidding vocabulary', () => {
    expect(publicApi.OpenAiAdsBiddingTypes).toEqual({
      impressions: 'impressions',
      clicks: 'clicks',
    })
    expect(publicApi.OpenAiAdsBillingEventTypes).toEqual({
      impression: 'impression',
      click: 'click',
    })
  })

  it('exposes pause but not activation primitives', () => {
    expect(publicApi).toMatchObject({
      pauseCampaign: expect.any(Function),
      pauseAdGroup: expect.any(Function),
      pauseAd: expect.any(Function),
    })
    expect(Object.keys(publicApi)).not.toEqual(expect.arrayContaining([
      'activateCampaign',
      'activateAdGroup',
      'activateAd',
    ]))
  })

  it('rejects lifecycle status smuggled into public updates before fetch', async () => {
    const calls = installFetchTrap()

    await expect(publicApi.updateCampaign('key', 'campaign', {
      status: 'active',
    } as unknown as OpenAiAdsUpdateCampaignRequest)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.updateAdGroup('key', 'ad-group', {
      status: 'active',
    } as unknown as OpenAiAdsUpdateAdGroupRequest)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.updateAd('key', 'ad', {
      status: 'active',
    } as unknown as OpenAiAdsUpdateAdRequest)).rejects.toMatchObject({ status: 400 })

    expect(calls).toHaveLength(0)
  })

  it('rejects clearing campaign geo targeting before fetch', async () => {
    const calls = installFetchTrap()

    await expect(publicApi.updateCampaign('key', 'campaign', {
      targeting: null,
    } as unknown as OpenAiAdsUpdateCampaignRequest)).rejects.toMatchObject({ status: 400 })

    expect(calls).toHaveLength(0)
  })

  it('validates the exact serialized body before fetch', async () => {
    const calls = installFetchTrap()
    const createRequest = {
      name: 'AEO audit leads',
      status: 'paused',
      budget: { lifetime_spend_limit_micros: 25_000_000 },
      targeting: { locations: { include: [{ id: '3000001' }] } },
      toJSON() {
        return { ...this, status: 'active', toJSON: undefined }
      },
    } as unknown as OpenAiAdsCreateCampaignRequest
    const updateRequest = {
      name: 'AEO audit leads v2',
      toJSON() {
        return { status: 'active' }
      },
    } as unknown as OpenAiAdsUpdateCampaignRequest
    const targetingRequest = {
      name: 'AEO audit leads v2',
      toJSON() {
        return { targeting: null }
      },
    } as unknown as OpenAiAdsUpdateCampaignRequest

    await expect(publicApi.createCampaign('key', createRequest)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.updateCampaign('key', 'campaign', updateRequest)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.updateCampaign('key', 'campaign', targetingRequest)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('rejects active public creates before fetch', async () => {
    const calls = installFetchTrap()
    const campaign = {
      name: 'AEO audit leads',
      status: 'active',
      budget: { lifetime_spend_limit_micros: 25_000_000 },
      targeting: { locations: { include: [{ id: '3000001' }] } },
    } as unknown as OpenAiAdsCreateCampaignRequest
    const adGroup = {
      campaign_id: 'campaign',
      name: 'AEO service research',
      status: 'active',
      bidding_config: { billing_event_type: 'impression', max_bid_micros: 60_000 },
    } as unknown as OpenAiAdsCreateAdGroupRequest
    const ad = {
      ad_group_id: 'ad-group',
      name: 'Free AEO audit card',
      status: 'active',
      creative: {
        type: 'chat_card',
        title: 'See how AI reads your site',
        body: 'Run a free AEO audit.',
        target_url: 'https://canonry.ai/audit',
        file_id: 'file_1',
      },
    } as unknown as OpenAiAdsCreateAdRequest

    await expect(publicApi.createCampaign('key', campaign)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.createAdGroup('key', adGroup)).rejects.toMatchObject({ status: 400 })
    await expect(publicApi.createAd('key', ad)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
})
