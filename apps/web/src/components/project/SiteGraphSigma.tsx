import {
  Component,
  type ErrorInfo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Maximize2, Minus, Plus, Search } from 'lucide-react'
import type Sigma from 'sigma'
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from 'sigma/rendering'
import type { Settings } from 'sigma/settings'
import type {
  CameraState,
  SigmaNodeEventPayload,
  SigmaStageEventPayload,
} from 'sigma/types'
import type { AnimateOptions } from 'sigma/utils'

import { SITE_GRAPH_LEGEND_STATES, type SiteCrawlGraphLayoutUnavailableReason } from '@ainyc/canonry-contracts'

import { cn } from '../../lib/utils.js'
import { recordUiError } from '../../lib/ui-telemetry.js'
import { displayPageLabel, siteHostFromUrl } from './site-health-paths.js'
import { Button } from '../ui/button.js'
import {
  buildSigmaSiteGraph,
  createSigmaSiteGraphReducers,
  findSiteGraphNodes,
  isSigmaWebGlColor,
  SITE_GRAPH_COLOR_TOKENS,
  SITE_GRAPH_SIGMA_COLOR_TOKENS,
  SITE_GRAPH_OVERVIEW_CAMERA_RATIO,
  siteGraphLabelBudget,
  siteGraphStatusDescription,
  siteGraphStatusGlyph,
  siteGraphStatusLabel,
  siteGraphStatusLegendLabel,
  siteGraphVisualState,
  type SigmaSiteGraph,
  type SigmaSiteGraphEdgeAttributes,
  type SigmaSiteGraphNodeAttributes,
  type SigmaSiteGraphTheme,
  type SiteGraphSigmaEdge,
  type SiteGraphSigmaNode,
} from './site-graph-sigma.js'

export type { SiteGraphSigmaEdge, SiteGraphSigmaNode } from './site-graph-sigma.js'

export interface SiteGraphSigmaProps {
  nodes: readonly SiteGraphSigmaNode[]
  edges: readonly SiteGraphSigmaEdge[]
  layoutState?: 'ready' | 'unavailable'
  layoutUnavailableReason?: SiteCrawlGraphLayoutUnavailableReason | null
  /** Server-identified crawl root. Without it no page gets the root marker. */
  rootNodeKey?: string | null
  /**
   * Nav and footer links are hidden through the edge reducer, so flipping this
   * never changes the graph and never rebuilds the renderer. Pages cannot move
   * as a result, which is what the toggle promises.
   */
  showTemplateLinks?: boolean
  selectedNodeKey?: string | null
  onSelectNode?: (node: SiteGraphSigmaNode) => void
  onOpenInventory?: () => void
  ariaLabel?: string
  className?: string
}

/**
 * Closed map over the contract's `layout.unavailable.reason`, so a new reason
 * is a compile error rather than silently falling back to generic copy. The
 * distinction the reader needs is "no map was made" vs "making it failed",
 * because only the second is worth retrying immediately.
 */
const LAYOUT_UNAVAILABLE_COPY: Record<SiteCrawlGraphLayoutUnavailableReason, { heading: string; detail: string }> = {
  'layout-failed': {
    heading: 'Map could not be built',
    detail: 'The map could not be created for this scan. Run a new scan to try again.',
  },
  'no-crawl': {
    heading: 'No map yet',
    detail: 'This scan has no map yet. Run a new scan to create one.',
  },
  'legacy-snapshot': {
    heading: 'No map yet',
    detail: 'This scan has no map yet. Run a new scan to create one.',
  },
  'details-unavailable': {
    heading: 'No map yet',
    detail: 'This scan has no map yet. Run a new scan to create one.',
  },
  'empty-crawl': {
    heading: 'No pages to map',
    detail: 'This scan found no pages to put on a map. Run a new scan to try again.',
  },
}

function unavailableLayoutMessage(
  reason?: SiteCrawlGraphLayoutUnavailableReason | null,
): { heading: string; detail: string } {
  // Persisted rows stay forward-compatible, so a value outside the union is
  // possible on the wire even though the type says otherwise.
  return (reason && LAYOUT_UNAVAILABLE_COPY[reason]) ?? LAYOUT_UNAVAILABLE_COPY['no-crawl']
}

interface HoveredNode {
  nodeKey: string
  left: number
  top: number
}

interface CameraActions {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  gotoNode: (nodeKey: string) => void
}

interface ReactSigmaEventHandlers {
  enterNode: (payload: SigmaNodeEventPayload) => void
  leaveNode: (payload: SigmaNodeEventPayload) => void
  clickNode: (payload: SigmaNodeEventPayload) => void
  clickStage: (payload: SigmaStageEventPayload) => void
  updated: (state: CameraState) => void
}

interface CameraHook {
  zoomIn: (options?: Partial<AnimateOptions> & { factor?: number }) => void
  zoomOut: (options?: Partial<AnimateOptions> & { factor?: number }) => void
  reset: (options?: Partial<AnimateOptions>) => void
  gotoNode: (nodeKey: string, options?: Partial<AnimateOptions>) => void
}

interface SigmaContainerProps {
  graph?: SigmaSiteGraph
  settings?: Partial<Settings<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes>>
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

interface ReactSigmaBindings {
  SigmaContainer: ComponentType<SigmaContainerProps>
  useCamera: () => CameraHook
  useRegisterEvents: () => (handlers: Partial<ReactSigmaEventHandlers>) => void
  useSigma: () => Sigma<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes>
}

interface GraphRenderBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetToken: unknown
}

interface GraphRenderBoundaryState {
  failed: boolean
}

/** Exported for tests. */
export class GraphRenderBoundary extends Component<GraphRenderBoundaryProps, GraphRenderBoundaryState> {
  override state: GraphRenderBoundaryState = { failed: false }

  static getDerivedStateFromError(): GraphRenderBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced, never swallowed: this is the only record of WHY the map died,
    // and the state it puts on screen deliberately does not blame the browser.
    console.error('[SiteGraphSigma] the map failed to render', error, info.componentStack)
    // Class name and the page it happened on only: never the message or stack.
    recordUiError({ kind: 'render', error, component: 'site-graph' })
  }

  override componentDidUpdate(previousProps: GraphRenderBoundaryProps): void {
    if (this.state.failed && previousProps.resetToken !== this.props.resetToken) {
      this.setState({ failed: false })
    }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const CAMERA_ANIMATION_MS = 220



function cameraAnimationMs(): number {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : CAMERA_ANIMATION_MS
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`
}

function resolvedCssColor(
  element: HTMLElement,
  customProperty: string,
  fallback: string,
): string {
  const computed = window.getComputedStyle(element)
  const direct = computed.getPropertyValue(customProperty).trim()
  if (direct && !direct.includes('var(') && isSigmaWebGlColor(direct)) return direct

  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.color = `var(${customProperty})`
  element.appendChild(probe)
  const resolved = window.getComputedStyle(probe).color.trim()
  probe.remove()
  return resolved && !resolved.includes('var(') && isSigmaWebGlColor(resolved) ? resolved : fallback
}

function sigmaTheme(element: HTMLElement): SigmaSiteGraphTheme {
  const color = (binding: keyof typeof SITE_GRAPH_SIGMA_COLOR_TOKENS) => {
    const token = SITE_GRAPH_SIGMA_COLOR_TOKENS[binding]
    return resolvedCssColor(element, token.property, token.fallback)
  }
  return {
    eligible: color('eligible'),
    hidden: color('hidden'),
    resource: color('resource'),
    redirect: color('redirect'),
    failed: color('failed'),
    unchecked: color('unchecked'),
    dimmedNode: color('dimmedNode'),
    edge: color('edge'),
    edgeDimmed: color('edgeDimmed'),
    edgeActive: color('edgeActive'),
    label: color('label'),
    background: color('background'),
  }
}

/**
 * The label text is drawn here rather than delegated to Sigma's
 * `drawDiscNodeLabel`: importing `sigma/rendering` for a value touches
 * `WebGL2RenderingContext` at module load, which does not exist during SSR or
 * in jsdom. The geometry below matches Sigma's own disc-label placement.
 */
function createSiteGraphNodeLabelRenderer(
  theme: SigmaSiteGraphTheme,
): NodeLabelDrawingFunction<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes> {
  return (context, data, settings) => {
    if (!data.label) return
    context.save()
    context.fillStyle = settings.labelColor.color ?? theme.label
    context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`
    context.fillText(data.label, data.x + data.size + 3, data.y + settings.labelSize / 3)
    context.restore()
  }
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const corner = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + corner, y)
  context.lineTo(x + width - corner, y)
  context.arcTo(x + width, y, x + width, y + corner, corner)
  context.lineTo(x + width, y + height - corner)
  context.arcTo(x + width, y + height, x + width - corner, y + height, corner)
  context.lineTo(x + corner, y + height)
  context.arcTo(x, y + height, x, y + height - corner, corner)
  context.lineTo(x, y + corner)
  context.arcTo(x, y, x + corner, y, corner)
  context.closePath()
}

function createSiteGraphNodeHoverRenderer(
  theme: SigmaSiteGraphTheme,
): NodeHoverDrawingFunction<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes> {
  return (context, data, settings) => {
    const label = typeof data.label === 'string' ? data.label : null
    const labelHeight = settings.labelSize + 10
    const labelX = data.x + data.size + 7
    const labelY = data.y - labelHeight / 2

    context.save()
    context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`

    // Repaint the hovered node so its status color survives the contrast ring.
    context.fillStyle = theme.background
    context.strokeStyle = theme.edgeActive
    context.lineWidth = 1.5
    context.beginPath()
    context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.fillStyle = data.color
    context.beginPath()
    context.arc(data.x, data.y, data.size, 0, Math.PI * 2)
    context.fill()

    if (label) {
      const labelWidth = Math.ceil(context.measureText(label).width) + 16
      roundedRectPath(context, labelX, labelY, labelWidth, labelHeight, 5)
      context.fillStyle = theme.background
      context.fill()
      context.strokeStyle = theme.edgeActive
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = theme.label
      context.textBaseline = 'middle'
      context.fillText(label, labelX + 8, data.y)
    }

    context.restore()
  }
}

function supportsWebGl(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * The browser genuinely cannot run the map. Probed once, at mount.
 */
function GraphUnavailableState({ onOpenInventory }: { onOpenInventory?: () => void }) {
  return (
    <div className="flex h-full min-h-80 items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <p className="text-sm font-medium text-heading">Interactive map unavailable</p>
        <p className="mt-1 text-sm text-secondary">
          This browser could not start WebGL. The page inventory remains available for the complete crawl.
        </p>
        {onOpenInventory && (
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={onOpenInventory}>Open page inventory</Button>
        )}
      </div>
    </div>
  )
}

/**
 * WE failed to draw, in a browser that has already proved it can. Saying
 * "WebGL is unavailable" here sends the reader to debug their machine for our
 * bug, so this state owns the failure and offers the only useful action.
 */
function GraphRenderFailedState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-80 items-center justify-center px-6 text-center" role="alert">
      <div className="max-w-md">
        <p className="text-sm font-medium text-heading">The map could not be drawn</p>
        <p className="mt-1 text-sm text-secondary">
          Something went wrong while drawing this map. The page inventory below is unaffected.
        </p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>
      </div>
    </div>
  )
}

interface SigmaRuntimeProps {
  reactSigma: ReactSigmaBindings
  graph: SigmaSiteGraph
  theme: SigmaSiteGraphTheme
  selectedNodeKey: string | null
  showTemplateLinks: boolean
  onSelectNodeKey: (nodeKey: string) => void
  onHoverNode: (hovered: HoveredNode | null) => void
  onCameraReady: (actions: CameraActions | null) => void
}

function SigmaRuntime({
  reactSigma,
  graph,
  theme,
  selectedNodeKey,
  showTemplateLinks,
  onSelectNodeKey,
  onHoverNode,
  onCameraReady,
}: SigmaRuntimeProps) {
  const { useSigma, useRegisterEvents, useCamera } = reactSigma
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const { zoomIn, zoomOut, reset, gotoNode } = useCamera()
  const [hoveredNodeKey, setHoveredNodeKey] = useState<string | null>(null)
  const focusNodeKey = hoveredNodeKey ?? selectedNodeKey
  const pendingRefreshRef = useRef<number | null>(null)
  /** What the last paint was reduced against, so an unchanged zoom is free. */
  const lastPaintRef = useRef<{ overview: boolean; budget: number }>({
    overview: true,
    budget: Number.NaN,
  })

  useEffect(() => () => {
    if (pendingRefreshRef.current !== null) cancelAnimationFrame(pendingRefreshRef.current)
  }, [])

  useEffect(() => {
    const duration = cameraAnimationMs()
    onCameraReady({
      zoomIn: () => zoomIn({ duration }),
      zoomOut: () => zoomOut({ duration }),
      reset: () => reset({ duration }),
      gotoNode: (nodeKey) => gotoNode(nodeKey, { duration }),
    })
    return () => onCameraReady(null)
  }, [gotoNode, onCameraReady, reset, zoomIn, zoomOut])

  useEffect(() => {
    registerEvents({
      enterNode: ({ node, event }) => {
        setHoveredNodeKey(node)
        onHoverNode({
          nodeKey: node,
          left: Number.isFinite(event.x) ? event.x + 14 : 20,
          top: Number.isFinite(event.y) ? event.y + 14 : 20,
        })
      },
      leaveNode: () => {
        setHoveredNodeKey(null)
        onHoverNode(null)
      },
      clickNode: ({ node }) => onSelectNodeKey(node),
      clickStage: () => onHoverNode(null),
      // Sigma applies reducers only inside its own `process()`, which runs on
      // `refresh()`. Reading the ratio at paint time therefore fixes the FIRST
      // paint only: without this listener, zooming never re-evaluates the
      // label budget and never toggles overview edge hiding. Coalesced onto an
      // animation frame so a pan-zoom gesture triggers one refresh per frame
      // rather than one per camera event.
      updated: () => {
        if (pendingRefreshRef.current !== null) return
        pendingRefreshRef.current = requestAnimationFrame(() => {
          pendingRefreshRef.current = null
          const nextOverview = sigma.getCamera().getState().ratio > SITE_GRAPH_OVERVIEW_CAMERA_RATIO
          // Only the overview threshold and the label budget tier change what
          // the reducers emit, so a refresh is skipped while neither moved.
          const nextBudget = siteGraphLabelBudget(sigma.getCamera().getState().ratio)
          if (nextOverview === lastPaintRef.current.overview && nextBudget === lastPaintRef.current.budget) return
          lastPaintRef.current = { overview: nextOverview, budget: nextBudget }
          sigma.refresh()
        })
      },
    })
  }, [onHoverNode, onSelectNodeKey, registerEvents, sigma])

  useEffect(() => {
    // The reducers read the camera ratio at paint time rather than closing
    // over a snapshot of it. A captured value had to be re-synced by a camera
    // event, and the fitted FIRST paint fires no such event, so a dense map
    // opened with its zoomed-in treatment: every label drawn and the whole
    // edge mesh visible. Reading live also means pan and zoom never need a
    // full 20k/50k graph refresh to stay correct.
    // Applying settings to an instance whose graph is not this one would be
    // writing to a renderer react-sigma is about to replace, or has already
    // killed: on a graph change React runs THIS effect (a child) between the
    // container's cleanup and its re-creation. Waiting for the matching
    // instance is what keeps that ordering from throwing.
    if (sigma.getGraph() !== graph) return
    const reducers = createSigmaSiteGraphReducers(
      graph,
      focusNodeKey,
      () => sigma.getCamera().getState().ratio,
      theme,
      showTemplateLinks,
    )
    sigma.setSetting('nodeReducer', reducers.nodeReducer)
    sigma.setSetting('edgeReducer', reducers.edgeReducer)
    const ratio = sigma.getCamera().getState().ratio
    lastPaintRef.current = {
      overview: ratio > SITE_GRAPH_OVERVIEW_CAMERA_RATIO,
      budget: siteGraphLabelBudget(ratio),
    }
    sigma.refresh()
    // Do not reset settings during cleanup. React Sigma kills its WebGL
    // programs before descendant effects can clean up; reconfiguring that
    // destroyed instance schedules a refresh with no `circle` program. A live
    // instance is overwritten by the next effect, and an unmounted one needs
    // no reset.
  }, [focusNodeKey, graph, showTemplateLinks, sigma, theme])

  return null
}

export function SiteGraphSigma({
  nodes,
  edges,
  layoutState = 'ready',
  layoutUnavailableReason,
  rootNodeKey = null,
  showTemplateLinks = true,
  selectedNodeKey,
  onSelectNode,
  onOpenInventory,
  ariaLabel,
  className,
}: SiteGraphSigmaProps) {
  const wrapperRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const cameraActionsRef = useRef<CameraActions | null>(null)
  const searchId = useId()
  const listboxId = useId()
  const instructionsId = useId()
  const [theme, setTheme] = useState<SigmaSiteGraphTheme | null>(null)
  const [reactSigma, setReactSigma] = useState<ReactSigmaBindings | null>(null)
  const [rendererState, setRendererState] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [cameraReady, setCameraReady] = useState(false)
  const [internalSelectedNodeKey, setInternalSelectedNodeKey] = useState<string | null>(null)
  const [hovered, setHovered] = useState<HoveredNode | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  /** Bumping this remounts the renderer, which is what "Try again" means. */
  const [renderAttempt, setRenderAttempt] = useState(0)
  const lastControlledFocusRef = useRef<string | null>(null)
  const deferredSearchValue = useDeferredValue(searchValue)
  const effectiveSelectedNodeKey = selectedNodeKey === undefined
    ? internalSelectedNodeKey
    : selectedNodeKey
  const nodeByKey = useMemo(
    () => new Map(nodes.map((node) => [node.nodeKey, node])),
    [nodes],
  )
  // The canvas label is aria-hidden, so the search listbox, the tooltip, and
  // the live region are the accessible route to a page's name. They use the
  // same server-owned root identity the map does, never a path or host guess.
  const rootHost = useMemo(
    // Only the crawl root defines the site's host. `nodes[0]` is whatever the
    // sample happened to order first, which may be an off-site alias.
    () => siteHostFromUrl(rootNodeKey ? nodeByKey.get(rootNodeKey)?.url : null),
    [nodeByKey, rootNodeKey],
  )
  const pageLabel = useCallback(
    (node: SiteGraphSigmaNode) => displayPageLabel(node, rootHost),
    [rootHost],
  )
  const selectedNode = effectiveSelectedNodeKey
    ? nodeByKey.get(effectiveSelectedNodeKey) ?? null
    : null
  const hoveredNode = hovered ? nodeByKey.get(hovered.nodeKey) ?? null : null
  const searchResults = useMemo(
    () => findSiteGraphNodes(nodes, deferredSearchValue),
    [deferredSearchValue, nodes],
  )
  const hasFinitePosition = nodes.some((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
  const builtGraph = useMemo(
    () => theme ? buildSigmaSiteGraph(nodes, edges, theme, rootNodeKey) : null,
    [edges, nodes, rootNodeKey, theme],
  )
  const sigmaSettings = useMemo<Partial<Settings<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes>> | null>(() => theme ? ({
    allowInvalidContainer: true,
    defaultNodeColor: theme.unchecked,
    defaultEdgeColor: theme.edge,
    defaultEdgeType: 'line' as const,
    enableCameraPanning: true,
    enableCameraZooming: true,
    enableCameraRotation: false,
    enableEdgeEvents: false,
    hideEdgesOnMove: true,
    hideLabelsOnMove: true,
    itemSizesReference: 'screen' as const,
    defaultDrawNodeHover: createSiteGraphNodeHoverRenderer(theme),
    defaultDrawNodeLabel: createSiteGraphNodeLabelRenderer(theme),
    labelColor: { color: theme.label },
    labelDensity: 0.07,
    labelGridCellSize: 140,
    labelFont: 'Geist Variable, Geist, sans-serif',
    labelRenderedSizeThreshold: 8,
    labelSize: 13,
    labelWeight: '600',
    maxCameraRatio: 12,
    minCameraRatio: 0.04,
    minEdgeThickness: 0.35,
    renderEdgeLabels: false,
    renderLabels: true,
    stagePadding: 42,
    zIndex: true,
  }) : null, [theme])

  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return
    const updateTheme = () => setTheme(sigmaTheme(element))
    updateTheme()

    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (nodes.length === 0 || layoutState === 'unavailable' || !hasFinitePosition) {
      setRendererState('checking')
      return
    }
    setRendererState(supportsWebGl() ? 'ready' : 'unavailable')
  }, [hasFinitePosition, layoutState, nodes.length])

  useEffect(() => {
    if (rendererState !== 'ready') {
      setReactSigma(null)
      return
    }
    let active = true
    void import('@react-sigma/core')
      .then((module) => {
        if (active) setReactSigma(module as unknown as ReactSigmaBindings)
      })
      .catch(() => {
        if (active) setRendererState('unavailable')
      })
    return () => {
      active = false
    }
  }, [rendererState])

  useEffect(() => {
    setActiveResultIndex(0)
  }, [deferredSearchValue])

  const handleCameraReady = useCallback((actions: CameraActions | null) => {
    cameraActionsRef.current = actions
    setCameraReady(Boolean(actions))
  }, [])

  const handleHoverNode = useCallback((nextHovered: HoveredNode | null) => {
    setHovered(nextHovered)
  }, [])

  const selectNode = useCallback((nodeKey: string, moveCamera: boolean) => {
    const node = nodeByKey.get(nodeKey)
    if (!node) return
    if (selectedNodeKey === undefined) setInternalSelectedNodeKey(nodeKey)
    onSelectNode?.(node)
    if (moveCamera) cameraActionsRef.current?.gotoNode(nodeKey)
    setStatusMessage(`Focused ${pageLabel(node)}`)
  }, [nodeByKey, onSelectNode, pageLabel, selectedNodeKey])

  const handleSigmaSelect = useCallback((nodeKey: string) => {
    selectNode(nodeKey, false)
  }, [selectNode])

  useEffect(() => {
    if (!cameraReady || !selectedNodeKey || !nodeByKey.has(selectedNodeKey)) {
      if (!selectedNodeKey) lastControlledFocusRef.current = null
      return
    }
    if (lastControlledFocusRef.current === selectedNodeKey) return
    cameraActionsRef.current?.gotoNode(selectedNodeKey)
    lastControlledFocusRef.current = selectedNodeKey
  }, [cameraReady, nodeByKey, selectedNodeKey])

  const chooseSearchResult = (node: SiteGraphSigmaNode) => {
    selectNode(node.nodeKey, true)
    setSearchValue(pageLabel(node))
    setSearchOpen(false)
  }

  const closeSearchOnBlur = () => {
    window.setTimeout(() => {
      if (document.activeElement !== searchInputRef.current) setSearchOpen(false)
    }, 0)
  }

  const defaultAriaLabel = `Interactive site map showing ${plural(nodes.length, 'page')} and ${plural(edges.length, 'internal link')}`
  const optionId = (nodeKey: string) => `${listboxId}-${nodeKey.replaceAll(/[^\w-]/g, '-')}`
  const unavailableLayout = unavailableLayoutMessage(layoutUnavailableReason)

  if (layoutState === 'unavailable') {
    return (
      <section
        ref={wrapperRef}
        role="group"
        aria-label={ariaLabel ?? defaultAriaLabel}
        className={cn('flex min-h-80 items-center justify-center rounded-lg border border-default bg-surface-inset px-6 text-center', className)}
      >
        <div className="max-w-md">
          <p className="text-sm font-medium text-heading">{unavailableLayout.heading}</p>
          <p className="mt-1 text-sm text-secondary">{unavailableLayout.detail}</p>
          {onOpenInventory && (
            <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={onOpenInventory}>Open page inventory</Button>
          )}
        </div>
      </section>
    )
  }

  if (nodes.length === 0) {
    return (
      <section
        ref={wrapperRef}
        role="group"
        aria-label={ariaLabel ?? defaultAriaLabel}
        className={cn('flex min-h-80 items-center justify-center rounded-lg border border-default bg-surface-inset px-6 text-center', className)}
      >
        <div className="max-w-md">
          <p className="text-sm text-secondary">No page graph is available for this scan.</p>
          {onOpenInventory && (
            <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={onOpenInventory}>Open page inventory</Button>
          )}
        </div>
      </section>
    )
  }

  if (!hasFinitePosition) {
    return (
      <section
        ref={wrapperRef}
        role="group"
        aria-label={ariaLabel ?? defaultAriaLabel}
        className={cn('flex min-h-80 items-center justify-center rounded-lg border border-default bg-surface-inset px-6 text-center', className)}
      >
        <div className="max-w-md">
          <p className="text-sm font-medium text-heading">{unavailableLayout.heading}</p>
          <p className="mt-1 text-sm text-secondary">{unavailableLayout.detail}</p>
          {onOpenInventory && (
            <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={onOpenInventory}>Open page inventory</Button>
          )}
        </div>
      </section>
    )
  }

  const activeResult = searchResults.at(activeResultIndex)
  const fallback = <GraphRenderFailedState onRetry={() => setRenderAttempt((attempt) => attempt + 1)} />
  const SigmaContainerComponent = reactSigma?.SigmaContainer

  return (
    <section
      ref={wrapperRef}
      role="group"
      aria-label={ariaLabel ?? defaultAriaLabel}
      aria-describedby={instructionsId}
      className={cn(
        'flex h-[clamp(460px,62vh,680px)] min-h-[460px] flex-col overflow-hidden rounded-lg border border-default bg-surface-inset',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-subtle bg-bg-elevated/70 px-3 py-2">
        <label htmlFor={searchId} className="sr-only">Focus a page in the site map</label>
        <div className="relative min-w-56 max-w-lg flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            id={searchId}
            ref={searchInputRef}
            role="combobox"
            type="search"
            autoComplete="off"
            aria-label="Focus a page in the site map"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={searchOpen}
            aria-activedescendant={searchOpen && activeResult ? optionId(activeResult.nodeKey) : undefined}
            value={searchValue}
            placeholder={selectedNode ? `Focused: ${pageLabel(selectedNode)}` : 'Find a page'}
            className="h-10 w-full rounded-md border border-base bg-bg py-2 pl-9 pr-3 text-sm text-primary placeholder-mono-600 outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
            onFocus={() => setSearchOpen(true)}
            onBlur={closeSearchOnBlur}
            onChange={(event) => {
              setSearchValue(event.target.value)
              setSearchOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSearchOpen(true)
                setActiveResultIndex((current) => Math.max(0, Math.min(searchResults.length - 1, current + 1)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveResultIndex((current) => Math.max(0, current - 1))
              } else if (event.key === 'Enter' && searchOpen && activeResult) {
                event.preventDefault()
                chooseSearchResult(activeResult)
              } else if (event.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
          />
          {searchOpen && (
            <div className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-30 overflow-hidden rounded-md border border-base bg-bg shadow-lg">
              <div id={listboxId} role="listbox" aria-label="Matching pages" className="max-h-72 overflow-auto py-1">
                {searchResults.length > 0 ? searchResults.map((node, index) => {
                  const status = siteGraphVisualState(node)
                  return (
                    <button
                      key={node.nodeKey}
                      id={optionId(node.nodeKey)}
                      type="button"
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      className={cn(
                        'flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm outline-none',
                        index === activeResultIndex ? 'bg-surface-active text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary',
                      )}
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveResultIndex(index)}
                      onClick={() => chooseSearchResult(node)}
                    >
                      <span className="min-w-0 truncate font-mono">{pageLabel(node)}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
                        <span
                          className="font-mono font-semibold"
                          style={{ color: `var(${SITE_GRAPH_COLOR_TOKENS[status].property})` }}
                          aria-hidden="true"
                        >
                          {siteGraphStatusGlyph(status)}
                        </span>
                        <span title={siteGraphStatusDescription(status)}>{siteGraphStatusLabel(status)}</span>
                      </span>
                    </button>
                  )
                }) : (
                  <p className="px-3 py-4 text-sm text-secondary">No rendered pages match.</p>
                )}
              </div>
              {searchResults.length === 50 && (
                <p className="border-t border-subtle px-3 py-2 text-[13px] text-muted">
                  First 50 matches. Refine the search or use the full page inventory.
                </p>
              )}
            </div>
          )}
        </div>
        <span className="text-[13px] tabular-nums text-muted">
          {plural(nodes.length, 'page')} · {plural(edges.length, 'link')}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {rendererState === 'unavailable' ? <GraphUnavailableState onOpenInventory={onOpenInventory} /> : rendererState === 'checking' || !theme || !builtGraph || !sigmaSettings || !reactSigma || !SigmaContainerComponent ? (
          <div className="flex h-full min-h-80 items-center justify-center px-6 text-center" role="status">
            <p className="text-sm text-secondary">Preparing the interactive site map...</p>
          </div>
        ) : (
          <GraphRenderBoundary fallback={fallback} resetToken={renderAttempt}>
            <div aria-hidden="true" className="absolute inset-0">
              <SigmaContainerComponent
                graph={builtGraph.graph}
                className="relative size-full bg-bg [&_.sigma-container]:size-full"
                style={{ width: '100%', height: '100%', background: theme.background }}
                settings={sigmaSettings}
              >
                <SigmaRuntime
                  reactSigma={reactSigma}
                  graph={builtGraph.graph}
                  theme={theme}
                  selectedNodeKey={effectiveSelectedNodeKey}
                  showTemplateLinks={showTemplateLinks}
                  onSelectNodeKey={handleSigmaSelect}
                  onHoverNode={handleHoverNode}
                  onCameraReady={handleCameraReady}
                />
              </SigmaContainerComponent>
            </div>

            <div className="absolute right-3 top-3 z-20 flex flex-col overflow-hidden rounded-md border border-base bg-bg shadow-lg">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-none border-b border-subtle"
                aria-label="Zoom in"
                disabled={!cameraReady}
                onClick={() => cameraActionsRef.current?.zoomIn()}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-none border-b border-subtle"
                aria-label="Zoom out"
                disabled={!cameraReady}
                onClick={() => cameraActionsRef.current?.zoomOut()}
              >
                <Minus className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-none"
                aria-label="Fit site map"
                disabled={!cameraReady}
                onClick={() => cameraActionsRef.current?.reset()}
              >
                <Maximize2 className="size-4" aria-hidden="true" />
              </Button>
            </div>

            {hoveredNode && hovered && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-20 max-w-64 rounded-md border border-base bg-bg/95 px-3 py-2 shadow-lg"
                style={{ left: hovered.left, top: hovered.top }}
              >
                <p className="truncate font-mono text-[13px] font-medium text-heading">{pageLabel(hoveredNode)}</p>
                {/* The status WORD stays, and leads: it is the only thing tying
                    this node back to the legend and to the pill in the table.
                    The plain-word sentence explains it, it does not replace it. */}
                <p className="mt-1 text-[13px] font-medium text-heading">
                  {siteGraphStatusLabel(siteGraphVisualState(hoveredNode))}
                </p>
                <p className="mt-0.5 text-[13px] text-secondary">
                  {siteGraphStatusDescription(siteGraphVisualState(hoveredNode))}
                </p>
                {hoveredNode.depth != null && (
                  <p className="mt-1 text-[13px] text-secondary">
                    {plural(hoveredNode.depth, 'click')} from home
                  </p>
                )}
                {hoveredNode.auditScore != null && (
                  <p className="mt-1 text-[13px] tabular-nums text-heading">
                    Score {Math.round(hoveredNode.auditScore)}/100
                  </p>
                )}
              </div>
            )}
          </GraphRenderBoundary>
        )}
      </div>

      <div aria-label="Site map legend" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-subtle bg-bg-elevated/50 px-3 py-2 text-[13px] text-secondary">
        {SITE_GRAPH_LEGEND_STATES.map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5" title={siteGraphStatusDescription(status)}>
            <span
              className="w-3 text-center font-mono text-[15px] font-semibold leading-none"
              style={{ color: `var(${SITE_GRAPH_COLOR_TOKENS[status].property})` }}
              aria-hidden="true"
            >
              {siteGraphStatusGlyph(status)}
            </span>
            {siteGraphStatusLegendLabel(status)}
          </span>
        ))}
        <span className="ml-auto">Bigger = more linked</span>
        {builtGraph && (builtGraph.omittedNodes > 0 || builtGraph.omittedEdges > 0) && (
          <span className="text-caution">Some records lacked valid layout data.</span>
        )}
      </div>

      <p id={instructionsId} className="sr-only">
        The WebGL map supports pointer, wheel, and touch navigation. Use the page search to focus a rendered page. Use the full page inventory for an accessible list of every crawled page and its links.
      </p>
      <p role="status" aria-live="polite" className="sr-only">{statusMessage}</p>
    </section>
  )
}
