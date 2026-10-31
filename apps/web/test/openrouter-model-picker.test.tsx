import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { OpenRouterModelPicker, type OpenRouterPickerCatalog } from '../src/components/shared/OpenRouterModelPicker.js'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

afterEach(cleanup)

const validation = { modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.' }
const catalog: OpenRouterPickerCatalog = {
  ...validation,
  knownModels: [
    { id: 'openai/gpt-5-mini', displayName: 'OpenAI: GPT-5 Mini' },
    { id: 'google/gemini-3.1-flash-lite', displayName: 'Google: Gemini 3.1 Flash Lite' },
    { id: 'google/gemini-3.1-pro', displayName: 'Google: Gemini 3.1 Pro' },
    { id: 'anthropic/claude-sonnet-5', displayName: 'Anthropic: Claude Sonnet 5' },
    { id: 'x-ai/grok-5', displayName: 'xAI: Grok 5' },
    // Not one of the common vendors, so it gets no filter of its own.
    { id: 'qwen/qwen3-max', displayName: 'Qwen: Qwen3 Max' },
  ],
}

function listedModelIds() {
  return [...screen.getByRole('group', { name: 'OpenRouter models' }).querySelectorAll<HTMLElement>('label[data-model-id]')].map(row => row.dataset.modelId)
}

test('vendor filters cover only vendors in the catalog and filter without touching the search', () => {
  render(<OpenRouterModelPicker inline catalog={catalog} selected={[]} onAdd={vi.fn()} />)
  const filters = screen.getByRole('group', { name: 'Filter by vendor' })
  // Perplexity, DeepSeek, Mistral and Meta have no model here, so they are not offered.
  expect(within(filters).getAllByRole('button').map(button => button.textContent)).toEqual(['OpenAI', 'Google', 'Anthropic', 'xAI'])
  const search = screen.getByRole('searchbox', { name: 'Search OpenRouter models' }) as HTMLInputElement

  fireEvent.click(within(filters).getByRole('button', { name: 'Google' }))
  expect(search.value).toBe('')
  expect(within(filters).getByRole('button', { name: 'Google' }).getAttribute('aria-pressed')).toBe('true')
  expect(listedModelIds()).toEqual(['google/gemini-3.1-flash-lite', 'google/gemini-3.1-pro'])
  fireEvent.change(search, { target: { value: 'pro' } })
  expect(listedModelIds()).toEqual(['google/gemini-3.1-pro'])
  fireEvent.change(search, { target: { value: '' } })

  fireEvent.click(within(filters).getByRole('button', { name: 'xAI' }))
  expect(within(filters).getByRole('button', { name: 'Google' }).getAttribute('aria-pressed')).toBe('false')
  expect(listedModelIds()).toEqual(['x-ai/grok-5'])

  // Clicking the active filter shows every model again, sorted by name.
  fireEvent.click(within(filters).getByRole('button', { name: 'xAI' }))
  expect(within(filters).getByRole('button', { name: 'xAI' }).getAttribute('aria-pressed')).toBe('false')
  expect(listedModelIds()).toEqual(['anthropic/claude-sonnet-5', 'google/gemini-3.1-flash-lite', 'google/gemini-3.1-pro', 'openai/gpt-5-mini', 'qwen/qwen3-max', 'x-ai/grok-5'])
})

test('the Meta filter covers both of Meta\'s OpenRouter prefixes', () => {
  render(<OpenRouterModelPicker inline catalog={{ ...validation, knownModels: [
    { id: 'meta/muse-spark', displayName: 'Meta: Muse Spark' },
    { id: 'meta-llama/llama-4-maverick', displayName: 'Meta: Llama 4 Maverick' },
    { id: 'qwen/qwen3-max', displayName: 'Qwen: Qwen3 Max' },
  ] }} selected={[]} onAdd={vi.fn()} />)
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter by vendor' })).getByRole('button', { name: 'Meta' }))
  expect(listedModelIds()).toEqual(['meta-llama/llama-4-maverick', 'meta/muse-spark'])
})

test('recommended models come first and the full catalog waits behind Browse all', () => {
  const onAdd = vi.fn()
  render(<OpenRouterModelPicker inline catalog={{ ...validation, knownModels: [
    ...catalog.knownModels,
    { id: 'openai/gpt-6-luna', displayName: 'OpenAI: GPT-6 Luna' },
    { id: 'google/gemini-3.8-flash', displayName: 'Google: Gemini 3.8 Flash' },
  ] }} selected={['openrouter:google/gemini-3.8-flash']} onAdd={onAdd} />)
  const recommended = screen.getByRole('group', { name: 'Recommended' })
  // Claude Sonnet 5.5 is not in this catalog, so it is not offered.
  expect([...recommended.querySelectorAll<HTMLElement>('label[data-model-id]')].map(row => row.textContent)).toEqual([
    'OpenAI: GPT-6 LunaMaker of ChatGPT',
    'Google: Gemini 3.8 FlashAdded',
  ])
  expect(screen.queryByRole('searchbox', { name: 'Search OpenRouter models' })).toBeNull()
  const browse = screen.getByRole('button', { name: 'Browse all 8 models' })
  expect(browse.getAttribute('aria-expanded')).toBe('false')

  fireEvent.click(within(recommended).getByRole('checkbox', { name: 'OpenAI: GPT-6 Luna' }))
  fireEvent.click(browse)
  expect(screen.getByRole('button', { name: 'Hide the full list' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('checkbox', { name: 'xAI: Grok 5' }))
  // A filtered-out choice stays visible in the summary.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search OpenRouter models' }), { target: { value: 'qwen' } })
  expect(screen.getByText('Selected: OpenAI: GPT-6 Luna, xAI: Grok 5')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save 2 models' }))
  expect(onAdd).toHaveBeenCalledWith(['openrouter:openai/gpt-6-luna', 'openrouter:x-ai/grok-5'])
})

test('a search with no results names the search, and an empty catalog says the list could not load', () => {
  const failure = "Couldn't load OpenRouter's model list. Check the OpenRouter key in Settings, or enter a model ID below."
  const { unmount } = render(<OpenRouterModelPicker inline catalog={catalog} selected={[]} onAdd={vi.fn()} />)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search OpenRouter models' }), { target: { value: ' llama ' } })
  expect(screen.getByText('No models match "llama".')).toBeTruthy()
  expect(screen.queryByText(failure)).toBeNull()
  unmount()

  const onAdd = vi.fn()
  render(<OpenRouterModelPicker inline catalog={{ ...validation, knownModels: [] }} selected={[]} onAdd={onAdd} />)
  const message = screen.getByText(/^Couldn't load OpenRouter's model list\./)
  expect(message.textContent).toBe(failure)
  expect(within(message).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
  expect(screen.queryByText(/No models match/)).toBeNull()
  // Nothing to search or filter, but a typed model ID still works.
  expect(screen.queryByRole('searchbox', { name: 'Search OpenRouter models' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Filter by vendor' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: 'vendor/typed-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add ID' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 model' }))
  expect(onAdd).toHaveBeenCalledWith(['openrouter:vendor/typed-model'])
})

test('a failed inline save shows the error and keeps the choices for a retry', async () => {
  const onAdd = vi.fn().mockRejectedValueOnce(new Error('Project update refused.')).mockResolvedValueOnce(undefined)
  render(<OpenRouterModelPicker inline catalog={catalog} selected={[]} onAdd={onAdd} />)
  const model = screen.getByRole('checkbox', { name: 'xAI: Grok 5' }) as HTMLInputElement
  fireEvent.click(model)
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 model' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Project update refused.')
  expect(model.checked).toBe(true)
  const save = screen.getByRole('button', { name: 'Save 1 model' }) as HTMLButtonElement
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2))
  expect(onAdd).toHaveBeenLastCalledWith(['openrouter:x-ai/grok-5'])
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
