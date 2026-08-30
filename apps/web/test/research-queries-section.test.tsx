import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

async function renderWorkspace(workspace: 'tracked' | 'discover' | 'test') {
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

function installApiMock() {
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname

    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo/measurement-setup') return jsonResponse({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null, activeSchemaVersion: null, draft: null })
    if (path === '/api/v1/projects/demo/measurement-plan') return jsonResponse({ active: null })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: null,
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

  await waitFor(() => expect(requests).toContainEqual({
    method: 'DELETE',
    body: { queries: [target.query] },
  }))
})

test('switches to research, deduplicates query lines, gates exact model choice, and states that research is not tracked', async () => {
  installApiMock()
  await renderWorkspace('test')

  expect(screen.getByRole('heading', { name: 'Queries' })).toBeTruthy()

  const model = await screen.findByLabelText(/Exact model/)
  expect((model as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('Saved to research history. Nothing is added to tracked queries.')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(/one query per line/i), { target: { value: 'Best AEO platform\nbest aeo platform\nHow do I measure AI citations?\n' } })
  expect(screen.getByText(/2 queries, duplicates and blank lines are removed/)).toBeTruthy()

  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByLabelText('API provider'), { target: { value: 'openai' } })
  expect((screen.getByLabelText(/Exact model/) as HTMLInputElement).disabled).toBe(false)
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

  const secondRunButton = screen.getAllByRole('button').find(button => button.closest('tr')?.textContent?.includes('gpt-5-b'))
  expect(secondRunButton).toBeTruthy()
  fireEvent.click(secondRunButton!)

  expect(await screen.findByText('Second run first query answer')).toBeTruthy()
})
