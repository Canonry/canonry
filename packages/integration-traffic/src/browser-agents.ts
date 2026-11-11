import { classifyTrafficPath, TrafficPathClasses, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { DEFAULT_AI_CRAWLER_RULES } from './rules.js'

/**
 * Hosted browsers that browse and act for a person (`AiCrawlerRule.browser`:
 * Google-Agent, Claude-Agent) load a page the way a person's browser does.
 * One page load brings its scripts, styles, images and fonts, framework data,
 * prefetches of the links in view and analytics beacons: about twenty
 * requests where a link fetcher such as Claude-User makes one. Logs carry no
 * `Sec-Fetch-Dest`, so which requests the agent made and which its page made
 * by itself is read from the method, path and query.
 */
export const BrowserAgentRequestKinds = {
  /** A GET the agent made: opening a page or a file. The only kind counted as an AI user fetch hit. */
  page: 'page',
  /** Another method the agent sent to a page, such as a form post. Kept in agent journeys, not counted. */
  action: 'action',
  /** What its page fetched by itself: files, data and API calls, prefetches, beacons, HEAD and OPTIONS. */
  resource: 'resource',
} as const
export type BrowserAgentRequestKind = (typeof BrowserAgentRequestKinds)[keyof typeof BrowserAgentRequestKinds]

// First path segments that hold what a page fetches by itself: framework build
// output, image optimizers and route data (Next.js `/_next/image` and
// `/_next/data/`, Nuxt, Nuxt Image, Astro), platform analytics, image, function
// and auth endpoints (Vercel, Cloudflare, Netlify), WordPress theme, plugin and
// REST files, and API calls (`/api/`, `/graphql`, read as data calls the way the
// human journeys read them).
const RESOURCE_SEGMENTS: ReadonlySet<string> = new Set([
  '_next', '_nuxt', '_ipx', '_astro', '_vercel', 'cdn-cgi', '.netlify',
  'wp-content', 'wp-includes', 'wp-json', 'api', 'graphql',
])
// Endpoints a page calls by itself: Astro's image optimizer, Azure's
// signed-in user check and WordPress AJAX.
const RESOURCE_PATHS: ReadonlySet<string> = new Set(['/_image', '/.auth/me', '/wp-admin/admin-ajax.php'])
// Files a page loads that `classifyTrafficPath` reads as content: web app
// manifests, and React Router's route data (Remix, Shopify Hydrogen).
const RESOURCE_EXTENSIONS = /\.(?:webmanifest|data)$/i
// Query parameters only a page's own fetches carry: Next.js React Server
// Component payloads (a client-side navigation and the prefetch of every link
// in view, which logs cannot tell apart) and WooCommerce AJAX.
const RESOURCE_QUERY_PARAMETERS: readonly string[] = ['_rsc', 'wc-ajax']

function isResourcePath(path: string): boolean {
  const lower = path.toLowerCase()
  const trimmed = lower.length > 1 ? lower.replace(/\/+$/, '') || '/' : lower
  if (RESOURCE_PATHS.has(trimmed) || RESOURCE_EXTENSIONS.test(trimmed)) return true
  if (RESOURCE_SEGMENTS.has(trimmed.split('/')[1] ?? '')) return true
  return classifyTrafficPath(trimmed) === TrafficPathClasses.asset
}

function hasResourceQuery(request: Pick<NormalizedTrafficRequest, 'path' | 'queryString'>): boolean {
  // Some sources leave the query on the path.
  const queryStart = request.path.indexOf('?')
  const pathQuery = queryStart < 0 ? '' : request.path.slice(queryStart + 1).split('#')[0]!
  const query = request.queryString ?? pathQuery
  if (!query) return false
  const params = new URLSearchParams(query)
  return RESOURCE_QUERY_PARAMETERS.some(name => params.has(name))
}

/**
 * What a browser agent's request was: a page load it made, an action (a form
 * post) it made, or a resource its page fetched by itself. A request with no
 * method reads as a GET.
 */
export function browserAgentRequestKind(request: Pick<NormalizedTrafficRequest, 'method' | 'path' | 'queryString'>): BrowserAgentRequestKind {
  const method = request.method?.trim().toUpperCase() || 'GET'
  if (method === 'HEAD' || method === 'OPTIONS') return BrowserAgentRequestKinds.resource
  const path = request.path.split(/[?#]/)[0] || '/'
  if (isResourcePath(path) || hasResourceQuery(request)) return BrowserAgentRequestKinds.resource
  return method === 'GET' ? BrowserAgentRequestKinds.page : BrowserAgentRequestKinds.action
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
