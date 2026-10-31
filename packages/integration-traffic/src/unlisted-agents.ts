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
 * they are mostly scripts, monitors and scanners.
 */
export const GENERIC_HTTP_CLIENTS: readonly string[] = [
  'curl', 'wget', 'python', 'python-requests', 'python-urllib', 'python-httpx', 'aiohttp',
  'httpx', 'go-http-client', 'okhttp', 'java', 'apache-httpclient', 'axios', 'node',
  'node-fetch', 'undici', 'got', 'libwww-perl', 'guzzlehttp', 'ruby', 'php', 'wordpress',
  'postmanruntime', 'insomnia',
]

/**
 * Words that mark a browser-shaped (`Mozilla/...`) user agent as a bot or
 * agent rather than a person's browser. `bot`, `crawler` and `spider` are
 * Worker keywords already, so they are not repeated here.
 */
export const BROWSER_SHAPED_AGENT_MARKERS: readonly string[] = ['compatible;', 'fetch', 'agent', 'headless', '+http']
