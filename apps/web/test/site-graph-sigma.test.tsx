import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { parseColor, parseFontString } from 'sigma/utils'
import type { SigmaOptions } from 'sigma/types'
import type { SigmaSiteGraph, SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes } from '../src/components/project/site-graph-sigma.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let evaluateNodeStyle: typeof import('sigma/types').evaluateNodeStyle
let evaluateEdgeStyle: typeof import('sigma/types').evaluateEdgeStyle

beforeAll(async () => {
  // Sigma's public style evaluators share a module with GPU primitives. Only
  // their import-time constants need a shim; canvas capability remains real
  // to each test's getContext fixture, and SSR is checked in its own file.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebGL2RenderingContext')
  Object.defineProperty(globalThis, 'WebGL2RenderingContext', {
    configurable: true,
    value: {
      BOOL: 0x8b56, BYTE: 0x1400, UNSIGNED_BYTE: 0x1401,
      SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404,
      UNSIGNED_INT: 0x1405, FLOAT: 0x1406, TRIANGLE_STRIP: 0x0005,
    },
  })
  try {
    const evaluators = await import('sigma/types')
    evaluateNodeStyle = evaluators.evaluateNodeStyle
    evaluateEdgeStyle = evaluators.evaluateEdgeStyle
  } finally {
    if (previous) Object.defineProperty(globalThis, 'WebGL2RenderingContext', previous)
    else Reflect.deleteProperty(globalThis, 'WebGL2RenderingContext')
  }
})

type RendererOptions = SigmaOptions<SigmaSiteGraphNodeAttributes, SigmaSiteGraphEdgeAttributes>
interface RendererProps {
  graph?: SigmaSiteGraph
  options?: RendererOptions
}

const sigmaMocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: never[]) => void>,
  refresh: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  reset: vi.fn(),
  gotoNode: vi.fn(),
  shouldThrow: false,
  cameraRatio: 1,
  graphsSeen: [] as SigmaSiteGraph[],
  optionsSeen: [] as RendererOptions[],
  containerProps: null as RendererProps | null,
}))

const sigmaMockInstance = {
  refresh: sigmaMocks.refresh,
  // The real Sigma reports the graph it renders, and SiteGraphSigma checks it
  // before configuring: applying settings to an instance built for a different
  // graph is exactly the bug that killed the map on a toggle.
  getGraph: () => sigmaMocks.containerProps?.graph ?? null,
  getCamera: () => ({ getState: () => ({ ratio: sigmaMocks.cameraRatio }) }),
}

vi.mock('@react-sigma/core', async () => {
  const React = await import('react')
  return {
    SigmaContainer: ({ children, graph, options }: RendererProps & { children?: React.ReactNode }) => {
      if (sigmaMocks.shouldThrow) throw new Error('WebGL renderer failed')
      // React Sigma 6 can recreate its renderer when either the graph or its
      // options change. Track both so stable graph identity alone cannot pass.
      if (graph && !sigmaMocks.graphsSeen.includes(graph)) sigmaMocks.graphsSeen.push(graph)
      if (options && !sigmaMocks.optionsSeen.includes(options)) sigmaMocks.optionsSeen.push(options)
      sigmaMocks.containerProps = { graph, options }
      return React.createElement(
        'div',
        {
          'data-testid': 'sigma-container',
          'data-nodes': graph?.order,
          'data-edges': graph?.size,
        },
        children,
      )
    },
    useCamera: () => ({
      zoomIn: sigmaMocks.zoomIn,
      zoomOut: sigmaMocks.zoomOut,
      reset: sigmaMocks.reset,
      gotoNode: sigmaMocks.gotoNode,
    }),
    useRegisterEvents: () => (handlers: Record<string, (...args: never[]) => void>) => {
      sigmaMocks.handlers = handlers
    },
    useSigma: () => sigmaMockInstance,
  }
})

import {
  SiteGraphSigma,
  type SiteGraphSigmaNode,
} from '../src/components/project/SiteGraphSigma.js'

function node(
  nodeKey: string,
  overrides: Partial<SiteGraphSigmaNode> = {},
): SiteGraphSigmaNode {
  return {
    nodeKey,
    url: `https://example.com/${nodeKey}`,
    path: nodeKey === 'home' ? '/' : `/${nodeKey}`,
    depth: nodeKey === 'home' ? 0 : 1,
    indexabilityState: 'indexable',
    fetchState: 'html',
    linkScoreNormalized: 50,
    x: nodeKey === 'home' ? 0 : 100,
    y: 0,
    ...overrides,
  }
}

const nodes = [node('home'), node('pricing')]
const edges = [{
  edgeKey: 'home-pricing',
  sourceNodeKey: 'home',
  targetNodeKey: 'pricing',
  followable: true,
  occurrences: 1,
}]

const templateEdges = [
  { edgeKey: 'home-pricing', sourceNodeKey: 'home', targetNodeKey: 'pricing', followable: true, occurrences: 1, isTemplate: false },
  { edgeKey: 'nav-pricing', sourceNodeKey: 'pricing', targetNodeKey: 'home', followable: true, occurrences: 1, isTemplate: true },
]

function mockWebGl(supported: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) => {
    if (contextId === 'webgl' || contextId === 'webgl2') return supported ? {} : null
    return null
  }) as typeof HTMLCanvasElement.prototype.getContext)
}

function graphState(hovered: boolean) {
  return {
    isIdle: !hovered, isPanning: false, isZooming: false, isDragging: false,
    hasHovered: hovered, hasHighlighted: false,
  }
}

// Exercise the installed library's display-data contract, keeping raw graph
// metadata in the third reducer argument as Sigma 4 does at runtime.
function renderedNode(key: string, hovered = false) {
  const { graph, options } = sigmaMocks.containerProps!
  const attributes = graph!.getNodeAttributes(key)
  const state = {
    isHovered: hovered, isLabelHovered: false, isHidden: false,
    isHighlighted: false, isDragged: false,
  }
  const stage = graphState(hovered)
  const display = evaluateNodeStyle(options!.styles?.nodes, attributes, state, stage, graph!)
  return { ...display, ...options!.nodeReducer?.(key, display, attributes, state, stage, graph!) }
}

function renderedEdge(key: string) {
  const { graph, options } = sigmaMocks.containerProps!
  const attributes = graph!.getEdgeAttributes(key)
  const state = {
    isHovered: false, isLabelHovered: false, isHidden: false,
    isHighlighted: false, parallelIndex: 0, parallelCount: 1,
  }
  const stage = graphState(false)
  const display = evaluateEdgeStyle(options!.styles?.edges, attributes, state, stage, graph!)
  return { ...display, ...options!.edgeReducer?.(key, display, attributes, state, stage, graph!) }
}

beforeEach(() => {
  sigmaMocks.handlers = {}
  sigmaMocks.shouldThrow = false
  sigmaMocks.containerProps = null
  sigmaMocks.graphsSeen = []
  sigmaMocks.optionsSeen = []
  sigmaMocks.cameraRatio = 1
  sigmaMocks.refresh.mockReset()
  sigmaMocks.zoomIn.mockReset()
  sigmaMocks.zoomOut.mockReset()
  sigmaMocks.reset.mockReset()
  sigmaMocks.gotoNode.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SiteGraphSigma', () => {
  it('is import-safe for server rendering and keeps WebGL out of the accessibility tree', () => {
    expect(() => renderToString(
      <SiteGraphSigma nodes={nodes} edges={edges} ariaLabel="Website link graph" />,
    )).not.toThrow()

    const markup = renderToString(
      <SiteGraphSigma nodes={nodes} edges={edges} ariaLabel="Website link graph" />,
    )
    expect(markup).toContain('Website link graph')
    expect(markup).toContain('Preparing the interactive site map')
  })

  it('loads the positioned graph and exposes bounded keyboard page search', async () => {
    mockWebGl(true)
    const manyNodes = Array.from({ length: 80 }, (_, index) => node(`page-${String(index).padStart(2, '0')}`, { x: index }))

    render(<SiteGraphSigma nodes={manyNodes} edges={[]} />)

    await screen.findByTestId('sigma-container')
    const search = screen.getByRole('combobox', { name: 'Focus a page in the site map' })
    fireEvent.focus(search)
    expect(screen.getAllByRole('option')).toHaveLength(50)
    expect(within(screen.getAllByRole('option')[0]!).getByText('Indexable')).toBeTruthy()
    const legend = screen.getByLabelText('Site map legend')
    for (const marker of ['●', '◆', '×', '○']) {
      expect(within(legend).getByText(marker)).toBeTruthy()
    }

    fireEvent.change(search, { target: { value: 'page-77' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('page-77', expect.any(Object))
  })

  it('closes the search list on blur without breaking mouse or keyboard selection', async () => {
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await screen.findByTestId('sigma-container')
    const search = screen.getByRole('combobox', { name: 'Focus a page in the site map' })

    fireEvent.focus(search)
    expect(screen.getByRole('listbox', { name: 'Matching pages' })).not.toBeNull()
    fireEvent.blur(search)
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Matching pages' })).toBeNull())

    fireEvent.focus(search)
    const pricing = screen.getByRole('option', { name: /pricing/i })
    fireEvent.pointerDown(pricing)
    fireEvent.blur(search)
    fireEvent.click(pricing)
    expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('pricing', expect.any(Object))
    expect(screen.queryByRole('listbox', { name: 'Matching pages' })).toBeNull()

    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(sigmaMocks.gotoNode).toHaveBeenCalled()
  })

  it('passes parseable non-black node, edge, and label colors to Sigma', async () => {
    mockWebGl(true)
    render(
      <SiteGraphSigma
        nodes={[
          node('eligible'),
          node('hidden', { indexabilityState: 'noindex' }),
          node('failed', { fetchState: 'fetch-error' }),
          node('unchecked', { fetchState: 'discovered', indexabilityState: 'unknown' }),
        ]}
        edges={[{ ...edges[0]!, sourceNodeKey: 'eligible', targetNodeKey: 'hidden' }]}
      />,
    )

    await waitFor(() => expect(sigmaMocks.containerProps).not.toBeNull())
    const graph = sigmaMocks.containerProps!.graph!
    const renderedNodes = graph.nodes().map((key) => renderedNode(key))
    expect(parseFontString(renderedNodes[0]!.labelFont)).toEqual({
      family: 'Geist Variable, Geist, sans-serif', weight: '600', style: 'normal',
    })
    expect(renderedNodes[0]!.labelSize).toBe(13)
    const colors = [
      ...renderedNodes.flatMap((data) => [data.color, data.labelColor]),
      ...graph.edges().map((key) => renderedEdge(key).color),
    ]
    for (const color of colors) {
      expect(color).toBeTruthy()
      const parsed = parseColor(color)
      expect([parsed.r, parsed.g, parsed.b], color).not.toEqual([0, 0, 0])
    }
  })

  it('renders hovered labels with the theme contrast pair and preserves the node color', async () => {
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)
    await waitFor(() => expect(sigmaMocks.containerProps).not.toBeNull())
    const normal = renderedNode('pricing')
    act(() => { sigmaMocks.handlers.enterNode!({ node: 'pricing', event: { x: 40, y: 30 } } as never) })
    const hovered = renderedNode('pricing', true)

    expect(normal.backdropVisibility).toBe('hidden')
    expect(hovered).toMatchObject({
      label: '● /pricing',
      labelVisibility: 'visible',
      backdropVisibility: 'visible',
      backdropColor: '#18181b',
      backdropBorderColor: '#a1a1aa',
      labelColor: '#e4e4e7',
      color: '#56b4e9',
    })
    expect(hovered.color).toBe(normal.color)
  })

  it('selects a node from Sigma events and reports it to the parent', async () => {
    mockWebGl(true)
    const onSelectNode = vi.fn()
    render(<SiteGraphSigma nodes={nodes} edges={edges} onSelectNode={onSelectNode} />)

    await waitFor(() => expect(sigmaMocks.handlers.clickNode).toBeTypeOf('function'))
    act(() => {
      sigmaMocks.handlers.clickNode!({ node: 'pricing', event: { x: 100, y: 80 } } as never)
    })

    expect(onSelectNode).toHaveBeenCalledWith(expect.objectContaining({ nodeKey: 'pricing' }))
  })

  it('shows the page audit score in the graph tooltip without changing the graph encoding', async () => {
    mockWebGl(true)
    render(
      <SiteGraphSigma
        nodes={[node('home'), node('pricing', { auditScore: 61 })]}
        edges={edges}
      />,
    )

    await waitFor(() => expect(sigmaMocks.handlers.enterNode).toBeTypeOf('function'))
    act(() => {
      sigmaMocks.handlers.enterNode!({ node: 'pricing', event: { x: 100, y: 80 } } as never)
    })

    const tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getByText('Score 61/100')).not.toBeNull()
    expect(within(tooltip).getByText(/allowed to index this page/)).not.toBeNull()
  })

  it('re-reduces after a zoom, so labels and edges actually change on screen', async () => {
    // Sigma applies reducers only inside process(), which runs on refresh().
    // Reading the ratio at paint time is necessary but NOT sufficient: without
    // a camera listener that refreshes, a zoom never re-evaluates the label
    // budget and the edge mesh never comes back. This is the defect the
    // founder screenshotted, so it is asserted end to end through the runtime.
    mockWebGl(true)
    sigmaMocks.cameraRatio = 1
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const denseNodes = Array.from({ length: 30 }, (_, index) => node(`n${String(index).padStart(2, '0')}`))
    const denseEdges = denseNodes.slice(1).map((target) => ({
      edgeKey: `n00-${target.nodeKey}`,
      sourceNodeKey: 'n00',
      targetNodeKey: target.nodeKey,
      followable: true,
      occurrences: 1,
    }))
    render(<SiteGraphSigma nodes={denseNodes} edges={denseEdges} rootNodeKey="n00" />)
    await waitFor(() => expect(sigmaMocks.handlers.updated).toBeTypeOf('function'))
    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalled())

    const graph = sigmaMocks.containerProps!.graph!
    const visibleEdges = () => graph.edges().filter((key) => renderedEdge(key).visibility !== 'hidden')
    const labelled = () => graph.nodes().filter((key) => {
      const data = renderedNode(key)
      return data.label !== '' && data.labelVisibility !== 'hidden'
    })

    // Fitted: the overview treatment.
    expect(visibleEdges()).toEqual([])
    const overviewLabels = labelled().length

    // Zoom in. The camera event must drive a refresh, coalesced onto a frame.
    const refreshesBefore = sigmaMocks.refresh.mock.calls.length
    sigmaMocks.cameraRatio = 0.1
    act(() => { sigmaMocks.handlers.updated!({ ratio: 0.1 } as never) })
    expect(frames).toHaveLength(1)
    act(() => { frames.shift()!(0) })
    expect(sigmaMocks.refresh.mock.calls.length).toBe(refreshesBefore + 1)

    // And the reduced output really changed: edges are back, more labels show.
    expect(visibleEdges().length).toBeGreaterThan(0)
    expect(labelled().length).toBeGreaterThan(overviewLabels)

    // A gesture that does not cross a tier costs no refresh.
    const refreshesAfterZoom = sigmaMocks.refresh.mock.calls.length
    sigmaMocks.cameraRatio = 0.11
    act(() => { sigmaMocks.handlers.updated!({ ratio: 0.11 } as never) })
    act(() => { frames.shift()!(0) })
    expect(sigmaMocks.refresh.mock.calls.length).toBe(refreshesAfterZoom)

    // Many events inside one frame coalesce into a single scheduled refresh.
    sigmaMocks.cameraRatio = 1
    act(() => {
      for (const ratio of [0.5, 0.8, 1]) sigmaMocks.handlers.updated!({ ratio } as never)
    })
    expect(frames).toHaveLength(1)
    act(() => { frames.shift()!(0) })
    expect(sigmaMocks.refresh.mock.calls.length).toBe(refreshesAfterZoom + 1)
    expect(visibleEdges()).toEqual([])
  })

  it('cancels pending camera work before the renderer is destroyed', async () => {
    mockWebGl(true)
    const schedule = vi.fn(() => 17)
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', schedule)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const rendered = render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalled())
    act(() => { sigmaMocks.handlers.updated!({ ratio: 0.1 } as never) })
    expect(schedule).toHaveBeenCalledOnce()
    sigmaMocks.refresh.mockClear()
    rendered.unmount()

    expect(cancel).toHaveBeenCalledWith(17)
    expect(sigmaMocks.refresh).not.toHaveBeenCalled()
  })

  it('moves the camera when controlled selection changes outside the graph', async () => {
    mockWebGl(true)
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={edges} selectedNodeKey="home" />,
    )

    await waitFor(() => expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('home', expect.any(Object)))
    sigmaMocks.gotoNode.mockClear()
    rerender(<SiteGraphSigma nodes={nodes} edges={edges} selectedNodeKey="pricing" />)

    await waitFor(() => expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('pricing', expect.any(Object)))
  })

  it('disables camera animation when the operator prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await screen.findByTestId('sigma-container')
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    await waitFor(() => expect(zoomIn).toHaveProperty('disabled', false))
    fireEvent.click(zoomIn)

    expect(sigmaMocks.zoomIn).toHaveBeenCalledWith({ duration: 0 })
  })

  it('shows a truthful fallback when WebGL is unavailable', async () => {
    mockWebGl(false)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('Interactive map unavailable')).toBeTruthy()
    expect(screen.getByText(/page inventory remains available/i)).toBeTruthy()
  })

  it('shows the unavailable fallback when only WebGL 1 is supported', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) => (
      contextId === 'webgl' ? {} : null
    )) as typeof HTMLCanvasElement.prototype.getContext)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('Interactive map unavailable')).toBeTruthy()
    expect(screen.queryByTestId('sigma-container')).toBeNull()
    expect(screen.queryByText('The map could not be drawn')).toBeNull()
  })

  it('offers the inventory directly from a WebGL fallback', async () => {
    const onOpenInventory = vi.fn()
    mockWebGl(false)
    render(<SiteGraphSigma nodes={nodes} edges={edges} onOpenInventory={onOpenInventory} />)

    await screen.findByText('Interactive map unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Open page inventory' }))
    expect(onOpenInventory).toHaveBeenCalledOnce()
  })

  it('owns a render failure instead of blaming the browser for it', async () => {
    // The map had already drawn in this browser, so "could not start WebGL"
    // sent the reader to debug their machine for our bug.
    mockWebGl(true)
    sigmaMocks.shouldThrow = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('The map could not be drawn')).toBeTruthy()
    expect(screen.queryByText('Interactive map unavailable')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    // The underlying error is logged, never swallowed.
    expect(consoleError).toHaveBeenCalled()
  })

  it('still says WebGL is unavailable when the browser genuinely cannot start it', async () => {
    mockWebGl(false)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('Interactive map unavailable')).toBeTruthy()
    expect(screen.queryByText('The map could not be drawn')).toBeNull()
  })

  it('distinguishes an empty graph from missing server layout positions', () => {
    const { rerender } = render(<SiteGraphSigma nodes={[]} edges={[]} />)
    expect(screen.getByText('No page graph is available for this scan.')).toBeTruthy()

    rerender(<SiteGraphSigma nodes={[]} edges={[]} layoutState="unavailable" />)
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()

    rerender(<SiteGraphSigma nodes={[node('home', { x: Number.NaN })]} edges={[]} />)
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()
  })

  it('distinguishes a persisted layout failure from an older scan without a layout', () => {
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={edges} layoutState="unavailable" layoutUnavailableReason="legacy-snapshot" />,
    )
    expect(screen.getByText('No map yet')).toBeTruthy()
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()

    rerender(
      <SiteGraphSigma nodes={nodes} edges={edges} layoutState="unavailable" layoutUnavailableReason="layout-failed" />,
    )
    expect(screen.getByText('Map could not be built')).toBeTruthy()
    expect(screen.getByText('The map could not be created for this scan. Run a new scan to try again.')).toBeTruthy()
  })

  it('keeps graph and renderer options stable across nav toggling and focus changes', async () => {
    // The live bug: ticking "Show nav and footer links" replaced the map with
    // the WebGL fallback. Visibility used to be expressed by handing the
    // renderer a SHORTER edge list, which is a different graph, which made
    // react-sigma kill and rebuild the whole Sigma instance. Browsers cap live
    // WebGL contexts, and the rebuild also let a child effect fire against the
    // instance that had just been killed.
    mockWebGl(true)
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={edges} showTemplateLinks={false} />,
    )
    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalled())
    expect(sigmaMocks.graphsSeen).toHaveLength(1)

    for (let i = 0; i < 12; i++) {
      rerender(<SiteGraphSigma nodes={nodes} edges={edges} showTemplateLinks={i % 2 === 0} selectedNodeKey={i % 2 === 0 ? 'home' : 'pricing'} />)
    }

    // Neither constructor input changes while focus and edge visibility do.
    expect(sigmaMocks.graphsSeen).toHaveLength(1)
    expect(sigmaMocks.optionsSeen).toHaveLength(1)
    expect(renderedNode('pricing').labelVisibility).toBe('visible')
    expect(renderedNode('pricing').size).toBeCloseTo(sigmaMocks.containerProps!.graph!.getNodeAttribute('pricing', 'size') * 1.35)
    // And the map is still on screen: no fallback of either kind.
    expect(screen.queryByText('The map could not be drawn')).toBeNull()
    expect(screen.queryByText('Interactive map unavailable')).toBeNull()
    expect(sigmaMocks.containerProps?.graph).toBe(sigmaMocks.graphsSeen[0])
  })

  it('re-reduces on toggle so the edges actually change without a rebuild', async () => {
    mockWebGl(true)
    sigmaMocks.cameraRatio = 0.1
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={templateEdges} showTemplateLinks={false} />,
    )
    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalled())

    const graph = sigmaMocks.containerProps!.graph!
    const visibleEdges = () => graph.edges().filter((key) => renderedEdge(key).visibility !== 'hidden')

    expect(visibleEdges()).toEqual(['home-pricing'])
    rerender(<SiteGraphSigma nodes={nodes} edges={templateEdges} showTemplateLinks />)
    expect(visibleEdges()).toEqual(['home-pricing', 'nav-pricing'])
    expect(sigmaMocks.graphsSeen).toHaveLength(1)
  })

  it('offers the inventory directly when the persisted layout is unavailable', () => {
    const onOpenInventory = vi.fn()
    render(
      <SiteGraphSigma
        nodes={nodes}
        edges={edges}
        layoutState="unavailable"
        onOpenInventory={onOpenInventory}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open page inventory' }))
    expect(onOpenInventory).toHaveBeenCalledOnce()
  })
})
