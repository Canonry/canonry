import { OPENAI_ADS_API_BASE, OPENAI_ADS_MAX_PAGES, OPENAI_ADS_REQUEST_TIMEOUT_MS } from './constants.js'
import type {
  OpenAiAdsAccount,
  OpenAiAdsAd,
  OpenAiAdsAdGroup,
  OpenAiAdsCampaign,
  OpenAiAdsInsightRow,
  OpenAiAdsInsightsOptions,
  OpenAiAdsListResponse,
} from './types.js'
import { OpenAiAdsApiError, parseErrorEnvelope } from './types.js'

function validateApiKey(apiKey: string): void {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new OpenAiAdsApiError('API key is required and must be a non-empty string', 400)
  }
}

function validateId(value: string, label: string): void {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenAiAdsApiError(`${label} is required and must be a non-empty string`, 400)
  }
}

function adsClientLog(level: 'info' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module: 'OpenAiAdsClient',
    action,
    ...ctx,
  }
  if (entry.apiKey) entry.apiKey = '***'

  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

// Query pairs are pre-encoded strings (e.g. 'fields[]=campaign.clicks').
// The live API was exercised with literal bracket pairs, so the client sends
// exactly that form rather than URLSearchParams' percent-encoded brackets.
function buildUrl(path: string, queryPairs: readonly string[]): string {
  const qs = queryPairs.join('&')
  return qs ? `${OPENAI_ADS_API_BASE}/${path}?${qs}` : `${OPENAI_ADS_API_BASE}/${path}`
}

async function adsFetch<T>(apiKey: string, path: string, queryPairs: readonly string[] = []): Promise<T> {
  const url = buildUrl(path, queryPairs)

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(OPENAI_ADS_REQUEST_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    const { code } = parseErrorEnvelope(await res.text())
    adsClientLog('error', 'http.auth-failed', { path, httpStatus: res.status, code })
    throw new OpenAiAdsApiError('OpenAI Ads API key is invalid or unauthorized', res.status, code)
  }

  if (res.status === 429) {
    const { code } = parseErrorEnvelope(await res.text())
    adsClientLog('error', 'http.rate-limited', { path, httpStatus: 429, code })
    throw new OpenAiAdsApiError('OpenAI Ads API rate limit exceeded', 429, code)
  }

  if (!res.ok) {
    const body = await res.text()
    const { message, code } = parseErrorEnvelope(body)
    adsClientLog('error', 'http.error', { path, httpStatus: res.status, code })
    const detail = message ?? (body.length <= 500 ? body : `${body.slice(0, 500)}... [truncated]`)
    throw new OpenAiAdsApiError(`OpenAI Ads API error (${res.status}): ${detail}`, res.status, code)
  }

  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new OpenAiAdsApiError('OpenAI Ads API returned invalid JSON', 502)
  }
}

// Every collection endpoint returns the same list envelope with
// first_id/last_id/has_more (captured live). The `after=` request param
// follows the OpenAI list convention; it has not been exercised against a
// multi-page dataset yet — revisit if pagination misbehaves on large accounts.
async function fetchAllPages<T>(apiKey: string, path: string, queryPairs: readonly string[]): Promise<T[]> {
  const items: T[] = []
  let after: string | null = null

  for (let page = 0; page < OPENAI_ADS_MAX_PAGES; page++) {
    const pairs: string[] = after ? [...queryPairs, `after=${encodeURIComponent(after)}`] : [...queryPairs]
    const response: OpenAiAdsListResponse<T> = await adsFetch<OpenAiAdsListResponse<T>>(apiKey, path, pairs)
    items.push(...response.data)
    if (!response.has_more || !response.last_id) {
      return items
    }
    after = response.last_id
  }

  adsClientLog('error', 'pagination.cap-reached', { path, pages: OPENAI_ADS_MAX_PAGES, items: items.length })
  return items
}

function insightsPairs(opts?: OpenAiAdsInsightsOptions): string[] {
  const pairs = (opts?.fields ?? []).map((field) => `fields[]=${encodeURIComponent(field)}`)
  // Trailing-window bounds. The start_date/end_date param names follow the
  // documented convention but were not in the 2026-06-10 capture — confirm
  // against a live request before relying on them (see OpenAiAdsInsightsOptions).
  if (opts?.startDate) pairs.push(`start_date=${encodeURIComponent(opts.startDate)}`)
  if (opts?.endDate) pairs.push(`end_date=${encodeURIComponent(opts.endDate)}`)
  return pairs
}

export async function getAdAccount(apiKey: string): Promise<OpenAiAdsAccount> {
  validateApiKey(apiKey)
  return adsFetch<OpenAiAdsAccount>(apiKey, 'ad_account')
}

export async function listCampaigns(apiKey: string): Promise<OpenAiAdsCampaign[]> {
  validateApiKey(apiKey)
  return fetchAllPages<OpenAiAdsCampaign>(apiKey, 'campaigns', [])
}

export async function listAdGroups(apiKey: string, campaignId: string): Promise<OpenAiAdsAdGroup[]> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return fetchAllPages<OpenAiAdsAdGroup>(apiKey, 'ad_groups', [`campaign_id=${encodeURIComponent(campaignId)}`])
}

export async function listAds(apiKey: string, adGroupId: string): Promise<OpenAiAdsAd[]> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return fetchAllPages<OpenAiAdsAd>(apiKey, 'ads', [`ad_group_id=${encodeURIComponent(adGroupId)}`])
}

export async function getAdAccountInsights(
  apiKey: string,
  opts?: OpenAiAdsInsightsOptions,
): Promise<OpenAiAdsInsightRow[]> {
  validateApiKey(apiKey)
  return fetchAllPages<OpenAiAdsInsightRow>(apiKey, 'ad_account/insights', insightsPairs(opts))
}

export async function getCampaignInsights(
  apiKey: string,
  campaignId: string,
  opts?: OpenAiAdsInsightsOptions,
): Promise<OpenAiAdsInsightRow[]> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return fetchAllPages<OpenAiAdsInsightRow>(
    apiKey,
    `campaigns/${encodeURIComponent(campaignId)}/insights`,
    insightsPairs(opts),
  )
}

export async function getAdGroupInsights(
  apiKey: string,
  adGroupId: string,
  opts?: OpenAiAdsInsightsOptions,
): Promise<OpenAiAdsInsightRow[]> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return fetchAllPages<OpenAiAdsInsightRow>(
    apiKey,
    `ad_groups/${encodeURIComponent(adGroupId)}/insights`,
    insightsPairs(opts),
  )
}
