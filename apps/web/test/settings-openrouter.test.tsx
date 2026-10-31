import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import type { ReactNode } from 'react'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { SettingsPage } from '../src/pages/SettingsPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  Link: ({ children, to, params, hash }: { children: ReactNode; to: string; params?: { projectName: string }; hash?: string }) => <a href={`${to.replace('$projectName', params?.projectName ?? '')}${hash ? `#${hash}` : ''}`}>{children}</a>,
}))

afterEach(cleanup)

test('saving the OpenRouter key offers project model selection without choosing a sweep model', async () => {
  const fixture = createDashboardFixture()
  fixture.dashboard.settings.providerStatuses = [{ name: 'openrouter', displayName: 'OpenRouter', state: 'needs-config', detail: 'Connect OpenRouter.' }]
  const writes: { path: string; method?: string; body: unknown }[] = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/cdp/status' && init?.method === 'GET') return jsonResponse({ connected: false, targets: [] })
    if (path === '/api/v1/settings/providers/openrouter' && init?.method === 'PUT') {
      writes.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null })
      return jsonResponse({ name: 'openrouter', configured: true })
    }
    throw new Error(`Unexpected fetch: ${init?.method} ${path}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><DashboardProvider value={fixture}><SettingsPage /></DashboardProvider></QueryClientProvider>)
  const provider = screen.getByText('OpenRouter').closest('#provider-openrouter') as HTMLElement
  fireEvent.click(within(provider).getByRole('button', { name: 'Configure' }))
  expect(screen.queryByRole('textbox', { name: 'Model (optional)' })).toBeNull()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'openrouter-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
  const destination = await screen.findByRole('link', { name: 'Choose project models' })
  expect(destination.getAttribute('href')).toBe(`/projects/${fixture.dashboard.projects[0]!.project.name}/settings#answer-engines`)
  await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/settings/providers/openrouter', method: 'PUT', body: { apiKey: 'openrouter-test-key' } }]))
})
