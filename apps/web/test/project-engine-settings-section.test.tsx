import React, { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { ProjectEngineSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

afterEach(cleanup)

const settings = {
  providers: [{ name: 'gemini', displayName: 'Gemini', configured: true }, { name: 'openai', displayName: 'OpenAI', configured: false }],
  providerCatalog: [
    { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' }], modelValidationPattern: { source: '^gemini-', flags: '' }, modelValidationHint: 'Use a Gemini model ID.' },
    { name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser', modelConfigurable: false, defaultModel: 'chatgpt-web', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Detected from browser.' },
  ],
  google: { configured: false }, bing: { configured: false },
}

function renderSection(onSave = vi.fn().mockResolvedValue(undefined), project = { name: 'demo', providers: [] as string[], providerModels: {} as Record<string, string> }, catalogue = settings) {
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(catalogue)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection project={project} onSave={onSave} /></QueryClientProvider>)
  return onSave
}

const openRouterSettings = {
  ...settings,
  providers: [...settings.providers, { name: 'openrouter', displayName: 'OpenRouter', configured: true }],
  providerCatalog: [...settings.providerCatalog, {
    name: 'openrouter', displayName: 'OpenRouter', mode: 'api', modelConfigurable: true,
    defaultModel: '', knownModels: [
      { id: 'google/gemini-model', displayName: 'Gemini via OpenRouter', tier: 'standard' },
      { id: 'anthropic/claude-model', displayName: 'Claude via OpenRouter', tier: 'flagship' },
    ], modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.',
  }],
}

test.each([
  { label: 'keeps its text without OpenRouter', catalogue: settings, hint: 'Includes engines configured later in global Settings.' },
  { label: 'says OpenRouter models run only once added', catalogue: openRouterSettings, hint: 'Includes direct engines configured later in Settings. OpenRouter models run only when you add them below.' },
])('the All configured engines hint $label', async ({ catalogue, hint }) => {
  renderSection(undefined, undefined, catalogue)
  await screen.findByText('All configured engines')
  expect(screen.getByText(hint)).toBeTruthy()
})

test('warns that All configured engines runs nothing when OpenRouter is the only connection', async () => {
  const openRouterOnly = { ...openRouterSettings, providers: [{ name: 'openrouter', displayName: 'OpenRouter', configured: true }] }
  const warning = 'Only OpenRouter is connected, so this runs no engine. Add OpenRouter models below.'
  renderSection(undefined, undefined, openRouterOnly)
  expect((await screen.findByRole('alert')).textContent).toBe(warning)
  cleanup()
  renderSection(undefined, undefined, openRouterSettings)
  await screen.findByText('All configured engines')
  expect(screen.queryByText(warning)).toBeNull()
})

test('adds several concrete OpenRouter models beside direct Gemini, without selecting the connection', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: [], providerModels: {} }, openRouterSettings)
  fireEvent.click(await screen.findByRole('button', { name: 'Add models', exact: true }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Gemini via OpenRouter' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search OpenRouter models' }), { target: { value: 'claude' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Claude via OpenRouter' }))
  const saveEngines = screen.getByRole('button', { name: 'Save engines' })
  // Nothing to save yet, so Save engines is not the primary action.
  expect(saveEngines.className).not.toContain('bg-accent')
  fireEvent.click(screen.getByRole('button', { name: 'Add 2 models' }))
  expect(screen.getByRole('checkbox', { name: 'Gemini' })).toHaveProperty('checked', true)
  expect(screen.getByRole('checkbox', { name: 'google/gemini-model via OpenRouter' })).toHaveProperty('checked', true)
  expect(screen.getByRole('checkbox', { name: 'anthropic/claude-model via OpenRouter' })).toHaveProperty('checked', true)
  // Adding only stages the models: the note and the primary Save engines say what is left.
  expect(screen.getByRole('status').textContent).toBe('2 models added. Save engines to start using them.')
  expect(saveEngines.className).toContain('bg-accent')
  fireEvent.click(saveEngines)
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini', 'openrouter:google/gemini-model', 'openrouter:anthropic/claude-model'], providerModels: {} }))
  expect(await screen.findByText('Engine settings saved. They apply on the next sweep.')).toBeTruthy()
  expect(screen.queryByText(/Save engines to start using/)).toBeNull()
  expect(saveEngines.className).not.toContain('bg-accent')
})

test('manual OpenRouter models remain selectable after saving and classifier-only routes are refused', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['openrouter:vendor/saved-model'], providerModels: {} }, {
    ...settings, providers: [...settings.providers, { name: 'openrouter', displayName: 'OpenRouter', configured: true }],
    providerCatalog: [...settings.providerCatalog, { name: 'openrouter', displayName: 'OpenRouter', mode: 'api', modelConfigurable: true, defaultModel: '', knownModels: [], modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.' }],
  })
  expect(await screen.findByRole('checkbox', { name: 'vendor/saved-model via OpenRouter' })).toHaveProperty('checked', true)
  fireEvent.click(screen.getByRole('button', { name: 'Add models', exact: true }))
  // Discovery returned nothing, which is a failed load, not an empty search.
  expect(screen.getByText(/^Couldn't load OpenRouter's model list\./).textContent).toBe("Couldn't load OpenRouter's model list. Check the OpenRouter key in Settings, or enter a model ID below.")
  expect(screen.queryByText(/No models match/)).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: 'typesafe/jev-1.13' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add ID' }))
  expect(screen.getByRole('alert').textContent).toContain('fixed vendor/model slug')
  fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: 'vendor/new-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add ID' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 model' }))
  // The saved model is already in use; only the new one waits for Save engines.
  expect(screen.getByRole('status').textContent).toBe('1 model added. Save engines to start using it.')
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['openrouter:vendor/saved-model', 'openrouter:vendor/new-model'], providerModels: {} }))
})

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

test.each([
  { label: 'project-scoped writer', apiKey: { id: 'project-writer', scopes: ['*'], projectId: 'project-1', readOnly: false }, embed: false },
  { label: 'embed', apiKey: undefined, embed: true },
])('does not render or request the administrator provider catalogue for $label', async ({ apiKey, embed }) => {
  const requests: string[] = []
  const restore = mockFetch(url => {
    requests.push(url)
    throw new Error(`The provider catalogue must not be requested: ${url}`)
  })
  onTestFinished(restore)
  if (embed) window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  onTestFinished(() => { delete window.__CANONRY_CONFIG__ })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AccountProvider account={null} apiKey={apiKey}>
        <ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={vi.fn().mockResolvedValue(undefined)} />
      </AccountProvider>
    </QueryClientProvider>,
  )

  expect(screen.queryByRole('heading', { name: 'Answer engines' })).toBeNull()
  expect(requests).toEqual([])
})


test('the inherited model label uses the configured instance model, even when absent from discovery', async () => {
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse({
      ...settings, providers: [{ name: 'gemini', configured: true, model: 'gemini-configured-alias' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection
    project={{ name: 'demo', providers: ['gemini'], providerModels: {} }} onSave={onSave}
  /></QueryClientProvider>)
  const option = await screen.findByRole('option', { name: 'Use instance setting: gemini-configured-alias' })
  expect((option as HTMLOptionElement).selected).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: {} }))
})
