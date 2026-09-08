import { MultiDirectedGraph } from 'graphology'
import { deriveSiteHealthState, type SiteHealthState } from '@ainyc/canonry-contracts'

export type SiteGraphVisualState = SiteHealthState

/**
 * Dedicated Okabe-Ito-derived colors for the WebGL graph. They stay separate
 * from Canonry's global success/warning/error tones because this four-way data
 * encoding must remain distinguishable for common color-vision deficiencies.
 */
export const SITE_GRAPH_COLOR_TOKENS = {
  eligible: { property: '--chart-site-health-eligible', fallback: '#56b4e9' },
  hidden: { property: '--chart-site-health-hidden', fallback: '#e69f00' },
  // Neutral on purpose. A text file or a PDF is not a fault, so it must not
  // borrow the amber the genuinely hidden pages use.
  resource: { property: '--chart-site-health-resource', fallback: '#d4d4d8' },
  redirect: { property: '--chart-site-health-redirect', fallback: '#9aa7b8' },
  failed: { property: '--chart-site-health-failed', fallback: '#d55e00' },
  unchecked: { property: '--chart-site-health-unchecked', fallback: '#a1a1aa' },
} as const satisfies Record<SiteGraphVisualState, { property: string; fallback: string }>

/** Default links must meet the 3:1 non-text contrast threshold in both themes. */
export const SITE_GRAPH_EDGE_TOKEN = {
  property: '--chart-neutral-text-dim',
  fallback: '#71717a',
} as const

/** Smallest dot we will draw; below this a node stops being clickable. */
export const SITE_GRAPH_NODE_MIN_SIZE = 2.5
/** Largest dot on a small map. Dense maps scale down from here. */
export const SITE_GRAPH_NODE_MAX_SIZE = 9
/** Node counts at or below this get the full size range. */
const SITE_GRAPH_NODE_SIZE_REFERENCE_COUNT = 200
/** No matter how dense the map, a node never shrinks past this. */
const SITE_GRAPH_NODE_MAX_SIZE_FLOOR = 3
/** The root is this much bigger than the largest ordinary node. */
const SITE_GRAPH_ROOT_SIZE_FACTOR = 1.6

/**
 * The largest ordinary node at this map size. A near-complete template mesh
 * pushes almost every page to a similar link score, so without this every dot
 * renders at the maximum and the map reads as one solid mass. Monotonically
 * non-increasing in node count.
 */
export function siteGraphMaxNodeSize(nodeCount: number): number {
  const density = SITE_GRAPH_NODE_SIZE_REFERENCE_COUNT / Math.max(SITE_GRAPH_NODE_SIZE_REFERENCE_COUNT, nodeCount)
  return Math.max(SITE_GRAPH_NODE_MAX_SIZE_FLOOR, SITE_GRAPH_NODE_MAX_SIZE * density ** 0.25)
}

/** The root stays findable at any link score, so it never shrinks to fit. */
export function siteGraphRootNodeSize(nodeCount: number): number {
  return siteGraphMaxNodeSize(nodeCount) * SITE_GRAPH_ROOT_SIZE_FACTOR
}

/**
 * Structural subset of a published Site Health graph node. Positions are
 * computed with the snapshot and are never recomputed in the browser.
 */
export interface SiteGraphHealthSource {
  indexabilityState: string
  fetchState: string
  /** Optional server-owned state. Legacy graph snapshots derive it below. */
  healthState?: SiteGraphVisualState
  /** Optional legacy canonical identity metadata. New snapshots use healthState. */
  canonicalNodeKey?: string | null
  indexabilityReasons?: readonly string[]
  nodeKey?: string
}

export interface SiteGraphSigmaNode extends SiteGraphHealthSource {
  nodeKey: string
  url: string
  path: string
  depth: number | null
  /** Page-level Technical AEO score. It does not affect graph color or size. */
  auditScore?: number | null
  linkScoreNormalized: number | null
  inventoryEligible?: boolean
  x: number
  y: number
}

export interface SiteGraphSigmaEdge {
  edgeKey: string
  sourceNodeKey: string
  targetNodeKey: string | null
  followable: boolean
  occurrences: number
  /** Nav/footer chrome. Null when this scan could not tell them apart. */
  isTemplate?: boolean | null
}

export interface SigmaSiteGraphTheme {
  eligible: string
  hidden: string
  resource: string
  redirect: string
  failed: string
  unchecked: string
  dimmedNode: string
  edge: string
  edgeDimmed: string
  edgeActive: string
  label: string
  background: string
}

/**
 * Sigma 3 only accepts hex and comma-delimited rgb(a) colors. Keep every
 * renderer-bound color in the existing neutral graph ladder or the dedicated
 * Site Health state palette, never in CSS's space-delimited color syntax.
 */
export const SITE_GRAPH_SIGMA_COLOR_TOKENS = {
  eligible: SITE_GRAPH_COLOR_TOKENS.eligible,
  hidden: SITE_GRAPH_COLOR_TOKENS.hidden,
  resource: SITE_GRAPH_COLOR_TOKENS.resource,
  redirect: SITE_GRAPH_COLOR_TOKENS.redirect,
  failed: SITE_GRAPH_COLOR_TOKENS.failed,
  unchecked: SITE_GRAPH_COLOR_TOKENS.unchecked,
  dimmedNode: { property: '--chart-neutral-text-dim', fallback: '#71717a' },
  edge: SITE_GRAPH_EDGE_TOKEN,
  edgeDimmed: { property: '--chart-neutral-text-faint', fallback: '#52525b' },
  edgeActive: { property: '--chart-neutral-text', fallback: '#a1a1aa' },
  label: { property: '--chart-tooltip-label', fallback: '#e4e4e7' },
  background: { property: '--chart-tooltip-bg', fallback: '#18181b' },
} as const satisfies Record<keyof SigmaSiteGraphTheme, { property: string; fallback: string }>

const SIGMA_HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i
const SIGMA_LEGACY_RGB_COLOR = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/

/** Reject CSS Color 4 values that Sigma 3 would silently render as black. */
export function isSigmaWebGlColor(color: string): boolean {
  return SIGMA_HEX_COLOR.test(color) || SIGMA_LEGACY_RGB_COLOR.test(color)
}

export interface SigmaSiteGraphNodeAttributes extends Record<string, unknown> {
  x: number
  y: number
  size: number
  color: string
  baseColor: string
  label: string
  nodeKey: string
  url: string
  path: string
  depth: number | null
  status: SiteGraphVisualState
  glyph: string
  forceLabel: boolean
  zIndex: number
  /** True only for the server-identified crawl root. */
  isRoot: boolean
}

export interface SigmaSiteGraphEdgeAttributes extends Record<string, unknown> {
  size: number
  color: string
  baseColor: string
  followable: boolean
  occurrences: number
  isTemplate: boolean
  type: 'line'
  zIndex: number
}

export type SigmaSiteGraph = MultiDirectedGraph<
  SigmaSiteGraphNodeAttributes,
  SigmaSiteGraphEdgeAttributes
>

export interface BuiltSigmaSiteGraph {
  graph: SigmaSiteGraph
  layoutAvailable: boolean
  omittedNodes: number
  omittedEdges: number
}

const SEARCH_RESULT_LIMIT = 50
/** Keep high-degree page focus useful without flooding the canvas with labels. */
export const SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT = 8
/** Sigma's fitted first paint is ratio 1; deeper labels appear after a real zoom-in. */
export const SITE_GRAPH_OVERVIEW_CAMERA_RATIO = 0.75

/**
 * How many page labels the canvas may draw at once, by camera ratio.
 *
 * A fitted 50-page map used to draw all 50 labels on top of each other. The
 * budget is spent on the pages a reader would look for first: the root, then
 * the best-linked pages. Zooming in raises the budget because the same labels
 * now have more room, and an unbounded final tier keeps a zoomed-in view
 * complete.
 */
export const SITE_GRAPH_LABEL_BUDGETS = [
  { maxRatio: 0.2, budget: Number.POSITIVE_INFINITY },
  { maxRatio: 0.45, budget: 60 },
  { maxRatio: SITE_GRAPH_OVERVIEW_CAMERA_RATIO, budget: 24 },
] as const
/** The fitted overview: the root plus the best-linked handful. */
export const SITE_GRAPH_OVERVIEW_LABEL_BUDGET = 10

export function siteGraphLabelBudget(cameraRatio: number): number {
  for (const tier of SITE_GRAPH_LABEL_BUDGETS) {
    if (cameraRatio <= tier.maxRatio) return tier.budget
  }
  return SITE_GRAPH_OVERVIEW_LABEL_BUDGET
}

/**
 * How wide a rendered label may get, in characters.
 *
 * Sigma keeps labels apart with a grid (`labelGridCellSize`), which assumes a
 * label is roughly as wide as its cell. A deep path is not: on a real site
 * `/apartments/atlanta-metro/dunwoody-apts/` renders about twice the cell
 * width, so labels chosen from neighbouring cells overlap and stack into an
 * unreadable smear. Bounding the TEXT is what makes the grid's assumption true;
 * widening the grid instead would just drop labels that do fit.
 */
const SITE_GRAPH_LABEL_MAX_CHARS = 24

/**
 * Shorten a path for display, keeping the LAST segment.
 *
 * The leaf is what identifies a page to a reader — `dunwoody-apts` says which
 * node this is, while a shared `/apartments/atlanta-metro/` prefix says only
 * which neighbourhood of the graph it sits in, something the layout already
 * shows. The full path stays on the node's `path` attribute for the hover card,
 * so nothing is lost, only deferred to the moment a reader asks for it.
 */
export function siteGraphDisplayPath(path: string, maxChars = SITE_GRAPH_LABEL_MAX_CHARS): string {
  const value = path || '/'
  if (value.length <= maxChars) return value
  const trailingSlash = value.endsWith('/') && value.length > 1
  const segments = value.split('/').filter(Boolean)
  const leaf = segments.at(-1)
  if (!leaf) return value.slice(0, maxChars - 1) + '…'
  const tail = `/${leaf}${trailingSlash ? '/' : ''}`
  // A leaf that is itself too long is cut from its END: the start of a slug
  // ("dunwoody-apts-phase-two") is the identifying part.
  if (tail.length + 2 > maxChars) return `…${tail.slice(0, maxChars - 2)}…`
  return `…${tail}`
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedScore(node: SiteGraphSigmaNode): number {
  return Math.max(0, Math.min(1, node.linkScoreNormalized ?? 0))
}

/**
 * Server snapshots own health state. The exact-contract derivation is only a
 * compatibility path for historical snapshots that predate that field.
 */
export function siteGraphVisualState(node: SiteGraphHealthSource): SiteGraphVisualState {
  if (node.healthState) return node.healthState
  return deriveSiteHealthState(node)
}

/**
 * Customer-facing vocabulary for the four node states. Three closed maps over
 * the same union, so a new state is a compile error in all of them and the
 * pill, the legend, and the tooltip can never drift apart.
 *
 * "Indexable" is deliberately not "Indexed": a crawl only observes what the
 * site PERMITS, never whether an engine actually indexed the page.
 */
export function siteGraphStatusLabel(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return 'Indexable'
    case 'hidden': return 'Hidden'
    case 'resource': return 'Not a page'
    case 'redirect': return 'Moved'
    case 'failed': return 'Broken'
    case 'unchecked': return 'Not checked'
  }
}

/** The legend has room to be precise where a pill does not. */
export function siteGraphStatusLegendLabel(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return 'Indexable'
    case 'hidden': return 'Hidden or points elsewhere'
    case 'resource': return 'Not a page'
    case 'redirect': return 'Moved'
    case 'failed': return 'Broken'
    case 'unchecked': return 'Not checked'
  }
}

/** Plain-word explanation, used as the tooltip on pills and legend entries. */
export function siteGraphStatusDescription(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return 'AI and search engines are allowed to index this page'
    case 'hidden': return 'This page tells them not to index it, or points them to another page'
    case 'resource': return 'A file rather than a page, such as a text file or a PDF. Answer engines can still read it'
    case 'redirect': return 'This address sends visitors to another page'
    case 'failed': return 'This page could not be loaded'
    case 'unchecked': return 'This page was found but not checked'
  }
}

/** Redundant non-color cue used in canvas labels, search results, and legend. */
export function siteGraphStatusGlyph(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return '●'
    case 'hidden': return '◆'
    case 'resource': return '▪'
    case 'redirect': return '↗'
    case 'failed': return '×'
    case 'unchecked': return '○'
  }
}

/**
 * Root identity is server-owned (`rootNodeKey` on the graph read). There is no
 * path or depth fallback on purpose: marking the wrong page as the site's
 * entry point on a guess would be worse than marking none.
 */
export function isSiteGraphRootNode(
  node: SiteGraphHealthSource & { nodeKey: string },
  rootNodeKey: string | null | undefined,
): boolean {
  return Boolean(rootNodeKey) && node.nodeKey === rootNodeKey
}

export function siteGraphNodeSize(node: SiteGraphSigmaNode, isRoot = false, nodeCount = 1): number {
  const maxSize = siteGraphMaxNodeSize(nodeCount)
  const importanceSize = SITE_GRAPH_NODE_MIN_SIZE
    + Math.sqrt(normalizedScore(node)) * (maxSize - SITE_GRAPH_NODE_MIN_SIZE)
  return isRoot ? Math.max(siteGraphRootNodeSize(nodeCount), importanceSize) : importanceSize
}

function nodeColor(state: SiteGraphVisualState, theme: SigmaSiteGraphTheme): string {
  switch (state) {
    case 'eligible': return theme.eligible
    case 'hidden': return theme.hidden
    case 'resource': return theme.resource
    case 'redirect': return theme.redirect
    case 'failed': return theme.failed
    case 'unchecked': return theme.unchecked
  }
}

function edgeSize(occurrences: number): number {
  return 0.35 + Math.min(1.65, Math.log2(Math.max(1, occurrences) + 1) * 0.28)
}

function hasFinitePosition(node: SiteGraphSigmaNode): boolean {
  return Number.isFinite(node.x) && Number.isFinite(node.y)
}

/** Build a directed multigraph from already-positioned snapshot data. */
export function buildSigmaSiteGraph(
  inputNodes: readonly SiteGraphSigmaNode[],
  inputEdges: readonly SiteGraphSigmaEdge[],
  theme: SigmaSiteGraphTheme,
  rootNodeKey: string | null = null,
): BuiltSigmaSiteGraph {
  const graph = new MultiDirectedGraph<
    SigmaSiteGraphNodeAttributes,
    SigmaSiteGraphEdgeAttributes
  >({ allowSelfLoops: true })
  const nodesByKey = new Map<string, SiteGraphSigmaNode>()

  for (const node of inputNodes) {
    if (!nodesByKey.has(node.nodeKey)) nodesByKey.set(node.nodeKey, node)
  }

  for (const node of [...nodesByKey.values()].sort((left, right) => lexical(left.nodeKey, right.nodeKey))) {
    if (!hasFinitePosition(node)) continue
    const status = siteGraphVisualState(node)
    const color = nodeColor(status, theme)
    const glyph = siteGraphStatusGlyph(status)
    const isRoot = isSiteGraphRootNode(node, rootNodeKey)
    graph.addNode(node.nodeKey, {
      x: node.x,
      y: node.y,
      size: siteGraphNodeSize(node, isRoot, nodesByKey.size),
      color,
      baseColor: color,
      label: `${glyph} ${siteGraphDisplayPath(node.path)}`,
      nodeKey: node.nodeKey,
      url: node.url,
      path: node.path,
      depth: node.depth,
      status,
      glyph,
      forceLabel: isRoot || node.depth === 0 || node.path.trim() === '/',
      zIndex: isRoot ? 2 : node.depth === 0 ? 1 : 0,
      isRoot,
    })
  }

  const seenEdgeKeys = new Set<string>()
  for (const edge of [...inputEdges].sort((left, right) => lexical(left.edgeKey, right.edgeKey))) {
    if (
      seenEdgeKeys.has(edge.edgeKey)
      || !edge.targetNodeKey
      || !graph.hasNode(edge.sourceNodeKey)
      || !graph.hasNode(edge.targetNodeKey)
    ) continue
    seenEdgeKeys.add(edge.edgeKey)
    graph.addDirectedEdgeWithKey(edge.edgeKey, edge.sourceNodeKey, edge.targetNodeKey, {
      size: edgeSize(edge.occurrences),
      color: theme.edge,
      baseColor: theme.edge,
      followable: edge.followable,
      occurrences: edge.occurrences,
      isTemplate: edge.isTemplate === true,
      type: 'line',
      zIndex: 0,
    })
  }

  return {
    graph,
    layoutAvailable: inputNodes.length === 0 || graph.order > 0,
    omittedNodes: Math.max(0, inputNodes.length - graph.order),
    omittedEdges: Math.max(0, inputEdges.length - graph.size),
  }
}

export function findSiteGraphNodes(
  nodes: readonly SiteGraphSigmaNode[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SiteGraphSigmaNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const boundedLimit = Math.max(0, Math.min(SEARCH_RESULT_LIMIT, Math.floor(limit)))
  return [...nodes]
    .sort((left, right) => lexical(left.path || left.url, right.path || right.url) || lexical(left.nodeKey, right.nodeKey))
    .filter((node) => {
      if (!hasFinitePosition(node)) return false
      if (!normalizedQuery) return true
      return `${node.path}\n${node.url}\n${node.nodeKey}`.toLocaleLowerCase().includes(normalizedQuery)
    })
    .slice(0, boundedLimit)
}

export interface SigmaSiteGraphReducers {
  nodeReducer: (
    nodeKey: string,
    attributes: SigmaSiteGraphNodeAttributes,
  ) => Partial<SigmaSiteGraphNodeAttributes>
  edgeReducer: (
    edgeKey: string,
    attributes: SigmaSiteGraphEdgeAttributes,
  ) => Partial<SigmaSiteGraphEdgeAttributes> & { hidden?: boolean }
}

/**
 * Reducers provide focus-on-neighborhood interaction without mutating the
 * graph. A zoomed-out overview keeps only the root and top-level labels while
 * hiding unrelated edges to protect legibility.
 */
export function createSigmaSiteGraphReducers(
  graph: SigmaSiteGraph,
  focusNodeKey: string | null,
  /**
   * A NUMBER pins one camera state (tests do this). A GETTER is read on every
   * reduce, which is what the live renderer passes: Sigma calls reducers during
   * paint, so a getter cannot go stale the way a captured boolean can. That
   * staleness is why a fitted first paint could draw the zoomed-in view.
   */
  cameraRatio: number | (() => number),
  theme: SigmaSiteGraphTheme,
  /**
   * Nav and footer links are hidden by REDUCING them away, never by handing
   * Sigma a different graph. Rebuilding the graph made react-sigma tear down
   * and recreate the whole renderer on a checkbox, which is both wasteful and
   * the source of a crash (a child effect keyed on the graph fired against the
   * instance the parent had just killed).
   */
  showTemplateLinks = true,
): SigmaSiteGraphReducers {
  const hasFocus = Boolean(focusNodeKey && graph.hasNode(focusNodeKey))
  const focused = hasFocus ? focusNodeKey : null
  const readRatio = typeof cameraRatio === 'function' ? cameraRatio : () => cameraRatio

  /**
   * Pages ranked by what a reader looks for first: the root, then size (which
   * encodes internal-link importance), then shallower, then path. Computed
   * once per reducer set; the budget slices it per paint.
   */
  const rankedNodeKeys = graph.nodes().sort((leftKey, rightKey) => {
    const left = graph.getNodeAttributes(leftKey)
    const right = graph.getNodeAttributes(rightKey)
    return Number(right.isRoot) - Number(left.isRoot)
      || right.size - left.size
      || (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER)
      || lexical(left.path, right.path)
      || lexical(leftKey, rightKey)
  })
  const labelRankByKey = new Map(rankedNodeKeys.map((nodeKey, rank) => [nodeKey, rank]))

  // Computed ONCE per reducer set. It does not depend on the camera, only on
  // the focus, so building it inside nodeReducer re-sorted the whole
  // neighbourhood for every node of every frame.
  const focusedNeighborLabelCandidates = new Set(
    focused
      ? graph.neighbors(focused)
        .filter((nodeKey) => nodeKey !== focused)
        .sort((leftKey, rightKey) => (labelRankByKey.get(leftKey) ?? 0) - (labelRankByKey.get(rightKey) ?? 0))
        .slice(0, SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT)
      : [],
  )

  return {
    nodeReducer: (nodeKey, attributes) => {
      const ratio = readRatio()
      const overview = ratio > SITE_GRAPH_OVERVIEW_CAMERA_RATIO
      // The crawl root anchors the whole map, so it keeps its label and its
      // marker in every view: zoomed out, and while another neighborhood has
      // focus. Nothing about its internal-link score can hide it.
      if (attributes.isRoot) {
        return nodeKey === focused
          ? { ...attributes, size: attributes.size * 1.35, forceLabel: true, zIndex: 3 }
          : { ...attributes, forceLabel: true }
      }
      if (focused) {
        // The selected or hovered page is always named, at any zoom.
        if (nodeKey === focused) {
          return {
            ...attributes,
            size: attributes.size * 1.35,
            forceLabel: true,
            zIndex: 3,
          }
        }
        if (graph.areNeighbors(nodeKey, focused)) {
          if (!overview) return attributes
          return focusedNeighborLabelCandidates.has(nodeKey)
            ? { ...attributes, forceLabel: false }
            : { ...attributes, forceLabel: false, label: '' }
        }
        return {
          ...attributes,
          color: theme.dimmedNode,
          forceLabel: false,
          label: '',
          zIndex: 0,
        }
      }
      // Unfocused: spend the zoom-dependent label budget on the best-ranked
      // pages and drop the rest, so labels never pile into unreadable text.
      const budget = siteGraphLabelBudget(ratio)
      if (budget === Number.POSITIVE_INFINITY) return attributes
      const rank = labelRankByKey.get(nodeKey) ?? Number.MAX_SAFE_INTEGER
      if (rank < budget) return { ...attributes, forceLabel: true }
      return { ...attributes, forceLabel: false, label: '' }
    },
    edgeReducer: (edgeKey, attributes) => {
      if (attributes.isTemplate && !showTemplateLinks) return { ...attributes, hidden: true }
      const overview = readRatio() > SITE_GRAPH_OVERVIEW_CAMERA_RATIO
      const [sourceNodeKey, targetNodeKey] = graph.extremities(edgeKey)
      const highlighted = Boolean(
        focused && (sourceNodeKey === focused || targetNodeKey === focused),
      )
      // A hovered or selected page always shows its own links, even fitted.
      if (highlighted) {
        return {
          ...attributes,
          color: theme.edgeActive,
          size: Math.max(1.4, attributes.size),
          zIndex: 2,
        }
      }
      if (overview) return { ...attributes, hidden: true }
      if (focused) {
        return {
          ...attributes,
          color: theme.edgeDimmed,
          size: Math.min(0.45, attributes.size),
          zIndex: 0,
        }
      }
      return attributes
    },
  }
}

