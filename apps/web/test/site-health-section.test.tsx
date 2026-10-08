import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey,
  getApiV1ProjectsByNameTechnicalAeoGraphQueryKey,
  getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import {
  LivePageHealthFindings,
  SiteHealthSection,
  type LivePageHealthPreviewView,
} from '../src/components/project/SiteHealthSection.js'
import { compileAppStyles, parseCompiledCss, compiledElementProperty, cssLengthPx } from './compiled-app-css.js'
import { heyClient } from '../src/api.js'
import type { SiteCrawlPageDto, SiteCrawlSummaryDto } from '@ainyc/canonry-contracts'
import { AccountProvider } from '../src/contexts/account-context.js'

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
    afterSummary,
    unavailableFooter,
  }: {
    runId?: string | null
    integrated?: boolean
    compactCopy?: boolean
    afterSummary?: React.ReactNode
    unavailableFooter?: React.ReactNode
  }) => (
    <div data-integrated={integrated ? 'true' : 'false'} data-compact-copy={compactCopy ? 'true' : 'false'}>
      Page health for {runId ?? 'latest'}
      {technicalAeoMock.state === 'success' ? afterSummary : unavailableFooter}
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

function summary(runId: string, pagesDiscovered: number, complete = true): SiteCrawlSummaryDto {
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
  linkScoreNormalized: 100,
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
  linkScoreNormalized: 40,
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

function seedInitialRootPage(queryClient: QueryClient) {
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_home', limit: 1 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 1,
    nextCursor: null,
    healthStateFilter: null,
    pages: [homePage],
  })
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

/** The project as GET /projects/:name returns it; Site Health reads only its saved page budget. */
function storedProject(siteAuditMaxPages: number | null) {
  return {
    id: projectId, name: projectName, displayName: 'Citypoint', canonicalDomain: 'citypoint.example',
    ownedDomains: [], aliases: [], qualifiedAliases: [], country: 'US', language: 'en', tags: [], labels: {},
    providers: [], providerModels: {}, providerDispatchModes: {}, locations: [], defaultLocation: null,
    autoExtractBacklinks: false, siteAuditMaxPages, configSource: 'api' as const, configRevision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function projectKey() {
  return getApiV1ProjectsByNameQueryKey({ client: heyClient, path: { name: projectName } })
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // On the project page the project is already loaded; Scan settings reads that cache.
  queryClient.setQueryData(projectKey(), storedProject(null))
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
  role?: 'admin' | 'viewer',
) {
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: 'Test account', role } : null}>
        <SiteHealthSection projectName={projectName} projectId={projectId} {...props} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return queryClient
}


const MAP_VIEW_HELP = 'Explore how pages, site sections, and internal links fit together.'
const TECHNICAL_VIEW_HELP = 'Prioritize audit findings and inspect the pages that need work.'
const MAP_NAVIGATION_HELP = 'Scroll to zoom. Click a page to inspect it.'
const LINK_SPLIT_HELP = 'Menu, header, and footer links repeat on every page, so they say nothing about which pages relate to each other. Links written in your page text do.'
const STALE_LAYOUT_HELP = 'Page positions on this map were set before menu and footer links were separated. Run a new scan to update them.'
const TOO_FEW_HELP = 'This scan found fewer than 15 pages and did not read where each link sits in the page. On a site that small every link is on most pages, so menu and footer links cannot be told apart from the rest.'
const LEGACY_SPLIT_HELP = 'This scan ran before menu and footer links were separated. Run a new scan to split them out.'
const RULE_HELP = {
  applied: 'This scan told menu and footer links apart by how often the same link repeats across pages. It cannot spot a link written into the page text when its wording matches the menu. Run a new scan to read the page layout instead.',
  'applied-placement': 'This scan read where each link sits in the page, so links in the page text are separated from the menu, header, and footer even when they use the same wording.',
  'applied-placement-with-ubiquity': 'This scan read where each link sits in the page. Some pages mark out no menu or main area, so those links fall back to how often the link repeats across pages, which can miss a link written into the page text.',
  'applied-placement-partial': 'This scan read where each link sits in the page. Some pages mark out no menu or main area, and this scan found fewer than 15 pages, so nothing could tell those links apart. They are counted as links in your page text, which is what a link no rule marked as menu, header, or footer means here.',
} as const
const METRIC_HELP = {
  clicksFromHome: 'How many clicks it takes to reach this page from the home page, following links. This always counts every link, including menu and footer.',
  linkImportance: 'How much link value flows to this page, based on how many pages link to it and how important those pages are. Shown relative to the highest page on this site, which is 100%. This always counts every link, including menu and footer.',
  linksInFiltered: 'How many other pages link to this page. Right now this counts only links written in your page text. Menu and footer links are hidden.',
  linksInAll: 'How many other pages link to this page. This counts every link, including menu and footer.',
  linksOutFiltered: 'How many other pages this page links to. Right now this counts only links written in your page text. Menu and footer links are hidden.',
  linksOutAll: 'How many other pages this page links to. This counts every link, including menu and footer.',
  technicalScore: 'How well this page is set up for AI and search engines to read, from 0 to 100. Open a page to see what it is marked down for.',
  linkTimes: 'How many times this link appears on the page it comes from.',
} as const
async function renderedCss(...elements: Element[]) {
  return parseCompiledCss(await compileAppStyles([...new Set(elements.flatMap(element => [...element.classList]))]))
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function deferredResponse() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
type SiteRead = { method: string; path: string; query: Record<string, string> }
function installSiteReads(receipts: Record<string, unknown>) {
  const reads: SiteRead[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    reads.push({ method: input instanceof Request ? input.method : init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams) })
    const key = Object.keys(receipts).sort((left, right) => right.length - left.length).find(path => url.pathname.endsWith(path))
    if (!key) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'No fixture for this read' } }, 404)
    const body = await receipts[key]
    return body instanceof Response ? body : jsonResponse(body)
  }))
  return reads
}
function seedInventoryRows(queryClient: QueryClient, runId: string, pages: SiteCrawlPageDto[]) {
  const input = { client: heyClient, path: { name: projectName }, query: { runId, limit: 200, sort: 'path' } } as const
  const response = { project: projectName, hasCrawlData: true, runId, total: pages.length, nextCursor: null, pages }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(input), response)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(input), { pages: [response], pageParams: [input] })
}
function compactPage(page: SiteCrawlPageDto) {
  return { nodeKey: page.nodeKey, url: page.url, path: page.path, depth: page.depth, indexabilityState: page.indexabilityState, fetchState: page.fetchState, auditState: page.auditState, auditScore: page.auditScore, inventoryEligible: page.inventoryEligible, inboundUniqueEdges: page.inboundUniqueEdges, outboundUniqueEdges: page.outboundUniqueEdges, linkScoreNormalized: page.linkScoreNormalized, healthState: page.healthState }
}
function storedNeighbor(edgeKey: string, isTemplate: boolean) {
  return { edgeKey, sourceNodeKey: `source-${edgeKey}`, sourceUrl: `https://citypoint.example/${edgeKey}`, targetNodeKey: 'page_services', targetUrl: servicesPage.url, relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchors: ['Roof repair'], isTemplate, templateRatio: isTemplate ? 0.9 : 0.1, templateSource: 'ubiquity', placementOccurrences: null }
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

test('managed scans hide the plain recovery button on a cold failed-run handoff for a viewer', () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_failed', 'failed', false), scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient, path: { name: projectName, runId: 'run_failed' },
  }), {
    project: projectName, runId: 'run_failed', status: 'failed', phase: 'failed',
    attempt: null, layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: 'The crawl could not reach the sitemap.',
  })
  renderSection(queryClient, { initialRunId: 'run_failed' }, 'viewer')
  const recovery = screen.getByRole('alert', { name: 'Site scan recovery' })
  expect(recovery.textContent).toContain('The crawl could not reach the sitemap.')
  expect(within(recovery).queryByRole('button', { name: 'Run scan again' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Run scan/ })).toBeNull()
  expect(screen.queryByText('Scan settings')).toBeNull()
  expect(mutationMock.mutate).not.toHaveBeenCalled()
})

test('public demo hides Page Health scan controls and skips the unavailable schedule read', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1')))
  renderSection(queryClient, {}, 'viewer')

  expect(screen.queryByRole('button', { name: /Run scan/ })).toBeNull()
  expect(screen.queryByText('Scan settings')).toBeNull()
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Scans are run by your Canonry team'))
  expect(request.mock.calls.some(([request]) => new URL((request as Request).url).pathname.endsWith('/schedule'))).toBe(false)
})

test('keeps three fixed live-finding slots while examples grow from zero to one to three', async () => {
  const { rerender } = render(
    <LivePageHealthFindings runId="run_live" preview={livePreview(0)} />,
  )

  const section = screen.getByRole('region', { name: 'Findings so far' })
  const firstSlots = within(section).getAllByTestId('live-page-health-slot')
  expect(firstSlots).toHaveLength(3)
  const slotCss = await renderedCss(...firstSlots)
  for (const slot of firstSlots) expect(cssLengthPx(compiledElementProperty(slotCss, slot, 'height') ?? '', slotCss)).toBe(56)
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
  expect(compiledElementProperty(slotCss, firstFilledSlot, 'display')).toBe('grid')
  expect(compiledElementProperty(slotCss, firstFilledSlot, 'grid-template-columns')?.replace(/,\s*/g, ',')).toBe('minmax(0,1fr) auto')
  expect(cssLengthPx(compiledElementProperty(slotCss, firstFilledSlot, 'gap') ?? '', slotCss)).toBe(8)
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
  const urlCss = await renderedCss(...finalUrls.filter((url): url is HTMLElement => url !== null))
  for (const url of finalUrls) {
    expect(url).not.toBeNull()
    expect(compiledElementProperty(urlCss, url!, 'overflow')).toBe('hidden')
    expect(compiledElementProperty(urlCss, url!, 'text-overflow')).toBe('ellipsis')
    expect(compiledElementProperty(urlCss, url!, 'white-space')).toBe('nowrap')
  }
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
  const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }))
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

test('shows link importance on the 0 to 100 scale every crawl writes', () => {
  // A site audit scores each page 0 to 100 against the crawl's top page. Any
  // value at or below 1 used to read as a 0 to 1 fraction, so a real page
  // scoring 0.85 out of 100 showed as 85.0%.
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', summary('run_1', 42), {
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, linkScoreNormalized: 0.85, x: 1, y: 1 },
    ],
  })
  const scoredPage = (nodeKey: string, path: string, linkScoreNormalized: number | null) => ({
    ...servicesPage,
    nodeKey,
    path,
    url: `https://citypoint.example${path}`,
    finalUrl: `https://citypoint.example${path}`,
    linkScoreNormalized,
  })
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' },
  } as const
  const pagesResponse = {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 5,
    nextCursor: null,
    pages: [
      scoredPage('page_top', '/top', 100),
      scoredPage('page_high', '/high', 85),
      scoredPage('page_low', '/low', 0.85),
      scoredPage('page_one', '/one', 1),
      scoredPage('page_unscored', '/unscored', null),
    ],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(pagesInput), pagesResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [pagesResponse],
    pageParams: [pagesInput],
  })

  renderSection(queryClient)

  // The selected page's tile.
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  const tile = screen.getByText('Link importance').parentElement as HTMLElement
  expect(within(tile).getByText('0.9%')).toBeTruthy()

  // The Pages table column.
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  const header = screen.getAllByRole('columnheader')
    .find((cell) => cell.textContent?.startsWith('Link importance')) as HTMLElement
  const table = header.closest('table') as HTMLElement
  const column = within(table).getAllByRole('columnheader').indexOf(header)
  const importance = (path: string) => {
    const row = within(table).getByRole('button', { name: path }).closest('tr') as HTMLElement
    return within(row).getAllByRole('cell')[column]?.textContent
  }
  expect(importance('/top')).toBe('100%')
  expect(importance('/high')).toBe('85.0%')
  expect(importance('/low')).toBe('0.9%')
  expect(importance('/one')).toBe('1.0%')
  expect(importance('/unscored')).toBe('Not scored')
})

test('connects a selected graph page score to its exact audit finding in the same run', () => {
  const queryClient = renderSection()

  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  expect(screen.getByRole('heading', { name: 'Findings and fixes for this page' })).not.toBeNull()
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
  expect(map.id).not.toBe('')
  expect(document.getElementById(map.getAttribute('aria-controls') ?? '')).toBe(screen.getByRole('tabpanel'))
  expect(map.getAttribute('tabindex')).toBe('0')
  expect(inventory.getAttribute('tabindex')).toBe('-1')
  expect(document.getElementById(screen.getByRole('tabpanel').getAttribute('aria-labelledby') ?? '')).toBe(map)

  map.focus()
  fireEvent.keyDown(map, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(inventory)
  expect(inventory.getAttribute('aria-selected')).toBe('true')
  expect(document.getElementById(screen.getByRole('tabpanel').getAttribute('aria-labelledby') ?? '')).toBe(inventory)

  fireEvent.keyDown(inventory, { key: 'End' })
  expect(document.activeElement).toBe(technical)
  expect(technical.getAttribute('aria-selected')).toBe('true')

  fireEvent.keyDown(technical, { key: 'Home' })
  expect(document.activeElement).toBe(map)
  expect(map.getAttribute('aria-selected')).toBe('true')
})

test('keeps every detail read pinned to the selected historical run', async () => {
  const queryClient = makeClient()
  seedInitialRootPage(queryClient)
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1'), scan('run_old', 'partial')))
  const oldSummary = { ...summary('run_old', 18, false), effectiveOptions: { checkDeadLinks: true }, deadLinks: { state: 'partial' as const, checked: 14, found: 2, unverified: 1 } }
  seedRun(queryClient, 'run_old', summary('run_old', 18, false))
  // Existing producers supply server fixtures, not expected request identities.
  const receipts = {
    '/crawl': oldSummary,
    '/graph': queryClient.getQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_old', maxNodes: 20_000, maxEdges: 50_000 } })),
    '/crawl/pages': queryClient.getQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_old', limit: 200, sort: 'path' } })),
    '/structure': queryClient.getQueryData(getApiV1ProjectsByNameTechnicalAeoStructureQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_old', parentPath: '/', limit: 100 } })),
    '/internal-links/neighbors': queryClient.getQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_old', nodeKey: 'page_services', limit: 100 } })),
    '/crawl/pages/audit': queryClient.getQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_old', nodeKey: 'page_services' } })),
    '/dead-links': { project: projectName, runId: 'run_old', state: 'partial', checkDeadLinks: true, checked: 14, found: 2, unverified: 1, total: 2, nextCursor: null, deadLinks: [] },
  }
  for (const receipt of Object.values(receipts)) expect(receipt).toBeDefined()
  // No old detail cache remains: a selected historical read must cross the SDK.
  queryClient.removeQueries({ predicate: query => JSON.stringify(query.queryKey).includes('run_old') })
  const reads = installSiteReads(receipts)
  renderSection(queryClient)
  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), { target: { value: 'run_old' } })
  await screen.findByText('Partial scan')
  expect(await screen.findByText('18')).not.toBeNull()
  await screen.findByText('Broken links: 2 found so far, 1 unchecked')
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(await screen.findByRole('button', { name: '/services/roof-repair' }))
  await screen.findByText('The page is too thin.')
  await screen.findByRole('region', { name: 'Links in (0)' })
  expect(screen.getAllByText('Clicks from home')).not.toHaveLength(0)
  expect(screen.getAllByText('Link importance')).not.toHaveLength(0)
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText('Page health for run_old').getAttribute('data-integrated')).toBe('true')
  expect(reads).toEqual(expect.arrayContaining([
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/crawl', query: { runId: 'run_old' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/graph', query: { runId: 'run_old', maxNodes: '20000', maxEdges: '50000' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/crawl/pages', query: { runId: 'run_old', limit: '200', sort: 'path' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/structure', query: { runId: 'run_old', parentPath: '/', limit: '100' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/internal-links/neighbors', query: { runId: 'run_old', nodeKey: 'page_services', limit: '100' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/crawl/pages/audit', query: { runId: 'run_old', nodeKey: 'page_services' } },
    { method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/dead-links', query: { runId: 'run_old', limit: '50' } },
  ]))
  expect(reads.every(read => read.query.runId === 'run_old')).toBe(true)
})

test('uses the API preferred scan by default and preserves an explicitly selected same-day partial scan', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), { ...scanHistory(scan('run_partial', 'partial'), scan('run_1')), preferredRunId: 'run_1' })
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))
  renderSection(queryClient)
  expect(screen.getByText('42')).not.toBeNull()
  expect(screen.queryByText('Partial scan')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText('Page health for run_1')).not.toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), { target: { value: 'run_partial' } })
  expect(await screen.findByText('Page health for run_partial')).not.toBeNull()
  expect(screen.getByText('Partial scan')).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Map' }))
  expect(screen.getByText('18')).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText('Page health for run_partial')).not.toBeNull()
})

test('falls back to the newest terminal run when scan history omits preferred selection', () => {
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
  expect(screen.getByRole('list', { name: 'Onboarding progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Scan site')
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

test('states the bounded first-run budget during onboarding and not on a regular scan', () => {
  for (const surface of ['onboarding', 'regular'] as const) {
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

    renderSection(queryClient, surface === 'onboarding' ? { showOnboardingActions: true } : {})

    const scanProgress = screen.getByRole('region', { name: 'Current scan progress' })
    if (surface === 'onboarding') {
      expect(scanProgress.textContent).toContain('A quick scan to find your first fixes.')
      // A pinned run may have come from the CLI with any budget, so the
      // banner must not claim this section's 100-page first look.
      expect(scanProgress.innerHTML).not.toContain('reads up to 100 pages')
    } else {
      expect(scanProgress.textContent).not.toContain('A quick scan to find your first fixes.')
    }

    cleanup()
    queryClient.clear()
  }
})

test('sends the chosen crawl budget so a scan that stopped early can be changed', () => {
  // The only way to change either budget used to be the CLI, which the
  // dashboard never mentions, so "this scan ran out of time" was a dead end.
  const queryClient = makeClient()
  renderSection(queryClient)

  fireEvent.change(screen.getByLabelText('Page budget'), { target: { value: '500' } })
  fireEvent.change(screen.getByLabelText('Crawl depth'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: /Run scan/ }))

  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false, maxPages: 500, maxDepth: 2 },
  })
})



test.each([
  { saved: null, label: 'Project default: full site (up to 50,000 pages)' },
  { saved: 2_500, label: 'Project default (2,500 pages)' },
  { saved: 750, label: 'Project default (750 pages)' },
])('the no-budget choice names the saved budget ($saved) and still sends no budget', ({ saved, label }) => {
  const queryClient = makeClient()
  queryClient.setQueryData(projectKey(), storedProject(saved))
  renderSection(queryClient)

  const budget = screen.getByRole('combobox', { name: 'Page budget' }) as HTMLSelectElement
  const options = within(budget).getAllByRole('option') as HTMLOptionElement[]
  expect(options.map(option => [option.value, option.textContent])).toEqual([
    ['', label],
    // A smaller saved budget adds a one-off full-site choice; with none, the default already is the full site.
    ...(saved === null ? [] : [['50000', 'Full site (up to 50,000 pages)']]),
    ['100', '100 pages (quick look)'],
    ['500', '500 pages'],
    ['2500', '2,500 pages'],
    ['10000', '10,000 pages'],
  ])
  expect(budget.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))
  // The server resolves the saved budget; the dashboard never fills one in.
  expect(mutationMock.mutate).toHaveBeenCalledExactlyOnceWith({ projectName, projectId, body: { checkDeadLinks: false } })
})

test('the no-budget choice follows the cached project after a Settings save', async () => {
  const queryClient = makeClient()
  renderSection(queryClient)
  const budget = screen.getByRole('combobox', { name: 'Page budget' })
  expect(within(budget).getByRole('option', { name: 'Project default: full site (up to 50,000 pages)' }).getAttribute('value')).toBe('')

  // Project Settings writes the saved project into this same cache entry.
  act(() => { queryClient.setQueryData(projectKey(), storedProject(10_000)) })

  expect((await within(budget).findByRole('option', { name: 'Project default (10,000 pages)' })).getAttribute('value')).toBe('')
  expect(within(budget).queryByRole('option', { name: 'Project default: full site (up to 50,000 pages)' })).toBeNull()
})

test('offers a one-off full-site scan only when the project saved a smaller budget, and sends the hard limit', async () => {
  const queryClient = makeClient()
  renderSection(queryClient)
  const budget = screen.getByRole('combobox', { name: 'Page budget' })
  // No saved budget: the project default already is the full site, so there is no second full-site choice.
  expect(within(budget).queryByRole('option', { name: 'Full site (up to 50,000 pages)' })).toBeNull()

  act(() => { queryClient.setQueryData(projectKey(), storedProject(10_000)) })
  const fullSite = await within(budget).findByRole('option', { name: 'Full site (up to 50,000 pages)' })
  expect(fullSite.getAttribute('value')).toBe('50000')
  expect(within(budget).getAllByRole('option').map(option => option.textContent)).toEqual([
    'Project default (10,000 pages)', 'Full site (up to 50,000 pages)', '100 pages (quick look)', '500 pages', '2,500 pages', '10,000 pages',
  ])
  fireEvent.change(budget, { target: { value: '50000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))
  expect(mutationMock.mutate).toHaveBeenCalledExactlyOnceWith({ projectName, projectId, body: { checkDeadLinks: false, maxPages: 50_000 } })
})

test('names no number for the no-budget choice before the project read lands', async () => {
  const queryClient = makeClient()
  queryClient.removeQueries({ queryKey: projectKey(), exact: true })
  const project = deferredResponse()
  const reads = installSiteReads({ '/projects/citypoint': project.promise })
  renderSection(queryClient)

  const budget = screen.getByRole('combobox', { name: 'Page budget' })
  expect((within(budget).getAllByRole('option')[0] as HTMLOptionElement).textContent).toBe('Project default')
  await waitFor(() => expect(reads.filter(read => read.path === '/api/v1/projects/citypoint')).toHaveLength(1))
  await act(async () => { project.resolve(jsonResponse(storedProject(500))) })
  await waitFor(() => expect((within(budget).getAllByRole('option')[0] as HTMLOptionElement).textContent).toBe('Project default (500 pages)'))
})

test.each([
  { surface: 'onboarding', props: { showOnboardingActions: true }, role: undefined },
  { surface: 'managed viewer', props: {}, role: 'viewer' as const },
])('reads no project for a hidden Scan settings ($surface)', async ({ surface, props, role }) => {
  if (surface === 'managed viewer') window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  queryClient.removeQueries({ queryKey: projectKey(), exact: true })
  const reads = installSiteReads({})
  renderSection(queryClient, props, role)
  await act(async () => {})

  expect(screen.queryByRole('combobox', { name: 'Page budget' })).toBeNull()
  expect(reads.filter(read => read.path === '/api/v1/projects/citypoint')).toEqual([])
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
  const selectedTab = screen.getByRole('tab', { name: 'Map' })
  const panel = document.getElementById(selectedTab.getAttribute('aria-controls') ?? '')
  expect(panel).toBe(progress.closest('[role="tabpanel"]'))
  expect(document.getElementById(panel?.getAttribute('aria-labelledby') ?? '')).toBe(selectedTab)
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
  screen.getByRole('status', { name: 'Current scan progress' })

  await waitFor(() => expect(onReleaseInitialRun).toHaveBeenCalledOnce())
  // The callback fires inside the effect that clears the selection, before
  // React re-renders without the progress status, so wait for that render.
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Current scan progress' })).toBeNull())
  await screen.findByRole('img', { name: 'Interactive site map' })
  expect(onReleaseInitialRun).toHaveBeenCalledOnce()
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

test('reserves live counters and Page Health finding space before the scan attempt has persisted', async () => {
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
  const phaseCss = await renderedCss(phase)
  expect(cssLengthPx(compiledElementProperty(phaseCss, phase, 'min-height') ?? '', phaseCss)).toBe(72)
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
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, { initialRunId: 'run_active' })

  await screen.findByRole('status', { name: 'Current scan progress' })
  await act(async () => {})
  expect(fetchMock.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname)
    .filter(path => path.endsWith('/page-health-preview'))).toHaveLength(0)
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
  expect(screen.getByRole('list', { name: 'Onboarding progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Scan site')
  fireEvent.click(within(recovery).getByRole('button', { name: 'Run scan again' }))
  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: true, maxPages: 100 },
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
  const stoppedBanner = screen.getByRole('status')
  expect(stoppedBanner.textContent).toContain('This scan stopped at the page limit, so some pages were not checked.')
  // Naming the limit without naming the remedy leaves nothing to act on.
  // Onboarding hides Scan settings (its first-look budget is fixed), so the
  // remedy points at where the setting lives after setup.
  expect(stoppedBanner.textContent).toContain("Raise the page budget in Site Health's Scan settings after setup.")
  expect(screen.queryByText('Scan settings', { selector: 'summary' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Page budget' })).toBeNull()
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
    body: { checkDeadLinks: true, maxPages: 100 },
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
    body: { checkDeadLinks: true, maxPages: 100 },
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

test('expands site sections lazily while preserving the selected run', async () => {
  const queryClient = makeClient()
  const reads = installSiteReads({ '/structure': {
    project: projectName, hasCrawlData: true, runId: 'run_1', parentPath: '/services', nextCursor: null,
    children: [{ path: '/services/roof-repair', url: servicesPage.url, hasPage: true, pageCount: 1, inventoryEligibleCount: 1, fetchedCount: 1 }],
  } })
  renderSection(queryClient)
  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  await act(async () => {})
  expect(reads.filter(read => read.path.endsWith('/structure') && read.query.parentPath === '/services')).toHaveLength(0)
  fireEvent.click(within(sections).getByRole('button', { name: 'Expand /services' }))
  await within(sections).findByRole('button', { name: '/services/roof-repair' })
  expect(reads.filter(read => read.path.endsWith('/structure'))).toEqual([{ method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/structure', query: { runId: 'run_1', parentPath: '/services', limit: '100' } }])
  fireEvent.click(within(sections).getByRole('button', { name: 'Collapse /services' }))
  expect(within(sections).queryByRole('button', { name: '/services/roof-repair' })).toBeNull()
})

test('keeps Site sections first in visual and keyboard order', async () => {
  const queryClient = makeClient()

  renderSection(queryClient)

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  const explorer = sections.parentElement
  expect(explorer).not.toBeNull()
  const mapColumn = explorer!.lastElementChild
  expect(mapColumn).not.toBeNull()
  const gridCss = await renderedCss(explorer!, mapColumn!)
  expect(compiledElementProperty(gridCss, explorer!, 'display')).toBe('grid')
  expect(compiledElementProperty(gridCss, explorer!, 'grid-template-columns')).toBeUndefined()
  expect(compiledElementProperty(gridCss, explorer!, 'grid-template-columns', '@media (width >= 64rem)')?.replace(/,\s*/g, ',')).toBe('minmax(14rem,18rem) minmax(0,1fr)')
  expect(explorer?.firstElementChild).toBe(sections)
  expect(cssLengthPx(compiledElementProperty(gridCss, mapColumn!, 'min-width') ?? '', gridCss)).toBe(0)
  expect(sections.compareDocumentPosition(screen.getByRole('img', { name: 'Interactive site map' })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
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

test('lets long selected paths and URLs wrap in the page inspector', async () => {
  const queryClient = makeClient()
  const longPath = `/services/${'roof-repair-'.repeat(32)}details`
  const longUrl = `https://citypoint.example${longPath}`
  const longPage = { ...servicesPage, path: longPath, url: longUrl, finalUrl: longUrl }
  seedRun(queryClient, 'run_1', summary('run_1', 42), { nodes: [{ ...homePage, x: 0, y: 0 }, { ...longPage, x: 1, y: 1 }] })
  seedInventoryRows(queryClient, 'run_1', [homePage, longPage])
  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: longPath }))
  const path = screen.getByRole('heading', { name: longPath, level: 3 })
  const url = screen.getByText(longUrl)
  expect(screen.getByRole('link', { name: 'Open page' }).getAttribute('href')).toBe(longUrl)
  const css = await renderedCss(path, url)
  expect(compiledElementProperty(css, path, 'overflow-wrap')).toBe('break-word')
  expect(compiledElementProperty(css, path, 'text-overflow')).toBeUndefined()
  expect(compiledElementProperty(css, path, 'white-space')).toBeUndefined()
  expect(compiledElementProperty(css, url, 'word-break')).toBe('break-all')
  expect(compiledElementProperty(css, url, 'text-overflow')).toBeUndefined()
  expect(compiledElementProperty(css, url, 'white-space')).toBeUndefined()
})

test('contains selected-page link tables inside mobile-safe grid items', async () => {
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
  const wrappers = [within(linksIn).getByRole('table').parentElement!, within(linksOut).getByRole('table').parentElement!]
  const css = await renderedCss(linksIn, linksOut, ...wrappers)
  for (const region of [linksIn, linksOut]) expect(cssLengthPx(compiledElementProperty(css, region, 'min-width') ?? '', css)).toBe(0)
  for (const wrapper of wrappers) expect(compiledElementProperty(css, wrapper, 'overflow-x')).toBe('auto')
  expect(within(linksIn).getByText('Roof repair')).not.toBeNull()
  expect(within(linksOut).getByText('Roof repair')).not.toBeNull()
})



test('removes map-specific chrome from the Page health view', () => {
  renderSection()

  // The view description is a tooltip on the heading now, so it is reachable
  // by its accessible name rather than rendered as a second line of prose.
  expect(screen.getByRole('button', { name: MAP_VIEW_HELP })).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))

  expect(screen.getByRole('button', { name: TECHNICAL_VIEW_HELP })).not.toBeNull()
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

  fireEvent.click(screen.getByRole('button', { name: 'View page health' }))
  expect(screen.getByText('Page health for run_legacy').getAttribute('data-integrated')).toBe('true')

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
  const queryClient = makeClient()
  seedInitialRootPage(queryClient)
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
    nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }, { ...compactPage(offWindowPage), x: 2, y: 2 }],
    edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
  })
  const reads = installSiteReads({ '/crawl/pages': {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null,
    healthStateFilter: null, pages: [offWindowPage],
  } })
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
  expect(reads.filter(read => read.path.endsWith('/crawl/pages'))).toEqual([{ method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/crawl/pages', query: { runId: 'run_1', nodeKey: 'page_far', limit: '1' } }])
  expect(within(screen.getByRole('list', { name: 'Why this page is hidden' })).queryByText('Hidden by meta robots tag')).toBeNull()
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
  for (const filterState of ['applied', 'unavailable-legacy-scan'] as const) {
    const queryClient = makeClient()
    seedInitialRootPage(queryClient)
    const hiddenPage = { ...contactPage, nodeKey: 'page_hidden_far', url: 'https://citypoint.example/thanks', path: '/thanks', indexabilityState: 'noindex', indexabilityReasons: ['meta-robots-noindex'], healthState: 'hidden' as const }
    const hiddenInput = { client: heyClient, path: { name: projectName }, query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' } } as const
    const hiddenResponse = { project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null, healthStateFilter: 'applied', pages: [hiddenPage] }
    queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(hiddenInput), { pages: [hiddenResponse], pageParams: [hiddenInput] })
    const deferred = deferredResponse()
    const reads = installSiteReads({ '/crawl/pages': deferred.promise })
    const answer = jsonResponse({ project: projectName, hasCrawlData: true, runId: 'run_1', total: 0, nextCursor: null, healthStateFilter: filterState, pages: [] })
    try {
      renderSection(queryClient)
      fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
      fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hidden pages' }))
      await screen.findByRole('button', { name: '/thanks' })
      await waitFor(() => expect(reads.filter(read => read.path.endsWith('/crawl/pages'))).toHaveLength(1))
      expect(screen.getByRole('heading', { name: '/services/roof-repair', level: 3 })).not.toBeNull()
      expect(screen.getByText('Loading page details...')).not.toBeNull()
      expect(reads).toEqual([{ method: 'GET', path: '/api/v1/projects/citypoint/technical-aeo/crawl/pages', query: { runId: 'run_1', healthState: 'hidden', nodeKey: 'page_services', limit: '1' } }])
      await act(async () => { deferred.resolve(answer) })
      if (filterState === 'applied') {
        await screen.findByText('Select a page to inspect its internal links and crawl signals.')
        expect(screen.queryByRole('heading', { name: '/services/roof-repair', level: 3 })).toBeNull()
      } else {
        await waitFor(() => expect(screen.queryByText('Loading page details...')).toBeNull())
        expect(screen.getByRole('heading', { name: '/services/roof-repair', level: 3 })).not.toBeNull()
      }
    } finally {
      deferred.resolve(answer)
      await act(async () => { await deferred.promise })
      cleanup()
      queryClient.clear()
    }
  }
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
    name: `${LINK_SPLIT_HELP} ${RULE_HELP.applied}`,
  })).toBeNull()
})

test('switching menu and footer links on draws them without moving a page', () => {
  renderSection(seedTemplateLinkGraph())

  const positionsBefore = screen.getByTestId('site-map-node-positions').textContent
  const edgeIdentityBefore = screen.getByTestId('site-map-edges-identity').textContent
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))

  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('true')
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toBe('1 link in your page text, 1 menu and footer.')
  // The layout was published without template links, so drawing them is a
  // rendering change only: nothing re-runs and no page moves.
  expect(screen.getByTestId('site-map-node-positions').textContent).toBe(positionsBefore)
  expect(screen.getByTestId('site-map-edges-identity').textContent).toBe(edgeIdentityBefore)
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
    name: `${LINK_SPLIT_HELP} ${TOO_FEW_HELP}`,
  })).not.toBeNull()
  // It must not claim a split it could not make, so every link is drawn.
  expect(screen.getByTestId('site-map-link-counts').textContent).toBe('All 2 links shown.')
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
})

test('disables the toggle and explains a scan that predates the split', () => {
  renderSection(seedTemplateLinkGraph({ templateDetection: 'unavailable-legacy-scan' }))

  expect((screen.getByRole('checkbox', { name: 'Show menu and footer links' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByRole('button', {
    name: `${LINK_SPLIT_HELP} ${LEGACY_SPLIT_HELP}`,
  })).not.toBeNull()
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('true')
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
  const help = `${LINK_SPLIT_HELP} ${RULE_HELP[templateDetection]}`
  expect(screen.getByRole('button', { name: help })).not.toBeNull()
  // It answers "so what" BEFORE "which rule": a reader wants to know why the
  // map hides most of their links, not which algorithm decided it.
  const trigger = screen.getByRole('button', { name: help })
  fireEvent.focus(trigger)
  expect(screen.getByText(help).getAttribute('aria-hidden')).toBe('true')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByText(help)).toBeNull()
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
  expect(screen.getByRole('button', { name: MAP_VIEW_HELP })).not.toBeNull()
  expect(screen.getByRole('button', { name: MAP_NAVIGATION_HELP })).not.toBeNull()
})





test('says when a map\'s page positions still include the nav mesh', () => {
  for (const staleLayout of [true, false]) {
    const queryClient = seedTemplateLinkGraph({ layout: {
      state: 'ready', version: 'site-health-fa2-v2', computedAt: '2026-08-08T18:16:33.000Z', templateLinksExcluded: !staleLayout,
    } })
    renderSection(queryClient)
    const help = `${LINK_SPLIT_HELP} ${RULE_HELP.applied}${staleLayout ? ` ${STALE_LAYOUT_HELP}` : ''}`
    expect(screen.getByRole('button', { name: help })).not.toBeNull()
    if (!staleLayout) expect(screen.queryByRole('button', { name: `${LINK_SPLIT_HELP} ${RULE_HELP.applied} ${STALE_LAYOUT_HELP}` })).toBeNull()
    cleanup()
    queryClient.clear()
  }
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
  expect(screen.getByRole('button', { name: METRIC_HELP.clicksFromHome })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.linkImportance })).toBeTruthy()

  // Filter OFF: both show totals and the secondary line disappears.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(within(tile('Links in')).getByText('5')).toBeTruthy()
  expect(within(tile('Links in')).queryByText(/menu and footer hidden/)).toBeNull()
  expect(screen.getByRole('region', { name: 'Links in (5)' })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.clicksFromHome })).toBeTruthy()
})

test('a link tile never presents a bounded count as a total', async () => {
  const cases = [
    { state: 'complete', total: 48, visible: 1, hidden: 47, truncated: false, showAll: false, value: '1', note: '47 menu and footer hidden', help: 'How many other pages link to this page. Right now this counts only links written in your page text. Menu and footer links are hidden.' },
    { state: 'complete', total: 500, visible: 60, hidden: 40, truncated: true, showAll: false, value: '60+', note: 'At least 40 menu and footer hidden', help: 'How many other pages link to this page. Right now this counts only links written in your page text. Menu and footer links are hidden.' },
    { state: 'complete', total: 48, visible: 1, hidden: 47, truncated: false, showAll: true, value: '48', note: null, help: 'How many other pages link to this page. This counts every link, including menu and footer.' },
    { state: 'complete', total: 3, visible: 3, hidden: 0, truncated: false, showAll: false, value: '3', note: null, help: 'How many other pages link to this page. Right now this counts only links written in your page text. Menu and footer links are hidden.' },
    { state: 'pending', total: 48, visible: 1, hidden: 47, truncated: false, showAll: false, value: '48', note: null, help: 'How many other pages link to this page. This counts every link, including menu and footer.' },
    { state: 'error', total: 48, visible: 1, hidden: 47, truncated: false, showAll: false, value: '48', note: null, help: 'How many other pages link to this page. This counts every link, including menu and footer.' },
  ] as const
  for (const row of cases) {
    const queryClient = seedTemplateLinkGraph({ nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, inboundUniqueEdges: row.total, x: 1, y: 1 }, { ...contactPage, x: -1, y: 1 }] })
    const deferred = deferredResponse()
    const edges = Array.from({ length: row.visible + row.hidden }, (_, index) => storedNeighbor(`edge-${index}`, index >= row.visible))
    const response = { project: projectName, hasCrawlData: true, runId: 'run_1', nodeKey: 'page_services', url: servicesPage.url, templateDetection: 'applied', linkKind: 'all', inbound: edges, outbound: [], inboundTruncated: row.truncated, outboundTruncated: false }
    const key = getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({ client: heyClient, path: { name: projectName }, query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 } })
    if (row.state === 'complete') queryClient.setQueryData(key, response)
    else { queryClient.removeQueries({ queryKey: key }); installSiteReads({ '/internal-links/neighbors': row.state === 'pending' ? deferred.promise : jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Neighbor evidence unavailable' } }, 503) }) }
    try {
      renderSection(queryClient)
      fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
      if (row.showAll) fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
      if (row.state === 'pending') await screen.findByText('Loading page links...')
      if (row.state === 'error') await screen.findByText('Page links could not be loaded.')
      const tile = screen.getByText('Links in').parentElement!
      await waitFor(() => expect(within(tile).getByText(row.value)).not.toBeNull())
      expect(within(tile).getByRole('button', { name: row.help })).not.toBeNull()
      if (row.note) expect(within(tile).getByText(row.note)).not.toBeNull()
      else expect(within(tile).queryByText(/menu and footer hidden/)).toBeNull()
      if (row.state === 'complete') expect(screen.getByRole('region', { name: `Links in (${row.showAll ? row.visible + row.hidden : row.visible})` })).not.toBeNull()
      if (row.total === 500) { fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' })); expect(within(tile).getByText('500')).not.toBeNull(); expect(within(tile).queryByText(/menu and footer hidden/)).toBeNull(); expect(within(tile).getByRole('button', { name: 'How many other pages link to this page. This counts every link, including menu and footer.' })).not.toBeNull() }
    } finally {
      deferred.resolve(jsonResponse(response))
      await act(async () => { await deferred.promise })
      cleanup()
      queryClient.clear()
    }
  }

})

test('presents server-filtered link counts and rows in both toggle states', async () => {
  // Stored API receipts already exclude self-links. This UI contract checks
  // the two remaining inbound categories and exact table/count presentation.
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

  // Filter on: tiles match the server's content-only table input.
  await waitFor(() => expect(within(tile('Links in')).getByText('1')).toBeTruthy())
  expect(within(tile('Links in')).getByText('1 menu and footer hidden')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (1)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()

  // Filter off: tiles show the crawl's totals, which also exclude the
  // self-link, and the tables agree with them.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(within(tile('Links in')).getByText('2')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (2)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()
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
  await waitFor(() => expect(screen.getByRole('button', { name: METRIC_HELP.linksInFiltered })).toBeTruthy())
  expect(screen.getByRole('button', { name: METRIC_HELP.linksOutFiltered })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.clicksFromHome })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.linkImportance })).toBeTruthy()

  // Focus alone reveals the bubble, so the copy is not hover-only.
  const trigger = screen.getByRole('button', { name: METRIC_HELP.linksInFiltered })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(METRIC_HELP.linksInFiltered).getAttribute('aria-hidden')).toBe('true')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(METRIC_HELP.linksInFiltered)).toBeNull()

  // Toggle off the filter and the two filterable tiles stop claiming to be
  // content-only, while the two full-graph tiles are untouched.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show menu and footer links' }))
  expect(screen.getByRole('button', { name: METRIC_HELP.linksInAll })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.linksOutAll })).toBeTruthy()
  expect(screen.queryByRole('button', { name: METRIC_HELP.linksInFiltered })).toBeNull()
  expect(screen.getByRole('button', { name: METRIC_HELP.clicksFromHome })).toBeTruthy()
  expect(screen.getByRole('button', { name: METRIC_HELP.linkImportance })).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  for (const [columnName, help] of [['Links in', METRIC_HELP.linksInAll], ['Links out', METRIC_HELP.linksOutAll], ['Score', METRIC_HELP.technicalScore]] as const) {
    const column = within(screen.getByRole('region', { name: 'Pages' })).getAllByRole('columnheader').find(header => header.textContent?.trim() === columnName)
    expect(column).toBeDefined()
    expect(within(column!).getByRole('button', { name: help })).not.toBeNull()
  }
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  const neighbors = screen.getByRole('region', { name: 'Links in (2)' })
  expect(within(neighbors).getByRole('button', { name: METRIC_HELP.linkTimes })).not.toBeNull()

})


function seedExactProgress(queryClient: QueryClient, phase: 'failed' | 'cancelled' | 'queued' | 'checking') {
  const status = phase === 'checking' ? 'running' : phase
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_selected', status, false), scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient, path: { name: projectName, runId: 'run_selected' },
  }), {
    project: projectName, runId: 'run_selected', status, phase,
    attempt: null, layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: status === 'failed' ? 'The crawl could not reach the sitemap.' : null,
  })
}

test.each(['failed', 'cancelled'] as const)('managed scans hide %s recovery in regular, embedded and onboarding views', phase => {
  for (const surface of ['regular', 'embed', 'onboarding'] as const) {
    window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] },
      ...(surface === 'embed' ? { embed: { enabled: true } } : {}),
    }
    const queryClient = makeClient()
    seedExactProgress(queryClient, phase)
    renderSection(queryClient, { initialRunId: 'run_selected', showOnboardingActions: surface === 'onboarding' }, 'viewer')
    expect(screen.getByRole('alert', { name: 'Site scan recovery' }).textContent).toContain(phase === 'failed' ? 'Scan failed' : 'Scan cancelled')
    expect(screen.queryByRole('button', { name: /Run scan|Run site audit/ })).toBeNull()
    cleanup()
    queryClient.clear()
  }
})

test('managed scans guard the dispatcher before releasing a pinned run', () => {
  const queryClient = makeClient()
  seedExactProgress(queryClient, 'failed')
  const onReleaseInitialRun = vi.fn()
  renderSection(queryClient, { initialRunId: 'run_selected', onReleaseInitialRun }, 'viewer')
  // Exercise an already-rendered plain Button: dispatch must not trust its visibility.
  const button = screen.getByRole('button', { name: 'Run scan again' })
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  fireEvent.click(button)
  expect(mutationMock.mutate).not.toHaveBeenCalled()
  expect(onReleaseInitialRun).not.toHaveBeenCalled()
  expect(screen.getByRole('alert', { name: 'Site scan recovery' })).not.toBeNull()
})

test.each(['header', 'failed', 'no crawl', 'no score', 'no details'] as const)('managed scans preserve admin launches and remove viewer launches: %s', state => {
  for (const role of ['admin', 'viewer'] as const) {
    window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
    const queryClient = makeClient()
    let props: Partial<React.ComponentProps<typeof SiteHealthSection>> = {}
    if (state === 'failed') {
      seedExactProgress(queryClient, 'failed')
      props = { initialRunId: 'run_selected' }
    } else if (state !== 'header') {
      props = { showOnboardingActions: true }
      if (state === 'no crawl') {
        seedRun(queryClient, 'run_1', { ...summary('run_1', 0), hasCrawlData: false })
      } else {
        technicalAeoMock.state = 'unavailable'
        seedRun(queryClient, 'run_1', { ...summary('run_1', 42), detailsAvailable: state !== 'no details' })
      }
    }
    renderSection(queryClient, props, role)
    const buttons = screen.queryAllByRole('button', { name: /Run scan|Run site audit/ })
    if (role === 'viewer') {
      expect(buttons).toHaveLength(0)
      expect(screen.queryByText('Scan settings')).toBeNull()
      expect(screen.queryByRole('checkbox', { name: 'Check dead links' })).toBeNull()
    } else {
      expect(buttons.length).toBeGreaterThan(0)
      fireEvent.click(buttons.at(-1)!)
      expect(mutationMock.mutate).toHaveBeenCalledWith({
        projectName,
        projectId,
        body: {
          checkDeadLinks: Boolean(props.showOnboardingActions),
          ...(props.showOnboardingActions ? { maxPages: 100 } : {}),
        },
      })
    }
    cleanup()
    queryClient.clear()
    mutationMock.mutate.mockReset()
  }
})

test.each(['queued', 'checking'] as const)('managed viewer retains operator-started %s progress', phase => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  seedExactProgress(queryClient, phase)
  renderSection(queryClient, { initialRunId: 'run_selected' }, 'viewer')
  const progress = screen.getByRole('status', { name: 'Current scan progress' })
  expect(progress.textContent).toContain(phase === 'queued' ? 'Waiting to start' : 'Checking pages')
  expect(screen.queryByRole('button', { name: /Run scan/ })).toBeNull()
})

test.each(['running', 'failed', 'partial'] as const)('managed viewer retains map, pages, page evidence and %s explanation', state => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  if (state === 'partial') {
    queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1', 'partial')))
    seedRun(queryClient, 'run_1', summary('run_1', 42, false))
  } else {
    queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_new', state, false), scan('run_1')))
  }
  renderSection(queryClient, {}, 'viewer')
  expect(screen.getByText(state === 'running'
    ? 'A newer scan is running. The latest published result remains available until it finishes.'
    : state === 'failed'
      ? 'The latest scan failed. The previous completed results remain available.'
      : 'This scan stopped at the page limit, so some pages were not checked.', { exact: false })).not.toBeNull()
  expect(screen.getByRole('img', { name: 'Interactive site map' })).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  expect(screen.getByRole('table')).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Page health' }))
  expect(screen.getByText('Page health for run_1')).not.toBeNull()
})

test('managed viewer retains dead-link results', () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', { ...summary('run_1', 42),
    deadLinks: { state: 'complete', checked: 41, found: 3, unverified: 0 },
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey({
    client: heyClient, path: { name: projectName }, query: { runId: 'run_1', limit: 50 },
  }), { project: projectName, runId: 'run_1', state: 'complete', checkDeadLinks: true,
    checked: 41, found: 3, unverified: 0, total: 3, nextCursor: null, deadLinks: [],
  })
  renderSection(queryClient, {}, 'viewer')
  expect(screen.getByText('Broken links: 3 found')).not.toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Check dead links' })).toBeNull()
})

test('the default crawl depth says what it is, and deeper limits exist', async () => {
  renderSection()
  const depth = screen.getByLabelText('Crawl depth')
  expect(within(depth).getByRole('option', { name: 'Default (10 clicks)' }).getAttribute('value')).toBe('')
  expect(within(depth).getByRole('option', { name: '100 clicks (maximum)' }).getAttribute('value')).toBe('100')
  expect(Math.max(...within(depth).getAllByRole('option').map(option => Number(option.getAttribute('value'))))).toBe(100)
  fireEvent.change(depth, { target: { value: '100' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))
  expect(mutationMock.mutate).toHaveBeenCalledExactlyOnceWith({ projectName, projectId, body: { checkDeadLinks: false, maxDepth: 100 } })

})
