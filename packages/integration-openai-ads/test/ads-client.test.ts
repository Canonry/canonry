import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getAdAccount,
  listCampaigns,
  listAdGroups,
  listAds,
  getAdAccountInsights,
  getCampaignInsights,
  getAdGroupInsights,
} from '../src/ads-client.js'
import { OPENAI_ADS_API_BASE } from '../src/constants.js'
import {
  FIXTURE_AD_ACCOUNT,
  FIXTURE_AD_GROUP,
  FIXTURE_AD,
  FIXTURE_CAMPAIGN,
  FIXTURE_ERROR_401,
  FIXTURE_ERROR_BAD_FIELDS,
  FIXTURE_ERROR_MISSING_PARAM,
  FIXTURE_INSIGHT_ROW_DEFAULT,
  FIXTURE_INSIGHT_ROW_FULL,
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
