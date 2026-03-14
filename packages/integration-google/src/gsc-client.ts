import { GSC_API_BASE, URL_INSPECTION_API, GSC_MAX_ROWS_PER_REQUEST } from './constants.js'
import type {
  GscSite,
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
  GscSearchAnalyticsResponse,
  GscUrlInspectionResult,
} from './types.js'
import { GoogleApiError } from './types.js'

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
  })

  if (res.status === 401) {
    throw new GoogleApiError('Access token expired or revoked', 401)
  }

  if (res.status === 429) {
    throw new GoogleApiError('Google API rate limit exceeded', 429)
  }

  if (!res.ok) {
    const body = await res.text()
    throw new GoogleApiError(`GSC API error (${res.status}): ${body}`, res.status)
  }

  return (await res.json()) as T
}

export async function listSites(accessToken: string): Promise<GscSite[]> {
  const data = await gscFetch<{ siteEntry?: GscSite[] }>(
    accessToken,
    `${GSC_API_BASE}/sites`,
  )
  return data.siteEntry ?? []
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

export async function inspectUrl(
  accessToken: string,
  inspectionUrl: string,
  siteUrl: string,
): Promise<GscUrlInspectionResult> {
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
