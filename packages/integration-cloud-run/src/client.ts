import { buildCloudRunLogFilter } from './filter.js'
import { normalizeCloudRunLogEntry } from './normalize.js'
import type {
  CloudRunListLogEntriesResponse,
  CloudRunTrafficEventsPage,
  ListCloudRunTrafficEventsOptions,
} from './types.js'

const CLOUD_LOGGING_ENTRIES_LIST_URL = 'https://logging.googleapis.com/v2/entries:list'
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_PAGES = 1
const DEFAULT_TIMEOUT_MS = 30_000

export class CloudRunLoggingApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'CloudRunLoggingApiError'
  }
}

function validateAccessToken(accessToken: string): void {
  if (!accessToken.trim()) {
    throw new CloudRunLoggingApiError('Cloud Logging access token is required', 400)
  }
}

function validateProjectId(gcpProjectId: string): void {
  if (!gcpProjectId.trim()) {
    throw new CloudRunLoggingApiError('GCP project ID is required', 400)
  }
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new CloudRunLoggingApiError('pageSize must be a positive integer', 400)
  }
  return pageSize
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new CloudRunLoggingApiError('maxPages must be a positive integer', 400)
  }
  return maxPages
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '')
  if (!text) return undefined
  return text.length <= 500 ? text : `${text.slice(0, 500)}... [truncated]`
}

export async function listCloudRunTrafficEvents(
  accessToken: string,
  options: ListCloudRunTrafficEventsOptions,
): Promise<CloudRunTrafficEventsPage> {
  validateAccessToken(accessToken)
  validateProjectId(options.gcpProjectId)

  const filter = buildCloudRunLogFilter(options)
  const pageSize = normalizePageSize(options.pageSize)
  const maxPages = normalizeMaxPages(options.maxPages)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let pageToken = options.pageToken
  let rawEntryCount = 0
  let skippedEntryCount = 0
  const events: CloudRunTrafficEventsPage['events'] = []

  const orderBy = options.orderBy ?? (options.firstSync ? 'timestamp desc' : 'timestamp asc')

  for (let page = 0; page < maxPages; page += 1) {
    const requestBody: Record<string, unknown> = {
      resourceNames: [`projects/${options.gcpProjectId}`],
      filter,
      orderBy,
      pageSize,
    }
    if (pageToken) {
      requestBody.pageToken = pageToken
    }

    const response = await fetch(CLOUD_LOGGING_ENTRIES_LIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new CloudRunLoggingApiError(
        `Cloud Logging entries.list failed with HTTP ${response.status}`,
        response.status,
        body,
      )
    }

    const body = (await response.json()) as CloudRunListLogEntriesResponse
    const entries = body.entries ?? []
    rawEntryCount += entries.length

    for (const entry of entries) {
      const event = normalizeCloudRunLogEntry(entry)
      if (event) {
        events.push(event)
      } else {
        skippedEntryCount += 1
      }
    }

    pageToken = body.nextPageToken
    if (!pageToken) break
  }

  return {
    events,
    rawEntryCount,
    skippedEntryCount,
    nextPageToken: pageToken,
    filter,
  }
}
