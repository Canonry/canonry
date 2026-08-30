import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

async function renderWorkspace(workspace: 'tracked' | 'discover' | 'test', role: 'admin' | 'viewer' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <DiscoverySection projectName="demo" workspace={workspace} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: 'demo-user', role } : null}>
        <RouterProvider router={router as never} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

function installApiMock(
  onRequest?: (path: string, method: string) => void,
  onResearchPost?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>,
) {
  let researchPostAttempt = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    onRequest?.(path, method)

    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') {
      if (method === 'POST' && onResearchPost) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        return onResearchPost(body, ++researchPostAttempt)
      }
      return jsonResponse({ runs: [] })
    }
    if (path.startsWith('/api/v1/projects/demo/research/runs/')) return jsonResponse({ ...queuedResearchRun(path.split('/').at(-1)!, 1), queries: [] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York',
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
        providerCatalog: [{
          name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini',
          knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', tier: 'fast' }],
          modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.',
        }],
        google: { configured: false }, bing: { configured: false },
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
}

function queuedResearchRun(id: string, totalQueries: number) {
  return {
    id, projectId: 'project_demo', status: 'queued', provider: 'openai', requestedModel: 'gpt-5-mini', resolvedModel: 'gpt-5-mini',
    location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, totalQueries,
    completedQueries: 0, failedQueries: 0, error: null, startedAt: null, finishedAt: null, createdAt: '2026-08-29T10:00:00.000Z',
  }
}

function installScopeRefetchMock() {
  const mutations: string[] = []
  let settingsUnavailable = false
  let projectUnavailable = false
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') mutations.push(path)
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') {
      if (projectUnavailable) return jsonResponse({ error: { message: 'Locations unavailable.' } }, 503)
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York',
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') {
      if (settingsUnavailable) return jsonResponse({ error: { message: 'Providers unavailable.' } }, 503)
      return jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
        providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' }],
        google: { configured: false }, bing: { configured: false },
      })
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)
  return {
    mutations,
    failSettings: () => { settingsUnavailable = true },
    failProject: () => { projectUnavailable = true },
  }
}

function installCompletedResearchMock() {
  const mutations: string[] = []
  const savedRun = {
    id: 'run-saved', projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: null,
    resolvedModel: 'gpt-5-mini', location: null, totalQueries: 1, completedQueries: 1, failedQueries: 0,
    error: null, startedAt: '2026-08-29T10:00:00.000Z', finishedAt: '2026-08-29T10:01:00.000Z', createdAt: '2026-08-29T10:00:00.000Z',
  }
  const savedQuery = {
    id: 'query-saved', position: 0, query: 'Which fictional option best fits a small team?', status: 'completed', requestedModel: null,
    resolvedModel: 'gpt-5-mini', servedModel: 'gpt-5-mini', answerText: 'Saved fictional test evidence.', groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
    answerMentioned: false, citationState: 'not-cited', error: null, startedAt: '2026-08-29T10:00:00.000Z', finishedAt: '2026-08-29T10:00:01.000Z', createdAt: '2026-08-29T10:00:00.000Z',
  }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      mutations.push(path)
      return jsonResponse({ error: { message: 'Mutation should not be reachable.' } }, 403)
    }
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [savedRun] })
    if (path === '/api/v1/projects/demo/research/runs/run-saved') return jsonResponse({ ...savedRun, queries: [savedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
      locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York',
      autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({
      providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
      providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' }],
      google: { configured: false }, bing: { configured: false },
    })
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)
  return { mutations }
}

test('gives every tracked-query removal a precise accessible name', async () => {
  const queries = Array.from({ length: 40 }, (_, index) => ({
    id: `query-${index + 1}`,
    query: `Which fictional signal is number ${index + 1}?`,
    createdAt: '2026-08-28T10:00:00.000Z',
  }))
  const target = queries[34]!
  const requests: Array<{ method: string; body?: unknown }> = []
  let currentQueries = queries
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/api/v1/projects/demo/queries' && method === 'GET') return jsonResponse(currentQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      return jsonResponse({
        setupMode: 'simple', activeRevision: null, latestOfficialFullRun: null, activePlanOrphans: [],
        queries: currentQueries.map(query => ({
          queryId: query.id,
          status: 'not_in_plan',
          catalogState: 'current',
          currentQueryText: query.query,
          assignmentScope: {
            mode: 'simple', activePlanQueryText: null, queryTextMatchesPlan: null,
            assignedTargetCount: null, classState: 'unavailable', queryClasses: [], classCounts: [], groupCoverage: [],
          },
        })),
      })
    }
    if (path === '/api/v1/projects/demo/queries' && method === 'DELETE') {
      requests.push({ method, body })
      currentQueries = currentQueries.filter(query => query.id !== target.id)
      return jsonResponse(currentQueries)
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('tracked')

  for (const query of queries) {
    expect(await screen.findByRole('button', { name: `Remove ${query.query}` })).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: `Remove ${target.query}` }))
  expect(requests).toEqual([])
  expect(screen.getByText(`Remove “${target.query}”?`)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: `Confirm removal of ${target.query}` }))

  await waitFor(() => expect(requests).toContainEqual({
    method: 'DELETE',
    body: { queries: [target.query] },
  }))
})

test('renders a compact Test workspace with explicit scope before a run', async () => {
  installApiMock()
  await renderWorkspace('test')

  expect(screen.getByRole('heading', { name: 'Test queries' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Queries' })).toBeNull()
  expect(screen.queryByText('New batch')).toBeNull()
  expect(screen.queryByText('Research queries')).toBeNull()
  expect(screen.queryByText('Saved research batches')).toBeNull()
  expect(screen.getByText('Excluded from Pulse and trends')).toBeTruthy()

  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  expect((screen.getByLabelText('Location') as HTMLSelectElement).value).toBe('New York')
  expect(screen.getByText('OpenAI · gpt-5-mini · New York')).toBeTruthy()
  expect(screen.getByText('Enter a query.')).toBeTruthy()
  expect(screen.getByText('Max 50 queries')).toBeTruthy()
  expect(screen.getByText('Model override').closest('details')?.open).toBe(false)

  const history = screen.getByText('Test history (0)').closest('details')
  expect(history?.open).toBe(false)
  expect(screen.getByRole('heading', { name: 'Results' }).compareDocumentPosition(history!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText('No test results yet.')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(/one query per line/i), { target: { value: 'Best AEO platform\nbest aeo platform\nHow do I measure AI citations?\n' } })
  expect(screen.getByText('2 provider calls')).toBeTruthy()

  fireEvent.click(screen.getByText('Advanced'))
  const model = screen.getByRole('combobox', { name: 'Model override' }) as HTMLInputElement
  expect(model.disabled).toBe(false)
})

test('submits the resolved provider and location explicitly after a writer runs a bounded test', async () => {
  const requests: Array<{ method: string; body?: unknown }> = []
  const createdRun = {
    id: 'run-new', projectId: 'project_demo', status: 'queued', provider: 'openai', requestedModel: null,
    resolvedModel: 'gpt-4.1', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, totalQueries: 2,
    completedQueries: 0, failedQueries: 0, error: null, startedAt: null, finishedAt: null, createdAt: '2026-08-29T10:00:00.000Z',
  }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') {
      if (method === 'POST') {
        requests.push({ method, body })
        return jsonResponse({ ...createdRun, queries: [] }, 202)
      }
      return jsonResponse({ runs: [] })
    }
    if (path === '/api/v1/projects/demo/research/runs/run-new') return jsonResponse({ ...createdRun, queries: [] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: { openai: 'gpt-4.1' },
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York',
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
        providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' }],
        google: { configured: false }, bing: { configured: false },
      })
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('test')
  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  expect(screen.getByText('OpenAI · gpt-4.1 · New York')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'First bounded query\nSecond bounded query' } })
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Run 2 queries' }))

  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({
    method: 'POST',
    body: {
      queries: ['First bounded query', 'Second bounded query'],
      provider: 'openai',
      model: 'gpt-4.1',
      location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
    },
  })
  expect((requests[0]?.body as { idempotencyKey?: unknown }).idempotencyKey).toEqual(expect.any(String))
})

test('uses a non-configurable provider default without submitting a model override', async () => {
  const requests: Array<{ method: string; body?: unknown }> = []
  const createdRun = {
    id: 'run-fixed-model', projectId: 'project_demo', status: 'queued', provider: 'fixed', requestedModel: null,
    resolvedModel: 'fixed-project-model', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, totalQueries: 1,
    completedQueries: 0, failedQueries: 0, error: null, startedAt: null, finishedAt: null, createdAt: '2026-08-29T10:00:00.000Z',
  }
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') {
      if (method === 'POST') {
        requests.push({ method, body })
        return jsonResponse({ ...createdRun, queries: [] }, 202)
      }
      return jsonResponse({ runs: [] })
    }
    if (path === '/api/v1/projects/demo/research/runs/run-fixed-model') return jsonResponse({ ...createdRun, queries: [] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['fixed'], providerModels: { fixed: 'fixed-project-model' },
      locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York',
      autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({
      providers: [{ name: 'fixed', displayName: 'Fixed provider', configured: true, defaultModel: 'fixed-catalog-model' }],
      providerCatalog: [{ name: 'fixed', displayName: 'Fixed provider', mode: 'api', modelConfigurable: false, defaultModel: 'fixed-catalog-model', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'The model is fixed.' }],
      google: { configured: false }, bing: { configured: false },
    })
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('test')
  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('fixed'))
  expect(screen.getByText('Fixed provider · fixed-project-model · New York')).toBeTruthy()
  fireEvent.click(screen.getByText('Advanced'))
  expect((screen.getByRole('combobox', { name: 'Model override' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A bounded fixed-provider query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))

  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({
    method: 'POST',
    body: {
      queries: ['A bounded fixed-provider query'],
      provider: 'fixed',
      location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
    },
  })
  const postedBody = requests[0]?.body as { idempotencyKey?: unknown; model?: unknown }
  expect(postedBody.idempotencyKey).toEqual(expect.any(String))
  expect(postedBody.model).toBeUndefined()
})

test('reuses the same research idempotency key after a lost response', async () => {
  const requests: Array<Record<string, unknown>> = []
  installApiMock(undefined, (body, attempt) => {
    requests.push(body)
    if (attempt === 1) return Promise.reject(new Error('Connection lost after dispatch.'))
    return jsonResponse({ ...queuedResearchRun('run-retry', 1), queries: [] }, 202)
  })
  await renderWorkspace('test')

  await screen.findByLabelText('Provider')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A retry-safe fictional query' } })
  const run = screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement
  fireEvent.click(run)
  await waitFor(() => expect(requests).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement).disabled).toBe(false))

  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0]?.idempotencyKey).toEqual(expect.any(String))
  expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey)
})

test('uses a different research idempotency key after a material draft edit', async () => {
  const requests: Array<Record<string, unknown>> = []
  installApiMock(undefined, (body) => {
    requests.push(body)
    return Promise.reject(new Error('Connection lost after dispatch.'))
  })
  await renderWorkspace('test')

  await screen.findByLabelText('Provider')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'First fictional query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement).disabled).toBe(false))

  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'Changed fictional query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]?.idempotencyKey).toEqual(expect.any(String))
  expect(requests[1]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey)
})

test('starts a deliberate new research run with a new idempotency key after success', async () => {
  const requests: Array<Record<string, unknown>> = []
  let completedRuns = 0
  installApiMock(undefined, (body) => {
    requests.push(body)
    completedRuns += 1
    return jsonResponse({ ...queuedResearchRun(`run-success-${completedRuns}`, 1), queries: [] }, 202)
  })
  await renderWorkspace('test')

  await screen.findByLabelText('Provider')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A deliberate fictional query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  await waitFor(() => expect((screen.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(''))

  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A deliberate fictional query' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 query' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0]?.idempotencyKey).toEqual(expect.any(String))
  expect(requests[1]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey)
})

test('does not submit a duplicate research request while the first request is pending', async () => {
  const requests: Array<Record<string, unknown>> = []
  let resolvePost: ((response: Response) => void) | undefined
  installApiMock(undefined, (body) => {
    requests.push(body)
    return new Promise<Response>((resolve) => { resolvePost = resolve })
  })
  await renderWorkspace('test')

  await screen.findByLabelText('Provider')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A pending fictional query' } })
  const run = screen.getByRole('button', { name: 'Run 1 query' })
  fireEvent.click(run)
  fireEvent.click(run)
  await waitFor(() => expect(requests).toHaveLength(1))
  expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true)

  resolvePost?.(jsonResponse({ ...queuedResearchRun('run-pending', 1), queries: [] }, 202))
  await waitFor(() => expect((screen.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(''))
})

test('rejects an over-limit batch without silently trimming it or starting a provider call', async () => {
  const mutationPaths: string[] = []
  installApiMock((path, method) => {
    if (method !== 'GET') mutationPaths.push(path)
  })
  await renderWorkspace('test')

  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  const overLimitQueries = Array.from({ length: 51 }, (_, index) => `Fictional test query ${index + 1}`).join('\n')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: overLimitQueries } })

  expect(screen.getByText('51 queries exceed the 50-query limit.')).toBeTruthy()
  const run = screen.getByRole('button', { name: 'Run 51 queries' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  expect(mutationPaths).toEqual([])
})

test('does not let a viewer start a test even if the form has a resolved scope', async () => {
  const mutationPaths: string[] = []
  installApiMock((path, method) => {
    if (method !== 'GET') mutationPaths.push(path)
  })
  await renderWorkspace('test', 'viewer')

  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional viewer test query' } })
  const run = screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  expect(mutationPaths).toEqual([])
})

test('hides the test-run action in a read-only embed', async () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true, views: ['project'] } }
  const mutationPaths: string[] = []
  installApiMock((path, method) => {
    if (method !== 'GET') mutationPaths.push(path)
  })
  await renderWorkspace('test')

  await screen.findByLabelText('Provider')
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional embed test query' } })
  expect(screen.queryByRole('button', { name: 'Run 1 query' })).toBeNull()
  expect(mutationPaths).toEqual([])
})

test('fails closed when cached provider data cannot be refreshed', async () => {
  const api = installScopeRefetchMock()
  const { queryClient } = await renderWorkspace('test')

  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional cached-provider query' } })
  expect((screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement).disabled).toBe(false)

  api.failSettings()
  await queryClient.refetchQueries()
  expect(await screen.findByText('Could not load API providers.')).toBeTruthy()
  const run = screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  expect(api.mutations).toEqual([])
})

test('fails closed when cached project locations cannot be refreshed', async () => {
  const api = installScopeRefetchMock()
  const { queryClient } = await renderWorkspace('test')

  const provider = await screen.findByLabelText('Provider') as HTMLSelectElement
  await waitFor(() => expect(provider.value).toBe('openai'))
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional cached-location query' } })
  expect((screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement).disabled).toBe(false)

  api.failProject()
  await queryClient.refetchQueries()
  expect(await screen.findByText('Could not load project locations.')).toBeTruthy()
  const run = screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  expect(api.mutations).toEqual([])
})

test('keeps viewer Test and promotion mutations unreachable even when a saved result is present', async () => {
  const api = installCompletedResearchMock()
  await renderWorkspace('test', 'viewer')

  expect(await screen.findByText('Saved fictional test evidence.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Track query' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Preview assignment' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional viewer query' } })
  const run = screen.getByRole('button', { name: 'Run 1 query' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  expect(api.mutations).toEqual([])
})

test('keeps embedded Test and promotion mutations unreachable even when a saved result is present', async () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true, views: ['project'] } }
  const api = installCompletedResearchMock()
  await renderWorkspace('test')

  expect(await screen.findByText('Saved fictional test evidence.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Track query' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Preview assignment' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'A fictional embed query' } })
  expect(screen.queryByRole('button', { name: 'Run 1 query' })).toBeNull()
  expect(api.mutations).toEqual([])
})

test('uses a saved query without spending and keeps saved provider, model, and location context', async () => {
  const savedRun = {
    id: 'run-saved', projectId: 'project_demo', status: 'completed', provider: 'gemini', requestedModel: null,
    resolvedModel: 'gemini-2.5-flash', location: { label: 'Harbor', city: 'Harbor', region: 'MI', country: 'US' }, totalQueries: 1,
    completedQueries: 1, failedQueries: 0, error: null, startedAt: '2026-08-28T10:00:00.000Z', finishedAt: '2026-08-28T10:01:00.000Z', createdAt: '2026-08-28T10:00:00.000Z',
  }
  const savedQuery = {
    id: 'saved-query', position: 0, query: 'Which fictional buildings allow pets?', status: 'completed', requestedModel: null,
    resolvedModel: 'gemini-2.5-flash', servedModel: 'gemini-2.5-flash', answerText: 'Saved answer evidence.', groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
    answerMentioned: false, citationState: 'not-cited', error: null, startedAt: '2026-08-28T10:00:00.000Z', finishedAt: '2026-08-28T10:00:01.000Z', createdAt: '2026-08-28T10:00:00.000Z',
  }
  const mutations: string[] = []
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if ((init?.method ?? 'GET') !== 'GET') mutations.push(path)
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [savedRun] })
    if (path === '/api/v1/projects/demo/research/runs/run-saved') return jsonResponse({ ...savedRun, queries: [savedQuery] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai', 'gemini'], providerModels: {},
      locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York', autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({
      providers: [
        { name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' },
        { name: 'gemini', displayName: 'Gemini', configured: true, defaultModel: 'gemini-2.5-flash' },
      ],
      providerCatalog: [
        { name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' },
        { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use a Gemini model ID.' },
      ],
      google: { configured: false }, bing: { configured: false },
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('test')
  expect(await screen.findByText('Saved answer evidence.')).toBeTruthy()
  expect(screen.getByText('Gemini · gemini-2.5-flash · Harbor')).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Brand mentioned' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Site cited' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Queries'), { target: { value: 'Unsent draft query' } })
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
  expect(screen.getByText('Gemini · gemini-2.5-flash · Harbor')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Use query' }))
  expect((screen.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(savedQuery.query)
  expect(screen.getByText('Saved answer evidence.')).toBeTruthy()
  expect(mutations).toEqual([])
})

test('renders research history and saved-result failures as failures, not empty states', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ error: { message: 'History unavailable.' } }, 503)
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {}, locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('test')
  expect(await screen.findByText('Could not load test history.')).toBeTruthy()
  expect(screen.queryByText('No test history yet.')).toBeNull()
  expect(screen.queryByText('Test history (0)')).toBeNull()
  expect(screen.queryByText('Choose a test batch')).toBeNull()
})

test('renders a selected saved-result failure without substituting an empty result', async () => {
  const failedRun = {
    id: 'run-failed-detail', projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: null, resolvedModel: 'gpt-5-mini', location: null, totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null, startedAt: null, finishedAt: null, createdAt: '2026-08-28T10:00:00.000Z',
  }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [failedRun] })
    if (path === '/api/v1/projects/demo/research/runs/run-failed-detail') return jsonResponse({ error: { message: 'Result unavailable.' } }, 503)
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {}, locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderWorkspace('test')
  expect(await screen.findByText('Could not load saved test results.')).toBeTruthy()
  expect(screen.queryByText('Choose a test batch')).toBeNull()
})

test('resets the selected query when switching research history batches', async () => {
  const run = (id: string, model: string) => ({
    id, projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: model, resolvedModel: model,
    location: null, totalQueries: 2, completedQueries: 2, failedQueries: 0, error: null,
    startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:01:00.000Z', createdAt: id === 'run-a' ? '2026-07-23T10:00:00.000Z' : '2026-07-22T10:00:00.000Z',
  })
  const query = (id: string, text: string) => ({
    id, position: 0, query: text, status: 'completed', requestedModel: null, resolvedModel: 'gpt-5-a', servedModel: 'gpt-5-a',
    answerText: `${text} answer`, groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: ['Rival'], citedCompetitorDomains: ['rival.example'], answerMentioned: false,
    citationState: 'not-cited', error: null, startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:00:01.000Z', createdAt: '2026-07-23T10:00:00.000Z',
  })
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run('run-a', 'gpt-5-a'), run('run-b', 'gpt-5-b')] })
    if (path === '/api/v1/projects/demo/research/runs/run-a') return jsonResponse({ ...run('run-a', 'gpt-5-a'), queries: [query('query-a-first', 'First run first query'), query('query-shared', 'First run selected query')] })
    // Reusing the selected id makes this assert the state reset itself, rather than merely relying on the display fallback.
    if (path === '/api/v1/projects/demo/research/runs/run-b') return jsonResponse({ ...run('run-b', 'gpt-5-b'), queries: [query('query-b-first', 'Second run first query'), query('query-shared', 'Second run stale query')] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  await renderWorkspace('test')

  await screen.findByText('First run first query answer')
  expect(screen.getByText('Named in answer')).toBeTruthy()
  expect(screen.getByText('Rival')).toBeTruthy()
  expect(screen.getByText('Cited competitor domains')).toBeTruthy()
  expect(screen.getByText('rival.example')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'First run selected query' }))
  expect(await screen.findByText('First run selected query answer')).toBeTruthy()

  fireEvent.click(screen.getByText('Test history (2)'))
  expect(screen.getByText('Test history (2)').closest('details')?.open).toBe(true)
  const secondRunButton = screen.getAllByRole('button').find(button => button.closest('tr')?.textContent?.includes('gpt-5-b'))
  expect(secondRunButton).toBeTruthy()
  fireEvent.click(secondRunButton!)

  expect(await screen.findByText('Second run first query answer')).toBeTruthy()
})
