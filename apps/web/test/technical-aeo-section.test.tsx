import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey,
  getApiV1ProjectsByNameTechnicalAeoPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoQueryKey,
  getApiV1ProjectsByNameTechnicalAeoTrendQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { FACTOR_SHARE_NOT_RECORDED, TechnicalAeoSection } from '../src/components/project/TechnicalAeoSection.js'
import { factorShareOfScoreLabel } from '../src/components/project/PageAuditEvidence.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { resetRunTracker } from '../src/lib/run-tracker-store.js'
import { resetToasts } from '../src/lib/toast-store.js'

const launchProbe = vi.hoisted(() => ({ capture: false, mutate: vi.fn(), dispatch: undefined as (() => void) | undefined }))
vi.mock('../src/components/shared/AccessControls.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/shared/AccessControls.js')>()
  return { ...actual, WriteButton: (props: React.ComponentProps<typeof actual.WriteButton>) => {
    if (launchProbe.capture) launchProbe.dispatch = props.onClick as () => void
    return <actual.WriteButton {...props} />
  } }
})

vi.mock('../src/queries/mutations.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/queries/mutations.js')>()
  return { ...actual, useTriggerSiteAudit: () => {
    const mutation = actual.useTriggerSiteAudit()
    return launchProbe.capture ? { ...mutation, mutate: launchProbe.mutate } : mutation
  } }
})

const projectName = 'citypoint'
const projectId = 'proj_1'
const scoreKey = getApiV1ProjectsByNameTechnicalAeoQueryKey({
  client: heyClient,
  path: { name: projectName },
})
const trendKey = getApiV1ProjectsByNameTechnicalAeoTrendQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { limit: 30 },
})
const pagesKey = getApiV1ProjectsByNameTechnicalAeoPagesQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { limit: 100, sort: 'score-asc' },
})
const auditRunsKey = getApiV1ProjectsByNameRunsQueryKey({
  client: heyClient,
  path: { name: projectName },
  query: { kind: 'site-audit', limit: 10 },
})

function score(runId: string, aggregateScore = 84) {
  return {
    project: projectName,
    hasData: true,
    runId,
    runStatus: 'completed',
    sitemapUrl: 'https://citypoint.example/sitemap.xml',
    auditedAt: '2026-07-14T18:16:33.000Z',
    aggregateScore,
    pagesDiscovered: 41,
    pagesAudited: 39,
    pagesSkipped: 2,
    pagesErrored: 0,
    deltaScore: 3,
    trend: 'up',
    previousScore: 81,
    previousAuditedAt: '2026-07-01T18:16:33.000Z',
    factors: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
  }
}

function scoreWithFinding() {
  return {
    ...score('audit_old', 52),
    pagesDiscovered: 2,
    pagesAudited: 2,
    pagesSkipped: 0,
    factors: [{
      id: 'ai-crawler-access',
      name: 'AI Crawler Access',
      weight: 20,
      avgScore: 30,
      status: 'fail',
      pagesPassing: 0,
      pagesPartial: 0,
      pagesFailing: 2,
    }],
    crossCuttingIssues: [{
      factorId: 'ai-crawler-access',
      factorName: 'AI Crawler Access',
      avgScore: 30,
      affectedPages: 2,
      totalPages: 2,
      affectedPct: 100,
      topRecommendations: ['Allow GPTBot in robots.txt'],
    }],
  }
}

function run(id: string, status: string) {
  return {
    id,
    projectId,
    kind: 'site-audit',
    status,
    trigger: 'manual',
    location: null,
    startedAt: '2026-07-14T18:15:00.000Z',
    finishedAt: status === 'running' || status === 'queued' ? null : '2026-07-14T18:16:33.000Z',
    error: null,
    createdAt: '2026-07-14T18:15:00.000Z',
  }
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scoreKey, score('audit_old'))
  queryClient.setQueryData(trendKey, { project: projectName, points: [] })
  queryClient.setQueryData(pagesKey, { project: projectName, runId: 'audit_old', auditedAt: null, total: 0, pages: [] })
  return queryClient
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetRunTracker()
  resetToasts()
  launchProbe.capture = false
  launchProbe.mutate.mockReset()
  launchProbe.dispatch = undefined
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
  resetRunTracker()
  resetToasts()
  vi.restoreAllMocks()
})

test('shows an active audit and prevents a duplicate re-run', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(auditRunsKey, [run('audit_running', 'running')])

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  expect((screen.getByRole('button', { name: 'Audit running' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Results refresh automatically when this audit finishes.')).not.toBeNull()
})

test('refreshes the score, trend, and pages when a newer audit completes', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(auditRunsKey, [run('audit_new', 'completed')])

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/pages')) {
      return jsonResponse({ project: projectName, runId: 'audit_new', auditedAt: null, total: 0, pages: [] })
    }
    if (url.includes('/technical-aeo/trend')) {
      return jsonResponse({ project: projectName, points: [] })
    }
    if (url.includes('/technical-aeo')) {
      return jsonResponse(score('audit_new', 90))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByText('90')).not.toBeNull())
  const fetchedUrls = fetchMock.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input))
  expect(fetchedUrls.some((url) => url.includes('/technical-aeo/pages'))).toBe(true)
  expect(fetchedUrls.some((url) => url.includes('/technical-aeo/trend'))).toBe(true)
})

test('loads the scorecard and pages for a selected historical audit', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, score('audit_new', 90))
  queryClient.setQueryData(pagesKey, { project: projectName, runId: 'audit_new', auditedAt: null, total: 0, pages: [] })
  queryClient.setQueryData(trendKey, {
    project: projectName,
    points: [
      { runId: 'audit_old', auditedAt: '2026-07-01T18:16:33.000Z', aggregateScore: 72, pagesAudited: 35 },
      { runId: 'audit_new', auditedAt: '2026-07-14T18:16:33.000Z', aggregateScore: 90, pagesAudited: 39 },
    ],
  })
  queryClient.setQueryData(auditRunsKey, [run('audit_new', 'completed')])

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/pages')) {
      return jsonResponse({ project: projectName, runId: 'audit_old', auditedAt: '2026-07-01T18:16:33.000Z', total: 0, pages: [] })
    }
    if (url.includes('/technical-aeo')) {
      return jsonResponse(score('audit_old', 72))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Technical AEO audit' }), {
    target: { value: 'audit_old' },
  })

  await waitFor(() => expect(screen.getByText('72')).not.toBeNull())
  expect(screen.getByText('Technical AEO history')).not.toBeNull()
  const fetchedUrls = fetchMock.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input))
  expect(fetchedUrls.some((url) => url.includes('runId=audit_old'))).toBe(true)
  expect(fetchedUrls.filter((url) => url.includes('runId=audit_old'))).toHaveLength(2)
})

test('shows a cross-cutting issue share as the API sent it, through formatPercent', () => {
  const queryClient = makeClient()
  // 1 of 3 audited pages is 33.33% on the wire.
  const issue = { ...scoreWithFinding().crossCuttingIssues[0]!, affectedPages: 1, totalPages: 3, affectedPct: 33.33 }
  queryClient.setQueryData(scoreKey, { ...scoreWithFinding(), crossCuttingIssues: [issue] })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  expect(screen.getByText('avg 30 · affects 1 of 3 pages (33.3%)')).not.toBeNull()
})

test('preserves the crawl error as the tooltip on a truncated page URL', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, { ...score('audit_old'), pagesErrored: 1 })
  const url = `https://citypoint.example/${'long-path-segment-'.repeat(8)}failed`
  queryClient.setQueryData(pagesKey, {
    project: projectName,
    runId: 'audit_old',
    auditedAt: null,
    total: 1,
    pages: [{
      url,
      status: 'error',
      error: 'Crawl timed out after 30 seconds',
      overallScore: 0,
    }],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  const visibleUrl = screen.getByText(`${[...url].slice(0, 54).join('')}…${[...url].slice(-20).join('')}`)
  expect(visibleUrl.parentElement?.getAttribute('title')).toBe('Crawl timed out after 30 seconds')
  expect(visibleUrl.parentElement?.querySelector('.sr-only')?.textContent).toBe(url)
})

test.each([
  ['integrated', true],
  ['standalone', false],
] as const)('shows a recoverable score-read error in %s mode', async (_mode, integrated) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  let scoreCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (/\/technical-aeo(?:\?|$)/.test(url)) scoreCalls += 1
    return new Response('{"error":"unavailable"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated={integrated} />
    </QueryClientProvider>,
  )

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Page health could not load')
  expect(screen.queryByText('Page health unavailable')).toBeNull()

  const callsBeforeRetry = scoreCalls
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(scoreCalls).toBeGreaterThan(callsBeforeRetry))
})

test('adds the caller recovery path when integrated page health cannot be read', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })))

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection
        projectName={projectName}
        projectId={projectId}
        runId="audit_partial"
        integrated
        afterSummary={<p>Continue after successful Page health</p>}
        unavailableFooter={<p>Continue setup without Page health</p>}
      />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Page health could not load')).not.toBeNull()
  expect(screen.getByText('Continue setup without Page health')).not.toBeNull()
  expect(screen.queryByText('Continue after successful Page health')).toBeNull()
})

test('a partial crawl scores the pages it reached, and never claims the site', () => {
  // `partial` is the normal outcome of a bounded first scan, not an exception.
  // Labelling it "Site score / Pass" makes exactly the claim the agent setup
  // request forbids ("never present it as a full-site result").
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, { ...score('audit_partial', 86), runStatus: 'partial' })
  queryClient.setQueryData(pagesKey, { project: projectName, runId: 'audit_partial', auditedAt: '2026-07-14T18:16:33.000Z', total: 0, pages: [] })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Score so far')).not.toBeNull()
  expect(screen.getByText('Part of the site')).not.toBeNull()
  expect(screen.queryByText('Site score')).toBeNull()
  expect(screen.getByLabelText(/from a scan that did not cover the whole site/)).not.toBeNull()
})

test('distills the integrated view to a score and its actionable findings', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, {
    ...score('audit_old', 52),
    pagesDiscovered: 2,
    pagesAudited: 2,
    pagesSkipped: 0,
    factors: [
      {
        id: 'ai-crawler-access',
        name: 'AI Crawler Access',
        weight: 20,
        avgScore: 30,
        status: 'fail',
        pagesPassing: 0,
        pagesPartial: 0,
        pagesFailing: 2,
      },
      {
        id: 'structured-data',
        name: 'Structured Data',
        weight: 15,
        avgScore: 74,
        status: 'pass',
        pagesPassing: 1,
        pagesPartial: 1,
        pagesFailing: 0,
      },
    ],
    crossCuttingIssues: [{
      factorId: 'ai-crawler-access',
      factorName: 'AI Crawler Access',
      avgScore: 30,
      affectedPages: 2,
      totalPages: 2,
      affectedPct: 100,
      topRecommendations: ['Allow GPTBot in robots.txt'],
    }],
  })
  queryClient.setQueryData(pagesKey, {
    project: projectName,
    runId: 'audit_old',
    auditedAt: '2026-07-14T18:16:33.000Z',
    total: 2,
    pages: [
      {
        url: 'https://citypoint.example/',
        status: 'success',
        overallScore: 44,
        factors: [{ id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 20, score: 30 }],
      },
      {
        url: 'https://citypoint.example/services',
        status: 'success',
        overallScore: 60,
        factors: [{ id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 20, score: 30 }],
      },
    ],
  })
  queryClient.setQueryData(trendKey, {
    project: projectName,
    points: [
      { runId: 'audit_older', auditedAt: '2026-07-01T18:16:33.000Z', aggregateScore: 48, pagesAudited: 2 },
      { runId: 'audit_old', auditedAt: '2026-07-14T18:16:33.000Z', aggregateScore: 52, pagesAudited: 2 },
    ],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection
        projectName={projectName}
        projectId={projectId}
        integrated
        afterSummary={<p>Continue after the Page health summary</p>}
        unavailableFooter={<p>Recover unavailable Page health</p>}
      />
    </QueryClientProvider>,
  )

  expect(screen.getByLabelText('Site score 52 out of 100')).not.toBeNull()
  expect(screen.getByText('2 pages checked')).not.toBeNull()
  expect(screen.getByText('2 checks with pages below pass')).not.toBeNull()
  const findingsHeading = screen.getByRole('heading', { name: 'Technical findings' })
  expect(findingsHeading).not.toBeNull()
  expect(screen.getByText('Select a check to see affected pages and recommended fixes.')).not.toBeNull()
  expect(screen.getByText('Pages affected')).not.toBeNull()
  const nextAction = screen.getByText('Continue after the Page health summary')
  const scoreSummary = screen.getByLabelText('Site score 52 out of 100')
  expect(Boolean(scoreSummary.compareDocumentPosition(nextAction) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(Boolean(nextAction.compareDocumentPosition(findingsHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(screen.queryByText('Recover unavailable Page health')).toBeNull()

  const failingFactor = screen.getByRole('button', { name: 'AI Crawler Access' })
  expect(failingFactor.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Allow GPTBot in robots.txt')).toBeNull()
  expect(screen.queryByRole('link', { name: 'https://citypoint.example/services' })).toBeNull()
  fireEvent.click(failingFactor)
  expect(failingFactor.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Allow GPTBot in robots.txt')).not.toBeNull()
  expect(screen.getByRole('link', { name: 'https://citypoint.example/services' })).not.toBeNull()

  expect(screen.queryByRole('heading', { name: 'Site score over time' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Prioritized fixes' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Per-page breakdown' })).toBeNull()
})

test('keeps the integrated findings table readable while affected pages load', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithFinding())
  queryClient.removeQueries({ queryKey: pagesKey })
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated />
    </QueryClientProvider>,
  )

  const factorButton = screen.getByRole('button', { name: 'AI Crawler Access' })
  expect(factorButton.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(factorButton)
  expect(await screen.findByText('Loading affected pages...')).not.toBeNull()
  expect(screen.getByRole('table').className).toContain('min-w-[42rem]')
  expect(screen.queryByText('Page details are not available in the loaded audit sample.')).toBeNull()
  expect(screen.queryByText(/Showing the worst 0 audited pages/)).toBeNull()
})

test('uses compact findings copy only when the onboarding parent requests it', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithFinding())
  queryClient.setQueryData(pagesKey, { project: projectName, pages: [], total: 0 })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated compactCopy />
    </QueryClientProvider>,
  )

  expect(screen.getByRole('heading', { name: 'Checks' })).not.toBeNull()
  expect(screen.getByText('Open a check to see affected pages and recommended fixes.')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Technical findings' })).toBeNull()
  const check = screen.getByRole('button', { name: 'AI Crawler Access' })
  expect(check.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Allow GPTBot in robots.txt')).toBeNull()
  fireEvent.click(check)
  expect(check.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Allow GPTBot in robots.txt')).not.toBeNull()
})

test('shows one exact page finding in onboarding when aggregate recommendations are unavailable', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, {
    ...scoreWithFinding(),
    crossCuttingIssues: [{
      ...scoreWithFinding().crossCuttingIssues[0],
      topRecommendations: [],
    }],
  })
  queryClient.setQueryData(pagesKey, {
    project: projectName,
    runId: 'audit_old',
    auditedAt: '2026-07-14T18:16:33.000Z',
    total: 1,
    pages: [{
      url: 'https://citypoint.example/services',
      status: 'success',
      overallScore: 42,
      factors: [{ id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 20, score: 30 }],
    }],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { url: 'https://citypoint.example/services' },
  }), {
    state: 'ready',
    project: projectName,
    runId: 'audit_old',
    complete: true,
    termination: null,
    nodeKey: 'page_services',
    url: 'https://citypoint.example/services',
    auditState: 'complete',
    auditScore: 42,
    evidenceState: 'complete',
    factors: [{
      id: 'content-depth',
      name: 'Content depth',
      weight: 12,
      score: 20,
      status: 'fail',
      applicable: true,
      findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Only 120 words were found.' }],
      recommendations: ['Answer the key questions visitors ask on this page.'],
    }],
    criticalDefects: [],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated compactCopy />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Page-level evidence for the first page to fix appears below.', { exact: false })).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'First page to fix' })).not.toBeNull()
  expect(screen.getAllByRole('link', { name: 'https://citypoint.example/services' })).toHaveLength(1)
  expect(screen.getByRole('heading', { name: 'Findings and fixes for this page' })).not.toBeNull()
  expect(await screen.findByText('Content depth')).not.toBeNull()
  expect(screen.getByText('42/100')).not.toBeNull()
})

test('does not call a healthy fallback page the first page to fix', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, {
    ...scoreWithFinding(),
    crossCuttingIssues: [{
      ...scoreWithFinding().crossCuttingIssues[0],
      topRecommendations: [],
    }],
  })
  queryClient.setQueryData(pagesKey, {
    project: projectName,
    runId: 'audit_old',
    auditedAt: '2026-07-14T18:16:33.000Z',
    total: 1,
    pages: [{
      url: 'https://citypoint.example/',
      status: 'success',
      overallScore: 92,
      factors: [{ id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 20, score: 100 }],
    }],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated compactCopy />
    </QueryClientProvider>,
  )

  expect(screen.getByRole('heading', { name: 'Example audited page' })).not.toBeNull()
  expect(screen.getByText('Page-level evidence for one audited page appears below.', { exact: false })).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'First page to fix' })).toBeNull()
})

test('shows a focused retry when integrated affected pages fail to load', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithFinding())
  queryClient.removeQueries({ queryKey: pagesKey })
  let pageCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/pages')) pageCalls += 1
    return new Response('{"error":"unavailable"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated />
    </QueryClientProvider>,
  )

  const factorButton = screen.getByRole('button', { name: 'AI Crawler Access' })
  expect(factorButton.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(factorButton)
  expect(await screen.findByText('Affected pages could not load')).not.toBeNull()
  expect(screen.queryByText('Page details are not available in the loaded audit sample.')).toBeNull()
  expect(screen.queryByText(/Showing the worst 0 audited pages/)).toBeNull()

  const callsBeforeRetry = pageCalls
  fireEvent.click(screen.getByRole('button', { name: 'Retry affected pages' }))
  await waitFor(() => expect(pageCalls).toBeGreaterThan(callsBeforeRetry))
})

test('keeps recommendation-free integrated findings truthful and single-column', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, {
    ...scoreWithFinding(),
    crossCuttingIssues: [{
      ...scoreWithFinding().crossCuttingIssues[0],
      topRecommendations: [],
    }],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Select a check to see affected pages and score details.')).not.toBeNull()
  expect(screen.queryByText('Open a check to see affected pages and fixes.')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Recommended fixes' })).toBeNull()

  const factorButton = screen.getByRole('button', { name: 'AI Crawler Access' })
  expect(factorButton.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(factorButton)
  expect(factorButton.getAttribute('aria-expanded')).toBe('true')
  expect(factorButton.hasAttribute('aria-controls')).toBe(false)
  const affectedPagesHeading = screen.getByRole('heading', { name: 'Affected pages (2)' })
  expect(affectedPagesHeading.closest('.grid')?.className).not.toContain('lg:grid-cols-2')

  fireEvent.click(factorButton)
  expect(factorButton.getAttribute('aria-expanded')).toBe('false')
  expect(factorButton.hasAttribute('aria-controls')).toBe(false)
})


test.each([false, true])('managed standalone audit controls are role-aware (hasData=%s)', hasData => {
  for (const role of ['viewer', 'admin'] as const) {
    window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
    const queryClient = makeClient()
    queryClient.setQueryData(scoreKey, { ...scoreWithFinding(), hasData })
    render(<QueryClientProvider client={queryClient}>
      <AccountProvider account={{ name: 'Test account', role }}>
        <TechnicalAeoSection projectName={projectName} projectId={projectId} />
      </AccountProvider>
    </QueryClientProvider>)
    const button = screen.queryByRole('button', { name: hasData ? 'Re-run audit' : 'Run first audit' })
    expect(Boolean(button)).toBe(role === 'admin')
    cleanup()
    queryClient.clear()
  }
})

test('managed standalone audit dispatcher refuses an already-rendered viewer launch', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(auditRunsKey, [])
  launchProbe.capture = true
  render(<QueryClientProvider client={queryClient}>
    <AccountProvider account={{ name: 'Test account', role: 'viewer' }}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </AccountProvider>
  </QueryClientProvider>)
  // Capture the real dispatcher independently of WriteButton's disabled state.
  expect(launchProbe.dispatch).toBeTypeOf('function')
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  launchProbe.dispatch!()
  expect(launchProbe.mutate).not.toHaveBeenCalled()
})

test.each(['running', 'failed'] as const)('managed viewer keeps the scorecard and %s scan state', status => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithFinding())
  queryClient.setQueryData(auditRunsKey, [{ ...run('audit_new', status), error: status === 'failed' ? 'The scan timed out.' : null }])
  render(<QueryClientProvider client={queryClient}>
    <AccountProvider account={{ name: 'Test account', role: 'viewer' }}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </AccountProvider>
  </QueryClientProvider>)
  expect(screen.getByText('52')).not.toBeNull()
  expect(screen.getAllByText('AI Crawler Access').length).toBeGreaterThan(0)
  if (status === 'running') expect(screen.getByText('Results refresh automatically when this audit finishes.')).not.toBeNull()
  expect(screen.queryByRole('button', { name: /Re-run audit|Audit running/ })).toBeNull()
})

/**
 * The sixteen core factors with the share of the score the audit engine
 * records when all of them apply. The weights sum to 111, so a weight shown
 * with a percent sign overstates every factor; the shares add up to 100.
 */
const CORE_FACTOR_SHARES = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, sharePct: 10.9, shown: '10.9%' },
  { id: 'content-depth', name: 'Content Depth', weight: 10, sharePct: 9, shown: '9.0%' },
  { id: 'citations', name: 'Citations & Authority Signals', weight: 8, sharePct: 7.2, shown: '7.2%' },
  { id: 'eeat-signals', name: 'E-E-A-T Signals', weight: 8, sharePct: 7.2, shown: '7.2%' },
  { id: 'faq-content', name: 'FAQ Content', weight: 8, sharePct: 7.2, shown: '7.2%' },
  { id: 'schema-completeness', name: 'Schema Completeness', weight: 8, sharePct: 7.2, shown: '7.2%' },
  { id: 'content-freshness', name: 'Content Freshness', weight: 7, sharePct: 6.3, shown: '6.3%' },
  { id: 'entity-consistency', name: 'Entity Consistency', weight: 7, sharePct: 6.3, shown: '6.3%' },
  { id: 'content-extractability', name: 'Content Extractability', weight: 6, sharePct: 5.4, shown: '5.4%' },
  { id: 'definition-blocks', name: 'Definition Blocks', weight: 6, sharePct: 5.4, shown: '5.4%' },
  { id: 'named-entities', name: 'Named Entities', weight: 6, sharePct: 5.4, shown: '5.4%' },
  { id: 'snippet-eligibility', name: 'Snippet Eligibility', weight: 6, sharePct: 5.4, shown: '5.4%' },
  { id: 'ai-access-files', name: 'AI Access Files (llms.txt, sitemap)', weight: 5, sharePct: 4.5, shown: '4.5%' },
  { id: 'schema-validity', name: 'Schema Validity', weight: 5, sharePct: 4.5, shown: '4.5%' },
  { id: 'technical-seo', name: 'Technical SEO', weight: 5, sharePct: 4.5, shown: '4.5%' },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, sharePct: 3.6, shown: '3.6%' },
] as const

/** A weight printed as a percent: `12%`, but not the `2%` inside `7.2%`. */
const WEIGHT_AS_PERCENT = /(?<![\d.])(?:1[02]|[4-8])%/

function scoreWithCoreFactors(recorded: boolean) {
  return {
    ...score('audit_old', 84),
    factors: CORE_FACTOR_SHARES.map(({ shown: _shown, ...factor }) => ({
      ...factor,
      sharePct: recorded ? factor.sharePct : null,
      avgScore: 84,
      status: 'pass',
      pagesPassing: 39,
      pagesPartial: 0,
      pagesFailing: 0,
    })),
  }
}

function factorScorecard(): HTMLElement {
  return screen.getByRole('columnheader', { name: 'Share' }).closest('table')!
}

function shareCell(table: HTMLElement, factorName: string): HTMLElement {
  const row = within(table).getByRole('button', { name: factorName }).closest('tr')!
  return within(row).getAllByRole('cell')[1]!
}

test('shows each ranking factor share of the site score, and the shares add up to 100%', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithCoreFactors(true))

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  const table = factorScorecard()
  expect(within(table).queryByRole('columnheader', { name: 'Weight' })).toBeNull()
  const shown = CORE_FACTOR_SHARES.map((factor) => shareCell(table, factor.name).textContent)
  expect(shown).toEqual(CORE_FACTOR_SHARES.map((factor) => factor.shown))
  const total = shown.reduce((sum, text) => sum + Number.parseFloat(text!), 0)
  expect(Number(total.toFixed(1))).toBe(100)
  // The raw weights (12, 10, 8, ...) are never printed as percentages.
  expect(table.textContent).not.toMatch(WEIGHT_AS_PERCENT)
})

test('shows a dash, never the weight, for a scan that did not record shares', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scoreKey, scoreWithCoreFactors(false))

  render(
    <QueryClientProvider client={queryClient}>
      <TechnicalAeoSection projectName={projectName} projectId={projectId} />
    </QueryClientProvider>,
  )

  const table = factorScorecard()
  for (const factor of CORE_FACTOR_SHARES) {
    const cell = shareCell(table, factor.name)
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe('—')
    expect(within(cell).getByText(FACTOR_SHARE_NOT_RECORDED).className).toContain('sr-only')
  }
  expect(table.textContent).not.toMatch(WEIGHT_AS_PERCENT)
})

test('names the site-score share of an expanded check, and nothing for a scan without shares', () => {
  const withShare = {
    ...scoreWithFinding(),
    factors: [{ ...scoreWithFinding().factors[0], weight: 4, sharePct: 3.6 }],
  }
  for (const [data, expected] of [[withShare, 'Worth 3.6% of the site score'], [scoreWithFinding(), null]] as const) {
    const queryClient = makeClient()
    queryClient.setQueryData(scoreKey, data)
    render(
      <QueryClientProvider client={queryClient}>
        <TechnicalAeoSection projectName={projectName} projectId={projectId} integrated />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'AI Crawler Access' }))
    expect(screen.getByText('Allow GPTBot in robots.txt')).not.toBeNull()
    if (expected) {
      expect(screen.getByText(expected)).not.toBeNull()
      expect(factorShareOfScoreLabel(3.6, 'site')).toBe(expected)
    } else {
      expect(screen.queryByText(/of the site score/)).toBeNull()
    }
    // Neither the old "Weight: 4%" line nor the fixture's weight of 20 appears as a percent.
    expect(screen.queryByText(/Weight:/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/(?<![\d.])(?:4|20)% of the site score/)
    cleanup()
    queryClient.clear()
  }
})
