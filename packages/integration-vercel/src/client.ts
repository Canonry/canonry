import { normalizeVercelLogRow } from './normalize.js'
import type {
  ListVercelTrafficEventsOptions,
  VercelRequestLogsResponseBody,
  VercelTrafficEventsPage,
} from './types.js'

const VERCEL_REQUEST_LOGS_URL = 'https://vercel.com/api/logs/request-logs'
const DEFAULT_ENVIRONMENT = 'production'
const DEFAULT_MAX_PAGES = 1
const DEFAULT_TIMEOUT_MS = 30_000

export class VercelLogsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'VercelLogsApiError'
  }
}

function trimRequired(name: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new VercelLogsApiError(`${name} is required`, 400)
  }
  return trimmed
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new VercelLogsApiError('maxPages must be a positive integer', 400)
  }
  return maxPages
}

function toEpochMs(label: string, value: number | string | Date): string {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : new Date(value).getTime()
  if (!Number.isFinite(ms)) {
    throw new VercelLogsApiError(`${label} must be a valid date`, 400)
  }
  return String(Math.trunc(ms))
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '')
  if (!text) return undefined
  return text.length <= 500 ? text : `${text.slice(0, 500)}... [truncated]`
}

/**
 * Pull a page (or up to `maxPages` pages) of request logs from Vercel's
 * internal `request-logs` endpoint — the same endpoint the `vercel` CLI rides
 * — normalize each row into `NormalizedTrafficRequest`, and return the merged
 * page plus the `hasMore` continuation signal.
 *
 * Pure pull adapter — no DB, no classification, no credential storage. The
 * caller supplies the Vercel personal access token and bounds the time window.
 */
export async function listVercelTrafficEvents(
  options: ListVercelTrafficEventsOptions,
): Promise<VercelTrafficEventsPage> {
  const token = trimRequired('token', options.token)
  const projectId = trimRequired('projectId', options.projectId)
  const teamId = trimRequired('teamId', options.teamId)
  const environment = options.environment ?? DEFAULT_ENVIRONMENT
  const startDate = toEpochMs('startDate', options.startDate)
  const endDate = toEpochMs('endDate', options.endDate)
  const maxPages = normalizeMaxPages(options.maxPages)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let rawEntryCount = 0
  let skippedEntryCount = 0
  let hasMore = false
  const events: VercelTrafficEventsPage['events'] = []

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(VERCEL_REQUEST_LOGS_URL)
    url.searchParams.set('projectId', projectId)
    url.searchParams.set('ownerId', teamId)
    url.searchParams.set('teamId', teamId)
    url.searchParams.set('page', String(page))
    url.searchParams.set('startDate', startDate)
    url.searchParams.set('endDate', endDate)
    url.searchParams.set('environment', environment)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new VercelLogsApiError(
        `Vercel request-logs endpoint returned HTTP ${response.status}`,
        response.status,
        body,
      )
    }

    const body = (await response.json()) as VercelRequestLogsResponseBody
    const rows = body.rows ?? []
    rawEntryCount += rows.length

    for (const row of rows) {
      const event = normalizeVercelLogRow(row)
      if (event) {
        events.push(event)
      } else {
        skippedEntryCount += 1
      }
    }

    hasMore = Boolean(body.hasMoreRows)
    if (!hasMore) break
  }

  return {
    events,
    rawEntryCount,
    skippedEntryCount,
    hasMore,
    endpoint: VERCEL_REQUEST_LOGS_URL,
  }
}
