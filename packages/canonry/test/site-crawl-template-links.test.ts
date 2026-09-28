import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlPages,
} from '@ainyc/canonry-db'
import { TEMPLATE_LINK_MIN_FETCHED_PAGES } from '@ainyc/canonry-contracts'
import { prepareSiteCrawlGraphLayout } from '../src/site-crawl-graph-layout.js'
import { classifySiteCrawlTemplateLinks } from '../src/site-crawl-template-links.js'

const NAV_TARGETS = ['services', 'pricing', 'about', 'contact'] as const

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-template-links-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

/**
 * A crawl shaped like a real site: a nav block on every page, one editorial
 * link per page, and one page (`orphan`) that nothing links to except the nav.
 */
function seedCrawl(db: ReturnType<typeof createClient>, pageCount: number) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p',
    canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now,
  }).run()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed',
    pagesFetched: pageCount, createdAt: now, updatedAt: now,
  }).run()

  const sources = Array.from({ length: pageCount }, (_, index) => `page-${String(index).padStart(2, '0')}`)
  const nodeKeys = [...new Set([...sources, ...NAV_TARGETS, 'orphan', ...sources.map((s) => `guide-${s}`)])]
  db.insert(siteCrawlPages).values(nodeKeys.map((nodeKey, index) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey,
    url: nodeKey === 'page-00' ? 'https://example.com/' : `https://example.com/${nodeKey}`,
    path: nodeKey === 'page-00' ? '/' : `/${nodeKey}`,
    parentPath: '/', discoverySource: 'link', fetchState: 'html',
    indexabilityState: 'indexable', healthState: 'eligible', auditState: 'complete',
    inventoryEligible: true, depth: nodeKey === 'page-00' ? 0 : 2,
    linkScoreNormalized: 100 - index / 10,
    createdAt: now, updatedAt: now,
  }))).run()

  const edges = []
  for (const source of sources) {
    for (const target of [...NAV_TARGETS, 'orphan']) {
      if (target === source) continue
      edges.push({
        id: crypto.randomUUID(), projectId, runId, attemptId,
        edgeKey: `nav:${source}->${target}`,
        sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
        targetNodeKey: target, targetUrl: `https://example.com/${target}`,
        relation: 'anchor', internal: true, followable: true,
        occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [target === 'services' ? 'Our  Services' : target],
        createdAt: now, updatedAt: now,
      })
    }
    edges.push({
      id: crypto.randomUUID(), projectId, runId, attemptId,
      edgeKey: `body:${source}->guide`,
      sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
      targetNodeKey: `guide-${source}`, targetUrl: `https://example.com/guide-${source}`,
      relation: 'anchor', internal: true, followable: true,
      occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: [`read the ${source} guide`],
      createdAt: now, updatedAt: now,
    })
  }
  db.insert(siteCrawlEdges).values(edges).run()
  return { projectId, runId, attemptId, sources }
}

function edgeRows(db: ReturnType<typeof createClient>, attemptId: string) {
  return db.select().from(siteCrawlEdges)
    .where(eq(siteCrawlEdges.attemptId, attemptId))
    .orderBy(asc(siteCrawlEdges.edgeKey))
    .all()
}

describe('site crawl template links', () => {
  it('marks the nav mesh, leaves editorial links alone, and persists the share', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    // No placement ruleset: this is the fallback, and it is what a pre-4.7.0
    // scan looks like forever, since placement can never be backfilled.
    const result = classifySiteCrawlTemplateLinks(db, scope, 20, null)
    expect(result.detection).toBe('applied')
    expect(result.templateEdgeCount).toBeGreaterThan(0)
    expect(result.placementEdgeCount).toBe(0)

    const rows = edgeRows(db, scope.attemptId)
    const template = rows.filter((row) => row.isTemplate)
    expect(template).toHaveLength(result.templateEdgeCount)
    expect(template.every((row) => row.edgeKey.startsWith('nav:'))).toBe(true)
    expect(rows.filter((row) => row.edgeKey.startsWith('body:')).every((row) => row.isTemplate === false)).toBe(true)
    // Never NULL after classification: NULL is reserved for a scan that was
    // never classified at all, which reads report as a legacy scan.
    expect(rows.every((row) => row.isTemplate !== null)).toBe(true)
    // Every one of the 20 fetched pages carries the nav item, and `Our
    // Services` written with one space or two is the same anchor.
    expect(rows.find((row) => row.edgeKey === 'nav:page-01->services')?.templateRatio).toBe(1)
    expect(rows.find((row) => row.edgeKey === 'body:page-01->guide')?.templateRatio).toBe(0.05)
  })

  it('marks nothing below the small-site floor, and says so rather than returning an empty set', () => {
    const db = freshDb()
    const scope = seedCrawl(db, TEMPLATE_LINK_MIN_FETCHED_PAGES - 1)

    const result = classifySiteCrawlTemplateLinks(db, scope, TEMPLATE_LINK_MIN_FETCHED_PAGES - 1, null)
    expect(result.detection).toBe('unavailable-too-few-pages')
    expect(result.templateEdgeCount).toBe(0)

    const rows = edgeRows(db, scope.attemptId)
    expect(rows.length).toBeGreaterThan(0)
    // Explicitly classified as "not a template link", with no invented ratio,
    // so the state on the snapshot is the only thing saying we could not tell.
    expect(rows.every((row) => row.isTemplate === false)).toBe(true)
    expect(rows.every((row) => row.templateRatio === null)).toBe(true)
  })

  it('is deterministic and idempotent across repeated publishes', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    const first = classifySiteCrawlTemplateLinks(db, scope, 20, null)
    const firstRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])
    const second = classifySiteCrawlTemplateLinks(db, scope, 20, null)
    const secondRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])

    expect(second).toEqual(first)
    expect(secondRows).toEqual(firstRows)
  })

  it('keeps template links out of the layout but in the published sample', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    classifySiteCrawlTemplateLinks(db, scope, 20, null)

    const layout = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    expect(layout.state).toBe('ready')
    if (layout.state !== 'ready') throw new Error('expected ready layout')

    const templateEdges = layout.edges.filter((edge) => edge.isTemplate)
    const contentEdges = layout.edges.filter((edge) => !edge.isTemplate)
    // Published so a viewer can switch them on without a refetch...
    expect(templateEdges.length).toBeGreaterThan(0)
    expect(contentEdges.length).toBeGreaterThan(0)
    expect(layout.edgeCount).toBe(layout.edges.length)
    // ...and counted, so the split never has to be inferred from the payload.
    expect(layout.totalTemplateEdges).toBe(templateEdges.length)
    expect(layout.totalEdges).toBe(layout.edges.length)
    expect(layout.templateLinksExcluded).toBe(true)
  })

  it('places a page whose only inbound links are template links', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    classifySiteCrawlTemplateLinks(db, scope, 20, null)

    const layout = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (layout.state !== 'ready') throw new Error('expected ready layout')

    // `orphan` is reachable only through the nav, so excluding template links
    // makes it a genuine singleton component. It must still land somewhere
    // finite and distinct rather than being stacked on another node.
    const orphan = layout.nodes.find((node) => node.nodeKey === 'orphan')
    expect(orphan).toBeDefined()
    expect(Number.isFinite(orphan!.x) && Number.isFinite(orphan!.y)).toBe(true)
    const collisions = layout.nodes.filter((node) => node.x === orphan!.x && node.y === orphan!.y)
    expect(collisions).toHaveLength(1)

    // Same crawl, same coordinates: the layout is a pure function of the
    // classified graph.
    const again = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (again.state !== 'ready') throw new Error('expected ready layout')
    expect(again.nodes).toEqual(layout.nodes)
  })

  it('excluding the nav mesh changes the spatialization it used to dominate', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    const withNavMesh = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    classifySiteCrawlTemplateLinks(db, scope, 20, null)
    const contentOnly = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (withNavMesh.state !== 'ready' || contentOnly.state !== 'ready') throw new Error('expected ready layouts')

    // Unclassified links are all content, so the first run is the old
    // behavior. The same node set with the mesh removed must not land in the
    // same places, or the exclusion did nothing.
    expect(withNavMesh.totalTemplateEdges).toBe(0)
    expect(contentOnly.totalTemplateEdges).toBeGreaterThan(0)
    expect(contentOnly.nodes.map((node) => node.nodeKey)).toEqual(withNavMesh.nodes.map((node) => node.nodeKey))
    expect(contentOnly.nodes).not.toEqual(withNavMesh.nodes)
  })
})

/**
 * Stamp DOM placement onto seeded links: everything is nav chrome except the
 * `body:` links, which sit in the page's main content. `only` narrows the
 * placement to a subset so a test can leave the rest with none recorded.
 */
function stampPlacement(
  db: ReturnType<typeof createClient>,
  attemptId: string,
  overrides: Record<string, { navigation: number; content: number; unknown: number }> = {},
) {
  for (const row of edgeRows(db, attemptId)) {
    const placement = overrides[row.edgeKey]
      ?? (row.edgeKey.startsWith('body:')
        ? { navigation: 0, content: 1, unknown: 0 }
        : { navigation: 1, content: 0, unknown: 0 })
    db.update(siteCrawlEdges).set({
      placementNavigationOccurrences: placement.navigation,
      placementContentOccurrences: placement.content,
      placementUnknownOccurrences: placement.unknown,
    }).where(eq(siteCrawlEdges.id, row.id)).run()
  }
}

describe('site crawl template links, by DOM placement', () => {
  it('classifies by placement and reports which rule it used', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    stampPlacement(db, scope.attemptId)

    const result = classifySiteCrawlTemplateLinks(db, scope, 20, '1.0.0')
    expect(result.detection).toBe('applied-placement')
    expect(result.placementEdgeCount).toBe(edgeRows(db, scope.attemptId).length)

    const rows = edgeRows(db, scope.attemptId)
    expect(rows.filter((row) => row.edgeKey.startsWith('nav:')).every((row) => row.isTemplate === true)).toBe(true)
    expect(rows.filter((row) => row.edgeKey.startsWith('body:')).every((row) => row.isTemplate === false)).toBe(true)
    // The fallback rule never ran, so none of its evidence is persisted. A
    // ratio beside a placement decision would suggest it had a vote.
    expect(rows.every((row) => row.templateRatio === null)).toBe(true)
  })

  it('un-hides an editorial link the ubiquity rule could not see', () => {
    // The measured canonry.ai failure, at the persistence layer. One page links
    // a nav target from its own prose, using the nav's exact anchor text, so
    // the (target, anchor) pair is on all 20 pages and ubiquity marks the row
    // chrome. Placement sees the content occurrence and does not.
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    const editorialKey = 'nav:page-03->services'

    const ubiquity = classifySiteCrawlTemplateLinks(db, scope, 20, null)
    expect(ubiquity.detection).toBe('applied')
    expect(edgeRows(db, scope.attemptId).find((row) => row.edgeKey === editorialKey)?.isTemplate).toBe(true)

    stampPlacement(db, scope.attemptId, { [editorialKey]: { navigation: 1, content: 1, unknown: 0 } })
    const placement = classifySiteCrawlTemplateLinks(db, scope, 20, '1.0.0')
    expect(placement.detection).toBe('applied-placement')
    const row = edgeRows(db, scope.attemptId).find((edge) => edge.edgeKey === editorialKey)
    expect(row?.isTemplate).toBe(false)
    // Only that one row moved: the rest of the nav mesh is still chrome.
    expect(placement.templateEdgeCount).toBe(ubiquity.templateEdgeCount - 1)
  })

  it('falls back to ubiquity for links the page says nothing about', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    stampPlacement(db, scope.attemptId, { 'nav:page-05->about': { navigation: 0, content: 0, unknown: 1 } })

    const result = classifySiteCrawlTemplateLinks(db, scope, 20, '1.0.0')
    expect(result.detection).toBe('applied-placement-with-ubiquity')

    const silent = edgeRows(db, scope.attemptId).find((row) => row.edgeKey === 'nav:page-05->about')
    // Every page carries this pair, so the fallback still calls it chrome, and
    // it persists the ratio that decided it.
    expect(silent?.isTemplate).toBe(true)
    expect(silent?.templateRatio).toBe(1)
  })

  it('never writes a NULL is_template, so every reader keeps one definition of a content link', () => {
    // Below the page floor the fallback is unavailable, so a link the page said
    // nothing about has no evidence behind it. It is still written as a real
    // `false`. A NULL here would be invisible to the layout input, the graph
    // sample, the totals, the map legend, and the inspector tiles, all of which
    // read `is_template` as a boolean, and it would be excluded by only the two
    // SQL link filters. That disagreement is the defect this shape prevents.
    const db = freshDb()
    const scope = seedCrawl(db, 4)
    stampPlacement(db, scope.attemptId, { 'nav:page-01->about': { navigation: 0, content: 0, unknown: 3 } })

    const result = classifySiteCrawlTemplateLinks(db, scope, 4, '1.0.0')
    expect(result.detection).toBe('applied-placement-partial')

    const rows = edgeRows(db, scope.attemptId)
    expect(rows.every((row) => typeof row.isTemplate === 'boolean')).toBe(true)
    expect(rows.find((row) => row.edgeKey === 'nav:page-01->about')?.isTemplate).toBe(false)
    // Everything the DOM did answer for is still classified normally, which is
    // the whole point: placement has no page floor.
    expect(rows.filter((row) => row.isTemplate === true).length).toBeGreaterThan(0)
    expect(rows.filter((row) => row.isTemplate === false).length).toBeGreaterThan(0)
    // The template + content split accounts for every stored link, exactly.
    expect(rows.filter((row) => row.isTemplate).length + rows.filter((row) => !row.isTemplate).length)
      .toBe(rows.length)
  })

  it('a redirect edge does not make a well-marked-up small site report missing landmarks', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 8)
    stampPlacement(db, scope.attemptId)
    const now = new Date().toISOString()
    db.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId: scope.projectId, runId: scope.runId, attemptId: scope.attemptId,
      edgeKey: 'redirect:page-00', sourceNodeKey: 'page-00', sourceUrl: 'https://example.com/page-00',
      targetNodeKey: null, targetUrl: 'https://example.com/moved',
      relation: 'redirect', internal: true, followable: true,
      occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchors: [],
      placementNavigationOccurrences: 0, placementContentOccurrences: 0, placementUnknownOccurrences: 0,
      createdAt: now, updatedAt: now,
    }).run()

    // Every ANCHOR link on this site is answered by its landmarks. The redirect
    // carries no placement by construction and must not be read as evidence
    // that a page is missing markup.
    const result = classifySiteCrawlTemplateLinks(db, scope, 8, '1.0.0')
    expect(result.detection).toBe('applied-placement')
  })

  it('is idempotent under placement, including the unclassified rows', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 4)
    stampPlacement(db, scope.attemptId, { 'nav:page-01->about': { navigation: 0, content: 0, unknown: 3 } })

    const first = classifySiteCrawlTemplateLinks(db, scope, 4, '1.0.0')
    const firstRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])
    const second = classifySiteCrawlTemplateLinks(db, scope, 4, '1.0.0')
    const secondRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])

    expect(second).toEqual(first)
    expect(secondRows).toEqual(firstRows)
  })

  it('re-running a legacy scan under placement changes which edges reach the physics', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    classifySiteCrawlTemplateLinks(db, scope, 20, null)
    const underUbiquity = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })

    stampPlacement(db, scope.attemptId, { 'nav:page-03->services': { navigation: 1, content: 1, unknown: 0 } })
    classifySiteCrawlTemplateLinks(db, scope, 20, '1.0.0')
    const underPlacement = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (underUbiquity.state !== 'ready' || underPlacement.state !== 'ready') throw new Error('expected ready layouts')

    // One more link now enters the ForceAtlas2 input, so stored coordinates
    // from the old rule are not valid seeds. That is what the algorithm version
    // bump exists to prevent.
    expect(underPlacement.totalTemplateEdges).toBe(underUbiquity.totalTemplateEdges - 1)
    expect(underPlacement.nodes).not.toEqual(underUbiquity.nodes)
  })
})
