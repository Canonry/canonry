import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function setup() {
  const posts: Record<string, unknown>[] = []
  let settingsError = false
  let projectError = false
  let historyError = false
  const project = {
    id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
    country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: { openai: 'project-model' },
    locations: [{ label: 'Metro Alpha', city: 'Alpha', region: 'AA', country: 'US' }], defaultLocation: 'Metro Alpha',
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const error = () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Unavailable' } }, 500)
    if (path === '/api/v1/projects/demo/research/runs') {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return error() }
      return historyError ? error() : jsonResponse({ runs: [] })
    }
    if (path === '/api/v1/projects/demo') return projectError ? error() : jsonResponse(project)
    if (path === '/api/v1/settings') return settingsError ? error() : jsonResponse({
      providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'catalog-model' }],
      providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'catalog-model', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }],
    })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)
  return { posts, queryClient, project, failSettings: () => { settingsError = true }, failProject: () => { projectError = true }, failHistory: () => { historyError = true } }
}

async function ready() {
  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByRole('textbox', { name: /^Queries/ }), { target: { value: 'best apartments near transit' } })
  const button = screen.getByRole('button', { name: /^Run .*quer/ })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  return button
}

test('research binds explicit context and reuses the same key after an uncertain response', async () => {
  const state = setup()
  const button = await ready()
  fireEvent.click(button)
  await waitFor(() => expect(state.posts).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole('button', { name: /^Run .*quer/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /^Run .*quer/ }))
  await waitFor(() => expect(state.posts).toHaveLength(2))
  expect(state.posts[0]).toMatchObject({ provider: 'openai', model: 'project-model', location: state.project.locations[0], idempotencyKey: expect.any(String) })
  expect(state.posts[1]).toEqual(state.posts[0])
  fireEvent.change(screen.getByRole('textbox', { name: /^Queries/ }), { target: { value: 'pet friendly apartments' } })
  await waitFor(() => expect((screen.getByRole('button', { name: /^Run .*quer/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /^Run .*quer/ }))
  await waitFor(() => expect(state.posts).toHaveLength(3))
  expect(state.posts[2]?.idempotencyKey).not.toEqual(state.posts[0]?.idempotencyKey)
})

test.each(['settings', 'project'] as const)('cached %s refresh failure blocks research rather than using stale execution settings', async (kind) => {
  const state = setup()
  await ready()
  if (kind === 'settings') state.failSettings(); else state.failProject()
  await state.queryClient.refetchQueries()
  await screen.findByRole('alert')
  expect((screen.getByRole('button', { name: /^Run .*quer/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(state.posts).toHaveLength(0)
})

test('history failure is not presented as an empty research history', async () => {
  const state = setup()
  await ready()
  state.failHistory()
  await state.queryClient.refetchQueries()
  expect(await screen.findByText('Could not load research history.')).toBeTruthy()
  expect(screen.queryByText(/No research batches yet/)).toBeNull()
})
