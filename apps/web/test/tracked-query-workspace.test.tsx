import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function simpleEditingFixture(options: {
  setupMode?: 'simple' | 'draft-only'
  nextSetupMode?: 'draft-only'
  activeRunOnSave?: boolean
  replaceFailure?: 'conflict' | 'lost-response'
} = {}) {
  const original = { id: 'query-original', query: 'Where can I find apartments in Metro Alder?', createdAt: '2026-08-28T10:00:00.000Z' }
  const sibling = { id: 'query-sibling', query: 'Which apartments have a pool?', createdAt: original.createdAt }
  let catalog = [original, sibling]
  let setupReads = 0
  let runReads = 0
  let setupUnavailable = false
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === '/api/v1/projects/demo/queries' && method === 'GET') return jsonResponse(catalog)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') return jsonResponse({
      setupMode: 'simple', activeRevision: null, latestOfficialFullRun: null, activePlanOrphans: [],
      queries: catalog.map(item => ({ queryId: item.id, status: 'not_in_plan', catalogState: 'current', currentQueryText: item.query,
        assignmentScope: { mode: 'simple', activePlanQueryText: null, queryTextMatchesPlan: null, assignedTargetCount: null,
          classState: 'unavailable', queryClasses: [], classCounts: [], groupCoverage: [] },
      })),
    })
    if (path === '/api/v1/projects/demo/measurement-setup') {
      setupReads += 1
      if (setupUnavailable) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Setup unavailable' } }, 500)
      const mode = setupReads > 1 && options.nextSetupMode ? options.nextSetupMode : options.setupMode ?? 'simple'
      return jsonResponse({ state: mode === 'simple' ? 'simple' : 'draft', nextAction: 'start_setup', mode, activeRevision: null, activeSchemaVersion: null, draft: mode === 'simple' ? null : { id: 'draft-new' } })
    }
    if (path === '/api/v1/projects/demo/runs') {
      runReads += 1
      return jsonResponse(options.activeRunOnSave && runReads > 1 ? [{ id: 'run-new', kind: 'answer-visibility', status: 'running' }] : [])
    }
    if (path === '/api/v1/projects/demo/queries/query-original/replace' && method === 'POST') {
      if (options.replaceFailure === 'conflict') return jsonResponse({ error: { code: 'QUERY_CHANGED', message: 'This query changed. Reload before editing.' } }, 409)
      const body = JSON.parse(String(init?.body))
      const replacement = { ...original, id: 'query-replacement', query: body.query }
      catalog = [replacement, sibling]
      if (options.replaceFailure === 'lost-response') throw new TypeError('Connection lost')
      return jsonResponse(replacement)
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restore)
  return { original, sibling, writes, failSetup: () => { setupUnavailable = true } }
}

test('edits one Simple query inline with an ID-targeted replacement and no sweep', async () => {
  const { original, sibling, writes } = simpleEditingFixture()
  await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  const editor = screen.getByRole('textbox', { name: 'Query text' })
  expect((screen.getByRole('button', { name: 'Save query' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Old answers keep the original wording.')).toBeTruthy()
  fireEvent.change(editor, { target: { value: 'Which apartments in Metro Alder allow pets?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query' }))
  await screen.findByText('Which apartments in Metro Alder allow pets?')
  expect(screen.getByText(sibling.query)).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Query text' })).toBeNull()
  expect(writes).toEqual([{ path: '/api/v1/projects/demo/queries/query-original/replace', method: 'POST', body: {
    expectedQuery: original.query, query: 'Which apartments in Metro Alder allow pets?',
  } }])
})

test.each([
  { nextSetupMode: 'draft-only' as const, message: /Setup changed/ },
  { activeRunOnSave: true, message: /Wait for the current sweep/ },
])('rechecks Simple setup and running sweeps before saving ($message)', async options => {
  const { original, writes } = simpleEditingFixture(options)
  await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: 'New question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query' }))
  expect(await screen.findByText(options.message)).toBeTruthy()
  expect(writes).toEqual([])
})

test('does not offer Simple editing while an Advanced draft exists', async () => {
  const { original, writes } = simpleEditingFixture({ setupMode: 'draft-only' })
  const client = await renderTracked()
  await screen.findByText(original.query)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.queryByRole('button', { name: `Edit ${original.query}` })).toBeNull()
  expect(writes).toEqual([])
})

test('keeps unsaved wording on a conflicting edit and does not retry the mutation', async () => {
  const { original, writes } = simpleEditingFixture({ replaceFailure: 'conflict' })
  await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: 'New question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query' }))
  expect(await screen.findByText('This query changed. Reload before editing.')).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Query text' }) as HTMLInputElement).value).toBe('New question')
  expect(writes).toHaveLength(1)
})

test('refreshes the catalog after a lost save response without resubmitting', async () => {
  const { original, writes } = simpleEditingFixture({ replaceFailure: 'lost-response' })
  await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: 'New question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query' }))
  await screen.findByText('New question')
  expect(screen.queryByRole('button', { name: 'Save query' })).toBeNull()
  expect(writes).toHaveLength(1)
})

test('does not expose query editing to a viewer', async () => {
  const { original, writes } = simpleEditingFixture()
  const client = await renderTracked('viewer')
  await screen.findByText(original.query)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
  expect(writes).toEqual([])
})

test('disables an open editor when cached setup cannot be revalidated', async () => {
  const { original, writes, failSetup } = simpleEditingFixture()
  const client = await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: 'New question' } })
  failSetup()
  await client.refetchQueries({ predicate: query => (query.queryKey[0] as { _id?: string })?._id === 'getApiV1ProjectsByNameMeasurementSetup' })
  await screen.findByText('Could not verify query editing.')
  expect((screen.getByRole('button', { name: 'Save query' }) as HTMLButtonElement).disabled).toBe(true)
  expect(writes).toEqual([])
})

test('coalesces double-submit while revalidating the current query setup', async () => {
  const { original, writes } = simpleEditingFixture()
  await renderTracked()
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${original.query}` }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query text' }), { target: { value: 'New question' } })
  const form = screen.getByRole('button', { name: 'Save query' }).closest('form')!
  fireEvent.submit(form)
  fireEvent.submit(form)
  await screen.findByText('Query saved.')
  expect(writes).toHaveLength(1)
})

test('bounds a large query table and filters by canonical Group and query type', async () => {
  const catalog = Array.from({ length: 121 }, (_, index) => ({ id: `q-${index}`, query: `Question ${index + 1} for a fictional Property`, createdAt: '2026-08-28T10:00:00.000Z' }))
  const restore = mockFetch(url => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(catalog)
    if (path === '/api/v1/projects/demo/runs') return jsonResponse([])
    if (path === '/api/v1/projects/demo/measurement-query-statuses') return jsonResponse({
      setupMode: 'active-v2', activeRevision: 1, latestOfficialFullRun: null, activePlanOrphans: [],
      queries: catalog.map((query, index) => {
        const group = index < 100 ? 'Alder' : 'Birch'
        const queryClass = index < 120 ? 'non-brand' : 'branded'
        return { queryId: query.id, currentQueryText: query.query, catalogState: 'current', status: 'awaiting_first_sweep',
          assignmentScope: { mode: 'advanced_assigned', activePlanQueryText: query.query, queryTextMatchesPlan: true,
            assignedTargetCount: 1, classState: queryClass, queryClasses: [queryClass], classCounts: [{ queryClass, assignedTargetCount: 1 }],
            groupCoverage: [{ groupKey: group, label: group, memberCount: 10, assignedMemberCount: 1, coverage: 'partial', classCounts: [{ queryClass, assignedTargetCount: 1 }] }],
          },
        }
      }),
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  await renderTracked()
  await screen.findByText(catalog[0]!.query)
  expect(screen.getAllByRole('row')).toHaveLength(51)
  expect(screen.getByText('50 of 121 queries')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show more queries' }))
  expect(screen.getAllByRole('row')).toHaveLength(101)
  fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Birch' } })
  expect(screen.getAllByRole('row')).toHaveLength(22)
  expect(screen.queryByText(catalog[0]!.query)).toBeNull()
  fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'branded' } })
  expect(screen.getAllByRole('row')).toHaveLength(2)
  expect(screen.getByText(catalog[120]!.query)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Show more queries' })).toBeNull()
})

async function renderTracked(role?: 'admin' | 'viewer') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <AccountProvider account={role ? { name: 'Demo operator', role } : null}><DiscoverySection projectName="demo" workspace="tracked" /></AccountProvider>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router as never} /></QueryClientProvider>)
  return queryClient
}

async function renderProjectTracked(initialEntry = '/projects/demo/discovery?runId=drawer-run') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: Outlet })
  const discoveryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectName/discovery',
    component: () => <DiscoverySection projectName="demo" workspace="tracked" />,
  })
  const portfolioRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectName/portfolio',
    component: () => <p>Portfolio setup</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([discoveryRoute, portfolioRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  await router.load()
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router as never} /></QueryClientProvider>)
}

test('requires an inline confirmation that names the tracked query before removal', async () => {
  const queries = Array.from({ length: 3 }, (_, index) => ({
    id: `query-${index + 1}`,
    query: `Which fictional signal is number ${index + 1}?`,
    createdAt: '2026-08-28T10:00:00.000Z',
  }))
  const target = queries[1]!
  const requests: Array<{ method: string; body?: unknown }> = []
  let currentQueries = queries
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/api/v1/projects/demo/queries' && method === 'GET') return jsonResponse(currentQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      return jsonResponse({
        setupMode: 'simple', activeRevision: null, latestOfficialFullRun: null,
        activePlanOrphans: [],
        queries: currentQueries.map(query => ({
          queryId: query.id,
          status: 'not_in_plan',
          catalogState: 'current',
          currentQueryText: query.query,
          assignmentScope: {
            mode: 'simple',
            activePlanQueryText: null,
            queryTextMatchesPlan: null,
            assignedTargetCount: null,
            classState: 'unavailable',
            queryClasses: [],
            classCounts: [],
            groupCoverage: [],
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

  await renderTracked()
  await screen.findByRole('button', { name: `Remove ${target.query}` })
  expect(screen.getAllByLabelText('Measurement status: Tracked')).toHaveLength(queries.length)
  expect(screen.queryByLabelText('Measurement status')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: `Remove ${target.query}` }))
  expect(requests).toEqual([])
  expect(screen.getByText(`Remove “${target.query}”?`)).toBeTruthy()
  expect(screen.getByText(/Saved results remain available/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: `Confirm removal of ${target.query}` }))
  await waitFor(() => expect(requests).toContainEqual({
    method: 'DELETE',
    body: { queries: [target.query] },
  }))
})

test('uses server assignment scope to keep advanced and legacy plan rows out of generic deletion', async () => {
  const currentQueries = [
    { id: 'query-assigned', query: 'Catalog text before rename', createdAt: '2026-08-28T10:00:00.000Z' },
    { id: 'query-unassigned', query: 'Unassigned catalog query', createdAt: '2026-08-28T10:00:00.000Z' },
    { id: 'query-legacy', query: 'Legacy plan query', createdAt: '2026-08-28T10:00:00.000Z' },
  ]
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(currentQueries)
    if (path === '/api/v1/projects/demo/runs') return jsonResponse([])
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      return jsonResponse({
        setupMode: 'active-v2', activeRevision: 8, latestOfficialFullRun: null,
        queries: [
          {
            queryId: 'query-assigned', status: 'awaiting_first_sweep', catalogState: 'current', currentQueryText: 'Current renamed query',
            assignmentScope: {
              mode: 'advanced_assigned', activePlanQueryText: 'Frozen plan query', queryTextMatchesPlan: false,
              assignedTargetCount: 2, classState: 'mixed', queryClasses: ['branded', 'non-brand'],
              classCounts: [{ queryClass: 'branded', assignedTargetCount: 1 }, { queryClass: 'non-brand', assignedTargetCount: 1 }],
              groupCoverage: [{ groupKey: 'metro', label: 'Metro', memberCount: 3, assignedMemberCount: 2, coverage: 'partial', classCounts: [{ queryClass: 'branded', assignedTargetCount: 1 }]}],
            },
          },
          {
            queryId: 'query-unassigned', status: 'not_in_plan', catalogState: 'current', currentQueryText: 'Unassigned catalog query',
            assignmentScope: { mode: 'advanced_unassigned', activePlanQueryText: null, queryTextMatchesPlan: null, assignedTargetCount: 0, classState: 'none', queryClasses: [], classCounts: [], groupCoverage: [] },
          },
          {
            queryId: 'query-legacy', status: 'not_in_plan', catalogState: 'current', currentQueryText: 'Legacy plan query',
            assignmentScope: { mode: 'legacy', activePlanQueryText: null, queryTextMatchesPlan: null, assignedTargetCount: null, classState: 'unavailable', queryClasses: [], classCounts: [], groupCoverage: [] },
          },
        ],
        activePlanOrphans: [{
          queryId: 'query-orphan', status: 'partial', catalogState: 'missing', currentQueryText: null,
          assignmentScope: {
            mode: 'advanced_assigned', activePlanQueryText: 'Removed saved query', queryTextMatchesPlan: null,
            assignedTargetCount: 1, classState: 'branded', queryClasses: ['branded'], classCounts: [{ queryClass: 'branded', assignedTargetCount: 1 }], groupCoverage: [],
          },
        }],
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderProjectTracked()
  const assignedText = await screen.findByText('Current renamed query')
  expect(screen.getByText('Active plan text: Frozen plan query')).toBeTruthy()
  expect(screen.getByText('2 Properties assigned')).toBeTruthy()
  expect(screen.getByText('Mixed')).toBeTruthy()
  expect(screen.queryByText('branded · non-brand queries')).toBeNull()
  expect(screen.getByText('Missing saved query')).toBeTruthy()
  expect(screen.getByText('Removed saved query')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove Current renamed query' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove Legacy plan query' })).toBeNull()

  const assignedLink = within(assignedText.closest('tr')!).getByRole('link', { name: 'Edit query' })
  expect(assignedLink.getAttribute('href')).toBe('/projects/demo/portfolio?runId=drawer-run&measurementStep=queries&measurementQueryId=query-assigned')
  const unassignedRow = screen.getByText('Unassigned catalog query').closest('tr')!
  expect(within(unassignedRow).getByRole('link', { name: 'Assign Properties' }).getAttribute('href'))
    .toBe('/projects/demo/portfolio?runId=drawer-run&measurementStep=queries&measurementQueryId=query-unassigned')
  const orphanRow = screen.getByText('Missing saved query').closest('tr')!
  expect(within(orphanRow).getByRole('link', { name: 'Edit assignments' })).toBeTruthy()
  const legacyRow = screen.getByText('Legacy plan query').closest('tr')!
  expect(within(legacyRow).getByText('Legacy setup')).toBeTruthy()
  expect(within(legacyRow).getByText('Status unavailable')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Remove Unassigned catalog query' }))
  expect(screen.getByText('Remove “Unassigned catalog query” from the tracked query catalog?')).toBeTruthy()
  expect(screen.getByText(/not assigned to the active plan/)).toBeTruthy()
})

test('fails closed when a current query has no server assignment metadata', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse([{ id: 'query-unknown', query: 'Unknown assignment state', createdAt: '2026-08-28T10:00:00.000Z' }])
    if (path === '/api/v1/projects/demo/runs') return jsonResponse([])
    if (path === '/api/v1/projects/demo/measurement-query-statuses') return jsonResponse({
      setupMode: 'active-v2', activeRevision: 8, latestOfficialFullRun: null, activePlanOrphans: [],
      queries: [{ queryId: 'query-unknown', status: 'not_in_plan', catalogState: 'current', currentQueryText: 'Unknown assignment state' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()
  expect(await screen.findByText('Assignment state unavailable')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove Unknown assignment state' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Edit assignments' })).toBeNull()
})

test('rechecks the server assignment scope before deleting a catalog query', async () => {
  const currentQuery = { id: 'query-rechecked', query: 'May change assignment', createdAt: '2026-08-28T10:00:00.000Z' }
  let statusRequests = 0
  let deleteRequests = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/queries' && method === 'GET') return jsonResponse([currentQuery])
    if (path === '/api/v1/projects/demo/runs') return jsonResponse([])
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      const assignmentScope = statusRequests === 1
        ? {
            mode: 'advanced_unassigned', activePlanQueryText: null, queryTextMatchesPlan: null,
            assignedTargetCount: 0, classState: 'none', queryClasses: [], classCounts: [], groupCoverage: [],
          }
        : {
            mode: 'advanced_assigned', activePlanQueryText: currentQuery.query, queryTextMatchesPlan: true,
            assignedTargetCount: 1, classState: 'branded', queryClasses: ['branded'],
            classCounts: [{ queryClass: 'branded', assignedTargetCount: 1 }], groupCoverage: [],
          }
      return jsonResponse({
        setupMode: 'active-v2', activeRevision: 8, latestOfficialFullRun: null, activePlanOrphans: [],
        queries: [{
          queryId: currentQuery.id, status: 'not_in_plan', catalogState: 'current', currentQueryText: currentQuery.query,
          assignmentScope,
        }],
      })
    }
    if (path === '/api/v1/projects/demo/queries' && method === 'DELETE') {
      deleteRequests += 1
      return jsonResponse([])
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderProjectTracked()
  await screen.findByRole('button', { name: `Remove ${currentQuery.query}` })
  fireEvent.click(screen.getByRole('button', { name: `Remove ${currentQuery.query}` }))
  fireEvent.click(screen.getByRole('button', { name: `Confirm removal of ${currentQuery.query}` }))

  await waitFor(() => expect(statusRequests).toBe(2))
  expect(deleteRequests).toBe(0)
  expect(screen.getByText('The query assignment changed. Review its current state before removing the catalog query.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Edit query' })).toBeTruthy()
})

test('does not save a query when the current assignment metadata cannot be verified', async () => {
  const currentQuery = { id: 'query-add-guard', query: 'Existing query', createdAt: '2026-08-28T10:00:00.000Z' }
  let statusRequests = 0
  let addRequests = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/queries' && method === 'GET') return jsonResponse([currentQuery])
    if (path === '/api/v1/projects/demo/runs') return jsonResponse([])
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      return jsonResponse({
        setupMode: 'active-v2', activeRevision: 8, latestOfficialFullRun: null, activePlanOrphans: [],
        queries: [{
          queryId: currentQuery.id, status: 'not_in_plan', catalogState: 'current', currentQueryText: currentQuery.query,
          assignmentScope: statusRequests === 1
            ? {
                mode: 'advanced_unassigned', activePlanQueryText: null, queryTextMatchesPlan: null,
                assignedTargetCount: 0, classState: 'none', queryClasses: [], classCounts: [], groupCoverage: [],
              }
            : undefined,
        }],
      })
    }
    if (path === '/api/v1/projects/demo/queries' && method === 'POST') {
      addRequests += 1
      return jsonResponse([])
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()
  await screen.findByRole('button', { name: 'Save queries' })
  fireEvent.click(screen.getByRole('button', { name: 'Save queries' }))
  fireEvent.change(screen.getByLabelText('Queries to add'), { target: { value: 'New catalog query' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Save queries' }).at(-1)!)

  await waitFor(() => expect(statusRequests).toBe(2))
  expect(addRequests).toBe(0)
  expect(screen.getByText('Could not verify the current assignment state. Retry before changing queries.')).toBeTruthy()
})
