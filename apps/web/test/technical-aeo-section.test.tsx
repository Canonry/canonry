import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey,
  getApiV1ProjectsByNameTechnicalAeoPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoQueryKey,
  getApiV1ProjectsByNameTechnicalAeoTrendQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { TechnicalAeoSection } from '../src/components/project/TechnicalAeoSection.js'
import { heyClient } from '../src/api.js'
import { resetRunTracker } from '../src/lib/run-tracker-store.js'
import { resetToasts } from '../src/lib/toast-store.js'

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
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
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
        footer={<p>Continue after successful Page health</p>}
        unavailableFooter={<p>Continue setup without Page health</p>}
      />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Page health could not load')).not.toBeNull()
  expect(screen.getByText('Continue setup without Page health')).not.toBeNull()
  expect(screen.queryByText('Continue after successful Page health')).toBeNull()
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
        footer={<p>Continue onboarding after reviewing fixes</p>}
        unavailableFooter={<p>Recover unavailable Page health</p>}
      />
    </QueryClientProvider>,
  )

  expect(screen.getByLabelText('Site score 52 out of 100')).not.toBeNull()
  expect(screen.getByText('2 pages checked')).not.toBeNull()
  expect(screen.getByText('2 checks need attention')).not.toBeNull()
  const findingsHeading = screen.getByRole('heading', { name: 'Technical findings' })
  expect(findingsHeading).not.toBeNull()
  expect(screen.getByText('Select a check to see affected pages and recommended fixes.')).not.toBeNull()
  expect(screen.getByText('Pages affected')).not.toBeNull()
  const onboardingFooter = screen.getByText('Continue onboarding after reviewing fixes')
  expect(onboardingFooter).not.toBeNull()
  expect(Boolean(findingsHeading.compareDocumentPosition(onboardingFooter) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(screen.queryByText('Recover unavailable Page health')).toBeNull()

  const failingFactor = screen.getByRole('button', { name: 'AI Crawler Access' })
  await waitFor(() => expect(failingFactor.getAttribute('aria-expanded')).toBe('true'))
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
  expect(screen.getAllByRole('link', { name: 'https://citypoint.example/services' })).toHaveLength(2)
  expect(screen.getByRole('heading', { name: 'Findings and fixes' })).not.toBeNull()
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
  await waitFor(() => expect(factorButton.getAttribute('aria-expanded')).toBe('true'))
  expect(factorButton.hasAttribute('aria-controls')).toBe(false)
  const affectedPagesHeading = screen.getByRole('heading', { name: 'Affected pages (2)' })
  expect(affectedPagesHeading.closest('.grid')?.className).not.toContain('lg:grid-cols-2')

  fireEvent.click(factorButton)
  expect(factorButton.getAttribute('aria-expanded')).toBe('false')
  expect(factorButton.hasAttribute('aria-controls')).toBe(false)
})
