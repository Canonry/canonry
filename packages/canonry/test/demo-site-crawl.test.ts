import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createClient, migrate, projects, runs, siteCrawlGraphLayouts, siteCrawlGraphNodes, type DatabaseClient } from '@ainyc/canonry-db'
import { SITE_CRAWL_GRAPH_LAYOUT_VERSION } from '../src/site-crawl-graph-layout.js'
import {
  buildDemoSiteCrawl, DEMO_AUDIT_FACTORS, seedSiteCrawl,
  type DemoSiteCrawlInput, type DemoSiteInventory, type DemoSitePage,
} from '../src/demo/seed-site-crawl.js'
import { harborResortsInventory } from '../src/demo/site-inventories/harbor-resorts.js'
import { summitRoofingInventory } from '../src/demo/site-inventories/summit-roofing.js'
import { createDemoSeedContext } from '../src/demo/types.js'

const context = createDemoSeedContext(new Date('2026-09-09T12:00:00.000Z'))
const nowIso = context.now.toISOString()

function crawlInput(project: typeof context.simple, inventory: DemoSiteInventory): DemoSiteCrawlInput {
  const prefix = `test-${project.id}`
  return { project, prefix, root: `https://${project.domain}/`, crawlRunId: `${prefix}-crawl`, attemptId: `${prefix}-attempt`, nowIso, inventory }
}

const SITES = [
  {
    name: 'summit-roofing', input: () => crawlInput(context.simple, summitRoofingInventory()),
    pages: 205, health: { eligible: 177, hidden: 14, redirect: 6, resource: 4, failed: 4 },
    edges: 4269, templateEdges: 3188, contentEdges: 1081, findings: 5,
    orphans: ['/guides/choosing-roof-color/', '/llms.txt', '/service-areas/fox-meadow/gutters/', '/spring-roof-special/'],
  },
  {
    name: 'harbor-resorts', input: () => crawlInput(context.portfolio, harborResortsInventory()),
    pages: 604, health: { eligible: 556, hidden: 12, redirect: 12, resource: 12, failed: 12 },
    edges: 3618, templateEdges: 1512, contentEdges: 2106, findings: 12,
    orphans: [],
  },
] as const

/** Factor id, name, and weight triples declared by the installed @canonry/aeo-audit analyzers. */
function installedAuditFactors(): Set<string> {
  const dir = path.join(import.meta.dirname, '..', 'node_modules', '@canonry', 'aeo-audit', 'dist')
  const triples = new Set<string>()
  for (const file of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.js')) continue
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const match of source.matchAll(/id: '([a-z-]+)', name: '([^']+)', weight: (\d+)/g)) triples.add(`${match[1]}|${match[2]}|${match[3]}`)
  }
  return triples
}

describe('demo site crawl inventories', () => {
  it.each(SITES)('$name has the exact page, link, and finding counts', site => {
    const crawl = buildDemoSiteCrawl(site.input())
    expect(crawl.pages).toHaveLength(site.pages)
    const health: Record<string, number> = {}
    for (const page of crawl.pages) health[page.healthState!] = (health[page.healthState!] ?? 0) + 1
    expect(health).toEqual(site.health)
    expect(crawl.edges).toHaveLength(site.edges)
    expect(crawl.edges.filter(edge => edge.isTemplate)).toHaveLength(site.templateEdges)
    expect(crawl.edges.filter(edge => !edge.isTemplate)).toHaveLength(site.contentEdges)
    expect(crawl.findings).toHaveLength(site.findings)
    expect(crawl.pages.filter(page => page.nodeKey !== '/' && page.inboundUniqueEdges === 0).map(page => page.nodeKey).sort()).toEqual(site.orphans)

    const counts = { pagesDiscovered: site.pages, pagesFetched: site.pages, pagesEligible: site.health.eligible, pagesErrored: site.health.failed, edgesDiscovered: site.edges }
    expect(crawl.attempt).toMatchObject({ state: 'completed', ...counts })
    expect(crawl.snapshot).toMatchObject({ complete: true, ...counts, findingsCount: site.findings, deadLinksFound: site.findings, deadLinkState: 'complete' })
    expect(crawl.layoutInput).toMatchObject({ totalNodes: site.pages, totalEdges: site.edges, totalTemplateEdges: site.templateEdges })
  })

  it.each(SITES)('$name keeps menu and footer links apart from links in page text', site => {
    const crawl = buildDemoSiteCrawl(site.input())
    for (const edge of crawl.edges) {
      expect(edge.relation).toBe('anchor')
      expect(edge.placementNavigationOccurrences! + edge.placementContentOccurrences!).toBe(edge.occurrences)
      if (edge.isTemplate) expect(edge.placementContentOccurrences, edge.edgeKey).toBe(0)
      else expect(edge.placementContentOccurrences, edge.edgeKey).toBeGreaterThan(0)
    }
  })

  it.each(SITES)('$name links only between pages that exist', site => {
    const crawl = buildDemoSiteCrawl(site.input())
    const keys = new Set(crawl.pages.map(page => page.nodeKey))
    expect(keys.size).toBe(crawl.pages.length)
    for (const edge of crawl.edges) {
      expect(keys.has(edge.sourceNodeKey), edge.edgeKey).toBe(true)
      expect(keys.has(edge.targetNodeKey), edge.edgeKey).toBe(true)
    }
    const layoutKeys = new Set(crawl.layoutInput.nodes.map(node => node.nodeKey))
    expect(crawl.layoutInput.edges.every(edge => layoutKeys.has(edge.sourceNodeKey) && layoutKeys.has(edge.targetNodeKey))).toBe(true)
    const eligible = new Set(crawl.pages.filter(page => page.healthState === 'eligible').map(page => page.url))
    for (const page of crawl.pages) {
      if (page.fetchState === 'redirect') expect(eligible.has(page.finalUrl!), page.nodeKey).toBe(true)
      if (page.canonicalUrl && page.canonicalUrl !== page.url) expect(eligible.has(page.canonicalUrl), page.nodeKey).toBe(true)
    }
  })

  it.each(SITES)('$name records anchor links only from pages the crawler parses as HTML', site => {
    const input = site.input()
    const kinds = new Map(input.inventory.pages.map(page => [page.path, page.kind]))
    const crawl = buildDemoSiteCrawl(input)
    const fromUnparsedPages = crawl.edges.filter(edge => !['html', 'noindex', 'canonicalized'].includes(kinds.get(edge.sourceNodeKey)!))
    expect(fromUnparsedPages.map(edge => edge.edgeKey)).toEqual([])
    const fetchStates = new Map(crawl.pages.map(page => [page.nodeKey, page.fetchState]))
    expect(new Set(crawl.edges.map(edge => fetchStates.get(edge.sourceNodeKey)))).toEqual(new Set(['html']))
  })

  it('sizes each Harbor property home above the pages it links to', () => {
    const crawl = buildDemoSiteCrawl(crawlInput(context.portfolio, harborResortsInventory()))
    const score = (key: string) => crawl.pages.find(page => page.nodeKey === key)!.linkScoreNormalized!
    expect(score('/')).toBe(100)
    for (const key of ['/destinations/key-west/resort/', '/destinations/coastal-maine/villas-3/']) {
      expect(score(key), key).toBeGreaterThan(50)
      expect(score(key), key).toBeGreaterThan(score(`${key}rooms/ocean-suite/`))
    }
  })

  it.each(SITES)('$name writes link importance on the 0 to 100 scale a real crawl writes', site => {
    // @canonry/aeo-audit writes `linkScore` as `value / maximum * 100` rounded
    // to two decimals, and executeSiteAudit stores it unchanged as
    // `linkScoreNormalized`. A demo on any other scale makes every reader guess.
    const crawl = buildDemoSiteCrawl(site.input())
    for (const page of crawl.pages) {
      const score = page.linkScoreNormalized!
      expect(score, page.nodeKey).toBeGreaterThanOrEqual(0)
      expect(score, page.nodeKey).toBeLessThanOrEqual(100)
      expect(Number(score.toFixed(2)), page.nodeKey).toBe(score)
    }
    const scores = crawl.pages.map(page => page.linkScoreNormalized!)
    // The most linked page is the 100 every other page is measured against,
    expect(Math.max(...scores)).toBe(100)
    // an unlinked page scores exactly 0,
    for (const orphan of site.orphans) expect(crawl.pages.find(page => page.nodeKey === orphan)!.linkScoreNormalized, orphan).toBe(0)
    // and more links in never lowers a page's score.
    const byInbound = [...crawl.pages].sort((left, right) => left.inboundUniqueEdges! - right.inboundUniqueEdges!)
    for (const [index, page] of byInbound.entries()) {
      if (index > 0) expect(page.linkScoreNormalized!, page.nodeKey).toBeGreaterThanOrEqual(byInbound[index - 1]!.linkScoreNormalized!)
    }
  })

  it.each(SITES)('$name reports one dead link for every link to a failed page', site => {
    const crawl = buildDemoSiteCrawl(site.input())
    const failed = crawl.pages.filter(page => page.healthState === 'failed')
    const failedKeys = new Set(failed.map(page => page.nodeKey))
    const linksToFailed = crawl.edges.filter(edge => failedKeys.has(edge.targetNodeKey))
    expect(crawl.findings).toHaveLength(linksToFailed.length)
    expect(new Set(crawl.findings.map(finding => finding.targetNodeKey))).toEqual(failedKeys)
    for (const finding of crawl.findings) {
      expect(finding.findingType).toBe('dead-link')
      expect(linksToFailed.some(edge => edge.sourceNodeKey === finding.sourceNodeKey && edge.targetNodeKey === finding.targetNodeKey)).toBe(true)
      expect(finding.evidence).toEqual({ statusCode: failed.find(page => page.nodeKey === finding.targetNodeKey)!.httpStatus, reason: 'http-error' })
    }
    for (const page of failed) expect(page).toMatchObject({ fetchState: 'fetch-error', auditState: 'error', auditScore: null })
  })

  it.each(SITES)('$name scores audited pages on the installed audit factors', site => {
    const installed = installedAuditFactors()
    for (const factor of DEMO_AUDIT_FACTORS) expect(installed.has(`${factor.id}|${factor.name}|${factor.weight}`), factor.id).toBe(true)
    const crawl = buildDemoSiteCrawl(site.input())
    const totalWeight = DEMO_AUDIT_FACTORS.reduce((sum, factor) => sum + factor.weight, 0)
    for (const page of crawl.pages.filter(candidate => candidate.auditState === 'success')) {
      const factors = page.auditFields!.factors as { id: string; score: number; weight: number }[]
      expect(factors.map(factor => factor.id)).toEqual(DEMO_AUDIT_FACTORS.map(factor => factor.id))
      expect(page.auditScore).toBe(Math.round(factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / totalWeight))
    }
  })
})

describe('demo site crawl inventory validation', () => {
  const valid = (): { pages: DemoSitePage[]; templateLinks: string[]; links: [string, string][] } => ({
    pages: [
      { path: '/', kind: 'html', score: 80 },
      { path: '/services/', kind: 'html', score: 80 },
      { path: '/guides/', kind: 'html', score: 80 },
      { path: '/guides/page/2/', kind: 'canonicalized', canonicalTo: '/guides/', score: 70 },
      { path: '/thank-you/', kind: 'noindex', score: 60 },
      { path: '/old-services/', kind: 'redirect', redirectTo: '/services/' },
      { path: '/removed/', kind: 'broken' },
      { path: '/terms.pdf', kind: 'resource', contentType: 'application/pdf' },
      { path: '/sitemap-only/', kind: 'html', score: 70 },
    ],
    templateLinks: ['/', '/services/', '/guides/'],
    links: [['/guides/', '/guides/page/2/'], ['/services/', '/thank-you/'], ['/guides/', '/old-services/'], ['/guides/', '/removed/'], ['/services/', '/terms.pdf']],
  })
  const build = (inventory: DemoSiteInventory) => () => buildDemoSiteCrawl(crawlInput(context.simple, inventory))

  it('accepts a consistent inventory', () => {
    expect(build(valid())).not.toThrow()
  })

  it.each([
    ['a duplicate path', (inventory: ReturnType<typeof valid>) => { inventory.pages.push({ path: '/services/', kind: 'html', score: 50 }) }, /lists \/services\/ more than once/],
    ['no root page', (inventory: ReturnType<typeof valid>) => { inventory.pages.shift() }, /no root page/],
    ['a link to a missing page', (inventory: ReturnType<typeof valid>) => { inventory.links.push(['/services/', '/missing/']) }, /link target \/missing\/ is not a page/],
    ['a link from a missing page', (inventory: ReturnType<typeof valid>) => { inventory.links.push(['/missing/', '/services/']) }, /link source \/missing\/ is not a page/],
    ['a menu link to a missing page', (inventory: ReturnType<typeof valid>) => { inventory.templateLinks.push('/missing/') }, /menu or footer link target \/missing\/ is not a page/],
    ['a redirect to a missing page', (inventory: ReturnType<typeof valid>) => { inventory.pages.push({ path: '/gone/', kind: 'redirect', redirectTo: '/missing/' }); inventory.links.push(['/', '/gone/']) }, /\/gone\/ redirects to \/missing\/, which is not an indexable HTML page/],
    ['a redirect to a noindex page', (inventory: ReturnType<typeof valid>) => { inventory.pages.push({ path: '/gone/', kind: 'redirect', redirectTo: '/thank-you/' }); inventory.links.push(['/', '/gone/']) }, /\/gone\/ redirects to \/thank-you\/, which is not an indexable HTML page/],
    ['a canonical to a redirect', (inventory: ReturnType<typeof valid>) => { inventory.pages.push({ path: '/guides/page/3/', kind: 'canonicalized', canonicalTo: '/old-services/', score: 60 }); inventory.links.push(['/guides/', '/guides/page/3/']) }, /\/guides\/page\/3\/ declares its canonical as \/old-services\/, which is not an indexable HTML page/],
    ['a link from a broken page', (inventory: ReturnType<typeof valid>) => { inventory.links.push(['/removed/', '/']) }, /link source \/removed\/ is not an HTML page/],
    ['a link from a PDF', (inventory: ReturnType<typeof valid>) => { inventory.links.push(['/terms.pdf', '/']) }, /link source \/terms\.pdf is not an HTML page/],
    ['a link from a redirect', (inventory: ReturnType<typeof valid>) => { inventory.links.push(['/old-services/', '/guides/']) }, /link source \/old-services\/ is not an HTML page/],
    ['a page no crawl could find', (inventory: ReturnType<typeof valid>) => { inventory.pages.push({ path: '/unlinked/', kind: 'noindex', score: 60 }) }, /\/unlinked\/ has no inbound link and is not in the sitemap/],
  ])('rejects %s', (_label, mutate, message) => {
    const inventory = valid()
    mutate(inventory)
    expect(build(inventory)).toThrow(message)
  })
})

describe('stored demo site crawls', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-site-crawl-'))
    db = createClient(path.join(tmpDir, 'demo.db'))
    migrate(db)
    for (const site of SITES) {
      const input = site.input()
      db.insert(projects).values({ id: input.project.id, name: input.project.name, displayName: input.project.displayName, canonicalDomain: input.project.domain, country: 'US', language: 'en', createdAt: nowIso, updatedAt: nowIso }).run()
      db.insert(runs).values({ id: input.crawlRunId, projectId: input.project.id, kind: 'site-audit', status: 'completed', trigger: 'manual', startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso }).run()
      await seedSiteCrawl(db, input)
    }
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true, googleStateSecret: 'test-only-google-state-secret-32b' })
    await app.ready()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(SITES)('$name stores a ready production layout for every page', async site => {
    const input = site.input()
    const layout = db.select().from(siteCrawlGraphLayouts).where(eq(siteCrawlGraphLayouts.projectId, input.project.id)).get()
    expect(layout).toMatchObject({ state: 'ready', layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION, totalNodes: site.pages, totalEdges: site.edges, totalTemplateEdges: site.templateEdges, nodeCount: site.pages, edgeCount: site.edges })
    const nodes = db.select().from(siteCrawlGraphNodes).where(and(eq(siteCrawlGraphNodes.projectId, input.project.id), eq(siteCrawlGraphNodes.runId, input.crawlRunId))).all()
    expect(nodes).toHaveLength(site.pages)
    expect(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)

    const graph = (await app.inject(`/api/v1/projects/${site.name}/technical-aeo/graph?linkKind=all`)).json()
    expect(graph).toMatchObject({ totalNodes: site.pages, totalEdges: site.edges, totalTemplateEdges: site.templateEdges, sampled: false, layout: { state: 'ready' } })
    const deadLinks = (await app.inject(`/api/v1/projects/${site.name}/technical-aeo/dead-links`)).json()
    expect(deadLinks).toMatchObject({ state: 'complete', total: site.findings, found: site.findings })
  })

  it.each(SITES)('$name serves stored link importance on the 0 to 100 scale', async site => {
    const graph = (await app.inject(`/api/v1/projects/${site.name}/technical-aeo/graph?linkKind=all`)).json() as { nodes: { linkScoreNormalized: number | null }[] }
    const scores = graph.nodes.map(node => node.linkScoreNormalized)
    expect(scores).toHaveLength(site.pages)
    expect(scores.every(score => score !== null && score >= 0 && score <= 100)).toBe(true)
    expect(Math.max(...scores.map(score => score!))).toBe(100)
  })

  it('serves the standard business map with complete page evidence and a path to a sub-service', async () => {
    const base = '/api/v1/projects/summit-roofing/technical-aeo'
    const detail = await app.inject(`${base}/crawl/pages/audit?nodeKey=${encodeURIComponent('/services/roof-repair/leak-repair/')}`)
    expect(detail.statusCode, detail.body.slice(0, 200)).toBe(200)
    expect(detail.json()).toMatchObject({ state: 'ready', evidenceState: 'complete' })
    const route = await app.inject(`${base}/path?toNodeKey=${encodeURIComponent('/services/roof-repair/leak-repair/')}`)
    expect(route.statusCode, route.body.slice(0, 200)).toBe(200)
    expect(route.json().state).toBe('found')
  })
})
