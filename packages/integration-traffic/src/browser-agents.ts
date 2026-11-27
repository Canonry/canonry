import { BrowserAgentRequestKinds, classifyTrafficPath, pathWithoutQuery, TrafficPathClasses, type BrowserAgentRequestKind, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { DEFAULT_AI_CRAWLER_RULES } from './rules.js'

// The kinds live in contracts, beside the sample schema that carries them.
export { BrowserAgentRequestKinds }
export type { BrowserAgentRequestKind }

/**
 * Hosted browsers that browse and act for a person (`AiCrawlerRule.browser`:
 * Google-Agent, Claude-Agent) load a page the way a person's browser does.
 * One page load brings its scripts, styles, images and fonts, framework data,
 * prefetches of the links in view and analytics beacons: about twenty
 * requests where a link fetcher such as Claude-User makes one. Logs carry no
 * `Sec-Fetch-Dest`, so which requests the agent made and which its page made
 * by itself is read from the method, path and query (`browserAgentRequestKind`).
 */

// Query parameters only a page's own fetches carry: Next.js React Server
// Component payloads (a client-side navigation and the prefetch of every link
// in view, which logs cannot tell apart), Remix v2 route data (`_data`),
// Shopify section rendering (`section_id`, `sections`) and WooCommerce AJAX.
const RESOURCE_QUERY_PARAMETERS: readonly string[] = ['_rsc', '_data', 'section_id', 'sections', 'wc-ajax']
// Files a person opens or downloads: documents, spreadsheets, slides,
// e-books, archives and static HTML pages. A GET for one is a page load
// wherever the file is kept, such as WordPress uploads (`/wp-content/uploads/`)
// or an API reference page (`/api/fs.html`), and so is a page's own fetch of
// one, such as a chart's CSV.
const DOCUMENT_FILE = /\.(?:pdf|docx?|xlsx?|pptx?|od[pst]|rtf|csv|tsv|txt|epub|mobi|zip|html?)$/
// Folders that hold what a page fetches by itself, matched at any depth so an
// app served under a sub-path (`/docs/_next/image`, `/blog/wp-json/`) reads
// the same: framework build output, image optimizers and route data (Next.js
// incl. `/_next/image` and `/_next/data/`, Nuxt, Nuxt Image, Astro, Blazor
// WebAssembly's `_framework`), platform analytics, image, function and
// identity endpoints (Vercel, Cloudflare, Netlify), and WordPress theme,
// plugin, upload and REST files.
const RESOURCE_FOLDERS: ReadonlySet<string> = new Set([
  '_next', '_nuxt', '_ipx', '_astro', '_framework', '_vercel', 'cdn-cgi', '.netlify',
  'wp-content', 'wp-includes', 'wp-json',
])
// Endpoints a page calls by itself, at any depth: Astro's image optimizer and
// WordPress AJAX.
const RESOURCE_ENDPOINTS: readonly string[] = ['/_image', '/wp-admin/admin-ajax.php']
// API calls, as the first path segment only, so a docs site's `/docs/api/...`
// pages stay pages. An extensionless API reference page at the site root
// (`/api/reactivity-core`) reads as a call.
const API_ROOT_FOLDERS: ReadonlySet<string> = new Set(['api', 'graphql'])
// Azure App Service and Static Web Apps calls a page makes by itself: the
// signed-in user check and the token refresh. Signing in and out are page loads.
const AZURE_AUTH_CALLS: ReadonlySet<string> = new Set(['/.auth/me', '/.auth/refresh'])
// React Router's route data (`/pricing.data`), which `classifyTrafficPath`
// reads as content.
const ROUTE_DATA_FILE = /\.data$/
// Vercel's first-party intake folders for Web Analytics and Speed Insights.
const VERCEL_BEACON_FOLDERS: ReadonlySet<string> = new Set(['insights', 'speed-insights'])
// WooCommerce AJAX calls its scripts post by themselves: the cart fragment
// refresh, the checkout's order review and the product variation lookup.
const WOOCOMMERCE_BACKGROUND_CALLS: ReadonlySet<string> = new Set(['get_refreshed_fragments', 'update_order_review', 'get_variation'])

/** The path, lowercased, without its query, fragment or trailing slashes. */
function comparablePath(path: string): string {
  const lower = pathWithoutQuery(path).toLowerCase()
  return lower.length > 1 ? lower.replace(/\/+$/, '') || '/' : lower
}

/**
 * A write a page's own scripts send, never the agent's action: Vercel's
 * analytics and Speed Insights beacons, anything sent to Cloudflare's
 * `/cdn-cgi/` (browser insights and bot checks; Cloudflare serves that folder
 * itself), WooCommerce's background AJAX, and WordPress Heartbeat when its
 * action is in the URL. WordPress's own Heartbeat script sends the action in
 * the request body, which logs lack, so its heartbeats read as actions.
 */
function isBackgroundWrite(path: string, segments: readonly string[], query: URLSearchParams | null): boolean {
  for (const [index, segment] of segments.entries()) {
    if (segment === 'cdn-cgi') return true
    if (segment === '_vercel' && VERCEL_BEACON_FOLDERS.has(segments[index + 1] ?? '')) return true
  }
  const wooCommerceCall = query?.get('wc-ajax')
  if (wooCommerceCall && WOOCOMMERCE_BACKGROUND_CALLS.has(wooCommerceCall)) return true
  return path.endsWith('/wp-admin/admin-ajax.php') && query?.get('action') === 'heartbeat'
}

/** A path a page fetches by itself: the folder, endpoint and file lists above, and static files. */
function isResourcePath(path: string, segments: readonly string[]): boolean {
  if (AZURE_AUTH_CALLS.has(path) || API_ROOT_FOLDERS.has(segments[0] ?? '')) return true
  if (segments.some(segment => RESOURCE_FOLDERS.has(segment))) return true
  if (RESOURCE_ENDPOINTS.some(endpoint => path.endsWith(endpoint))) return true
  return ROUTE_DATA_FILE.test(path) || classifyTrafficPath(path) === TrafficPathClasses.asset
}

/**
 * What a browser agent's request was: a page load it made, an action it sent,
 * or a resource its page fetched or sent by itself. The method decides first:
 * HEAD and OPTIONS are resources, and any other method but GET is an action
 * unless it is a page's background write. A GET is then a resource when its
 * query marks a page's own fetch, a page when it opens a document or a
 * download, a resource when its path is one a page fetches by itself, and
 * otherwise a page. A request with no method reads as a GET.
 */
export function browserAgentRequestKind(request: Pick<NormalizedTrafficRequest, 'method' | 'path' | 'queryString'>): BrowserAgentRequestKind {
  const method = request.method?.trim().toUpperCase() || 'GET'
  if (method === 'HEAD' || method === 'OPTIONS') return BrowserAgentRequestKinds.resource
  const path = comparablePath(request.path)
  const segments = path.split('/').filter(Boolean)
  const query = request.queryString ? new URLSearchParams(request.queryString) : null
  if (method !== 'GET') {
    return isBackgroundWrite(path, segments, query) ? BrowserAgentRequestKinds.resource : BrowserAgentRequestKinds.action
  }
  if (query && RESOURCE_QUERY_PARAMETERS.some(name => query.has(name))) return BrowserAgentRequestKinds.resource
  if (DOCUMENT_FILE.test(path)) return BrowserAgentRequestKinds.page
  return isResourcePath(path, segments) ? BrowserAgentRequestKinds.resource : BrowserAgentRequestKinds.page
}

/**
 * Version of the browser-agent request rules: `browserAgentRequestKind`,
 * `countsAsAiUserFetchHit` and `keepsBrowserAgentJourneyRequest`. Bump it when
 * a change to them alters which requests count as AI user fetch hits or which
 * journey requests are kept, so the stored-traffic pass runs again and marks
 * the sources whose stored hours were counted the old way.
 */
export const BROWSER_AGENT_REQUEST_RULES_VERSION = 1

/**
 * Whether an AI user fetch that is not likely fake counts as a hit: every
 * request of a link fetcher, and only a browser agent's page loads. Likely
 * fakes are routed to their own counts before this check, at ingest and in the
 * stored-traffic pass alike.
 */
export function countsAsAiUserFetchHit(
  fetch: { browser?: boolean },
  request: Pick<NormalizedTrafficRequest, 'method' | 'path' | 'queryString'>,
): boolean {
  return !fetch.browser || browserAgentRequestKind(request) === BrowserAgentRequestKinds.page
}

/**
 * Whether a browser agent's request stays in its agent journey: the page loads
 * and actions it made, and any request that failed (HTTP 400-599), so a blocked
 * file, data call or API request stays visible with its error.
 */
export function keepsBrowserAgentJourneyRequest(
  request: Pick<NormalizedTrafficRequest, 'method' | 'path' | 'queryString' | 'status'>,
): boolean {
  if (request.status !== null && request.status >= 400) return true
  return browserAgentRequestKind(request) !== BrowserAgentRequestKinds.resource
}

/** Bot ids of the hosted browser agents (`AiCrawlerRule.browser`). */
export const BROWSER_AGENT_BOT_IDS: readonly string[] = DEFAULT_AI_CRAWLER_RULES
  .filter(rule => rule.browser === true)
  .map(rule => rule.id)

const BROWSER_AGENT_BOT_ID_SET: ReadonlySet<string> = new Set(BROWSER_AGENT_BOT_IDS)

/** Whether a stored bot or agent id names a hosted browser agent. */
export function isBrowserAgentId(botId: string): boolean {
  return BROWSER_AGENT_BOT_ID_SET.has(botId)
}
