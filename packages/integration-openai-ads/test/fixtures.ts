// Fixtures mirror REAL OpenAI Advertiser API responses captured live on
// 2026-06-10 (curl against an active ad account). Identifiers, names, URLs,
// and copy are sanitized; field names, nesting, envelope shape, value types,
// and unit quirks (micros vs decimal dollars) are verbatim from production.
// Never add a field here that has not been observed in a captured response.

import type {
  OpenAiAdsAccount,
  OpenAiAdsAd,
  OpenAiAdsAdGroup,
  OpenAiAdsCampaign,
  OpenAiAdsInsightRow,
  OpenAiAdsListResponse,
} from '../src/types.js'

export const FIXTURE_AD_ACCOUNT: OpenAiAdsAccount = {
  id: 'adacct_0000000000000000000000000000aaaa',
  status: 'active',
  account_integrity_review: {
    details: {
      decision: 'allowed',
      reason: 'Low risk: established business with an official site and third-party validation.',
      status_updated_at: '2026-06-03T18:57:34.397908+00:00',
    },
    review: { status: 'approved' },
  },
  currency_code: 'USD',
  name: 'Acme Exteriors, Inc',
  preview_url: 'https://bzrcdn.openai.com/0000000000000000.png',
  review: { status: 'approved' },
  timezone: 'America/Denver',
  url: 'https://acme-exteriors.example/',
}

export const FIXTURE_CAMPAIGN: OpenAiAdsCampaign = {
  id: 'cmpn_0000000000000000000000000000bbbb',
  created_at: 1780770653,
  status: 'active',
  bidding_type: 'clicks',
  budget: { daily_spend_limit_micros: 150000000 },
  conversion_event_setting_ids: ['0000000000000000000000000000cccc'],
  description: null,
  end_time: null,
  landing_page_configuration: null,
  mode: null,
  name: 'Homeowners Free Estimate',
  start_time: 1780770127,
  targeting: {
    locations: {
      include: [
        { id: '1000232', type: 'country', country_code: 'US', name: 'United States', region_code: null },
        { id: '1000037', type: 'country', country_code: 'CA', name: 'Canada', region_code: null },
      ],
    },
  },
  updated_at: 1780868842,
}

export const FIXTURE_AD_GROUP: OpenAiAdsAdGroup = {
  id: 'adgrp_0000000000000000000000000000dddd',
  created_at: 1780770657,
  status: 'active',
  bidding_config: {
    billing_event_type: 'click',
    max_bid_micros: 2000000,
  },
  // Live format: ONE multi-line string of newline-separated example queries —
  // not one hint per array element, and not prose descriptions.
  context_hints: [
    'how much does a new deck cost for my house\nhow much material do I need for a deck\nwhat size deck fits my yard\ncomposite vs wood deck for my home\nhow many boards do I need for a deck\nmeasure my yard to plan materials',
  ],
  description: null,
  name: 'Deck Project Planning',
  product_set: null,
  updated_at: 1780864410,
}

export const FIXTURE_AD: OpenAiAdsAd = {
  id: 'ad_0000000000000000000000000000eeee',
  created_at: 1780770662,
  status: 'active',
  creative: {
    type: 'chat_card',
    body: 'Know how much material you need, from a free measurement.',
    file_id: 'file_0000000000000000000000000000ffff',
    target_url: 'https://lp.acme-exteriors.example/free-estimate?utm_source=chatgpt&utm_medium=cpc',
    title: 'Free Estimate For Materials',
  },
  name: 'HO Deck - Materials',
  review: { status: 'approved' },
  review_status: 'approved',
  updated_at: 1781139491,
}

// Default insights response (no fields[] requested) carries impressions only.
export const FIXTURE_INSIGHT_ROW_DEFAULT: OpenAiAdsInsightRow = {
  id: 'start=1781071200:end=1781157600:entity_id=adacct_0000000000000000000000000000aaaa',
  ad_account_name: 'Acme Exteriors, Inc',
  end_time: 1781157600,
  impressions: 2061,
  readable_time: '2026-06-10',
  start_time: 1781071200,
}

// With fields[]= requested: clicks/ctr/cpc/spend appear; spend and cpc are
// DECIMAL DOLLARS (not micros) in production responses.
export const FIXTURE_INSIGHT_ROW_FULL: OpenAiAdsInsightRow = {
  id: 'start=1781071200:end=1781157600:entity_id=cmpn_0000000000000000000000000000bbbb',
  campaign_name: 'Homeowners Free Estimate',
  clicks: 23,
  cpc: 1.71,
  ctr: 0.0132,
  end_time: 1781157600,
  impressions: 1736,
  readable_time: '2026-06-10',
  spend: 39.28,
  start_time: 1781071200,
}

export function makeListResponse<T>(
  data: T[],
  overrides: Partial<Omit<OpenAiAdsListResponse<T>, 'data'>> = {},
): OpenAiAdsListResponse<T> {
  const ids = data as Array<{ id?: string }>
  return {
    object: 'list',
    data,
    first_id: ids[0]?.id ?? null,
    last_id: ids[ids.length - 1]?.id ?? null,
    has_more: false,
    ...overrides,
  }
}

// Real 401 body (no/invalid Authorization), captured verbatim.
export const FIXTURE_ERROR_401 = {
  error: {
    message: 'Missing or invalid SDK key in Authorization header.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
}

// Real 400 body for a list endpoint missing its required parent filter.
export const FIXTURE_ERROR_MISSING_PARAM = {
  error: {
    message: "Missing required parameter: 'campaign_id'.",
    type: 'invalid_request_error',
    param: 'campaign_id',
    code: 'missing_required_parameter',
  },
}

// Real 400 body for an invalid fields[] name — the message enumerates the
// valid catalog (truncated here; structure verbatim, code is null upstream).
export const FIXTURE_ERROR_BAD_FIELDS = {
  error: {
    message:
      '400: Each value in fields must be one of: ad_account.id, campaign.clicks, campaign.impressions, campaign.spend, metadata.readable_time',
    type: 'server_error',
    param: null,
    code: null,
  },
}
