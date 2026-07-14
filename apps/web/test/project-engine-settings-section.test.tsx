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
