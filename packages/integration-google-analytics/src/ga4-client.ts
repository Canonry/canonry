import crypto from 'node:crypto'
import {
  GA4_DATA_API_BASE,
  GA4_SCOPE,
  GOOGLE_TOKEN_URL,
  GA4_DEFAULT_SYNC_DAYS,
  GA4_MAX_SYNC_DAYS,
} from './constants.js'
import type {
  GA4RunReportRequest,
  GA4RunReportResponse,
  GA4TrafficRow,
} from './types.js'
import { GA4ApiError } from './types.js'

function ga4Log(level: 'info' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, module: 'GA4Client', action, ...ctx }
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

/**
 * Create a signed JWT for Google service account authentication.
 * Uses Node.js built-in crypto — no external dependencies.
 */
export function createServiceAccountJwt(clientEmail: string, privateKey: string, scope: string): string {
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
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    ga4Log('error', 'token.failed', { httpStatus: res.status, responseBody: body })
    throw new GA4ApiError(`Failed to get access token: ${body}`, res.status)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  return data.access_token
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
    ga4Log('error', 'report.auth-failed', { propertyId, httpStatus: res.status, responseBody: body })
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
    ga4Log('error', 'report.error', { propertyId, httpStatus: res.status, responseBody: body })
    throw new GA4ApiError(`GA4 API error (${res.status}): ${body}`, res.status)
  }

  return (await res.json()) as GA4RunReportResponse
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]!
}

/**
 * Fetch landing page traffic data for the given number of days.
 * Returns per-day, per-page traffic rows.
 */
export async function fetchTrafficByLandingPage(
  accessToken: string,
  propertyId: string,
  days?: number,
): Promise<GA4TrafficRow[]> {
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
  while (true) {
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
  while (true) {
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
  const accessToken = await getAccessToken(clientEmail, privateKey)

  // Run a minimal report to verify access
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
