import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function installApiMock() {
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname

    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: null,
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
        providerCatalog: [{
          name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini',
          knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', tier: 'fast' }],
          modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.',
        }],
        google: { configured: false }, bing: { configured: false },
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
}

test('switches to research, deduplicates query lines, gates exact model choice, and states that research is not tracked', async () => {
  installApiMock()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <DiscoverySection projectName="demo" />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Find new queries to track')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Research queries' }))

  const model = await screen.findByLabelText(/Exact model/)
  expect((model as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('Saved to research history. Nothing is added to tracked queries.')).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(/one query per line/i), { target: { value: 'Best AEO platform\nbest aeo platform\nHow do I measure AI citations?\n' } })
  expect(screen.getByText(/2 queries, duplicates and blank lines are removed/)).toBeTruthy()

  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByLabelText('API provider'), { target: { value: 'openai' } })
  expect((screen.getByLabelText(/Exact model/) as HTMLInputElement).disabled).toBe(false)
})
