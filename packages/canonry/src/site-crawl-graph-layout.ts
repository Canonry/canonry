import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { and, asc, count, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  siteCrawlEdges,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import {
  SITE_CRAWL_GRAPH_MAX_EDGES,
  SITE_CRAWL_GRAPH_MAX_NODES,
  TEMPLATE_LINK_RATIO_THRESHOLD,
  compareText,
} from '@ainyc/canonry-contracts'

export const SITE_CRAWL_GRAPH_LAYOUT_TIMEOUT_MS = 15_000
/** Persisted points are normalized; fresh hash seeds occupy this FA2-scale space. */
export const SITE_CRAWL_GRAPH_SEED_SCALE = 100

export interface SiteCrawlGraphSeedNode {
  nodeKey: string
  path: string
  depth: number | null
  sampleRank: number
}

interface SeededGraphNode extends SiteCrawlGraphSeedNode {
  x: number
  y: number
}

export interface SiteCrawlGraphLayoutEdge {
  edgeKey: string
  sourceNodeKey: string
  targetNodeKey: string
  followable: boolean
  occurrences: number
  /**
   * Nav, header, and footer chrome. Template links are PUBLISHED in the sample
   * (a viewer can switch them on without a refetch) but are kept out of the
   * physics below, so positions describe content structure.
   */
  isTemplate: boolean
}

interface PersistedGraphEdge extends SiteCrawlGraphLayoutEdge {
  sampleRank: number
}

export interface SiteCrawlGraphLayoutInput {
  rootNodeKey: string | null
  totalNodes: number
  totalEdges: number
  /** Share of `totalEdges` classified as nav, header, or footer links. */
  totalTemplateEdges: number
  nodes: SiteCrawlGraphSeedNode[]
  edges: SiteCrawlGraphLayoutEdge[]
  /** Surviving nodes from the immediately prior compatible complete snapshot. */
  priorPositions?: ReadonlyMap<string, Pick<PersistedGraphPosition, 'x' | 'y'>>
}

export interface PersistedGraphPosition {
  nodeKey: string
  sampleRank: number
  x: number
  y: number
}

export type PreparedSiteCrawlGraphLayout =
  | {
    state: 'ready'
    layoutVersion: string
    totalNodes: number
    totalEdges: number
    totalTemplateEdges: number
    nodeCount: number
    edgeCount: number
    /** Always true for a layout this module computes; false only for older rows. */
    templateLinksExcluded: true
    nodes: PersistedGraphPosition[]
    edges: PersistedGraphEdge[]
  }
  | {
    state: 'unavailable'
    failureCode: 'empty-crawl' | 'layout-timeout' | 'layout-error'
    totalNodes: number
    totalEdges: number
    totalTemplateEdges: number
    nodeCount: 0
    edgeCount: 0
    nodes: []
    edges: []
  }

interface ComputedPosition {
  nodeKey: string
  x: number
  y: number
}

interface LayoutComputeInput {
  nodes: SeededGraphNode[]
  edges: SiteCrawlGraphLayoutEdge[]
  iterations: number
}

interface ComputedLayout {
  positions: ComputedPosition[]
  /** The uniform node size the anti-overlap pass used, in layout units. */
  nodeSize: number
}

type ComputePositions = (
  input: LayoutComputeInput,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<ComputedLayout>

const graphSourcePage = alias(siteCrawlPages, 'layout_graph_source_page')
const graphTargetPage = alias(siteCrawlPages, 'layout_graph_target_page')

/**
 * Tuned for dense navigation meshes, which is what most real sites are: a
 * 50-page site with a 25-link template header produces ~1,250 edges that all
 * pull every page toward every other page. Under linear attraction with
 * gravity 1 that collapses into one tight blob in the middle of an empty
 * canvas.
 *
 * - `linLogMode` makes attraction logarithmic, so a template link no longer
 *   pulls as hard as a real editorial link and communities can separate.
 * - `outboundAttractionDistribution` divides a node's pull by its out-degree,
 *   so a nav block that links everywhere stops dominating the field.
 * - lower `gravity` stops the whole graph being squeezed back to the center
 *   once those two let it expand.
 */
const FORCE_ATLAS_SETTINGS = Object.freeze({
  adjustSizes: false,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
  edgeWeightInfluence: 0.5,
  gravity: 0.2,
  linLogMode: true,
  outboundAttractionDistribution: true,
  scalingRatio: 2,
  slowDown: 10,
  strongGravityMode: false,
})

/**
 * Publish-time layout has no per-node render size (the browser derives size
 * from the link score), so anti-overlap uses a uniform conservative bound: the
 * largest node the renderer will draw, which is the root marker produced by
 * `siteGraphRootNodeSize` in
 * `apps/web/src/components/project/site-graph-sigma.ts`. That function scales
 * down with node count, so this constant is the small-map ceiling.
 */
const RENDER_MAX_NODE_SIZE = 14
/**
 * Normalized coordinates span [-1, 1], which the fitted camera renders across
 * roughly this many pixels of half-viewport. It converts a pixel node size
 * into a fraction of the graph's own extent, so the separation the layout
 * produces is scale invariant.
 */
const RENDER_HALF_EXTENT_PX = 420
const NODE_SIZE_EXTENT_FRACTION = RENDER_MAX_NODE_SIZE / RENDER_HALF_EXTENT_PX

/**
 * The uniform node size the layout works in: whichever bound is tighter, one
 * render-sized node, or the largest disc that still leaves the graph mostly
 * empty space at this node count. The worker computes and RETURNS the value it
 * used so component packing spaces singletons by the same number rather than
 * deriving it a second time.
 */
export function siteCrawlGraphNodeSize(extent: number, nodeCount: number): number {
  if (!Number.isFinite(extent) || extent <= 0 || nodeCount <= 0) return 0
  const byExtent = extent * NODE_SIZE_EXTENT_FRACTION
  const byArea = Math.sqrt((NOVERLAP_SETTINGS.maxPackingFraction * (2 * extent) ** 2) / nodeCount) / 2
  return Math.min(byExtent, byArea)
}

/** Extent used by `siteCrawlGraphNodeSize`: max axis distance from the centroid. */
export function siteCrawlGraphExtent(positions: readonly { x: number; y: number }[]): number {
  if (positions.length === 0) return 0
  const centerX = positions.reduce((sum, p) => sum + p.x, 0) / positions.length
  const centerY = positions.reduce((sum, p) => sum + p.y, 0) / positions.length
  let extent = 0
  for (const position of positions) {
    extent = Math.max(extent, Math.abs(position.x - centerX), Math.abs(position.y - centerY))
  }
  return extent
}

const NOVERLAP_SETTINGS = Object.freeze({
  /** Half a node of clear space between two touching nodes. */
  marginFactor: 0.5,
  expansion: 1.1,
  ratio: 1,
  speed: 3,
  /**
   * Node discs may claim at most this share of the graph's bounding box. At
   * the 20k cap the extent-derived size asks for spacing the graph physically
   * does not have, and noverlap either runs for minutes or overflows its
   * collision set. This bound keeps the pass solvable at every graph size,
   * and it only binds on graphs far too dense to read node-by-node anyway.
   */
  maxPackingFraction: 0.15,
  /** Cells hold a handful of nodes each, which is what keeps the pass linear. */
  gridSizeMin: 10,
  gridSizeMax: 200,
  iterationLadder: [
    { maxNodes: 1_000, iterations: 120 },
    { maxNodes: 5_000, iterations: 60 },
  ],
  iterationsFloor: 20,
})

/** One grid cell per few nodes; a fixed grid degenerates to O(n^2) at the cap. */
export function noverlapGridSize(nodeCount: number): number {
  return Math.max(
    NOVERLAP_SETTINGS.gridSizeMin,
    Math.min(NOVERLAP_SETTINGS.gridSizeMax, Math.ceil(Math.sqrt(Math.max(1, nodeCount)))),
  )
}

/** Same shape as the ForceAtlas2 budget: small graphs can afford convergence. */
export function noverlapMaxIterations(nodeCount: number): number {
  for (const step of NOVERLAP_SETTINGS.iterationLadder) {
    if (nodeCount <= step.maxNodes) return step.iterations
  }
  return NOVERLAP_SETTINGS.iterationsFloor
}

/**
 * Clearance between packed components, as a multiple of the node size the
 * anti-overlap pass used. Components sit close enough to read as one map while
 * still being visibly separate.
 */
const COMPONENT_PACKING_SPACING_FACTOR = 3

/**
 * Physics settings are part of the layout's identity. Fingerprinting them into
 * the version means a settings change automatically stops prior positions from
 * being reused as seeds (`loadPriorSiteCrawlGraphPositions` matches on this
 * exact string), so a tuning change can never half-apply against coordinates
 * produced by different physics.
 */
export function siteCrawlGraphLayoutSettingsFingerprint(settings: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 8)
}

/**
 * v3 excludes template links from the physics. That changes what the same
 * crawl produces, so it is an ALGORITHM change, not a settings change: v2
 * coordinates must not be reused as seeds for a v3 layout.
 *
 * v4 is the same exclusion over a corrected classification. A link that is
 * both a footer link and an in-prose link used to be marked chrome and was
 * dropped from the physics, so every stored v3 layout was solved over a graph
 * missing much of the site's real editorial structure. The settings
 * fingerprint below cannot catch this: the threshold did not move, the rule
 * that applies it did. Bumping the algorithm is what stops a v3 layout being
 * reused, or its coordinates being seeded into the corrected solve.
 *
 * v5 is the same exclusion over a DIFFERENT classification: links are now
 * separated by where they sit in the page, and ubiquity only decides the ones
 * the page's landmarks say nothing about. That moves which edges enter the
 * physics on every site whose editorial anchors reuse the nav's wording, which
 * is most of them, so v4 coordinates are the wrong seed for a v5 solve.
 */
const SITE_CRAWL_GRAPH_LAYOUT_ALGORITHM = 'site-health-fa2-v5'

export const SITE_CRAWL_GRAPH_LAYOUT_VERSION = `${SITE_CRAWL_GRAPH_LAYOUT_ALGORITHM}-${
  siteCrawlGraphLayoutSettingsFingerprint({
    forceAtlas: FORCE_ATLAS_SETTINGS,
    noverlap: NOVERLAP_SETTINGS,
    nodeSizeExtentFraction: NODE_SIZE_EXTENT_FRACTION,
    componentPackingSpacingFactor: COMPONENT_PACKING_SPACING_FACTOR,
    templateLinkRatioThreshold: TEMPLATE_LINK_RATIO_THRESHOLD,
  })
}`

const WORKER_SOURCE = String.raw`
const {parentPort, workerData} = require('node:worker_threads');
try {
  const graphologyModule = require(workerData.graphologyPath);
  const forceAtlasModule = require(workerData.forceAtlasPath);
  const noverlapModule = require(workerData.noverlapPath);
  const MultiDirectedGraph = graphologyModule.MultiDirectedGraph;
  const forceAtlas2 = forceAtlasModule.default || forceAtlasModule;
  const noverlap = noverlapModule.default || noverlapModule;
  const graph = new MultiDirectedGraph({allowSelfLoops: true});
  for (const node of workerData.input.nodes) {
    graph.addNode(node.nodeKey, {x: node.x, y: node.y});
  }
  for (const edge of workerData.input.edges) {
    graph.addDirectedEdgeWithKey(edge.edgeKey, edge.sourceNodeKey, edge.targetNodeKey, {
      weight: 1 + Math.log2(Math.max(1, edge.occurrences)),
    });
  }
  if (graph.order > 1 && graph.size > 0) {
    forceAtlas2.assign(graph, {
      iterations: workerData.input.iterations,
      settings: workerData.settings,
    });
  }
  let nodeSize = 0;
  // Anti-overlap runs on the spatialization ForceAtlas2 just produced. Node
  // size is uniform and derived from the graph's own extent, so the pass is
  // scale invariant and stays deterministic for a fixed input.
  if (graph.order > 1) {
    let sumX = 0;
    let sumY = 0;
    graph.forEachNode(function (nodeKey, attributes) {
      sumX += attributes.x;
      sumY += attributes.y;
    });
    const centerX = sumX / graph.order;
    const centerY = sumY / graph.order;
    let extent = 0;
    graph.forEachNode(function (nodeKey, attributes) {
      extent = Math.max(extent, Math.abs(attributes.x - centerX), Math.abs(attributes.y - centerY));
    });
    if (Number.isFinite(extent) && extent > 0) {
      // Whichever bound is tighter: one render-sized node, or the largest disc
      // that still leaves the graph mostly empty space at this node count.
      // Mirrors siteCrawlGraphNodeSize; a test asserts the two agree.
      const byExtent = extent * workerData.nodeSizeExtentFraction;
      const byArea = Math.sqrt(
        (workerData.noverlap.maxPackingFraction * Math.pow(2 * extent, 2)) / graph.order,
      ) / 2;
      nodeSize = Math.min(byExtent, byArea);
      graph.forEachNode(function (nodeKey) {
        graph.setNodeAttribute(nodeKey, 'size', nodeSize);
      });
      noverlap.assign(graph, {
        maxIterations: workerData.noverlap.maxIterations,
        settings: {
          gridSize: workerData.noverlap.gridSize,
          margin: nodeSize * workerData.noverlap.marginFactor,
          expansion: workerData.noverlap.expansion,
          ratio: workerData.noverlap.ratio,
          speed: workerData.noverlap.speed,
        },
      });
    }
  }
  const positions = [];
  graph.forEachNode((nodeKey, attributes) => {
    positions.push({nodeKey, x: attributes.x, y: attributes.y});
  });
  parentPort.postMessage({ok: true, positions, nodeSize});
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error && typeof error.message === 'string' ? error.message : String(error),
  });
}
`

class GraphLayoutTimeoutError extends Error {
  override name = 'GraphLayoutTimeoutError'
}

function hashUnit(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

function pathSection(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? '__root__'
}

/**
 * Stable, hierarchy-aware initial coordinates. The home node is central;
 * top-level folders get stable hash-derived cluster centers, and depth expands
 * pages within each cluster before ForceAtlas2 spatializes actual links.
 */
export function seedSiteCrawlGraphNodes(
  nodes: readonly SiteCrawlGraphSeedNode[],
  rootNodeKey: string | null,
  priorPositions?: ReadonlyMap<string, Pick<PersistedGraphPosition, 'x' | 'y'>>,
): SeededGraphNode[] {
  return [...nodes]
    .sort((a, b) => a.sampleRank - b.sampleRank || a.nodeKey.localeCompare(b.nodeKey))
    .map((node) => {
      const prior = priorPositions?.get(node.nodeKey)
      if (prior && Number.isFinite(prior.x) && Number.isFinite(prior.y)) {
        return {
          ...node,
          x: prior.x * SITE_CRAWL_GRAPH_SEED_SCALE,
          y: prior.y * SITE_CRAWL_GRAPH_SEED_SCALE,
        }
      }
      if (node.nodeKey === rootNodeKey) return { ...node, x: 0, y: 0 }
      const section = pathSection(node.path)
      const sectionAngle = hashUnit(`section:${section}`) * Math.PI * 2
      const sectionRadius = section === '__root__' ? 24 : 100
      const clusterX = Math.cos(sectionAngle) * sectionRadius
      const clusterY = Math.sin(sectionAngle) * sectionRadius
      const localAngle = hashUnit(`node-angle:${node.nodeKey}`) * Math.PI * 2
      const depth = Math.max(0, Math.min(12, node.depth ?? 4))
      const localRadius = 4 + depth * 2.5 + Math.sqrt(hashUnit(`node-radius:${node.nodeKey}`)) * 14
      return {
        ...node,
        x: clusterX + Math.cos(localAngle) * localRadius,
        y: clusterY + Math.sin(localAngle) * localRadius,
      }
    })
}

/** The expensive cap is deliberately tiny at 20k/50k and pinned by version. */
export function adaptiveForceAtlasIterations(nodeCount: number, edgeCount: number): number {
  if (nodeCount <= 100 && edgeCount <= 500) return 100
  if (nodeCount <= 500 && edgeCount <= 2_500) return 70
  if (nodeCount <= 2_000 && edgeCount <= 10_000) return 40
  if (nodeCount <= 5_000 && edgeCount <= 20_000) return 24
  if (nodeCount <= 10_000 && edgeCount <= 35_000) return 12
  return 6
}

async function computeForceAtlasPositions(
  input: LayoutComputeInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ComputedLayout> {
  if (input.nodes.length <= 1 || input.edges.length === 0) {
    // No edges means no physics to run, but every page is still its own
    // component, so packing needs a real spacing. Derive it from the seeds.
    const positions = input.nodes.map(({ nodeKey, x, y }) => ({ nodeKey, x, y }))
    return { positions, nodeSize: siteCrawlGraphNodeSize(siteCrawlGraphExtent(positions), positions.length) }
  }
  const requireFromPackage = createRequire(import.meta.url)
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      graphologyPath: requireFromPackage.resolve('graphology'),
      forceAtlasPath: requireFromPackage.resolve('graphology-layout-forceatlas2'),
      noverlapPath: requireFromPackage.resolve('graphology-layout-noverlap'),
      input,
      settings: FORCE_ATLAS_SETTINGS,
      noverlap: {
        ...NOVERLAP_SETTINGS,
        gridSize: noverlapGridSize(input.nodes.length),
        maxIterations: noverlapMaxIterations(input.nodes.length),
      },
      nodeSizeExtentFraction: NODE_SIZE_EXTENT_FRACTION,
    },
  })
  const timeoutMs = options.timeoutMs ?? SITE_CRAWL_GRAPH_LAYOUT_TIMEOUT_MS
  return await new Promise<ComputedLayout>((resolve, reject) => {
    let settled = false
    const finish = (result: { positions?: ComputedPosition[]; nodeSize?: number; error?: unknown }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (result.error) reject(result.error instanceof Error
        ? result.error
        : new Error('Graph layout failed with a non-Error reason', { cause: result.error }))
      else resolve({ positions: result.positions ?? [], nodeSize: result.nodeSize ?? 0 })
    }
    const onAbort = () => finish({ error: options.signal?.reason ?? new DOMException('Layout aborted', 'AbortError') })
    const timer = setTimeout(() => finish({ error: new GraphLayoutTimeoutError(`Graph layout exceeded ${timeoutMs}ms`) }), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) return onAbort()
    worker.once('message', (message: { ok: boolean; positions?: ComputedPosition[]; nodeSize?: number; error?: string }) => {
      if (!message.ok) finish({ error: new Error(message.error ?? 'Graph layout worker failed') })
      else finish({ positions: message.positions, nodeSize: message.nodeSize })
    })
    worker.once('error', (error) => finish({ error }))
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) finish({ error: new Error(`Graph layout worker exited with code ${code}`) })
    })
  })
}

/**
 * Union-find over the sampled edge list. Direction does not matter here: a page
 * reachable only by linking OUT is still attached to the graph a reader sees.
 *
 * Returns every component, largest first, ties broken by smallest node key, and
 * members sorted within each component, so the whole result is a pure function
 * of the input.
 */
export function siteCrawlGraphComponents(
  nodeKeys: readonly string[],
  edges: readonly Pick<SiteCrawlGraphLayoutEdge, 'sourceNodeKey' | 'targetNodeKey'>[],
): string[][] {
  const parent = new Map<string, string>(nodeKeys.map((key) => [key, key]))
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression keeps repeated lookups cheap at the 20k cap.
    let cursor = key
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  for (const edge of edges) {
    if (!parent.has(edge.sourceNodeKey) || !parent.has(edge.targetNodeKey)) continue
    const sourceRoot = find(edge.sourceNodeKey)
    const targetRoot = find(edge.targetNodeKey)
    if (sourceRoot === targetRoot) continue
    // Union by smaller key so the result never depends on edge order.
    if (sourceRoot < targetRoot) parent.set(targetRoot, sourceRoot)
    else parent.set(sourceRoot, targetRoot)
  }

  const members = new Map<string, string[]>()
  for (const key of [...nodeKeys].sort()) {
    const root = find(key)
    const group = members.get(root)
    if (group) group.push(key)
    else members.set(root, [key])
  }
  return [...members.values()].sort((left, right) => (
    right.length - left.length || compareText(left[0]!, right[0]!)
  ))
}

interface PackedComponent {
  nodeKeys: string[]
  centerX: number
  centerY: number
  radius: number
}

function describeComponent(
  nodeKeys: string[],
  byKey: ReadonlyMap<string, ComputedPosition>,
): PackedComponent {
  let sumX = 0
  let sumY = 0
  for (const nodeKey of nodeKeys) {
    const position = byKey.get(nodeKey)!
    sumX += position.x
    sumY += position.y
  }
  const centerX = sumX / nodeKeys.length
  const centerY = sumY / nodeKeys.length
  let radius = 0
  for (const nodeKey of nodeKeys) {
    const position = byKey.get(nodeKey)!
    radius = Math.max(radius, Math.hypot(position.x - centerX, position.y - centerY))
  }
  return { nodeKeys, centerX, centerY, radius }
}

/**
 * Pack disconnected components around the largest one.
 *
 * ForceAtlas2 spatializes each component correctly but has nothing holding the
 * components themselves together, so they drift apart until the bounding box is
 * mostly empty and the camera fit shrinks the real graph to a dot.
 *
 * Each component is moved as a RIGID BODY: every node in it takes the same
 * translation, so the internal layout ForceAtlas2 computed, and every distance
 * inside it, survives exactly. Only the components move relative to each other.
 * `nodeSpacing` is the same node size the anti-overlap pass used, so singleton
 * components land at least one node apart.
 */
export function packSiteCrawlGraphComponents(
  positions: readonly ComputedPosition[],
  edges: readonly Pick<SiteCrawlGraphLayoutEdge, 'sourceNodeKey' | 'targetNodeKey'>[],
  nodeSpacing: number,
): ComputedPosition[] {
  const components = siteCrawlGraphComponents(positions.map((position) => position.nodeKey), edges)
  if (components.length <= 1) return [...positions]

  const byKey = new Map(positions.map((position) => [position.nodeKey, position]))
  if (positions.some((position) => !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
    return [...positions]
  }
  const described = components.map((nodeKeys) => describeComponent(nodeKeys, byKey))
  const [anchor, ...rest] = described as [PackedComponent, ...PackedComponent[]]

  const spacing = Math.max(nodeSpacing, Number.EPSILON) * COMPONENT_PACKING_SPACING_FACTOR
  // Largest first, so the big secondary components take the inner rings and
  // the ring pitch can shrink to the singletons that follow. Sizing every cell
  // off the single largest component would let one mid-sized component inflate
  // the whole frame that hundreds of orphans then sit in.
  const ordered = [...rest].sort((left, right) => (
    right.radius - left.radius
    || compareText(left.nodeKeys[0]!, right.nodeKeys[0]!)
  ))

  const moved = new Map<string, ComputedPosition>()
  // Ring geometry advances with the items actually placed: each ring's pitch
  // is set by the largest component ON that ring, not by the largest overall.
  let ringRadius = anchor.radius + spacing
  let ringPitch = 0
  let placedOnRing = 0
  let ringCapacity = 0
  for (const component of ordered) {
    if (placedOnRing >= ringCapacity) {
      // Open a new ring sized for the next (and therefore largest remaining)
      // component, then fit as many as its circumference allows.
      ringPitch = 2 * component.radius + spacing
      ringRadius += ringPitch / 2 + (placedOnRing === 0 ? 0 : ringPitch / 2)
      ringCapacity = Math.max(1, Math.floor((2 * Math.PI * ringRadius) / ringPitch))
      placedOnRing = 0
    }
    const angle = (placedOnRing / ringCapacity) * Math.PI * 2
    placedOnRing += 1
    const targetX = anchor.centerX + Math.cos(angle) * ringRadius
    const targetY = anchor.centerY + Math.sin(angle) * ringRadius
    const shiftX = targetX - component.centerX
    const shiftY = targetY - component.centerY
    for (const nodeKey of component.nodeKeys) {
      const position = byKey.get(nodeKey)!
      moved.set(nodeKey, { nodeKey, x: position.x + shiftX, y: position.y + shiftY })
    }
  }
  return positions.map((position) => moved.get(position.nodeKey) ?? position)
}

function normalizePositions(
  seededNodes: readonly SeededGraphNode[],
  computed: readonly ComputedPosition[],
  rootNodeKey: string | null,
): PersistedGraphPosition[] {
  const byKey = new Map(computed.map((position) => [position.nodeKey, position]))
  if (byKey.size !== seededNodes.length) throw new Error('Graph layout returned an incomplete node set')
  const root = rootNodeKey ? byKey.get(rootNodeKey) : null
  const centerX = root?.x ?? computed.reduce((sum, position) => sum + position.x, 0) / Math.max(1, computed.length)
  const centerY = root?.y ?? computed.reduce((sum, position) => sum + position.y, 0) / Math.max(1, computed.length)
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new Error('Graph layout returned a non-finite center')
  let scale = 0
  for (const position of computed) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Graph layout returned non-finite coordinates')
    scale = Math.max(scale, Math.abs(position.x - centerX), Math.abs(position.y - centerY))
  }
  scale = scale > 0 ? scale : 1
  return seededNodes.map((node) => {
    const position = byKey.get(node.nodeKey)
    if (!position) throw new Error(`Graph layout omitted ${node.nodeKey}`)
    return {
      nodeKey: node.nodeKey,
      sampleRank: node.sampleRank,
      x: Math.round(((position.x - centerX) / scale) * 1_000_000) / 1_000_000,
      y: Math.round(((position.y - centerY) / scale) * 1_000_000) / 1_000_000,
    }
  })
}

/** Best-effort layout boundary: physics failure is data unavailability, not crawl failure. */
export async function layoutSiteCrawlGraphInput(
  input: SiteCrawlGraphLayoutInput,
  options: {
    computePositions?: ComputePositions
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<PreparedSiteCrawlGraphLayout> {
  options.signal?.throwIfAborted()
  if (input.nodes.length === 0) {
    return {
      state: 'unavailable', failureCode: 'empty-crawl',
      totalNodes: input.totalNodes, totalEdges: input.totalEdges,
      totalTemplateEdges: input.totalTemplateEdges,
      nodeCount: 0, edgeCount: 0, nodes: [],
      edges: [],
    }
  }
  /**
   * The point of the feature. A template header repeated across 50 pages is
   * ~1,250 edges pulling every page toward every other page, which is exactly
   * the mesh the physics tuning above was fighting. Dropping those edges from
   * the INPUT is stronger than damping them: what is left is the editorial
   * link structure, so a page reachable only through the nav becomes the
   * weakly connected component it really is and the packing pass places it.
   *
   * The full sample is still PUBLISHED below, so a viewer can switch template
   * links on and see them drawn over positions that never move.
   */
  const layoutEdges = input.edges.filter((edge) => !edge.isTemplate)
  const seeded = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey, input.priorPositions)
  // ONE budget for the whole pipeline. Packing and normalization run on this
  // thread after the worker resolves, so without a shared deadline they were
  // unbounded work outside the timeout that is supposed to cap layout.
  const timeoutMs = options.timeoutMs ?? SITE_CRAWL_GRAPH_LAYOUT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const assertWithinBudget = () => {
    options.signal?.throwIfAborted()
    if (Date.now() > deadline) throw new GraphLayoutTimeoutError(`Graph layout exceeded ${timeoutMs}ms`)
  }
  try {
    const compute = options.computePositions ?? computeForceAtlasPositions
    const { positions, nodeSize } = await compute({
      nodes: seeded,
      edges: layoutEdges,
      iterations: adaptiveForceAtlasIterations(input.nodes.length, layoutEdges.length),
    }, { signal: options.signal, timeoutMs: Math.max(1, deadline - Date.now()) })
    assertWithinBudget()
    // Packing runs last and only ever translates whole components, so it can
    // never undo the anti-overlap the worker just did inside one of them. It
    // sees the same content-only edges, so a page whose only inbound links are
    // template links is a genuine singleton and gets placed, not stacked on
    // the origin.
    const framed = packSiteCrawlGraphComponents(positions, layoutEdges, nodeSize)
    assertWithinBudget()
    return {
      state: 'ready',
      layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION,
      totalNodes: input.totalNodes,
      totalEdges: input.totalEdges,
      totalTemplateEdges: input.totalTemplateEdges,
      nodeCount: input.nodes.length,
      edgeCount: input.edges.length,
      templateLinksExcluded: true,
      nodes: normalizePositions(seeded, framed, input.rootNodeKey),
      edges: input.edges.map((edge, sampleRank) => ({ ...edge, sampleRank })),
    }
  } catch (error) {
    // Cancellation is control flow owned by the crawl executor, not a layout
    // availability failure. Preserve the signal's exact reason so its typed
    // cancellation guard can update the run and attempt correctly.
    if (options.signal?.aborted) options.signal.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      state: 'unavailable',
      failureCode: error instanceof GraphLayoutTimeoutError ? 'layout-timeout' : 'layout-error',
      totalNodes: input.totalNodes,
      totalEdges: input.totalEdges,
      totalTemplateEdges: input.totalTemplateEdges,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    }
  }
}

/**
 * The graph is immutable per attempt, so a new publish can read the latest
 * complete, compatible snapshot without changing it. Its normalized points are
 * expanded back into the ForceAtlas seed space by `seedSiteCrawlGraphNodes`.
 */
function loadPriorSiteCrawlGraphPositions(
  db: DatabaseClient,
  scope: { projectId: string; runId: string },
): ReadonlyMap<string, Pick<PersistedGraphPosition, 'x' | 'y'>> {
  const prior = db.select({
    runId: siteCrawlSnapshots.runId,
    attemptId: siteCrawlSnapshots.attemptId,
  }).from(siteCrawlSnapshots)
    .innerJoin(siteCrawlGraphLayouts, and(
      eq(siteCrawlGraphLayouts.projectId, siteCrawlSnapshots.projectId),
      eq(siteCrawlGraphLayouts.runId, siteCrawlSnapshots.runId),
      eq(siteCrawlGraphLayouts.attemptId, siteCrawlSnapshots.attemptId),
    ))
    .where(and(
      eq(siteCrawlSnapshots.projectId, scope.projectId),
      ne(siteCrawlSnapshots.runId, scope.runId),
      eq(siteCrawlSnapshots.complete, true),
      eq(siteCrawlGraphLayouts.state, 'ready'),
      eq(siteCrawlGraphLayouts.layoutVersion, SITE_CRAWL_GRAPH_LAYOUT_VERSION),
    ))
    .orderBy(desc(siteCrawlSnapshots.createdAt), desc(siteCrawlSnapshots.id))
    .limit(1)
    .get()
  if (!prior?.attemptId) return new Map()

  return new Map(db.select({
    nodeKey: siteCrawlGraphNodes.nodeKey,
    x: siteCrawlGraphNodes.x,
    y: siteCrawlGraphNodes.y,
  }).from(siteCrawlGraphNodes)
    .where(and(
      eq(siteCrawlGraphNodes.projectId, scope.projectId),
      eq(siteCrawlGraphNodes.runId, prior.runId),
      eq(siteCrawlGraphNodes.attemptId, prior.attemptId),
    ))
    .all()
    .map((node) => [node.nodeKey, { x: node.x, y: node.y }]))
}

/**
 * Read only the bounded publish sample. The JSON CTE uses one bound parameter
 * for retained keys, avoiding SQLite's variable cap and any 1m-edge scan into
 * JavaScript memory.
 */
export async function prepareSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string; rootUrl: string },
  options: { computePositions?: ComputePositions; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PreparedSiteCrawlGraphLayout> {
  let totalNodes = 0
  let totalEdges = 0
  let totalTemplateEdges = 0
  try {
    const assertNotAborted = () => options.signal?.throwIfAborted()
    assertNotAborted()
    const pageScope = [
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
    ]
    const edgeScope = [
      eq(siteCrawlEdges.projectId, scope.projectId),
      eq(siteCrawlEdges.runId, scope.runId),
      eq(siteCrawlEdges.attemptId, scope.attemptId),
      eq(siteCrawlEdges.internal, true),
      eq(siteCrawlEdges.relation, 'anchor'),
    ]
    totalNodes = db.select({ value: count() }).from(siteCrawlPages).where(and(...pageScope)).get()?.value ?? 0
    assertNotAborted()
    // ONE query shape for both counts, so the template share always splits the
    // same denominator the response reports as `totalEdges`.
    const countGraphCompatibleEdges = (...extra: (SQL | undefined)[]): number => db
      .select({ value: count() })
      .from(siteCrawlEdges)
      .innerJoin(graphSourcePage, and(
        eq(graphSourcePage.projectId, scope.projectId),
        eq(graphSourcePage.runId, scope.runId),
        eq(graphSourcePage.attemptId, scope.attemptId),
        eq(graphSourcePage.nodeKey, siteCrawlEdges.sourceNodeKey),
      ))
      .innerJoin(graphTargetPage, and(
        eq(graphTargetPage.projectId, scope.projectId),
        eq(graphTargetPage.runId, scope.runId),
        eq(graphTargetPage.attemptId, scope.attemptId),
        eq(graphTargetPage.nodeKey, siteCrawlEdges.targetNodeKey),
      ))
      .where(and(...edgeScope, ...extra))
      .get()?.value ?? 0
    totalEdges = countGraphCompatibleEdges()
    assertNotAborted()
    totalTemplateEdges = countGraphCompatibleEdges(eq(siteCrawlEdges.isTemplate, true))
    assertNotAborted()

    const graphSeedColumns = {
      nodeKey: siteCrawlPages.nodeKey,
      path: siteCrawlPages.path,
      depth: siteCrawlPages.depth,
    }
    const rootRows = db.select(graphSeedColumns).from(siteCrawlPages)
      .where(and(...pageScope, eq(siteCrawlPages.url, scope.rootUrl)))
      .orderBy(asc(siteCrawlPages.nodeKey)).limit(1).all()
    assertNotAborted()
    const retainedRows = [...rootRows]
    if (retainedRows.length < SITE_CRAWL_GRAPH_MAX_NODES) {
      retainedRows.push(...db.select(graphSeedColumns).from(siteCrawlPages)
        .where(and(...pageScope, eq(siteCrawlPages.depth, 0), ne(siteCrawlPages.url, scope.rootUrl)))
        .orderBy(asc(siteCrawlPages.nodeKey))
        .limit(SITE_CRAWL_GRAPH_MAX_NODES - retainedRows.length).all())
    }
    assertNotAborted()
    if (retainedRows.length < SITE_CRAWL_GRAPH_MAX_NODES) {
      retainedRows.push(...db.select(graphSeedColumns).from(siteCrawlPages)
        .where(and(
          ...pageScope,
          or(isNull(siteCrawlPages.depth), ne(siteCrawlPages.depth, 0)),
          ne(siteCrawlPages.url, scope.rootUrl),
        ))
        .orderBy(desc(siteCrawlPages.linkScoreNormalized), asc(siteCrawlPages.nodeKey))
        .limit(SITE_CRAWL_GRAPH_MAX_NODES - retainedRows.length).all())
    }
    assertNotAborted()

    const nodes = retainedRows.map((row, sampleRank) => ({
      nodeKey: row.nodeKey,
      path: row.path,
      depth: row.depth,
      sampleRank,
    }))
    const rootNodeKey = rootRows[0]?.nodeKey ?? null
    const priorPositions = loadPriorSiteCrawlGraphPositions(db, scope)
    assertNotAborted()
    const selectedKeys = JSON.stringify(nodes.map((node) => node.nodeKey))
    // Sample order is deliberately unchanged, so it keeps walking
    // `idx_site_crawl_edges_graph_sample` rather than sorting a million rows
    // in a temp b-tree. Template links therefore compete for the same 50k
    // slots as content links; at that cap `sampled` already says the map is
    // truncated, and `totalTemplateEdges` still reports the real split.
    // A NULL `is_template` cannot occur here: publish classifies every link in
    // the attempt before layout runs, and it writes a strict boolean. A link no
    // rule could measure is a real `false` carrying an `unmeasured` source, not
    // a NULL, so the `Boolean(...)` coercion below cannot silently turn "we do
    // not know" into "content".
    const edgeRows = nodes.length === 0 ? [] : db.all(sql`
      WITH selected(node_key) AS (SELECT value FROM json_each(${selectedKeys}))
      SELECT
        edge.edge_key AS edgeKey,
        edge.source_node_key AS sourceNodeKey,
        edge.target_node_key AS targetNodeKey,
        edge.followable AS followable,
        edge.occurrences AS occurrences,
        edge.is_template AS isTemplate
      FROM site_crawl_edges AS edge
      INNER JOIN selected AS source ON source.node_key = edge.source_node_key
      INNER JOIN selected AS target ON target.node_key = edge.target_node_key
      WHERE edge.project_id = ${scope.projectId}
        AND edge.run_id = ${scope.runId}
        AND edge.attempt_id = ${scope.attemptId}
        AND edge.internal = 1
        AND edge.relation = 'anchor'
      ORDER BY edge.occurrences DESC, edge.edge_key ASC
      LIMIT ${SITE_CRAWL_GRAPH_MAX_EDGES}
    `) as Array<{
      edgeKey: string
      sourceNodeKey: string
      targetNodeKey: string
      followable: boolean
      occurrences: number
      isTemplate: number | boolean | null
    }>
    assertNotAborted()
    return await layoutSiteCrawlGraphInput({
      totalNodes,
      totalEdges,
      totalTemplateEdges,
      nodes,
      edges: edgeRows.map((row) => ({ ...row, isTemplate: Boolean(row.isTemplate) })),
      rootNodeKey,
      priorPositions,
    }, options)
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      state: 'unavailable', failureCode: 'layout-error',
      totalNodes, totalEdges, totalTemplateEdges, nodeCount: 0, edgeCount: 0, nodes: [],
      edges: [],
    }
  }
}

/** Idempotent derived-data write, intentionally separate from crawl publication. */
export function persistSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string },
  layout: PreparedSiteCrawlGraphLayout,
  now = new Date().toISOString(),
): void {
  db.transaction((tx) => {
    tx.delete(siteCrawlGraphLayouts).where(and(
      eq(siteCrawlGraphLayouts.projectId, scope.projectId),
      eq(siteCrawlGraphLayouts.runId, scope.runId),
      eq(siteCrawlGraphLayouts.attemptId, scope.attemptId),
    )).run()
    tx.insert(siteCrawlGraphLayouts).values({
      id: crypto.randomUUID(),
      projectId: scope.projectId,
      runId: scope.runId,
      attemptId: scope.attemptId,
      state: layout.state,
      layoutVersion: layout.state === 'ready' ? layout.layoutVersion : null,
      failureCode: layout.state === 'unavailable' ? layout.failureCode : null,
      totalNodes: layout.totalNodes,
      totalEdges: layout.totalEdges,
      totalTemplateEdges: layout.totalTemplateEdges,
      nodeCount: layout.nodeCount,
      edgeCount: layout.edgeCount,
      templateLinksExcluded: layout.state === 'ready',
      createdAt: now,
      updatedAt: now,
    }).run()
    if (layout.state !== 'ready') return
    const batchSize = 250
    for (let offset = 0; offset < layout.nodes.length; offset += batchSize) {
      tx.insert(siteCrawlGraphNodes).values(layout.nodes.slice(offset, offset + batchSize).map((node) => ({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        nodeKey: node.nodeKey,
        sampleRank: node.sampleRank,
        x: node.x,
        y: node.y,
        createdAt: now,
      }))).run()
    }
    for (let offset = 0; offset < layout.edges.length; offset += batchSize) {
      tx.insert(siteCrawlGraphEdges).values(layout.edges.slice(offset, offset + batchSize).map((edge) => ({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        edgeKey: edge.edgeKey,
        sampleRank: edge.sampleRank,
        sourceNodeKey: edge.sourceNodeKey,
        targetNodeKey: edge.targetNodeKey,
        followable: edge.followable,
        occurrences: edge.occurrences,
        isTemplate: edge.isTemplate,
        createdAt: now,
      }))).run()
    }
  })
}

/** Remove unpublished derived rows when terminal publication loses its CAS. */
export function deleteSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string },
): void {
  db.delete(siteCrawlGraphLayouts).where(and(
    eq(siteCrawlGraphLayouts.projectId, scope.projectId),
    eq(siteCrawlGraphLayouts.runId, scope.runId),
    eq(siteCrawlGraphLayouts.attemptId, scope.attemptId),
  )).run()
}
