/**
 * Read-time classification of a normalized request path into a coarse
 * "what was actually fetched" class. Server-side traffic rollups count every
 * classified-crawler request equally, so on real sites infrastructure fetches
 * (a bot polling `sitemap_index.xml` tens of thousands of times, `robots.txt`,
 * static assets) dominate the headline "crawler hits" number and overstate how
 * much of a site's *content* is actually being crawled.
 *
 * This helper lets the read layer segment those counts (content vs
 * sitemap/robots/asset infrastructure) without a schema migration —
 * `pathNormalized` is already persisted on every rollup row.
 *
 * Pure, no I/O. The path is the already-normalized pattern produced by
 * `normalizeTrafficPathPattern` (query string stripped, id-like segments
 * collapsed to `:id`), but the function is defensive about a stray query/hash
 * and about empty input so it is safe to call on raw paths too.
 */

export const TrafficPathClasses = {
  content: 'content',
  sitemap: 'sitemap',
  robots: 'robots',
  asset: 'asset',
  other: 'other',
} as const

export type TrafficPathClass = (typeof TrafficPathClasses)[keyof typeof TrafficPathClasses]

/** Per-class crawler-hit breakdown. Keys mirror {@link TrafficPathClass}. */
export interface TrafficCrawlerSegments {
  content: number
  sitemap: number
  robots: number
  asset: number
  other: number
}

// Robots / AI-control files (always served from the site root, but matched by
// basename to stay robust). These are pure infrastructure polling, never a
// content read.
const ROBOTS_BASENAMES = new Set(['robots.txt', 'llms.txt', 'llms-full.txt'])

// Non-page infrastructure endpoints whose basename carries a document-like
// extension, so the extension check below would otherwise call them `content`.
// WordPress XML-RPC and cron are the common case.
const INFRA_BASENAMES = new Set(['xmlrpc.php', 'wp-cron.php'])

// Static-asset extensions. A crawler fetching these is pulling sub-resources,
// not reading a page. Mirrors the set the issue calls out plus the common
// remainder (fonts, modern image formats, media, source maps).
const ASSET_EXTENSIONS = new Set([
  'css',
  'js',
  'mjs',
  'cjs',
  'map',
  'json',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'gif',
  'svg',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'wasm',
])

// Document extensions that DO represent a real page read, so a path that
// carries one is content rather than "other".
const DOCUMENT_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'shtml',
  'php',
  'php5',
  'php7',
  'asp',
  'aspx',
  'jsp',
  'jspx',
  'cfm',
  'md',
])

// Non-page file downloads / feeds: not a content page, not a sub-resource
// asset, not site infrastructure → the residual "other" bucket. Membership is
// explicit (rather than "any extension we don't recognize") because an
// UNRECOGNIZED dotted suffix is far more likely to be a content slug
// (`/release-notes-3.14`, `/u/jane.doe`, `/products/3.5mm-adapter`) than a file
// type — those must stay `content`, never silently fall into `other`.
const DOWNLOAD_EXTENSIONS = new Set([
  'pdf',
  'csv',
  'tsv',
  'txt',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'zip',
  'gz',
  'tgz',
  'tar',
  'rar',
  '7z',
  'bz2',
  'xz',
  'rss',
  'atom',
  'ics',
  'vcf',
  'epub',
  'mobi',
  'apk',
  'dmg',
  'exe',
  'bin',
  'iso',
  'sql',
])

// Extensionless sitemap endpoints. Tight on purpose: a bare `startsWith('sitemap')`
// also swallows content slugs like `/sitemap-best-practices`. Real `*.xml` /
// `*.xml.gz` sitemaps are caught by the extension check, so this only needs the
// handful of extensionless conventions.
const SITEMAP_BASENAME = /^sitemap(?:[-_]index)?$/

export function classifyTrafficPath(pathNormalized: string | null | undefined): TrafficPathClass {
  const raw = (pathNormalized ?? '').trim()
  if (!raw) return TrafficPathClasses.other

  // Defensive: the normalized pattern already has no query string, but a raw
  // path might. Classification is on the path only.
  const rawPath = raw.split(/[?#]/)[0] ?? ''
  // Drop a trailing slash so `/sitemap.xml/` and `/app.css/` classify the same
  // as their slash-less forms; keep the bare root `/` as-is (a content page).
  const pathOnly = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') || '/' : rawPath
  if (!pathOnly) return TrafficPathClasses.other

  const lower = pathOnly.toLowerCase()
  const segments = lower.split('/')
  const basename = segments[segments.length - 1] ?? ''

  if (ROBOTS_BASENAMES.has(basename)) return TrafficPathClasses.robots

  // Any `*.xml` / `*.xml.gz`, or one of the extensionless sitemap conventions.
  if (lower.endsWith('.xml') || lower.endsWith('.xml.gz')) return TrafficPathClasses.sitemap
  if (SITEMAP_BASENAME.test(basename)) return TrafficPathClasses.sitemap

  // Non-page infrastructure endpoints that an extension or extensionless path
  // would otherwise misclassify as `content`. WordPress is the common case:
  // XML-RPC / cron (`xmlrpc.php`, `wp-cron.php`), the WP REST API
  // (`/wp-json/...`), and RSS / comment feeds, which WordPress exposes at `/feed`
  // and `/<path>/feed[/...]` with no file extension. These are polling and
  // syndication, not a content crawl, so they go to the residual bucket.
  if (INFRA_BASENAMES.has(basename)) return TrafficPathClasses.other
  if (lower === '/wp-json' || lower.startsWith('/wp-json/')) return TrafficPathClasses.other
  if (lower.endsWith('/feed') || lower.includes('/feed/')) return TrafficPathClasses.other

  // Extract the extension from the basename (ignore leading-dot dotfiles, where
  // the dot is at index 0 — those have no extension).
  const dot = basename.lastIndexOf('.')
  const ext = dot > 0 ? basename.slice(dot + 1) : ''

  if (ext) {
    if (ASSET_EXTENSIONS.has(ext)) return TrafficPathClasses.asset
    if (DOCUMENT_EXTENSIONS.has(ext)) return TrafficPathClasses.content
    if (DOWNLOAD_EXTENSIONS.has(ext)) return TrafficPathClasses.other
    // An UNRECOGNIZED suffix is almost always a dotted content slug — a version
    // (`/release-notes-3.14`), username (`/u/jane.doe`), or SKU
    // (`/products/3.5mm-adapter`) — not a file type. Bias to `content` so a real
    // page crawl is never dropped from the headline (the issue's priority).
    return TrafficPathClasses.content
  }

  // No extension → a normal page/document path (`/`, `/about`, `/blog/post/`).
  return TrafficPathClasses.content
}

export function emptyCrawlerSegments(): TrafficCrawlerSegments {
  return { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 }
}

/**
 * Aggregate `(pathNormalized, hits)` rows into a per-class breakdown. The
 * returned buckets always sum to the total hits passed in, so a caller can
 * derive the existing `crawlerHits` total from the segments without a second
 * pass.
 */
export function segmentCrawlerHits(
  rows: Array<{ pathNormalized: string; hits: number }>,
): TrafficCrawlerSegments {
  const segments = emptyCrawlerSegments()
  for (const row of rows) {
    segments[classifyTrafficPath(row.pathNormalized)] += row.hits
  }
  return segments
}

/**
 * Infrastructure subtotal — sitemap + robots + asset fetches. This is the
 * polling/sub-resource traffic that should be shown as a secondary figure, not
 * summed into the headline "content was crawled" number. The residual `other`
 * bucket is intentionally NOT folded in here, so `content + infra + other`
 * reconstructs the full total.
 */
export function sumInfraHits(segments: TrafficCrawlerSegments): number {
  return segments.sitemap + segments.robots + segments.asset
}
