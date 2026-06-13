// Types mirror OpenAI Advertiser API responses captured live on 2026-06-10.
// Money units are mixed upstream and preserved as-is here: budgets/bids are
// integer micros, insights spend/cpc are decimal dollars. Normalize at ingest.

export interface OpenAiAdsListResponse<T> {
  object: 'list'
  data: T[]
  first_id: string | null
  last_id: string | null
  has_more: boolean
  count?: number
}

export interface OpenAiAdsReviewState {
  status: string
}

export interface OpenAiAdsAccount {
  id: string
  status: string
  name: string
  currency_code: string
  timezone: string
  url: string | null
  review?: OpenAiAdsReviewState
  account_integrity_review?: unknown
  preview_url?: string | null
}

export interface OpenAiAdsCampaignBudget {
  daily_spend_limit_micros?: number
  lifetime_spend_limit_micros?: number
}

export interface OpenAiAdsLocationTarget {
  id: string
  type: string
  country_code: string | null
  name: string | null
  region_code: string | null
}

export interface OpenAiAdsTargeting {
  locations?: {
    include?: OpenAiAdsLocationTarget[]
    exclude?: OpenAiAdsLocationTarget[]
  }
}

export interface OpenAiAdsCampaign {
  id: string
  name: string
  status: string
  bidding_type: string | null
  budget: OpenAiAdsCampaignBudget | null
  conversion_event_setting_ids: string[] | null
  description: string | null
  start_time: number | null
  end_time: number | null
  landing_page_configuration: unknown
  mode: string | null
  targeting: OpenAiAdsTargeting | null
  created_at: number
  updated_at: number
}

export interface OpenAiAdsBiddingConfig {
  billing_event_type: string | null
  max_bid_micros: number | null
}

export interface OpenAiAdsAdGroup {
  id: string
  name: string
  status: string
  bidding_config: OpenAiAdsBiddingConfig | null
  // Live format: each entry is a multi-line string of newline-separated
  // example queries (typically one entry per ad group).
  context_hints: string[]
  description: string | null
  product_set: unknown
  created_at: number
  updated_at: number
}

export interface OpenAiAdsCreative {
  type: string
  title?: string | null
  body?: string | null
  file_id?: string | null
  target_url?: string | null
}

export interface OpenAiAdsAd {
  id: string
  name: string
  status: string
  creative: OpenAiAdsCreative | null
  review?: OpenAiAdsReviewState
  review_status?: string
  created_at: number
  updated_at: number
}

// One row per time bucket (daily granularity observed). Metric fields appear
// only when requested via fields[]; default responses carry impressions only.
export interface OpenAiAdsInsightRow {
  id: string
  start_time: number
  end_time: number
  readable_time?: string
  impressions?: number
  clicks?: number
  spend?: number
  ctr?: number
  cpc?: number
  cpm?: number
  ad_account_name?: string
  campaign_name?: string
}

export interface OpenAiAdsInsightsOptions {
  // Namespaced field names, e.g. 'campaign.clicks', 'ad_group.spend',
  // 'metadata.readable_time'. Invalid names get a 400 whose message
  // enumerates the valid catalog.
  fields?: string[]
  // Trailing-window bounds (YYYY-MM-DD, account timezone, inclusive). The
  // sync re-pulls a window so lagging recent days settle on later runs.
  // NOTE: the start_date/end_date param names are the documented convention
  // but were NOT present in the 2026-06-10 capture — confirm against a live
  // request before relying on them (a wrong param may 400 or be ignored).
  startDate?: string
  endDate?: string
}

interface OpenAiAdsErrorEnvelope {
  error?: {
    message?: string
    type?: string
    param?: string | null
    code?: string | null
  }
}

export class OpenAiAdsApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'OpenAiAdsApiError'
    this.status = status
    this.code = code
  }
}

export function parseErrorEnvelope(body: string): { message: string | null; code: string | null } {
  try {
    const parsed = JSON.parse(body) as OpenAiAdsErrorEnvelope
    return {
      message: parsed.error?.message ?? null,
      code: parsed.error?.code ?? null,
    }
  } catch {
    return { message: null, code: null }
  }
}
