import { test, expect, beforeAll, onTestFinished } from 'vitest'
import React from 'react'
import { render, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { heyClient } from '../src/api.js'
import { getApiV1ProjectsQueryKey } from '@ainyc/canonry-api-client/react-query'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

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
  const router = createAppRouter(queryClient, { initialEntries: [`/projects/${uuid}/report`] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  // The UUID-shaped segment is swapped for the name; the /report tab is preserved.
  expect(router.state.location.pathname).toBe('/projects/acme-co/report')
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

test('/projects/$id/report renders the report tab', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/report')
  expect(container.innerHTML).toMatch(/Loading report/)
})

test('/projects/$id/local renders the local presence tab', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/local')
  // Route resolves to the project shell...
  expect(container.innerHTML).toMatch(/Citypoint Dental NYC/)
  // ...and the Local Presence tab renders GbpSection. The fixture has no GBP
  // connection, so its connect empty-state renders (heading shows in every state).
  await waitFor(() => expect(container.innerHTML).toMatch(/Google Business Profile/))
})

test('/projects/$id/discovery keeps its stable route and defaults Queries to Discover', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/discovery')
  expect(container.innerHTML).toMatch(/Generate and check questions/)
  expect(container.innerHTML).toMatch(/Describe your customer/)
  expect(container.innerHTML).toMatch(/Queries/)
  expect(container.innerHTML).toMatch(/Discover/)
})

test('/projects/$id/discovery selects the URL-backed tracked Queries workspace', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/discovery?queries=tracked')
  expect(container.innerHTML).toMatch(/Tracked queries/)
  expect(container.innerHTML).not.toMatch(/Manage queries/)
})

test('/projects/$id/discovery rejects an unknown Queries workspace and falls back to Discover', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/discovery?queries=unknown')
  expect(container.innerHTML).toMatch(/Generate and check questions/)
})

test('legacy manageQueries hands off to tracked Queries without closing a run drawer', async () => {
  const { router } = await renderRoute('/projects/project_citypoint?manageQueries=true&runId=run_citypoint_001')
  await waitFor(() => expect(router.state.location.pathname).toMatch(/\/discovery$/))
  expect(router.state.location.search).toMatchObject({ queries: 'tracked', runId: 'run_citypoint_001' })
  expect(router.state.location.search.manageQueries).toBeUndefined()
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
