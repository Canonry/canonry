// @vitest-environment jsdom
import { test, expect } from 'vitest'
import React from 'react'
import { render, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { queryKeys } from '../src/queries/query-keys.js'

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
  expect(container.innerHTML).toMatch(/Visibility and execution state/)
})

test('/projects renders the projects page', async () => {
  const { container } = await renderRoute('/projects')
  expect(container.querySelector('.page-title')?.textContent).toBe('Projects')
})

test('/projects/$id renders the project page', async () => {
  const { container } = await renderRoute('/projects/project_citypoint')
  expect(container.innerHTML).toMatch(/Citypoint Dental NYC/)
})

test('/runs renders the runs page', async () => {
  const { container } = await renderRoute('/runs')
  expect(container.querySelector('.page-title')?.textContent).toBe('Runs')
})

test('/settings renders the settings page', async () => {
  const { container } = await renderRoute('/settings')
  expect(container.querySelector('.page-title')?.textContent).toBe('Settings')
})

test('/setup renders the setup page', async () => {
  const { container } = await renderRoute('/setup')
  expect(container.querySelector('.page-title')?.textContent).toBe('Setup')
})

// ── Not-found route ──

test('unknown path renders the not-found page', async () => {
  const { container } = await renderRoute('/this-does-not-exist')
  expect(container.innerHTML).toMatch(/not found/i)
})

// ── Project tab navigation ──

test('/projects/$id/search-console renders the search engine intelligence tab', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/search-console')
  expect(container.innerHTML).toMatch(/Search Engine Intelligence/)
})

test('/projects/$id/analytics renders the analytics tab', async () => {
  const { container } = await renderRoute('/projects/project_citypoint/analytics')
  expect(container.innerHTML).toMatch(/Loading analytics/)
})

// ── Smart redirects ──

test('/ redirects to /setup when portfolio is empty', async () => {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Pre-seed query cache so beforeLoad can read it
  queryClient.setQueryData(queryKeys.projects.all, [])
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

test('/setup redirects to / when projects exist', async () => {
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Pre-seed query cache with projects so beforeLoad redirects
  queryClient.setQueryData(queryKeys.projects.all, fixture.dashboard.projects.map(p => p.project))
  const router = createAppRouter(queryClient, { initialEntries: ['/setup'] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  expect(router.state.location.pathname).toBe('/')
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
    expect(container.innerHTML).toMatch(/Provider state/)
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
