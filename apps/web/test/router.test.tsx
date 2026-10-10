import { test, expect, beforeAll, afterEach, onTestFinished } from 'vitest'
import React from 'react'
import { render, screen, waitFor, act, cleanup, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { RunKinds, RunStatuses, projectDtoSchema, runDetailDtoSchema } from '@ainyc/canonry-contracts'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { heyClient } from '../src/api.js'
import { getApiV1ProjectsQueryKey } from '@ainyc/canonry-api-client/react-query'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

const projectsCacheKey = getApiV1ProjectsQueryKey({ client: heyClient })

async function renderRoute(pathname: string, options: Parameters<typeof createDashboardFixture>[0] = {}) {
  const fixture = createDashboardFixture(options)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })

  await router.load()

  const result = render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  return { ...result, router, fixture }
}

// ── Route rendering ──

test('/ renders the overview page', async () => {
  const { container } = await renderRoute('/')
  expect(container.innerHTML).toMatch(/Visibility across all projects/)
})

test('/projects renders the projects page', async () => {
  const { container } = await renderRoute('/projects')
  expect(container.querySelector('.page-title')?.textContent).toBe('Projects')
})

test('/projects/$name resolves a project by its name', async () => {
  const { container } = await renderRoute('/projects/Citypoint%20Dental%20NYC')
  expect(container.innerHTML).toMatch(/Citypoint Dental NYC/)
})

test('/projects/$id still resolves a legacy id-based URL', async () => {
  const { container } = await renderRoute('/projects/project_citypoint')
  expect(container.innerHTML).toMatch(/Citypoint Dental NYC/)
})

test('a legacy UUID project URL redirects to the clean name URL', async () => {
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const uuid = '11111111-2222-4333-8444-555555555555'
  const project = { ...fixture.dashboard.projects[0]!.project, id: uuid, name: 'acme-co' }
  // Pre-seed the projects cache so the route-level redirect can resolve id → name
  queryClient.setQueryData(projectsCacheKey, [project])
  const router = createAppRouter(queryClient, { initialEntries: [`/projects/${uuid}/activity`] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  // The UUID-shaped segment is swapped for the name; the /activity tab is preserved.
  expect(router.state.location.pathname).toBe('/projects/acme-co/activity')
})

test('/runs renders the runs page', async () => {
  const { container } = await renderRoute('/runs')
  expect(container.querySelector('.page-title')?.textContent).toBe('Runs')
})

test('/settings renders the settings page', async () => {
  const { container } = await renderRoute('/settings')
  expect(container.querySelector('.page-title')?.textContent).toBe('Settings')
})

test('/setup legacy rescue renders the established setup page', async () => {
  const { container } = await renderRoute('/setup?experience=legacy')
  expect(container.querySelector('.page-title')?.textContent).toBe('Setup')
})

// ── Not-found route ──

test('unknown path renders the not-found page', async () => {
  const { container } = await renderRoute('/this-does-not-exist')
  expect(container.innerHTML).toMatch(/not found/i)
})

// ── Project tab navigation ──

test('/projects/$id/search-console renders the search engines tab', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/search-console')
  expect(container.innerHTML).toMatch(/Search Engines/)
})

test('/projects/$id/conversions renders the conversion integrity workspace', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/conversions')
  expect(container.innerHTML).toMatch(/Conversion Integrity/)
  expect(container.innerHTML).toMatch(/Loading conversion setup/)
})

test('retired report URLs redirect to AI Visibility without reading the report API', async () => {
  const requestedPaths: string[] = []
  const restore = mockFetch(url => {
    requestedPaths.push(pathOf(url))
    return jsonResponse({ error: { message: 'not needed for route compatibility' } }, 503)
  })
  onTestFinished(restore)
  const { container, router } = await renderRoute('/projects/project_citypoint/report')
  expect(router.state.location.pathname).toBe('/projects/project_citypoint')
  expect(container.querySelector('.project-subnav-current')?.textContent).toBe('AI Visibility')
  await waitFor(() => expect(requestedPaths.length).toBeGreaterThan(0))
  expect(requestedPaths.some(path => /\/report(?:\.html)?(?:\?|$)/.test(path))).toBe(false)
  expect([...container.querySelectorAll('h1')].map(heading => heading.textContent)).toEqual(['Citypoint Dental NYC'])
})

test('/projects/$id/local renders the local presence tab', async () => {
  const restore = mockFetch(url => pathOf(url).endsWith('/google/connections')
    ? jsonResponse([])
    : jsonResponse({ error: { message: 'not needed for local presence route' } }, 503))
  onTestFinished(restore)
  const { container } = await renderRoute('/projects/project_citypoint/local')
  // Route resolves to the project shell...
  expect(container.innerHTML).toMatch(/Citypoint Dental NYC/)
  // ...and the Local Presence tab renders GbpSection. The fixture has no GBP
  // connection, so its connect empty-state renders (heading shows in every state).
  await waitFor(() => expect(container.innerHTML).toMatch(/Google Business Profile/))
})

test('/projects/$id/discovery opens Research on Write, with Find ideas one choice away', async () => {
  await renderRoute('/projects/project_citypoint/discovery')
  expect(screen.getByRole('tab', { name: 'Research' }).getAttribute('aria-selected')).toBe('true')
  // A bare URL names no start: a writer lands on the form that runs nothing until pressed.
  expect(within(screen.getByRole('radiogroup', { name: 'Start from' })).getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([['Write', 'true'], ['Pattern', 'false'], ['Find ideas', 'false']])
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Ideal customer' })).toBeNull()
})

// ── Smart redirects ──

test('/ redirects to /setup when portfolio is empty', async () => {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Pre-seed query cache so beforeLoad can read it
  queryClient.setQueryData(projectsCacheKey, [])
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(router.state.location.pathname).toBe('/setup')
})

test('/ waits for an authoritative cold project list before redirecting to setup', async () => {
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()

  expect(router.state.location.pathname).toBe('/setup')
})

test('/ does not treat a failed cold project-list request as an empty portfolio', async () => {
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse({ error: { message: 'offline' } }, 503)
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()

  expect(router.state.location.pathname).toBe('/')
})

test.each([false, true])('deleting a project updates the live portfolio before navigation (last project: %s)', async lastProject => {
  const makeProject = (name: string) => projectDtoSchema.parse({
    id: `${name}-id`, name, displayName: name === 'alpha' ? 'Alpha' : 'Beta',
    canonicalDomain: `${name}.example`, country: 'US', language: 'en',
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  })
  let projects = [makeProject('alpha'), ...(lastProject ? [] : [makeProject('beta')])]
  const runs = projects.map(project => runDetailDtoSchema.parse({
    id: `${project.name}-run`, projectId: project.id,
    kind: project.name === 'alpha' ? RunKinds['site-audit'] : RunKinds['backlink-extract'],
    status: RunStatuses.completed, trigger: 'manual', createdAt: '2026-10-08T00:00:00.000Z',
    snapshots: [],
  }))
  const deletes: string[] = []
  const restore = mockFetch((input, init) => {
    const url = new URL(input)
    const path = url.pathname
    if (init?.method === 'DELETE' && path === '/api/v1/projects/alpha') {
      deletes.push(path)
      projects = projects.filter(project => project.name !== 'alpha')
      return new Response(null, { status: 204 })
    }
    if (path === '/api/v1/projects') return jsonResponse(projects)
    if (path === '/api/v1/runs') {
      return jsonResponse(runs.filter(run => projects.some(project => project.id === run.projectId)
        && (!url.searchParams.has('kind') || run.kind === url.searchParams.get('kind'))))
    }
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: {}, bing: {} })
    if (path === '/api/v1/cdp/status') return jsonResponse({ connected: false, targets: [] })
    if (path === '/health') return jsonResponse({ status: 'ok' })
    const projectPath = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/)
    const project = projects.find(item => item.name === projectPath?.[1])
    if (project) {
      const endpoint = projectPath?.[2]
      if (!endpoint) return jsonResponse(project)
      if (endpoint === 'overview') return jsonResponse(null)
      if (endpoint === 'measurement-plan') return jsonResponse({ active: null })
      if (endpoint === 'measurement-setup') return jsonResponse({
        state: 'simple', nextAction: 'start_setup', mode: 'simple', answerVisibilityProviderReady: true,
        activeRevision: null, activeSchemaVersion: null, draft: null,
      })
      if (['runs', 'queries', 'schedules', 'notifications', 'google/connections'].includes(endpoint ?? '')) return jsonResponse([])
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: `Unavailable ${path}` } }, 404)
  })
  onTestFinished(restore)
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } })
  onTestFinished(() => queryClient.clear())
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  const { unmount } = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
  onTestFinished(unmount)

  const activity = () => within(screen.getByRole('heading', { name: 'Activity', exact: true }).closest('section')!)
  await waitFor(() => expect(activity().getByRole('button', { name: /Alpha.*Site audit completed/ })).toBeTruthy())
  await act(async () => { await router.navigate({ to: '/projects/$projectName/settings', params: { projectName: 'alpha' } }) })
  const deleteButton = await screen.findByRole('button', { name: 'Delete project', exact: true })
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  fireEvent.click(deleteButton)
  fireEvent.click(screen.getByRole('button', { name: 'Yes, delete project' }))

  await waitFor(() => expect(deletes).toEqual(['/api/v1/projects/alpha']))
  await waitFor(() => expect(router.state.location.pathname).toBe(lastProject ? '/setup' : '/'))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Alpha', exact: true })).toBeNull())
  expect(queryClient.getQueryData<Array<{ name: string }>>(projectsCacheKey)?.map(project => project.name))
    .toEqual(lastProject ? [] : ['beta'])
  if (!lastProject) {
    expect(screen.getByRole('link', { name: 'Beta', exact: true })).toBeTruthy()
    await waitFor(() => {
      expect(activity().getByRole('button', { name: /Beta.*Backlink extract completed/ })).toBeTruthy()
      expect(activity().queryByRole('button', { name: /Alpha/ })).toBeNull()
    })
    expect(screen.getByRole('link', { name: 'beta', exact: true })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'alpha', exact: true })).toBeNull()
  }
})

test('/setup stays available when projects exist so incomplete setup can resume', async () => {
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A project row alone is not proof of activation: it may still need
  // queries, a provider, or a successful baseline.
  queryClient.setQueryData(projectsCacheKey, fixture.dashboard.projects.map(p => p.project))
  const router = createAppRouter(queryClient, { initialEntries: ['/setup'] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(router.state.location.pathname).toBe('/setup')
})

// ── Active nav highlighting ──

test('sidebar highlights the active route', async () => {
  const { container } = await renderRoute('/settings')
  const activeLinks = container.querySelectorAll('.sidebar-link-active')
  const settingsActive = Array.from(activeLinks).some(el => el.textContent?.includes('Settings'))
  expect(settingsActive).toBe(true)
})

// ── Drawer via search params ──

test('?runId= opens the run drawer', async () => {
  const { container, fixture } = await renderRoute('/?runId=run_citypoint_001')
  const firstRun = fixture.dashboard.runs[0]
  if (firstRun) {
    await waitFor(() => {
      expect(container.innerHTML).toMatch(firstRun.summary)
    })
  }
})

test.each([
  [RunKinds['site-audit'], RunStatuses.running, 'Run is in progress...'],
  [RunKinds['backlink-extract'], RunStatuses.completed, 'Run completed.'],
  [RunKinds['answer-visibility'], RunStatuses.running, 'Waiting for first query result...'],
  [RunKinds['answer-visibility'], RunStatuses.completed, 'No snapshot data available.'],
])('run drawer describes %s %s without query snapshots', async (kind, status, expected) => {
  const run = runDetailDtoSchema.parse({
    id: 'drawer_run', projectId: 'project_citypoint', kind, status,
    trigger: 'manual', createdAt: '2026-10-07T12:00:00Z',
    startedAt: '2026-10-07T12:00:00Z',
    finishedAt: status === RunStatuses.completed ? '2026-10-07T12:01:00Z' : null,
    snapshots: [],
  })
  const restore = mockFetch(url => pathOf(url) === '/api/v1/runs/drawer_run'
    ? jsonResponse(run)
    : jsonResponse({ error: { message: 'Unneeded read for run drawer' } }, 503))
  onTestFinished(restore)
  const { unmount } = await renderRoute('/?runId=drawer_run')
  onTestFinished(unmount)

  await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(expected))
  if (kind !== RunKinds['answer-visibility']) {
    expect(screen.getByRole('dialog').textContent).not.toMatch(/first query result|No snapshot data/)
  }
})

// ── Browser back/forward ──

test('back/forward navigation works via router history', async () => {
  const { router, container } = await renderRoute('/')

  // Navigate to /runs
  await act(async () => {
    await router.navigate({ to: '/runs' })
  })
  await waitFor(() => {
    expect(container.innerHTML).toMatch(/All runs/)
  })

  // Navigate to /settings
  await act(async () => {
    await router.navigate({ to: '/settings' })
  })
  await waitFor(() => {
    expect(container.innerHTML).toMatch(/Connections and answer engines/)
  })

  // Go back to /runs
  await act(async () => {
    router.history.back()
  })
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/runs')
  })

  // Go forward to /settings
  await act(async () => {
    router.history.forward()
  })
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/settings')
  })
})
