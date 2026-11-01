/**
 * Bots and agents that no rule in `rules.ts` names yet. The Cloudflare Worker
 * forwards them from these lists, so the edge and the server agree on what
 * counts as one, and a new agent needs no Worker redeploy to reach Canonry.
 */

/**
 * Static files an agent reading a site never needs. Text files (robots.txt,
 * llms.txt), sitemaps, feeds and PDFs are deliberately not listed.
 */
export const UNLISTED_AGENT_SKIPPED_EXTENSIONS: readonly string[] = [
  'avif', 'bmp', 'css', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'map', 'mjs', 'mp3', 'mp4',
  'otf', 'png', 'svg', 'ttf', 'webm', 'webmanifest', 'webp', 'woff', 'woff2', 'zip',
]

/**
 * Generic HTTP tools, by the product name that starts their user agent. They
 * name a library, not who sent the request, so nothing can attribute them, and
 * they are mostly scripts, monitors, scanners and apps (`dalvik` is Android's
 * built-in client).
 */
export const GENERIC_HTTP_CLIENTS: readonly string[] = [
  'curl', 'wget', 'python', 'python-requests', 'python-urllib', 'python-httpx', 'aiohttp',
  'httpx', 'go-http-client', 'okhttp', 'java', 'apache-httpclient', 'axios', 'node',
  'node-fetch', 'undici', 'got', 'libwww-perl', 'guzzlehttp', 'ruby', 'faraday', 'http.rb', 'php', 'wordpress',
  'dalvik', 'postmanruntime', 'insomnia',
]

/**
 * Words that mark a browser-shaped (`Mozilla/...`) user agent as a bot or
 * agent rather than a person's browser. `bot`, `crawler` and `spider` are
 * Worker keywords already, so they are not repeated here.
 */
export const BROWSER_SHAPED_AGENT_MARKERS: readonly string[] = ['compatible;', 'fetch', 'agent', 'headless', '+http']

// Ends the product name a user agent starts with: "name/1.0", "name (...)", "name;".
const PRODUCT_NAME_END = /[/\s;(]/
const SKIPPED_PATH = new RegExp(`\\.(?:${UNLISTED_AGENT_SKIPPED_EXTENSIONS.join('|')})$`, 'i')
// How a browser-shaped agent names itself: the token after "compatible;", or a
// versioned token naming a bot, crawler, spider, fetcher, agent, user fetcher
// or headless browser ("ExampleBot/2.0"). The version matters: a phone model
// such as "CUBOT X30" ends in "bot" but is a person's browser.
const COMPATIBLE_NAME = /compatible;\s*([a-z0-9][a-z0-9._-]*)/
const BOT_LIKE_NAME = /([a-z0-9][a-z0-9._-]*(?:bot|crawler|spider|fetcher|agent|-user))\//
const HEADLESS_NAME = /\b(headless[a-z]*)\//
// Old Internet Explorer user agents also say "compatible;"; they are browsers.
const BROWSER_COMPATIBLE_NAMES: readonly string[] = ['msie']
const MAX_AGENT_NAME_LENGTH = 64
// A user agent sent with its header name: "User-Agent: Mozilla/5.0 ...".
const HEADER_NAME_PREFIX = /^user-agent\s*:\s*/
// A name is one token, so a URL or a "name:value" pair names nobody.
const AGENT_NAME = /^[a-z0-9][a-z0-9._-]*$/
/**
 * Fixed user agents whose own tokens name someone else. Apple's link previews
 * (Messages and other Apple apps) send a 2015 Mac Safari plus Facebook's and
 * Twitter's preview tokens, so sites serve them their share cards.
 */
const KNOWN_AGENT_NAMES: ReadonlyArray<{ marker: string, name: string }> = [
  { marker: 'facebookexternalhit/1.1 facebot twitterbot/1.0', name: 'imessage-link-preview' },
]

function boundedAgentName(name: string): string | null {
  const bounded = name.replace(/^[._-]+/, '').slice(0, MAX_AGENT_NAME_LENGTH).replace(/[._-]+$/, '')
  return AGENT_NAME.test(bounded) ? bounded : null
}

/**
 * Bump when `unrecognizedAgentName` names requests differently, so the engine
 * renames or drops stored unrecognized rows to match (see the canonry
 * package's traffic reclassification).
 */
export const UNRECOGNIZED_AGENT_NAMING_VERSION = 2

/**
 * The lowercased name of a bot or agent, for a request no rule recognizes.
 * Null for a person's browser, a generic HTTP tool, a static file, a write, or
 * a user agent that names nobody. Reads requests the way the Cloudflare
 * Worker's `isUnlistedAgent` does, and also names the bots, crawlers and
 * spiders the Worker forwards by keyword.
 */
export function unrecognizedAgentName(request: { method?: string | null, path?: string | null, userAgent?: string | null }): string | null {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null
  if (request.path && SKIPPED_PATH.test(request.path.split('?')[0] ?? '')) return null
  const ua = (request.userAgent ?? '').trim().toLowerCase().replace(HEADER_NAME_PREFIX, '')
  if (!ua) return null
  const known = KNOWN_AGENT_NAMES.find(entry => ua.includes(entry.marker))
  if (known) return known.name
  const product = ua.split(PRODUCT_NAME_END)[0] ?? ''
  if (!product || GENERIC_HTTP_CLIENTS.includes(product)) return null
  if (product !== 'mozilla') {
    // With no version anywhere, a user agent names itself with its whole
    // phrase ("Chrome Privacy Preserving Prefetch Proxy"), not its first word.
    return boundedAgentName(ua.includes('/') ? product : ua.replace(/[^a-z0-9._-]+/g, '-'))
  }
  const name = COMPATIBLE_NAME.exec(ua)?.[1] ?? BOT_LIKE_NAME.exec(ua)?.[1] ?? HEADLESS_NAME.exec(ua)?.[1]
  if (!name || BROWSER_COMPATIBLE_NAMES.includes(name)) return null
  return boundedAgentName(name)
}
