/**
 * The Aero bar is an administrator control.
 *
 * Hiding it is not the security boundary — the routes refuse a viewer whether
 * or not the bar was drawn (see `packages/canonry/test/agent-admin-only.test.ts`).
 * This is about not offering an analyst a command bar that can only refuse
 * them, and about not naming the agent on a screen where it is not theirs.
 *
 * An install with no accounts must keep the bar: that is the single-operator
 * case, where `NO_ACCOUNTS` reports full access and always has.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import {
  getApiV1ProjectsByNameAgentProvidersQueryKey,
  getApiV1ProjectsQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import * as aero from '../src/api-aero.js'
import { AeroBarHost, aeroAllowedFor } from '../src/components/shared/AeroBar.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { createDashboardFixture } from '../src/mock-data.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.__CANONRY_CONFIG__
})

async function renderBarFor(role: 'admin' | 'viewer' | null) {
  const project = createDashboardFixture().dashboard.projects[0]!.project
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), [project])
  queryClient.setQueryData(
    getApiV1ProjectsByNameAgentProvidersQueryKey({ client: heyClient, path: { name: project.name } }),
    {
      providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
      defaultProvider: 'openai',
    },
  )

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AeroBarHost />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'projects/$projectName',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, projectRoute]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${encodeURIComponent(project.name)}`],
    }),
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: role, role } : null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return project
}

test('offers the Aero bar to an administrator', async () => {
  const project = await renderBarFor('admin')
  expect(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') })).toBeTruthy()
})

test('keeps the Aero bar on a single-operator install with no accounts', async () => {
  const project = await renderBarFor(null)
  expect(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') })).toBeTruthy()
})

test('does not offer the Aero bar to a view-only account', async () => {
  await renderBarFor('viewer')
  expect(screen.queryByRole('button', { name: /Ask Aero/i })).toBeNull()
  // Not merely disabled, and not replaced by an explanation either: a viewer
  // has no business knowing the project carries an agent at all.
  expect(document.body.textContent).not.toMatch(/Aero/i)
})

test('offers a view-only account the Aero bar when the install allows viewers', async () => {
  window.__CANONRY_CONFIG__ = { agent: { allowViewers: true } }
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const project = await renderBarFor('viewer')

  fireEvent.click(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') }))
  await waitFor(() => expect(transcript).toHaveBeenCalled())
  // The operator's controls stay off a viewer's bar.
  expect(screen.queryByRole('button', { name: /History/i })).toBeNull()
  expect(screen.getByRole('button', { name: /New conversation/i })).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('Ask Aero, or / for commands…'), { target: { value: '/' } })
  expect(screen.queryByText('/run-sweep')).toBeNull()
  expect(screen.queryByText('/new')).toBeNull()
  expect(screen.getByText('/status')).toBeTruthy()
})

test('still hides the Aero bar from a view-only account when the install does not allow viewers', async () => {
  window.__CANONRY_CONFIG__ = { agent: { allowViewers: false } }
  await renderBarFor('viewer')
  expect(screen.queryByRole('button', { name: /Ask Aero/i })).toBeNull()
})

test('the app shell and the bar host share one rule for who may use Aero', () => {
  window.__CANONRY_CONFIG__ = { agent: { allowViewers: true } }
  expect(aeroAllowedFor({ isAdmin: true, account: null })).toBe(true)
  expect(aeroAllowedFor({ isAdmin: false, account: { role: 'viewer' } })).toBe(true)
  expect(aeroAllowedFor({ isAdmin: false, account: null })).toBe(false)
  window.__CANONRY_CONFIG__ = {}
  expect(aeroAllowedFor({ isAdmin: false, account: { role: 'viewer' } })).toBe(false)
})
