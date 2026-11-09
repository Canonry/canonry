import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { SettingsPage } from '../src/pages/SettingsPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'
import { connectionFixture, settingsFixture } from './provider-settings-fixtures.js'

afterEach(cleanup)

async function renderSettings(fixture: ReturnType<typeof createDashboardFixture>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  const root = createRootRoute()
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage })
  const projectSettings = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/settings', component: () => null })
  const setup = createRoute({ getParentRoute: () => root, path: '/setup', component: () => null })
  const router = createRouter({ routeTree: root.addChildren([settings, projectSettings, setup]), history: createMemoryHistory({ initialEntries: ['/settings'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><DashboardProvider value={fixture}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider>)
  return router
}

test('saving the OpenRouter key offers project model selection without choosing a sweep model', async () => {
  const fixture = createDashboardFixture()
  fixture.dashboard.settings.providerStatuses = [{ name: 'openrouter', displayName: 'OpenRouter', state: 'needs-config', detail: 'Connect OpenRouter.' }]
  const writes: { path: string; method?: string; body: unknown }[] = []
  let connection = connectionFixture({ name: 'openrouter', displayName: 'OpenRouter', kind: 'model-gateway', configured: false, apiKeyConfigured: false, defaultModel: null, effectiveModel: null, capabilities: { apiKey: true, clearApiKey: false, baseUrl: true, resetBaseUrl: true, model: false, quota: true, disconnect: true, reload: true } })
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse(settingsFixture([connection]))
    if (path === '/api/v1/cdp/status' && init?.method === 'GET') return jsonResponse({ connected: false, targets: [] })
    if (path === '/api/v1/settings/providers/openrouter' && init?.method === 'GET') return jsonResponse(connection)
    if (path === '/api/v1/settings/providers/openrouter' && init?.method === 'PUT') {
      writes.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null })
      connection = { ...connection, configured: true, apiKeyConfigured: true }
      return jsonResponse({ name: 'openrouter', configured: true })
    }
    throw new Error(`Unexpected fetch: ${init?.method} ${path}`)
  })
  onTestFinished(restore)
  await renderSettings(fixture)
  fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }))
  const provider = screen.getByText('OpenRouter').closest('#provider-openrouter') as HTMLElement
  fireEvent.click(within(provider).getByRole('button', { name: 'Configure' }))
  expect(screen.queryByRole('textbox', { name: 'Model (optional)' })).toBeNull()
  fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'openrouter-test-key' } })
  expect(screen.queryByText('Instance model')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save connection', exact: true }))
  const destination = await screen.findByRole('link', { name: 'Choose project models' })
  expect(destination.getAttribute('href')).toBe(`/projects/${encodeURIComponent(fixture.dashboard.projects[0]!.project.name)}/settings#answer-engines`)
  await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/settings/providers/openrouter', method: 'PUT', body: { apiKey: 'openrouter-test-key', expectedRevision: 'saved-revision' } }]))
})

test.each([true, false])('shows saved models for the selected project with connection lifecycle metadata %s', async lifecycle => {
  const fixture = createDashboardFixture()
  const first = fixture.dashboard.projects[0]!.project
  const second = fixture.dashboard.projects[1]!.project
  const third = fixture.dashboard.projects[2]!.project
  first.providers = ['openrouter:google/gemini-2.5-flash', 'openrouter:anthropic/claude-sonnet-4', 'gemini']
  second.providers = ['openrouter:google/gemini-2.5-flash']
  third.providers = []
  const connection = connectionFixture({ name: 'openrouter', displayName: 'OpenRouter', kind: 'model-gateway', defaultModel: null, effectiveModel: null })
  const settings = settingsFixture([connection])
  settings.providerCatalog![0]!.knownModels = [
    { id: 'google/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' },
    { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4', tier: 'standard' },
  ]
  if (!lifecycle) delete settings.providerConnections
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse(settings)
    if (path === '/api/v1/cdp/status' && init?.method === 'GET') return jsonResponse({ connected: false, targets: [] })
    throw new Error(`Unexpected fetch: ${init?.method} ${path}`)
  })
  onTestFinished(restore)
  await renderSettings(fixture)
  expect(await screen.findByText('Gemini 2.5 Flash via OpenRouter · Claude Sonnet 4 via OpenRouter')).toBeTruthy()
  const project = screen.getByRole('combobox', { name: 'Project' })
  fireEvent.change(project, { target: { value: second.name } })
  expect(screen.getByText('Gemini 2.5 Flash via OpenRouter')).toBeTruthy()
  expect(screen.queryByText(/Claude Sonnet 4 via OpenRouter/)).toBeNull()
  expect(screen.getByRole('link', { name: 'Choose project models' }).getAttribute('href')).toBe(`/projects/${encodeURIComponent(second.name)}/settings#answer-engines`)
  fireEvent.change(project, { target: { value: third.name } })
  expect(screen.getByText('No models selected')).toBeTruthy()
  expect(screen.queryByText('Gemini 2.5 Flash via OpenRouter')).toBeNull()
})

test.each(['ok', 'error'] as const)('keeps optional connections collapsed, exposes a browser deep link, and shows %s service health appropriately', async state => {
  const fixture = createDashboardFixture()
  fixture.health.workerStatus = { label: 'Worker', state, detail: state === 'ok' ? 'Worker is healthy.' : 'Worker heartbeat has stopped.' }
  const browser = connectionFixture({ name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser' })
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse(settingsFixture([browser]))
    if (path === '/api/v1/cdp/status' && init?.method === 'GET') return jsonResponse({ connected: false, targets: [] })
    throw new Error(`Unexpected fetch: ${init?.method} ${path}`)
  })
  onTestFinished(restore)
  const router = await renderSettings(fixture)
  const connections = screen.getByText('Search and browser connections', { selector: 'summary' }).closest('details')!
  const health = screen.getByText('Service health', { selector: 'summary' }).closest('details')!
  expect(connections.open).toBe(false)
  expect(health.open).toBe(state !== 'ok')
  expect(connections.contains(screen.getByRole('heading', { name: 'ChatGPT (CDP)', hidden: true }))).toBe(true)
  if (state === 'error') expect(within(health).getByText('Worker heartbeat has stopped.')).toBeTruthy()
  else {
    fireEvent.click(screen.getByText('Service health', { selector: 'summary' }))
    expect(within(health).getAllByText('Healthy')).toHaveLength(2)
  }

  fireEvent.click(await screen.findByRole('link', { name: 'Browser settings' }))
  await waitFor(() => expect(router.state.location.hash).toBe('browser-connection'))
  await waitFor(() => expect(connections.open).toBe(true))
  expect(screen.getByRole('heading', { name: 'ChatGPT (CDP)' })).toBeTruthy()
  expect(within(connections).getByRole('heading', { name: 'Google OAuth' })).toBeTruthy()
  const card = screen.getByRole('heading', { name: 'ChatGPT (CDP)' }).closest('#browser-connection')!
  expect(within(card as HTMLElement).getByRole('button', { name: 'Configure' })).toBeTruthy()
})
