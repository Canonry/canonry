import {
  deriveSiteHealthState, factorStatusFromScore, SiteCrawlFetchStates, SiteCrawlIndexabilityStates,
} from '@ainyc/canonry-contracts'
import {
  siteCrawlAttempts, siteCrawlEdges, siteCrawlFindings, siteCrawlPages, siteCrawlSnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { layoutSiteCrawlGraphInput, persistSiteCrawlGraphLayout } from '../site-crawl-graph-layout.js'
import { HARBOR_MARKETS, harborProperties } from './portfolio.js'
import type { DemoSeedProject } from './types.js'

const SECTIONS = [
  ['rooms', ['ocean-suite', 'family-suite', 'garden-studio', 'accessible-suite', 'penthouse', 'two-bedroom-villa', 'king-room', 'connecting-rooms']],
  ['dining', ['waterfront-grill', 'poolside-cafe', 'lobby-bar', 'breakfast', 'private-dining']],
  ['amenities', ['pool', 'spa', 'fitness-center', 'beach', 'kids-club', 'pet-friendly-stays']],
  ['experiences', ['kayaking', 'sunset-cruise', 'local-food-tour', 'nature-trails', 'art-walk', 'family-activities']],
  ['offers', ['family-getaway', 'weekend-escape', 'extended-stay', 'spa-retreat']],
  ['meetings', ['ballroom', 'boardroom', 'waterfront-terrace']],
] as const

type PageKind = 'html' | 'hidden' | 'failed' | 'redirect' | 'resource'
interface Page { path: string; parentPath: string; depth: number; score: number; kind: PageKind; canonicalPath?: string }
interface Edge { edgeKey: string; sourceNodeKey: string; targetNodeKey: string; isTemplate: boolean; occurrences: number; followable: boolean }

/** A bounded fictional crawl, laid out by the same offline worker as real crawls. */
export async function seedPortfolioCrawl(db: DatabaseClient, input: {
  project: DemoSeedProject; prefix: string; root: string; crawlRunId: string; attemptId: string; nowIso: string
}): Promise<void> {
  const { project, prefix, root, crawlRunId, attemptId, nowIso } = input
  const pages: Page[] = []
  const edges = new Map<string, Edge>()
  const addPage = (path: string, score = 92, kind: PageKind = 'html', canonicalPath?: string) => {
    const parts = path.split('/').filter(Boolean)
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}/` : '/'
    pages.push({ path, parentPath, depth: parts.length, score, kind, canonicalPath })
  }
  const addEdge = (source: string, target: string, isTemplate = false) => {
    if (source === target) return
    const edgeKey = `${source}->${target}`
    const existing = edges.get(edgeKey)
    if (existing) { existing.occurrences++; existing.isTemplate &&= isTemplate; return }
    edges.set(edgeKey, { edgeKey, sourceNodeKey: source, targetNodeKey: target, isTemplate, occurrences: 1, followable: true })
  }
  for (const path of ['/', '/destinations/', '/offers/', '/experiences/', '/guides/', '/contact/', '/services/']) addPage(path)
  for (const market of HARBOR_MARKETS) {
    addPage(`/destinations/${market.key}/`)
    addPage(`/destinations/${market.key}/guides/`)
    for (const topic of ['getting-here', 'family-travel', 'seasonal-events', 'local-restaurants', 'weekend-itinerary']) {
      addPage(`/destinations/${market.key}/guides/${topic}/`, 82)
    }
    addEdge('/guides/', `/destinations/${market.key}/guides/`)
  }
  const properties = harborProperties()
  for (const [propertyIndex, property] of properties.entries()) {
    const home = `${property.path}/`
    addPage(home, 94)
    for (const [sectionIndex, [section, topics]] of SECTIONS.entries()) {
      addPage(`${home}${section}/`, 88 - propertyIndex % 5)
      for (const [topicIndex, topic] of topics.entries()) {
        const pagePath = `${home}${section}/${topic}/`
        addPage(pagePath, 94 - (propertyIndex * 7 + sectionIndex * 3 + topicIndex * 9) % 39)
        // Related-page cards and booking guidance connect each property's content.
        addEdge(pagePath, `${home}${section}/${topics[(topicIndex + 1) % topics.length]}/`)
        addEdge(pagePath, `${home}${section}/${topics[(topicIndex + 2) % topics.length]}/`)
        addEdge(pagePath, `${home}offers/family-getaway/`)
        addEdge(pagePath, `${home}amenities/spa/`)
      }
    }
    for (const section of ['gallery', 'location', 'faq', 'reviews', 'contact']) addPage(`${home}${section}/`, 86)
    addPage(`${home}booking-confirmation/`, 90, 'hidden')
    addPage(`${home}offers/expired-summer-package/`, 0, 'failed')
    addPage(`${home}property-guide.pdf`, 0, 'resource')
    addPage(`${home}rooms/old-ocean-suite/`, 0, 'redirect', `${home}rooms/ocean-suite/`)
    addEdge('/offers/', `${home}offers/`)
    const siblings = properties.filter(candidate => candidate.market.key === property.market.key)
    addEdge(home, `${siblings[property.number % siblings.length]!.path}/`)
    addEdge(`/destinations/${property.market.key}/guides/family-travel/`, home)
  }
  for (const page of pages) {
    if (page.path !== '/') addEdge(page.parentPath, page.path)
    addEdge(page.path, '/', true)
    addEdge(page.path, page.parentPath, true)
    const property = properties.find(candidate => page.path.startsWith(`${candidate.path}/`))
    if (property) addEdge(page.path, `${property.path}/`, true)
  }
  const links = [...edges.values()]
  const incoming = new Map<string, Edge[]>()
  const outgoing = new Map<string, Edge[]>()
  for (const edge of links) {
    incoming.set(edge.targetNodeKey, [...(incoming.get(edge.targetNodeKey) ?? []), edge])
    outgoing.set(edge.sourceNodeKey, [...(outgoing.get(edge.sourceNodeKey) ?? []), edge])
  }
  const maxInbound = Math.max(...pages.map(page => incoming.get(page.path)?.length ?? 0))
  const scope = { projectId: project.id, runId: crawlRunId, attemptId }
  const pageRows = pages.map(page => {
    const fetchState = page.kind === 'failed' ? SiteCrawlFetchStates.fetchError
      : page.kind === 'redirect' ? SiteCrawlFetchStates.redirect
        : page.kind === 'resource' ? SiteCrawlFetchStates.nonHtml : SiteCrawlFetchStates.html
    const indexabilityState = page.kind === 'hidden' ? SiteCrawlIndexabilityStates.noindex
      : page.kind === 'html' ? SiteCrawlIndexabilityStates.indexable : SiteCrawlIndexabilityStates.unknown
    const audited = fetchState === SiteCrawlFetchStates.html
    const canonicalNodeKey = page.canonicalPath ?? (audited ? page.path : null)
    const factors = audited ? [
      { id: 'structured-data', name: 'Structured Data', score: page.score - 5, recommendation: 'Add property, room, and amenity details to the page markup.' },
      { id: 'page-identity', name: 'Page Identity', score: page.score, recommendation: 'Use a unique title and description for this property page.' },
      { id: 'internal-links', name: 'Internal Links', score: page.score + 5, recommendation: 'Link this page from relevant property and destination guides.' },
    ].map(factor => ({
      id: factor.id, name: factor.name, score: factor.score, weight: 1,
      status: factorStatusFromScore(factor.score), applicable: true,
      findings: [{ type: factor.score < 80 ? 'missing' : 'found', code: `demo-${factor.id}`, message: factor.score < 80 ? 'Sample finding: page details are incomplete.' : 'Sample finding: page details are available.' }],
      recommendations: factor.score < 80 ? [factor.recommendation] : [],
    })) : []
    const inbound = incoming.get(page.path) ?? []
    const outbound = outgoing.get(page.path) ?? []
    return {
      ...scope, id: `${prefix}-page-${page.path}`, nodeKey: page.path,
      url: new URL(page.path, root).href, path: page.path, parentPath: page.parentPath,
      discoverySource: page.path === '/' ? 'root' : 'crawl',
      sitemapMetadata: { sampleData: true, sitemap: new URL('/sitemap.xml', root).href },
      fetchState, fetchedAt: nowIso, httpStatus: page.kind === 'failed' ? 404 : page.kind === 'redirect' ? 301 : 200,
      contentType: page.kind === 'resource' ? 'application/pdf' : 'text/html',
      finalUrl: new URL(page.canonicalPath ?? page.path, root).href,
      redirectChain: page.kind === 'redirect' ? [new URL(page.path, root).href, new URL(page.canonicalPath!, root).href] : [],
      canonicalUrl: canonicalNodeKey ? new URL(canonicalNodeKey, root).href : null, canonicalNodeKey,
      indexabilityState, indexabilityReasons: page.kind === 'hidden' ? ['meta-noindex'] : [],
      directives: page.kind === 'hidden' ? { robots: ['noindex'] } : {},
      healthState: deriveSiteHealthState({ nodeKey: page.path, fetchState, indexabilityState, canonicalNodeKey }),
      auditState: audited ? 'completed' : 'skipped', auditScore: audited ? page.score : null,
      auditFields: { schemaVersion: '1.0', sampleData: true, factors, criticalDefects: [] },
      inventoryEligible: page.kind === 'html', depth: page.depth,
      inboundUniqueEdges: inbound.length, outboundUniqueEdges: outbound.length,
      inboundOccurrences: inbound.reduce((sum, edge) => sum + edge.occurrences, 0),
      outboundOccurrences: outbound.reduce((sum, edge) => sum + edge.occurrences, 0),
      linkScoreRaw: inbound.length, linkScoreNormalized: Math.log1p(inbound.length) / Math.log1p(maxInbound),
      createdAt: nowIso, updatedAt: nowIso,
    } satisfies typeof siteCrawlPages.$inferInsert
  })
  const findings: (typeof siteCrawlFindings.$inferInsert)[] = pages.flatMap(page => page.kind === 'failed' ? [{
    ...scope, id: `${prefix}-broken-${page.path}`, findingKey: `broken-${page.path}`, findingType: 'dead-link', severity: 'medium',
    sourceNodeKey: page.parentPath, sourceUrl: new URL(page.parentPath, root).href, targetUrl: new URL(page.path, root).href,
    evidence: { statusCode: 404, note: 'Sample finding: an expired package is still linked from the property offers page.' }, createdAt: nowIso, updatedAt: nowIso,
  }] : [])
  const counts = { pagesDiscovered: pages.length, pagesFetched: pages.length, pagesEligible: pageRows.filter(page => page.inventoryEligible).length, pagesErrored: pages.filter(page => page.kind === 'failed').length, edgesDiscovered: links.length }
  db.insert(siteCrawlAttempts).values({ ...scope, id: attemptId, attemptNumber: 1, state: 'completed', lastEventSequence: pages.length, ...counts, startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(siteCrawlSnapshots).values({ ...scope, id: `${prefix}-crawl-snapshot`, rootUrl: root, requestedRootUrl: root, crawlSchemaVersion: 'demo-2', engineVersion: 'sample-seed', normalizationVersion: 'demo-1', indexabilityVersion: 'demo-1', linkScoreVersion: 'demo-1', effectiveOptions: { sampleData: true }, pageBudget: 1000, edgeBudget: 5000, maxDepth: 5, checkDeadLinks: true, complete: true, termination: 'complete', detailsAvailable: true, ...counts, findingsCount: findings.length, deadLinkState: 'complete', deadLinksChecked: pages.length, deadLinksFound: findings.length, deadLinksUnverified: 0, templateDetection: 'applied-placement', linkPlacementRulesetVersion: 'demo-1', createdAt: nowIso, updatedAt: nowIso }).run()
  for (let i = 0; i < pageRows.length; i += 100) db.insert(siteCrawlPages).values(pageRows.slice(i, i + 100)).run()
  const edgeRows = links.map(edge => ({
    ...scope, ...edge, id: `${prefix}-edge-${edge.edgeKey}`,
    sourceUrl: new URL(edge.sourceNodeKey, root).href, targetUrl: new URL(edge.targetNodeKey, root).href,
    relation: 'anchor', internal: true, followableOccurrences: edge.occurrences, nofollowOccurrences: 0,
    anchors: ['Sample page link'], placementNavigationOccurrences: edge.isTemplate ? edge.occurrences : 0,
    placementContentOccurrences: edge.isTemplate ? 0 : edge.occurrences, placementUnknownOccurrences: 0,
    createdAt: nowIso, updatedAt: nowIso,
  }))
  for (let i = 0; i < edgeRows.length; i += 100) db.insert(siteCrawlEdges).values(edgeRows.slice(i, i + 100)).run()
  db.insert(siteCrawlFindings).values(findings).run()
  const layout = await layoutSiteCrawlGraphInput({
    rootNodeKey: '/', totalNodes: pages.length, totalEdges: links.length,
    totalTemplateEdges: links.filter(edge => edge.isTemplate).length,
    nodes: pages.map((page, sampleRank) => ({ nodeKey: page.path, path: page.path, depth: page.depth, sampleRank })),
    edges: links,
  })
  if (layout.state !== 'ready') throw new Error(`Demo portfolio map unavailable: ${layout.failureCode}`)
  persistSiteCrawlGraphLayout(db, scope, layout, nowIso)
}
