/**
 * Pure inventory builder for the user's blog content.
 *
 * Aggregates URLs across all observed sources (GSC ranking data, GA4
 * landing-page traffic, sitemap inspection, WordPress posts), deduplicates,
 * and filters down to blog-shaped paths only. Used by the action classifier
 * to answer "do we already have a page for this query?" when GSC does not
 * yet have an exact-query entry.
 *
 * No I/O — callers fetch the raw URL lists and pass them in.
 */

export type SitePageSource = 'gsc' | 'ga4' | 'sitemap' | 'wp'

export interface SitePage {
  url: string
  sources: SitePageSource[]
}

export interface InventoryInput {
  gscPages: string[]
  ga4LandingPages: string[]
  sitemapUrls: string[]
  wpPosts: string[]
}

const BLOG_SHAPED_PATH_PREFIXES = [
  '/blog/',
  '/posts/',
  '/articles/',
  '/guides/',
  '/learn/',
  '/resources/',
  '/glossary/',
]

export function buildInventory(input: InventoryInput): SitePage[] {
  const map = new Map<string, Set<SitePageSource>>()

  const addPage = (rawUrl: string, source: SitePageSource): void => {
    const path = extractPath(rawUrl)
    if (!path) return
    if (!isBlogShaped(path)) return
    let sources = map.get(path)
    if (!sources) {
      sources = new Set()
      map.set(path, sources)
    }
    sources.add(source)
  }

  for (const url of input.gscPages) addPage(url, 'gsc')
  for (const url of input.ga4LandingPages) addPage(url, 'ga4')
  for (const url of input.sitemapUrls) addPage(url, 'sitemap')
  for (const url of input.wpPosts) addPage(url, 'wp')

  return Array.from(map.entries()).map(([url, sources]) => ({
    url,
    sources: Array.from(sources),
  }))
}

function extractPath(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  const match = /^https?:\/\/[^/]+(.*)$/.exec(trimmed)
  const path = match ? match[1] : trimmed
  const stripped = path.replace(/\/+$/, '')
  return stripped || '/'
}

function isBlogShaped(path: string): boolean {
  return BLOG_SHAPED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}
