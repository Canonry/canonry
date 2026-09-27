import {
  deriveSiteHealthState, factorStatusFromScore, placementLinkDecision, SiteCrawlFetchStates,
  SiteCrawlIndexabilityReasons, SiteCrawlIndexabilityStates, type SiteCrawlAuditFactorDto,
} from '@ainyc/canonry-contracts'
import {
  siteCrawlAttempts, siteCrawlEdges, siteCrawlFindings, siteCrawlPages, siteCrawlSnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  layoutSiteCrawlGraphInput, persistSiteCrawlGraphLayout,
  type PreparedSiteCrawlGraphLayout, type SiteCrawlGraphLayoutInput,
} from '../site-crawl-graph-layout.js'
import type { DemoSeedProject } from './types.js'

/**
 * Factor ids, names, and weights exactly as @canonry/aeo-audit reports them.
 * `bias` shifts a factor across the whole example site so the scorecard has a
 * realistic spread; the page score stays the weighted mean.
 */
export const DEMO_AUDIT_FACTORS = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, bias: 4, found: 'JSON-LD markup describes this page.', missing: 'JSON-LD markup is missing or incomplete.', recommendation: 'Add JSON-LD that describes the business and this page.' },
  { id: 'content-depth', name: 'Content Depth', weight: 10, bias: 0, found: 'The page covers its topic in depth.', missing: 'The page has little original text.', recommendation: 'Expand the page with specific details and examples.' },
  { id: 'faq-content', name: 'FAQ Content', weight: 8, bias: -10, found: 'The page has an FAQ section with direct answers.', missing: 'No FAQ content was found.', recommendation: 'Add an FAQ section that answers what visitors ask about this topic.' },
  { id: 'schema-completeness', name: 'Schema Completeness', weight: 8, bias: -4, found: 'Schema properties cover the key details.', missing: 'Key schema properties are missing.', recommendation: 'Fill in the missing schema properties.' },
  { id: 'eeat-signals', name: 'E-E-A-T Signals', weight: 8, bias: 2, found: 'Author, credentials, and business details are visible.', missing: 'No author or credentials are shown.', recommendation: 'Name the author and show relevant credentials.' },
  { id: 'citations', name: 'Citations & Authority Signals', weight: 8, bias: -8, found: 'The page cites supporting sources.', missing: 'The page makes claims without supporting sources.', recommendation: 'Link to the sources that support the claims on this page.' },
  { id: 'lighthouse', name: 'Lighthouse (Performance/A11y/Best Practices)', weight: 8, bias: 3, found: 'Performance and accessibility checks pass.', missing: 'Performance or accessibility checks need work.', recommendation: 'Compress large images and fix the flagged accessibility issues.' },
  { id: 'geographic-signals', name: 'Geographic Signals', weight: 7, bias: 2, found: 'The places this business serves are named on the page.', missing: 'The page does not say where the business operates.', recommendation: 'Name the towns and regions this page serves.' },
  { id: 'content-freshness', name: 'Content Freshness', weight: 7, bias: -3, found: 'The page shows a recent update date.', missing: 'No recent update date was found.', recommendation: 'Review the page and show when it was last updated.' },
  { id: 'entity-consistency', name: 'Entity Consistency', weight: 7, bias: 6, found: 'Business name and contact details match across the site.', missing: 'Business name or contact details differ from other pages.', recommendation: 'Use the same business name, phone, and address everywhere.' },
  { id: 'agent-skill-exposure', name: 'Agent Skill Exposure', weight: 6, bias: -12, found: 'Key actions are described in a machine-readable form.', missing: 'No machine-readable actions were found.', recommendation: 'Describe key actions, such as booking or requesting a quote, in a machine-readable form.' },
  { id: 'content-extractability', name: 'Content Extractability', weight: 6, bias: 5, found: 'Main content is plain HTML that is easy to extract.', missing: 'Main content is hard to extract from the page markup.', recommendation: 'Keep the main content in plain HTML rather than scripts or images.' },
  { id: 'definition-blocks', name: 'Definition Blocks', weight: 6, bias: -6, found: 'Key terms are defined in short, direct passages.', missing: 'Key terms are not defined directly.', recommendation: 'Add a short, direct definition of the main topic.' },
  { id: 'named-entities', name: 'Named Entities', weight: 6, bias: 1, found: 'Products, places, and organizations are named specifically.', missing: 'Few specific products, places, or organizations are named.', recommendation: 'Name the specific products, places, and organizations involved.' },
  { id: 'snippet-eligibility', name: 'Snippet Eligibility', weight: 6, bias: -2, found: 'A concise answer passage is available.', missing: 'No concise answer passage was found.', recommendation: 'Open with a two or three sentence answer to the main query.' },
  { id: 'ai-access-files', name: 'AI Access Files (llms.txt, sitemap)', weight: 5, bias: 8, found: 'llms.txt and the sitemap are available.', missing: 'AI access files are missing or incomplete.', recommendation: 'Publish llms.txt and keep the sitemap current.' },
  { id: 'schema-validity', name: 'Schema Validity', weight: 5, bias: 7, found: 'Structured data parses without errors.', missing: 'Structured data has validation errors.', recommendation: 'Fix the invalid structured data fields.' },
  { id: 'technical-seo', name: 'Technical SEO', weight: 5, bias: 6, found: 'Title, description, and headings are in place.', missing: 'The title or meta description needs attention.', recommendation: 'Write a unique title and meta description.' },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, bias: 9, found: 'AI crawlers are allowed to fetch this page.', missing: 'Some AI crawlers are blocked from this page.', recommendation: 'Review the robots.txt rules for AI crawlers.' },
] as const

export type DemoAuditFactorId = (typeof DEMO_AUDIT_FACTORS)[number]['id']

interface DemoSitePageBase {
  path: string
  /** Listed in the XML sitemap. Defaults to true for indexable HTML pages only. */
  sitemap?: boolean
}

interface DemoSiteAuditedPage extends DemoSitePageBase {
  /** Target page score. Factors vary around it; the stored score is their weighted mean. */
  score: number
  /** Exact scores for factors this example is meant to show, such as thin content. */
  factorScores?: Partial<Record<DemoAuditFactorId, number>>
}

/** One URL of an example site, described the way a crawl would observe it. */
export type DemoSitePage =
  | (DemoSiteAuditedPage & { kind: 'html' })
  | (DemoSiteAuditedPage & { kind: 'noindex' })
  | (DemoSiteAuditedPage & { kind: 'canonicalized'; canonicalTo: string })
  | (DemoSitePageBase & { kind: 'redirect'; redirectTo: string })
  | (DemoSitePageBase & { kind: 'resource'; contentType: string })
  | (DemoSitePageBase & { kind: 'broken' })

export type DemoSitePageKind = DemoSitePage['kind']
export type DemoSiteLinkPlacement = 'navigation' | 'content'
export type DemoSiteLink = readonly [source: string, target: string, placement?: DemoSiteLinkPlacement]

export interface DemoSiteInventory {
  pages: readonly DemoSitePage[]
  /** Menu and footer targets repeated on every HTML page. A target listed twice is two occurrences. */
  templateLinks: readonly string[]
  /** Links on specific pages. Placement defaults to content. */
  links: readonly DemoSiteLink[]
}

export interface DemoSiteCrawlInput {
  project: DemoSeedProject
  prefix: string
  root: string
  crawlRunId: string
  attemptId: string
  nowIso: string
  inventory: DemoSiteInventory
}

const ROOT_PATH = '/'
const BROKEN_STATUS = 404
const HTML_KINDS: ReadonlySet<DemoSitePageKind> = new Set(['html', 'noindex', 'canonicalized'])

type PageRow = typeof siteCrawlPages.$inferInsert
type EdgeRow = typeof siteCrawlEdges.$inferInsert & { sourceNodeKey: string; targetNodeKey: string; edgeKey: string; isTemplate: boolean; occurrences: number }
type FindingRow = typeof siteCrawlFindings.$inferInsert
type AttemptRow = typeof siteCrawlAttempts.$inferInsert
type SnapshotRow = typeof siteCrawlSnapshots.$inferInsert

export interface DemoSiteCrawl {
  pages: PageRow[]
  edges: EdgeRow[]
  findings: FindingRow[]
  attempt: AttemptRow
  snapshot: SnapshotRow
  layoutInput: SiteCrawlGraphLayoutInput
}

interface LinkDraft { source: string; target: string; navigation: number; content: number; anchors: Set<string> }

/** Stable [0, 1) value so example scores never change between starts. */
function unitHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

function anchorText(path: string): string {
  if (path === ROOT_PATH) return 'Home'
  const segment = path.split('/').filter(Boolean).at(-1) ?? path
  if (segment.endsWith('.pdf')) return `${anchorText(`/${segment.slice(0, -4)}/`)} (PDF)`
  if (segment.includes('.')) return segment
  const words = segment.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function parentPath(path: string): string {
  if (path === ROOT_PATH) return ROOT_PATH
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash <= 0 ? ROOT_PATH : `${trimmed.slice(0, slash)}/`
}

function auditFactors(page: Extract<DemoSitePage, { score: number }>): { score: number; factors: SiteCrawlAuditFactorDto[] } {
  const totalWeight = DEMO_AUDIT_FACTORS.reduce((sum, factor) => sum + factor.weight, 0)
  const offsets = DEMO_AUDIT_FACTORS.map(factor => factor.bias + (unitHash(`${page.path}#${factor.id}`) * 2 - 1) * 12)
  const meanOffset = DEMO_AUDIT_FACTORS.reduce((sum, factor, index) => sum + offsets[index]! * factor.weight, 0) / totalWeight
  const factors = DEMO_AUDIT_FACTORS.map((factor, index): SiteCrawlAuditFactorDto => {
    const score = page.factorScores?.[factor.id] ?? Math.max(0, Math.min(100, Math.round(page.score + offsets[index]! - meanOffset)))
    const status = factorStatusFromScore(score)
    const passing = status === 'pass'
    return {
      id: factor.id, name: factor.name, weight: factor.weight, score, status, applicable: true,
      findings: [{ type: passing ? 'found' : 'missing', code: `${factor.id}.${passing ? 'present' : 'gap'}`, message: passing ? factor.found : factor.missing }],
      recommendations: passing ? [] : [factor.recommendation],
    }
  })
  const score = Math.round(factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / totalWeight)
  return { score, factors }
}

/**
 * Turns an example site inventory into the rows a completed crawl stores, using
 * the crawler's own vocabulary. Throws before anything is written when the
 * inventory describes a crawl that could not exist, because one dangling link
 * otherwise surfaces much later as an unavailable map.
 */
export function buildDemoSiteCrawl(input: DemoSiteCrawlInput): DemoSiteCrawl {
  const { inventory, root, prefix, nowIso } = input
  const scope = { projectId: input.project.id, runId: input.crawlRunId, attemptId: input.attemptId }
  const url = (path: string) => new URL(path, root).href
  const sitemapUrl = url('/sitemap.xml')

  const pagesByPath = new Map<string, DemoSitePage>()
  for (const page of inventory.pages) {
    if (pagesByPath.has(page.path)) throw new Error(`Demo site inventory lists ${page.path} more than once`)
    pagesByPath.set(page.path, page)
  }
  if (!pagesByPath.has(ROOT_PATH)) throw new Error('Demo site inventory has no root page')
  const requirePage = (path: string, role: string) => {
    if (!pagesByPath.has(path)) throw new Error(`Demo site ${role} ${path} is not a page in the inventory`)
  }
  const requireIndexable = (from: string, relation: string, target: string) => {
    if (pagesByPath.get(target)?.kind !== 'html') {
      throw new Error(`Demo site page ${from} ${relation} ${target}, which is not an indexable HTML page`)
    }
  }
  for (const page of inventory.pages) {
    if (page.kind === 'redirect') requireIndexable(page.path, 'redirects to', page.redirectTo)
    if (page.kind === 'canonicalized') requireIndexable(page.path, 'declares its canonical as', page.canonicalTo)
  }

  const drafts = new Map<string, LinkDraft>()
  const observe = (source: string, target: string, placement: DemoSiteLinkPlacement) => {
    requirePage(source, 'link source')
    requirePage(target, 'link target')
    // The crawler reads links only from a fetched HTML page. An error page, a
    // file, or a redirect records none.
    if (!HTML_KINDS.has(pagesByPath.get(source)!.kind)) {
      throw new Error(`Demo site link source ${source} is not an HTML page, so no crawl could record links from it`)
    }
    // The executor drops self links, so page metrics never count them.
    if (source === target) return
    const key = `${source}->${target}`
    let draft = drafts.get(key)
    if (!draft) {
      draft = { source, target, navigation: 0, content: 0, anchors: new Set() }
      drafts.set(key, draft)
    }
    draft[placement]++
    draft.anchors.add(anchorText(target))
  }
  for (const target of inventory.templateLinks) requirePage(target, 'menu or footer link target')
  for (const page of inventory.pages) {
    if (!HTML_KINDS.has(page.kind)) continue
    for (const target of inventory.templateLinks) observe(page.path, target, 'navigation')
  }
  for (const [source, target, placement = 'content'] of inventory.links) observe(source, target, placement)

  const edges = [...drafts.entries()].map(([edgeKey, draft]): EdgeRow => {
    const occurrences = draft.navigation + draft.content
    return {
      ...scope, id: `${prefix}-edge-${edgeKey}`, edgeKey,
      sourceNodeKey: draft.source, sourceUrl: url(draft.source),
      targetNodeKey: draft.target, targetUrl: url(draft.target),
      relation: 'anchor', internal: true, followable: true,
      occurrences, followableOccurrences: occurrences, nofollowOccurrences: 0,
      anchors: [...draft.anchors],
      isTemplate: placementLinkDecision({ navigation: draft.navigation, content: draft.content, unknown: 0 }) === 'navigation',
      templateRatio: null,
      placementNavigationOccurrences: draft.navigation,
      placementContentOccurrences: draft.content,
      placementUnknownOccurrences: 0,
      createdAt: nowIso, updatedAt: nowIso,
    }
  })

  const inbound = new Map<string, EdgeRow[]>()
  const outbound = new Map<string, EdgeRow[]>()
  for (const edge of edges) {
    inbound.set(edge.targetNodeKey, [...(inbound.get(edge.targetNodeKey) ?? []), edge])
    outbound.set(edge.sourceNodeKey, [...(outbound.get(edge.sourceNodeKey) ?? []), edge])
  }
  const inSitemap = (page: DemoSitePage) => page.sitemap ?? page.kind === 'html'
  for (const page of inventory.pages) {
    if (page.path !== ROOT_PATH && !inbound.has(page.path) && !inSitemap(page)) {
      throw new Error(`Demo site page ${page.path} has no inbound link and is not in the sitemap, so no crawl could find it`)
    }
  }

  // Shortest followable link depth from the root, as the crawler measures it.
  const depths = new Map([[ROOT_PATH, 0]])
  for (const queue = [ROOT_PATH]; queue.length > 0;) {
    const from = queue.shift()!
    for (const edge of outbound.get(from) ?? []) {
      if (depths.has(edge.targetNodeKey)) continue
      depths.set(edge.targetNodeKey, depths.get(from)! + 1)
      queue.push(edge.targetNodeKey)
    }
  }

  // PageRank over fetched HTML pages, as the crawler's link score does.
  const htmlPaths = inventory.pages.filter(page => HTML_KINDS.has(page.kind)).map(page => page.path).sort()
  const rankIndex = new Map(htmlPaths.map((path, index) => [path, index]))
  const rankTargets = htmlPaths.map(path => (outbound.get(path) ?? []).map(edge => rankIndex.get(edge.targetNodeKey)).filter((index): index is number => index !== undefined))
  let ranks = htmlPaths.map(() => 1 / htmlPaths.length)
  for (let iteration = 0; iteration < 50; iteration++) {
    const next = htmlPaths.map(() => 0.15 / htmlPaths.length)
    let dangling = 0
    for (const [index, targets] of rankTargets.entries()) {
      if (targets.length === 0) dangling += ranks[index]!
      for (const target of targets) next[target]! += 0.85 * ranks[index]! / targets.length
    }
    ranks = next.map(value => value + 0.85 * dangling / htmlPaths.length)
  }
  const maxInbound = Math.max(1, ...[...inbound.values()].map(edges => edges.length))

  const firstInbound = (path: string) => inbound.get(path)?.[0]?.sourceUrl ?? null
  const pages = inventory.pages.map((page): PageRow => {
    const fetchState = page.kind === 'broken' ? SiteCrawlFetchStates.fetchError
      : page.kind === 'redirect' ? SiteCrawlFetchStates.redirect
        : page.kind === 'resource' ? SiteCrawlFetchStates.nonHtml : SiteCrawlFetchStates.html
    const indexabilityState = page.kind === 'html' ? SiteCrawlIndexabilityStates.indexable
      : page.kind === 'noindex' ? SiteCrawlIndexabilityStates.noindex : SiteCrawlIndexabilityStates.unknown
    const indexabilityReasons = page.kind === 'html' ? []
      : page.kind === 'noindex' ? [SiteCrawlIndexabilityReasons.metaRobotsNoindex]
        : page.kind === 'canonicalized' ? [SiteCrawlIndexabilityReasons.canonicalToOther]
          : page.kind === 'redirect' ? [SiteCrawlIndexabilityReasons.redirectTerminal]
            : [SiteCrawlIndexabilityReasons.notHtmlOrUnavailable]
    const canonicalNodeKey = page.kind === 'canonicalized' ? page.canonicalTo : HTML_KINDS.has(page.kind) ? page.path : null
    const audit = 'score' in page ? auditFactors(page) : null
    const inboundEdges = inbound.get(page.path) ?? []
    const outboundEdges = outbound.get(page.path) ?? []
    const rank = rankIndex.has(page.path) ? ranks[rankIndex.get(page.path)!]! : 0
    const sitemapSources = inSitemap(page) ? [sitemapUrl] : []
    return {
      ...scope, id: `${prefix}-page-${page.path}`, nodeKey: page.path,
      url: url(page.path), path: page.path, parentPath: parentPath(page.path),
      discoverySource: page.path === ROOT_PATH ? 'root' : sitemapSources.length > 0 ? 'sitemap' : 'link',
      discoveryProvenance: [{ discoveredFrom: firstInbound(page.path), sitemapSources, root: page.path === ROOT_PATH }],
      sitemapMetadata: { sources: sitemapSources },
      fetchState, fetchedAt: nowIso,
      httpStatus: page.kind === 'broken' ? BROKEN_STATUS : page.kind === 'redirect' ? 301 : 200,
      contentType: page.kind === 'resource' ? page.contentType : page.kind === 'redirect' ? null : 'text/html; charset=utf-8',
      finalUrl: url(page.kind === 'redirect' ? page.redirectTo : page.path),
      redirectChain: page.kind === 'redirect' ? [url(page.redirectTo)] : [],
      directives: { metaRobots: page.kind === 'noindex' ? ['follow', 'noindex'] : [], xRobots: [] },
      canonicalUrl: canonicalNodeKey ? url(canonicalNodeKey) : null, canonicalNodeKey,
      indexabilityState, indexabilityReasons,
      healthState: deriveSiteHealthState({ nodeKey: page.path, fetchState, indexabilityState, indexabilityReasons, canonicalNodeKey }),
      auditState: audit ? 'success' : page.kind === 'broken' ? 'error' : 'not-applicable',
      auditScore: audit?.score ?? null,
      auditFields: audit ? { schemaVersion: '1.0', factors: audit.factors, criticalDefects: [] } : {},
      inventoryEligible: page.kind === 'html',
      depth: depths.get(page.path) ?? null,
      inboundUniqueEdges: inboundEdges.length, outboundUniqueEdges: outboundEdges.length,
      inboundOccurrences: inboundEdges.reduce((sum, edge) => sum + edge.occurrences, 0),
      outboundOccurrences: outboundEdges.reduce((sum, edge) => sum + edge.occurrences, 0),
      // Raw score is PageRank, as the crawler computes it. The normalized score uses the crawler's scale, 0 to 100
      // against the top page with two decimals, but follows a log of inbound links so hub pages stay visibly larger
      // than the pages they link to.
      linkScoreRaw: Number(rank.toFixed(12)),
      linkScoreNormalized: Number((Math.log1p(inboundEdges.length) / Math.log1p(maxInbound) * 100).toFixed(2)),
      createdAt: nowIso, updatedAt: nowIso,
    }
  })

  const findings = edges.flatMap((edge): FindingRow[] => pagesByPath.get(edge.targetNodeKey)?.kind === 'broken' ? [{
    ...scope, id: `${prefix}-finding-${edge.edgeKey}`, findingKey: `dead-link:${edge.edgeKey}`,
    findingType: 'dead-link', severity: 'error',
    sourceNodeKey: edge.sourceNodeKey, sourceUrl: edge.sourceUrl, targetNodeKey: edge.targetNodeKey, targetUrl: edge.targetUrl,
    evidence: { statusCode: BROKEN_STATUS, reason: 'http-error' },
    createdAt: nowIso, updatedAt: nowIso,
  }] : [])

  const counts = {
    pagesDiscovered: pages.length,
    pagesFetched: pages.length,
    pagesEligible: pages.filter(page => page.inventoryEligible).length,
    pagesErrored: pages.filter(page => page.fetchState === SiteCrawlFetchStates.fetchError).length,
    edgesDiscovered: edges.length,
  }
  const attempt: AttemptRow = {
    ...scope, id: input.attemptId, attemptNumber: 1, state: 'completed',
    lastEventSequence: pages.length + edges.length + findings.length + 1,
    ...counts, startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  }
  const pageBudget = Math.max(1000, pages.length)
  const edgeBudget = Math.max(5000, edges.length)
  const snapshot: SnapshotRow = {
    ...scope, id: `${prefix}-crawl-snapshot`, rootUrl: root, requestedRootUrl: root,
    crawlSchemaVersion: 'demo-2', engineVersion: 'sample-seed', normalizationVersion: 'demo-1', indexabilityVersion: 'demo-1', linkScoreVersion: 'demo-1',
    effectiveOptions: { mode: 'summary', sitemapUrl, maxPages: pageBudget, maxEdges: edgeBudget, maxDepth: null, checkDeadLinks: true, sampleData: true },
    pageBudget, edgeBudget, maxDepth: null, checkDeadLinks: true, complete: true, termination: 'complete', detailsAvailable: true,
    ...counts, findingsCount: findings.length, deadLinkState: 'complete',
    deadLinksChecked: new Set(edges.map(edge => edge.targetNodeKey)).size, deadLinksFound: findings.length, deadLinksUnverified: 0,
    templateDetection: 'applied-placement', linkPlacementRulesetVersion: 'demo-1', createdAt: nowIso, updatedAt: nowIso,
  }

  // Same sample order the production layout reads: root, then link score, then key.
  const order = [...pages].sort((left, right) => Number(right.nodeKey === ROOT_PATH) - Number(left.nodeKey === ROOT_PATH)
    || right.linkScoreNormalized! - left.linkScoreNormalized!
    || (left.nodeKey < right.nodeKey ? -1 : 1))
  const layoutEdges = [...edges].sort((left, right) => right.occurrences - left.occurrences || (left.edgeKey < right.edgeKey ? -1 : 1))
  const layoutInput: SiteCrawlGraphLayoutInput = {
    rootNodeKey: ROOT_PATH, totalNodes: pages.length, totalEdges: edges.length,
    totalTemplateEdges: edges.filter(edge => edge.isTemplate).length,
    nodes: order.map((page, sampleRank) => ({ nodeKey: page.nodeKey, path: page.path, depth: page.depth ?? null, sampleRank })),
    edges: layoutEdges.map(edge => ({
      edgeKey: edge.edgeKey, sourceNodeKey: edge.sourceNodeKey, targetNodeKey: edge.targetNodeKey,
      followable: true, occurrences: edge.occurrences, isTemplate: edge.isTemplate,
    })),
  }
  return { pages, edges, findings, attempt, snapshot, layoutInput }
}

/** Stores a fictional completed crawl and lays it out with the production graph worker. */
export async function seedSiteCrawl(db: DatabaseClient, input: DemoSiteCrawlInput): Promise<DemoSiteCrawl & { layout: Extract<PreparedSiteCrawlGraphLayout, { state: 'ready' }> }> {
  const crawl = buildDemoSiteCrawl(input)
  db.transaction(tx => {
    tx.insert(siteCrawlAttempts).values(crawl.attempt).run()
    tx.insert(siteCrawlSnapshots).values(crawl.snapshot).run()
    for (let i = 0; i < crawl.pages.length; i += 100) tx.insert(siteCrawlPages).values(crawl.pages.slice(i, i + 100)).run()
    for (let i = 0; i < crawl.edges.length; i += 250) tx.insert(siteCrawlEdges).values(crawl.edges.slice(i, i + 250)).run()
    if (crawl.findings.length > 0) tx.insert(siteCrawlFindings).values(crawl.findings).run()
  })
  const layout = await layoutSiteCrawlGraphInput(crawl.layoutInput)
  if (layout.state !== 'ready') throw new Error(`Demo site map for ${input.project.name} is unavailable: ${layout.failureCode}`)
  persistSiteCrawlGraphLayout(db, { projectId: input.project.id, runId: input.crawlRunId, attemptId: input.attemptId }, layout, input.nowIso)
  return { ...crawl, layout }
}
