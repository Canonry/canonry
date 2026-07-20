import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { heyClient } from '../src/api.js'
import {
  getApiV1ProjectsByNameGoogleGscCoverageQueryKey,
  getApiV1ProjectsQueryKey,
  getApiV1RunsByIdQueryKey,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { useTriggerGscSync, useTriggerRun, useTriggerSiteAudit } from '../src/queries/mutations.js'
import { createQueryClient } from '../src/queries/query-client.js'

const projectsCacheKey = getApiV1ProjectsQueryKey({ client: heyClient })
const runsCacheKey = getApiV1RunsQueryKey({ client: heyClient })
const gscCoverageKey = getApiV1ProjectsByNameGoogleGscCoverageQueryKey({
  client: heyClient,
  path: { name: 'citypoint' },
})
const runDetailKey = (id: string) => getApiV1RunsByIdQueryKey({ client: heyClient, path: { id } })

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
  cleanup()
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
    const url = input instanceof Request ? input.url : String(input)
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
  queryClient.setQueryData(runsCacheKey, [makeRun('completed')])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(getToasts().some((toast) => toast.title === 'Visibility sweep completed')).toBe(true)
  })

  expect(getRunTrackerState().runs).toEqual({})

  queryClient.setQueryData(runsCacheKey, [makeRun('completed')])

  await waitFor(() => {
    expect(getToasts().filter((toast) => toast.title === 'Visibility sweep completed')).toHaveLength(1)
  })
})

test('refetches runs on focus only when tracked runs are pending', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
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
  queryClient.setQueryData(runsCacheKey, [makeRun('running')])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  fetchMock.mockClear()
  window.dispatchEvent(new Event('focus'))

  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([input]) => (input instanceof Request ? input.url : String(input)).includes('/api/v1/runs'))).toBe(true)
  })
})

test('keeps run notifications active when the app is bootstrapped from dashboard context', async () => {
  const fixture = createDashboardFixture()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
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
    expect(fetchMock.mock.calls.some(([input]) => (input instanceof Request ? input.url : String(input)).includes('/api/v1/runs'))).toBe(true)
  })

  await waitFor(() => {
    expect(getToasts().some((toast) => toast.title === 'Visibility sweep completed')).toBe(true)
  })
})

test('emits one aggregate batch toast for run-all completions', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
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
  queryClient.setQueryData(runsCacheKey, [
    makeRun('completed'),
    { ...makeRun('failed', 'Provider timeout'), id: 'run_2', projectId: 'proj_2' },
  ])
  queryClient.setQueryData(projectsCacheKey, [
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
  queryClient.setQueryData(runDetailKey(fixture.dashboard.runs[0]!.id), {
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

test('renders tracked work in the global task center across the app shell', async () => {
  const fixture = createDashboardFixture()
  const activeAudit = {
    ...makeRun('running'),
    id: 'audit_1',
    kind: 'site-audit',
  }
  trackRun({
    id: activeAudit.id,
    projectId: activeAudit.projectId,
    kind: 'site-audit',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'site-audit',
    lastAnnouncedStatus: 'queued',
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(runsCacheKey, [activeAudit])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(screen.getByText('Active tasks')).not.toBeNull()
  expect(screen.getAllByText('Technical audit').length).toBeGreaterThanOrEqual(1)
  expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1)
  expect(screen.getAllByText('Citypoint Dental NYC').length).toBeGreaterThanOrEqual(1)
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

test('invalidates GSC project queries when a tracked gsc-sync run completes', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/v1/runs')) {
      return jsonResponse([{ ...makeRun('completed'), kind: 'gsc-sync' }])
    }
    if (url.includes('/api/v1/projects')) return jsonResponse([makeProject()])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  trackRun({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'gsc-sync',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'gsc-sync',
    lastAnnouncedStatus: 'queued',
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(runsCacheKey, [{ ...makeRun('completed'), kind: 'gsc-sync' }])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  // Pre-populate the GSC coverage cache so invalidation has something to mark stale.
  queryClient.setQueryData(gscCoverageKey, { stale: true })

  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    const state = queryClient.getQueryState(gscCoverageKey)
    expect(state?.isInvalidated).toBe(true)
  })
})

test('does not invalidate GSC project queries for non-GSC runs', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
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
  queryClient.setQueryData(runsCacheKey, [makeRun('completed')])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  queryClient.setQueryData(gscCoverageKey, { stale: true })

  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  // Wait for the terminal toast to fire so the observer effect has run.
  await waitFor(() => {
    expect(getToasts().some((toast) => toast.title === 'Visibility sweep completed')).toBe(true)
  })

  const state = queryClient.getQueryState(gscCoverageKey)
  expect(state?.isInvalidated).toBe(false)
})

function TriggerGscSyncButton() {
  const mutation = useTriggerGscSync()
  return (
    <button
      type="button"
      onClick={() => {
        mutation.mutate({ projectName: 'citypoint', projectLabel: 'Citypoint Dental NYC' })
      }}
    >
      Trigger GSC sync
    </button>
  )
}

function TriggerSiteAuditButton() {
  const mutation = useTriggerSiteAudit()
  return (
    <button
      type="button"
      onClick={() => {
        mutation.mutate({
          projectName: 'citypoint',
          projectId: 'proj_1',
          projectLabel: 'Citypoint Dental NYC',
        })
      }}
    >
      Trigger technical audit
    </button>
  )
}

test('tracks a queued Technical AEO audit for the global task center', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ runId: 'audit_1', status: 'queued' }))
  vi.stubGlobal('fetch', fetchMock)

  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <TriggerSiteAuditButton />
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Trigger technical audit' }))

  await waitFor(() => {
    expect(getRunTrackerState().runs.audit_1).toMatchObject({
      projectId: 'proj_1',
      kind: 'site-audit',
      sourceAction: 'site-audit',
    })
  })
  expect(getToasts().some((toast) => toast.title === 'Technical audit queued')).toBe(true)
})

test('useTriggerGscSync invalidates GSC project queries when the mutation succeeds', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({
    ...makeRun('queued'),
    kind: 'gsc-sync',
  }))
  vi.stubGlobal('fetch', fetchMock)

  const queryClient = createQueryClient()
  // Pre-populate the cache so we can observe invalidation.
  queryClient.setQueryData(gscCoverageKey, { stale: true })

  render(
    <QueryClientProvider client={queryClient}>
      <TriggerGscSyncButton />
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Trigger GSC sync' }))

  await waitFor(() => {
    const state = queryClient.getQueryState(gscCoverageKey)
    expect(state?.isInvalidated).toBe(true)
  })
})

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

test('clears a tracked sync run that has aged out of the /runs window so its button cannot wedge', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    // The tracked run has aged out of the capped window: GET /runs no longer returns it.
    if (url.includes('/api/v1/runs')) return jsonResponse([])
    if (url.includes('/api/v1/projects')) return jsonResponse([makeProject()])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  // A gbp-sync run tracked long ago (epoch) — absent from /runs and past the TTL.
  trackRun({
    id: 'gbp_run_aged',
    projectId: 'proj_1',
    kind: 'gbp-sync',
    projectLabel: 'Citypoint Dental NYC',
    sourceAction: 'gbp-sync',
    lastAnnouncedStatus: 'queued',
    trackedAt: 0,
  })
  expect(getRunTrackerState().runs.gbp_run_aged).toBeTruthy()

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(runsCacheKey, [])
  queryClient.setQueryData(projectsCacheKey, [makeProject()])
  render(
    <QueryClientProvider client={queryClient}>
      <RunNotificationObserver />
    </QueryClientProvider>,
  )

  // The observer gives up on the aged-out run instead of tracking it forever: it
  // drops from the tracker (which re-enables the Sync button) and surfaces a
  // neutral "status unavailable" toast.
  await waitFor(() => expect(getRunTrackerState().runs.gbp_run_aged).toBeUndefined())
  expect(getToasts().some((toast) => toast.title === 'Business Profile sync status unavailable')).toBe(true)
})
