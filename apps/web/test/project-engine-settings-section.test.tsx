import React, { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { ProjectEngineSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

afterEach(() => { cleanup(); resetToasts() })

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
  { label: 'without OpenRouter', catalogue: settings },
  { label: 'with OpenRouter beside a direct engine', catalogue: openRouterSettings },
])('explains future connections in a tooltip beside the heading, $label', async ({ catalogue }) => {
  const hint = 'All connected engines includes engines connected later in global Settings. Search answer services and OpenRouter models run only where you choose them.'
  renderSection(undefined, undefined, catalogue)
  await screen.findByText('All connected engines')
  // The help is the tooltip's name, not body copy, and stays out of the heading's name.
  expect(screen.queryByText(hint)).toBeNull()
  expect(screen.getByRole('button', { name: hint })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Answer engines' })).toBeTruthy()
  expect(screen.queryByText('Execution')).toBeNull()
  expect(screen.queryByText('Provider mode')).toBeNull()
  expect(screen.getByRole('group', { name: 'Engines to run' })).toBeTruthy()
  expect(screen.getByText('Applies on the next check')).toBeTruthy()
})

test('leads with choosing models when OpenRouter is the only connection', async () => {
  const openRouterOnly = { ...openRouterSettings, providers: [{ name: 'openrouter', displayName: 'OpenRouter', configured: true }] }
  const onSave = renderSection(undefined, undefined, openRouterOnly)
  expect(await screen.findByText('OpenRouter connected')).toBeTruthy()
  expect(screen.getByText('No models selected.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'OpenRouter runs only the models you choose here. A direct engine connected later in Settings can run too.' })).toBeTruthy()
  // No mode that would run nothing, and nothing to save until a model is chosen.
  expect(screen.queryByText('All connected engines')).toBeNull()
  expect(screen.queryByText('Runs no engine yet')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(screen.queryByText('Applies on the next check')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Choose models' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Claude via OpenRouter' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 model' }))
  expect(screen.queryByText('No models selected.')).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'anthropic/claude-model via OpenRouter' })).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: 'Add models' })).toBeTruthy()
  expect(screen.getByText('Applies on the next check')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['openrouter:anthropic/claude-model'], providerModels: {} }))
})

test('shows only the saved OpenRouter models, with Save engines, once some are chosen', async () => {
  const openRouterOnly = { ...openRouterSettings, providers: [{ name: 'openrouter', displayName: 'OpenRouter', configured: true }] }
  renderSection(undefined, { name: 'demo', providers: ['openrouter:google/gemini-model'], providerModels: {} }, openRouterOnly)
  expect(await screen.findByRole('checkbox', { name: 'google/gemini-model via OpenRouter' })).toHaveProperty('checked', true)
  expect(screen.queryByText('No models selected.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save engines' })).toBeTruthy()
  expect(screen.getByText('Applies on the next check')).toBeTruthy()
})

test('adds several concrete OpenRouter models beside direct Gemini, without selecting the connection', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: [], providerModels: {} }, openRouterSettings)
  fireEvent.click(await screen.findByRole('button', { name: 'Add OpenRouter models' }))
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
  expect(screen.getByRole('status').textContent).toBe('2 models added, not saved')
  expect(saveEngines.className).toContain('bg-accent')
  fireEvent.click(saveEngines)
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini', 'openrouter:google/gemini-model', 'openrouter:anthropic/claude-model'], providerModels: {} }))
  await waitFor(() => expect(getToasts().map(toast => toast.title)).toContain('Saved for the next check'))
  expect(screen.queryByText(/not saved/)).toBeNull()
  expect(saveEngines.className).not.toContain('bg-accent')
})

test('manual OpenRouter models remain selectable after saving and classifier-only routes are refused', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['openrouter:vendor/saved-model'], providerModels: {} }, {
    ...settings, providers: [...settings.providers, { name: 'openrouter', displayName: 'OpenRouter', configured: true }],
    providerCatalog: [...settings.providerCatalog, { name: 'openrouter', displayName: 'OpenRouter', mode: 'api', modelConfigurable: true, defaultModel: '', knownModels: [], modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.' }],
  })
  expect(await screen.findByRole('checkbox', { name: 'vendor/saved-model via OpenRouter' })).toHaveProperty('checked', true)
  fireEvent.click(screen.getByRole('button', { name: 'Add OpenRouter models' }))
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
  expect(screen.getByRole('status').textContent).toBe('1 model added, not saved')
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['openrouter:vendor/saved-model', 'openrouter:vendor/new-model'], providerModels: {} }))
})

test('automatic providers serialize as an empty list and choose mode materializes configured engines', async () => {
  const onSave = renderSection()
  await screen.findByText('All connected engines')
  expect((screen.getByLabelText('All connected engines') as HTMLInputElement).checked).toBe(true)
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

test('a connected answer service never joins automatic choices and offers its sweep profiles as opt-in rows', async () => {
  const profile = (id: string, displayName: string, workflows: string[], relationships: string[]) => ({
    id, route: `fake-answers:${id}`, displayName, description: `${displayName} profile.`, product: 'answer', execution: 'sync', workflows,
    evidence: { relationships, citationBasis: relationships.includes('explicit-citation') ? 'explicit-citation' : 'none', citationMeasurable: relationships.includes('explicit-citation'), spans: false, retrievalObservability: 'sources' },
    costBasis: 'unknown', locationGranularity: 'none', disclosedModelKind: 'unknown', maxQueryChars: null,
  })
  const cited = profile('cited', 'Cited', ['research', 'snapshot', 'visibility-sweep'], ['explicit-citation'])
  const results = profile('results', 'Results only', ['research'], ['search-result'])
  const base = { mode: 'api', modelConfigurable: false, knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Pinned.', kind: 'answer-service', connection: 'fake-answers' }
  const onSave = renderSection(undefined, { name: 'demo', providers: [], providerModels: {} }, {
    ...settings,
    providers: [...settings.providers, { name: 'fake-answers', displayName: 'Fake Answers', configured: true, kind: 'answer-service' }],
    providerCatalog: [
      ...settings.providerCatalog,
      { ...base, name: 'fake-answers', displayName: 'Fake Answers', defaultModel: '', selectionKind: 'profile', profiles: [cited, results], workflows: [] },
      { ...base, name: 'fake-answers:cited', displayName: 'Cited · Fake Answers', defaultModel: 'cited', selectionKind: null, profiles: [cited], workflows: cited.workflows },
      { ...base, name: 'fake-answers:results', displayName: 'Results only · Fake Answers', defaultModel: 'results', selectionKind: null, profiles: [results], workflows: results.workflows },
    ],
  } as typeof settings)
  await screen.findByText('All connected engines')
  act(() => { fireEvent.click(screen.getByLabelText('Choose engines')) })
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Cited · Fake Answers') as HTMLInputElement).checked).toBe(false)
  expect(screen.queryByLabelText('Fake Answers')).toBeNull()
  expect(screen.queryByLabelText('Results only · Fake Answers')).toBeNull()
  act(() => { fireEvent.click(screen.getByLabelText('Cited · Fake Answers')) })
  expect(screen.getByRole('button', { name: 'Cited profile.' })).toBeTruthy()
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini', 'fake-answers:cited'], providerModels: {} }))
})

test('groups connected services and keeps their profile order when choosing engines', async () => {
  const profile = (connection: string, id: string, displayName: string) => ({
    id, route: `${connection}:${id}`, displayName, description: `${displayName} profile.`, product: 'answer', execution: 'sync', workflows: ['research', 'snapshot', 'visibility-sweep'],
    evidence: { relationships: ['explicit-citation'], citationBasis: 'explicit-citation', citationMeasurable: true, spans: false, retrievalObservability: 'sources' },
    costBasis: 'unknown', locationGranularity: 'none', disclosedModelKind: 'unknown', maxQueryChars: null,
  })
  const services = [
    { name: 'fake-answers', displayName: 'Fake Answers', profiles: [profile('fake-answers', 'standard', 'Standard'), profile('fake-answers', 'advanced', 'Advanced')] },
    { name: 'other-answers', displayName: 'Other Answers', profiles: [profile('other-answers', 'low', 'Low'), profile('other-answers', 'high', 'High')] },
  ]
  const base = { mode: 'api', modelConfigurable: false, knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Pinned.', kind: 'answer-service' }
  const onSave = renderSection(undefined, { name: 'demo', providers: [], providerModels: {} }, {
    ...settings,
    providers: services.map(service => ({ name: service.name, displayName: service.displayName, configured: true, kind: 'answer-service' })),
    providerCatalog: [
      ...settings.providerCatalog,
      ...services.flatMap(service => [
        { ...base, ...service, connection: service.name, defaultModel: '', selectionKind: 'profile', workflows: [] },
        ...service.profiles.map(item => ({ ...base, connection: service.name, name: item.route, displayName: `${item.displayName} · ${service.displayName}`, defaultModel: item.id, selectionKind: null, profiles: [item], workflows: item.workflows })),
      ]),
    ],
  } as typeof settings)
  await screen.findByLabelText('Standard · Fake Answers')
  expect(screen.getAllByRole('checkbox').map(input => input.closest('label')?.textContent?.trim())).toEqual([
    'Standard · Fake Answers', 'Advanced · Fake Answers', 'Low · Other Answers', 'High · Other Answers',
  ])
  expect(screen.getByText('Nothing selected to run.')).toBeTruthy()
  expect(screen.queryByText('All connected engines')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  act(() => { fireEvent.click(screen.getByLabelText('Standard · Fake Answers')) })
  expect(screen.queryByText('Nothing selected to run.')).toBeNull()
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['fake-answers:standard'], providerModels: {} }))
})
