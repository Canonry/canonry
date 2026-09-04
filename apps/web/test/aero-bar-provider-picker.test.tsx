import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { AeroBar } from '../src/components/shared/AeroBar.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

const providerPickerStorage = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => providerPickerStorage.get(key) ?? null,
    setItem: (key: string, value: string) => providerPickerStorage.set(key, value),
    removeItem: (key: string) => providerPickerStorage.delete(key),
    clear: () => providerPickerStorage.clear(),
  },
})

test('renders a configured route in the Aero provider picker', async () => {
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects/demo/agent/providers') {
      return jsonResponse({
        providers: [{
          id: 'route:gateway-gpt-5',
          label: 'Gateway GPT-5',
          defaultModel: 'openai/gpt-5',
          configured: true,
          keySource: 'config',
        }],
        defaultProvider: 'route:gateway-gpt-5',
      })
    }
    if (path === '/api/v1/projects/demo/agent/transcript') {
      return jsonResponse({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
    }
    return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <AeroBar projectName="demo" />
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about demo/i }))
  const picker = await screen.findByRole('button', { name: 'Switch agent model' })
  fireEvent.click(picker)

  expect(screen.getByRole('option', { name: /Gateway GPT-5/ })).toBeTruthy()
})
