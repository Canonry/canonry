import { resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import { createLogger } from './logger.js'

const log = createLogger('SitemapParser')

const LOC_REGEX = /<loc>([^<]+)<\/loc>/gi
const SITEMAP_TAG_REGEX = /<sitemap>[\s\S]*?<\/sitemap>/gi

/**
 * Block SSRF before fetching a sitemap (or a nested sitemap-index entry).
 * Delegates to the shared webhook target validator, which DNS-resolves the
 * hostname and rejects every resolved IP in a private / loopback / link-local /
 * CGNAT / cloud-metadata range — strictly stronger than a literal-hostname
 * regex, which can't catch a public name that resolves to an internal IP, IPv6,
 * or 127.0.0.0/8.
 */
async function validateSitemapUrl(url: string): Promise<void> {
  // `allowLoopback: true` preserves the prior behavior — the old regex guard
  // never blocked 127.0.0.0/8, and these GSC/Bing coverage inspections run in
  // `canonry serve` against the operator's own (config-sourced) sitemap, where
  // a localhost target is legitimate. The upgrade is everything else the regex
  // missed: real DNS resolution (a public name resolving to an internal IP),
  // IPv6, CGNAT, and the 169.254 metadata range stay blocked.
  const check = await resolveWebhookTarget(url, { allowLoopback: true })
  if (!check.ok) {
    throw new Error(`Sitemap URL rejected: ${check.message.replace(/^"url" /, '')} (${url})`)
  }
}

// Read a sitemap response body, transparently decompressing if the payload is
// gzipped. Detects gzip via the magic header bytes (0x1f 0x8b) rather than
// trusting the URL extension or Content-Encoding header — Node's fetch already
// auto-decompresses transport-level gzip, but static `.xml.gz` files served
// without `Content-Encoding: gzip` reach us as raw deflate bytes.
async function readSitemapBody(res: Response): Promise<string> {
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const isGzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!isGzipped) {
    return new TextDecoder().decode(bytes)
  }
  const decompressed = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(decompressed).text()
}

export async function fetchAndParseSitemap(sitemapUrl: string): Promise<string[]> {
  const urls = new Set<string>()
  const visited = new Set<string>()
  await parseSitemapRecursive(sitemapUrl, urls, visited, 0, /* isChild */ false)
  return [...urls]
}

async function parseSitemapRecursive(
  url: string,
  urls: Set<string>,
  visited: Set<string>,
  depth: number,
  isChild: boolean,
): Promise<void> {
  if (depth > 3) return // Prevent infinite recursion
  if (visited.has(url)) return // Skip sitemaps we've already fetched in this run
  visited.add(url)

  let res: Response
  try {
    // SSRF guard runs inside the try so a blocked nested-index child is treated
    // like any other failing child (skipped + warned) while a blocked top-level
    // URL still bubbles up and fails the run.
    await validateSitemapUrl(url)
    res = await fetch(url)
  } catch (err) {
    // Top-level failures bubble up so the caller's run is marked failed; child
    // failures only warn so one bad nested sitemap doesn't doom the whole index.
    if (!isChild) throw err
    log.warn('child-sitemap.fetch-failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (!res.ok) {
    if (!isChild) {
      throw new Error(`Failed to fetch sitemap at ${url}: ${res.status} ${res.statusText}`)
    }
    log.warn('child-sitemap.http-error', { url, status: res.status, statusText: res.statusText })
    return
  }

  let xml: string
  try {
    xml = await readSitemapBody(res)
  } catch (err) {
    if (!isChild) throw err
    log.warn('child-sitemap.parse-failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // Check if this is a sitemap index (contains <sitemap> tags)
  const sitemapEntries = xml.match(SITEMAP_TAG_REGEX)
  if (sitemapEntries) {
    for (const entry of sitemapEntries) {
      const locMatch = LOC_REGEX.exec(entry)
      LOC_REGEX.lastIndex = 0
      const inner = locMatch?.[1]?.trim()
      if (inner) {
        await parseSitemapRecursive(inner, urls, visited, depth + 1, /* isChild */ true)
      }
    }
    return
  }

  // Regular sitemap — extract all <loc> URLs
  let match: RegExpExecArray | null
  while ((match = LOC_REGEX.exec(xml)) !== null) {
    const inner = match[1]?.trim()
    if (inner) {
      urls.add(inner)
    }
  }
  LOC_REGEX.lastIndex = 0
}
