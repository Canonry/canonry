import { and, ne, notLike, type SQL } from 'drizzle-orm'
import { backlinkDomains } from '@ainyc/canonry-db'

// Crawler / SERP / proxy hosts that show up in the Common Crawl hyperlink graph
// but don't represent editorial backlinks. Industry tools (Ahrefs, Semrush,
// Majestic) bucket these as "search engines" and exclude them from backlink
// profiles by default. Without this filter, google.com alone dominates the
// list — it can account for 95%+ of "linking hosts" via translate, cache,
// scholar, googleusercontent, SERP redirects, etc. — and crowds out the real
// editorial referrers.
//
// Each entry is a glob pattern. `*.example.com` matches the apex `example.com`
// and any subdomain. A bare `example.com` is an exact match. Wildcard form is
// the default since crawler/proxy hosts often surface as subdomains
// (translate.google.com, scholar.google.com, webcache.googleusercontent.com).
export const BACKLINK_FILTER_PATTERNS: readonly string[] = [
  '*.google.com',
  '*.googleusercontent.com',
  '*.translate.goog',
  '*.bing.com',
  '*.yandex.com',
  '*.yandex.ru',
  '*.baidu.com',
  '*.duckduckgo.com',
  '*.archive.org',
]

export function isFilteredBacklinkDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  for (const pattern of BACKLINK_FILTER_PATTERNS) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (lower === suffix || lower.endsWith('.' + suffix)) return true
    } else if (lower === pattern.toLowerCase()) {
      return true
    }
  }
  return false
}

// Drizzle SQL clause that excludes any domain matching the filter patterns.
// SQLite's default LIKE is case-insensitive for ASCII, which matches how
// `isFilteredBacklinkDomain` lowercases its input.
export function backlinkCrawlerExclusionClause(): SQL {
  const conditions: SQL[] = []
  for (const pattern of BACKLINK_FILTER_PATTERNS) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      conditions.push(ne(backlinkDomains.linkingDomain, suffix))
      conditions.push(notLike(backlinkDomains.linkingDomain, `%.${suffix}`))
    } else {
      conditions.push(ne(backlinkDomains.linkingDomain, pattern))
    }
  }
  const combined = and(...conditions)
  if (!combined) throw new Error('BACKLINK_FILTER_PATTERNS is unexpectedly empty')
  return combined
}
