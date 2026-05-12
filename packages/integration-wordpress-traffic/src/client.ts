import { normalizeWordpressTrafficEvent } from './normalize.js'
import type {
  ListWordpressTrafficEventsOptions,
  WordpressTrafficEventsPage,
  WordpressTrafficEventsResponseBody,
} from './types.js'

const WORDPRESS_TRAFFIC_ENDPOINT_PATH = '/wp-json/canonry/v1/events'
const DEFAULT_PAGE_SIZE = 500
const DEFAULT_MAX_PAGES = 1
const DEFAULT_TIMEOUT_MS = 30_000

export class WordpressTrafficApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'WordpressTrafficApiError'
  }
}

function trimRequired(name: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new WordpressTrafficApiError(`${name} is required`, 400)
  }
  return trimmed
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new WordpressTrafficApiError('pageSize must be a positive integer', 400)
  }
  return pageSize
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new WordpressTrafficApiError('maxPages must be a positive integer', 400)
  }
  return maxPages
}

function resolveEndpoint(baseUrl: string): string {
  const trimmed = trimRequired('baseUrl', baseUrl).replace(/\/+$/, '')
  return `${trimmed}${WORDPRESS_TRAFFIC_ENDPOINT_PATH}`
}

function buildBasicAuthHeader(username: string, applicationPassword: string): string {
  const credentials = `${trimRequired('username', username)}:${trimRequired('applicationPassword', applicationPassword)}`
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '')
  if (!text) return undefined
  return text.length <= 500 ? text : `${text.slice(0, 500)}... [truncated]`
}

/**
 * Fetch a page (or up to `maxPages` pages) of WordPress traffic events from
 * the canonry traffic-logger plugin's REST endpoint, normalize each event into
 * `NormalizedTrafficRequest`, and return the merged page along with the
 * opaque cursor to resume from.
 *
 * Pure pull adapter — no DB, no classification, no credential storage. The
 * caller (API route or sync orchestrator) supplies the WordPress Application
 * Password and persists the returned cursor.
 */
export async function listWordpressTrafficEvents(
  options: ListWordpressTrafficEventsOptions,
): Promise<WordpressTrafficEventsPage> {
  const endpoint = resolveEndpoint(options.baseUrl)
  const authHeader = buildBasicAuthHeader(options.username, options.applicationPassword)
  const pageSize = normalizePageSize(options.pageSize)
  const maxPages = normalizeMaxPages(options.maxPages)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let cursor = options.cursor
  let rawEntryCount = 0
  let skippedEntryCount = 0
  let hasMore = false
  const events: WordpressTrafficEventsPage['events'] = []

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint)
    url.searchParams.set('limit', String(pageSize))
    if (cursor !== undefined && cursor !== '') {
      url.searchParams.set('cursor', cursor)
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const body = await readErrorBody(response)
      throw new WordpressTrafficApiError(
        `WordPress traffic endpoint returned HTTP ${response.status}`,
        response.status,
        body,
      )
    }

    const body = (await response.json()) as WordpressTrafficEventsResponseBody
    const entries = body.events ?? []
    rawEntryCount += entries.length

    for (const entry of entries) {
      const normalized = normalizeWordpressTrafficEvent(entry)
      if (normalized) {
        events.push(normalized)
      } else {
        skippedEntryCount += 1
      }
    }

    cursor = body.next_cursor ?? undefined
    // Track the latest `has_more` so a single-page call (maxPages=1)
    // surfaces the plugin's continuation signal to the caller. Internal
    // pagination still uses the same break rule as before.
    hasMore = Boolean(body.has_more) && Boolean(cursor)
    if (!body.has_more || !cursor) break
  }

  return {
    events,
    rawEntryCount,
    skippedEntryCount,
    nextCursor: cursor,
    hasMore,
    endpoint,
  }
}
