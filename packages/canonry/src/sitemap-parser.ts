import { createLogger } from './logger.js'

const log = createLogger('SitemapParser')

const LOC_REGEX = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const SITEMAP_TAG_REGEX = /<sitemap>[\s\S]*?<\/sitemap>/gi

// Block private/link-local IP ranges to prevent SSRF
const PRIVATE_IP_PATTERNS = [
  /^169\.254\./,                    // link-local (AWS metadata endpoint etc.)
  /^10\./,                          // private class A
  /^172\.(1[6-9]|2\d|3[01])\./,    // private class B
  /^192\.168\./,                    // private class C
]

function validateSitemapUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid sitemap URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Sitemap URL must use http or https protocol: ${url}`)
  }
  const host = parsed.hostname.toLowerCase()
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(`Sitemap URL points to a private or reserved IP range: ${url}`)
    }
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

  validateSitemapUrl(url)

  let res: Response
  try {
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
      if (locMatch?.[1]) {
        await parseSitemapRecursive(locMatch[1], urls, visited, depth + 1, /* isChild */ true)
      }
    }
    return
  }

  // Regular sitemap — extract all <loc> URLs
  let match: RegExpExecArray | null
  while ((match = LOC_REGEX.exec(xml)) !== null) {
    if (match[1]) {
      urls.add(match[1])
    }
  }
  LOC_REGEX.lastIndex = 0
}
