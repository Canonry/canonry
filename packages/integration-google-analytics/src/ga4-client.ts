import crypto from 'node:crypto'
import {
  GA4_DATA_API_BASE,
  GA4_SCOPE,
  GOOGLE_TOKEN_URL,
  GA4_DEFAULT_SYNC_DAYS,
  GA4_MAX_SYNC_DAYS,
  GA4_REQUEST_TIMEOUT_MS,
  GA4_MAX_PAGES,
} from './constants.js'
import type {
  GA4AiReferralRow,
  GA4SocialReferralRow,
  GA4RunReportRequest,
  GA4RunReportResponse,
  GA4SourceDimension,
  GA4TrafficRow,
} from './types.js'
import { GA4ApiError } from './types.js'

function validateClientEmail(clientEmail: string): void {
  if (!clientEmail || typeof clientEmail !== 'string' || clientEmail.trim().length === 0) {
    throw new GA4ApiError('Client email is required and must be a non-empty string', 400)
  }
  // Simple email format check
  if (!clientEmail.includes('@')) {
    throw new GA4ApiError('Client email must be a valid email address', 400)
  }
}

function validatePrivateKey(privateKey: string): void {
  if (!privateKey || typeof privateKey !== 'string' || privateKey.trim().length === 0) {
    throw new GA4ApiError('Private key is required and must be a non-empty string', 400)
  }
}

function validatePropertyId(propertyId: string): void {
  if (!propertyId || typeof propertyId !== 'string' || propertyId.trim().length === 0) {
    throw new GA4ApiError('Property ID is required and must be a non-empty string', 400)
  }
  // GA4 property ID format: numeric only (GA4 property IDs are numbers)
  if (!/^\d+$/.test(propertyId)) {
    throw new GA4ApiError('Property ID must be a numeric string', 400)
  }
}

function validateAccessToken(accessToken: string): void {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new GA4ApiError('Access token is required and must be a non-empty string', 400)
  }
}

function validateScope(scope: string): void {
  if (!scope || typeof scope !== 'string' || scope.trim().length === 0) {
    throw new GA4ApiError('Scope is required and must be a non-empty string', 400)
  }
}

function ga4Log(level: 'info' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module: 'GA4Client',
    action,
    ...ctx,
  }
  // Sanitize potential secrets
  if (entry.accessToken) entry.accessToken = '***'
  if (entry.privateKey) entry.privateKey = '***'

  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

/**
 * Create a signed JWT for Google service account authentication.
 * Uses Node.js built-in crypto — no external dependencies.
 */
export function createServiceAccountJwt(clientEmail: string, privateKey: string, scope: string): string {
  validateClientEmail(clientEmail)
  validatePrivateKey(privateKey)
  validateScope(scope)
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: clientEmail,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600, // 1 hour
  }

  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')

  const headerB64 = encode(header)
  const payloadB64 = encode(payload)
  const signingInput = `${headerB64}.${payloadB64}`

  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signingInput)
  const signature = sign.sign(privateKey, 'base64url')

  return `${signingInput}.${signature}`
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token.
 */
export async function getAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  const jwt = createServiceAccountJwt(clientEmail, privateKey, GA4_SCOPE)

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(GA4_REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    ga4Log('error', 'token.failed', { httpStatus: res.status })
    // Sanitize: avoid leaking private key or client email details from OAuth error responses
    const detail = body.length <= 200 ? body : `${body.slice(0, 200)}... [truncated]`
    const sanitizedDetail = detail
      .replace(new RegExp(escapeRegExp(clientEmail), 'g'), '***')
      .replace(new RegExp(escapeRegExp(privateKey.slice(0, 32)), 'g'), '***')
    throw new GA4ApiError(`Failed to get access token: ${sanitizedDetail}`, res.status)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  return data.access_token
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Run a GA4 Data API report.
 */
async function runReport(
  accessToken: string,
  propertyId: string,
  request: GA4RunReportRequest,
): Promise<GA4RunReportResponse> {
  const url = `${GA4_DATA_API_BASE}/properties/${propertyId}:runReport`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(GA4_REQUEST_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '')
    let detail = ''
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } }
      if (parsed.error?.status === 'SERVICE_DISABLED') {
        detail =
          ' The Google Analytics Data API is not enabled for this GCP project. ' +
          'Enable it at: https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview'
      } else if (parsed.error?.message) {
        detail = ` ${parsed.error.message}`
      }
    } catch {
      // not JSON — use raw body if short enough
      if (body.length < 200) detail = ` ${body}`
    }
    ga4Log('error', 'report.auth-failed', { propertyId, httpStatus: res.status })
    throw new GA4ApiError(
      `GA4 API authentication failed — check service account permissions.${detail}`,
      res.status,
    )
  }

  if (res.status === 429) {
    ga4Log('error', 'report.rate-limited', { propertyId })
    throw new GA4ApiError('GA4 API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    ga4Log('error', 'report.error', { propertyId, httpStatus: res.status })
    const detail = body.length <= 500 ? body : `${body.slice(0, 500)}... [truncated]`
    throw new GA4ApiError(`GA4 API error (${res.status}): ${detail}`, res.status)
  }

  return (await res.json()) as GA4RunReportResponse
}

/**
 * Batch multiple GA4 reports into a single HTTP request.
 * Reduces API quota usage vs. making individual runReport calls.
 */
async function batchRunReports(
  accessToken: string,
  propertyId: string,
  requests: GA4RunReportRequest[],
): Promise<GA4RunReportResponse[]> {
  const url = `${GA4_DATA_API_BASE}/properties/${propertyId}:batchRunReports`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(GA4_REQUEST_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '')
    ga4Log('error', 'batch-report.auth-failed', { propertyId, httpStatus: res.status })
    throw new GA4ApiError(
      `GA4 API authentication failed — check service account permissions. ${body}`,
      res.status,
    )
  }

  if (res.status === 429) {
    ga4Log('error', 'batch-report.rate-limited', { propertyId })
    throw new GA4ApiError('GA4 API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    ga4Log('error', 'batch-report.error', { propertyId, httpStatus: res.status })
    const detail = body.length <= 500 ? body : `${body.slice(0, 500)}... [truncated]`
    throw new GA4ApiError(`GA4 API error (${res.status}): ${detail}`, res.status)
  }

  const data = (await res.json()) as { reports: GA4RunReportResponse[] }
  return data.reports
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]!
}

// AI referral source patterns matched against both sessionSource and firstUserSource.
// sessionSource: the referrer/utm_source for the session that triggered the hit.
// firstUserSource: the referrer/utm_source from the user's very first visit (lifetime).
// Using both ensures we catch AI traffic whether it arrives via referrer header or
// utm_source parameter (e.g. ?utm_source=chatgpt.com).
const AI_REFERRAL_SOURCE_FILTERS: Array<{ matchType: 'CONTAINS' | 'EXACT'; value: string }> = [
  { matchType: 'CONTAINS', value: 'perplexity' },
  { matchType: 'CONTAINS', value: 'gemini' },
  { matchType: 'CONTAINS', value: 'chatgpt' },
  { matchType: 'CONTAINS', value: 'openai' },
  { matchType: 'CONTAINS', value: 'claude' },
  { matchType: 'CONTAINS', value: 'anthropic' },
  { matchType: 'CONTAINS', value: 'copilot' },
  { matchType: 'CONTAINS', value: 'phind' },
  { matchType: 'EXACT', value: 'you.com' },
  { matchType: 'CONTAINS', value: 'meta.ai' },
]

/**
 * Fetch landing page traffic data for the given number of days.
 * Returns per-day, per-page traffic rows.
 */
export async function fetchTrafficByLandingPage(
  accessToken: string,
  propertyId: string,
  days?: number,
): Promise<GA4TrafficRow[]> {
  validateAccessToken(accessToken)
  validatePropertyId(propertyId)
  const syncDays = Math.min(Math.max(1, days ?? GA4_DEFAULT_SYNC_DAYS), GA4_MAX_SYNC_DAYS)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - syncDays)

  ga4Log('info', 'fetch-traffic.start', { propertyId, days: syncDays })

  const PAGE_SIZE = 10000
  const rows: GA4TrafficRow[] = []
  let offset = 0

  // Paginate through all results — the GA4 Data API caps each response at `limit` rows.
  // We loop until we've fetched every row reported by `rowCount`.
  let pageCount = 0
  while (pageCount < GA4_MAX_PAGES) {
    pageCount++
    const request: GA4RunReportRequest = {
      dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }],
      dimensions: [
        { name: 'date' },
        { name: 'landingPagePlusQueryString' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
      ],
      limit: PAGE_SIZE,
      offset,
    }

    const response = await runReport(accessToken, propertyId, request)
    const pageRows = (response.rows ?? []).map((row) => ({
      date: row.dimensionValues[0]!.value,
      landingPage: row.dimensionValues[1]!.value,
      sessions: parseInt(row.metricValues[0]!.value, 10) || 0,
      organicSessions: 0, // populated by organic-only pass below
      users: parseInt(row.metricValues[1]!.value, 10) || 0,
    }))

    rows.push(...pageRows)

    const totalRows = response.rowCount ?? 0
    offset += pageRows.length

    if (pageRows.length < PAGE_SIZE || offset >= totalRows) break
  }

  // Second pass: organic-only report filtered to "Organic Search" channel.
  // `organicGoogleSearchSessions` is only available when Search Console is linked;
  // using a dimensionFilter on sessionDefaultChannelGrouping works for all properties.
  const organicMap = new Map<string, number>()
  let organicOffset = 0
  let organicPageCount = 0
  while (organicPageCount < GA4_MAX_PAGES) {
    organicPageCount++
    const organicRequest: GA4RunReportRequest = {
      dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }],
      dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGrouping',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      limit: 10000,
      offset: organicOffset,
    }
    const organicResponse = await runReport(accessToken, propertyId, organicRequest)
    for (const row of organicResponse.rows ?? []) {
      const key = `${row.dimensionValues[0]!.value}::${row.dimensionValues[1]!.value}`
      organicMap.set(key, parseInt(row.metricValues[0]!.value, 10) || 0)
    }
    const total = organicResponse.rowCount ?? 0
    organicOffset += (organicResponse.rows ?? []).length
    if ((organicResponse.rows ?? []).length < 10000 || organicOffset >= total) break
  }

  // Merge organic session counts back into the rows
  for (const row of rows) {
    const key = `${row.date}::${row.landingPage}`
    row.organicSessions = organicMap.get(key) ?? 0
  }

  // Convert YYYYMMDD to YYYY-MM-DD
  for (const row of rows) {
    if (row.date.length === 8 && !row.date.includes('-')) {
      row.date = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`
    }
  }

  ga4Log('info', 'fetch-traffic.done', { propertyId, rowCount: rows.length })
  return rows
}

/**
 * Verify that the service account credentials work by requesting a minimal report.
 */
export async function verifyConnection(
  clientEmail: string,
  privateKey: string,
  propertyId: string,
): Promise<boolean> {
  validateClientEmail(clientEmail)
  validatePrivateKey(privateKey)
  validatePropertyId(propertyId)
  const accessToken = await getAccessToken(clientEmail, privateKey)
  return verifyConnectionWithToken(accessToken, propertyId)
}

/**
 * Verify that an OAuth access token grants access to the given GA4 property.
 * Used for the OAuth auth path (canonry google connect --type ga4).
 */
export async function verifyConnectionWithToken(
  accessToken: string,
  propertyId: string,
): Promise<boolean> {
  validateAccessToken(accessToken)
  validatePropertyId(propertyId)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - 1)

  await runReport(accessToken, propertyId, {
    dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    limit: 1,
  })

  return true
}

export interface GA4AggregateSummary {
  periodStart: string
  periodEnd: string
  totalSessions: number
  totalOrganicSessions: number
  totalUsers: number
}

/**
 * Fetch true aggregate totals for the given period.
 * Uses no landing-page dimension so totalUsers reflects actual unique visitors,
 * not a sum-of-per-page counts which inflates the metric.
 */
export async function fetchAggregateSummary(
  accessToken: string,
  propertyId: string,
  days?: number,
): Promise<GA4AggregateSummary> {
  validateAccessToken(accessToken)
  validatePropertyId(propertyId)
  const syncDays = Math.min(Math.max(1, days ?? GA4_DEFAULT_SYNC_DAYS), GA4_MAX_SYNC_DAYS)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - syncDays)

  ga4Log('info', 'fetch-aggregate.start', { propertyId, days: syncDays })

  const dateRange = { startDate: formatDate(startDate), endDate: formatDate(endDate) }

  // Use batchRunReports to combine both queries into a single HTTP request,
  // reducing GA4 API quota consumption (property-level rate limits).
  const batchRes = await batchRunReports(accessToken, propertyId, [
    {
      dateRanges: [dateRange],
      dimensions: [],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      limit: 1,
    },
    {
      dateRanges: [dateRange],
      dimensions: [],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGrouping',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      limit: 1,
    },
  ])

  const totalRow = batchRes[0]?.rows?.[0]
  const organicRow = batchRes[1]?.rows?.[0]

  const summary: GA4AggregateSummary = {
    periodStart: formatDate(startDate),
    periodEnd: formatDate(endDate),
    totalSessions: parseInt(totalRow?.metricValues[0]?.value ?? '0', 10) || 0,
    totalUsers: parseInt(totalRow?.metricValues[1]?.value ?? '0', 10) || 0,
    totalOrganicSessions: parseInt(organicRow?.metricValues[0]?.value ?? '0', 10) || 0,
  }

  ga4Log('info', 'fetch-aggregate.done', { propertyId, ...summary })
  return summary
}

/**
 * Fetch traffic specifically from AI referral sources.
 */
export async function fetchAiReferrals(
  accessToken: string,
  propertyId: string,
  days?: number,
): Promise<GA4AiReferralRow[]> {
  validateAccessToken(accessToken)
  validatePropertyId(propertyId)
  const syncDays = Math.min(Math.max(1, days ?? GA4_DEFAULT_SYNC_DAYS), GA4_MAX_SYNC_DAYS)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - syncDays)

  ga4Log('info', 'fetch-ai-referrals.start', { propertyId, days: syncDays })

  // Use explicit AI referrer patterns only. Generic search-engine sources such as
  // plain "bing" are intentionally excluded because they would misclassify normal
  // search traffic as AI traffic.
  //
  // GA4 has three layers of source attribution we check:
  //
  // 1. sessionSource — GA4's resolved session source. Combines auto-detected
  //    referrer headers AND utm_source parameters (utm_source takes priority).
  //    This is the primary dimension and catches most AI traffic.
  //
  // 2. firstUserSource — the source from the user's very first visit (lifetime).
  //    Catches users who first discovered the site via an AI engine but return
  //    later through other channels.
  //
  // 3. sessionManualSource — explicitly the utm_source parameter value for the
  //    session that led to the visit. GA4's plain manualSource/manualMedium
  //    dimensions are key-event scoped, which can miss AI-tagged visits that
  //    never converted. This catches edge cases where:
  //    - The referrer header was stripped (browser privacy settings)
  //    - GA4's session attribution resolved to a different source but the
  //      utm_source was still set to an AI engine
  //    - Custom UTM tags were used (e.g. ?utm_source=chatgpt-recommendation)
  //
  // Querying all three ensures comprehensive AI traffic detection regardless of
  // whether it arrives via referrer header or utm_source parameter.
  const PAGE_SIZE = 1000
  const rows: GA4AiReferralRow[] = []

  // Each entry: [sourceDimension, mediumDimension, label for storage]
  const dimensionPairs: Array<[string, string, GA4SourceDimension]> = [
    ['sessionSource', 'sessionMedium', 'session'],
    ['firstUserSource', 'firstUserMedium', 'first_user'],
    ['sessionManualSource', 'sessionManualMedium', 'manual_utm'],
  ]

  for (const [sourceDim, mediumDim, dimLabel] of dimensionPairs) {
    let offset = 0
    let aiRefPageCount = 0
    while (aiRefPageCount < GA4_MAX_PAGES) {
      aiRefPageCount++
      const request: GA4RunReportRequest = {
        dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }],
        dimensions: [
          { name: 'date' },
          { name: sourceDim },
          { name: mediumDim },
        ],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
        ],
        dimensionFilter: {
          orGroup: {
            expressions: AI_REFERRAL_SOURCE_FILTERS.map(({ matchType, value }) => ({
              filter: {
                fieldName: sourceDim,
                stringFilter: { matchType, value },
              },
            })),
          },
        },
        limit: PAGE_SIZE,
        offset,
      }

      const response = await runReport(accessToken, propertyId, request)
      const pageRows: GA4AiReferralRow[] = (response.rows ?? []).map((row) => ({
        date: row.dimensionValues[0]!.value,
        source: row.dimensionValues[1]!.value,
        medium: row.dimensionValues[2]!.value,
        sessions: parseInt(row.metricValues[0]!.value, 10) || 0,
        users: parseInt(row.metricValues[1]!.value, 10) || 0,
        sourceDimension: dimLabel,
      }))

      rows.push(...pageRows)

      const totalRows = response.rowCount ?? 0
      offset += pageRows.length
      if (pageRows.length < PAGE_SIZE || offset >= totalRows) break
    }
  }

  // Deduplicate within each dimension: if the same date+source+medium+dimension
  // appears multiple times (shouldn't happen, but defensive), keep the higher count.
  const deduped = new Map<string, GA4AiReferralRow>()
  for (const row of rows) {
    const key = `${row.date}::${row.source}::${row.medium}::${row.sourceDimension}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, row)
    } else {
      // Take the max of each metric independently to avoid discarding higher counts
      deduped.set(key, {
        ...existing,
        sessions: Math.max(existing.sessions, row.sessions),
        users: Math.max(existing.users, row.users),
      })
    }
  }
  const dedupedRows = [...deduped.values()]

  // Convert YYYYMMDD to YYYY-MM-DD
  for (const row of dedupedRows) {
    if (row.date.length === 8 && !row.date.includes('-')) {
      row.date = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`
    }
  }

  ga4Log('info', 'fetch-ai-referrals.done', { propertyId, rowCount: dedupedRows.length })
  return dedupedRows
}

// Social channel groups from GA4's default channel grouping.
// Google maintains the source→channel mapping; we filter on their classification
// rather than hardcoding source patterns. See:
// https://support.google.com/analytics/answer/9756891
const SOCIAL_CHANNEL_GROUPS = ['Organic Social', 'Paid Social']

/**
 * Fetch traffic from social media referral sources using GA4's native
 * sessionDefaultChannelGroup classification. This uses Google's maintained
 * source→channel mapping rather than hardcoded source patterns.
 *
 * Uses sessionSource/sessionMedium for per-source breakdowns within the
 * social channel groups. Does NOT query firstUserSource (acquisition, not
 * referral) or sessionManualSource (UTM-only edge case).
 */
export async function fetchSocialReferrals(
  accessToken: string,
  propertyId: string,
  days?: number,
): Promise<GA4SocialReferralRow[]> {
  validateAccessToken(accessToken)
  validatePropertyId(propertyId)
  const syncDays = Math.min(Math.max(1, days ?? GA4_DEFAULT_SYNC_DAYS), GA4_MAX_SYNC_DAYS)
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - syncDays)

  ga4Log('info', 'fetch-social-referrals.start', { propertyId, days: syncDays })

  const PAGE_SIZE = 1000
  const rows: GA4SocialReferralRow[] = []
  let offset = 0

  while (true) {
    const request: GA4RunReportRequest = {
      dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }],
      dimensions: [
        { name: 'date' },
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
        { name: 'sessionDefaultChannelGroup' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
      ],
      dimensionFilter: {
        orGroup: {
          expressions: SOCIAL_CHANNEL_GROUPS.map((value) => ({
            filter: {
              fieldName: 'sessionDefaultChannelGroup',
              stringFilter: { matchType: 'EXACT' as const, value },
            },
          })),
        },
      },
      limit: PAGE_SIZE,
      offset,
    }

    const response = await runReport(accessToken, propertyId, request)
    const pageRows: GA4SocialReferralRow[] = (response.rows ?? []).map((row) => ({
      date: row.dimensionValues[0]!.value,
      source: row.dimensionValues[1]!.value,
      medium: row.dimensionValues[2]!.value,
      sessions: parseInt(row.metricValues[0]!.value, 10) || 0,
      users: parseInt(row.metricValues[1]!.value, 10) || 0,
      channelGroup: row.dimensionValues[3]!.value,
    }))

    rows.push(...pageRows)

    const totalRows = response.rowCount ?? 0
    offset += pageRows.length
    if (pageRows.length < PAGE_SIZE || offset >= totalRows) break
  }

  // Convert YYYYMMDD to YYYY-MM-DD
  for (const row of rows) {
    if (row.date.length === 8 && !row.date.includes('-')) {
      row.date = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`
    }
  }

  ga4Log('info', 'fetch-social-referrals.done', { propertyId, rowCount: rows.length })
  return rows
}
