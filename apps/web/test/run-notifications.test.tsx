import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { RunNotificationObserver } from '../src/App.js'
import { addToast, getToasts, resetToasts } from '../src/lib/toast-store.js'
import {
  createTrackedBatch,
  getRunTrackerState,
  resetRunTracker,
  runTrackerStorageKey,
  trackRun,
} from '../src/lib/run-tracker-store.js'
import { createAppRouter } from '../src/router/router.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { queryKeys } from '../src/queries/query-keys.js'
import { useTriggerRun } from '../src/queries/mutations.js'
import { createQueryClient } from '../src/queries/query-client.js'

function makeProject() {
  return {
    id: 'proj_1',
    name: 'citypoint',
    displayName: 'Citypoint Dental NYC',
    canonicalDomain: 'citypoint.example',
    ownedDomains: [],
    country: 'US',
    language: 'en',
    tags: [],
    labels: {},
    providers: ['openai'],
    locations: [],
    defaultLocation: null,
    configSource: 'database',
    configRevision: 1,
    createdAt: '2026-03-26T00:00:00.000Z',
    updatedAt: '2026-03-26T00:00:00.000Z',
  }
}

function makeRun(status: string, error: string | null = null) {
  return {
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    status,
    trigger: 'manual',
    location: null,
    startedAt: '2026-03-26T00:00:00.000Z',
    finishedAt: status === 'queued' || status === 'running' ? null : '2026-03-26T00:01:00.000Z',
    error,
    createdAt: '2026-03-26T00:00:00.000Z',
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetToasts()
  resetRunTracker()
  window.sessionStorage.clear()
})

afterEach(() => {
  resetToasts()
  resetRunTracker()
  vi.restoreAllMocks()
})

test('persists tracked runs to session storage', () => {
  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'project-run',
    lastAnnouncedStatus: 'queued',
  })

  expect(window.sessionStorage.getItem(runTrackerStorageKey)).toContain('Citypoint Dental NYC')
})

test('emits one terminal toast for a tracked run and does not duplicate it', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v1/runs')) return jsonResponse([makeRun('completed')])
    if (url.includes('/api/v1/projects')) return jsonResponse([makeProject()])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'project-run',
    lastAnnouncedStatus: 'queued',
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.runs.all, [makeRun('completed')])
  queryClient.setQueryData(queryKeys.projects.all, [makeProject()])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(getToasts().some((toast) => toast.title === 'Visibility sweep completed')).toBe(true)
  })

  expect(getRunTrackerState().runs).toEqual({})

  queryClient.setQueryData(queryKeys.runs.all, [makeRun('completed')])

  await waitFor(() => {
    expect(getToasts().filter((toast) => toast.title === 'Visibility sweep completed')).toHaveLength(1)
  })
})

test('refetches runs on focus only when tracked runs are pending', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v1/runs')) return jsonResponse([makeRun('running')])
    if (url.includes('/api/v1/projects')) return jsonResponse([makeProject()])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'project-run',
    lastAnnouncedStatus: 'queued',
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.runs.all, [makeRun('running')])
  queryClient.setQueryData(queryKeys.projects.all, [makeProject()])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  fetchMock.mockClear()
  window.dispatchEvent(new Event('focus'))

  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/runs'))).toBe(true)
  })
})

test('keeps run notifications active when the app is bootstrapped from dashboard context', async () => {
  const fixture = createDashboardFixture()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v1/runs')) return jsonResponse([makeRun('completed')])
    if (url.includes('/api/v1/projects')) return jsonResponse([makeProject()])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'project-run',
    lastAnnouncedStatus: 'queued',
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RunNotificationObserver />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/runs'))).toBe(true)
  })

  expect(getToasts().some((toast) => toast.title === 'Visibility sweep completed')).toBe(true)
})

test('emits one aggregate batch toast for run-all completions', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v1/runs')) {
      return jsonResponse([
        makeRun('completed'),
        { ...makeRun('failed', 'Provider timeout'), id: 'run_2', projectId: 'proj_2' },
      ])
    }
    if (url.includes('/api/v1/projects')) {
      return jsonResponse([
        makeProject(),
        { ...makeProject(), id: 'proj_2', name: 'northstar', displayName: 'Northstar Orthopedics' },
      ])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'run-all',
    lastAnnouncedStatus: 'queued',
  })
  trackRun({
    id: 'run_2',
    projectId: 'proj_2',
    kind: 'answer-visibility',
    projectLabel: 'Northstar Orthopedics',
    sourceAction: 'run-all',
    lastAnnouncedStatus: 'queued',
  })
  createTrackedBatch({
    runIds: ['run_1', 'run_2'],
    queuedCount: 2,
    skippedCount: 1,
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.runs.all, [
    makeRun('completed'),
    { ...makeRun('failed', 'Provider timeout'), id: 'run_2', projectId: 'proj_2' },
  ])
  queryClient.setQueryData(queryKeys.projects.all, [
    makeProject(),
    { ...makeProject(), id: 'proj_2', name: 'northstar', displayName: 'Northstar Orthopedics' },
  ])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(getToasts().filter((toast) => toast.title === 'Run-all batch finished')).toHaveLength(1)
  })

  expect(getToasts()).toHaveLength(1)
  expect(getRunTrackerState().batches).toEqual({})
})

test('toast CTA opens the existing run drawer via router state', async () => {
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  queryClient.setQueryData(queryKeys.runs.detail(fixture.dashboard.runs[0]!.id), {
    ...makeRun('completed'),
    id: fixture.dashboard.runs[0]!.id,
    snapshots: [],
  })

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  const runId = fixture.dashboard.runs[0]!.id
  addToast({
    title: 'Visibility sweep completed',
    tone: 'positive',
    cta: {
      label: 'View run',
      intent: 'open-run-drawer',
      runId,
    },
  })

  fireEvent.click(await screen.findByRole('button', { name: /View run:/ }))

  await waitFor(() => {
    expect(router.state.location.search.runId).toBe(runId)
  })
})

function TriggerRunButton() {
  const mutation = useTriggerRun()

  return (
    <button
      type="button"
      onClick={() => {
        mutation.mutate({
          projectName: 'citypoint',
          projectLabel: 'Citypoint Dental NYC',
          sourceAction: 'project-run',
        })
      }}
    >
      Trigger run
    </button>
  )
}

test('maps RUN_IN_PROGRESS errors to one caution toast with an extended timer', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    error: {
      code: 'RUN_IN_PROGRESS',
      message: 'Project already has an active run.',
    },
  }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <TriggerRunButton />
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Trigger run' }))
  fireEvent.click(screen.getByRole('button', { name: 'Trigger run' }))

  await waitFor(() => {
    const runInProgressToasts = getToasts().filter((toast) => toast.title === 'Run already in progress')
    expect(runInProgressToasts).toHaveLength(1)
    expect(runInProgressToasts[0]?.tone).toBe('caution')
    expect(runInProgressToasts[0]?.durationMs).toBe(8000)
    expect(runInProgressToasts[0]?.detail).toContain('Citypoint Dental NYC already has an active run')
  })
})
