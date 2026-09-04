import { afterEach, expect, test } from 'vitest'
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
import { getApiV1ProjectsByNameAgentProvidersQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AeroBar } from '../src/components/shared/AeroBar.js'
import { AccountProvider } from '../src/contexts/account-context.js'

const PROJECT_NAME = 'citypoint'

afterEach(() => {
  cleanup()
  try {
    window.localStorage.clear()
  } catch {
    // Some Node test workers expose no local storage implementation.
  }
})

async function renderWithProviderReadiness(data: {
  providers: Array<{
    id: 'openai'
    label: string
    defaultModel: string
    configured: boolean
    keySource: 'config' | null
  }>
  defaultProvider: 'openai' | null
}, role: 'admin' | 'viewer' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameAgentProvidersQueryKey({
      client: heyClient,
      path: { name: PROJECT_NAME },
    }),
    data,
  )

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AeroBar projectName={PROJECT_NAME} />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'settings', component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: role, role } : null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { ...rendered, router }
}

test('does not advertise a working Aero prompt when no agent provider is configured', async () => {
  const { router } = await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: false,
      keySource: null,
    }],
    defaultProvider: null,
  })

  expect(screen.getByRole('status').textContent).toBe('Aero needs an agent provider.Open Settings')
  expect(screen.queryByRole('button', { name: /Ask Aero/i })).toBeNull()

  fireEvent.click(screen.getByRole('link', { name: 'Open Settings' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

test('shows the prompt affordance only after provider readiness is confirmed', async () => {
  await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: true,
      keySource: 'config',
    }],
    defaultProvider: 'openai',
  })

  expect(screen.getByRole('button', { name: /Ask Aero about citypoint/i })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})

test('does not send a view-only user to administrator settings', async () => {
  await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: false,
      keySource: null,
    }],
    defaultProvider: null,
  }, 'viewer')

  expect(screen.getByRole('status').textContent).toContain('Ask an administrator to configure one.')
  expect(screen.queryByRole('link', { name: 'Open Settings' })).toBeNull()
})
