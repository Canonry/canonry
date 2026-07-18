import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  activateAd,
  activateAdGroup,
  activateCampaign,
  createAd,
  createAdGroup,
  createCampaign,
  getAd,
  getAdAccount,
  getAdGroup,
  getCampaign,
  listConversionEventSettings,
  listConversionPixels,
  listCampaigns,
  listAdGroups,
  listAds,
  getAdAccountInsights,
  getCampaignInsights,
  getAdGroupInsights,
  pauseAd,
  pauseAdGroup,
  pauseCampaign,
  searchGeoLocations,
  updateAd,
  updateAdGroup,
  updateCampaign,
  uploadImageFromUrl,
} from '../src/ads-client.js'
import { OPENAI_ADS_API_BASE } from '../src/constants.js'
import {
  OpenAiAdsBillingEventTypes,
  OpenAiAdsCreativeTypes,
  OpenAiAdsWriteStatuses,
} from '../src/types.js'
import type {
  OpenAiAdsCreateAdGroupRequest,
  OpenAiAdsCreateAdRequest,
  OpenAiAdsCreateCampaignRequest,
} from '../src/types.js'
import {
  FIXTURE_AD_ACCOUNT,
  FIXTURE_AD_GROUP,
  FIXTURE_AD,
  FIXTURE_CAMPAIGN,
  FIXTURE_EMPTY_CONVERSION_EVENT_SETTINGS,
  FIXTURE_EMPTY_CONVERSION_PIXELS,
  FIXTURE_ERROR_401,
  FIXTURE_ERROR_BAD_FIELDS,
  FIXTURE_ERROR_MISSING_PARAM,
  FIXTURE_INSIGHT_ROW_DEFAULT,
  FIXTURE_INSIGHT_ROW_FULL,
  FIXTURE_GEO_SEARCH,
  makeListResponse,
} from './fixtures.js'

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOnce(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), { status })
  }
  return calls
}

function expectJsonPost(call: { url: string; init?: RequestInit }, path: string, body?: unknown): void {
  expect(call.url).toBe(`${OPENAI_ADS_API_BASE}/${path}`)
  expect(call.init?.method).toBe('POST')
  if (body === undefined) {
    expect(call.init?.body).toBeUndefined()
  } else {
    expect(JSON.parse(String(call.init?.body))).toEqual(body)
  }
}

const CREATE_CAMPAIGN_REQUEST: OpenAiAdsCreateCampaignRequest = {
  name: 'AEO audit leads',
  description: 'Promote the free AEO audit.',
  start_time: 1_780_770_127,
  end_time: 1_781_374_527,
  status: OpenAiAdsWriteStatuses.paused,
  budget: { lifetime_spend_limit_micros: 25_000_000 },
  targeting: { locations: { include: [{ id: '1000232' }] } },
}

const CREATE_AD_GROUP_REQUEST: OpenAiAdsCreateAdGroupRequest = {
  campaign_id: FIXTURE_CAMPAIGN.id,
  name: 'AEO service research',
  description: 'People researching AEO services.',
  context_hints: ['how do I improve visibility in ChatGPT', 'best AEO agency'],
  status: OpenAiAdsWriteStatuses.paused,
  bidding_config: {
    billing_event_type: OpenAiAdsBillingEventTypes.impression,
    max_bid_micros: 60_000,
  },
}

const CREATE_AD_REQUEST: OpenAiAdsCreateAdRequest = {
  ad_group_id: FIXTURE_AD_GROUP.id,
  name: 'Free AEO audit card',
  status: OpenAiAdsWriteStatuses.paused,
  creative: {
    type: OpenAiAdsCreativeTypes.chatCard,
    title: 'See how AI reads your site',
    body: 'Run a free AEO audit and get your top three fixes.',
    target_url: 'https://canonry.ai/audit?utm_source=chatgpt&utm_medium=paid',
    file_id: 'file_0000000000000000000000000000ffff',
  },
}

describe('getAdAccount', () => {
  it('sends a Bearer Authorization header and parses the account', async () => {
    const calls = mockFetchOnce(FIXTURE_AD_ACCOUNT)

    const account = await getAdAccount('test-key')

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ad_account`)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(account.id).toBe(FIXTURE_AD_ACCOUNT.id)
    expect(account.currency_code).toBe('USD')
    expect(account.timezone).toBe('America/Denver')
    expect(account.account_integrity_review?.details?.decision).toBe('allowed')
    expect(account.account_integrity_review?.review?.status).toBe('approved')
  })

  it('throws OpenAiAdsApiError with the upstream code on 401', async () => {
    mockFetchOnce(FIXTURE_ERROR_401, 401)

    await expect(() => getAdAccount('bad-key')).rejects.toMatchObject({
      name: 'OpenAiAdsApiError',
      status: 401,
      code: 'invalid_api_key',
    })
    mockFetchOnce(FIXTURE_ERROR_401, 401)
    await expect(() => getAdAccount('bad-key')).rejects.toThrow(/invalid or unauthorized/)
  })

  it('throws a rate-limit error on 429', async () => {
    mockFetchOnce({ error: { message: 'Too many requests', type: 'rate_limit_error', param: null, code: null } }, 429)

    await expect(() => getAdAccount('key')).rejects.toMatchObject({ status: 429 })
    mockFetchOnce({ error: { message: 'Too many requests', type: 'rate_limit_error', param: null, code: null } }, 429)
    await expect(() => getAdAccount('key')).rejects.toThrow(/rate limit/)
  })

  it('throws a 502-style error on invalid JSON', async () => {
    globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 200 })

    await expect(() => getAdAccount('key')).rejects.toMatchObject({ status: 502 })
  })

  it('rejects an empty API key before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_AD_ACCOUNT)

    await expect(() => getAdAccount('')).rejects.toMatchObject({ status: 400 })
    expect(calls.length).toBe(0)
  })
})

describe('planning reads', () => {
  it('searches geo locations with an encoded query and bounded limit', async () => {
    const calls = mockFetchOnce(FIXTURE_GEO_SEARCH)

    const response = await searchGeoLocations('test-key', 'San Francisco, CA', 5)

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/geo_lookup/search?q=San%20Francisco%2C%20CA&limit=5`)
    expect(response.results[0]).toMatchObject({
      canonical_name: 'San Francisco, California, United States',
      country_code: 'US',
      region_code: 'CA',
    })
  })

  it('rejects a blank geo query before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_GEO_SEARCH)

    await expect(() => searchGeoLocations('test-key', '   ')).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('rejects an out-of-range geo limit before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_GEO_SEARCH)

    await expect(() => searchGeoLocations('test-key', 'San Francisco', 0)).rejects.toMatchObject({ status: 400 })
    await expect(() => searchGeoLocations('test-key', 'San Francisco', 501)).rejects.toMatchObject({ status: 400 })
    await expect(() => searchGeoLocations('test-key', 'San Francisco', 1.5)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('lists conversion pixels using the confirmed empty live envelope', async () => {
    const calls = mockFetchOnce(FIXTURE_EMPTY_CONVERSION_PIXELS)

    const pixels = await listConversionPixels('test-key')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/conversions/pixels`)
    expect(pixels).toEqual([])
  })

  it('lists conversion event settings using the confirmed empty live envelope', async () => {
    const calls = mockFetchOnce(FIXTURE_EMPTY_CONVERSION_EVENT_SETTINGS)

    const settings = await listConversionEventSettings('test-key')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/conversions/event_settings`)
    expect(settings).toEqual([])
  })
})

describe('listCampaigns', () => {
  it('parses the list envelope and returns the campaigns', async () => {
    mockFetchOnce(makeListResponse([FIXTURE_CAMPAIGN]))

    const campaigns = await listCampaigns('test-key')

    expect(campaigns.length).toBe(1)
    expect(campaigns[0]!.id).toBe(FIXTURE_CAMPAIGN.id)
    // budgets are integer micros upstream — assert the unit survives untouched
    expect(campaigns[0]!.budget?.daily_spend_limit_micros).toBe(150000000)
    expect(campaigns[0]!.targeting?.locations?.include?.[0]?.country_code).toBe('US')
  })

  it('follows cursor pagination via after= until has_more is false', async () => {
    const page1 = makeListResponse([{ ...FIXTURE_CAMPAIGN, id: 'cmpn_page1' }], {
      has_more: true,
      last_id: 'cmpn_page1',
    })
    const page2 = makeListResponse([{ ...FIXTURE_CAMPAIGN, id: 'cmpn_page2' }])
    const urls: string[] = []
    let call = 0
    globalThis.fetch = async (url: string | URL | Request) => {
      urls.push(String(url))
      call += 1
      return new Response(JSON.stringify(call === 1 ? page1 : page2), { status: 200 })
    }

    const campaigns = await listCampaigns('test-key')

    expect(campaigns.map((c) => c.id)).toEqual(['cmpn_page1', 'cmpn_page2'])
    expect(urls.length).toBe(2)
    expect(urls[0]).not.toContain('after=')
    expect(urls[1]).toContain('after=cmpn_page1')
  })

  it('stops when has_more is false even though last_id is set', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_CAMPAIGN]))

    await listCampaigns('test-key')

    expect(calls.length).toBe(1)
  })
})

describe('listAdGroups', () => {
  it('requires campaign_id in the query and preserves context_hints verbatim', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_AD_GROUP]))

    const adGroups = await listAdGroups('test-key', 'cmpn_abc')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ad_groups?campaign_id=cmpn_abc`)
    expect(adGroups[0]!.context_hints).toEqual(FIXTURE_AD_GROUP.context_hints)
    // live format: one multi-line string of newline-separated example queries
    expect(adGroups[0]!.context_hints[0]).toContain('\n')
    expect(adGroups[0]!.bidding_config?.max_bid_micros).toBe(2000000)
  })

  it('rejects an empty campaign id before calling fetch', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_AD_GROUP]))

    await expect(() => listAdGroups('test-key', '')).rejects.toMatchObject({ status: 400 })
    expect(calls.length).toBe(0)
  })

  it('surfaces the upstream missing-parameter error envelope', async () => {
    mockFetchOnce(FIXTURE_ERROR_MISSING_PARAM, 400)

    await expect(() => listAdGroups('test-key', 'cmpn_abc')).rejects.toMatchObject({
      status: 400,
      code: 'missing_required_parameter',
    })
  })
})

describe('listAds', () => {
  it('requires ad_group_id in the query and parses the chat_card creative', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_AD]))

    const ads = await listAds('test-key', 'adgrp_abc')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ads?ad_group_id=adgrp_abc`)
    expect(ads[0]!.creative?.type).toBe('chat_card')
    expect(ads[0]!.creative?.target_url).toContain('utm_source=chatgpt')
    expect(ads[0]!.review_status).toBe('approved')
  })
})

describe('campaign write primitives', () => {
  it('retrieves one campaign by encoded id', async () => {
    const calls = mockFetchOnce(FIXTURE_CAMPAIGN)

    const campaign = await getCampaign('test-key', 'cmpn/abc')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/campaigns/cmpn%2Fabc`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(campaign.id).toBe(FIXTURE_CAMPAIGN.id)
  })

  it('creates a campaign with a typed JSON POST body', async () => {
    const calls = mockFetchOnce({ ...FIXTURE_CAMPAIGN, status: OpenAiAdsWriteStatuses.paused })

    const campaign = await createCampaign('test-key', CREATE_CAMPAIGN_REQUEST)

    expectJsonPost(calls[0]!, 'campaigns', CREATE_CAMPAIGN_REQUEST)
    expect(campaign.status).toBe(OpenAiAdsWriteStatuses.paused)
  })

  it('updates a campaign with POST and the supplied partial body', async () => {
    const request = {
      description: null,
      budget: { lifetime_spend_limit_micros: 30_000_000 },
    }
    const calls = mockFetchOnce({ ...FIXTURE_CAMPAIGN, ...request })

    await updateCampaign('test-key', FIXTURE_CAMPAIGN.id, request)

    expectJsonPost(calls[0]!, `campaigns/${FIXTURE_CAMPAIGN.id}`, request)
  })

  it('uses explicit activate and pause actions without a request body', async () => {
    let calls = mockFetchOnce({ ...FIXTURE_CAMPAIGN, status: OpenAiAdsWriteStatuses.active })
    await activateCampaign('test-key', FIXTURE_CAMPAIGN.id)
    expectJsonPost(calls[0]!, `campaigns/${FIXTURE_CAMPAIGN.id}/activate`)

    calls = mockFetchOnce({ ...FIXTURE_CAMPAIGN, status: OpenAiAdsWriteStatuses.paused })
    await pauseCampaign('test-key', FIXTURE_CAMPAIGN.id)
    expectJsonPost(calls[0]!, `campaigns/${FIXTURE_CAMPAIGN.id}/pause`)
  })

  it('rejects an invalid create budget before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_CAMPAIGN)
    const request = {
      ...CREATE_CAMPAIGN_REQUEST,
      budget: { lifetime_spend_limit_micros: 999_999 },
    }

    await expect(() => createCampaign('test-key', request)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('rejects an empty update body before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_CAMPAIGN)

    await expect(() => updateCampaign('test-key', FIXTURE_CAMPAIGN.id, {})).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('preserves upstream error handling for JSON POST requests', async () => {
    mockFetchOnce(FIXTURE_ERROR_MISSING_PARAM, 400)

    await expect(() => createCampaign('test-key', CREATE_CAMPAIGN_REQUEST)).rejects.toMatchObject({
      status: 400,
      code: 'missing_required_parameter',
    })
  })
})

describe('ad group write primitives', () => {
  it('retrieves one ad group by encoded id', async () => {
    const calls = mockFetchOnce(FIXTURE_AD_GROUP)

    const adGroup = await getAdGroup('test-key', 'adgrp/abc')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ad_groups/adgrp%2Fabc`)
    expect(adGroup.id).toBe(FIXTURE_AD_GROUP.id)
  })

  it('creates and updates an ad group with typed JSON POST bodies', async () => {
    let calls = mockFetchOnce({ ...FIXTURE_AD_GROUP, status: OpenAiAdsWriteStatuses.paused })
    await createAdGroup('test-key', CREATE_AD_GROUP_REQUEST)
    expectJsonPost(calls[0]!, 'ad_groups', CREATE_AD_GROUP_REQUEST)

    const request = {
      context_hints: ['AEO audit', 'ChatGPT visibility audit'],
      bidding_config: {
        billing_event_type: OpenAiAdsBillingEventTypes.impression,
        max_bid_micros: 75_000,
      },
    }
    calls = mockFetchOnce({ ...FIXTURE_AD_GROUP, ...request })
    await updateAdGroup('test-key', FIXTURE_AD_GROUP.id, request)
    expectJsonPost(calls[0]!, `ad_groups/${FIXTURE_AD_GROUP.id}`, request)
  })

  it('uses explicit activate and pause actions without a request body', async () => {
    let calls = mockFetchOnce({ ...FIXTURE_AD_GROUP, status: OpenAiAdsWriteStatuses.active })
    await activateAdGroup('test-key', FIXTURE_AD_GROUP.id)
    expectJsonPost(calls[0]!, `ad_groups/${FIXTURE_AD_GROUP.id}/activate`)

    calls = mockFetchOnce({ ...FIXTURE_AD_GROUP, status: OpenAiAdsWriteStatuses.paused })
    await pauseAdGroup('test-key', FIXTURE_AD_GROUP.id)
    expectJsonPost(calls[0]!, `ad_groups/${FIXTURE_AD_GROUP.id}/pause`)
  })

  it('rejects unsupported billing events before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_AD_GROUP)
    const request = {
      ...CREATE_AD_GROUP_REQUEST,
      bidding_config: {
        ...CREATE_AD_GROUP_REQUEST.bidding_config,
        billing_event_type: 'click',
      },
    }

    await expect(() =>
      createAdGroup('test-key', request as OpenAiAdsCreateAdGroupRequest),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
})

describe('ad write primitives', () => {
  it('retrieves one ad by encoded id', async () => {
    const calls = mockFetchOnce(FIXTURE_AD)

    const ad = await getAd('test-key', 'ad/abc')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ads/ad%2Fabc`)
    expect(ad.review_status).toBe('approved')
  })

  it('creates and updates an ad with complete chat-card creatives', async () => {
    let calls = mockFetchOnce({ ...FIXTURE_AD, status: OpenAiAdsWriteStatuses.paused })
    await createAd('test-key', CREATE_AD_REQUEST)
    expectJsonPost(calls[0]!, 'ads', CREATE_AD_REQUEST)

    const request = {
      name: 'Free AEO audit card v2',
      creative: {
        ...CREATE_AD_REQUEST.creative,
        title: 'Find your top AEO fixes',
      },
    }
    calls = mockFetchOnce({ ...FIXTURE_AD, ...request })
    await updateAd('test-key', FIXTURE_AD.id, request)
    expectJsonPost(calls[0]!, `ads/${FIXTURE_AD.id}`, request)
  })

  it('uses explicit activate and pause actions without a request body', async () => {
    let calls = mockFetchOnce({ ...FIXTURE_AD, status: OpenAiAdsWriteStatuses.active })
    await activateAd('test-key', FIXTURE_AD.id)
    expectJsonPost(calls[0]!, `ads/${FIXTURE_AD.id}/activate`)

    calls = mockFetchOnce({ ...FIXTURE_AD, status: OpenAiAdsWriteStatuses.paused })
    await pauseAd('test-key', FIXTURE_AD.id)
    expectJsonPost(calls[0]!, `ads/${FIXTURE_AD.id}/pause`)
  })

  it('rejects an invalid chat-card target URL before calling fetch', async () => {
    const calls = mockFetchOnce(FIXTURE_AD)
    const request = {
      ...CREATE_AD_REQUEST,
      creative: { ...CREATE_AD_REQUEST.creative, target_url: 'javascript:alert(1)' },
    }

    await expect(() => createAd('test-key', request)).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
})

describe('uploadImageFromUrl', () => {
  it('uploads a remote image with JSON and returns the documented file id', async () => {
    const calls = mockFetchOnce({ file_id: 'file_901' })

    const result = await uploadImageFromUrl('test-key', 'https://canonry.ai/ads/aeo-audit-card.png')

    expectJsonPost(calls[0]!, 'upload', { image_url: 'https://canonry.ai/ads/aeo-audit-card.png' })
    expect(result).toEqual({ file_id: 'file_901' })
  })

  it('rejects a non-HTTP image URL before calling fetch', async () => {
    const calls = mockFetchOnce({ file_id: 'file_901' })

    await expect(() => uploadImageFromUrl('test-key', 'file:///tmp/card.png')).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })
})

describe('insights', () => {
  it('returns default rows (impressions only) when no fields are requested', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_INSIGHT_ROW_DEFAULT]))

    const rows = await getAdAccountInsights('test-key')

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ad_account/insights`)
    expect(rows[0]!.impressions).toBe(2061)
    expect(rows[0]!.clicks).toBeUndefined()
  })

  it('serializes fields as literal fields[]= pairs in request order', async () => {
    const calls = mockFetchOnce(makeListResponse([FIXTURE_INSIGHT_ROW_FULL]))

    const rows = await getCampaignInsights('test-key', 'cmpn_abc', {
      fields: ['campaign.impressions', 'campaign.clicks', 'campaign.spend', 'metadata.readable_time'],
    })

    // The live API was exercised with literal bracket pairs — keep them
    // unencoded so the client sends exactly what was verified.
    expect(calls[0]!.url).toBe(
      `${OPENAI_ADS_API_BASE}/campaigns/cmpn_abc/insights?fields[]=campaign.impressions&fields[]=campaign.clicks&fields[]=campaign.spend&fields[]=metadata.readable_time`,
    )
    // spend/cpc are decimal dollars upstream — assert they pass through untouched
    expect(rows[0]!.spend).toBe(39.28)
    expect(rows[0]!.cpc).toBe(1.71)
    expect(rows[0]!.readable_time).toBe('2026-06-10')
  })

  it('supports ad-group-level insights', async () => {
    const calls = mockFetchOnce(
      makeListResponse([{ ...FIXTURE_INSIGHT_ROW_FULL, id: 'start=1:end=2:entity_id=adgrp_abc' }]),
    )

    await getAdGroupInsights('test-key', 'adgrp_abc', { fields: ['ad_group.impressions'] })

    expect(calls[0]!.url).toBe(`${OPENAI_ADS_API_BASE}/ad_groups/adgrp_abc/insights?fields[]=ad_group.impressions`)
  })

  it('surfaces the invalid-fields 400 with its catalog message', async () => {
    mockFetchOnce(FIXTURE_ERROR_BAD_FIELDS, 400)

    await expect(() =>
      getCampaignInsights('test-key', 'cmpn_abc', { fields: ['impressions'] }),
    ).rejects.toThrow(/Each value in fields must be one of/)
  })

  it('paginates insights like every other list', async () => {
    const page1 = makeListResponse([{ ...FIXTURE_INSIGHT_ROW_FULL, id: 'row-1' }], {
      has_more: true,
      last_id: 'row-1',
    })
    const page2 = makeListResponse([{ ...FIXTURE_INSIGHT_ROW_FULL, id: 'row-2' }])
    const urls: string[] = []
    let call = 0
    globalThis.fetch = async (url: string | URL | Request) => {
      urls.push(String(url))
      call += 1
      return new Response(JSON.stringify(call === 1 ? page1 : page2), { status: 200 })
    }

    const rows = await getAdAccountInsights('test-key', { fields: ['ad_account.id'] })

    expect(rows.map((r) => r.id)).toEqual(['row-1', 'row-2'])
    expect(urls[1]).toContain('fields[]=ad_account.id')
    expect(urls[1]).toContain('after=row-1')
  })
})
