import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test } from 'vitest'

import { EngineRoutesSettings } from '../src/components/settings/EngineRoutesSettings.js'
import { SettingsPage } from '../src/pages/SettingsPage.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const settings = {
  providers: [],
  providerCatalog: [],
  google: { configured: false },
  bing: { configured: false },
  engineConnections: [
    {
      id: 'gateway:team',
      label: 'Team gateway',
      preset: 'litellm' as const,
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:4000',
      quota: { maxConcurrency: 3, maxRequestsPerMinute: 60, maxRequestsPerDay: 5000 },
      secretConfigured: true,
    },
  ],
  engineRoutes: [
    {
      id: 'native:gemini',
      label: 'Gemini',
      connectionId: 'native:gemini',
      modelId: 'gemini-2.5-flash',
      revision: 1,
      source: 'implicit-native' as const,
      capabilities: {
        kind: 'verified-measurement' as const,
        retrieval: true,
        citations: true,
        location: true,
        servedModel: true,
        fallback: 'disabled' as const,
      },
    },
    {
      id: 'route:team-gpt',
      label: 'Team GPT',
      connectionId: 'gateway:team',
      modelId: 'openai/gpt-5.4',
      revision: 2,
      source: 'configured' as const,
      capabilities: { kind: 'text-only' as const },
    },
  ],
}

const modelCatalog = {
  connectionId: 'gateway:team',
  state: 'available' as const,
  manualModelIdAllowed: true as const,
  fetchedAt: '2026-09-01T12:00:00.000Z',
  models: [
    { id: 'openai/gpt-5.4', displayName: 'GPT 5.4', provider: 'OpenAI' },
    { id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  ],
}

function renderSettings({
  modelCatalogStatus = 200,
  settingsBody = settings,
}: {
  modelCatalogStatus?: number
  settingsBody?: typeof settings
} = {}) {
  const requests: Array<{ path: string; init?: RequestInit }> = []
  const restore = mockFetch((url, init) => {
    const path = decodeURIComponent(pathOf(url))
    requests.push({ path, init })
    if (path === '/api/v1/settings') return jsonResponse(settingsBody)
    if (path === '/api/v1/settings/engine-connections/gateway:team/models') return jsonResponse(modelCatalog, modelCatalogStatus)
    if (path.startsWith('/api/v1/settings/engine-connections/')) return jsonResponse({
      ...settingsBody.engineConnections[0],
      id: path.split('/').at(-1)!,
    })
    if (path.startsWith('/api/v1/settings/engine-routes/')) return jsonResponse({
      ...settingsBody.engineRoutes[1],
      id: path.split('/').at(-1)!,
    })
    return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EngineRoutesSettings />
    </QueryClientProvider>,
  )
  return { requests, client }
}

test('lists native and configured routes with their actual measurement readiness', async () => {
  renderSettings()

  await screen.findByText('Team GPT')
  expect(screen.getByRole('heading', { name: 'Engine routes' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: /Gemini/ })).toBeTruthy()
  expect(screen.getByRole('cell', { name: /Team GPT/ })).toBeTruthy()
  expect(screen.getAllByText('Sweep ready')).toHaveLength(1)
  expect(screen.getAllByText('Text-only')).toHaveLength(1)
  expect(screen.getByText('Saved API key')).toBeTruthy()
  expect(screen.getByText('Text-only routes can be used for research, not answer-visibility sweeps.')).toBeTruthy()
})

test('keeps routes first, then the route catalog editor, before the connection table', async () => {
  renderSettings()

  await screen.findByText('Team GPT')
  const routeTable = screen.getByRole('table', { name: 'Engine routes' })
  const connectionTable = screen.getByRole('table', { name: 'Gateway connections' })
  const routeRows = Array.from(routeTable.querySelectorAll('tbody tr'))
  expect(routeRows.map(row => row.textContent)).toEqual([
    expect.stringContaining('Gemini'),
    expect.stringContaining('Team GPT'),
  ])
  expect(routeTable.compareDocumentPosition(connectionTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Add route' }))
  const routeEditor = screen.getByRole('form', { name: 'Add route' })
  expect(routeEditor.textContent).toContain('Connection model catalog')
  expect(routeTable.compareDocumentPosition(routeEditor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(routeEditor.compareDocumentPosition(connectionTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('preserves a redacted connection secret when an editor changes no key', async () => {
  const { requests } = renderSettings()
  await screen.findByText('Team gateway')

  fireEvent.click(screen.getByRole('button', { name: 'Edit Team gateway' }))
  expect(screen.getByText('Leave blank to keep the saved key.')).toBeTruthy()
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Connection label'), { target: { value: 'Team gateway east' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

  await waitFor(() => expect(requests.some(request => request.path === '/api/v1/settings/engine-connections/gateway:team')).toBe(true))
  const request = requests.find(item => item.path === '/api/v1/settings/engine-connections/gateway:team')!
  expect(JSON.parse(String(request.init?.body))).toMatchObject({ label: 'Team gateway east', preset: 'litellm' })
  expect(JSON.parse(String(request.init?.body))).not.toHaveProperty('apiKey')
})

test('uses the contract LiteLLM endpoint when its preset is selected', async () => {
  renderSettings()
  await screen.findByText('Team gateway')

  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'litellm' } })

  expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('http://localhost:4000')
})

test('creates a generic route with a manual model ID and truthfully labels it text-only', async () => {
  const { requests } = renderSettings()
  await screen.findByText('Team GPT')

  fireEvent.click(screen.getByRole('button', { name: 'Add route' }))
  fireEvent.change(screen.getByLabelText('Route label'), { target: { value: 'Llama research' } })
  fireEvent.change(screen.getByLabelText('Route ID'), { target: { value: 'route:llama-research' } })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'meta-llama/llama-4-maverick' } })
  expect(screen.getByText('Generic routes are text-only until a verified evidence adapter is installed.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save route' }))

  await waitFor(() => expect(requests.some(request => request.path === '/api/v1/settings/engine-routes/route:llama-research')).toBe(true))
  const request = requests.find(item => item.path === '/api/v1/settings/engine-routes/route:llama-research')!
  expect(JSON.parse(String(request.init?.body))).toEqual({
    label: 'Llama research',
    connectionId: 'gateway:team',
    modelId: 'meta-llama/llama-4-maverick',
  })
})

test('loads and searches a connection catalog only after an explicit request while retaining manual model entry', async () => {
  const { requests } = renderSettings()
  await screen.findByText('Team GPT')

  fireEvent.click(screen.getByRole('button', { name: 'Add route' }))
  expect(requests.some(request => request.path.endsWith('/models'))).toBe(false)
  expect(screen.getByLabelText('Model ID')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Load model catalog' }))
  await screen.findByRole('option', { name: 'GPT 5.4 · OpenAI' })
  expect(requests.some(request => request.path === '/api/v1/settings/engine-connections/gateway:team/models')).toBe(true)

  fireEvent.change(screen.getByLabelText('Search model catalog'), { target: { value: 'gpt' } })
  expect(screen.getByRole('option', { name: 'GPT 5.4 · OpenAI' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Claude Sonnet 4.5 · Anthropic' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Catalog model ID'), { target: { value: 'openai/gpt-5.4' } })
  expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('openai/gpt-5.4')
})

test('keeps saved routes and the manual fallback visible if a catalog load fails', async () => {
  renderSettings({ modelCatalogStatus: 503 })
  await screen.findByText('Team GPT')

  fireEvent.click(screen.getByRole('button', { name: 'Add route' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load model catalog' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the model catalog. Enter a model ID manually.')
  expect(screen.getByRole('cell', { name: /Team GPT/ })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'manual/fallback-model' } })
  expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('manual/fallback-model')
})

test('keeps the last known routes visible when a settings refresh fails', async () => {
  let settingsReads = 0
  const restore = mockFetch(url => {
    if (pathOf(url) !== '/api/v1/settings') return jsonResponse({ error: { message: 'Unexpected request' } }, 500)
    settingsReads += 1
    return settingsReads === 1
      ? jsonResponse(settings)
      : jsonResponse({ error: { message: 'Gateway settings are temporarily unavailable' } }, 503)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><EngineRoutesSettings /></QueryClientProvider>)

  await screen.findByText('Team GPT')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh routes' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh routes. Showing the last successful settings.')
  expect(screen.getByRole('cell', { name: /Team GPT/ })).toBeTruthy()
})

test('keeps a route with a missing connection visible and marks it unavailable', async () => {
  renderSettings({
    settingsBody: {
      ...settings,
      engineRoutes: [
        ...settings.engineRoutes,
        {
          id: 'route:stale',
          label: 'Stale verified route',
          connectionId: 'gateway:missing',
          modelId: 'missing/model',
          revision: 3,
          source: 'verified-adapter',
          capabilities: {
            kind: 'verified-measurement',
            retrieval: true,
            citations: true,
            location: true,
            servedModel: true,
            fallback: 'disabled',
          },
        },
      ],
    },
  })

  await screen.findByText('Stale verified route')
  expect(screen.getByText('Connection missing')).toBeTruthy()
  expect(screen.getByRole('cell', { name: /Team GPT/ })).toBeTruthy()
})

test('shows a viewer the safe route summary without reading administrator settings', async () => {
  const requests: string[] = []
  const restore = mockFetch(url => {
    const path = decodeURIComponent(pathOf(url))
    requests.push(path)
    if (path === '/api/v1/settings/engine-routes') {
      return jsonResponse({
        routes: [
          {
            id: 'native:gemini',
            label: 'Gemini',
            modelId: 'gemini-2.5-flash',
            revision: 1,
            source: 'implicit-native',
            readiness: { state: 'measurement-ready', measurementReady: true },
          },
          {
            id: 'route:team-gpt',
            label: 'Team GPT',
            modelId: 'openai/gpt-5.4',
            revision: 2,
            source: 'configured',
            readiness: { state: 'text-ready', measurementReady: false },
          },
          {
            id: 'route:stale',
            label: 'Stale route',
            modelId: 'missing/model',
            revision: 3,
            source: 'verified-adapter',
            readiness: { state: 'unavailable', measurementReady: false },
          },
        ],
      })
    }
    return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
        <SettingsPage />
      </AccountProvider>
    </QueryClientProvider>,
  )

  await screen.findByText('Team GPT')
  expect(screen.getByRole('heading', { name: 'Available engine routes' })).toBeTruthy()
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh routes' })).toBeNull()
  expect(requests).toEqual(['/api/v1/settings/engine-routes'])
})

test('does not mount the mutable connection and route editor in an embed', () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  const requests: string[] = []
  const restore = mockFetch(url => {
    requests.push(pathOf(url))
    return jsonResponse({ error: { message: 'unexpected' } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><EngineRoutesSettings /></QueryClientProvider>)

  expect(screen.queryByRole('heading', { name: 'Engine routes' })).toBeNull()
  expect(requests).toEqual([])
})
