/**
 * Build a bounded internal-link graph from a crawl the audit already ran.
 *
 * The crawler observes up to 2,500 edges while auditing five pages, and until
 * now every one of them was discarded. They are the most interesting thing in
 * the report for a reader: an audit score says a page is weak, the link graph
 * says whether anything points at it.
 *
 * Two node kinds, kept visibly distinct. A CRAWLED node was fetched and
 * audited, so it carries a score and an indexability verdict. A DISCOVERED node
 * is a link target the crawler saw but never opened; it has a URL and nothing
 * else. Rendering them alike would imply a measurement that never happened.
 *
 * Selection is deterministic — no clock, no randomness — so the same crawl
 * always produces the same picture, and a cached result never disagrees with
 * the run that produced it.
 */
import type { CrawlEdgeObservation, CrawlPageObservation } from 'npm:@canonry/aeo-audit@7.2.0'
import type { SiteMapEdge, SiteMapNode, SiteMapSample } from './types.ts'

/**
 * Display caps, not crawl caps. Past roughly this many nodes a static graph
 * stops being readable and becomes decoration.
 */
export const SITE_MAP_MAX_NODES = 24
export const SITE_MAP_MAX_EDGES = 60

/** Path for display, or the host for the site root. Query and hash are dropped. */
function nodeLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    return path === '' ? parsed.hostname.replace(/^www\./i, '') : path
  } catch {
    return url
  }
}

function indexableOf(page: CrawlPageObservation): boolean | null {
  const state = page.indexability?.state
  if (state === 'indexable') return true
  if (state === 'noindex' || state === 'blocked') return false
  return null
}

/**
 * A crawled page is keyed by the URL it settled on, because that is the URL its
 * inbound links resolve to. Keying by the requested URL would leave a redirected
 * page looking unlinked.
 */
function pageKey(page: CrawlPageObservation): string {
  return page.finalUrl ?? page.requestedUrl
}

export function buildSiteMap(
  pages: readonly CrawlPageObservation[],
  edges: readonly CrawlEdgeObservation[],
): SiteMapSample | null {
  const internal = edges.filter((edge) => edge.classification === 'internal' && edge.from !== edge.to)
  if (pages.length === 0 && internal.length === 0) return null

  // Count one link per (from, to) pair. The engine keys edge observations by
  // (from, to, type), so a page that both anchor-links a target and points at it
  // via rel=canonical (or a redirect) emits several observations for one link;
  // tallying each would inflate the inbound/outbound counts the sampled-pages
  // table shows. `uniquePairs` is the deduped edge total, reused below.
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  const uniquePairs = new Set<string>()
  for (const edge of internal) {
    // A space cannot occur in a URL, so it is a safe (from, to) separator.
    const pair = `${edge.from} ${edge.to}`
    if (uniquePairs.has(pair)) continue
    uniquePairs.add(pair)
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1)
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1)
  }

  const crawled = new Map<string, CrawlPageObservation>()
  for (const page of pages) crawled.set(pageKey(page), page)

  const candidates = new Set<string>([...crawled.keys()])
  for (const edge of internal) {
    candidates.add(edge.from)
    candidates.add(edge.to)
  }

  const toNode = (url: string): SiteMapNode => {
    const page = crawled.get(url)
    return {
      key: url,
      url,
      label: nodeLabel(url),
      depth: page?.depth ?? null,
      crawled: page !== undefined,
      score: page?.audit?.overallScore ?? null,
      indexable: page ? indexableOf(page) : null,
      inboundLinks: inbound.get(url) ?? 0,
      outboundLinks: outbound.get(url) ?? 0,
    }
  }

  // Crawled pages are never dropped — they are what was actually measured.
  // Remaining slots go to the most-linked discovered targets, since a page
  // twelve others point at says more about the site than an orphan does.
  const all = [...candidates].map(toNode)
  const keptCrawled = all.filter((node) => node.crawled).sort(byDepthThenUrl)
  const discovered = all.filter((node) => !node.crawled).sort(byInboundThenUrl)
  const nodes = [...keptCrawled, ...discovered].slice(0, SITE_MAP_MAX_NODES)
  const nodeKeys = new Set(nodes.map((node) => node.key))

  const mapped: SiteMapEdge[] = internal
    .filter((edge) => nodeKeys.has(edge.from) && nodeKeys.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, followable: edge.followableOccurrences > 0 }))
  const dedupedEdges = dedupe(mapped).sort(byEndpoints).slice(0, SITE_MAP_MAX_EDGES)

  return {
    nodes,
    edges: dedupedEdges,
    totalPages: candidates.size,
    totalEdges: uniquePairs.size,
    // Compare deduped-to-deduped. `internal.length` counts per-type observations,
    // so using it here reported "showing N of N, truncated" whenever a pair had
    // more than one edge type even though every unique edge was displayed.
    truncated: candidates.size > nodes.length || uniquePairs.size > dedupedEdges.length,
  }
}

function byDepthThenUrl(a: SiteMapNode, b: SiteMapNode): number {
  return (a.depth ?? 99) - (b.depth ?? 99) || a.url.localeCompare(b.url)
}

function byInboundThenUrl(a: SiteMapNode, b: SiteMapNode): number {
  return b.inboundLinks - a.inboundLinks || a.url.localeCompare(b.url)
}

function byEndpoints(a: SiteMapEdge, b: SiteMapEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
}

/** One edge per (from, to); the crawler already aggregates occurrences. */
function dedupe(edges: readonly SiteMapEdge[]): SiteMapEdge[] {
  const seen = new Map<string, SiteMapEdge>()
  for (const edge of edges) {
    // Written as an escape, not a literal: a raw NUL byte makes the file
    // binary and Val Town refuses to push it. NUL is still the right
    // separator here, because it cannot occur in a URL.
    const key = `${edge.from}\u0000${edge.to}`
    const existing = seen.get(key)
    if (existing) existing.followable ||= edge.followable
    else seen.set(key, { ...edge })
  }
  return [...seen.values()]
}
