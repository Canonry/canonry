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
import { getApiV1ProjectsByNameAgentProvidersQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AeroBar } from '../src/components/shared/AeroBar.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import * as aero from '../src/api-aero.js'

const PROJECT_NAME = 'citypoint'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
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


test('managed sweeps hides the Aero sweep shortcut while retaining read shortcuts', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.change(screen.getByPlaceholderText('Ask Aero, or / for commands…'), { target: { value: '/' } })
  expect(screen.getByText('/status')).toBeTruthy()
  expect(screen.queryByText('/run-sweep')).toBeNull()
  expect(screen.queryByText('Run sweep now')).toBeNull()
})

async function openAeroWithSavedWriteScope(managedSweeps: boolean) {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps } }
  vi.stubGlobal('localStorage', { getItem: (key: string) => key.includes(':scope:') ? 'all' : null, setItem: vi.fn(), clear: vi.fn() })
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const prompt = vi.spyOn(aero, 'promptAero').mockResolvedValue(undefined)
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  await waitFor(() => expect(transcript).toHaveBeenCalled())
  return { prompt, input: screen.getByPlaceholderText('Ask Aero, or / for commands…') }
}

test.each([
  ['enter', '/run-sweep'], ['submit', '/run-sweep'],
  ['enter', '  /RUN-SWEEP now'], ['submit', '/run-sweep '],
] as const)('managed Aero blocks the typed sweep command through %s (%s)', async (method, draft) => {
  const { prompt, input } = await openAeroWithSavedWriteScope(true)
  fireEvent.change(input, { target: { value: draft } })
  if (method === 'enter') fireEvent.keyDown(input, { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('Sweeps are run by your Canonry team')).toBeTruthy()
  expect(prompt).not.toHaveBeenCalled()
})

test.each([false, true])('managed=%s uses the effective Aero scope even with a saved write preference', async managed => {
  const { prompt, input } = await openAeroWithSavedWriteScope(managed)
  if (managed) {
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Can make changes|Read only/ })).toBeNull()
    expect(screen.queryByTitle(/run sweep|allow writes/i)).toBeNull()
  } else {
    expect(screen.getByRole('button', { name: 'Can make changes' })).toBeTruthy()
  }
  fireEvent.change(input, { target: { value: 'Show the latest sweep results' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ scope: managed ? 'read-only' : 'all' })))
})

test('operator mode retains the exact Aero sweep shortcut and saved write scope', async () => {
  const { prompt, input } = await openAeroWithSavedWriteScope(false)
  fireEvent.change(input, { target: { value: '/run-sweep' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
    prompt: 'Run a new answer-visibility sweep for this project now and tell me when it lands.', scope: 'all',
  })))
})
