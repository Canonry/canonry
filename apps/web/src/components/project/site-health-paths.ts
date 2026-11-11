/**
 * How Agent Readiness writes a crawled page in a list cell.
 *
 * Every URL in one scan usually shares the crawl root's host, so repeating
 * `https://example.com/` in front of each row costs a column of width and
 * tells the reader nothing. Stripping it is a DISPLAY change only: call sites
 * keep the full URL in `title` and in whatever they link or copy, and a
 * genuinely cross-host URL keeps its full form so an off-site link is never
 * disguised as an internal path.
 */

const WWW_PREFIX = /^www\./i

/** Hostname of a crawl root URL, or null when it cannot be parsed. */
export function siteHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * `www.` is a presentation prefix, not a different site, so it never decides
 * whether a URL counts as same-host.
 */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(WWW_PREFIX, '')
}

export function isSameSiteUrl(url: string, rootHost: string | null | undefined): boolean {
  if (!rootHost) return false
  try {
    return bareHost(new URL(url).hostname) === bareHost(rootHost)
  } catch {
    return false
  }
}

/**
 * Display text for one crawled page URL.
 *
 * Same-host URLs render as their path (query strings kept, because
 * `/search?q=roof` and `/search` are different pages). Anything else,
 * including an unparseable value, is returned unchanged rather than silently
 * dropped.
 */
export function displayPagePath(
  url: string | null | undefined,
  rootHost: string | null | undefined,
): string {
  if (!url) return ''
  if (!isSameSiteUrl(url, rootHost)) return url

  const parsed = new URL(url)
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return path === '' ? '/' : path
}

/**
 * What one crawled page is called: its path, everywhere. The root is marked on
 * the map by its ring and its forced label, not by renaming it, so an apex and
 * a www alias both read as the "/" they actually are.
 */
export function displayPageLabel(
  page: { url?: string | null; path?: string | null },
  rootHost: string | null | undefined,
): string {
  return displayPagePath(page.url, rootHost) || page.path || '/'
}
