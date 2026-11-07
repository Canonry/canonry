import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, RouterProvider } from '@tanstack/react-router'
import type { ProviderConnectionSettingsDto } from '@canonry/canonry-contracts'

import { ProviderConnectionsSection } from '../src/components/settings/ProviderConfigForm.js'
import { CdpConfigCard } from '../src/components/settings/CdpConfigCard.js'
import { connectionFixture, settingsFixture } from './provider-settings-fixtures.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

function renderConnections(initial: ProviderConnectionSettingsDto[], options: { rejectDelete?: boolean; router?: boolean } = {}) {
  let connections = initial
  const writes: { method: string; body: unknown; path: string }[] = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse(settingsFixture(connections))
    const name = path.split('/').at(-1)
    const current = connections.find(connection => connection.name === name)
    if (!current) throw new Error(`Unexpected fetch ${path}`)
    if (init?.method === 'GET') return jsonResponse(current)
    writes.push({ path, method: init?.method ?? '', body: JSON.parse(String(init?.body)) })
    if (init?.method === 'DELETE') {
      if (options.rejectDelete) return jsonResponse({ error: { code: 'CONFLICT', message: 'Connection usage changed. Refresh the impact before disconnecting.' } }, 409)
      connections = connections.map(connection => connection === current ? { ...connection, configured: false, apiKeyConfigured: false } : connection)
      return jsonResponse(connections.find(connection => connection.name === name))
    }
    return jsonResponse({ name, configured: current.configured })
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  if (options.router) {
    const root = createRootRoute()
    const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: () => <><ProviderConnectionsSection projects={[]} /><Link to="/other">Leave settings</Link></> })
    const other = createRoute({ getParentRoute: () => root, path: '/other', component: () => <p>Other page</p> })
    const router = createRouter({ routeTree: root.addChildren([settings, other]), history: createMemoryHistory({ initialEntries: ['/settings'] }) })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  } else render(<QueryClientProvider client={client}><ProviderConnectionsSection projects={[]} /></QueryClientProvider>)
  return writes
}

async function manage() {
  fireEvent.click(await screen.findByRole('button', { name: 'Manage', exact: true }))
  return screen.findByRole('form')
}

test('prefills saved nonsecret fields and updates a model without resending credentials', async () => {
  const writes = renderConnections([connectionFixture({ baseUrl: 'https://proxy.example/v1', model: 'old-model', effectiveModel: 'old-model' })])
  const form = await manage()
  expect(within(form).getByLabelText('Replace API key')).toHaveProperty('value', '')
  expect(within(form).getByLabelText('Endpoint URL')).toHaveProperty('value', 'https://proxy.example/v1')
  expect(within(form).getByLabelText('Model ID')).toHaveProperty('value', 'old-model')
  fireEvent.change(within(form).getByLabelText('Model ID'), { target: { value: 'custom-model' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save connection' }))
  await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/api/v1/settings/providers/openai', body: { expectedRevision: 'saved-revision', model: 'custom-model' } }]))
})

test('resets model, endpoint and quota overrides rather than pinning current defaults', async () => {
  const base = connectionFixture()
  const writes = renderConnections([{ ...base, model: 'custom-model', baseUrl: 'https://proxy.example/v1', quota: { ...base.quota, overrides: { maxConcurrency: 5 }, effective: { ...base.quota.effective, maxConcurrency: 5 } } }])
  const form = await manage()
  fireEvent.click(within(form).getByLabelText('Use provider default endpoint'))
  fireEvent.click(within(form).getByLabelText('Use provider default: gpt-default'))
  fireEvent.click(within(form).getByText('Request limits', { selector: 'summary' }))
  expect(within(form).getByLabelText('Concurrent requests')).toHaveProperty('value', '5')
  fireEvent.click(within(form).getByRole('button', { name: 'Reset all limits to defaults' }))
  fireEvent.click(within(form).getByRole('button', { name: 'Save connection' }))
  await waitFor(() => expect(writes[0]?.body).toEqual({ expectedRevision: 'saved-revision', reset: { model: true, baseUrl: true, quota: ['maxConcurrency'] } }))
})

test('adding a local connection saves endpoint and an optional key', async () => {
  const local = connectionFixture({ name: 'local', displayName: 'Local', configured: false, apiKeyConfigured: false })
  local.capabilities.resetBaseUrl = false
  local.capabilities.clearApiKey = true
  const writes = renderConnections([local])
  fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Add provider' }), { target: { value: 'local' } })
  fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
  const form = await screen.findByRole('form')
  expect(screen.queryByRole('searchbox', { name: 'Add provider' })).toBeNull()
  fireEvent.change(within(form).getByLabelText('Endpoint URL'), { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'local-test-key' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save connection' }))
  await waitFor(() => expect(writes[0]?.body).toEqual({ expectedRevision: 'saved-revision', apiKey: 'local-test-key', baseUrl: 'http://localhost:11434/v1' }))
})

test('searching Add provider finds an existing connection and opens its saved settings', async () => {
  const writes = renderConnections([connectionFixture({ model: 'saved-model', effectiveModel: 'saved-model' })])
  fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Add provider' }), { target: { value: ' OpenAI ' } })
  expect(screen.getByText('Already connected')).toBeTruthy()
  expect(screen.queryByText('No matching providers.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Manage OpenAI' }))
  const form = await screen.findByRole('form', { name: 'OpenAI connection settings' })
  expect(screen.queryByRole('searchbox', { name: 'Add provider' })).toBeNull()
  expect(within(form).getByLabelText('Model ID')).toHaveProperty('value', 'saved-model')
  expect(within(form).getByLabelText('Replace API key')).toHaveProperty('value', '')
  expect(writes).toEqual([])
})

test('keeps an unsaved key until explicit discard and returns focus after closing the editor', async () => {
  const writes = renderConnections([connectionFixture({ name: 'local', displayName: 'Local' })])
  const pristineForm = await manage()
  const cancel = within(pristineForm).getByRole('button', { name: 'Cancel' })
  cancel.focus()
  fireEvent.click(cancel)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('form')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage', exact: true })))
  const form = await manage()
  fireEvent.change(within(form).getByLabelText('Replace API key'), { target: { value: 'unsaved-key' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(screen.getByLabelText('Replace API key')).toHaveProperty('value', 'unsaved-key')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByLabelText('Replace API key')).toHaveProperty('value', 'unsaved-key')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Manage', exact: true })))
  expect(writes).toEqual([])
})

test('blocks actual router navigation until the connection draft is discarded', async () => {
  renderConnections([connectionFixture()], { router: true })
  const form = await manage()
  fireEvent.change(within(form).getByLabelText('Replace API key'), { target: { value: 'unsaved-key' } })
  fireEvent.click(screen.getByRole('link', { name: 'Leave settings' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
  expect(screen.queryByText('Other page')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: 'Leave settings' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
  expect(await screen.findByText('Other page')).toBeTruthy()
})

test('browser settings stays on the Settings route when the document has a base URL', async () => {
  const base = document.createElement('base')
  base.href = '/'
  document.head.append(base)
  onTestFinished(() => base.remove())
  const browser = connectionFixture({ name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser' })
  renderConnections([browser], { router: true })
  const link = await screen.findByRole('link', { name: 'Browser settings' })
  expect(link.getAttribute('href')).toBe('/settings#browser-connection')
})

test('disconnect previews project impact and sends its reviewed revision', async () => {
  const connection = connectionFixture({ usage: { projectCount: 1, projects: [{ name: 'example', displayName: 'Example project', providers: ['openai'], sources: ['project', 'measurement-plan'] }] } })
  const writes = renderConnections([connection])
  await manage()
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect OpenAI' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Example project')).toBeTruthy()
  expect(within(dialog).getByText(/Project selections and recorded history remain/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect', exact: true }))
  await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/settings/providers/openai', method: 'DELETE', body: { expectedImpactRevision: 'impact-revision' } }]))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await screen.findByText(/No provider connections configured/)).toBeTruthy()
})

test('a stale disconnect preview stays open and requires a refreshed impact', async () => {
  const writes = renderConnections([connectionFixture()], { rejectDelete: true })
  await manage()
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect OpenAI' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect', exact: true }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Connection usage changed. Refresh the impact before disconnecting.')
  expect(within(dialog).getByRole('button', { name: 'Refresh impact' })).toBeTruthy()
  expect(writes).toHaveLength(1)
})

test('pending batches lock credentials while allowing a quota-only update', async () => {
  const writes = renderConnections([connectionFixture({ blockers: [{ code: 'outstanding-batches', message: 'Wait for the submitted batch to finish before changing credentials.', runIds: ['run-1'], batchIds: ['batch-1'] }], hostManaged: { vertex: null, batch: { enabled: true }, pricing: null } })])
  const form = await manage()
  expect(within(form).getByLabelText('Replace API key')).toHaveProperty('disabled', true)
  expect(within(form).getByLabelText('Use provider default: gpt-default')).toHaveProperty('disabled', true)
  fireEvent.click(within(form).getByText('Request limits', { selector: 'summary' }))
  fireEvent.click(within(form).getByLabelText('Use default (2)'))
  fireEvent.change(within(form).getByLabelText('Concurrent requests'), { target: { value: '3' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save connection' }))
  await waitFor(() => expect(writes[0]?.body).toEqual({ expectedRevision: 'saved-revision', quota: { maxConcurrency: 3 } }))
})

test('browser endpoint updates begin with the saved host and port', async () => {
  const writes: unknown[] = []
  const restore = mockFetch((url, init) => {
    if (pathOf(url) === '/api/v1/cdp/status') return jsonResponse({ connected: true, endpoint: 'http://browser.internal:9333', targets: [] })
    if (pathOf(url) === '/api/v1/settings/cdp') { writes.push(JSON.parse(String(init?.body))); return jsonResponse({ configured: true }) }
    throw new Error(`Unexpected fetch ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><CdpConfigCard /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Update endpoint' }))
  expect(screen.getByLabelText('CDP host')).toHaveProperty('value', 'browser.internal')
  expect(screen.getByLabelText('CDP port')).toHaveProperty('value', '9333')
  fireEvent.change(screen.getByLabelText('CDP port'), { target: { value: '9444' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
  await waitFor(() => expect(writes).toEqual([{ host: 'browser.internal', port: 9444 }]))
})

test('hosts without lifecycle metadata keep the existing provider setup path', async () => {
  const writes: unknown[] = []
  const data = settingsFixture([connectionFixture({ configured: false, apiKeyConfigured: false })])
  delete data.providerConnections
  const restore = mockFetch((url, init) => {
    if (pathOf(url) === '/api/v1/settings') return jsonResponse(data)
    if (pathOf(url) === '/api/v1/settings/providers/openai' && init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return jsonResponse({ name: 'openai', configured: true }) }
    throw new Error(`Unexpected fetch ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><ProviderConnectionsSection projects={[]} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Configure' }))
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'legacy-host-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
  await waitFor(() => expect(writes).toEqual([{ apiKey: 'legacy-host-test-key' }]))
  expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull()
})
