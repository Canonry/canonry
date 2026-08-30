import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

const project = {
  id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
  country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
  locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
}

const run = {
  id: 'run_saved', projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: null,
  resolvedModel: 'sample-model', location: null, totalQueries: 2, completedQueries: 1, failedQueries: 1,
  error: null, startedAt: '2026-08-01T10:00:00.000Z', finishedAt: '2026-08-01T10:01:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
}

const completedQuery = {
  id: 'query_done', position: 0, query: 'How should a sample team measure answer visibility?', status: 'completed',
  requestedModel: null, resolvedModel: 'sample-model', servedModel: 'sample-model', answerText: 'This is saved test evidence.',
  groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
  answerMentioned: false, citationState: 'not-cited', error: null, startedAt: '2026-08-01T10:00:00.000Z',
  finishedAt: '2026-08-01T10:00:01.000Z', createdAt: '2026-08-01T10:00:00.000Z',
}

const failedQuery = {
  ...completedQuery,
  id: 'query_failed',
  position: 1,
  query: 'This failed test query must not be offered for tracking',
  status: 'failed',
  answerText: null,
  error: 'Provider unavailable',
  answerMentioned: null,
  citationState: null,
}

const secondCompletedQuery = {
  ...completedQuery,
  id: 'query_done_second',
  position: 1,
  query: 'Which sample visibility signal should we track?',
  answerText: 'This is the second saved test evidence.',
}

test('promotes a completed saved test query through preview and receipt-backed commit', async () => {
  const calls: Array<{ path: string; body?: unknown; headers?: HeadersInit }> = []
  let commitAttempts = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, headers: init?.headers })

    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery, failedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo/research/runs/run_saved/queries/query_done/promotion-preview') {
      return jsonResponse({
        mode: 'simple', previewChecksum: 'preview-checksum', source: { runId: 'run_saved', queryId: 'query_done', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase(), status: 'completed', completedAt: completedQuery.finishedAt },
        trackedQuery: { state: 'new', id: 'tracked_query', proposedId: 'tracked_query', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase() },
        setup: { state: 'simple', mode: 'simple', activeRevision: null, activeCompiledChecksum: null, draftEtag: null },
      })
    }
    if (path === '/api/v1/projects/demo/research/runs/run_saved/queries/query_done/promotion') {
      commitAttempts += 1
      if (commitAttempts === 1) return jsonResponse({ error: { message: 'The project changed. Preview again if needed.' } }, 409)
      return jsonResponse({
        status: 'tracked-awaiting-first-sweep', mode: 'simple', publishedRevision: null, compiledChecksum: null,
        source: { runId: 'run_saved', queryId: 'query_done', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase(), status: 'completed', completedAt: completedQuery.finishedAt },
        trackedQuery: { state: 'new', id: 'tracked_query', proposedId: 'tracked_query', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase() },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const preview = await screen.findByRole('button', { name: 'Preview assignment' })
  expect(screen.getByText('This is saved test evidence.')).toBeTruthy()
  expect(screen.getByText('Saved test evidence')).toBeTruthy()
  expect(screen.queryByText('This failed test query must not be offered for tracking')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Preview assignment' })).toHaveLength(1)
  fireEvent.click(preview)

  const confirm = await screen.findByRole('button', { name: 'Confirm tracking' })
  fireEvent.click(confirm)
  await waitFor(() => expect(calls.filter(call => call.path.endsWith('/promotion'))).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm tracking' }))
  expect(await screen.findByText('Tracked, awaiting first sweep.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Preview assignment' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm tracking' })).toBeNull()

  const previewCall = calls.find(call => call.path.endsWith('/promotion-preview'))
  const commitCalls = calls.filter(call => call.path.endsWith('/promotion'))
  const commitCall = commitCalls[0]
  expect(previewCall?.body).toEqual({})
  expect(commitCall?.body).toEqual({ previewChecksum: 'preview-checksum', request: {} })
  expect(new Headers(commitCall?.headers).get('Idempotency-Key')).toMatch(/^research-promotion-/)
  expect(new Headers(commitCalls[0]?.headers).get('Idempotency-Key')).toBe(new Headers(commitCalls[1]?.headers).get('Idempotency-Key'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('previews an Advanced assignment before it can be confirmed', async () => {
  const calls: Array<{ path: string; body?: unknown; headers?: HeadersInit }> = []
  const source = { runId: 'run_saved', queryId: 'query_done', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase(), status: 'completed', completedAt: completedQuery.finishedAt }
  const trackedQuery = { state: 'new', id: 'tracked_query', proposedId: 'tracked_query', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase() }
  const activePlan = {
    active: {
      revision: 4, checksum: 'plan-checksum', compiledChecksum: 'compiled-checksum', createdAt: '2026-08-01T00:00:00.000Z',
      plan: {
        schemaVersion: 2,
        identities: { projectBrand: { canonicalHost: 'demo.example', ownedHosts: ['demo.example'], names: ['Demo'] } },
        targets: [{ stableKey: 'property-sample', label: 'Sample Property', aliases: [], urlMatchers: [], mentionNotApplicable: false, discoveryIdentity: null }],
        groups: [{ stableKey: 'group-sample', label: 'Sample Group', targetKeys: ['property-sample'], competitors: [] }],
        querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [], compiledChecksum: 'compiled-checksum',
      },
    },
  }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, headers: init?.headers })
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', activeRevision: 4, activeSchemaVersion: 2, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse(activePlan)
    if (path.endsWith('/promotion-preview')) {
      return jsonResponse({
        mode: 'advanced', previewChecksum: 'advanced-preview', source, trackedQuery,
        setup: { state: 'operational', mode: 'active-v2', activeRevision: 4, activeCompiledChecksum: 'compiled-checksum', draftEtag: null },
        selection: { queryClass: 'branded', groupKeys: ['group-sample'] },
        audience: { targetKeys: ['property-sample'], groups: [{ groupKey: 'group-sample', label: 'Sample Group', memberCount: 1 }], overlapCount: 0 },
        assignments: { requested: 1, added: 1, alreadyPresent: 0, classifications: [{ targetKey: 'property-sample', queryId: 'tracked_query', queryClass: 'branded' }] },
        execution: { addedNodes: 1, addedProviderCalls: 2, fullRunNodes: 12, fullRunProviderCalls: 24 },
        candidate: { compiledChecksum: 'next-checksum', checks: [], plan: activePlan.active.plan, diff: { activeRevision: 4, targets: { added: [], removed: [], changed: [], unchanged: ['property-sample'] }, groups: { added: [], removed: [], changed: [], unchanged: ['group-sample'] }, assignments: { added: 1, removed: 0, reclassified: 0 }, execution: { addedNodeKeys: ['node-sample'], removedNodeKeys: [] } } },
      })
    }
    if (path.endsWith('/promotion')) return jsonResponse({ status: 'tracked-awaiting-first-sweep', mode: 'advanced', source, trackedQuery, publishedRevision: 5, compiledChecksum: 'next-checksum' })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  await screen.findByLabelText('Query class')
  expect((screen.getByRole('button', { name: 'Preview assignment' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Query class'), { target: { value: 'branded' } })
  fireEvent.click(screen.getByLabelText(/Sample Group/))
  fireEvent.click(screen.getByRole('button', { name: 'Preview assignment' }))

  expect(await screen.findByText('Resolved Properties')).toBeTruthy()
  expect(screen.getByText('1 added, 0 already tracked')).toBeTruthy()
  expect(screen.getByText('2 added, 24 in the full sweep')).toBeTruthy()
  expect(screen.queryByText('Published revision')).toBeNull()
  const previewCall = calls.find(call => call.path.endsWith('/promotion-preview'))
  expect(previewCall?.body).toEqual({ queryClass: 'branded', groupKeys: ['group-sample'] })

  fireEvent.click(screen.getByRole('button', { name: 'Confirm tracking' }))
  expect(await screen.findByText('Tracked, awaiting first sweep.')).toBeTruthy()
  expect(screen.getByText('Published revision 5 will be measured by the next AI visibility sweep.')).toBeTruthy()
  const commitCall = calls.find(call => call.path.endsWith('/promotion'))
  expect(commitCall?.body).toEqual({ previewChecksum: 'advanced-preview', request: { queryClass: 'branded', groupKeys: ['group-sample'] } })
  expect(new Headers(commitCall?.headers).get('Idempotency-Key')).toMatch(/^research-promotion-/)
})

test('does not confirm an Advanced preview that adds no assignments', async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const source = { runId: 'run_saved', queryId: 'query_done', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase(), status: 'completed', completedAt: completedQuery.finishedAt }
  const trackedQuery = { state: 'existing', id: 'tracked_query', proposedId: 'tracked_query', query: completedQuery.query, normalizedQuery: completedQuery.query.toLowerCase() }
  const activePlan = {
    active: {
      revision: 4, checksum: 'plan-checksum', compiledChecksum: 'compiled-checksum', createdAt: '2026-08-01T00:00:00.000Z',
      plan: {
        schemaVersion: 2,
        identities: { projectBrand: { canonicalHost: 'demo.example', ownedHosts: ['demo.example'], names: ['Demo'] } },
        targets: [{ stableKey: 'property-sample', label: 'Sample Property', aliases: [], urlMatchers: [], mentionNotApplicable: false, discoveryIdentity: null }],
        groups: [{ stableKey: 'group-sample', label: 'Sample Group', targetKeys: ['property-sample'], competitors: [] }],
        querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [], compiledChecksum: 'compiled-checksum',
      },
    },
  }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', activeRevision: 4, activeSchemaVersion: 2, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse(activePlan)
    if (path.endsWith('/promotion-preview')) {
      return jsonResponse({
        mode: 'advanced', previewChecksum: 'advanced-preview', source, trackedQuery,
        setup: { state: 'operational', mode: 'active-v2', activeRevision: 4, activeCompiledChecksum: 'compiled-checksum', draftEtag: null },
        selection: { queryClass: 'branded', groupKeys: ['group-sample'] },
        audience: { targetKeys: ['property-sample'], groups: [{ groupKey: 'group-sample', label: 'Sample Group', memberCount: 1 }], overlapCount: 0 },
        assignments: { requested: 1, added: 0, alreadyPresent: 1, classifications: [{ targetKey: 'property-sample', queryId: 'tracked_query', queryClass: 'branded' }] },
        execution: { addedNodes: 0, addedProviderCalls: 0, fullRunNodes: 12, fullRunProviderCalls: 24 },
        candidate: { compiledChecksum: 'plan-checksum', checks: [], plan: activePlan.active.plan, diff: { activeRevision: 4, targets: { added: [], removed: [], changed: [], unchanged: ['property-sample'] }, groups: { added: [], removed: [], changed: [], unchanged: ['group-sample'] }, assignments: { added: 0, removed: 0, reclassified: 0 }, execution: { addedNodeKeys: [], removedNodeKeys: [] } } },
      })
    }
    if (path.endsWith('/promotion')) throw new Error('A zero-change preview must not be committed')
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  await screen.findByLabelText('Query class')
  fireEvent.change(screen.getByLabelText('Query class'), { target: { value: 'branded' } })
  fireEvent.click(screen.getByLabelText(/Sample Group/))
  fireEvent.click(screen.getByRole('button', { name: 'Preview assignment' }))

  const confirm = await screen.findByRole('button', { name: 'Confirm tracking' }) as HTMLButtonElement
  expect(screen.getByText('0 added, 1 already tracked')).toBeTruthy()
  expect(screen.getByText('Already tracked; no change to confirm.')).toBeTruthy()
  expect(confirm.disabled).toBe(true)
  fireEvent.click(confirm)
  expect(calls.filter(call => call.path.endsWith('/promotion'))).toHaveLength(0)
})

test('keeps promotion state isolated to the selected completed saved test query', async () => {
  const calls: Array<{ path: string; body?: unknown; headers?: HeadersInit }> = []
  const completedRun = { ...run, totalQueries: 2, completedQueries: 2, failedQueries: 0 }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, headers: init?.headers })
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [completedRun] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...completedRun, queries: [completedQuery, secondCompletedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    const source = path.includes('query_done_second') ? secondCompletedQuery : completedQuery
    if (path.endsWith('/promotion-preview')) {
      return jsonResponse({
        mode: 'simple', previewChecksum: `preview-${source.id}`,
        source: { runId: 'run_saved', queryId: source.id, query: source.query, normalizedQuery: source.query.toLowerCase(), status: 'completed', completedAt: source.finishedAt },
        trackedQuery: { state: 'new', id: `tracked-${source.id}`, proposedId: `tracked-${source.id}`, query: source.query, normalizedQuery: source.query.toLowerCase() },
        setup: { state: 'simple', mode: 'simple', activeRevision: null, activeCompiledChecksum: null, draftEtag: null },
      })
    }
    if (path.endsWith('/promotion')) {
      return jsonResponse({
        status: 'tracked-awaiting-first-sweep', mode: 'simple', publishedRevision: null, compiledChecksum: null,
        source: { runId: 'run_saved', queryId: source.id, query: source.query, normalizedQuery: source.query.toLowerCase(), status: 'completed', completedAt: source.finishedAt },
        trackedQuery: { state: 'new', id: `tracked-${source.id}`, proposedId: `tracked-${source.id}`, query: source.query, normalizedQuery: source.query.toLowerCase() },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  fireEvent.click(await screen.findByRole('button', { name: 'Preview assignment' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm tracking' }))
  expect(await screen.findByText('Tracked, awaiting first sweep.')).toBeTruthy()
  const firstCommit = calls.find(call => call.path.endsWith('/queries/query_done/promotion'))
  expect(firstCommit).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: secondCompletedQuery.query }))
  expect(await screen.findByText(secondCompletedQuery.answerText)).toBeTruthy()
  expect(screen.queryByText('Tracked, awaiting first sweep.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm tracking' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Preview assignment' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm tracking' }))
  await waitFor(() => expect(calls.filter(call => call.path.endsWith('/promotion'))).toHaveLength(2))
  const secondCommit = calls.find(call => call.path.endsWith('/queries/query_done_second/promotion'))
  expect(secondCommit).toBeTruthy()
  expect(new Headers(secondCommit?.headers).get('Idempotency-Key')).not.toBe(new Headers(firstCommit?.headers).get('Idempotency-Key'))
})

test('waits for tracking setup before it permits a simple promotion preview', async () => {
  const calls: string[] = []
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return new Promise<Response>(() => {})
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const preview = await screen.findByRole('button', { name: 'Preview assignment' })
  expect((preview as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(preview)
  expect(calls.filter(path => path.endsWith('/promotion-preview'))).toHaveLength(0)
})

test('offers a local retry when tracking setup cannot be read', async () => {
  let setupRequests = 0
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') {
      setupRequests += 1
      return setupRequests === 1 ? jsonResponse({ error: { message: 'Setup is unavailable.' } }, 503) : jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    }
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  expect(await screen.findByText('Could not load tracking setup.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }))
  await waitFor(() => expect(setupRequests).toBe(2))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Preview assignment' }) as HTMLButtonElement).disabled).toBe(false))
})

test('offers a local retry when the required published Portfolio setup cannot be read', async () => {
  let planRequests = 0
  const activePlan = {
    active: {
      revision: 4, checksum: 'plan-checksum', compiledChecksum: 'compiled-checksum', createdAt: '2026-08-01T00:00:00.000Z',
      plan: {
        schemaVersion: 2,
        identities: { projectBrand: { canonicalHost: 'demo.example', ownedHosts: ['demo.example'], names: ['Demo'] } },
        targets: [{ stableKey: 'property-sample', label: 'Sample Property', aliases: [], urlMatchers: [], mentionNotApplicable: false, discoveryIdentity: null }],
        groups: [], querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [], compiledChecksum: 'compiled-checksum',
      },
    },
  }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', activeRevision: 4, activeSchemaVersion: 2, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') {
      planRequests += 1
      return planRequests === 1 ? jsonResponse({ error: { message: 'Plan is unavailable.' } }, 503) : jsonResponse(activePlan)
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  expect(await screen.findByText('Could not load the published Portfolio setup.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Preview assignment' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry Portfolio setup' }))
  await waitFor(() => expect(planRequests).toBe(2))
  expect(await screen.findByLabelText('Query class')).toBeTruthy()
})

test('uses the router base path for a refused Portfolio setup handoff', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/run_saved') return jsonResponse({ ...run, queries: [completedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'operational', nextAction: 'view_measurement', mode: 'active-v1', activeRevision: 2, activeSchemaVersion: 1, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path.endsWith('/promotion-preview')) {
      return jsonResponse({
        mode: 'refused',
        refusal: { reason: 'active-v1', message: 'Move this project to Portfolio setup before tracking this test query.' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: Outlet })
  const discoveryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectName/discovery',
    component: () => <ResearchQueriesSection projectName="demo" />,
  })
  const portfolioRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectName/portfolio',
    component: () => <p>Portfolio</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([discoveryRoute, portfolioRoute]),
    basepath: '/workspace',
    history: createMemoryHistory({ initialEntries: ['/workspace/projects/demo/discovery?queries=test&runId=run_saved&onboarding=site-health'] }),
  })
  await router.load()
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router as never} /></QueryClientProvider>)

  fireEvent.click(await screen.findByRole('button', { name: 'Preview assignment' }))
  const handoff = await screen.findByRole('link', { name: 'Open Portfolio setup' })
  expect(handoff.getAttribute('href')).toBe('/workspace/projects/demo/portfolio?runId=run_saved')
})
