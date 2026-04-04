import { GSC_API_BASE, URL_INSPECTION_API, GSC_MAX_ROWS_PER_REQUEST, INDEXING_API_BASE, GOOGLE_REQUEST_TIMEOUT_MS } from './constants.js'
import type {
  GscSite,
  GscSitemap,
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
  GscSearchAnalyticsResponse,
  GscUrlInspectionResult,
  IndexingApiResponse,
} from './types.js'
import { GoogleApiError } from './types.js'

function validateAccessToken(accessToken: string): void {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new GoogleApiError('Access token is required and must be a non-empty string', 400)
  }
}

function validateSiteUrl(siteUrl: string): void {
  if (!siteUrl || typeof siteUrl !== 'string' || siteUrl.trim().length === 0) {
    throw new GoogleApiError('Site URL is required and must be a non-empty string', 400)
  }
  // Accept both https://example.com and sc-domain:example.com patterns
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length)
    if (!domain) {
      throw new GoogleApiError('Site URL sc-domain must include a domain', 400)
    }
    // Domain validation: simple check for at least one dot
    if (!domain.includes('.')) {
      throw new GoogleApiError('Site URL sc-domain must be a valid domain', 400)
    }
  } else {
    try {
      const url = new URL(siteUrl)
      if (!url.protocol.startsWith('http')) {
        throw new GoogleApiError('Site URL must be an HTTP or HTTPS URL', 400)
      }
    } catch {
      throw new GoogleApiError('Site URL must be a valid URL', 400)
    }
  }
}

function validateUrl(urlParam: string): void {
  if (!urlParam || typeof urlParam !== 'string' || urlParam.trim().length === 0) {
    throw new GoogleApiError('URL is required and must be a non-empty string', 400)
  }
  try {
    const url = new URL(urlParam)
    if (!url.protocol.startsWith('http')) {
      throw new GoogleApiError('URL must be an HTTP or HTTPS URL', 400)
    }
  } catch {
    throw new GoogleApiError('URL must be a valid URL', 400)
  }
}

function gscClientLog(level: 'info' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, module: 'GscClient', action, ...ctx }
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

async function gscFetch<T>(accessToken: string, url: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const method = opts?.method ?? 'GET'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const res = await fetch(url, {
    method,
    headers,
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  })

  if (res.status === 401) {
    const body = await res.text().catch(() => '')
    gscClientLog('error', 'http.auth-expired', { url, method, httpStatus: 401, responseBody: body })
    throw new GoogleApiError('Access token expired or revoked', 401)
  }

  if (res.status === 429) {
    const body = await res.text().catch(() => '')
    gscClientLog('error', 'http.rate-limited', { url, method, httpStatus: 429, responseBody: body })
    throw new GoogleApiError('Google API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    gscClientLog('error', 'http.error', { url, method, httpStatus: res.status, responseBody: body })
    throw new GoogleApiError(`GSC API error (${res.status}): ${body}`, res.status)
  }

  return (await res.json()) as T
}

export async function listSites(accessToken: string): Promise<GscSite[]> {
  validateAccessToken(accessToken)
  const data = await gscFetch<{ siteEntry?: GscSite[] }>(
    accessToken,
    `${GSC_API_BASE}/sites`,
  )
  return data.siteEntry ?? []
}

export async function listSitemaps(accessToken: string, siteUrl: string): Promise<GscSitemap[]> {
  validateAccessToken(accessToken)
  validateSiteUrl(siteUrl)
  const encodedSiteUrl = encodeURIComponent(siteUrl)
  const data = await gscFetch<{ sitemap?: GscSitemap[] }>(
    accessToken,
    `${GSC_API_BASE}/sites/${encodedSiteUrl}/sitemaps`,
  )
  return data.sitemap ?? []
}

export interface FetchSearchAnalyticsOptions {
  startDate: string
  endDate: string
  dimensions?: string[]
  query?: string
  page?: string
}

export async function fetchSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  opts: FetchSearchAnalyticsOptions,
): Promise<GscSearchAnalyticsRow[]> {
  validateAccessToken(accessToken)
  validateSiteUrl(siteUrl)
  const allRows: GscSearchAnalyticsRow[] = []
  let startRow = 0
  const dimensions = opts.dimensions ?? ['query', 'page', 'country', 'device', 'date']

  for (;;) {
    const requestBody: GscSearchAnalyticsRequest = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions,
      rowLimit: GSC_MAX_ROWS_PER_REQUEST,
      startRow,
    }

    if (opts.query || opts.page) {
      const filters: GscSearchAnalyticsRequest['dimensionFilterGroups'] = []
      const filterList: Array<{ dimension: string; operator: string; expression: string }> = []
      if (opts.query) filterList.push({ dimension: 'query', operator: 'contains', expression: opts.query })
      if (opts.page) filterList.push({ dimension: 'page', operator: 'contains', expression: opts.page })
      filters.push({ filters: filterList })
      requestBody.dimensionFilterGroups = filters
    }

    const encodedSiteUrl = encodeURIComponent(siteUrl)
    const data = await gscFetch<GscSearchAnalyticsResponse>(
      accessToken,
      `${GSC_API_BASE}/sites/${encodedSiteUrl}/searchAnalytics/query`,
      { method: 'POST', body: requestBody },
    )

    const rows = data.rows ?? []
    allRows.push(...rows)

    if (rows.length < GSC_MAX_ROWS_PER_REQUEST) {
      break
    }
    startRow += rows.length
  }

  return allRows
}

export async function publishUrlNotification(
  accessToken: string,
  url: string,
  type: 'URL_UPDATED' | 'URL_DELETED' = 'URL_UPDATED',
): Promise<IndexingApiResponse> {
  validateAccessToken(accessToken)
  validateUrl(url)
  return gscFetch<IndexingApiResponse>(
    accessToken,
    `${INDEXING_API_BASE}/urlNotifications:publish`,
    {
      method: 'POST',
      body: { url, type },
    },
  )
}

export async function getUrlNotificationStatus(
  accessToken: string,
  url: string,
): Promise<IndexingApiResponse> {
  validateAccessToken(accessToken)
  validateUrl(url)
  const encodedUrl = encodeURIComponent(url)
  return gscFetch<IndexingApiResponse>(
    accessToken,
    `${INDEXING_API_BASE}/urlNotifications/metadata?url=${encodedUrl}`,
  )
}

export async function inspectUrl(
  accessToken: string,
  inspectionUrl: string,
  siteUrl: string,
): Promise<GscUrlInspectionResult> {
  validateAccessToken(accessToken)
  validateUrl(inspectionUrl)
  validateSiteUrl(siteUrl)
  return gscFetch<GscUrlInspectionResult>(
    accessToken,
    URL_INSPECTION_API,
    {
      method: 'POST',
      body: {
        inspectionUrl,
        siteUrl,
      },
    },
  )
}
