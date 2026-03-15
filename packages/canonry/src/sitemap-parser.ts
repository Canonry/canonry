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

export async function fetchAndParseSitemap(sitemapUrl: string): Promise<string[]> {
  const urls = new Set<string>()
  await parseSitemapRecursive(sitemapUrl, urls, 0)
  return [...urls]
}

async function parseSitemapRecursive(url: string, urls: Set<string>, depth: number): Promise<void> {
  if (depth > 3) return // Prevent infinite recursion

  validateSitemapUrl(url)

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap at ${url}: ${res.status} ${res.statusText}`)
  }

  const xml = await res.text()

  // Check if this is a sitemap index (contains <sitemap> tags)
  const sitemapEntries = xml.match(SITEMAP_TAG_REGEX)
  if (sitemapEntries) {
    for (const entry of sitemapEntries) {
      const locMatch = LOC_REGEX.exec(entry)
      LOC_REGEX.lastIndex = 0
      if (locMatch?.[1]) {
        await parseSitemapRecursive(locMatch[1], urls, depth + 1)
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
