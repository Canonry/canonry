import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import {
  getApiV1ProjectsByNameMeasurementQueryStatusesQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const trackedQueries = [
  { id: 'query-not-in-plan', query: 'What is a demo signal?', createdAt: '2026-08-28T10:00:00.000Z' },
  { id: 'query-awaiting', query: 'How does a demo sweep work?', createdAt: '2026-08-28T10:00:00.000Z' },
  { id: 'query-partial', query: 'Where is the demo evidence?', createdAt: '2026-08-28T10:00:00.000Z' },
  { id: 'query-measured', query: 'Which demo result is measured?', createdAt: '2026-08-28T10:00:00.000Z' },
]

const statuses = {
  setupMode: 'active-v2' as const,
  activeRevision: 7,
  latestOfficialFullRun: {
    id: 'run_demo_complete', status: 'completed' as const,
    createdAt: '2026-08-28T10:00:00.000Z', finishedAt: '2026-08-28T10:01:00.000Z',
  },
  queries: [
    { queryId: 'query-not-in-plan', status: 'not_in_plan' as const },
    { queryId: 'query-awaiting', status: 'awaiting_first_sweep' as const },
    { queryId: 'query-partial', status: 'partial' as const },
    { queryId: 'query-measured', status: 'measured' as const },
  ],
}

async function renderTracked(role: 'admin' | 'viewer' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <DiscoverySection projectName="demo" workspace="tracked" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const page = render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: 'demo-viewer', role } : null}>
        <RouterProvider router={router as never} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { page, queryClient }
}

test('renders the four server-derived tracked-query measurement labels', async () => {
  const requests: string[] = []
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    requests.push(path)
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') return jsonResponse(statuses)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()

  for (const label of ['Not in plan', 'Awaiting first sweep', 'Partial', 'Measured']) {
    expect(await screen.findByText(label)).toBeTruthy()
  }
  expect(screen.getByRole('columnheader', { name: 'Measurement status' })).toBeTruthy()
  expect(screen.getByLabelText('Measurement status: Measured')).toBeTruthy()
  expect(requests).toContain('/api/v1/projects/demo/measurement-query-statuses')
})

test('renders a loading state while the server-derived status is pending', async () => {
  let resolveStatus: (response: Response) => void = () => undefined
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      return new Promise<Response>((resolve) => { resolveStatus = resolve })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()

  expect(await screen.findByText('Loading measurement status')).toBeTruthy()
  resolveStatus(jsonResponse(statuses))
  expect(await screen.findByText('Measured')).toBeTruthy()
})

test('renders an error with retry instead of inventing a status', async () => {
  let statusRequests = 0
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      return statusRequests === 1 ? jsonResponse({ code: 'UNAVAILABLE' }, 503) : jsonResponse(statuses)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()

  expect((await screen.findByRole('alert')).textContent).toContain('Could not load measurement status.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry measurement status' }))
  await waitFor(() => expect(screen.getByText('Measured')).toBeTruthy())
  expect(statusRequests).toBe(2)
})

test('replaces retained statuses with loading, then unavailable, when a refetch fails', async () => {
  let statusRequests = 0
  let resolveFailedRefetch: (response: Response) => void = () => undefined
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      if (statusRequests === 1) return jsonResponse(statuses)
      return new Promise<Response>((resolve) => { resolveFailedRefetch = resolve })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const { queryClient } = await renderTracked()
  expect(await screen.findByText('Measured')).toBeTruthy()

  void queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsByNameMeasurementQueryStatusesQueryKey({ client: heyClient, path: { name: 'demo' } }),
  })
  expect(await screen.findByText('Loading measurement status')).toBeTruthy()
  expect(screen.queryByText('Measured')).toBeNull()

  resolveFailedRefetch(jsonResponse({ code: 'UNAVAILABLE' }, 503))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load measurement status.')
  expect(screen.queryByText('Measured')).toBeNull()
  expect(screen.getAllByText('Status unavailable')).toHaveLength(trackedQueries.length)
})

test('refreshes already-Measured badges after the project run list reports an external scheduled full sweep terminal', async () => {
  let statusRequests = 0
  let runListRequests = 0
  let resolveRunList: (response: Response) => void = () => undefined
  const measured = {
    ...statuses,
    queries: statuses.queries.map(row => ({
      ...row,
      status: row.status === 'not_in_plan' ? 'not_in_plan' as const : 'measured' as const,
    })),
  }
  const partial = {
    ...statuses,
    latestOfficialFullRun: {
      id: 'run-external-partial', status: 'partial' as const,
      createdAt: '2026-08-28T10:05:00.000Z', finishedAt: '2026-08-28T10:06:00.000Z',
    },
    queries: statuses.queries.map(row => ({
      ...row,
      status: row.status === 'not_in_plan' ? 'not_in_plan' as const : 'partial' as const,
    })),
  }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      return jsonResponse(statusRequests === 1 ? measured : partial)
    }
    if (path === '/api/v1/projects/demo/runs') {
      runListRequests += 1
      return new Promise<Response>((resolve) => { resolveRunList = resolve })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()
  expect(await screen.findAllByText('Measured')).toHaveLength(3)
  await waitFor(() => expect(runListRequests).toBe(1))

  resolveRunList(jsonResponse([{
    id: 'run-external-partial',
    projectId: 'project-demo',
    kind: 'answer-visibility',
    status: 'partial',
    trigger: 'scheduled',
    measurementPlanVersionId: 'plan-current',
    measurementScope: null,
    createdAt: '2026-08-28T10:05:00.000Z',
    finishedAt: '2026-08-28T10:06:00.000Z',
  }]))

  await waitFor(() => expect(screen.getAllByText('Partial')).toHaveLength(3))
  expect(statusRequests).toBe(2)
})

test('never leaves a Measured badge visible when the external-sweep status refresh fails', async () => {
  let statusRequests = 0
  let runListRequests = 0
  let resolveRunList: (response: Response) => void = () => undefined
  let resolveFailedRefetch: (response: Response) => void = () => undefined
  const measured = {
    ...statuses,
    queries: statuses.queries.map(row => ({
      ...row,
      status: row.status === 'not_in_plan' ? 'not_in_plan' as const : 'measured' as const,
    })),
  }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') {
      statusRequests += 1
      if (statusRequests === 1) return jsonResponse(measured)
      return new Promise<Response>((resolve) => { resolveFailedRefetch = resolve })
    }
    if (path === '/api/v1/projects/demo/runs') {
      runListRequests += 1
      return new Promise<Response>((resolve) => { resolveRunList = resolve })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked()
  expect(await screen.findAllByText('Measured')).toHaveLength(3)
  await waitFor(() => expect(runListRequests).toBe(1))

  resolveRunList(jsonResponse([{
    id: 'run-external-partial',
    projectId: 'project-demo',
    kind: 'answer-visibility',
    status: 'partial',
    trigger: 'scheduled',
    measurementPlanVersionId: 'plan-current',
    measurementScope: null,
    createdAt: '2026-08-28T10:05:00.000Z',
    finishedAt: '2026-08-28T10:06:00.000Z',
  }]))

  expect(await screen.findByText('Loading measurement status')).toBeTruthy()
  expect(screen.queryAllByText('Measured')).toHaveLength(0)
  resolveFailedRefetch(jsonResponse({ code: 'UNAVAILABLE' }, 503))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load measurement status.')
  expect(screen.queryAllByText('Measured')).toHaveLength(0)
  expect(screen.getAllByText('Status unavailable')).toHaveLength(trackedQueries.length)
})

test('keeps server-derived status visible to viewers and hides tracked-query writes in embed mode', async () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true, views: ['project'] } }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/queries') return jsonResponse(trackedQueries)
    if (path === '/api/v1/projects/demo/measurement-query-statuses') return jsonResponse(statuses)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  await renderTracked('viewer')

  expect(await screen.findByText('Measured')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add queries' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
})
