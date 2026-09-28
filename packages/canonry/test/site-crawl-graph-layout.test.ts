import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import {
  SITE_CRAWL_GRAPH_LAYOUT_VERSION,
  SITE_CRAWL_GRAPH_SEED_SCALE,
  adaptiveForceAtlasIterations,
  layoutSiteCrawlGraphInput,
  noverlapGridSize,
  noverlapMaxIterations,
  packSiteCrawlGraphComponents,
  prepareSiteCrawlGraphLayout,
  seedSiteCrawlGraphNodes,
  siteCrawlGraphComponents,
  siteCrawlGraphExtent,
  siteCrawlGraphLayoutSettingsFingerprint,
  siteCrawlGraphNodeSize,
  type SiteCrawlGraphLayoutInput,
} from '../src/site-crawl-graph-layout.js'

/**
 * A navigation mesh: every page carries a 25-link template header, so almost
 * every page links to almost every other one. This is what a real 50-page site
 * looks like, and it is exactly the shape that collapses into a single blob
 * under linear attraction.
 */
const NAV_MESH_SECTIONS = ['services', 'blog', 'about'] as const
const NAV_MESH_PER_SECTION = 16

function navMeshFixture(): SiteCrawlGraphLayoutInput {
  const nodes = [{ nodeKey: 'home', path: '/', depth: 0, sampleRank: 0 }]
  for (const [sectionIndex, section] of NAV_MESH_SECTIONS.entries()) {
    for (let i = 0; i < NAV_MESH_PER_SECTION; i++) {
      nodes.push({
        nodeKey: `${section}-${String(i).padStart(2, '0')}`,
        path: `/${section}/page-${i}`,
        depth: 2,
        sampleRank: 1 + sectionIndex * NAV_MESH_PER_SECTION + i,
      })
    }
  }
  const template = ['home', ...NAV_MESH_SECTIONS.flatMap((section) => (
    Array.from({ length: 8 }, (_, i) => `${section}-${String(i).padStart(2, '0')}`)
  ))]
  const edges = []
  for (const node of nodes) {
    for (const target of template) {
      if (target === node.nodeKey) continue
      edges.push({
        edgeKey: `nav:${node.nodeKey}->${target}`,
        sourceNodeKey: node.nodeKey,
        targetNodeKey: target,
        followable: true,
        occurrences: 1,
      })
    }
  }
  // In-section editorial links are the only community signal in the graph.
  for (const section of NAV_MESH_SECTIONS) {
    for (let i = 0; i < NAV_MESH_PER_SECTION; i++) {
      const from = `${section}-${String(i).padStart(2, '0')}`
      const to = `${section}-${String((i + 1) % NAV_MESH_PER_SECTION).padStart(2, '0')}`
      edges.push({ edgeKey: `ed:${from}->${to}`, sourceNodeKey: from, targetNodeKey: to, followable: true, occurrences: 1 })
    }
  }
  return { rootNodeKey: 'home', totalNodes: nodes.length, totalEdges: edges.length, nodes, edges }
}

function sectionSeparationRatio(positions: ReadonlyArray<{ nodeKey: string; x: number; y: number }>): number {
  const centroids = new Map<string, [number, number]>()
  const radii = new Map<string, number>()
  for (const section of NAV_MESH_SECTIONS) {
    const points = positions.filter((position) => position.nodeKey.startsWith(`${section}-`))
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length
    centroids.set(section, [cx, cy])
    radii.set(section, points.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / points.length)
  }
  let minInterCentroid = Infinity
  for (let i = 0; i < NAV_MESH_SECTIONS.length; i++) {
    for (let j = i + 1; j < NAV_MESH_SECTIONS.length; j++) {
      const [ax, ay] = centroids.get(NAV_MESH_SECTIONS[i]!)!
      const [bx, by] = centroids.get(NAV_MESH_SECTIONS[j]!)!
      minInterCentroid = Math.min(minInterCentroid, Math.hypot(ax - bx, ay - by))
    }
  }
  const meanRadius = [...radii.values()].reduce((sum, r) => sum + r, 0) / radii.size
  return minInterCentroid / meanRadius
}

function minPairwiseDistance(positions: ReadonlyArray<{ x: number; y: number }>): number {
  let min = Infinity
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      min = Math.min(min, Math.hypot(positions[i]!.x - positions[j]!.x, positions[i]!.y - positions[j]!.y))
    }
  }
  return min
}

const input: SiteCrawlGraphLayoutInput = {
  rootNodeKey: 'home',
  totalNodes: 4,
  totalEdges: 3,
  nodes: [
    { nodeKey: 'home', path: '/', depth: 0, sampleRank: 0 },
    { nodeKey: 'services-a', path: '/services/a', depth: 2, sampleRank: 1 },
    { nodeKey: 'services-b', path: '/services/b', depth: 2, sampleRank: 2 },
    { nodeKey: 'blog-a', path: '/blog/a', depth: 2, sampleRank: 3 },
  ],
  edges: [
    { edgeKey: 'home-services', sourceNodeKey: 'home', targetNodeKey: 'services-a', followable: true, occurrences: 2 },
    { edgeKey: 'services-sibling', sourceNodeKey: 'services-a', targetNodeKey: 'services-b', followable: true, occurrences: 1 },
    { edgeKey: 'home-blog', sourceNodeKey: 'home', targetNodeKey: 'blog-a', followable: false, occurrences: 1 },
  ],
}

describe('site crawl graph layout', () => {
  it('seeds home centrally and keeps pages in the same path section clustered', () => {
    const first = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey)
    const second = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey)
    expect(second).toEqual(first)
    expect(first.find((node) => node.nodeKey === 'home')).toMatchObject({ x: 0, y: 0 })

    const byKey = new Map(first.map((node) => [node.nodeKey, node]))
    const distance = (a: string, b: string) => Math.hypot(byKey.get(a)!.x - byKey.get(b)!.x, byKey.get(a)!.y - byKey.get(b)!.y)
    expect(distance('services-a', 'services-b')).toBeLessThan(distance('services-a', 'blog-a'))
  })

  it('reuses prior normalized coordinates for surviving node keys and hash-seeds only new nodes', () => {
    const priorPositions = new Map([
      ['home', { x: 0, y: 0 }],
      ['services-a', { x: 0.42, y: -0.31 }],
    ])

    const seeded = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey, priorPositions)
    const byKey = new Map(seeded.map((node) => [node.nodeKey, node]))

    // Persisted coordinates are normalized to [-1, 1], while fresh hash seeds
    // use the ForceAtlas-scale coordinate space. Reusing the old point at that
    // scale keeps surviving pages spatially anchored across snapshots.
    expect(byKey.get('home')).toMatchObject({ x: 0, y: 0 })
    expect(byKey.get('services-a')).toMatchObject({ x: 42, y: -31 })
    expect(byKey.get('services-b')).not.toMatchObject({ x: 42, y: -31 })
  })

  it('pins an adaptive upper bound for the 20k-node publish cap', () => {
    expect(adaptiveForceAtlasIterations(100, 200)).toBeGreaterThan(adaptiveForceAtlasIterations(20_000, 50_000))
    expect(adaptiveForceAtlasIterations(20_000, 50_000)).toBeLessThanOrEqual(8)
    expect(adaptiveForceAtlasIterations(20_000, 50_000)).toBeGreaterThan(0)
  })

  it('normalizes persisted coordinates around home and records the pinned layout version', async () => {
    const result = await layoutSiteCrawlGraphInput(input, {
      computePositions: async ({ nodes }) => ({
        positions: nodes.map((node) => ({ nodeKey: node.nodeKey, x: node.x + 50, y: node.y - 30 })),
        nodeSize: 1,
      }),
    })
    expect(result).toMatchObject({
      state: 'ready',
      layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION,
      totalNodes: 4,
      totalEdges: 3,
      edgeCount: 3,
    })
    if (result.state !== 'ready') throw new Error('expected ready layout')
    expect(result.nodes.find((node) => node.nodeKey === 'home')).toMatchObject({ x: 0, y: 0 })
    expect(result.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })

  it('is deterministic through the real ForceAtlas2 worker', async () => {
    const first = await layoutSiteCrawlGraphInput(input)
    const second = await layoutSiteCrawlGraphInput(input)

    expect(second).toEqual(first)
  })

  it('is deterministic through the whole pipeline, including anti-overlap and framing', async () => {
    // The sparse fixture above never exercises noverlap (it converges on the
    // first pass) or the framing pass. This one is dense enough to run every
    // stage, so any nondeterminism introduced by them shows up here.
    const dense: SiteCrawlGraphLayoutInput = {
      ...navMeshFixture(),
      nodes: [...navMeshFixture().nodes, { nodeKey: 'orphan', path: '/orphan', depth: null, sampleRank: 99 }],
    }
    const first = await layoutSiteCrawlGraphInput(dense)
    const second = await layoutSiteCrawlGraphInput(dense)

    expect(first.state).toBe('ready')
    expect(second).toEqual(first)
  })

  it('separates top-level sections on a dense navigation mesh instead of one blob', async () => {
    const result = await layoutSiteCrawlGraphInput(navMeshFixture())
    if (result.state !== 'ready') throw new Error('expected ready layout')

    // Sections must sit further apart than they are wide. Under the previous
    // linear-attraction settings this fixture measured about 0.84: the
    // sections overlapped each other completely.
    expect(sectionSeparationRatio(result.nodes)).toBeGreaterThan(1)

    // Anti-overlap ran: no two pages share a point, and the closest pair is
    // still a visible distance apart in the normalized [-1, 1] space.
    expect(minPairwiseDistance(result.nodes)).toBeGreaterThan(0.01)

    // The graph fills the frame rather than sitting as a dot in empty space.
    const spread = (values: number[]) => {
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length
      return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length)
    }
    expect(spread(result.nodes.map((node) => node.x))).toBeGreaterThan(0.15)
    expect(spread(result.nodes.map((node) => node.y))).toBeGreaterThan(0.15)
  })

  it('keeps prior-seeded coordinates flowing through the new pipeline', async () => {
    const priorPositions = new Map([['home', { x: 0, y: 0 }], ['services-00', { x: 0.4, y: -0.2 }]])
    const result = await layoutSiteCrawlGraphInput({ ...navMeshFixture(), priorPositions })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready layout')
    expect(result.nodes).toHaveLength(navMeshFixture().nodes.length)
    expect(result.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })

  it('degrades to unavailable when layout physics fails', async () => {
    const result = await layoutSiteCrawlGraphInput(input, {
      computePositions: async () => { throw new Error('worker stopped') },
    })
    expect(result).toEqual({
      state: 'unavailable',
      failureCode: 'layout-error',
      totalNodes: 4,
      totalEdges: 3,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    })
  })

  it('samples root and depth-zero first, then link score with stable ties, and excludes dangling edges', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-graph-layout-order-'))
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = '2026-08-09T12:00:00.000Z'
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'layout-order', displayName: 'Layout order', canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now }).run()
    db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId, runId, attemptNumber: 1, state: 'running', createdAt: now, updatedAt: now,
    }).run()
    const pages = [
      { nodeKey: 'root', url: 'https://example.com/', path: '/', depth: 3, linkScoreNormalized: 1 },
      { nodeKey: 'depth-zero', url: 'https://example.com/start', path: '/start', depth: 0, linkScoreNormalized: 2 },
      { nodeKey: 'alpha', url: 'https://example.com/a', path: '/a', depth: 1, linkScoreNormalized: 90 },
      { nodeKey: 'beta', url: 'https://example.com/b', path: '/b', depth: 1, linkScoreNormalized: 90 },
      { nodeKey: 'low', url: 'https://example.com/low', path: '/low', depth: 1, linkScoreNormalized: 10 },
    ]
    db.insert(siteCrawlPages).values(pages.map((page) => ({
      id: crypto.randomUUID(), projectId, runId, attemptId, parentPath: '/', discoverySource: 'link',
      fetchState: 'fetched', indexabilityState: 'eligible', auditState: 'complete', inventoryEligible: true,
      createdAt: now, updatedAt: now, ...page,
    }))).run()
    db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'beta-root',
        sourceNodeKey: 'beta', sourceUrl: 'https://example.com/b', targetNodeKey: 'root', targetUrl: 'https://example.com/',
        relation: 'anchor', internal: true, followable: true, occurrences: 4, followableOccurrences: 4, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'root-alpha',
        sourceNodeKey: 'root', sourceUrl: 'https://example.com/', targetNodeKey: 'alpha', targetUrl: 'https://example.com/a',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'root-missing',
        sourceNodeKey: 'root', sourceUrl: 'https://example.com/', targetNodeKey: 'missing', targetUrl: 'https://example.com/missing',
        relation: 'anchor', internal: true, followable: true, occurrences: 99, followableOccurrences: 99, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
    ]).run()

    const result = await prepareSiteCrawlGraphLayout(db, {
      projectId, runId, attemptId, rootUrl: 'https://example.com/',
    })
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready layout')
    expect(result.nodes.map((node) => node.nodeKey)).toEqual(['root', 'depth-zero', 'alpha', 'beta', 'low'])
    expect(result.edges.map((edge) => edge.edgeKey)).toEqual(['beta-root', 'root-alpha'])
    expect(result.totalEdges).toBe(2)

    const queryPlan = db.all(sql`
      EXPLAIN QUERY PLAN
      WITH selected(node_key) AS (SELECT value FROM json_each(${JSON.stringify(pages.map((page) => page.nodeKey))}))
      SELECT edge.edge_key
      FROM site_crawl_edges AS edge
      INNER JOIN selected AS source ON source.node_key = edge.source_node_key
      INNER JOIN selected AS target ON target.node_key = edge.target_node_key
      WHERE edge.project_id = ${projectId}
        AND edge.run_id = ${runId}
        AND edge.attempt_id = ${attemptId}
        AND edge.internal = 1
        AND edge.relation = 'anchor'
      ORDER BY edge.occurrences DESC, edge.edge_key ASC
      LIMIT ${50_000}
    `) as Array<{ detail: string }>
    expect(queryPlan.some((step) => step.detail.includes('idx_site_crawl_edges_graph_sample'))).toBe(true)
    expect(queryPlan.some((step) => step.detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false)

    let checkpoints = 0
    const checkpointSignal = {
      throwIfAborted() {
        checkpoints += 1
        if (checkpoints === 4) throw new DOMException('stop before page sampling', 'AbortError')
      },
    } as AbortSignal
    await expect(prepareSiteCrawlGraphLayout(db, {
      projectId, runId, attemptId, rootUrl: 'https://example.com/',
    }, { signal: checkpointSignal })).rejects.toThrow('stop before page sampling')
    expect(checkpoints).toBe(4)

    vi.spyOn(db, 'all').mockImplementationOnce(() => {
      throw new Error('edge sample query failed')
    })
    await expect(prepareSiteCrawlGraphLayout(db, {
      projectId, runId, attemptId, rootUrl: 'https://example.com/',
    })).resolves.toMatchObject({
      state: 'unavailable',
      failureCode: 'layout-error',
      totalNodes: 5,
      totalEdges: 2,
    })
  })

  it('loads surviving coordinates from the latest compatible complete snapshot', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-graph-layout-prior-'))
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = '2026-08-09T12:00:00.000Z'
    const projectId = crypto.randomUUID()
    const priorRunId = crypto.randomUUID()
    const priorAttemptId = crypto.randomUUID()
    const currentRunId = crypto.randomUUID()
    const currentAttemptId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'layout-prior', displayName: 'Layout prior', canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values([
      { id: priorRunId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: '2026-08-08T12:00:00.000Z' },
      { id: currentRunId, projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now },
    ]).run()
    db.insert(siteCrawlAttempts).values([
      { id: priorAttemptId, projectId, runId: priorRunId, attemptNumber: 1, state: 'completed', createdAt: '2026-08-08T12:00:00.000Z', updatedAt: '2026-08-08T12:00:00.000Z' },
      { id: currentAttemptId, projectId, runId: currentRunId, attemptNumber: 1, state: 'running', createdAt: now, updatedAt: now },
    ]).run()
    const pageValues = (runId: string, attemptId: string, nodeKey: string, url: string, pathName: string) => ({
      id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey, url, path: pathName, parentPath: '/', discoverySource: 'link',
      fetchState: 'fetched', indexabilityState: 'eligible', auditState: 'complete', inventoryEligible: true,
      depth: nodeKey === 'root' ? 0 : 1, linkScoreNormalized: nodeKey === 'new' ? 80 : 90,
      createdAt: now, updatedAt: now,
    })
    db.insert(siteCrawlPages).values([
      pageValues(priorRunId, priorAttemptId, 'root', 'https://example.com/', '/'),
      pageValues(priorRunId, priorAttemptId, 'existing', 'https://example.com/existing', '/existing'),
      pageValues(currentRunId, currentAttemptId, 'root', 'https://example.com/', '/'),
      pageValues(currentRunId, currentAttemptId, 'existing', 'https://example.com/existing', '/existing'),
      pageValues(currentRunId, currentAttemptId, 'new', 'https://example.com/new', '/new'),
    ]).run()
    db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: priorRunId, attemptId: priorAttemptId,
      rootUrl: 'https://example.com/', complete: true, detailsAvailable: true,
      createdAt: '2026-08-08T12:00:00.000Z', updatedAt: '2026-08-08T12:00:00.000Z',
    }).run()
    db.insert(siteCrawlGraphLayouts).values({
      id: crypto.randomUUID(), projectId, runId: priorRunId, attemptId: priorAttemptId,
      state: 'ready', layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION,
      totalNodes: 2, totalEdges: 1, nodeCount: 2, edgeCount: 1, createdAt: now, updatedAt: now,
    }).run()
    db.insert(siteCrawlGraphNodes).values([
      { id: crypto.randomUUID(), projectId, runId: priorRunId, attemptId: priorAttemptId, nodeKey: 'root', sampleRank: 0, x: 0, y: 0, createdAt: now },
      { id: crypto.randomUUID(), projectId, runId: priorRunId, attemptId: priorAttemptId, nodeKey: 'existing', sampleRank: 1, x: 0.42, y: -0.31, createdAt: now },
    ]).run()
    db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId, runId: currentRunId, attemptId: currentAttemptId, edgeKey: 'root-existing',
        sourceNodeKey: 'root', sourceUrl: 'https://example.com/', targetNodeKey: 'existing', targetUrl: 'https://example.com/existing',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
    ]).run()

    let seededNodes: Array<{ nodeKey: string; x: number; y: number }> = []
    const result = await prepareSiteCrawlGraphLayout(db, {
      projectId, runId: currentRunId, attemptId: currentAttemptId, rootUrl: 'https://example.com/',
    }, {
      computePositions: async ({ nodes }) => {
        seededNodes = nodes
        return { positions: nodes, nodeSize: 1 }
      },
    })

    expect(result.state).toBe('ready')
    expect(seededNodes.find((node) => node.nodeKey === 'existing')).toMatchObject({
      x: 0.42 * SITE_CRAWL_GRAPH_SEED_SCALE,
      y: -0.31 * SITE_CRAWL_GRAPH_SEED_SCALE,
    })
    expect(seededNodes.find((node) => node.nodeKey === 'new')).not.toMatchObject({
      x: 0.42 * SITE_CRAWL_GRAPH_SEED_SCALE,
      y: -0.31 * SITE_CRAWL_GRAPH_SEED_SCALE,
    })
  })

  it('groups nodes into components, largest first, deterministically', () => {
    const components = siteCrawlGraphComponents(
      ['a', 'b', 'c', 'orphan-1', 'orphan-2', 'pair-x', 'pair-y'],
      [
        { sourceNodeKey: 'a', targetNodeKey: 'b' },
        { sourceNodeKey: 'b', targetNodeKey: 'c' },
        { sourceNodeKey: 'pair-x', targetNodeKey: 'pair-y' },
        // An edge naming a node outside the sample must not invent one.
        { sourceNodeKey: 'a', targetNodeKey: 'not-sampled' },
      ],
    )

    expect(components).toEqual([
      ['a', 'b', 'c'],
      ['pair-x', 'pair-y'],
      ['orphan-1'],
      ['orphan-2'],
    ])
  })

  it('moves each component as a rigid body, so no layout inside one is disturbed', () => {
    // ForceAtlas2 has nothing holding separate components together, so they
    // drift arbitrarily far apart.
    const positions = [
      { nodeKey: 'a', x: -10, y: 0 },
      { nodeKey: 'b', x: 10, y: 0 },
      { nodeKey: 'c', x: 0, y: 10 },
      { nodeKey: 'pair-x', x: 9_000, y: -4_000 },
      { nodeKey: 'pair-y', x: 9_001, y: -4_000 },
      { nodeKey: 'orphan', x: -7_500, y: 8_100 },
    ]
    const edges = [
      { sourceNodeKey: 'a', targetNodeKey: 'b' },
      { sourceNodeKey: 'b', targetNodeKey: 'c' },
      { sourceNodeKey: 'pair-x', targetNodeKey: 'pair-y' },
    ]
    const distance = (points: ReadonlyArray<{ nodeKey: string; x: number; y: number }>, left: string, right: string) => {
      const a = points.find((point) => point.nodeKey === left)!
      const b = points.find((point) => point.nodeKey === right)!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }

    const packed = packSiteCrawlGraphComponents(positions, edges, 4)

    // The connected pair keeps its exact internal distance: it was translated,
    // never spread. This is the regression the ring placement caused.
    expect(distance(packed, 'pair-x', 'pair-y')).toBeCloseTo(distance(positions, 'pair-x', 'pair-y'), 9)
    expect(distance(packed, 'pair-x', 'pair-y')).toBeCloseTo(1, 9)
    // The main component is the anchor and does not move at all.
    for (const nodeKey of ['a', 'b', 'c']) {
      expect(packed.find((point) => point.nodeKey === nodeKey))
        .toEqual(positions.find((point) => point.nodeKey === nodeKey))
    }
    // Every intra-component distance in the main component is untouched too.
    expect(distance(packed, 'a', 'b')).toBeCloseTo(distance(positions, 'a', 'b'), 9)

    // The far-flung components are brought in beside the anchor.
    const anchorRadius = Math.max(distance(packed, 'a', 'b'), distance(packed, 'a', 'c')) / 2
    for (const nodeKey of ['pair-x', 'pair-y', 'orphan']) {
      const point = packed.find((candidate) => candidate.nodeKey === nodeKey)!
      expect(Math.hypot(point.x, point.y - 10 / 3)).toBeLessThan(anchorRadius * 12)
    }

    expect(packSiteCrawlGraphComponents(positions, edges, 4)).toEqual(packed)
  })

  it('spaces an edgeless crawl on a grid instead of stacking it in one place', () => {
    // 20,000 pages and no internal anchor links is a real crawl shape, and it
    // is 20,000 singleton components. Every one must still be its own dot.
    const nodeCount = 20_000
    const positions = Array.from({ length: nodeCount }, (_, index) => ({
      nodeKey: `n${String(index).padStart(5, '0')}`,
      // Deliberately degenerate: the seeds put many pages on the same point.
      x: (index % 7) * 0.001,
      y: Math.floor(index / 7) * 0.001,
    }))
    const nodeSize = 3
    const packed = packSiteCrawlGraphComponents(positions, [], nodeSize)

    const byKey = new Map(packed.map((point) => [point.nodeKey, point]))
    expect(byKey.size).toBe(nodeCount)
    // Nearest-neighbour check over a grid bucket rather than 200m pairs.
    const bucket = new Map<string, Array<{ x: number; y: number }>>()
    const cell = nodeSize * 4
    for (const point of packed) {
      const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
      const list = bucket.get(key)
      if (list) list.push(point)
      else bucket.set(key, [point])
    }
    let minimum = Infinity
    for (const point of packed) {
      const cx = Math.floor(point.x / cell)
      const cy = Math.floor(point.y / cell)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of bucket.get(`${cx + dx}:${cy + dy}`) ?? []) {
            if (other === point) continue
            minimum = Math.min(minimum, Math.hypot(point.x - other.x, point.y - other.y))
          }
        }
      }
    }
    expect(minimum).toBeGreaterThanOrEqual(nodeSize)
  })

  it('leaves a fully connected graph exactly where the physics put it', () => {
    const positions = [{ nodeKey: 'a', x: 1, y: 2 }, { nodeKey: 'b', x: 3, y: 4 }]
    expect(packSiteCrawlGraphComponents(positions, [{ sourceNodeKey: 'a', targetNodeKey: 'b' }], 4))
      .toEqual(positions)
  })

  it('derives one node size that the worker and the packing pass share', async () => {
    // The worker computes the size inline (it is a string module) and returns
    // it. This pins the exported rule to what the worker actually used, so the
    // two can never drift into spacing the graph by different numbers.
    const fixture = navMeshFixture()
    const result = await layoutSiteCrawlGraphInput(fixture)
    if (result.state !== 'ready') throw new Error('expected ready layout')

    expect(siteCrawlGraphNodeSize(0, 10)).toBe(0)
    expect(siteCrawlGraphNodeSize(100, 0)).toBe(0)
    // The area bound binds on a crowded graph; the render bound on a sparse one.
    expect(siteCrawlGraphNodeSize(1_000, 20_000)).toBeLessThan(siteCrawlGraphNodeSize(1_000, 10))
    expect(siteCrawlGraphExtent([{ x: -3, y: 0 }, { x: 3, y: 0 }])).toBeCloseTo(3, 9)
  })

  it('keeps the packed bounding box tight enough for camera fit to frame the site', async () => {
    // Observed on canonry.ai: two disconnected pages landed so far out that
    // the camera fit shrank the whole connected site into a corner. The frame
    // is set by the bounding box, so the box itself has to stay tight.
    const base = navMeshFixture()
    const withOrphans: SiteCrawlGraphLayoutInput = {
      ...base,
      nodes: [
        ...base.nodes,
        { nodeKey: 'orphan-a', path: '/orphan-a', depth: null, sampleRank: 900 },
        { nodeKey: 'orphan-b', path: '/orphan-b', depth: null, sampleRank: 901 },
      ],
    }
    const result = await layoutSiteCrawlGraphInput(withOrphans)
    if (result.state !== 'ready') throw new Error('expected ready layout')

    const connected = result.nodes.filter((node) => !node.nodeKey.startsWith('orphan-'))
    const span = (points: typeof result.nodes) => {
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    }

    // The full frame is only slightly larger than the connected site's own
    // box, so fitting the camera still fills the canvas with the real graph.
    expect(span(result.nodes)).toBeLessThan(span(connected) * 2.5)
    // And the orphans are genuinely outside it, not hidden inside the mesh.
    const orphans = result.nodes.filter((node) => node.nodeKey.startsWith('orphan-'))
    expect(orphans).toHaveLength(2)
    expect(orphans[0]!.x).not.toBe(orphans[1]!.x)
  })

  it('bounds the anti-overlap budget so the 20k cap stays solvable', () => {
    expect(noverlapGridSize(49)).toBe(10)
    expect(noverlapGridSize(20_000)).toBe(142)
    // A fixed grid degenerates to a quadratic scan at the cap.
    expect(noverlapGridSize(20_000)).toBeGreaterThan(noverlapGridSize(500))
    expect(noverlapGridSize(1_000_000)).toBeLessThanOrEqual(200)

    expect(noverlapMaxIterations(49)).toBe(120)
    expect(noverlapMaxIterations(1_000)).toBe(120)
    expect(noverlapMaxIterations(5_000)).toBe(60)
    expect(noverlapMaxIterations(20_000)).toBe(20)
    expect(noverlapMaxIterations(20_000)).toBeLessThan(noverlapMaxIterations(49))
  })

  it('fingerprints the physics settings into the layout version', () => {
    // v5: the template rule that decides which edges enter the physics changed
    // again, from repetition across pages to where each link sits in the page,
    // so v4 coordinates are not valid seeds for this solve. The settings
    // fingerprint cannot catch a rule change, which is why the algorithm name
    // carries it.
    expect(SITE_CRAWL_GRAPH_LAYOUT_VERSION).toMatch(/^site-health-fa2-v5-[0-9a-f]{8}$/)

    // The fingerprint is what stops positions produced by one set of physics
    // being reused as seeds under another: `loadPriorSiteCrawlGraphPositions`
    // matches this exact string.
    const fingerprint = siteCrawlGraphLayoutSettingsFingerprint({ gravity: 0.2 })
    expect(fingerprint).toHaveLength(8)
    expect(siteCrawlGraphLayoutSettingsFingerprint({ gravity: 0.2 })).toBe(fingerprint)
    expect(siteCrawlGraphLayoutSettingsFingerprint({ gravity: 1 })).not.toBe(fingerprint)
  })
})
