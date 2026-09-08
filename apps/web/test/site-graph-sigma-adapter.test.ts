// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseColor } from 'sigma/utils'

import {
  siteGraphDisplayPath,
  buildSigmaSiteGraph,
  createSigmaSiteGraphReducers,
  findSiteGraphNodes,
  SITE_GRAPH_COLOR_TOKENS,
  SITE_GRAPH_EDGE_TOKEN,
  SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT,
  SITE_GRAPH_LABEL_BUDGETS,
  SITE_GRAPH_OVERVIEW_LABEL_BUDGET,
  siteGraphLabelBudget,
  siteGraphMaxNodeSize,
  siteGraphRootNodeSize,
  SITE_GRAPH_SIGMA_COLOR_TOKENS,
  isSigmaWebGlColor,
  isSiteGraphRootNode,
  siteGraphNodeSize,
  siteGraphStatusDescription,
  siteGraphStatusGlyph,
  siteGraphStatusLabel,
  siteGraphStatusLegendLabel,
  siteGraphVisualState,
  type SigmaSiteGraphTheme,
  type SiteGraphSigmaEdge,
  type SiteGraphSigmaNode,
} from '../src/components/project/site-graph-sigma.js'
import { SITE_GRAPH_LEGEND_STATES } from '@ainyc/canonry-contracts'

const theme: SigmaSiteGraphTheme = {
  eligible: 'rgb(1, 2, 3)',
  hidden: 'rgb(4, 5, 6)',
  resource: 'rgb(34, 35, 36)',
  redirect: 'rgb(37, 38, 39)',
  failed: 'rgb(7, 8, 9)',
  unchecked: 'rgb(10, 11, 12)',
  dimmedNode: 'rgb(13, 14, 15)',
  edge: 'rgb(16, 17, 18)',
  edgeDimmed: 'rgb(19, 20, 21)',
  edgeActive: 'rgb(22, 23, 24)',
  label: 'rgb(25, 26, 27)',
  background: 'rgb(28, 29, 30)',
}

function node(
  nodeKey: string,
  overrides: Partial<SiteGraphSigmaNode> = {},
): SiteGraphSigmaNode {
  return {
    nodeKey,
    url: `https://example.com/${nodeKey}`,
    path: `/${nodeKey}`,
    depth: 1,
    indexabilityState: 'indexable',
    fetchState: 'html',
    linkScoreNormalized: 0.5,
    x: 10,
    y: 20,
    ...overrides,
  }
}

function edge(
  edgeKey: string,
  sourceNodeKey: string,
  targetNodeKey: string | null,
): SiteGraphSigmaEdge {
  return {
    edgeKey,
    sourceNodeKey,
    targetNodeKey,
    followable: true,
    occurrences: 1,
  }
}

describe('buildSigmaSiteGraph', () => {
  it('uses only non-black colors accepted by Sigma 3 for every renderer binding', () => {
    for (const [binding, token] of Object.entries(SITE_GRAPH_SIGMA_COLOR_TOKENS)) {
      expect(isSigmaWebGlColor(token.fallback), `${binding} must use Sigma's supported color syntax`).toBe(true)
      const parsed = parseColor(token.fallback)
      expect([parsed.r, parsed.g, parsed.b], `${binding} must not render black`).not.toEqual([0, 0, 0])
    }

    expect(isSigmaWebGlColor('rgb(255 255 255 / 0.06)')).toBe(false)
  })

  it('prefers the server-published health state and uses an exact legacy fallback only when absent', () => {
    expect(siteGraphVisualState(node('server-owned', {
      healthState: 'hidden',
      fetchState: 'html',
      indexabilityState: 'indexable',
    }))).toBe('hidden')
    expect(siteGraphVisualState(node('legacy', {
      fetchState: 'fetch-error',
    }))).toBe('failed')
    expect(siteGraphVisualState(node('legacy-redirect', {
      fetchState: 'redirect',
      indexabilityState: 'indexable',
    }))).toBe('redirect')
    // A fetched .txt or PDF is not hidden; it is simply not a page.
    expect(siteGraphVisualState(node('legacy-resource', {
      fetchState: 'non-html',
      indexabilityState: 'indexable',
    }))).toBe('resource')
    expect(siteGraphVisualState(node('legacy-canonical-source', {
      canonicalNodeKey: 'legacy-canonical-target',
      fetchState: 'html',
      indexabilityState: 'indexable',
    }))).toBe('hidden')
    expect(siteGraphVisualState(node('legacy-pending', {
      fetchState: 'discovered',
      indexabilityState: 'unknown',
    }))).toBe('unchecked')
    expect(siteGraphVisualState(node('legacy-unrecognized', {
      fetchState: 'fetch-error-but-not-a-crawler-state',
      indexabilityState: 'indexable',
    }))).toBe('unchecked')
  })

  it('renders the node label through the truncator, not the raw path', () => {
    // Guards the WIRING, not the helper: a unit test of siteGraphDisplayPath
    // still passes when the label is built from node.path directly, which is
    // the state that shipped the overlapping labels.
    const deep = '/apartments/atlanta-metro/dunwoody-apts/'
    const result = buildSigmaSiteGraph([node('deep', { path: deep })], [], theme)
    const label = result.graph.getNodeAttribute('deep', 'label')

    expect(label).not.toContain('atlanta-metro')
    expect(label).toContain('dunwoody-apts')
    expect(result.graph.getNodeAttribute('deep', 'path')).toBe(deep)
  })

  it('adds a distinct status glyph to labels so color is never the only visual cue', () => {
    const result = buildSigmaSiteGraph(
      [
        node('eligible'),
        node('hidden', { indexabilityState: 'noindex' }),
        node('failed', { fetchState: 'fetch-error' }),
        node('unchecked', { fetchState: 'discovered', indexabilityState: 'unknown' }),
      ],
      [],
      theme,
    )

    expect(siteGraphStatusGlyph('eligible')).toBe('●')
    expect(siteGraphStatusGlyph('hidden')).toBe('◆')
    expect(siteGraphStatusGlyph('failed')).toBe('×')
    expect(siteGraphStatusGlyph('unchecked')).toBe('○')
    expect(result.graph.getNodeAttribute('eligible', 'label')).toBe('● /eligible')
    expect(result.graph.getNodeAttribute('hidden', 'label')).toBe('◆ /hidden')
    expect(result.graph.getNodeAttribute('failed', 'label')).toBe('× /failed')
    expect(result.graph.getNodeAttribute('unchecked', 'label')).toBe('○ /unchecked')
    expect(result.graph.getNodeAttribute('eligible', 'color')).toBe(theme.eligible)
    expect(result.graph.getNodeAttribute('hidden', 'color')).toBe(theme.hidden)
    expect(result.graph.getNodeAttribute('failed', 'color')).toBe(theme.failed)
    expect(result.graph.getNodeAttribute('unchecked', 'color')).toBe(theme.unchecked)
    expect(new Set(result.graph.mapNodes((_key, attributes) => attributes.size))).toEqual(
      new Set([siteGraphNodeSize(node('same-size'))]),
    )
    expect(SITE_GRAPH_EDGE_TOKEN).toEqual({
      property: '--chart-neutral-text-dim',
      fallback: '#71717a',
    })
  })

  it('uses the server-published positions without running a browser layout', () => {
    const result = buildSigmaSiteGraph(
      [
        node('home', { path: '/', depth: 0, x: -91.25, y: 43.5, linkScoreNormalized: 1 }),
        node('pricing', { x: 122.75, y: -8.25, indexabilityState: 'noindex' }),
      ],
      [edge('home-pricing', 'home', 'pricing')],
      theme,
    )

    expect(result.layoutAvailable).toBe(true)
    expect(result.graph.type).toBe('directed')
    expect(result.graph.multi).toBe(true)
    expect(result.graph.getNodeAttributes('home')).toMatchObject({
      x: -91.25,
      y: 43.5,
      size: siteGraphNodeSize(node('home', { path: '/', depth: 0, linkScoreNormalized: 1 })),
      status: 'eligible',
    })
    expect(result.graph.getNodeAttributes('pricing')).toMatchObject({
      x: 122.75,
      y: -8.25,
      color: theme.hidden,
      status: 'hidden',
    })
    expect(result.graph.extremities('home-pricing')).toEqual(['home', 'pricing'])
  })

  it('drops invalid positions, dangling edges, and duplicate keys deterministically', () => {
    const result = buildSigmaSiteGraph(
      [
        node('home', { x: 0, y: 0 }),
        node('home', { x: 100, y: 100 }),
        node('missing-position', { x: Number.NaN }),
      ],
      [
        edge('valid', 'home', 'home'),
        edge('dangling', 'home', 'missing-position'),
        edge('unresolved', 'home', null),
        edge('valid', 'home', 'home'),
      ],
      theme,
    )

    expect(result.graph.order).toBe(1)
    expect(result.graph.size).toBe(1)
    expect(result.graph.getNodeAttribute('home', 'x')).toBe(0)
    expect(result.omittedNodes).toBe(2)
    expect(result.omittedEdges).toBe(3)
  })

  it('reports an unavailable layout when pages exist but none have finite positions', () => {
    const result = buildSigmaSiteGraph(
      [node('one', { x: Number.NaN }), node('two', { y: Number.POSITIVE_INFINITY })],
      [],
      theme,
    )

    expect(result.layoutAvailable).toBe(false)
    expect(result.graph.order).toBe(0)
  })

  it('dims non-neighbors and hides unrelated edges in the zoomed-out overview', () => {
    const result = buildSigmaSiteGraph(
      [node('home'), node('pricing'), node('unrelated', { healthState: 'failed' })],
      [edge('home-pricing', 'home', 'pricing'), edge('pricing-unrelated', 'pricing', 'unrelated')],
      theme,
    )
    const reducers = createSigmaSiteGraphReducers(result.graph, 'home', 2, theme)

    expect(reducers.nodeReducer('pricing', result.graph.getNodeAttributes('pricing')).color).toBe(theme.eligible)
    expect(reducers.nodeReducer('unrelated', result.graph.getNodeAttributes('unrelated'))).toMatchObject({
      color: theme.dimmedNode,
      label: '',
      status: 'failed',
      glyph: '×',
    })
    expect(reducers.edgeReducer('home-pricing', result.graph.getEdgeAttributes('home-pricing'))).toMatchObject({
      color: theme.edgeActive,
      zIndex: 2,
    })
    expect(reducers.edgeReducer('pricing-unrelated', result.graph.getEdgeAttributes('pricing-unrelated'))).toMatchObject({
      hidden: true,
    })
  })

  it('spends a zoom-dependent label budget on the best-linked pages', () => {
    // A fitted 50-page map used to draw every label at once, overlapping into
    // unreadable text. The budget names the pages a reader looks for first.
    const pages = Array.from({ length: 40 }, (_, index) => node(`p${String(index).padStart(2, '0')}`, {
      path: `/p${index}`,
      depth: 1 + (index % 3),
      linkScoreNormalized: index / 39,
    }))
    const result = buildSigmaSiteGraph(
      [node('home', { path: '/', depth: 0, linkScoreNormalized: 0 }), ...pages],
      pages.map((page) => edge(`home-${page.nodeKey}`, 'home', page.nodeKey)),
      theme,
      'home',
    )

    const labelled = (ratio: number) => {
      const reducers = createSigmaSiteGraphReducers(result.graph, null, ratio, theme)
      return result.graph.nodes().filter((nodeKey) => {
        const reduced = reducers.nodeReducer(nodeKey, result.graph.getNodeAttributes(nodeKey))
        return reduced.label !== ''
      })
    }

    const overview = labelled(1)
    expect(overview.length).toBeLessThanOrEqual(SITE_GRAPH_OVERVIEW_LABEL_BUDGET)
    // The root is always one of them, whatever its link score.
    expect(overview).toContain('home')
    // The rest are the best-linked pages, not an arbitrary slice.
    expect(overview).toContain('p39')
    expect(overview).not.toContain('p00')

    // Zooming in reveals more, and a close zoom holds nothing back.
    expect(labelled(0.6).length).toBeGreaterThan(overview.length)
    expect(labelled(0.1).length).toBe(result.graph.order)

    expect(siteGraphLabelBudget(1)).toBe(SITE_GRAPH_OVERVIEW_LABEL_BUDGET)
    expect(siteGraphLabelBudget(0.1)).toBe(Number.POSITIVE_INFINITY)
    // The ladder only ever loosens as the camera moves in.
    const budgets = [1, 0.7, 0.4, 0.1].map(siteGraphLabelBudget)
    expect(budgets).toEqual([...budgets].sort((left, right) => left - right))
    expect(SITE_GRAPH_LABEL_BUDGETS.length).toBeGreaterThan(0)
  })

  it('shrinks the node size range as a map gets denser, keeping importance monotonic', () => {
    // At 50 nodes on a template mesh nearly every page scores alike, so a
    // fixed range drew them all at the maximum and read as one solid mass.
    expect(siteGraphMaxNodeSize(50)).toBeGreaterThan(siteGraphMaxNodeSize(5_000))
    expect(siteGraphMaxNodeSize(5_000)).toBeGreaterThan(siteGraphMaxNodeSize(20_000))
    expect(siteGraphMaxNodeSize(20_000)).toBeGreaterThan(0)
    expect(siteGraphRootNodeSize(50)).toBeGreaterThan(siteGraphMaxNodeSize(50))

    // Importance still reads monotonically at any density.
    for (const count of [50, 5_000]) {
      const low = siteGraphNodeSize(node('low', { linkScoreNormalized: 0.1 }), false, count)
      const high = siteGraphNodeSize(node('high', { linkScoreNormalized: 0.9 }), false, count)
      expect(high).toBeGreaterThan(low)
      expect(high).toBeLessThanOrEqual(siteGraphMaxNodeSize(count))
    }
    // A denser map never draws a bigger dot for the same importance.
    expect(siteGraphNodeSize(node('x', { linkScoreNormalized: 1 }), false, 5_000))
      .toBeLessThan(siteGraphNodeSize(node('x', { linkScoreNormalized: 1 }), false, 50))
  })

  it('bounds collision-safe label candidates around a high-degree focused page by link importance', () => {
    const neighbors = Array.from({ length: 24 }, (_, index) => node(`article-${String(index).padStart(2, '0')}`, {
      path: `/blog/article-${String(index).padStart(2, '0')}`,
      depth: 2,
      linkScoreNormalized: index / 23,
    }))
    const result = buildSigmaSiteGraph(
      [node('blog', { path: '/blog', depth: 1, linkScoreNormalized: 1 }), ...neighbors],
      [
        edge('blog-self', 'blog', 'blog'),
        ...neighbors.map((neighbor) => edge(`blog-${neighbor.nodeKey}`, 'blog', neighbor.nodeKey)),
      ],
      theme,
    )
    const reducers = createSigmaSiteGraphReducers(result.graph, 'blog', 2, theme)
    const candidateNeighbors = neighbors.filter((neighbor) => {
      const reduced = reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )
      return reduced.label !== ''
    })
    const suppressedNeighbors = neighbors.filter((neighbor) => !candidateNeighbors.includes(neighbor))

    expect(SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT).toBe(8)
    expect(candidateNeighbors.map((neighbor) => neighbor.nodeKey)).toEqual([
      'article-16',
      'article-17',
      'article-18',
      'article-19',
      'article-20',
      'article-21',
      'article-22',
      'article-23',
    ])
    for (const neighbor of candidateNeighbors) {
      expect(reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )).toMatchObject({ forceLabel: false })
    }
    expect(suppressedNeighbors).toHaveLength(16)
    for (const neighbor of suppressedNeighbors) {
      expect(reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )).toMatchObject({ color: theme.eligible, forceLabel: false, label: '' })
    }
    expect(reducers.nodeReducer('blog', result.graph.getNodeAttributes('blog'))).toMatchObject({
      label: '● /blog',
      forceLabel: true,
    })

    const reversed = buildSigmaSiteGraph(
      [...neighbors].reverse().concat(node('blog', { path: '/blog', depth: 1, linkScoreNormalized: 1 })),
      [
        edge('blog-self', 'blog', 'blog'),
        ...[...neighbors].reverse().map((neighbor) => edge(`blog-${neighbor.nodeKey}`, 'blog', neighbor.nodeKey)),
      ],
      theme,
    )
    const reversedReducers = createSigmaSiteGraphReducers(reversed.graph, 'blog', 2, theme)
    expect(neighbors.filter((neighbor) => reversedReducers.nodeReducer(
      neighbor.nodeKey,
      reversed.graph.getNodeAttributes(neighbor.nodeKey),
    ).label !== '').map((neighbor) => neighbor.nodeKey)).toEqual(
      candidateNeighbors.map((neighbor) => neighbor.nodeKey),
    )

    const zoomedIn = createSigmaSiteGraphReducers(result.graph, 'blog', 0.5, theme)
    expect(zoomedIn.nodeReducer(
      'article-00',
      result.graph.getNodeAttributes('article-00'),
    )).toEqual(result.graph.getNodeAttributes('article-00'))
  })
})

describe('findSiteGraphNodes', () => {
  it('returns a stable, bounded search result instead of rendering every node', () => {
    const nodes = [
      ...Array.from({ length: 80 }, (_, index) => node(`page-${String(index).padStart(2, '0')}`)),
      node('missing-layout', { x: Number.NaN }),
    ]

    expect(findSiteGraphNodes(nodes, '', 50)).toHaveLength(50)
    expect(findSiteGraphNodes(nodes, 'page-77', 50).map((item) => item.nodeKey)).toEqual(['page-77'])
    expect(findSiteGraphNodes([...nodes].reverse(), 'page', 3).map((item) => item.nodeKey)).toEqual([
      'page-00',
      'page-01',
      'page-02',
    ])
  })
})

describe('the crawl root', () => {
  const graphWithRoot = () => buildSigmaSiteGraph(
    [
      node('home', { path: '/', depth: 0, linkScoreNormalized: 0 }),
      node('services', { path: '/services', depth: 1, linkScoreNormalized: 1 }),
      node('deep', { path: '/blog/guides/article', depth: 3 }),
    ],
    [edge('home-services', 'home', 'services'), edge('services-deep', 'services', 'deep')],
    theme,
    'home',
  )

  it('takes its identity from the server and never guesses from a path or a depth', () => {
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), 'home')).toBe(true)
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), null)).toBe(false)
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), 'other')).toBe(false)

    const unidentified = buildSigmaSiteGraph([node('home', { path: '/', depth: 0 })], [], theme)
    expect(unidentified.graph.getNodeAttribute('home', 'isRoot')).toBe(false)
    expect(unidentified.graph.getNodeAttribute('home', 'label')).toBe('● /')
    expect(unidentified.graph.getNodeAttribute('home', 'isRoot')).toBe(false)
  })

  it('is labeled and oversized regardless of link score, with no alarm marker', () => {
    const root = graphWithRoot().graph.getNodeAttributes('home')

    // The root reads as the path it is; the ring and the forced label are
    // what mark it, not a different name.
    expect(root.label).toBe('● /')
    expect(root.forceLabel).toBe(true)
    expect(root.isRoot).toBe(true)
    // No ring: a coloured halo read as "selected" or "broken here", when all
    // it meant was "you are here". The label and the size say that already.
    expect(root.ringColor).toBeUndefined()
    // The lowest possible internal-link score must not shrink it.
    expect(root.size).toBeCloseTo(siteGraphRootNodeSize(3), 9)
    expect(root.size).toBeGreaterThan(
      graphWithRoot().graph.getNodeAttribute('services', 'size'),
    )
    expect(root.zIndex).toBeGreaterThan(graphWithRoot().graph.getNodeAttribute('services', 'zIndex'))
  })

  it('keeps its label in the overview and while another page has focus', () => {
    const built = graphWithRoot()
    const root = built.graph.getNodeAttributes('home')

    const overview = createSigmaSiteGraphReducers(built.graph, null, 2, theme)
    expect(overview.nodeReducer('home', root)).toMatchObject({
      label: '● /',
      forceLabel: true,
    })

    // Focused elsewhere, and not even a neighbor of the focus.
    const focusedElsewhere = createSigmaSiteGraphReducers(built.graph, 'deep', 2, theme)
    expect(focusedElsewhere.nodeReducer('home', root)).toMatchObject({
      label: '● /',
      forceLabel: true,
    })
    expect(focusedElsewhere.nodeReducer('home', root).color).toBe(theme.eligible)

    const focusedOnRoot = createSigmaSiteGraphReducers(built.graph, 'home', 2, theme)
    expect(focusedOnRoot.nodeReducer('home', root)).toMatchObject({
      forceLabel: true,
      zIndex: 3,
      size: root.size * 1.35,
    })
  })
})

describe('a real template-mesh site (canonry.ai shape: 50 pages, ~1,259 links)', () => {
  function templateMesh() {
    const pages = Array.from({ length: 50 }, (_, index) => node(`page-${String(index).padStart(2, '0')}`, {
      path: index === 0 ? '/' : `/page-${index}`,
      depth: index === 0 ? 0 : 1 + (index % 3),
      // A shared header links everywhere, so link scores bunch near the top.
      linkScoreNormalized: 0.7 + (index % 10) / 33,
      x: Math.cos(index) * 50,
      y: Math.sin(index * 1.7) * 50,
    }))
    const edges = []
    for (const source of pages) {
      for (const target of pages) {
        if (source.nodeKey === target.nodeKey) continue
        if (edges.length >= 1_259) break
        edges.push(edge(`${source.nodeKey}->${target.nodeKey}`, source.nodeKey, target.nodeKey))
      }
    }
    return { pages, edges }
  }

  it('draws a readable overview: budgeted labels, no edge mesh, one Home', () => {
    const { pages, edges } = templateMesh()
    const built = buildSigmaSiteGraph(pages, edges, theme, 'page-00')
    expect(built.graph.order).toBe(50)
    expect(built.graph.size).toBe(1_259)

    const fitted = createSigmaSiteGraphReducers(built.graph, null, 1, theme)

    // Labels stay inside the budget instead of overlapping into a smear.
    const labelled = built.graph.nodes().filter((nodeKey) => (
      fitted.nodeReducer(nodeKey, built.graph.getNodeAttributes(nodeKey)).label !== ''
    ))
    expect(labelled.length).toBeLessThanOrEqual(SITE_GRAPH_OVERVIEW_LABEL_BUDGET)
    expect(labelled).toContain('page-00')

    // Exactly one page carries the root marker, and it is the one the server
    // identified. Its label is its path like every other page.
    const ringed = built.graph.nodes().filter((nodeKey) => built.graph.getNodeAttribute(nodeKey, 'isRoot'))
    expect(ringed).toEqual(['page-00'])
    expect(built.graph.getNodeAttribute('page-00', 'label')).toBe('● /')

    // The default view of a dense site shows nodes only.
    const visibleEdges = built.graph.edges().filter((edgeKey) => (
      fitted.edgeReducer(edgeKey, built.graph.getEdgeAttributes(edgeKey)).hidden !== true
    ))
    expect(visibleEdges).toEqual([])

    // Selecting a page brings back that page's own links, still fitted.
    const focused = createSigmaSiteGraphReducers(built.graph, 'page-07', 1, theme)
    const focusedEdges = built.graph.edges().filter((edgeKey) => (
      focused.edgeReducer(edgeKey, built.graph.getEdgeAttributes(edgeKey)).hidden !== true
    ))
    expect(focusedEdges.length).toBeGreaterThan(0)
    for (const edgeKey of focusedEdges) {
      expect(built.graph.extremities(edgeKey)).toContain('page-07')
    }
    // And its own label is drawn whatever the budget says.
    expect(focused.nodeReducer('page-07', built.graph.getNodeAttributes('page-07')).forceLabel).toBe(true)

    // Dots stay small enough at this density to read as separate pages.
    expect(siteGraphMaxNodeSize(50)).toBeLessThanOrEqual(9)
  })
})

describe('the customer-facing state vocabulary', () => {
  it('never calls a file or a redirect hidden, at any surface', () => {
    // /llms-full.txt shipped reading "Hidden" over "Not a reachable HTML
    // page". Badge, legend, and tooltip all have to agree that it is a file.
    expect(siteGraphStatusLabel('resource')).toBe('Not a page')
    expect(siteGraphStatusLegendLabel('resource')).toBe('Not a page')
    expect(siteGraphStatusDescription('resource')).toMatch(/file rather than a page/i)
    expect(siteGraphStatusDescription('resource')).not.toMatch(/hidden/i)

    expect(siteGraphStatusLabel('redirect')).toBe('Moved')
    expect(siteGraphStatusLegendLabel('redirect')).toBe('Moved')
    expect(siteGraphStatusDescription('redirect')).not.toMatch(/hidden/i)

    // Only the genuinely suppressed state says hidden.
    expect(siteGraphStatusLabel('hidden')).toBe('Hidden')
    expect(siteGraphStatusDescription('hidden')).toMatch(/not to index/i)
  })

  it('colors the non-problem states neutrally, never with the hidden amber', () => {
    for (const state of ['resource', 'redirect'] as const) {
      expect(SITE_GRAPH_COLOR_TOKENS[state].fallback).not.toBe(SITE_GRAPH_COLOR_TOKENS.hidden.fallback)
      expect(SITE_GRAPH_COLOR_TOKENS[state].property).toBe(`--chart-site-health-${state}`)
    }
    // Every state is distinctly colored and distinctly glyphed.
    const colors = SITE_GRAPH_LEGEND_STATES.map((state) => SITE_GRAPH_COLOR_TOKENS[state].fallback)
    expect(new Set(colors).size).toBe(SITE_GRAPH_LEGEND_STATES.length)
    const glyphs = SITE_GRAPH_LEGEND_STATES.map(siteGraphStatusGlyph)
    expect(new Set(glyphs).size).toBe(SITE_GRAPH_LEGEND_STATES.length)
  })

  it('legends every state the derivation can produce', () => {
    expect([...SITE_GRAPH_LEGEND_STATES].sort()).toEqual(
      ['eligible', 'failed', 'hidden', 'redirect', 'resource', 'unchecked'],
    )
    for (const state of SITE_GRAPH_LEGEND_STATES) {
      expect(siteGraphStatusLegendLabel(state)).not.toBe('')
      expect(siteGraphStatusDescription(state)).not.toBe('')
    }
  })
})

describe('siteGraphDisplayPath', () => {
  // Sigma keeps labels apart with a fixed-size grid, so a label far wider than
  // its cell overlaps its neighbours. A real crawl of a property site produced
  // exactly this: three metro paths drawn on top of each other, unreadable.
  it('keeps the leaf segment, which is what identifies the page', () => {
    expect(siteGraphDisplayPath('/apartments/atlanta-metro/dunwoody-apts/')).toBe('…/dunwoody-apts/')
  })

  it('leaves a path that already fits completely untouched', () => {
    expect(siteGraphDisplayPath('/apartments/')).toBe('/apartments/')
    expect(siteGraphDisplayPath('/')).toBe('/')
  })

  it('treats an empty path as the root rather than rendering nothing', () => {
    expect(siteGraphDisplayPath('')).toBe('/')
  })

  it('bounds the result even when the leaf alone is too long', () => {
    const result = siteGraphDisplayPath('/a/an-extremely-long-single-slug-that-will-not-fit-anywhere')
    expect(result.length).toBeLessThanOrEqual(24)
    expect(result.startsWith('…')).toBe(true)
  })

  it('never renders wider than the grid cell assumes, for any depth', () => {
    for (const path of [
      '/apartments/dallas-fort-worth-metro/uptown-apts/',
      '/apartments/northern-virginia-and-dc-metro/rosslyn-apts/',
      '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/',
    ]) {
      expect(siteGraphDisplayPath(path).length).toBeLessThanOrEqual(24)
    }
  })
})
