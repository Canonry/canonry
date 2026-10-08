import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

/**
 * Wire shape of one event row emitted by the canonry traffic-logger plugin's
 * `GET /wp-json/canonry/v1/events` endpoint. Field names mirror the plugin's
 * DB column names so the plugin can serialize rows directly without an
 * intermediate transform.
 *
 * The plugin captures requests post-hygiene-filter (no static assets, no
 * `/wp-admin/`, no POSTs by default). It does NOT classify; UA pattern and
 * referer matching happen server-side in `packages/integration-traffic`.
 *
 * The plugin records the real client IP (plugin 0.3.0+), so `remoteIp` on
 * the normalized event is a routable address the classifier can verify
 * against published operator IP ranges, the same as the Cloud Run adapter.
 */
export interface WordpressTrafficEventPayload {
  /** Plugin-assigned auto-increment id; used as the pagination cursor. */
  id: number
  /** ISO 8601 timestamp recorded by the plugin at request time. */
  observed_at: string
  method: string | null
  /** Request `Host` header (host only, no scheme). */
  host: string | null
  /** Path component; always populated, never includes the query string. */
  path: string
  /** Query string (without the leading `?`); null if none. */
  query_string: string | null
  /** HTTP response status as observed by the plugin. */
  status: number | null
  user_agent: string | null
  /** Real client IP (IPv4 or IPv6), or null when none was captured. */
  remote_ip: string | null
  referer: string | null
}

/**
 * Top-level response shape of `GET /wp-json/canonry/v1/events`.
 * `next_cursor` is opaque to canonry — pass it back verbatim as `?cursor=`.
 * It is a nonempty string exactly when `has_more=true`, and otherwise null.
 */
export interface WordpressTrafficEventsResponseBody {
  events: WordpressTrafficEventPayload[]
  next_cursor: string | null
  has_more: boolean
  /** Optional site metadata for diagnostics; not required for normalization. */
  site?: {
    url?: string
    anonymous_id?: string
    wordpress_version?: string
    plugin_version?: string
  }
}

/** The fetch shape `listWordpressTrafficEvents` calls. */
export type WordpressTrafficFetch = (url: URL, init: RequestInit) => Promise<Response>

export interface ListWordpressTrafficEventsOptions {
  /** Absolute base URL of the WP site, e.g. `https://example.com`. The plugin path is appended automatically. */
  baseUrl: string
  /** WordPress username paired with the Application Password. */
  username: string
  /** WordPress Application Password (raw; the client base64-encodes it for Basic auth). */
  applicationPassword: string
  /** Opaque cursor returned from a previous page's `next_cursor`. */
  cursor?: string
  pageSize?: number
  maxPages?: number
  timeoutMs?: number
  /**
   * The fetch every page request goes through. Defaults to global `fetch`.
   * The api-routes caller passes its egress-guarded fetch, which checks the
   * address of each request and of every redirect hop and dials only that
   * address, so neither DNS rebinding nor a redirect (to an IP literal or to
   * a name) can carry the Basic-auth credentials to an internal host.
   */
  fetchImpl?: WordpressTrafficFetch
  /**
   * Optional INCLUSIVE lower bound on `observed_at` — ISO 8601. When set,
   * the plugin returns only events with `observed_at >= since`. Used by the
   * backfill route to scope a historical pull to a specific window.
   * Composes with `cursor` for pagination within the window.
   */
  since?: string
  /**
   * Optional EXCLUSIVE upper bound on `observed_at` — ISO 8601. When set,
   * the plugin returns only events with `observed_at < until`. The
   * half-open convention `[since, until)` lets adjacent windows tile
   * without overlap.
   */
  until?: string
}

export interface WordpressTrafficEventsPage {
  events: NormalizedTrafficRequest[]
  rawEntryCount: number
  skippedEntryCount: number
  /**
   * Opaque cursor returned by the plugin's `next_cursor` field when another
   * page remains. Persist it verbatim on the source row as `last_cursor` and
   * replay it with the same fixed lower and upper time bounds. The plugin
   * returns no cursor once `has_more=false`, which tells the caller to clear
   * any persisted cursor.
   */
  nextCursor?: string
  /**
   * Mirrors the plugin's `has_more` boolean. `true` means another page is
   * waiting at `nextCursor` and the caller should keep fetching within
   * this sync. `false` means the plugin is caught up — clear `nextCursor`
   * and stop iterating. The integration rejects a response that omits or
   * contradicts `has_more` / `next_cursor`; it never guesses that a page is
   * terminal.
   */
  hasMore: boolean
  /** Resolved REST endpoint path, useful for diagnostics. */
  endpoint: string
}
