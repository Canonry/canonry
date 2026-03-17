import dns from 'node:dns/promises'
import net from 'node:net'

const LOC_REGEX = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const SITEMAP_TAG_REGEX = /<sitemap>[\s\S]*?<\/sitemap>/gi

/**
 * Check whether an IP address (v4 or v6) is private, loopback, or link-local.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 checks
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    if (parts[0] === 127) return true                                          // loopback
    if (parts[0] === 10) return true                                           // class A
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true   // class B
    if (parts[0] === 192 && parts[1] === 168) return true                      // class C
    if (parts[0] === 169 && parts[1] === 254) return true                      // link-local
    if (parts[0] === 0) return true                                            // 0.0.0.0/8
    return false
  }

  // IPv6 checks
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase()
    if (normalized === '::1') return true                           // loopback
    if (normalized === '::') return true                            // unspecified
    if (normalized.startsWith('fe80:')) return true                 // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // ULA
    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4mapped) return isPrivateIP(v4mapped[1]!)
    return false
  }

  return false
}

async function validateSitemapUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid sitemap URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Sitemap URL must use http or https protocol: ${url}`)
  }

  // URL.hostname wraps IPv6 in brackets — strip them for IP checks
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Block localhost by name
  if (host === 'localhost' || host === 'localhost.localdomain') {
    throw new Error(`Sitemap URL must not point to localhost: ${url}`)
  }

  // If the hostname is already an IP literal, check it directly
  if (net.isIP(host)) {
    if (isPrivateIP(host)) {
      throw new Error(`Sitemap URL points to a private or reserved IP range: ${url}`)
    }
    return
  }

  // Resolve the hostname and verify all addresses are public
  let addresses: string[]
  try {
    const results = await dns.resolve(host)
    const results6 = await dns.resolve6(host).catch((err: NodeJS.ErrnoException) => {
      // No AAAA records is expected for IPv4-only hosts — treat as empty.
      // Re-throw unexpected errors so they don't silently mask real failures.
      if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return [] as string[]
      throw err
    })
    addresses = [...results, ...results6]
  } catch {
    throw new Error(`Cannot resolve sitemap hostname: ${host}`)
  }

  if (addresses.length === 0) {
    throw new Error(`Cannot resolve sitemap hostname: ${host}`)
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new Error(`Sitemap URL resolves to a private or reserved IP address: ${url}`)
    }
  }
}

interface FetchSitemapOptions {
  /** Skip SSRF validation — only for tests against localhost. */
  dangerouslyAllowPrivate?: boolean
}

export async function fetchAndParseSitemap(sitemapUrl: string, options?: FetchSitemapOptions): Promise<string[]> {
  const urls = new Set<string>()
  await parseSitemapRecursive(sitemapUrl, urls, 0, options)
  return [...urls]
}

async function parseSitemapRecursive(url: string, urls: Set<string>, depth: number, options?: FetchSitemapOptions): Promise<void> {
  if (depth > 3) return // Prevent infinite recursion

  if (!options?.dangerouslyAllowPrivate) {
    await validateSitemapUrl(url)
  }

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
        await parseSitemapRecursive(locMatch[1], urls, depth + 1, options)
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
