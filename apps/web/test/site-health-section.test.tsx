import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameTechnicalAeoRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey,
  getApiV1ProjectsByNameTechnicalAeoGraphQueryKey,
  getApiV1ProjectsByNameTechnicalAeoGraphQueryKey,
  getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import {
  linkTileCount,
  LivePageHealthFindings,
  siteHealthMetricHelp,
  siteMapLinkCountsLabel,
  siteMapLinkRuleHelp,
  SiteHealthSection,
  SITE_HEALTH_VIEW_DESCRIPTIONS,
  SITE_MAP_HELP,
  SITE_MAP_LINK_SPLIT_COPY,
  SITE_MAP_STALE_LAYOUT_COPY,
  TEMPLATE_DETECTION_COPY,
  type LivePageHealthPreviewView,
} from '../src/components/project/SiteHealthSection.js'
import { heyClient } from '../src/api.js'

const mutationMock = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  data: undefined as { runId: string; status: 'queued' | 'running' } | undefined,
}))
const technicalAeoMock = vi.hoisted(() => ({ state: 'success' as 'success' | 'unavailable' }))

vi.mock('../src/queries/mutations.js', () => ({
  useTriggerSiteAudit: () => ({
    isPending: mutationMock.isPending,
    data: mutationMock.data,
    mutate: mutationMock.mutate,
  }),
}))

vi.mock('@tanstack/react-router', async () => {
  const React = await import('react')
  return {
    Link: ({
      to,
      params,
      children,
      ...props
    }: {
      to: string
      params: { projectName: string }
      children?: React.ReactNode
    }) => React.createElement('a', {
      ...props,
      href: to.replace('$projectName', encodeURIComponent(params.projectName)),
    }, children),
  }
})

vi.mock('../src/components/project/TechnicalAeoSection.js', () => ({
  TechnicalAeoSection: ({
    runId,
    integrated,
    compactCopy,
    footer,
    unavailableFooter,
  }: {
    runId?: string | null
    integrated?: boolean
    compactCopy?: boolean
    footer?: React.ReactNode
    unavailableFooter?: React.ReactNode
  }) => (
    <div data-integrated={integrated ? 'true' : 'false'} data-compact-copy={compactCopy ? 'true' : 'false'}>
      Page health for {runId ?? 'latest'}
      {technicalAeoMock.state === 'success' ? footer : unavailableFooter}
    </div>
  ),
}))

// Stable ids for the edge arrays the map is handed, so a test can assert the
// renderer was never given a NEW array (which would rebuild Sigma). Hoisted
// because the mock factory runs before this module body does.
const { edgeIdentity } = vi.hoisted(() => {
  const seen = new WeakMap<object, number>()
  let next = 0
  return {
    edgeIdentity(edges: unknown): number {
      if (!edges || typeof edges !== 'object') return -1
      const existing = seen.get(edges as object)
      if (existing !== undefined) return existing
      next += 1
      seen.set(edges as object, next)
      return next
    },
  }
})

vi.mock('../src/components/project/SiteGraphSigma.js', () => ({
  SiteGraphSigma: ({
    nodes,
    edges,
    showTemplateLinks,
    onSelectNode,
  }: {
    nodes: Array<{ nodeKey: string; path: string; x: number; y: number }>
    edges?: Array<{ edgeKey: string }>
    showTemplateLinks?: boolean
    onSelectNode?: (node: { nodeKey: string; path: string; x: number; y: number }) => void
  }) => (
    <div role="img" aria-label="Interactive site map">
      {nodes.map((node) => (
        <button key={node.nodeKey} type="button" onClick={() => onSelectNode?.(node)}>{node.path}</button>
      ))}
      {/* What the renderer was actually handed, so a test can assert which
          links are drawn and that positions never move. */}
      <span data-testid="site-map-edge-keys">{(edges ?? []).map((edge) => edge.edgeKey).join(',')}</span>
      <span data-testid="site-map-show-template">{String(showTemplateLinks)}</span>
      {/* Identity of the edge array the renderer was handed. Toggling must not
          change it, because a new array rebuilds the whole Sigma instance. */}
      <span data-testid="site-map-edges-identity">{String(edgeIdentity(edges))}</span>
      <span data-testid="site-map-node-positions">
        {nodes.map((node) => `${node.nodeKey}:${node.x},${node.y}`).join(';')}
      </span>
    </div>
  ),
}))

const projectName = 'citypoint'
const projectId = 'proj_1'

function scan(
  runId: string,
  status: 'completed' | 'partial' | 'queued' | 'running' | 'failed' | 'cancelled' = 'completed',
  hasCrawlData = true,
) {
  return {
    runId,
    status,
    startedAt: '2026-08-08T18:15:00.000Z',
    finishedAt: status === 'queued' || status === 'running' ? null : '2026-08-08T18:16:33.000Z',
    createdAt: '2026-08-08T18:15:00.000Z',
    hasCrawlData,
  }
}

/** The scan history is served newest first, exactly as the dropdown reads it. */
function scanHistoryKey() {
  return getApiV1ProjectsByNameTechnicalAeoRunsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { limit: 20 },
  })
}

function scanHistory(...scans: ReturnType<typeof scan>[]) {
  return { project: projectName, scans }
}

function livePreview(
  pagesAudited: number,
  examples: LivePageHealthPreviewView['examples'] = [],
  state: LivePageHealthPreviewView['state'] = 'collecting',
): LivePageHealthPreviewView {
  return { state, pagesAudited, examples }
}

function livePageHealthPreviewResponse(
  runId: string,
  state: 'waiting' | 'collecting' | 'terminal',
  pagesAudited: number,
  examples: LivePageHealthPreviewView['examples'] = [],
) {
  return {
    project: projectName,
    runId,
    status: state === 'waiting' ? 'queued' as const : state === 'collecting' ? 'running' as const : 'completed' as const,
    state,
    attemptId: state === 'waiting' ? null : 'attempt_live',
    pagesAudited,
    updatedAt: state === 'waiting' ? null : '2026-08-09T12:00:00.000Z',
    examples,
  }
}

function summary(runId: string, pagesDiscovered: number, complete = true) {
  return {
    project: projectName,
    hasCrawlData: true,
    legacyAuditAvailable: true,
    runId,
    runStatus: complete ? 'completed' as const : 'partial' as const,
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://citypoint.example/',
    crawlSchemaVersion: '1',
    engineVersion: '4.6.2',
    normalizationVersion: '1',
    indexabilityVersion: '1',
    linkScoreVersion: '1',
    effectiveOptions: { checkDeadLinks: false },
    complete,
    // A real `CrawlTerminationReason` from @canonry/aeo-audit, not an invented
    // token: the plain-word copy is a closed map over that exact vocabulary.
    termination: complete ? null : 'max-pages',
    detailsAvailable: true,
    counts: {
      pagesDiscovered,
      pagesFetched: pagesDiscovered - 2,
      pagesEligible: pagesDiscovered - 5,
      edges: pagesDiscovered * 7,
      findings: 4,
    },
    deadLinks: { state: 'disabled' as const },
  }
}

const homePage = {
  nodeKey: 'page_home',
  url: 'https://citypoint.example/',
  finalUrl: 'https://citypoint.example/',
  path: '/',
  parentPath: '/',
  discoverySource: 'root',
  fetchState: 'html',
  httpStatus: 200,
  canonicalUrl: 'https://citypoint.example/',
  indexabilityState: 'indexable',
  indexabilityReasons: [],
  auditState: 'success',
  auditScore: 94,
  inventoryEligible: true,
  depth: 0,
  inboundUniqueEdges: 3,
  outboundUniqueEdges: 8,
  inboundOccurrences: 3,
  outboundOccurrences: 10,
  linkScoreRaw: 1,
  linkScoreNormalized: 1,
  healthState: 'eligible' as const,
}

const servicesPage = {
  ...homePage,
  nodeKey: 'page_services',
  url: 'https://citypoint.example/services/roof-repair',
  finalUrl: 'https://citypoint.example/services/roof-repair',
  path: '/services/roof-repair',
  parentPath: '/services',
  discoverySource: 'internal-link',
  auditScore: 61,
  depth: 3,
  inboundUniqueEdges: 1,
  outboundUniqueEdges: 2,
  inboundOccurrences: 2,
  outboundOccurrences: 2,
  linkScoreRaw: 0.4,
  linkScoreNormalized: 0.4,
}

const contactPage = {
  ...servicesPage,
  nodeKey: 'page_contact',
  url: 'https://citypoint.example/contact',
  finalUrl: 'https://citypoint.example/contact',
  path: '/contact',
  parentPath: '/',
  depth: 1,
}

const contentEdge = {
  edgeKey: 'home-services',
  sourceNodeKey: 'page_home',
  targetNodeKey: 'page_services',
  followable: true,
  occurrences: 2,
  isTemplate: false,
}

/** A nav link: the same anchor to the same page from every page on the site. */
const templateEdge = {
  edgeKey: 'nav-contact',
  sourceNodeKey: 'page_services',
  targetNodeKey: 'page_contact',
  followable: true,
  occurrences: 1,
  isTemplate: true,
}

function seedRun(
  queryClient: QueryClient,
  runId: string,
  crawlSummary = summary(runId, 42),
  graphOverrides: Record<string, unknown> = {},
) {
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId },
  }), crawlSummary)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId,
    rootNodeKey: 'page_home',
    layout: {
      state: 'ready',
      version: 'site-health-fa2-v1',
      computedAt: '2026-08-08T18:16:33.000Z',
      templateLinksExcluded: true,
    },
    templateDetection: 'applied',
    linkKind: 'all',
    totalNodes: 2,
    totalEdges: 1,
    totalTemplateEdges: 0,
    totalContentEdges: 1,
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, x: 1, y: 1 },
    ],
    edges: [contentEdge],
    omittedNodes: 0,
    omittedEdges: 0,
    sampled: false,
    ...graphOverrides,
  })
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, limit: 200, sort: 'path' },
  } as const
  const pagesResponse = {
    project: projectName,
    hasCrawlData: true,
    runId,
    total: 2,
    nextCursor: null,
    pages: [homePage, servicesPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(pagesInput), pagesResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [pagesResponse],
    pageParams: [pagesInput],
  })

  const structureInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, parentPath: '/', limit: 100 },
  } as const
  const structureResponse = {
    project: projectName,
    hasCrawlData: true,
    runId,
    parentPath: '/',
    nextCursor: null,
    children: [{
      path: '/services',
      url: null,
      hasPage: false,
      pageCount: 14,
      inventoryEligibleCount: 12,
      fetchedCount: 14,
    }],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureQueryKey(structureInput), structureResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(structureInput), {
    pages: [structureResponse],
    pageParams: [structureInput],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId,
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, nodeKey: 'page_services' },
  }), {
    state: 'ready',
    project: projectName,
    runId,
    complete: crawlSummary.complete,
    termination: crawlSummary.termination,
    nodeKey: 'page_services',
    url: servicesPage.url,
    auditState: 'complete',
    auditScore: 61,
    evidenceState: 'complete',
    factors: [{
      id: 'content-depth',
      name: 'Content depth',
      weight: 12,
      score: 35,
      status: 'fail',
      applicable: true,
      findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'The page is too thin.' }],
      recommendations: ['Add complete answers to the page.'],
    }],
    criticalDefects: [],
  })
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
  }), summary('run_1', 42))
  seedRun(queryClient, 'run_1')
  return queryClient
}

function renderSection(
  queryClient = makeClient(),
  props: Partial<React.ComponentProps<typeof SiteHealthSection>> = {},
) {
  render(
    <QueryClientProvider client={queryClient}>
      <SiteHealthSection projectName={projectName} projectId={projectId} {...props} />
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  mutationMock.mutate.mockReset()
  mutationMock.isPending = false
  mutationMock.data = undefined
  technicalAeoMock.state = 'success'
  Reflect.deleteProperty(window, '__CANONRY_CONFIG__')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('keeps three fixed live-finding slots while examples grow from zero to one to three', async () => {
  const { rerender } = render(
    <LivePageHealthFindings runId="run_live" preview={livePreview(0)} />,
  )

  const section = screen.getByRole('region', { name: 'Findings so far' })
  const firstSlots = within(section).getAllByTestId('live-page-health-slot')
  expect(firstSlots).toHaveLength(3)
  expect(firstSlots.every((slot) => slot.classList.contains('h-14'))).toBe(true)
  expect(within(section).getByText('Checks that need attention will appear here.')).not.toBeNull()
  expect(within(section).getAllByRole('listitem')).toHaveLength(1)

  rerender(
    <LivePageHealthFindings
      runId="run_live"
      preview={livePreview(1, [{
        nodeKey: 'home',
        url: 'https://example.com/',
        auditScore: 63,
        checksNeedingAttention: 2,
      }])}
    />,
  )

  await waitFor(() => expect(within(section).getByText('https://example.com/')).not.toBeNull())
  const firstFilledSlot = within(section).getAllByTestId('live-page-health-slot')[0]
  expect(firstFilledSlot).toBe(firstSlots[0])
  expect(firstFilledSlot.classList.contains('grid')).toBe(true)
  expect(firstFilledSlot.classList.contains('grid-cols-[minmax(0,1fr)_auto]')).toBe(true)
  expect(firstFilledSlot.classList.contains('gap-2')).toBe(true)
  expect(within(section).getAllByRole('listitem')).toHaveLength(1)
  expect(within(section).getByText('2 checks').getAttribute('aria-hidden')).toBe('true')
  expect(within(section).getAllByText('2 checks need attention').some((node) => node.classList.contains('sr-only'))).toBe(true)

  rerender(
    <LivePageHealthFindings
      runId="run_live"
      preview={livePreview(3, [
        {
          nodeKey: 'contact',
          url: 'https://example.com/contact',
          auditScore: 44,
          checksNeedingAttention: 1,
        },
        {
          nodeKey: 'home',
          url: 'https://example.com/',
          auditScore: 63,
          checksNeedingAttention: 3,
        },
        {
          nodeKey: 'about',
          url: 'https://example.com/about',
          auditScore: 51,
          checksNeedingAttention: 4,
        },
      ])}
    />,
  )

  await waitFor(() => expect(within(section).getByText('https://example.com/contact')).not.toBeNull())
  const finalSlots = within(section).getAllByTestId('live-page-health-slot')
  expect(finalSlots).toEqual(firstSlots)
  const finalUrls = finalSlots.map((slot) => slot.querySelector<HTMLElement>('[title]'))
  expect(finalUrls.map((url) => url?.textContent)).toEqual([
    'https://example.com/',
    'https://example.com/contact',
    'https://example.com/about',
  ])
  expect(finalUrls.every((url) => url?.classList.contains('truncate'))).toBe(true)
  expect(within(section).getAllByRole('listitem')).toHaveLength(3)
})

test('retains latched live findings during a temporary preview error without a focusable changing row', async () => {
  const stableFocus = document.createElement('button')
  document.body.append(stableFocus)
  const { rerender } = render(
    <LivePageHealthFindings
      runId="run_live"
      preview={livePreview(1, [{
        nodeKey: 'home',
        url: 'https://example.com/',
        auditScore: 63,
        checksNeedingAttention: 2,
      }])}
    />,
  )

  await waitFor(() => expect(screen.getByText('https://example.com/')).not.toBeNull())
  stableFocus.focus()
  const row = screen.getByText('https://example.com/').closest('li')

  rerender(
    <LivePageHealthFindings
      runId="run_live"
      preview={livePreview(1, [{
        nodeKey: 'home',
        url: 'https://example.com/',
        auditScore: 63,
        checksNeedingAttention: 2,
      }])}
      error
    />,
  )

  expect(screen.getByText('Live findings paused. The scan is still running.')).not.toBeNull()
  expect(screen.getByText('https://example.com/').closest('li')).toBe(row)
  expect(document.activeElement).toBe(stableFocus)
  expect(within(screen.getByRole('region', { name: 'Findings so far' })).queryAllByRole('button')).toHaveLength(0)
  stableFocus.remove()
})

test('clears the latched live examples when the exact onboarding run changes', async () => {
  const { rerender } = render(
    <LivePageHealthFindings
      runId="run_first"
      preview={livePreview(9, [{
        nodeKey: 'home',
        url: 'https://example.com/',
        auditScore: 63,
        checksNeedingAttention: 2,
      }])}
    />,
  )
  await waitFor(() => expect(screen.getByText('https://example.com/')).not.toBeNull())

  rerender(<LivePageHealthFindings runId="run_second" preview={livePreview(0)} />)

  await waitFor(() => expect(screen.queryByText('https://example.com/')).toBeNull())
  expect(screen.getByText('Checks that need attention will appear here.')).not.toBeNull()
})

test('clears provisional examples as soon as the same run reports a terminal preview', async () => {
  const collectingPreview = {
    ...livePreview(9, [{
      nodeKey: 'home',
      url: 'https://example.com/',
      auditScore: 63,
      checksNeedingAttention: 2,
    }]),
    state: 'collecting' as const,
  }
  const { rerender } = render(<LivePageHealthFindings runId="run_live" preview={collectingPreview} />)

  await waitFor(() => expect(screen.getByText('https://example.com/')).not.toBeNull())
  const slots = screen.getAllByTestId('live-page-health-slot')

  rerender(<LivePageHealthFindings runId="run_live" preview={{ ...livePreview(9), state: 'terminal' }} />)

  expect(screen.queryByText('https://example.com/')).toBeNull()
  expect(screen.getByText('Checks that need attention will appear here.')).not.toBeNull()
  expect(screen.getAllByTestId('live-page-health-slot')).toEqual(slots)
})

test('keeps live findings outside an aria-live region', () => {
  render(<LivePageHealthFindings runId="run_live" preview={livePreview(2)} />)

  const section = screen.getByRole('region', { name: 'Findings so far' })
  expect(section.hasAttribute('aria-live')).toBe(false)
  expect(section.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull()
})

test('leads with the map, truthful crawl metrics, and an explicit disabled dead-link state', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = renderSection()

  expect(screen.getByRole('heading', { name: 'Site Health', level: 2 })).not.toBeNull()
  expect(screen.getByRole('option', { name: 'Latest scan' })).not.toBeNull()
  expect(screen.getByRole('tab', { name: 'Map' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('img', { name: 'Interactive site map' })).not.toBeNull()
  expect(screen.getByText('Indexable')).not.toBeNull()
  expect(screen.getByText('37')).not.toBeNull()
  const internalLinksMetric = screen.getByText('Internal links').parentElement
  expect(internalLinksMetric).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).getByText('1')).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).queryByText('294')).toBeNull()
  expect(screen.getByText('Dead-link check')).not.toBeNull()
  expect(screen.getByText('Broken links: not checked')).not.toBeNull()
  expect(screen.queryByText('0 broken links')).toBeNull()

  const deadLinksKey = getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 50 },
  })
  await waitFor(() => expect(queryClient.getQueryState(deadLinksKey)?.fetchStatus).toBe('idle'))
  expect(queryClient.getQueryState(deadLinksKey)?.dataUpdatedAt).toBe(0)
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('/dead-links')
  })).toBe(false)
})

test('shows the requested and effective hosts when the site moves to a different address', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://new-citypoint.example/',
  })

  renderSection(queryClient)

  const banner = screen.getByRole('status')
  expect(within(banner).getByText('Site address changed during this scan.')).not.toBeNull()
  expect(within(banner).getByText('citypoint.example')).not.toBeNull()
  expect(within(banner).getByText('new-citypoint.example')).not.toBeNull()
  expect(within(banner).getByText(/The map and inventory use the new address/)).not.toBeNull()
})

test('describes a moved host in Page health language during explicit onboarding', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://new-citypoint.example/',
  })

  renderSection(queryClient, { showOnboardingActions: true })

  const banner = screen.getByText('Site address changed during this scan.').closest('[role="status"]')
  expect(banner).not.toBeNull()
  expect(banner!.textContent).toContain('Page health uses the new address.')
  expect(banner!.textContent).not.toMatch(/map|inventory/i)
})

test('does not warn when the submitted site redirects between apex and www', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://www.citypoint.example/',
  })

  renderSection(queryClient)

  expect(screen.queryByText('Site address changed during this scan.')).toBeNull()
})

test('does not warn when the submitted site upgrades from HTTP to HTTPS', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    requestedRootUrl: 'http://citypoint.example/',
    rootUrl: 'https://citypoint.example/',
  })

  renderSection(queryClient)

  expect(screen.queryByText('Site address changed during this scan.')).toBeNull()
})

test('uses the server-owned health state for both the inventory badge and selected-page badge', () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' },
  } as const
  const failedPage = {
    ...servicesPage,
    // Deliberately conflicts with the legacy fields: the server health state wins.
    fetchState: 'html',
    indexabilityState: 'indexable',
    auditState: 'success',
    inventoryEligible: true,
    healthState: 'failed' as const,
  }
  const pagesResponse = {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 2,
    nextCursor: null,
    pages: [homePage, failedPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(pagesInput), pagesResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [pagesResponse],
    pageParams: [pagesInput],
  })
  const graphInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  } as const
  const graph = queryClient.getQueryData<{ nodes: Array<typeof homePage & { x: number; y: number }> }>(
    getApiV1ProjectsByNameTechnicalAeoGraphQueryKey(graphInput),
  )!
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey(graphInput), {
    ...graph,
    nodes: graph.nodes.map((page) => page.nodeKey === failedPage.nodeKey
      ? { ...page, ...failedPage }
      : page),
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  expect(screen.getAllByText('Broken')).toHaveLength(2)
})

test('connects a selected graph page score to its exact audit finding in the same run', () => {
  const queryClient = renderSection()

  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  expect(screen.getByRole('heading', { name: 'Findings and fixes' })).not.toBeNull()
  expect(screen.getByLabelText('Score 61 out of 100')).not.toBeNull()
  expect(screen.getByText('The page is too thin.')).not.toBeNull()
  expect(screen.getByText('Add complete answers to the page.')).not.toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services' },
  }))).not.toBeUndefined()
})

test('uses a labelled, roving-focus tab interface for Site Health views', () => {
  renderSection()

  const map = screen.getByRole('tab', { name: 'Map' })
  const inventory = screen.getByRole('tab', { name: 'Pages' })
  const technical = screen.getByRole('tab', { name: 'Page health' })
  expect(map.getAttribute('id')).toBe('site-health-map-tab')
  expect(map.getAttribute('aria-controls')).toBe('site-health-map-panel')
  expect(map.getAttribute('tabindex')).toBe('0')
  expect(inventory.getAttribute('tabindex')).toBe('-1')
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('site-health-map-tab')

  map.focus()
  fireEvent.keyDown(map, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(inventory)
  expect(inventory.getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('site-health-inventory-tab')

  fireEvent.keyDown(inventory, { key: 'End' })
  expect(document.activeElement).toBe(technical)
  expect(technical.getAttribute('aria-selected')).toBe('true')

  fireEvent.keyDown(technical, { key: 'Home' })
  expect(document.activeElement).toBe(map)
  expect(map.getAttribute('aria-selected')).toBe('true')
})

test('keeps every detail read pinned to the selected historical run', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1'), scan('run_old', 'partial')))
  seedRun(queryClient, 'run_old', summary('run_old', 18, false))
  renderSection(queryClient)

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), {
    target: { value: 'run_old' },
  })

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const neighborKey = getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_old', nodeKey: 'page_services', limit: 100 },
  })
  expect(queryClient.getQueryState(neighborKey)).not.toBeUndefined()
  expect(screen.getAllByText('Clicks from home')).not.toHaveLength(0)
  expect(screen.getAllByText('Link importance')).not.toHaveLength(0)

  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText('Page health for run_old').getAttribute('data-integrated')).toBe('true')
})

test('defaults to the newest terminal run when that scan is partial', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_partial', 'partial'), scan('run_1')))
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))

  renderSection(queryClient)

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()
  expect(screen.getByText(/stopped at the page limit/i)).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText(/stopped at the page limit/i)).not.toBeNull()
})

test('keeps dead-link checks off by default when starting a scan', () => {
  renderSection()

  fireEvent.click(screen.getByText('Scan settings'))
  const checkbox = screen.getByRole('checkbox', { name: 'Check dead links' }) as HTMLInputElement
  expect(checkbox.checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))

  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false },
  })
})

test('releases a pinned onboarding scan before the header starts its replacement', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_1' },
  }), {
    project: projectName,
    runId: 'run_1',
    status: 'completed',
    phase: 'completed',
    attempt: null,
    layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { initialRunId: 'run_1', onReleaseInitialRun })
  const history = screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement
  expect(history.value).toBe('run_1')

  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))

  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false },
  })
  expect(onReleaseInitialRun).toHaveBeenCalledOnce()
  expect(history.value).toBe('')

  act(() => {
    queryClient.setQueryData(
      scanHistoryKey(),
      scanHistory(scan('run_2', 'running', false), scan('run_1')),
    )
  })
  expect(await screen.findByText(/a newer scan is running/i)).not.toBeNull()

  act(() => {
    seedRun(queryClient, 'run_2', summary('run_2', 64))
    queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_2'), scan('run_1')))
  })
  await waitFor(() => expect(screen.getByText('64')).not.toBeNull())
  expect(history.value).toBe('')
})

test('uses the exact active run for a first scan instead of showing stale-map copy', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_active',
    runStatus: 'running',
  })

  renderSection(queryClient, { showOnboardingActions: true })

  const scanProgress = screen.getByRole('region', { name: 'Current scan progress' })
  expect(scanProgress.textContent).toContain('Scanning site')
  expect(scanProgress.textContent).toContain('Page health appears after the scan finishes')
  expect(scanProgress.textContent).not.toContain('map appears')
  expect(screen.getByRole('list', { name: 'Onboarding progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Site audit')
  expect(screen.queryByRole('tablist', { name: 'Site Health views' })).toBeNull()
  expect(screen.queryByRole('tabpanel')).toBeNull()
  expect(scanProgress.textContent).toContain('Scanning site')
  expect(screen.queryByText(/latest completed results remain/i)).toBeNull()
  expect(screen.queryByText('Full-site map not available')).toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }))).not.toBeUndefined()
})

test('offers the onboarding continuation only after the selected active scan reaches its persisted 20-second threshold', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-08T18:15:19.999Z'))
  const queryClient = makeClient()
  const onContinueOnboarding = vi.fn()
  const onSkipOnboarding = vi.fn()
  queryClient.setQueryData(scanHistoryKey(), scanHistory({
    ...scan('run_active', 'running', false),
    createdAt: '2026-08-08T18:15:00.000Z',
  }))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'discovering',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, {
    showOnboardingActions: true,
    onContinueOnboarding,
    onSkipOnboarding,
  })

  expect(screen.queryByRole('heading', { name: 'Continue while Site Health finishes' })).toBeNull()

  act(() => {
    vi.advanceTimersByTime(1)
  })

  expect(screen.getByRole('heading', { name: 'Continue while Site Health finishes' })).not.toBeNull()
  expect(screen.getByText('Canonry will finish this scan locally. Saved results will appear in Site Health.')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Set up AI Visibility' }))
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
  expect(onContinueOnboarding).toHaveBeenCalledOnce()
  expect(onSkipOnboarding).toHaveBeenCalledOnce()
})

test('uses the persisted selected-run timestamp after reload instead of restarting the continuation timer', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-08T18:17:00.000Z'))
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory({
    ...scan('run_handoff', 'running', false),
    createdAt: '2026-08-08T18:15:00.000Z',
  }))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, {
    initialRunId: 'run_handoff',
    showOnboardingActions: true,
    onContinueOnboarding: vi.fn(),
    onSkipOnboarding: vi.fn(),
  })

  expect(screen.getByRole('heading', { name: 'Continue while Site Health finishes' })).not.toBeNull()
})

test('resets the continuation threshold when the selected active run changes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-08T18:15:19.000Z'))
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory({
    ...scan('run_old', 'running', false),
    createdAt: '2026-08-08T18:15:00.000Z',
  }))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_old' },
  }), {
    project: projectName,
    runId: 'run_old',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, {
    showOnboardingActions: true,
    onContinueOnboarding: vi.fn(),
    onSkipOnboarding: vi.fn(),
  })
  expect(screen.queryByRole('heading', { name: 'Continue while Site Health finishes' })).toBeNull()

  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_new' },
  }), {
    project: projectName,
    runId: 'run_new',
    status: 'running',
    phase: 'discovering',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  await act(async () => {
    queryClient.setQueryData(scanHistoryKey(), scanHistory(
      { ...scan('run_new', 'running', false), createdAt: '2026-08-08T18:15:19.000Z' },
      { ...scan('run_old', 'completed'), createdAt: '2026-08-08T18:15:00.000Z' },
    ))
    await vi.advanceTimersByTimeAsync(0)
  })

  act(() => {
    vi.advanceTimersByTime(1_000)
  })
  expect(screen.queryByRole('heading', { name: 'Continue while Site Health finishes' })).toBeNull()
})

test('defers the terminal-only crawl read for an active exact run and keeps progress visible', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'discovering',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    code: 'NOT_FOUND',
    message: 'No completed crawl exists for this run.',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, { initialRunId: 'run_active' })

  await waitFor(() => expect(screen.getByRole('status', { name: 'Current scan progress' })).not.toBeNull())
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Discovering pages')
})

test('uses exact stored progress when the project run list is unavailable', async () => {
  const queryClient = makeClient()
  queryClient.removeQueries({
    queryKey: scanHistoryKey(),
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  const requestedPaths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    requestedPaths.push(new URL(url).pathname)
    return new Response('{"error":{"message":"run list unavailable"}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }))

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  const progress = await screen.findByRole('status', { name: 'Current scan progress' })
  expect(progress.textContent).toContain('Checking pages')
  expect(progress.closest('[role="tabpanel"]')?.getAttribute('id')).toBe('site-health-map-panel')
  expect(requestedPaths.some((path) => path.endsWith('/technical-aeo/crawl'))).toBe(false)
})

test('releases a stale exact handoff after the stored progress route returns not found', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/runs/run_missing/progress')) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Run not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
  }))

  renderSection(queryClient, { initialRunId: 'run_missing', onReleaseInitialRun })

  await waitFor(() => expect(onReleaseInitialRun).toHaveBeenCalledOnce())
  expect(screen.queryByRole('status', { name: 'Current scan progress' })).toBeNull()
  expect(screen.getByRole('img', { name: 'Interactive site map' })).not.toBeNull()
})

test('releases local exact-run selection when durable handoff state is cleared', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_1' },
  }), {
    project: projectName,
    runId: 'run_1',
    status: 'completed',
    phase: 'completed',
    attempt: null,
    layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: null },
    error: null,
  })
  const view = (initialRunId?: string) => (
    <QueryClientProvider client={queryClient}>
      <SiteHealthSection projectName={projectName} projectId={projectId} initialRunId={initialRunId} />
    </QueryClientProvider>
  )
  const { rerender } = render(view('run_1'))
  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('run_1')

  rerender(view(undefined))

  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('')
})

test('pins an onboarding handoff to its exact active scan after reload', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_handoff', 'running', false), scan('run_previous')),
  )
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_handoff' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_handoff',
    runStatus: 'running',
  })

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  expect(screen.getByRole('region', { name: 'Current scan progress' }).textContent).toContain('Scanning site')
  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('run_handoff')
  expect(screen.queryByRole('img', { name: 'Interactive site map' })).toBeNull()
})

test('releases final Page Health as soon as exact progress is terminal despite stale running scan history', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff', 'running', false), scan('run_previous')))
  seedRun(queryClient, 'run_handoff')
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'completed',
    phase: 'completed',
    attempt: null,
    layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: '2026-08-09T12:00:01.000Z' },
    error: null,
  })

  renderSection(queryClient, { showOnboardingActions: true, initialRunId: 'run_handoff' })

  expect(screen.queryByRole('region', { name: 'Current scan progress' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Page health' })).not.toBeNull()
  expect(screen.getByText('Page health for run_handoff')).not.toBeNull()
})

test('shows exact stored scan progress as raw stages and counts, never a fabricated percentage', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_active',
    runStatus: 'running',
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'checking',
    attempt: {
      id: 'attempt_1',
      state: 'running',
      pagesDiscovered: 47,
      pagesFetched: 19,
      pagesEligible: 16,
      pagesErrored: 2,
      edgesDiscovered: 105,
      lastUpdatedAt: '2026-08-09T12:00:00.000Z',
      startedAt: '2026-08-09T11:58:00.000Z',
      finishedAt: null,
      error: null,
    },
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient)

  const phase = screen.getByRole('status', { name: 'Current scan progress' })
  const progress = screen.getByRole('region', { name: 'Current scan progress' })
  expect(within(phase).getByText(/Checking pages/)).not.toBeNull()
  expect(within(progress).getByText('47')).not.toBeNull()
  expect(within(progress).getByText('19')).not.toBeNull()
  expect(within(progress).getByText('Links found')).not.toBeNull()
  expect(within(progress).queryByText('Internal links found')).toBeNull()
  expect(within(progress).getByText('105')).not.toBeNull()
  expect(within(progress).getByText('2')).not.toBeNull()
  expect(progress.textContent).not.toMatch(/\d+%/)
})

test('reserves live counters and Page Health finding space before the scan attempt has persisted', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_queued', 'queued', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_queued' },
  }), {
    project: projectName,
    runId: 'run_queued',
    status: 'queued',
    phase: 'queued',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { showOnboardingActions: true, initialRunId: 'run_queued' })

  const progress = screen.getByRole('region', { name: 'Current scan progress' })
  const phase = screen.getByRole('status', { name: 'Current scan progress' })
  const counters = within(progress).getByLabelText('Live scan counters')
  const findings = within(progress).getByRole('region', { name: 'Findings so far' })

  expect(within(counters).getAllByText('—')).toHaveLength(4)
  expect(within(findings).getAllByTestId('live-page-health-slot')).toHaveLength(3)
  expect(phase.getAttribute('aria-live')).toBe('polite')
  expect(phase.getAttribute('aria-atomic')).toBe('true')
  expect(phase.classList.contains('min-h-[4.5rem]')).toBe(true)
  expect(progress.hasAttribute('aria-live')).toBe(false)
  expect(counters.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull()
  expect(findings.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull()
})

test('uses the selected active onboarding run for provisional Page Health evidence', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(
    scan('run_newer', 'running', false),
    scan('run_selected', 'running', false),
  ))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_selected' },
  }), {
    project: projectName,
    runId: 'run_selected',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_selected' },
  }), livePageHealthPreviewResponse('run_selected', 'collecting', 12, [{
    nodeKey: 'selected-page',
    url: 'https://example.com/selected',
    auditScore: 42,
    checksNeedingAttention: 3,
  }]))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_newer' },
  }), livePageHealthPreviewResponse('run_newer', 'collecting', 9, [{
    nodeKey: 'wrong-page',
    url: 'https://example.com/wrong',
    auditScore: 20,
    checksNeedingAttention: 9,
  }]))

  renderSection(queryClient, { showOnboardingActions: true, initialRunId: 'run_selected' })

  const findings = await screen.findByRole('region', { name: 'Findings so far' })
  expect(within(findings).getByText('Based on 12 audited pages. Results may change until the scan finishes.')).not.toBeNull()
  expect(within(findings).getByText('https://example.com/selected')).not.toBeNull()
  expect(within(findings).getAllByText('3 checks need attention')).not.toHaveLength(0)
  expect(within(findings).queryByText('https://example.com/wrong')).toBeNull()
})

test('does not request provisional Page Health evidence outside explicit onboarding', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, { initialRunId: 'run_active' })

  await act(async () => {})
  expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(expect.stringContaining('/page-health-preview'))
  expect(screen.queryByRole('region', { name: 'Findings so far' })).toBeNull()
})

test('stops the onboarding Page Health preview poll when the server reports its terminal state', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  let previewCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/page-health-preview')) {
      previewCalls++
      return new Response(JSON.stringify(livePageHealthPreviewResponse(
        'run_active',
        previewCalls === 1 ? 'collecting' : 'terminal',
        3,
        previewCalls === 1 ? [{
          nodeKey: 'home',
          url: 'https://example.com/',
          auditScore: 45,
          checksNeedingAttention: 2,
        }] : [],
      )), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
  }))

  renderSection(queryClient, { showOnboardingActions: true, initialRunId: 'run_active' })

  await waitFor(() => expect(previewCalls).toBe(1))
  await screen.findByText('https://example.com/')
  await vi.advanceTimersByTimeAsync(3_100)
  await waitFor(() => expect(previewCalls).toBeGreaterThanOrEqual(2))
  expect(screen.queryByText('https://example.com/')).toBeNull()
  const callsAtTerminal = previewCalls

  await vi.advanceTimersByTimeAsync(9_500)
  expect(previewCalls).toBe(callsAtTerminal)
})

test('keeps the exact onboarding run in arranging-map state until its terminal layout is published', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff')))
  seedRun(queryClient, 'run_handoff')
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'completed',
    phase: 'arranging-map',
    attempt: {
      id: 'attempt_1',
      state: 'completed',
      pagesDiscovered: 42,
      pagesFetched: 40,
      pagesEligible: 37,
      pagesErrored: 0,
      edgesDiscovered: 294,
      lastUpdatedAt: '2026-08-09T12:00:00.000Z',
      startedAt: '2026-08-09T11:58:00.000Z',
      finishedAt: '2026-08-09T12:00:00.000Z',
      error: null,
    },
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  const progress = screen.getByRole('status', { name: 'Current scan progress' })
  expect(progress.textContent).toContain('Arranging map')
  expect(screen.queryByRole('img', { name: 'Interactive site map' })).toBeNull()
})

test('waits for arranging-map to finish before loading the large graph payload', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff')))
  seedRun(queryClient, 'run_handoff')
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { runId: 'run_handoff', maxNodes: 20_000, maxEdges: 50_000 },
    }),
  })
  const progressKey = getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  })
  const arrangingProgress = {
    project: projectName,
    runId: 'run_handoff',
    status: 'completed' as const,
    phase: 'arranging-map' as const,
    attempt: null,
    layout: { state: 'pending' as const, layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  }
  queryClient.setQueryData(progressKey, arrangingProgress)
  let layoutPublished = false
  const graphRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/graph')) return new Response('{}', { status: 500 })
    graphRequests.push(url)
    if (!layoutPublished) {
      return new Response('{"error":{"message":"layout pending"}}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      project: projectName,
      hasCrawlData: true,
      runId: 'run_handoff',
      layout: { state: 'ready', version: 'site-health-fa2-v1', computedAt: '2026-08-09T12:00:01.000Z' },
      totalNodes: 2,
      totalEdges: 1,
      nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }],
      edges: [],
      omittedNodes: 0,
      omittedEdges: 0,
      sampled: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))

  renderSection(queryClient, { initialRunId: 'run_handoff' })
  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Arranging map')

  layoutPublished = true
  act(() => {
    queryClient.setQueryData(progressKey, {
      ...arrangingProgress,
      phase: 'completed',
      layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: '2026-08-09T12:00:01.000Z' },
    })
  })

  await screen.findByRole('img', { name: 'Interactive site map' })
  expect(graphRequests).toHaveLength(1)
})

test('offers rerun recovery when a pinned onboarding scan is cancelled before a map exists', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff', 'cancelled', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'cancelled',
    phase: 'cancelled',
    attempt: null,
    layout: { state: 'unavailable', layoutVersion: null, failureCode: 'CANCELLED', updatedAt: null },
    error: null,
  })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    code: 'NOT_FOUND',
    message: 'No completed crawl exists for this run.',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, {
    initialRunId: 'run_handoff',
    onReleaseInitialRun,
    showOnboardingActions: true,
  })

  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const recovery = screen.getByRole('alert', { name: 'Site scan recovery' })
  expect(recovery.textContent).toContain('Scan cancelled')
  expect(recovery.textContent).toContain('before Canonry could publish page health results')
  expect(recovery.textContent).not.toContain('site map')
  expect(screen.queryByRole('tablist', { name: 'Site Health views' })).toBeNull()
  expect(screen.getByRole('list', { name: 'Onboarding progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Site audit')
  fireEvent.click(within(recovery).getByRole('button', { name: 'Run scan again' }))
  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: true },
  })
  expect(onReleaseInitialRun).toHaveBeenCalledOnce()
})

test('keeps measurement-plan setup out of Site Health', () => {
  renderSection()

  expect(screen.queryByRole('link', { name: 'Build measurement plan' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Define what to measure' })).toBeNull()
})

test('moves explicit onboarding into Page health before the optional AI Visibility handoff', () => {
  const onContinueOnboarding = vi.fn()
  const onSkipOnboarding = vi.fn()
  renderSection(makeClient(), {
    showOnboardingActions: true,
    onContinueOnboarding,
    onSkipOnboarding,
  })

  expect(screen.queryByRole('dialog')).toBeNull()
  const onboardingProgress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(onboardingProgress.querySelector('[aria-current="step"]')?.textContent).toContain('Page health')
  expect(within(onboardingProgress).getByText('AI Visibility').closest('li')?.getAttribute('aria-current')).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'View a Site Health scan' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site Health' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site audit complete' })).toBeNull()
  expect(screen.queryByRole('tablist', { name: 'Site Health views' })).toBeNull()
  expect(screen.queryByText('Dead-link check')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review fixes' })).toBeNull()
  expect(screen.getByText('Page health for run_1').getAttribute('data-compact-copy')).toBe('true')

  const pageHealthHeading = screen.getByRole('heading', { name: 'Page health' })
  const pageHealth = screen.getByText('Page health for run_1')
  const handoffHeading = screen.getByRole('heading', { name: 'Next: Set up AI Visibility' })
  const handoff = handoffHeading.closest('section')
  expect(handoff).not.toBeNull()
  expect(Boolean(pageHealthHeading.compareDocumentPosition(handoff!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(Boolean(pageHealth.compareDocumentPosition(handoff!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(screen.getByText('See whether answer engines mention your brand and cite your pages.')).not.toBeNull()
  expect(screen.queryByText(/Page health shows the onsite fixes/i)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Set up AI Visibility' }))
  expect(onContinueOnboarding).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
  expect(onSkipOnboarding).toHaveBeenCalledOnce()
})

test('does not expose explicit onboarding actions in regular Site Health', () => {
  renderSection()

  expect(screen.queryByRole('heading', { name: 'Site audit complete' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review fixes' })).toBeNull()
  expect(screen.getByRole('tablist', { name: 'Site Health views' })).not.toBeNull()
  expect(screen.getByRole('tab', { name: 'Map' })).not.toBeNull()
  expect(screen.getByText('Dead-link check')).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.queryByRole('heading', { name: 'Page health' })).toBeNull()
  expect(screen.getByText('Page health for run_1').getAttribute('data-compact-copy')).toBe('false')
})

test('labels a usable partial onboarding audit without claiming full completion', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_partial', 'partial')))
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))

  renderSection(queryClient, { showOnboardingActions: true })

  expect(screen.getByText('Page health for run_partial')).not.toBeNull()
  expect(screen.getByText('This scan stopped at the page limit, so some pages were not checked.')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site audit finished with partial coverage' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site audit complete' })).toBeNull()
  expect(screen.queryByRole('tablist', { name: 'Site Health views' })).toBeNull()
})

test('keeps a partial crawl recoverable when it publishes no Page health score', () => {
  const onContinueOnboarding = vi.fn()
  const onSkipOnboarding = vi.fn()
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_partial', 'partial')))
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))
  technicalAeoMock.state = 'unavailable'

  renderSection(queryClient, {
    showOnboardingActions: true,
    onContinueOnboarding,
    onSkipOnboarding,
  })

  expect(screen.getByRole('region', { name: 'Page health recovery' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Set up AI Visibility' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
  expect(onContinueOnboarding).not.toHaveBeenCalled()
  expect(onSkipOnboarding).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Run site audit again' }))
  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: true },
  })
})

test('keeps explicit onboarding recoverable and follows the active replacement after a terminal scan publishes no crawl data', async () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 0),
    hasCrawlData: false,
    detailsAvailable: false,
    counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
  })

  renderSection(queryClient, { showOnboardingActions: true })

  expect(screen.getByRole('heading', { name: 'Page health results unavailable' })).not.toBeNull()
  expect(screen.getByText('This scan did not produce page health results. Run it again to continue setup.')).not.toBeNull()
  expect(screen.queryByText(/map|graph|inventory/i)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run scan again' }))
  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: true },
  })

  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_2' },
  }), {
    project: projectName,
    runId: 'run_2',
    status: 'running',
    phase: 'discovering',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  act(() => {
    queryClient.setQueryData(
      scanHistoryKey(),
      scanHistory(scan('run_2', 'running', false), scan('run_1', 'completed', false)),
    )
  })

  expect((await screen.findByRole('status', { name: 'Current scan progress' })).textContent).toContain('Discovering pages')
  expect(screen.queryByRole('heading', { name: 'Full-site map not available' })).toBeNull()
})

test('does not request map, inventory, or dead-link data for ready explicit onboarding', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1' },
  }), {
    ...summary('run_1', 42),
    deadLinks: { state: 'complete' as const, checked: 42, found: 0 },
  })
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
    }),
  })
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' as const },
  }
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput),
  })
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { runId: 'run_1', limit: 50 },
    }),
  })
  const fetchMock = vi.fn(async () => new Response('{"error":"unavailable"}', {
    status: 503,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, { showOnboardingActions: true })

  expect(screen.getByText('Page health for run_1')).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'Next: Set up AI Visibility' })).not.toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.queryByText('The interactive map could not be loaded.')).toBeNull()
  expect(screen.queryByRole('tablist', { name: 'Site Health views' })).toBeNull()
})

test('keeps the scan state visible while an onboarding retry mutation is pending', () => {
  mutationMock.isPending = true

  renderSection(makeClient(), { showOnboardingActions: true })

  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Page health appears after the scan finishes')
  expect(screen.queryByText('Page health for run_1')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Next: Set up AI Visibility' })).toBeNull()
  expect(screen.queryByRole('tabpanel')).toBeNull()
})

test('uses the mutation run id until scan history contains the newly queued onboarding run', () => {
  const queryClient = makeClient()
  mutationMock.data = { runId: 'run_2', status: 'queued' }
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_stale', 'running', false), scan('run_1')),
  )
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_stale' },
  }), {
    project: projectName,
    runId: 'run_stale',
    status: 'running',
    phase: 'fetching-pages',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_2' },
  }), {
    project: projectName,
    runId: 'run_2',
    status: 'queued',
    phase: 'queued',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { showOnboardingActions: true })

  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Waiting to start')
  expect(screen.queryByText('Page health for run_1')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Next: Set up AI Visibility' })).toBeNull()
})

test.each([
  ['queued', 'failed', 'Scan failed'],
  ['running', 'cancelled', 'Scan cancelled'],
] as const)('keeps the replacement scan selected when it transitions from %s to %s', async (startStatus, status, heading) => {
  const queryClient = makeClient()
  mutationMock.data = { runId: 'run_2', status: startStatus }
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_2', startStatus, false), scan('run_1')),
  )
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_2' },
  }), {
    project: projectName,
    runId: 'run_2',
    status: startStatus,
    phase: startStatus === 'queued' ? 'queued' : 'fetching-pages',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { showOnboardingActions: true })
  expect(screen.getByRole('status', { name: 'Current scan progress' })).not.toBeNull()

  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_2', status, false), scan('run_1')),
  )

  const recovery = await screen.findByRole('alert', { name: 'Site scan recovery' })
  expect(within(recovery).getByRole('heading', { name: heading })).not.toBeNull()
  expect(screen.queryByText('Page health for run_1')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Next: Set up AI Visibility' })).toBeNull()
})

test('hides graph-only detail copy when an onboarding crawl has no explorer payload', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    detailsAvailable: false,
  })

  renderSection(queryClient, { showOnboardingActions: true })

  expect(screen.getByText('Page health for run_1')).not.toBeNull()
  expect(screen.queryByText(/page graph|map|inventory/i)).toBeNull()
})

test('loads the complete inventory in 200-page batches', async () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' as const },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 3,
      nextCursor: 'cursor_2',
      pages: [homePage, servicesPage],
    }],
    pageParams: [pagesInput],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/crawl/pages')) {
      return new Response('{}', { status: 500 })
    }
    return new Response(JSON.stringify({
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 3,
      nextCursor: null,
      pages: [contactPage],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  expect(screen.getByText('Showing 2 of 3 pages found.')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load more pages' }))

  await waitFor(() => expect(screen.getByText('Showing 3 of 3 pages found.')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('cursor=cursor_2')
  })).toBe(true)
  expect(screen.getByRole('button', { name: '/contact' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Load more pages' })).toBeNull()
})

test('makes loaded-window inventory search limits explicit', () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' as const },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 500,
      nextCursor: 'cursor_2',
      pages: [homePage, servicesPage],
    }],
    pageParams: [pagesInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded pages' }), {
    target: { value: '/not-loaded-yet' },
  })

  expect(screen.getByText('No matches in the 2 loaded pages. Load more pages to continue searching.')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Load more pages' })).not.toBeNull()
  expect(screen.queryByText('No pages match this search.')).toBeNull()
})

test('expands site sections lazily while preserving the selected run', () => {
  const queryClient = makeClient()
  const nestedInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', parentPath: '/services', limit: 100 },
  } as const
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(nestedInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      parentPath: '/services',
      nextCursor: null,
      children: [{
        path: '/services/roof-repair',
        url: servicesPage.url,
        hasPage: true,
        pageCount: 1,
        inventoryEligibleCount: 1,
        fetchedCount: 1,
      }],
    }],
    pageParams: [nestedInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: 'Expand /services' }))

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  expect(within(sections).getByRole('button', { name: '/services/roof-repair' })).not.toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(nestedInput))).not.toBeUndefined()
})

test('keeps Site sections first in visual and keyboard order', () => {
  const queryClient = makeClient()

  renderSection(queryClient)

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  const explorer = sections.parentElement
  expect(explorer?.id).toBe('site-health-map-explorer')
  expect(explorer?.className).toContain('lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]')
  expect(explorer?.className).not.toContain('sm:grid-cols-')
  expect(explorer?.firstElementChild).toBe(sections)
  expect(explorer?.lastElementChild?.className).toContain('min-w-0')
})

test('queries dead-link details only when the summary says the check ran', async () => {
  const queryClient = makeClient()
  const enabledSummary = {
    ...summary('run_1', 42),
    effectiveOptions: { checkDeadLinks: true },
    deadLinks: { state: 'complete' as const, checked: 41, found: 3, unverified: 0 },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
  }), enabledSummary)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1' },
  }), enabledSummary)
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/dead-links')) return new Response('{}', { status: 500 })
    return new Response(JSON.stringify({
      project: projectName,
      runId: 'run_1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 41,
      found: 3,
      unverified: 0,
      total: 3,
      nextCursor: null,
      deadLinks: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient)

  await waitFor(() => expect(screen.getByText('Broken links: 3 found')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('/technical-aeo/dead-links')
  })).toBe(true)
})

test('does not call a scan clean when some links could never be fetched', async () => {
  // The reported shape: nothing broken, six links unreachable. "none found"
  // alone would claim an absence the scan never established, and the six must
  // never be folded into the broken count.
  const queryClient = makeClient()
  const enabledSummary = {
    ...summary('run_1', 42),
    effectiveOptions: { checkDeadLinks: true },
    deadLinks: { state: 'complete' as const, checked: 193, found: 0, unverified: 6 },
  }
  for (const query of [undefined, { runId: 'run_1' }]) {
    queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
      client: heyClient,
      path: { name: projectName },
      ...(query ? { query } : {}),
    }), enabledSummary)
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/dead-links')) return new Response('{}', { status: 500 })
    return new Response(JSON.stringify({
      project: projectName,
      runId: 'run_1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 193,
      found: 0,
      unverified: 6,
      total: 0,
      nextCursor: null,
      deadLinks: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  renderSection(queryClient)

  await waitFor(() => expect(screen.getByText('Broken links: none found, 6 unchecked')).not.toBeNull())
  expect(screen.queryByText('Broken links: none found')).toBeNull()
  expect(screen.queryByText('Broken links: 6 found')).toBeNull()
})

test('reports broken and unchecked links side by side when both exist', async () => {
  const queryClient = makeClient()
  const enabledSummary = {
    ...summary('run_1', 42),
    effectiveOptions: { checkDeadLinks: true },
    deadLinks: { state: 'complete' as const, checked: 40, found: 2, unverified: 5 },
  }
  for (const query of [undefined, { runId: 'run_1' }]) {
    queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
      client: heyClient,
      path: { name: projectName },
      ...(query ? { query } : {}),
    }), enabledSummary)
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/dead-links')) return new Response('{}', { status: 500 })
    return new Response(JSON.stringify({
      project: projectName,
      runId: 'run_1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 40,
      found: 2,
      unverified: 5,
      total: 2,
      nextCursor: null,
      deadLinks: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  renderSection(queryClient)

  // 2 and 5 stay separate numbers; the badge never shows their sum.
  await waitFor(() => expect(screen.getByText('Broken links: 2 found, 5 unchecked')).not.toBeNull())
  expect(screen.queryByText('Broken links: 7 found')).toBeNull()
})

test('lets long selected paths and URLs wrap in the page inspector', () => {
  renderSection()
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const path = screen.getByRole('heading', { name: '/services/roof-repair', level: 3 })
  const url = screen.getByText(servicesPage.url)
  expect(path.className).toContain('break-words')
  expect(path.className).not.toContain('truncate')
  expect(url.className).toContain('break-all')
  expect(url.className).not.toContain('truncate')
})

test('contains selected-page link tables inside mobile-safe grid items', () => {
  const queryClient = makeClient()
  const edge = {
    edgeKey: 'home-services',
    sourceNodeKey: homePage.nodeKey,
    sourceUrl: homePage.url,
    targetNodeKey: servicesPage.nodeKey,
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [edge],
    outbound: [{ ...edge, edgeKey: 'services-home', sourceNodeKey: servicesPage.nodeKey, sourceUrl: servicesPage.url, targetNodeKey: homePage.nodeKey, targetUrl: homePage.url }],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  const linksIn = screen.getByRole('region', { name: 'Links in (1)' })
  const linksOut = screen.getByRole('region', { name: 'Links out (1)' })
  expect(linksIn.className).toContain('min-w-0')
  expect(linksOut.className).toContain('min-w-0')
})

test('keeps the legacy scorecard available as a subordinate page-health view', () => {
  renderSection()

  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))

  expect(screen.getByText('Page health for run_1')).not.toBeNull()
})

test('removes map-specific chrome from the Page health view', () => {
  renderSection()

  // The view description is a tooltip on the heading now, so it is reachable
  // by its accessible name rather than rendered as a second line of prose.
  expect(screen.getByRole('button', { name: SITE_HEALTH_VIEW_DESCRIPTIONS.map })).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))

  expect(screen.getByRole('button', { name: SITE_HEALTH_VIEW_DESCRIPTIONS.technical })).not.toBeNull()
  expect(screen.queryByText('Pages found')).toBeNull()
  expect(screen.queryByText('Dead-link check')).toBeNull()
  expect(screen.getByText('Page health for run_1')).not.toBeNull()
})

test('marks a score-only scan in the history and renders its legacy state, not an error', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_1'), scan('run_legacy', 'completed', false)),
  )
  // With the route fix a legacy run answers 200 with hasCrawlData:false rather
  // than 404, so the existing no-crawl path takes over.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_legacy' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: true,
    runId: null,
    runStatus: null,
    requestedRootUrl: null,
    rootUrl: null,
    effectiveOptions: {},
    complete: false,
    termination: null,
    detailsAvailable: false,
    counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
    deadLinks: { state: 'unavailable' as const },
  })

  renderSection(queryClient)

  const legacyOption = screen.getByRole('option', { name: /Score only/ }) as HTMLOptionElement
  expect(legacyOption.value).toBe('run_legacy')
  const crawlOption = screen.getByRole('option', { name: /Completed$/ }) as HTMLOptionElement
  expect(crawlOption.value).toBe('run_1')

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), {
    target: { value: 'run_legacy' },
  })

  expect(screen.getByRole('heading', { name: 'Full-site map not available' })).not.toBeNull()
  expect(screen.getByText(/Existing page health results are preserved/)).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site Health could not load' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('narrows the page list to hidden pages through the server-side filter', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const hiddenPage = {
    ...contactPage,
    nodeKey: 'page_hidden',
    url: 'https://citypoint.example/thank-you',
    finalUrl: 'https://citypoint.example/thank-you',
    path: '/thank-you',
    indexabilityState: 'noindex',
    indexabilityReasons: ['meta-robots-noindex', 'x-robots-noindex', 'brand-new-crawler-reason'],
    healthState: 'hidden' as const,
  }
  const hiddenInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const hiddenResponse = {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 1,
    nextCursor: null,
    pages: [hiddenPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(hiddenInput), hiddenResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(hiddenInput), {
    pages: [hiddenResponse],
    pageParams: [hiddenInput],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_hidden', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_hidden',
    url: hiddenPage.url,
    inbound: [],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  const allChip = screen.getByRole('button', { name: 'All' })
  const hiddenChip = screen.getByRole('button', { name: 'Hidden pages' })
  expect(allChip.getAttribute('aria-pressed')).toBe('true')
  expect(hiddenChip.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: '/services/roof-repair' })).not.toBeNull()

  fireEvent.click(hiddenChip)

  expect(hiddenChip.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '/thank-you' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: '/services/roof-repair' })).toBeNull()

  // The reasons read in plain words, and an unknown one is shown rather than dropped.
  fireEvent.click(screen.getByRole('button', { name: '/thank-you' }))
  const reasons = screen.getByRole('list', { name: 'Why this page is hidden' })
  expect(within(reasons).getByText('Hidden by meta robots tag')).not.toBeNull()
  expect(within(reasons).getByText('Hidden by X-Robots-Tag header')).not.toBeNull()
  expect(within(reasons).getByText('brand-new-crawler-reason')).not.toBeNull()
})

test('writes same-site link targets as paths and keeps the full URL on hover', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const baseEdge = {
    edgeKey: 'home-services',
    sourceNodeKey: homePage.nodeKey,
    sourceUrl: homePage.url,
    targetNodeKey: servicesPage.nodeKey,
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [baseEdge],
    outbound: [
      {
        ...baseEdge,
        edgeKey: 'services-offsite',
        sourceNodeKey: servicesPage.nodeKey,
        sourceUrl: servicesPage.url,
        targetNodeKey: null,
        targetUrl: 'https://directory.example/citypoint',
      },
    ],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const linksIn = screen.getByRole('region', { name: 'Links in (1)' })
  const homeCell = within(linksIn).getByText('/')
  expect(homeCell.getAttribute('title')).toBe('https://citypoint.example/')
  expect(within(linksIn).queryByText('https://citypoint.example/')).toBeNull()

  // A genuinely cross-host target is never disguised as an internal path.
  const linksOut = screen.getByRole('region', { name: 'Links out (1)' })
  expect(within(linksOut).getByText('https://directory.example/citypoint')).not.toBeNull()
})

test('inspects a map page that is outside the loaded inventory window', async () => {
  // The map holds every node while the inventory pages 200 at a time. This
  // selects a node that is ONLY on the map, so the by-key read is the only
  // thing that can supply its reasons.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const offWindowPage = {
    ...contactPage,
    nodeKey: 'page_far',
    url: 'https://citypoint.example/far',
    path: '/far',
    indexabilityState: 'noindex',
    indexabilityReasons: ['x-robots-noindex'],
    healthState: 'hidden' as const,
  }
  // On the map, absent from the loaded inventory page.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', rootNodeKey: 'page_home',
    layout: { state: 'ready', version: 'site-health-fa2-v2', computedAt: '2026-08-08T18:16:33.000Z' },
    totalNodes: 3, totalEdges: 1,
    nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }, { ...offWindowPage, x: 2, y: 2 }],
    edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
  })
  const byKeyInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_far', limit: 1 },
  } as const
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(byKeyInput), {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null,
    healthStateFilter: null, pages: [offWindowPage],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_far', limit: 100 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', nodeKey: 'page_far',
    url: offWindowPage.url, inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
  })

  renderSection(queryClient)
  // Select it from the MAP, which is the only place it appears.
  fireEvent.click(screen.getByRole('button', { name: '/far' }))

  // The by-key read is what supplies its reasons; without it this page would
  // render as though the crawler gave no reason at all.
  await waitFor(() => expect(
    within(screen.getByRole('list', { name: 'Why this page is hidden' }))
      .getByText('Hidden by X-Robots-Tag header'),
  ).not.toBeNull())
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(byKeyInput)))
    .not.toBeUndefined()
})

test('says the reasons are unknown when the single-page read fails', async () => {
  // A failed read is not "this page has no reasons". Rendering it as such is
  // indistinguishable from a page that genuinely has none.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient, path: { name: projectName },
  }), summary('run_1', 42))
  seedRun(queryClient, 'run_1')
  const offWindowPage = {
    ...contactPage, nodeKey: 'page_far', url: 'https://citypoint.example/far', path: '/far',
    indexabilityState: 'noindex', indexabilityReasons: ['x-robots-noindex'], healthState: 'hidden' as const,
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', rootNodeKey: 'page_home',
    layout: { state: 'ready', version: 'site-health-fa2-v2', computedAt: '2026-08-08T18:16:33.000Z' },
    totalNodes: 3, totalEdges: 1,
    nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }, { ...offWindowPage, x: 2, y: 2 }],
    edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/far' }))

  // The by-key read is left to fail against the stubbed 500.
  await waitFor(() => expect(
    screen.getByText(/any reason this page is hidden is unknown/i),
  ).not.toBeNull())
  expect(screen.queryByRole('list', { name: 'Why this page is hidden' })).toBeNull()
})

test('keeps a filtered selection until the server says it does not match', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const hiddenPage = {
    ...contactPage,
    nodeKey: 'page_hidden_far',
    url: 'https://citypoint.example/thanks',
    path: '/thanks',
    indexabilityState: 'noindex',
    indexabilityReasons: ['meta-robots-noindex'],
    healthState: 'hidden' as const,
  }
  const hiddenListInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const hiddenListResponse = {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null,
    healthStateFilter: 'applied' as const, pages: [hiddenPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(hiddenListInput), hiddenListResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(hiddenListInput), {
    pages: [hiddenListResponse], pageParams: [hiddenListInput],
  })
  // The server confirms this page is NOT in the filtered set.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', nodeKey: 'page_services', limit: 1 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 0, nextCursor: null,
    healthStateFilter: 'applied' as const, pages: [],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hidden pages' }))

  // The selection is dropped because the SERVER answered, not because the
  // page was missing from the loaded window.
  await waitFor(() => expect(screen.getByRole('button', { name: '/thanks' })).not.toBeNull())
  expect(screen.getByText('Select a page to inspect its internal links and crawl signals.')).not.toBeNull()
})

test('says so when a scan is too old to filter, instead of showing an empty list', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const legacyInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const legacyResponse = {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 0, nextCursor: null,
    healthStateFilter: 'unavailable-legacy-scan' as const, pages: [],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(legacyInput), legacyResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(legacyInput), {
    pages: [legacyResponse], pageParams: [legacyInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hidden pages' }))

  expect(screen.getByText('This scan cannot be filtered. Run a new scan to filter its pages.')).not.toBeNull()
})

test('leads the site sections list with the root page, which is in no folder', async () => {
  // The sections list shows folders, and the home page belongs to none of
  // them, so it used to be the one page with nowhere to click.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_home', limit: 100 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', nodeKey: 'page_home',
    url: homePage.url, inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
  })

  renderSection(queryClient)

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  const rows = within(sections).getAllByRole('listitem')
  // The root leads the list, written as the path it is.
  expect(within(rows[0]!).getByRole('button', { name: '/' })).not.toBeNull()
  expect(within(rows[1]!).getByRole('button', { name: '/services' })).not.toBeNull()

  // And it selects the root page rather than a folder path.
  fireEvent.click(within(rows[0]!).getByRole('button', { name: '/' }))
  await waitFor(() => expect(
    screen.getByRole('heading', { name: '/', level: 3 }),
  ).not.toBeNull())
})

/** A map with both kinds of link, and a page reachable only through the nav. */
function seedTemplateLinkGraph(overrides: Record<string, unknown> = {}) {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', summary('run_1', 42), {
    totalEdges: 2,
    totalTemplateEdges: 1,
    totalContentEdges: 1,
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
    edges: [contentEdge, templateEdge],
    ...overrides,
  })
  return queryClient
}

test('the map opens on page-text links only and says what it is hiding', () => {
  renderSection(seedTemplateLinkGraph())

  const toggle = screen.getByRole('checkbox', { name: 'Show menu and footer links' }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  expect(toggle.disabled).toBe(false)
  // One short line, the numbers only. Asserted against the exported builder so
  // the test cannot pass once the shipped string changes.
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe(siteMapLinkCountsLabel({
      filterUnavailable: false, showTemplateLinks: false,
      contentEdgeCount: 1, templateEdgeCount: 1, totalEdgeCount: 2,
    }))
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe('1 link in your page text. 1 menu and footer link hidden.')

  // The renderer holds EVERY edge and is told to hide the template ones.
  // Handing it a shorter list instead would rebuild the renderer on a
  // checkbox, which is what used to kill the map.
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('false')
})

test('omits link-filter explanations and controls when the map has no links', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 1),
    counts: {
      pagesDiscovered: 1,
      pagesFetched: 1,
      pagesEligible: 1,
      edges: 0,
      findings: 0,
    },
  }, {
    totalNodes: 1,
    totalEdges: 0,
    totalTemplateEdges: 0,
    totalContentEdges: 0,
    nodes: [{ ...homePage, x: 0, y: 0 }],
    edges: [],
  })

  renderSection(queryClient)

  expect(screen.getByRole('heading', { name: 'Site map' })).not.toBeNull()
  expect(screen.queryByTestId('site-map-link-counts')).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Show menu and footer links' })).toBeNull()
  expect(screen.queryByRole('button', {
    name: siteMapLinkRuleHelp('applied', { staleLayout: false }),
  })).toBeNull()
})

test('switching menu and footer links on draws them without moving a page', () => {
  renderSection(seedTemplateLinkGraph())

  const positionsBefore = screen.getByTestId('site-map-node-positions').textContent
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))

  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('true')
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe(siteMapLinkCountsLabel({
      filterUnavailable: false, showTemplateLinks: true,
      contentEdgeCount: 1, templateEdgeCount: 1, totalEdgeCount: 2,
    }))
  // The layout was published without template links, so drawing them is a
  // rendering change only: nothing re-runs and no page moves.
  expect(screen.getByTestId('site-map-node-positions').textContent).toBe(positionsBefore)
})

test('disables the toggle in plain words when a scan is too small to classify', () => {
  renderSection(seedTemplateLinkGraph({
    templateDetection: 'unavailable-too-few-pages',
    totalTemplateEdges: 0,
    totalContentEdges: 2,
  }))

  const toggle = screen.getByRole('checkbox', { name: 'Show menu and footer links' }) as HTMLInputElement
  expect(toggle.disabled).toBe(true)
  expect(screen.getByRole('button', {
    name: siteMapLinkRuleHelp('unavailable-too-few-pages', { staleLayout: false }),
  })).not.toBeNull()
  // It must not claim a split it could not make, so every link is drawn.
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe(siteMapLinkCountsLabel({
      filterUnavailable: true, showTemplateLinks: false,
      contentEdgeCount: 0, templateEdgeCount: 0, totalEdgeCount: 2,
    }))
  expect(screen.getByTestId('site-map-link-counts').textContent).toBe('All 2 links shown.')
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
})

test('disables the toggle and explains a scan that predates the split', () => {
  renderSection(seedTemplateLinkGraph({ templateDetection: 'unavailable-legacy-scan' }))

  expect((screen.getByRole('checkbox', { name: 'Show menu and footer links' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByRole('button', {
    name: siteMapLinkRuleHelp('unavailable-legacy-scan', { staleLayout: false }),
  })).not.toBeNull()
})

// Asserting the record's own value, not a substring of it, so the test cannot
// keep passing once the shipped copy says something different.
test.each([
  'applied',
  'applied-placement',
  'applied-placement-with-ubiquity',
  'applied-placement-partial',
] as const)('renders the shipped rule copy for %s, and keeps the control usable', (templateDetection) => {
  // These counts are the output of a rule, and the rule changes between scans.
  // A reader who cannot see which rule produced the split cannot tell a real
  // change on the site from a change in how it was measured.
  renderSection(seedTemplateLinkGraph({ templateDetection }))

  // The explanation moved into a keyboard-reachable tooltip whose accessible
  // name IS the shipped string. Nothing was dropped in the compression.
  const help = siteMapLinkRuleHelp(templateDetection, { staleLayout: false })
  expect(screen.getByRole('button', { name: help })).not.toBeNull()
  // It answers "so what" BEFORE "which rule": a reader wants to know why the
  // map hides most of their links, not which algorithm decided it.
  expect(help).toBe(`${SITE_MAP_LINK_SPLIT_COPY} ${TEMPLATE_DETECTION_COPY[templateDetection]}`)
  // The visible line is the numbers, in words a reader owns.
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe('1 link in your page text. 1 menu and footer link hidden.')
  // Every one of these states DID split the links, so the toggle works and the
  // counts are real.
  expect((screen.getByRole('checkbox', { name: 'Show menu and footer links' }) as HTMLInputElement).disabled).toBe(false)
})

test('the compressed headings keep their own accessible names', () => {
  // The tooltip is a SIBLING of each heading, never a child. Nesting it would
  // append the help text to the heading's accessible name and to any landmark
  // that points at it with aria-labelledby, which is a worse outcome than the
  // second line of prose it replaced.
  renderSection()

  expect(screen.getByRole('heading', { name: 'Site Health', level: 2 })).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'Site map', level: 2 })).not.toBeNull()
  // ...and each explanation is still reachable, on its own control.
  expect(screen.getByRole('button', { name: SITE_HEALTH_VIEW_DESCRIPTIONS.map })).not.toBeNull()
  expect(screen.getByRole('button', { name: SITE_MAP_HELP })).not.toBeNull()
})

test('the weaker rule names its own blind spot', () => {
  // An editorial link whose wording matches the menu is invisible to ubiquity,
  // and a reader comparing months has to know that.
  expect(TEMPLATE_DETECTION_COPY.applied).toContain('wording matches the menu')
})

test('does not claim unmeasured links are excluded, because they are counted as page-text links', () => {
  // This copy used to say those links were "left out of both counts". They
  // never were: they are content links everywhere, and the copy now says so.
  const copy = TEMPLATE_DETECTION_COPY['applied-placement-partial']
  expect(copy).toContain('counted as links in your page text')
  expect(copy).not.toContain('left out of both counts')
})

test('says when a map\'s page positions still include the nav mesh', () => {
  renderSection(seedTemplateLinkGraph({
    layout: {
      state: 'ready',
      version: 'site-health-fa2-v2',
      computedAt: '2026-08-08T18:16:33.000Z',
      templateLinksExcluded: false,
    },
  }))

  // The staleness warning joins the rule explanation in the same tooltip, so
  // the header strip stays one line and neither explanation is lost.
  expect(screen.getByRole('button', {
    name: siteMapLinkRuleHelp('applied', { staleLayout: true }),
  })).not.toBeNull()
  expect(siteMapLinkRuleHelp('applied', { staleLayout: true }))
    .toBe(`${SITE_MAP_LINK_SPLIT_COPY} ${TEMPLATE_DETECTION_COPY.applied} ${SITE_MAP_STALE_LAYOUT_COPY}`)
  expect(siteMapLinkRuleHelp('applied', { staleLayout: false }))
    .toBe(`${SITE_MAP_LINK_SPLIT_COPY} ${TEMPLATE_DETECTION_COPY.applied}`)
})

test('reads an empty page-text link set as a finding, with the real hidden counts', async () => {
  // canonry.ai: the homepage has 49 inbound / 30 outbound links but only 1
  // inbound / 5 outbound CONTENT links. With menu and footer hidden (the
  // default) a page whose only connections are chrome drew nothing and said
  // nothing, so a correct and interesting result looked like a broken map.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = seedTemplateLinkGraph()
  const templateEdge = (edgeKey: string, sourceNodeKey: string, targetNodeKey: string) => ({
    edgeKey,
    sourceNodeKey,
    sourceUrl: `https://citypoint.example/${sourceNodeKey}`,
    targetNodeKey,
    targetUrl: `https://citypoint.example/${targetNodeKey}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Home'],
    isTemplate: true,
    templateRatio: 0.9,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    // Only nav links point here, which is the whole finding.
    inbound: [templateEdge('t1', 'page_home', 'page_services'), templateEdge('t2', 'page_contact', 'page_services')],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  // Named counts, not an apology and not silence.
  expect(await screen.findByText('No links in the page text point here. 2 menu and footer links hidden.')).toBeTruthy()
  // Zero of ANY kind is a different fact and says so.
  expect(screen.getByText('This page links to nothing.')).toBeTruthy()

  // Switching nav links on shows them rather than the finding.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(screen.queryByText('No links in the page text point here. 2 menu and footer links hidden.')).toBeNull()
})

test('the link tiles count exactly what the tables list, in both toggle states', async () => {
  // Reported on canonry.ai: the tiles read "Links in 48 / Links out 26" while
  // the tables directly beneath read "(1)" and "(2)". Both were right, and
  // side by side with no labels the pair read as a broken table.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  // The crawl's own totals for this page must match the links seeded below,
  // the way a real crawl's do: 5 unique inbound edges, 2 outbound.
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 5, outboundUniqueEdges: 2 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })

  const link = (edgeKey: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: 'page_home',
    sourceUrl: 'https://citypoint.example/',
    targetNodeKey: 'page_services',
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  // One content link in among four nav links in; two content links out.
  const inbound = [link('in-content', false), ...Array.from({ length: 4 }, (_, i) => link(`in-nav-${i}`, true))]
  const outbound = [link('out-a', false), link('out-b', false)]
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    inbound,
    outbound,
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const tile = (label: string) => {
    const term = screen.getByText(label)
    return term.parentElement as HTMLElement
  }

  // Filter ON (the default): tile and table agree on the content-only count,
  // and the hidden amount is named rather than silently dropped.
  await waitFor(() => expect(within(tile('Links in')).getByText('1')).toBeTruthy())
  expect(within(tile('Links in')).getByText('4 menu and footer hidden')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (1)' })).toBeTruthy()
  // The hidden count is exactly the difference between the two states.
  expect(within(tile('Links out')).getByText('2')).toBeTruthy()
  expect(within(tile('Links out')).queryByText(/menu and footer hidden/)).toBeNull()
  expect(screen.getByRole('region', { name: 'Links out (2)' })).toBeTruthy()

  // Depth and importance are full-graph values, and the panel says so rather
  // than letting them look filtered.
  // The standalone footnote is gone: `siteHealthMetricHelp` already appends
  // that same sentence to both tiles it describes, so the page said it twice.
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linkImportance', false) })).toBeTruthy()

  // Filter OFF: both show totals and the secondary line disappears.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(within(tile('Links in')).getByText('5')).toBeTruthy()
  expect(within(tile('Links in')).queryByText(/menu and footer hidden/)).toBeNull()
  expect(screen.getByRole('region', { name: 'Links in (5)' })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
})

test('a link tile never presents a bounded count as a total', () => {
  // The neighbour read is capped, so a truncated list proves only a lower
  // bound. Rounding that into a flat number would be a quiet lie.
  expect(linkTileCount({ total: 48, visible: 1, hidden: 47, truncated: false, showTemplateLinks: false, known: true }))
    .toEqual({ value: '1', hiddenNote: '47 menu and footer hidden', filtered: true })

  expect(linkTileCount({ total: 500, visible: 100, hidden: 400, truncated: true, showTemplateLinks: false, known: true }))
    .toEqual({ value: '100+', hiddenNote: 'At least 400 menu and footer hidden', filtered: true })

  // Filter off: the crawl's own total, and no secondary line.
  expect(linkTileCount({ total: 48, visible: 1, hidden: 47, truncated: false, showTemplateLinks: true, known: true }))
    .toEqual({ value: '48', hiddenNote: null, filtered: false })

  // Nothing hidden is not a note worth showing.
  // Nothing hidden, but the filter IS in force: no note to show, yet the tile
  // is still a content-only count and the tooltip must say so.
  expect(linkTileCount({ total: 3, visible: 3, hidden: 0, truncated: false, showTemplateLinks: false, known: true }))
    .toEqual({ value: '3', hiddenNote: null, filtered: true })

  // Before the neighbour read lands there is no per-kind answer, so the tile
  // shows the total rather than flashing a zero.
  // A legacy scan cannot tell nav from content, so the tile is NOT filtered:
  // claiming "content links only" there would be a lie.
  expect(linkTileCount({ total: 48, visible: 0, hidden: 0, truncated: false, showTemplateLinks: false, known: false }))
    .toEqual({ value: '48', hiddenNote: null, filtered: false })
})

test('both count fixes hold at once: filtered tiles and no self-link anywhere', async () => {
  // The two bugs on this panel were independent and had to be true together:
  // the tiles must follow the toggle, and neither surface may count a page's
  // link to itself. This is a page with template inbound AND a self-link.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  // 2 real inbound (1 content, 1 nav) and 1 real outbound, as the crawl's own
  // page metrics count them: the self-link is in neither, at either layer.
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 2, outboundUniqueEdges: 1 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })
  const link = (edgeKey: string, from: string, to: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: from,
    sourceUrl: `https://citypoint.example/${from}`,
    targetNodeKey: to,
    targetUrl: `https://citypoint.example/${to}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: isTemplate ? [] : ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    // The API no longer returns the self-link in either direction: the writer
    // drops it and the migration cleared the stored ones.
    inbound: [link('in-content', 'page_home', 'page_services', false), link('in-nav', 'page_contact', 'page_services', true)],
    outbound: [link('out-content', 'page_services', 'page_home', false)],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement
  const selfLinkRows = () => screen.queryAllByText('/page_services')

  // Filter on: tiles match the tables, and no self-link is listed anywhere.
  await waitFor(() => expect(within(tile('Links in')).getByText('1')).toBeTruthy())
  expect(within(tile('Links in')).getByText('1 menu and footer hidden')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (1)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()
  expect(selfLinkRows()).toHaveLength(0)

  // Filter off: tiles show the crawl's totals, which also exclude the
  // self-link, and the tables agree with them.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(within(tile('Links in')).getByText('2')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (2)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()
  expect(selfLinkRows()).toHaveLength(0)
})

test('metric help text tells the truth about what the menu and footer filter changes', () => {
  // Depth and link score are computed by the crawl over the FULL link graph,
  // before nav links are told apart, so the filter cannot move them. Sitting
  // beside two filtered tiles, they have to say so or they read as filtered.
  expect(siteHealthMetricHelp('clicksFromHome', false)).toBe(
    'How many clicks it takes to reach this page from the home page, following links. This always counts every link, including menu and footer.',
  )
  expect(siteHealthMetricHelp('linkImportance', false)).toBe(
    'How much link value flows to this page, based on how many pages link to it and how important those pages are. Shown relative to the highest page on this site, which is 100%. This always counts every link, including menu and footer.',
  )
  // A full-graph metric ignores the argument entirely: there is no state in
  // which it is a filtered number, so no caller can make it claim otherwise.
  expect(siteHealthMetricHelp('clicksFromHome', true)).toBe(siteHealthMetricHelp('clicksFromHome', false))
  expect(siteHealthMetricHelp('linkImportance', true)).toBe(siteHealthMetricHelp('linkImportance', false))

  // The two counts that DO follow the toggle describe whichever number is on
  // screen right now.
  expect(siteHealthMetricHelp('linksIn', true)).toBe(
    'How many other pages link to this page. Right now this counts only links written in your page text. Menu and footer links are hidden.',
  )
  expect(siteHealthMetricHelp('linksIn', false)).toBe(
    'How many other pages link to this page. This counts every link, including menu and footer.',
  )
  expect(siteHealthMetricHelp('linksOut', true)).toBe(
    'How many other pages this page links to. Right now this counts only links written in your page text. Menu and footer links are hidden.',
  )
  expect(siteHealthMetricHelp('linksOut', false)).toBe(
    'How many other pages this page links to. This counts every link, including menu and footer.',
  )

  // Metrics with nothing to qualify are left alone rather than padded with a
  // sentence about a filter that does not apply to them.
  expect(siteHealthMetricHelp('technicalScore', true)).toBe(siteHealthMetricHelp('technicalScore', false))
  expect(siteHealthMetricHelp('linkTimes', true)).toBe(siteHealthMetricHelp('linkTimes', false))
})

test('the tile tooltips are keyboard reachable and follow the menu and footer toggle', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 2, outboundUniqueEdges: 1 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })
  const link = (edgeKey: string, from: string, to: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: from,
    sourceUrl: `https://citypoint.example/${from}`,
    targetNodeKey: to,
    targetUrl: `https://citypoint.example/${to}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: isTemplate ? [] : ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    inbound: [link('in-content', 'page_home', 'page_services', false), link('in-nav', 'page_contact', 'page_services', true)],
    outbound: [link('out-content', 'page_services', 'page_home', false)],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  // The explanation is the trigger's accessible name, so a screen reader gets
  // it without a hover ever happening.
  await waitFor(() => expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', true) })).toBeTruthy())
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksOut', true) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linkImportance', false) })).toBeTruthy()

  // Focus alone reveals the bubble, so the copy is not hover-only.
  const trigger = screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', true) })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  // Toggle off the filter and the two filterable tiles stop claiming to be
  // content-only, while the two full-graph tiles are untouched.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksOut', false) })).toBeTruthy()
  expect(screen.queryByRole('button', { name: siteHealthMetricHelp('linksIn', true) })).toBeNull()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linkImportance', false) })).toBeTruthy()
})
