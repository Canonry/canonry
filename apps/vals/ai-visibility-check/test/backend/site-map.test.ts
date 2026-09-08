import type { CrawlEdgeObservation, CrawlPageObservation } from 'npm:@canonry/aeo-audit@7.2.0'
import { buildSiteMap, SITE_MAP_MAX_NODES } from '../../src/site-health/site-map.ts'

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function page(url: string, options: { depth?: number; score?: number; indexable?: boolean; finalUrl?: string } = {}) {
  return {
    key: url,
    requestedUrl: url,
    finalUrl: options.finalUrl ?? url,
    state: 'html',
    depth: options.depth ?? 0,
    provenance: 'sitemap',
    statusCode: 200,
    contentType: 'text/html',
    redirectChain: [],
    canonicalUrl: null,
    metaRobots: [],
    xRobots: [],
    path: new URL(url).pathname,
    directory: null,
    indexability: {
      state: options.indexable === false ? 'noindex' : 'indexable',
      reasons: [],
      rulesetVersion: '1',
    },
    audit: options.score === undefined ? null : { overallScore: options.score },
    error: null,
  } as unknown as CrawlPageObservation
}

function edge(
  from: string,
  to: string,
  options: { internal?: boolean; followable?: boolean; type?: 'anchor' | 'redirect' | 'canonical' } = {},
) {
  const type = options.type ?? 'anchor'
  return {
    // The engine's key is endpoint-AND-type-derived, so one (from,to) pair with
    // two link types is two distinct observations.
    key: `${type}->${from}->${to}`,
    from,
    to,
    type,
    classification: options.internal === false ? 'external' : 'internal',
    totalOccurrences: 1,
    followableOccurrences: options.followable === false ? 0 : 1,
    nofollowOccurrences: options.followable === false ? 1 : 0,
    anchorSummaries: [],
  } as unknown as CrawlEdgeObservation
}

const ROOT = 'https://example.com/'
const PRICING = 'https://example.com/pricing'
const BLOG = 'https://example.com/blog'

Deno.test('a crawled page carries its score; a link target explicitly does not', () => {
  const map = buildSiteMap(
    [page(ROOT, { depth: 0, score: 82 })],
    [edge(ROOT, PRICING)],
  )
  assert(map, 'expected a map')

  const root = map.nodes.find((node) => node.url === ROOT)
  const pricing = map.nodes.find((node) => node.url === PRICING)
  assert(root && pricing, 'both endpoints should become nodes')

  equal(root.crawled, true)
  equal(root.score, 82)
  equal(pricing.crawled, false, 'a link target was never fetched')
  equal(pricing.score, null, 'an uncrawled page must never show a score')
  equal(pricing.indexable, null, 'an uncrawled page has no indexability verdict')
})

Deno.test('link counts are directional', () => {
  const map = buildSiteMap(
    [page(ROOT, { depth: 0 }), page(PRICING, { depth: 1 })],
    [edge(ROOT, PRICING), edge(BLOG, PRICING), edge(PRICING, BLOG)],
  )
  assert(map, 'expected a map')

  const pricing = map.nodes.find((node) => node.url === PRICING)!
  const root = map.nodes.find((node) => node.url === ROOT)!
  equal(pricing.inboundLinks, 2, 'two pages link to pricing')
  equal(pricing.outboundLinks, 1, 'pricing links out once')
  equal(root.inboundLinks, 0, 'nothing links to the root here')
  equal(root.outboundLinks, 1)
})

Deno.test('external links and self-links are excluded', () => {
  const map = buildSiteMap(
    [page(ROOT, { depth: 0 })],
    [edge(ROOT, 'https://other.com/x', { internal: false }), edge(ROOT, ROOT), edge(ROOT, PRICING)],
  )
  assert(map, 'expected a map')

  assert(!map.nodes.some((node) => node.url.includes('other.com')), 'an external target is not part of the site map')
  equal(map.edges.length, 1, 'only the one internal, non-self edge survives')
  equal(map.edges[0]?.to, PRICING)
})

Deno.test('a redirected page is keyed by where it landed, so its inbound links attach', () => {
  const finalUrl = 'https://example.com/pricing/'
  const map = buildSiteMap(
    [page(ROOT, { depth: 0 }), page('https://example.com/prices', { depth: 1, finalUrl, score: 60 })],
    [edge(ROOT, finalUrl)],
  )
  assert(map, 'expected a map')

  const landed = map.nodes.find((node) => node.url === finalUrl)
  assert(landed, 'the settled URL should be the node identity')
  equal(landed.crawled, true, 'the redirected page was crawled')
  equal(landed.inboundLinks, 1, 'the inbound link must attach to the settled URL')
})

Deno.test('crawled pages are never dropped, and discovered targets are kept by inbound links', () => {
  const crawled = [page(ROOT, { depth: 0, score: 70 })]
  // More discovered targets than the display cap, with a deterministic
  // inbound ordering: /t0 has the most links, /t39 the fewest.
  const edges: CrawlEdgeObservation[] = []
  for (let index = 0; index < 40; index++) {
    const target = `https://example.com/t${index}`
    for (let link = 0; link <= 40 - index; link++) {
      edges.push(edge(`https://example.com/src${link}`, target))
    }
  }
  edges.push(edge(ROOT, 'https://example.com/t0'))

  const map = buildSiteMap(crawled, edges)
  assert(map, 'expected a map')

  equal(map.nodes.length, SITE_MAP_MAX_NODES, 'node count is capped for legibility')
  assert(map.nodes.some((node) => node.url === ROOT), 'a crawled page must survive the cap')
  assert(map.nodes.some((node) => node.url === 'https://example.com/t0'), 'the most-linked target should be kept')
  assert(
    !map.nodes.some((node) => node.url === 'https://example.com/t39'),
    'the least-linked target should be dropped first',
  )
  equal(map.truncated, true, 'a capped map must say so')
  assert(map.totalPages > map.nodes.length, 'the pre-cap total must exceed what is shown')
})

Deno.test('selection is deterministic across identical crawls', () => {
  const build = () =>
    buildSiteMap(
      [page(ROOT, { depth: 0, score: 70 })],
      [edge(ROOT, PRICING), edge(ROOT, BLOG), edge(BLOG, PRICING)],
    )
  equal(JSON.stringify(build()), JSON.stringify(build()), 'the same crawl must always draw the same map')
})

Deno.test('a nofollow-only link is marked, not hidden', () => {
  const map = buildSiteMap([page(ROOT, { depth: 0 })], [edge(ROOT, PRICING, { followable: false })])
  assert(map, 'expected a map')
  equal(map.edges.length, 1)
  equal(map.edges[0]?.followable, false, 'a nofollow link is still a link')
})

Deno.test('duplicate observations of one link collapse to a single edge', () => {
  const map = buildSiteMap(
    [page(ROOT, { depth: 0 })],
    [edge(ROOT, PRICING, { followable: false }), edge(ROOT, PRICING)],
  )
  assert(map, 'expected a map')
  equal(map.edges.length, 1, 'one edge per page pair')
  equal(map.edges[0]?.followable, true, 'any followable occurrence makes the edge followable')
})

Deno.test('a pair linked by two edge types counts as one link, not two', () => {
  // The engine keys observations by (from, to, type), so a page that both
  // anchor-links a target and canonicals to it emits two internal edges for one
  // link. Counting each would inflate inbound/outbound and falsely truncate.
  const map = buildSiteMap(
    [page(ROOT, { depth: 0 }), page(PRICING, { depth: 1 })],
    [edge(ROOT, PRICING), edge(ROOT, PRICING, { type: 'canonical' })],
  )
  assert(map, 'expected a map')
  equal(map.edges.length, 1, 'one displayed edge per pair')
  equal(map.totalEdges, 1, 'one unique link total')
  equal(map.truncated, false, 'nothing is truncated when the only pair is shown')

  const pricing = map.nodes.find((node) => node.url === PRICING)!
  equal(pricing.inboundLinks, 1, 'one page links here, not two edge types')
  const root = map.nodes.find((node) => node.url === ROOT)!
  equal(root.outboundLinks, 1, 'one outbound link, not two edge types')
})

Deno.test('a crawl with nothing to draw returns null rather than an empty diagram', () => {
  equal(buildSiteMap([], []), null)
})

Deno.test('a noindex page is recorded as not indexable', () => {
  const map = buildSiteMap([page(ROOT, { depth: 0, score: 40, indexable: false })], [edge(ROOT, PRICING)])
  assert(map, 'expected a map')
  equal(map.nodes.find((node) => node.url === ROOT)?.indexable, false)
})
