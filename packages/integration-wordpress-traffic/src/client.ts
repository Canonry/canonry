import { randomUUID } from 'node:crypto'
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

interface RequestedWindowBoundary {
  value: string
  timestampMs: number
}

interface RequestedWindow {
  since?: RequestedWindowBoundary
  until?: RequestedWindowBoundary
}

interface ParsedWordpressTrafficEventsResponseBody {
  events: unknown[]
  nextCursor: string | null
  hasMore: boolean
  site?: WordpressTrafficEventsResponseBody['site']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequestedBoundary(
  name: 'since' | 'until',
  value: string | undefined,
): RequestedWindowBoundary | undefined {
  if (value === undefined || value === '') return undefined
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) {
    throw new WordpressTrafficApiError(`${name} must be a valid ISO 8601 timestamp`, 400)
  }
  return { value, timestampMs }
}

function parseRequestedWindow(options: ListWordpressTrafficEventsOptions): RequestedWindow {
  const since = parseRequestedBoundary('since', options.since)
  const until = parseRequestedBoundary('until', options.until)
  if (since && until && since.timestampMs >= until.timestampMs) {
    throw new WordpressTrafficApiError('since must be earlier than until', 400)
  }
  return { since, until }
}

function parseSiteMetadata(value: unknown): WordpressTrafficEventsResponseBody['site'] | undefined {
  if (!isRecord(value)) return undefined
  return {
    url: typeof value.url === 'string' ? value.url : undefined,
    anonymous_id: typeof value.anonymous_id === 'string' ? value.anonymous_id : undefined,
    wordpress_version: typeof value.wordpress_version === 'string' ? value.wordpress_version : undefined,
    plugin_version: typeof value.plugin_version === 'string' ? value.plugin_version : undefined,
  }
}

function invalidResponse(message: string): WordpressTrafficApiError {
  return new WordpressTrafficApiError(
    `WordPress traffic endpoint returned an invalid response: ${message}`,
    502,
  )
}

function parseResponseBody(value: unknown): ParsedWordpressTrafficEventsResponseBody {
  if (!isRecord(value)) {
    throw invalidResponse('expected an object body')
  }
  if (!Array.isArray(value.events)) {
    throw invalidResponse('events must be an array')
  }
  if (typeof value.has_more !== 'boolean') {
    throw invalidResponse('has_more must be a boolean')
  }

  const nextCursor = value.next_cursor
  if (value.has_more) {
    if (typeof nextCursor !== 'string' || nextCursor.trim().length === 0) {
      throw invalidResponse('has_more=true requires a nonempty next_cursor')
    }
  } else if (nextCursor !== null) {
    throw invalidResponse('has_more=false requires next_cursor=null')
  }

  return {
    events: value.events,
    nextCursor: nextCursor as string | null,
    hasMore: value.has_more,
    site: parseSiteMetadata(value.site),
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw invalidResponse('body is not valid JSON')
  }
}

function assertEntryIsWithinRequestedWindow(entry: unknown, window: RequestedWindow): void {
  if (!window.since && !window.until) return

  const observedAt = isRecord(entry) && typeof entry.observed_at === 'string'
    ? entry.observed_at
    : undefined
  const observedAtMs = observedAt === undefined ? Number.NaN : Date.parse(observedAt)
  const outsideWindow = !Number.isFinite(observedAtMs)
    || (window.since !== undefined && observedAtMs < window.since.timestampMs)
    || (window.until !== undefined && observedAtMs >= window.until.timestampMs)
  if (!outsideWindow) return

  const lower = window.since?.value ?? '-infinity'
  const upper = window.until?.value ?? '+infinity'
  throw new WordpressTrafficApiError(
    `WordPress traffic endpoint returned an invalid or out-of-window observed_at for the requested [${lower}, ${upper}) window. Upgrade to a bounded-window-capable Canonry traffic-logger extension before syncing.`,
    502,
  )
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
  const requestedWindow = parseRequestedWindow(options)

  let cursor = options.cursor
  let rawEntryCount = 0
  let skippedEntryCount = 0
  let hasMore = false
  const events: WordpressTrafficEventsPage['events'] = []
  const fetchImpl = options.fetchImpl ?? fetch

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint)
    url.searchParams.set('limit', String(pageSize))
    if (cursor !== undefined && cursor !== '') {
      url.searchParams.set('cursor', cursor)
    }
    if (options.since !== undefined && options.since !== '') {
      // INCLUSIVE lower bound — the plugin filters `observed_at >= since`.
      url.searchParams.set('since', options.since)
    }
    if (options.until !== undefined && options.until !== '') {
      // EXCLUSIVE upper bound — the plugin filters `observed_at < until`.
      url.searchParams.set('until', options.until)
    }
    // Cache-buster. Some WordPress hosts front the site with a page cache
    // (LiteSpeed and similar) that caches this REST response keyed on the URL
    // despite its no-cache headers. Without a unique param the sync's request
    // URL is identical every run, so it reads a frozen page and never sees new
    // events. A fresh value per request forces a distinct cache key.
    url.searchParams.set('_cb', randomUUID())

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
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

    const body = parseResponseBody(await readResponseJson(response))
    const entries = body.events
    rawEntryCount += entries.length

    for (const entry of entries) {
      assertEntryIsWithinRequestedWindow(entry, requestedWindow)
      if (!isRecord(entry)) {
        skippedEntryCount += 1
        continue
      }
      const normalized = normalizeWordpressTrafficEvent(
        entry as unknown as WordpressTrafficEventsResponseBody['events'][number],
        body.site,
      )
      if (normalized) {
        events.push(normalized)
      } else {
        skippedEntryCount += 1
      }
    }

    cursor = body.nextCursor ?? undefined
    // Track the latest `has_more` so a single-page call (maxPages=1)
    // surfaces the plugin's continuation signal to the caller. Internal
    // pagination still uses the same break rule as before.
    hasMore = body.hasMore
    if (!hasMore) break
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
