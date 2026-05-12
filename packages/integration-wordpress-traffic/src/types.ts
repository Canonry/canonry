import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

/**
 * Wire shape of one event row emitted by the canonry traffic-logger plugin's
 * `GET /wp-json/canonry/v1/events` endpoint. Field names mirror the plugin's
 * DB column names so the plugin can serialize rows directly without an
 * intermediate transform.
 *
 * The plugin captures requests post-hygiene-filter (no static assets, no
 * `/wp-admin/`, no POSTs by default). It does NOT classify — UA pattern /
 * referer matching happens server-side in `packages/integration-traffic`.
 *
 * IPs are hashed by the plugin (sha256 prefix) before the row is written, so
 * canonry never sees raw client IPs. Verification stays `claimed_unverified`
 * for every WordPress event until rDNS / IP-range verification is wired.
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
  /** SHA-256 prefix or null when hashing is disabled and no IP was captured. */
  remote_ip_hash: string | null
  referer: string | null
}

/**
 * Top-level response shape of `GET /wp-json/canonry/v1/events`.
 * `next_cursor` is opaque to canonry — pass it back verbatim as `?cursor=`.
 */
export interface WordpressTrafficEventsResponseBody {
  events: WordpressTrafficEventPayload[]
  next_cursor: string | null
  has_more: boolean
  /** Optional site metadata for diagnostics; not required for normalization. */
  site?: {
    url?: string
    wordpress_version?: string
    plugin_version?: string
  }
}

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
}

export interface WordpressTrafficEventsPage {
  events: NormalizedTrafficRequest[]
  rawEntryCount: number
  skippedEntryCount: number
  nextCursor?: string
  /** Resolved REST endpoint path, useful for diagnostics. */
  endpoint: string
}
