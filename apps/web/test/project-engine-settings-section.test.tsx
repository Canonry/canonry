import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { ProjectEngineSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { mockFetch, jsonResponse, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const settings = {
  providers: [{ name: 'gemini', displayName: 'Gemini', configured: true }, { name: 'openai', displayName: 'OpenAI', configured: false }],
  providerCatalog: [
    { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' }], modelValidationPattern: { source: '^gemini-', flags: '' }, modelValidationHint: 'Use a Gemini model ID.' },
    { name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser', modelConfigurable: false, defaultModel: 'chatgpt-web', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Detected from browser.' },
  ],
  engineConnections: [
    { id: 'gateway:verified', label: 'Verified gateway', preset: 'custom-openai-compatible' as const, protocol: 'openai-compatible' as const, baseUrl: 'https://verified.example/v1', quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 }, secretConfigured: true },
    { id: 'gateway:research', label: 'Research gateway', preset: 'custom-openai-compatible' as const, protocol: 'openai-compatible' as const, baseUrl: 'https://research.example/v1', quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 }, secretConfigured: true },
  ],
  engineRoutes: [
    {
      id: 'native:gemini', label: 'Gemini', connectionId: 'native:gemini', modelId: 'gemini-2.5-flash', revision: 1, source: 'implicit-native' as const,
      capabilities: { kind: 'verified-measurement' as const, retrieval: true, citations: true, location: true, servedModel: true, fallback: 'disabled' as const },
    },
    {
      id: 'route:verified-gateway', label: 'Verified gateway', connectionId: 'gateway:verified', modelId: 'verified/model', revision: 2, source: 'verified-adapter' as const,
      capabilities: { kind: 'verified-measurement' as const, retrieval: true, citations: true, location: true, servedModel: true, fallback: 'disabled' as const },
    },
    {
      id: 'route:research-gateway', label: 'Research gateway', connectionId: 'gateway:research', modelId: 'research/model', revision: 1, source: 'configured' as const,
      capabilities: { kind: 'text-only' as const },
    },
  ],
  google: { configured: false }, bing: { configured: false },
}

function renderSection(
  onSave = vi.fn().mockResolvedValue(undefined),
  project = { name: 'demo', providers: [] as string[], providerModels: {} as Record<string, string> },
  settingsBody: typeof settings = settings,
) {
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(settingsBody)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection project={project} onSave={onSave} /></QueryClientProvider>)
  return onSave
}

test('automatic providers serialize as an empty list and choose mode materializes configured engines', async () => {
  const onSave = renderSection()
  await screen.findByText('All configured engines')
  expect((screen.getByLabelText('All configured engines') as HTMLInputElement).checked).toBe(true)
  act(() => { fireEvent.click(screen.getByLabelText('Choose engines')) })
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test('inherit deletes only the selected provider override and custom models remain editable', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-custom' } })
  await screen.findByLabelText('Gemini custom model ID')
  const input = screen.getByLabelText('Gemini custom model ID') as HTMLInputElement
  act(() => { fireEvent.change(input, { target: { value: 'gemini-next' } }) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ providers: ['gemini'], providerModels: { gemini: 'gemini-next' } }))
  const select = screen.getByLabelText('Model')
  act(() => { fireEvent.change(select, { target: { value: '__inherit__' } }) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test('choosing Custom for a known-model override enters custom mode with an empty draft', async () => {
  renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } })
  const select = await screen.findByLabelText('Model') as HTMLSelectElement
  // A known override shows the catalog model, not the custom input.
  expect(select.value).toBe('gemini-2.5-pro')
  expect(screen.queryByLabelText('Gemini custom model ID')).toBeNull()
  act(() => { fireEvent.change(select, { target: { value: '__custom__' } }) })
  // Switching to custom must actually reveal an (empty) custom input, not snap back.
  const input = await screen.findByLabelText('Gemini custom model ID') as HTMLInputElement
  expect(input.value).toBe('')
})

test('save drops overrides for engines that are not selected', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro', openai: 'gpt-5-mini' } })
  await screen.findByLabelText('Model')
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  // openai is not a selected engine, so its lingering override must not persist.
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } }))
})

test('migrates native route selections to legacy providers while retaining verified route IDs', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['native:gemini'], providerModels: { 'native:gemini': 'gemini-2.5-pro' }, researchProvider: 'native:gemini',
  })
  await screen.findByLabelText('Choose engines')
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByLabelText('Verified gateway'))
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'gemini' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['gemini', 'route:verified-gateway'],
    providerModels: { gemini: 'gemini-2.5-pro' },
    researchProvider: 'gemini',
  }))
})

test('keeps text-only routes unavailable to sweeps and permits them only as a research route', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['gemini'], providerModels: {}, researchProvider: null,
  })
  await screen.findByLabelText('Research gateway')
  const textOnlySweepControl = screen.getByLabelText('Research gateway') as HTMLInputElement
  expect(textOnlySweepControl.disabled).toBe(true)
  expect(screen.getByText('Text-only — research only')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['gemini'],
    providerModels: {},
    researchProvider: 'route:research-gateway',
  }))
})

test('keeps selected stale sweep and research routes visible without silently clearing them', async () => {
  const onSave = renderSection(
    undefined,
    { name: 'demo', providers: ['route:verified-gateway'], providerModels: {}, researchProvider: 'route:research-gateway' },
    { ...settings, engineConnections: [] },
  )

  await screen.findByLabelText('Verified gateway')
  expect((screen.getByLabelText('Verified gateway') as HTMLInputElement).checked).toBe(true)
  expect(screen.getAllByText('Connection missing')).toHaveLength(2)
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).value).toBe('route:research-gateway')
  expect(screen.getByText(/saved research route is unavailable/i)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['route:verified-gateway'],
    providerModels: {},
  }))
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).value).toBe('route:research-gateway')
})

test('a background project refetch does not clobber in-progress edits', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(settings)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={onSave} /></QueryClientProvider>,
  )
  await screen.findByLabelText('Choose engines')
  act(() => { fireEvent.click(screen.getByLabelText('Choose engines')) })
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  // A dashboard poll hands down a fresh project object with identical data.
  rerender(
    <QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={onSave} /></QueryClientProvider>,
  )
  // The in-progress "Choose engines" selection must survive the refetch.
  expect((screen.getByLabelText('Choose engines') as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
})

test('does not mount a mutable engine editor for embeds', () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  const requests: string[] = []
  const restore = mockFetch(url => {
    requests.push(pathOf(url))
    return jsonResponse({ error: { message: 'unexpected' } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={vi.fn()} /></QueryClientProvider>)

  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(requests).toEqual([])
})

test('uses the safe route read for a view-only project setting summary', async () => {
  const requests: string[] = []
  const restore = mockFetch(url => {
    const path = pathOf(url)
    requests.push(path)
    if (path === '/api/v1/settings/engine-routes') {
      return jsonResponse({
        routes: [{
          id: 'native:gemini', label: 'Gemini', modelId: 'gemini-2.5-flash', revision: 1, source: 'implicit-native',
          readiness: { state: 'measurement-ready', measurementReady: true },
        }],
      })
    }
    return jsonResponse({ error: { message: `unexpected ${path}` } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
        <ProjectEngineSettingsSection project={{ name: 'demo', providers: ['gemini'], providerModels: {} }} onSave={vi.fn()} />
      </AccountProvider>
    </QueryClientProvider>,
  )

  await screen.findByRole('heading', { name: 'Available engine routes' })
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(requests).toEqual(['/api/v1/settings/engine-routes'])
})
