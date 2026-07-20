import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { ProjectEngineSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

afterEach(cleanup)

const settings = {
  providers: [{ name: 'gemini', displayName: 'Gemini', configured: true }, { name: 'openai', displayName: 'OpenAI', configured: false }],
  providerCatalog: [
    { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' }], modelValidationPattern: { source: '^gemini-', flags: '' }, modelValidationHint: 'Use a Gemini model ID.' },
    { name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser', modelConfigurable: false, defaultModel: 'chatgpt-web', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Detected from browser.' },
  ],
  google: { configured: false }, bing: { configured: false },
}

function renderSection(onSave = vi.fn().mockResolvedValue(undefined), project = { name: 'demo', providers: [] as string[], providerModels: {} as Record<string, string> }) {
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(settings)
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
