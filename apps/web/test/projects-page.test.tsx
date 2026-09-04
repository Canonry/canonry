import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

async function renderProjects(apiKey?: ApiKeyAccess, emptyPortfolio = false) {
  const fixture = createDashboardFixture({ emptyPortfolio })
  if (emptyPortfolio) fixture.dashboard.projects = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={apiKey}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { fixture, router }
}

test('routes Add project through the explicit validated Site Health launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'legacy' } }
  const requests: Array<{ path: string; method: string }> = []
  const restore = mockFetch((url, init) => {
    requests.push({ path: pathOf(url), method: init?.method ?? 'GET' })
    return jsonResponse({})
  })
  onTestFinished(restore)
  const { router } = await renderProjects()

  fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))

  await waitFor(() => expect(router.state.location.pathname).toBe('/setup'))
  expect(router.state.location.search).toEqual({ experience: 'platform' })
  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
  expect(screen.getByLabelText('Website URL')).toBeTruthy()
  expect(screen.queryByLabelText('Canonical domain')).toBeNull()
  expect(requests.some(request => request.path === '/api/v1/projects' && request.method === 'POST')).toBe(false)
})

test('hides instance project creation from a project-scoped write key', async () => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects({
    id: 'project-writer',
    scopes: ['*'],
    projectId: 'project_citypoint',
    readOnly: false,
  })

  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Apply YAML' })).toBeTruthy()
})

test.each([
  ['read-only', { id: 'reader', scopes: ['read'], projectId: null, readOnly: true }],
  ['narrow', { id: 'ads-writer', scopes: ['ads.write'], projectId: null, readOnly: false }],
] as const)('hides project and YAML write affordances from a %s key', async (_label, apiKey) => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects(apiKey)

  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Apply YAML' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
})

test('does not offer project creation in a read-only empty state', async () => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects({
    id: 'reader',
    scopes: ['read'],
    projectId: null,
    readOnly: true,
  }, true)

  expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Map a site' })).toBeNull()
})
