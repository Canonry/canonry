import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { TEMPLATE_LINK_MIN_FETCHED_PAGES } from '@canonry/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '../src/index.js'
import { backfillSiteCrawlTemplateLinks } from '../src/migrate.js'

// v131 classifies each stored scan's links as nav/header/footer chrome or
// content. Everything it needs is already persisted (anchors, node keys, and
// the attempt's fetched-page count), so an existing install gains the filter
// without re-crawling. It deliberately does NOT rewrite published layout
// coordinates, and the layout row records that.

const NAV_TARGETS = ['services', 'pricing', 'about'] as const

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-template-links-migration-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

/** A crawl as it looked before v131: links stored, nothing classified. */
function seedLegacyCrawl(db: ReturnType<typeof createClient>, pageCount: number) {
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
  db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId, runId, attemptId,
    rootUrl: 'https://example.com/', complete: true, detailsAvailable: true,
    pagesFetched: pageCount, createdAt: now, updatedAt: now,
  }).run()

  const sources = Array.from({ length: pageCount }, (_, index) => `page-${String(index).padStart(2, '0')}`)
  const nodeKeys = [...sources, ...NAV_TARGETS, ...sources.map((source) => `guide-${source}`)]
  db.insert(siteCrawlPages).values(nodeKeys.map((nodeKey) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey,
    url: `https://example.com/${nodeKey}`, path: `/${nodeKey}`, parentPath: '/',
    discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable',
    healthState: 'eligible', auditState: 'complete', inventoryEligible: true, depth: 1,
    createdAt: now, updatedAt: now,
  }))).run()

  const edges = []
  for (const source of sources) {
    for (const target of NAV_TARGETS) {
      edges.push({
        id: crypto.randomUUID(), projectId, runId, attemptId,
        edgeKey: `nav:${source}->${target}`,
        sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
        targetNodeKey: target, targetUrl: `https://example.com/${target}`,
        relation: 'anchor', internal: true, followable: true,
        occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [target], createdAt: now, updatedAt: now,
      })
    }
    edges.push({
      id: crypto.randomUUID(), projectId, runId, attemptId,
      edgeKey: `body:${source}->guide`,
      sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
      targetNodeKey: `guide-${source}`, targetUrl: `https://example.com/guide-${source}`,
      relation: 'anchor', internal: true, followable: true,
      occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: [`read the ${source} guide`], createdAt: now, updatedAt: now,
    })
  }
  db.insert(siteCrawlEdges).values(edges).run()

  // A published layout from before the split: coordinates exist, and it must
  // stay marked as NOT having excluded template links.
  db.insert(siteCrawlGraphLayouts).values({
    id: crypto.randomUUID(), projectId, runId, attemptId, state: 'ready',
    layoutVersion: 'site-health-fa2-v2-deadbeef',
    totalNodes: nodeKeys.length, totalEdges: edges.length,
    nodeCount: nodeKeys.length, edgeCount: edges.length,
    createdAt: now, updatedAt: now,
  }).run()
  db.insert(siteCrawlGraphNodes).values(nodeKeys.map((nodeKey, sampleRank) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey, sampleRank,
    x: sampleRank / 100, y: 0, createdAt: now,
  }))).run()
  db.insert(siteCrawlGraphEdges).values(edges.map((edge, sampleRank) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: edge.edgeKey, sampleRank,
    sourceNodeKey: edge.sourceNodeKey, targetNodeKey: edge.targetNodeKey,
    followable: true, occurrences: 1, createdAt: now,
  }))).run()

  // Exactly the pre-v131 state: the columns exist but were never written.
  db.run(sql`UPDATE site_crawl_edges SET is_template = NULL, template_ratio = NULL`)
  db.run(sql`UPDATE site_crawl_graph_edges SET is_template = 0`)
  db.run(sql`UPDATE site_crawl_snapshots SET template_detection = NULL`)
  return { projectId, runId, attemptId, edgeCount: edges.length, navEdgeCount: sources.length * NAV_TARGETS.length }
}

test('classifies every stored link from rows the crawl already persisted', () => {
  const db = freshDb()
  const seeded = seedLegacyCrawl(db, 20)

  const before = db.all(sql`SELECT count(*) AS n FROM site_crawl_edges WHERE is_template IS NULL`) as Array<{ n: number }>
  expect(before[0]!.n).toBe(seeded.edgeCount)

  backfillSiteCrawlTemplateLinks(db)

  const rows = db.select().from(siteCrawlEdges).all()
  expect(rows.every((row) => row.isTemplate !== null)).toBe(true)
  expect(rows.filter((row) => row.isTemplate)).toHaveLength(seeded.navEdgeCount)
  expect(rows.filter((row) => row.isTemplate).every((row) => row.edgeKey.startsWith('nav:'))).toBe(true)
  expect(rows.filter((row) => row.edgeKey.startsWith('body:')).every((row) => row.isTemplate === false)).toBe(true)

  const snapshot = db.select().from(siteCrawlSnapshots).get()
  expect(snapshot?.templateDetection).toBe('applied')

  // The bounded map sample carries the same decision, so a map read never
  // joins the full link table to learn it.
  const graphEdges = db.select().from(siteCrawlGraphEdges).all()
  expect(graphEdges.filter((row) => row.isTemplate)).toHaveLength(seeded.navEdgeCount)

  const layout = db.select().from(siteCrawlGraphLayouts).get()
  expect(layout?.totalTemplateEdges).toBe(seeded.navEdgeCount)
  // Positions were computed with the nav mesh in, and this migration does not
  // rewrite them. Saying so is what stops the map claiming otherwise.
  expect(layout?.templateLinksExcluded).toBe(false)
})

test('records why a small scan could not be classified instead of marking nothing silently', () => {
  const db = freshDb()
  seedLegacyCrawl(db, TEMPLATE_LINK_MIN_FETCHED_PAGES - 1)

  backfillSiteCrawlTemplateLinks(db)

  const rows = db.select().from(siteCrawlEdges).all()
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every((row) => row.isTemplate === false)).toBe(true)
  expect(rows.every((row) => row.templateRatio === null)).toBe(true)
  expect(db.select().from(siteCrawlSnapshots).get()?.templateDetection).toBe('unavailable-too-few-pages')
  expect(db.select().from(siteCrawlGraphLayouts).get()?.totalTemplateEdges).toBe(0)
})

test('is idempotent: a retried migration writes the same values', () => {
  const db = freshDb()
  seedLegacyCrawl(db, 20)

  backfillSiteCrawlTemplateLinks(db)
  const first = db.select().from(siteCrawlEdges).all()
    .map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])
    .sort()
  backfillSiteCrawlTemplateLinks(db)
  const second = db.select().from(siteCrawlEdges).all()
    .map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])
    .sort()

  expect(second).toEqual(first)
})

test('runs as part of migrate, so an existing install needs no manual step', () => {
  const db = freshDb()
  seedLegacyCrawl(db, 20)

  // v131 is already recorded on this fresh DB, so drive the backfill the way
  // the version does and assert the outcome an upgraded install sees.
  backfillSiteCrawlTemplateLinks(db)
  migrate(db)

  const remaining = db.all(sql`SELECT count(*) AS n FROM site_crawl_edges WHERE is_template IS NULL`) as Array<{ n: number }>
  expect(remaining[0]!.n).toBe(0)
  expect(db.select().from(siteCrawlSnapshots).get()?.templateDetection).toBe('applied')
})

test('keeps an in-prose link that shares a stored row with a nav link', () => {
  // The regression, end to end through persistence. One row aggregates every
  // anchor between the same two pages, so page-00's footer link to /services
  // and its in-prose link to /services are ONE row with two anchors. Reading
  // the row's most ubiquitous anchor gave it the nav ratio, so the editorial
  // link was marked chrome: hidden from the map, and absent from every content
  // count. A site whose footer reaches most pages has this on most of its
  // editorial links.
  const db = freshDb()
  const seeded = seedLegacyCrawl(db, 20)
  db.run(sql`
    UPDATE site_crawl_edges
    SET anchors = ${JSON.stringify(['services', 'why our roof crews book out'])}
    WHERE edge_key = 'nav:page-00->services'
  `)

  backfillSiteCrawlTemplateLinks(db)

  const mixed = db.select().from(siteCrawlEdges).where(sql`edge_key = 'nav:page-00->services'`).get()
  // 1 of 20 pages says "why our roof crews book out". That is what the row is
  // worth, and it is below the threshold, so the link is editorial.
  expect(mixed?.isTemplate).toBe(false)
  expect(mixed?.templateRatio).toBe(0.05)

  // The nav mesh does not come back with it: every other page links /services
  // with the nav anchor only, so those rows stay chrome. A page's link becomes
  // editorial only when that page really does link the target in its own words.
  const stillChrome = db.select().from(siteCrawlEdges).all()
    .filter((row) => row.edgeKey.startsWith('nav:') && row.edgeKey !== 'nav:page-00->services')
  expect(stillChrome).toHaveLength(seeded.navEdgeCount - 1)
  expect(stillChrome.every((row) => row.isTemplate === true)).toBe(true)

  // Every surface that reads the classification moves with it, so the map, the
  // link filters, and the totals cannot tell three different stories.
  const graphEdge = db.select().from(siteCrawlGraphEdges).where(sql`edge_key = 'nav:page-00->services'`).get()
  expect(graphEdge?.isTemplate).toBe(false)
  const layout = db.select().from(siteCrawlGraphLayouts).get()
  expect(layout?.totalTemplateEdges).toBe(seeded.navEdgeCount - 1)
})
