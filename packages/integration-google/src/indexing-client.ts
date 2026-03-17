import { INDEXING_API_BASE } from './constants.js'
import { GoogleApiError } from './types.js'

export interface UrlNotificationResult {
  urlNotificationMetadata: {
    url: string
    latestUpdate: {
      url: string
      type: string
      notifyTime: string
    }
  }
}

async function indexingFetch<T>(accessToken: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    throw new GoogleApiError('Access token expired or revoked', 401)
  }
  if (res.status === 429) {
    throw new GoogleApiError('Google Indexing API rate limit exceeded (200/day)', 429)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GoogleApiError(`Google Indexing API error: ${res.status} ${text}`, res.status)
  }

  return res.json() as Promise<T>
}

export async function requestIndexing(
  accessToken: string,
  url: string,
  type: 'URL_UPDATED' | 'URL_DELETED' = 'URL_UPDATED',
): Promise<UrlNotificationResult> {
  return indexingFetch<UrlNotificationResult>(
    accessToken,
    `${INDEXING_API_BASE}/urlNotifications:publish`,
    { url, type },
  )
}
