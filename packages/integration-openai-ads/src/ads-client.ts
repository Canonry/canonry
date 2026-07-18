import { OPENAI_ADS_API_BASE, OPENAI_ADS_MAX_PAGES, OPENAI_ADS_REQUEST_TIMEOUT_MS } from './constants.js'
import type {
  OpenAiAdsAccount,
  OpenAiAdsAd,
  OpenAiAdsAdGroup,
  OpenAiAdsCampaign,
  OpenAiAdsConversionEventSetting,
  OpenAiAdsConversionPixel,
  OpenAiAdsCreateAdGroupRequest,
  OpenAiAdsCreateAdRequest,
  OpenAiAdsCreateCampaignRequest,
  OpenAiAdsGeoSearchResponse,
  OpenAiAdsInsightRow,
  OpenAiAdsInsightsOptions,
  OpenAiAdsListResponse,
  OpenAiAdsUpdateAdGroupRequest,
  OpenAiAdsUpdateAdRequest,
  OpenAiAdsUpdateCampaignRequest,
  OpenAiAdsUploadImageRequest,
  OpenAiAdsUploadImageResponse,
} from './types.js'
import {
  OpenAiAdsApiError,
  OpenAiAdsBiddingTypes,
  OpenAiAdsBillingEventTypes,
  OpenAiAdsCreativeTypes,
  OpenAiAdsWriteStatuses,
  parseErrorEnvelope,
} from './types.js'

const MIN_ENTITY_NAME_LENGTH = 3
const MAX_ENTITY_NAME_LENGTH = 1_000
const MIN_CAMPAIGN_TIMESTAMP = 946_684_800
const MAX_CAMPAIGN_TIMESTAMP = 4_102_444_800
const MIN_LIFETIME_BUDGET_MICROS = 1_000_000
const MIN_BID_MICROS = 1
const MAX_BID_MICROS = 100_000_000
const MIN_AD_TITLE_LENGTH = 3
const MAX_AD_TITLE_LENGTH = 50
const MAX_AD_BODY_LENGTH = 100
const MIN_GEO_SEARCH_LIMIT = 1
const MAX_GEO_SEARCH_LIMIT = 500

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

function validateGeoSearchLimit(limit: number | undefined): void {
  if (limit === undefined) return
  if (!Number.isInteger(limit) || limit < MIN_GEO_SEARCH_LIMIT || limit > MAX_GEO_SEARCH_LIMIT) {
    throw new OpenAiAdsApiError(
      `Geo search limit must be an integer between ${MIN_GEO_SEARCH_LIMIT} and ${MAX_GEO_SEARCH_LIMIT}`,
      400,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRequestObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OpenAiAdsApiError(`${label} must be a JSON object`, 400)
  }
}

function validateNonEmptyRequest(value: unknown, label: string): asserts value is Record<string, unknown> {
  validateRequestObject(value, label)
  if (Object.keys(value).length === 0) {
    throw new OpenAiAdsApiError(`${label} must include at least one field`, 400)
  }
}

function snapshotJsonRequest<T>(value: T, label: string): T {
  try {
    const serialized = JSON.stringify(value)
    return JSON.parse(serialized) as T
  } catch {
    throw new OpenAiAdsApiError(`${label} must be JSON-serializable`, 400)
  }
}

function validateEntityName(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length < MIN_ENTITY_NAME_LENGTH ||
    value.length > MAX_ENTITY_NAME_LENGTH
  ) {
    throw new OpenAiAdsApiError(
      `${label} must be ${MIN_ENTITY_NAME_LENGTH}-${MAX_ENTITY_NAME_LENGTH} characters and include a non-space character`,
      400,
    )
  }
}

function validatePausedCreateStatus(value: unknown, label: string): void {
  if (value !== OpenAiAdsWriteStatuses.paused) {
    throw new OpenAiAdsApiError(`${label} status must be paused`, 400)
  }
}

function validatePublicUpdateRequest(value: unknown, label: string): asserts value is Record<string, unknown> {
  validateNonEmptyRequest(value, label)
  if (Object.hasOwn(value, 'status')) {
    throw new OpenAiAdsApiError(`${label} cannot include status; use an explicit lifecycle action`, 400)
  }
}

function validateCampaignTimestamp(value: unknown, label: string): void {
  if (value === undefined || value === null) return
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_CAMPAIGN_TIMESTAMP ||
    (value as number) > MAX_CAMPAIGN_TIMESTAMP
  ) {
    throw new OpenAiAdsApiError(
      `${label} must be a Unix timestamp between ${MIN_CAMPAIGN_TIMESTAMP} and ${MAX_CAMPAIGN_TIMESTAMP}`,
      400,
    )
  }
}

function validateCampaignBudget(value: unknown): void {
  validateRequestObject(value, 'Campaign budget')
  const limit = value.lifetime_spend_limit_micros
  if (!Number.isInteger(limit) || (limit as number) < MIN_LIFETIME_BUDGET_MICROS) {
    throw new OpenAiAdsApiError(
      `Campaign budget lifetime_spend_limit_micros must be an integer of at least ${MIN_LIFETIME_BUDGET_MICROS}`,
      400,
    )
  }
}

function validateCampaignTargeting(value: unknown): void {
  if (value === undefined) return
  if (value === null) {
    throw new OpenAiAdsApiError('Campaign targeting cannot be null; omit it to preserve existing targeting', 400)
  }
  validateRequestObject(value, 'Campaign targeting')
  validateRequestObject(value.locations, 'Campaign targeting locations')
  const include = value.locations.include
  if (!Array.isArray(include) || include.length === 0) {
    throw new OpenAiAdsApiError('Campaign targeting locations include must be a non-empty array', 400)
  }
  for (const target of include) {
    validateRequestObject(target, 'Campaign location target')
    validateId(target.id as string, 'Campaign location id')
  }
}

function validateCampaignBidding(request: OpenAiAdsCreateCampaignRequest): void {
  const biddingType: unknown = request.bidding_type
  if (
    biddingType !== undefined &&
    biddingType !== OpenAiAdsBiddingTypes.impressions &&
    biddingType !== OpenAiAdsBiddingTypes.clicks
  ) {
    throw new OpenAiAdsApiError('Campaign bidding_type must be impressions or clicks', 400)
  }

  const conversionIds: unknown = request.conversion_event_setting_ids
  if (conversionIds !== undefined) {
    if (!Array.isArray(conversionIds)) {
      throw new OpenAiAdsApiError('Campaign conversion_event_setting_ids must be an array of unique IDs', 400)
    }
    for (const conversionId of conversionIds) {
      validateId(conversionId as string, 'Campaign conversion event setting id')
    }
    if (new Set(conversionIds).size !== conversionIds.length) {
      throw new OpenAiAdsApiError('Campaign conversion_event_setting_ids must contain unique IDs', 400)
    }
  }

  if (
    biddingType === OpenAiAdsBiddingTypes.clicks &&
    (!Array.isArray(conversionIds) || conversionIds.length === 0)
  ) {
    throw new OpenAiAdsApiError(
      'Click campaigns require at least one conversion_event_setting_id',
      400,
    )
  }
}

function validateBiddingConfig(value: unknown): void {
  validateRequestObject(value, 'Ad group bidding_config')
  if (
    value.billing_event_type !== OpenAiAdsBillingEventTypes.impression &&
    value.billing_event_type !== OpenAiAdsBillingEventTypes.click
  ) {
    throw new OpenAiAdsApiError('Ad group billing_event_type must be impression or click', 400)
  }
  const maxBid = value.max_bid_micros
  if (!Number.isInteger(maxBid) || (maxBid as number) < MIN_BID_MICROS || (maxBid as number) > MAX_BID_MICROS) {
    throw new OpenAiAdsApiError(
      `Ad group max_bid_micros must be an integer between ${MIN_BID_MICROS} and ${MAX_BID_MICROS}`,
      400,
    )
  }
}

function validateContextHints(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((hint) => typeof hint !== 'string' || hint.trim().length === 0)) {
    throw new OpenAiAdsApiError('Ad group context_hints must be an array of non-empty strings', 400)
  }
}

function validateHttpUrl(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenAiAdsApiError(`${label} is required and must be a non-empty URL`, 400)
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    throw new OpenAiAdsApiError(`${label} must be an absolute HTTP or HTTPS URL`, 400)
  }
}

function validateChatCardCreative(value: unknown): void {
  validateRequestObject(value, 'Ad creative')
  if (value.type !== OpenAiAdsCreativeTypes.chatCard) {
    throw new OpenAiAdsApiError('Ad creative type must be chat_card', 400)
  }
  if (
    typeof value.title !== 'string' ||
    value.title.trim().length < MIN_AD_TITLE_LENGTH ||
    value.title.length > MAX_AD_TITLE_LENGTH
  ) {
    throw new OpenAiAdsApiError(
      `Ad creative title must be ${MIN_AD_TITLE_LENGTH}-${MAX_AD_TITLE_LENGTH} characters`,
      400,
    )
  }
  if (typeof value.body !== 'string' || value.body.trim().length === 0 || value.body.length > MAX_AD_BODY_LENGTH) {
    throw new OpenAiAdsApiError(`Ad creative body must be 1-${MAX_AD_BODY_LENGTH} characters`, 400)
  }
  validateId(value.file_id as string, 'Ad creative file id')
  validateHttpUrl(value.target_url, 'Ad creative target URL')
}

function validateCreateCampaignRequest(request: OpenAiAdsCreateCampaignRequest): void {
  validateRequestObject(request, 'Campaign create request')
  validateEntityName(request.name, 'Campaign name')
  validatePausedCreateStatus(request.status, 'Campaign create request')
  validateCampaignBudget(request.budget)
  validateCampaignTimestamp(request.start_time, 'Campaign start_time')
  validateCampaignTimestamp(request.end_time, 'Campaign end_time')
  validateCampaignBidding(request)
  validateCampaignTargeting(request.targeting)
}

function validateUpdateCampaignRequest(request: OpenAiAdsUpdateCampaignRequest): void {
  validatePublicUpdateRequest(request, 'Campaign update request')
  if (request.name !== undefined) validateEntityName(request.name, 'Campaign name')
  if (request.budget !== undefined) validateCampaignBudget(request.budget)
  validateCampaignTimestamp(request.start_time, 'Campaign start_time')
  validateCampaignTimestamp(request.end_time, 'Campaign end_time')
  validateCampaignTargeting(request.targeting)
}

function validateCreateAdGroupRequest(request: OpenAiAdsCreateAdGroupRequest): void {
  validateRequestObject(request, 'Ad group create request')
  validateId(request.campaign_id, 'Campaign id')
  validateEntityName(request.name, 'Ad group name')
  validatePausedCreateStatus(request.status, 'Ad group create request')
  validateContextHints(request.context_hints)
  validateBiddingConfig(request.bidding_config)
}

function validateUpdateAdGroupRequest(request: OpenAiAdsUpdateAdGroupRequest): void {
  validatePublicUpdateRequest(request, 'Ad group update request')
  if (request.name !== undefined) validateEntityName(request.name, 'Ad group name')
  validateContextHints(request.context_hints)
  if (request.bidding_config !== undefined) validateBiddingConfig(request.bidding_config)
}

function validateCreateAdRequest(request: OpenAiAdsCreateAdRequest): void {
  validateRequestObject(request, 'Ad create request')
  validateId(request.ad_group_id, 'Ad group id')
  validateEntityName(request.name, 'Ad name')
  validatePausedCreateStatus(request.status, 'Ad create request')
  validateChatCardCreative(request.creative)
}

function validateUpdateAdRequest(request: OpenAiAdsUpdateAdRequest): void {
  validatePublicUpdateRequest(request, 'Ad update request')
  if (request.name !== undefined) validateEntityName(request.name, 'Ad name')
  if (request.creative !== undefined) validateChatCardCreative(request.creative)
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

async function adsFetch<T>(
  apiKey: string,
  path: string,
  queryPairs: readonly string[] = [],
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  const url = buildUrl(path, queryPairs)

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  throw new OpenAiAdsApiError(
    `OpenAI Ads API collection remained incomplete after the ${OPENAI_ADS_MAX_PAGES}-page safety cap`,
    502,
    'pagination_limit_exceeded',
  )
}

function insightsPairs(opts?: OpenAiAdsInsightsOptions): string[] {
  return (opts?.fields ?? []).map((field) => `fields[]=${encodeURIComponent(field)}`)
}

export async function getAdAccount(apiKey: string): Promise<OpenAiAdsAccount> {
  validateApiKey(apiKey)
  return adsFetch<OpenAiAdsAccount>(apiKey, 'ad_account')
}

export async function searchGeoLocations(
  apiKey: string,
  query: string,
  limit?: number,
): Promise<OpenAiAdsGeoSearchResponse> {
  validateApiKey(apiKey)
  validateId(query, 'Geo search query')
  validateGeoSearchLimit(limit)
  const queryPairs = [`q=${encodeURIComponent(query)}`]
  if (limit !== undefined) queryPairs.push(`limit=${limit}`)
  return adsFetch<OpenAiAdsGeoSearchResponse>(apiKey, 'geo_lookup/search', queryPairs)
}

export async function listConversionPixels(apiKey: string): Promise<OpenAiAdsConversionPixel[]> {
  validateApiKey(apiKey)
  return fetchAllPages<OpenAiAdsConversionPixel>(apiKey, 'conversions/pixels', [])
}

export async function listConversionEventSettings(apiKey: string): Promise<OpenAiAdsConversionEventSetting[]> {
  validateApiKey(apiKey)
  return fetchAllPages<OpenAiAdsConversionEventSetting>(apiKey, 'conversions/event_settings', [])
}

export async function listCampaigns(apiKey: string): Promise<OpenAiAdsCampaign[]> {
  validateApiKey(apiKey)
  return fetchAllPages<OpenAiAdsCampaign>(apiKey, 'campaigns', [])
}

export async function getCampaign(apiKey: string, campaignId: string): Promise<OpenAiAdsCampaign> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return adsFetch<OpenAiAdsCampaign>(apiKey, `campaigns/${encodeURIComponent(campaignId)}`)
}

export async function createCampaign(
  apiKey: string,
  request: OpenAiAdsCreateCampaignRequest,
): Promise<OpenAiAdsCampaign> {
  validateApiKey(apiKey)
  const outbound = snapshotJsonRequest(request, 'Campaign create request')
  validateCreateCampaignRequest(outbound)
  return adsFetch<OpenAiAdsCampaign>(apiKey, 'campaigns', [], 'POST', outbound)
}

export async function updateCampaign(
  apiKey: string,
  campaignId: string,
  request: OpenAiAdsUpdateCampaignRequest,
): Promise<OpenAiAdsCampaign> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  const outbound = snapshotJsonRequest(request, 'Campaign update request')
  validateUpdateCampaignRequest(outbound)
  return adsFetch<OpenAiAdsCampaign>(apiKey, `campaigns/${encodeURIComponent(campaignId)}`, [], 'POST', outbound)
}

export async function activateCampaign(apiKey: string, campaignId: string): Promise<OpenAiAdsCampaign> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return adsFetch<OpenAiAdsCampaign>(apiKey, `campaigns/${encodeURIComponent(campaignId)}/activate`, [], 'POST')
}

export async function pauseCampaign(apiKey: string, campaignId: string): Promise<OpenAiAdsCampaign> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return adsFetch<OpenAiAdsCampaign>(apiKey, `campaigns/${encodeURIComponent(campaignId)}/pause`, [], 'POST')
}

export async function listAdGroups(apiKey: string, campaignId: string): Promise<OpenAiAdsAdGroup[]> {
  validateApiKey(apiKey)
  validateId(campaignId, 'Campaign id')
  return fetchAllPages<OpenAiAdsAdGroup>(apiKey, 'ad_groups', [`campaign_id=${encodeURIComponent(campaignId)}`])
}

export async function getAdGroup(apiKey: string, adGroupId: string): Promise<OpenAiAdsAdGroup> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return adsFetch<OpenAiAdsAdGroup>(apiKey, `ad_groups/${encodeURIComponent(adGroupId)}`)
}

export async function createAdGroup(
  apiKey: string,
  request: OpenAiAdsCreateAdGroupRequest,
): Promise<OpenAiAdsAdGroup> {
  validateApiKey(apiKey)
  const outbound = snapshotJsonRequest(request, 'Ad group create request')
  validateCreateAdGroupRequest(outbound)
  return adsFetch<OpenAiAdsAdGroup>(apiKey, 'ad_groups', [], 'POST', outbound)
}

export async function updateAdGroup(
  apiKey: string,
  adGroupId: string,
  request: OpenAiAdsUpdateAdGroupRequest,
): Promise<OpenAiAdsAdGroup> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  const outbound = snapshotJsonRequest(request, 'Ad group update request')
  validateUpdateAdGroupRequest(outbound)
  return adsFetch<OpenAiAdsAdGroup>(apiKey, `ad_groups/${encodeURIComponent(adGroupId)}`, [], 'POST', outbound)
}

export async function activateAdGroup(apiKey: string, adGroupId: string): Promise<OpenAiAdsAdGroup> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return adsFetch<OpenAiAdsAdGroup>(apiKey, `ad_groups/${encodeURIComponent(adGroupId)}/activate`, [], 'POST')
}

export async function pauseAdGroup(apiKey: string, adGroupId: string): Promise<OpenAiAdsAdGroup> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return adsFetch<OpenAiAdsAdGroup>(apiKey, `ad_groups/${encodeURIComponent(adGroupId)}/pause`, [], 'POST')
}

export async function listAds(apiKey: string, adGroupId: string): Promise<OpenAiAdsAd[]> {
  validateApiKey(apiKey)
  validateId(adGroupId, 'Ad group id')
  return fetchAllPages<OpenAiAdsAd>(apiKey, 'ads', [`ad_group_id=${encodeURIComponent(adGroupId)}`])
}

export async function getAd(apiKey: string, adId: string): Promise<OpenAiAdsAd> {
  validateApiKey(apiKey)
  validateId(adId, 'Ad id')
  return adsFetch<OpenAiAdsAd>(apiKey, `ads/${encodeURIComponent(adId)}`)
}

export async function createAd(apiKey: string, request: OpenAiAdsCreateAdRequest): Promise<OpenAiAdsAd> {
  validateApiKey(apiKey)
  const outbound = snapshotJsonRequest(request, 'Ad create request')
  validateCreateAdRequest(outbound)
  return adsFetch<OpenAiAdsAd>(apiKey, 'ads', [], 'POST', outbound)
}

export async function updateAd(
  apiKey: string,
  adId: string,
  request: OpenAiAdsUpdateAdRequest,
): Promise<OpenAiAdsAd> {
  validateApiKey(apiKey)
  validateId(adId, 'Ad id')
  const outbound = snapshotJsonRequest(request, 'Ad update request')
  validateUpdateAdRequest(outbound)
  return adsFetch<OpenAiAdsAd>(apiKey, `ads/${encodeURIComponent(adId)}`, [], 'POST', outbound)
}

export async function activateAd(apiKey: string, adId: string): Promise<OpenAiAdsAd> {
  validateApiKey(apiKey)
  validateId(adId, 'Ad id')
  return adsFetch<OpenAiAdsAd>(apiKey, `ads/${encodeURIComponent(adId)}/activate`, [], 'POST')
}

export async function pauseAd(apiKey: string, adId: string): Promise<OpenAiAdsAd> {
  validateApiKey(apiKey)
  validateId(adId, 'Ad id')
  return adsFetch<OpenAiAdsAd>(apiKey, `ads/${encodeURIComponent(adId)}/pause`, [], 'POST')
}

export async function uploadImageFromUrl(apiKey: string, imageUrl: string): Promise<OpenAiAdsUploadImageResponse> {
  validateApiKey(apiKey)
  validateHttpUrl(imageUrl, 'Image URL')
  const request: OpenAiAdsUploadImageRequest = { image_url: imageUrl }
  return adsFetch<OpenAiAdsUploadImageResponse>(apiKey, 'upload', [], 'POST', request)
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
