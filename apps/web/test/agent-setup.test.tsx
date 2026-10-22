import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { uiTelemetryEventSchema, type UiTelemetryEvent } from '@canonry/canonry-contracts'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { AgentSetupPage } from '../src/pages/AgentSetupPage.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { configureUiTelemetry, resetUiTelemetryForTests, setUiPageFromRoute } from '../src/lib/ui-telemetry.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
  vi.unstubAllEnvs()
  resetUiTelemetryForTests()
})

function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
}

const HOSTED_URL = 'https://canonry.example.com/team/canonry/api/v1/mcp'

function mount(body: Record<string, unknown> = { mcp: { status: 'available', hosted: { status: 'ready', url: HOSTED_URL } } }, status = 200, role?: 'admin' | 'viewer') {
  const requests: { path: string; method: string }[] = []
  const healthPath = `${window.__CANONRY_CONFIG__?.basePath?.replace(/\/$/, '') ?? ''}/health`
  const restore = mockFetch((url, init) => {
    const request = { path: new URL(url, window.location.origin).pathname, method: init?.method ?? 'GET' }
    requests.push(request)
    if (request.path !== healthPath || request.method !== 'GET') throw new Error(`Unexpected request: ${request.method} ${request.path}`)
    return jsonResponse({ status: 'ok', version: '7.52.0', ...body }, status)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><AccountProvider account={role ? { name: 'Person', role } : null}><AgentSetupPage /></AccountProvider></QueryClientProvider>)
  return requests
}

test.each(['', '/canonry/'])('copies the server’s hosted URL and preserves the local base path %j without browser secrets or starting work', async basePath => {
  window.__CANONRY_CONFIG__ = { basePath }
  const originalUrl = window.location.href
  const origin = window.location.origin
  window.history.replaceState(null, '', `${basePath || '/'}agent-setup?apiKey=query-secret#session=fragment-secret`)
  document.cookie = 'canonry_test_session=cookie-secret; Path=/'
  vi.stubEnv('VITE_API_KEY', 'cnry_browser-secret')
  onTestFinished(() => {
    window.history.replaceState(null, '', originalUrl)
    document.cookie = 'canonry_test_session=; Max-Age=0; Path=/'
  })
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  const requests = mount()

  await screen.findByText('Hosted setup configured')
  expect(screen.getByText('Local plugins and other MCP clients').closest('details')?.open).toBe(false)
  expect(screen.getByRole('link', { name: 'ChatGPT setup guide' }).getAttribute('href')).toBe('https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt')
  expect(screen.getByRole('link', { name: 'Claude Desktop setup guide' }).getAttribute('href')).toBe('https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp')
  fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  const instance = `${origin}${basePath ? '/canonry' : ''}`
  const prompt = writeText.mock.calls[0]![0]
  expect(prompt).toContain(`remote MCP URL: ${HOSTED_URL}\n`)
  expect(prompt).toContain('OAuth sign-in')
  expect(prompt).toContain('review the requested access before approving it')
  expect(prompt).toContain('Do not install software')
  expect(prompt).not.toMatch(/query-secret|fragment-secret|cookie-secret|cnry_browser-secret|canonry-mcp|codex plugin|claude plugin/)
  expect(prompt).not.toContain(`${instance}/api/v1/mcp`)

  fireEvent.click(screen.getByRole('button', { name: 'Copy MCP URL' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
  expect(writeText.mock.calls[1]![0]).toBe(HOSTED_URL)

  fireEvent.click(screen.getByRole('button', { name: 'Copy verification prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3))
  const verification = writeText.mock.calls[2]![0]
  expect(verification).toContain(`targets ${HOSTED_URL}.`)
  expect(verification).toContain('stored reads only')
  expect(verification).not.toMatch(/query-secret|fragment-secret|cookie-secret|cnry_browser-secret/)
  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy local setup prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(4))
  const localPrompt = writeText.mock.calls[3]![0]
  expect(localPrompt).toContain(`existing Canonry instance: ${instance}\n`)
  expect(localPrompt).not.toMatch(/query-secret|fragment-secret|cookie-secret|cnry_browser-secret/)
  fireEvent.click(screen.getByRole('button', { name: 'Copy local verification prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(5))
  expect(writeText.mock.calls[4]![0]).toContain(`targets ${instance}.`)
  expect(requests).toEqual([{ path: basePath ? '/canonry/health' : '/health', method: 'GET' }])
})

test.each([
  { label: 'unavailable transport', body: { mcp: { status: 'unavailable', hosted: { status: 'ready', url: HOSTED_URL } } }, status: 200, badge: 'Hosted setup not confirmed' },
  { label: 'unsupported deployment', body: { mcp: { status: 'not-supported' } }, status: 200, badge: 'Hosted setup not confirmed' },
  { label: 'missing metadata', body: {}, status: 200, badge: 'Hosted setup not confirmed' },
  { label: 'transport-only metadata', body: { mcp: { status: 'available' } }, status: 200, badge: 'Hosted setup not confirmed' },
  { label: 'failed health request', body: { mcp: { status: 'available', hosted: { status: 'ready', url: HOSTED_URL } } }, status: 503, badge: 'Hosted setup not confirmed' },
])('does not advertise hosted setup for $label', async ({ body, status, badge }) => {
  mount(body, status)
  await screen.findByText(badge)
  expect(screen.queryByRole('button', { name: 'Copy MCP URL' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy setup prompt' })).toBeNull()
  expect(screen.queryByText(HOSTED_URL)).toBeNull()
  expect(screen.queryByText('Hosted setup configured')).toBeNull()
  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  expect(screen.getByRole('button', { name: 'Copy local setup prompt' })).toBeTruthy()
})

test.each([
  { reason: 'public-url-required', message: 'Configure this instance’s public URL before connecting a hosted client.' },
  { reason: 'https-required', message: 'Configure an HTTPS public URL for this instance.' },
  { reason: 'public-host-required', message: 'Use a public HTTPS address that your client can reach. Localhost and private-network addresses do not work for hosted connectors.' },
  { reason: 'public-path-mismatch', message: 'Make the publicUrl path match basePath, and preserve that prefix when the proxy forwards requests for hosted OAuth.' },
  { reason: 'oauth-unavailable', message: 'The sign-in routes are unavailable. Check this instance’s OAuth configuration.' },
  { reason: 'account-required', message: 'Create a named Canonry account on this instance’s server with canonry user create. A shared dashboard password does not provide an OAuth account.' },
  { reason: 'transport-unavailable', message: 'Restore the instance’s HTTP MCP service before connecting a hosted client.' },
])('gives administrators the missing prerequisite for $reason without offering a hosted URL', async ({ reason, message }) => {
  mount({ mcp: { status: 'available', hosted: { status: 'unavailable', reason } } }, 200, 'admin')
  await screen.findByText('Hosted setup needs attention')
  expect(screen.getByText(message)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Copy MCP URL' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy setup prompt' })).toBeNull()
})

test('asks a viewer to contact an administrator instead of offering account creation', async () => {
  mount({ mcp: { status: 'available', hosted: { status: 'unavailable', reason: 'account-required' } } }, 200, 'viewer')
  await screen.findByText('Ask your Canonry administrator to finish hosted connection setup for this instance.')
  expect(screen.queryByText(/canonry user create/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy MCP URL' })).toBeNull()
})

test.each([
  { role: 'viewer', ready: true },
  { role: 'admin', ready: true },
  { role: 'viewer', ready: false },
  { role: 'admin', ready: false },
] as const)('keeps local instructions hidden for a $role when hosted readiness is $ready and local setup is disabled', async ({ role, ready }) => {
  window.__CANONRY_CONFIG__ = { dashboard: { showLocalAgentSetup: false } }
  mount({ mcp: { status: 'available', hosted: ready ? { status: 'ready', url: HOSTED_URL } : { status: 'unavailable', reason: 'account-required' } } }, 200, role)

  await screen.findByText(ready ? 'Hosted setup configured' : 'Hosted setup needs attention')
  expect(screen.getByText('Connect ChatGPT or Claude Desktop to this instance.')).toBeTruthy()
  expect(screen.queryByText(/or another agent/)).toBeNull()
  expect(screen.queryByText('Local plugins and other MCP clients')).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Your client' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy local setup prompt' })).toBeNull()
  expect(screen.queryByText(/canonry user create|codex plugin|claude plugin|canonry-mcp/)).toBeNull()
  if (ready) {
    expect(screen.getByRole('button', { name: 'Copy MCP URL' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '2. Sign in and approve access' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy verification prompt' })).toBeTruthy()
  } else {
    expect(screen.getByText('Ask your Canonry administrator to finish hosted connection setup for this instance.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy MCP URL' })).toBeNull()
  }
})

test('hides optional resource links and copied references while keeping client help and local setup available', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { showLocalAgentSetup: true, showResourceLinks: false } }
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  mount()
  await screen.findByText('Hosted setup configured')
  expect(screen.getByRole('link', { name: 'ChatGPT setup guide' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Claude Desktop setup guide' })).toBeTruthy()
  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  expect(screen.queryByRole('link', { name: 'Runtime and plugin instructions' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy local setup prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  expect(writeText.mock.calls[0]![0]).not.toContain('github.com')
  expect(writeText.mock.calls[0]![0]).toContain('Check the saved API URL before using it.')
  expect(screen.getByRole('button', { name: 'Copy install commands' })).toBeTruthy()
})

test.each(['unconfirmed', 'demo', 'embed'] as const)('hides connection documentation in the %s view when resource links are disabled', async mode => {
  window.__CANONRY_CONFIG__ = {
    dashboard: { showResourceLinks: false, showLocalAgentSetup: false },
    ...(mode === 'demo' ? { demo: { enabled: true, readOnly: true, sampleData: true } } : {}),
    ...(mode === 'embed' ? { embed: { enabled: true } } : {}),
  }
  mount({})
  if (mode === 'unconfirmed') await screen.findByText('Hosted setup not confirmed')
  expect(screen.queryByRole('link', { name: 'Read the connection guide' })).toBeNull()
  expect(screen.queryByText('Local plugins and other MCP clients')).toBeNull()
})

test.each(['denied', 'missing'] as const)('keeps the hosted URL selectable when clipboard access is %s', async failure => {
  setClipboard(failure === 'denied' ? { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } : undefined)
  mount()
  await screen.findByText('Hosted setup configured')
  fireEvent.click(screen.getByRole('button', { name: 'Copy MCP URL' }))

  const fallback = await screen.findByRole('textbox', { name: 'Copy MCP URL text' }) as HTMLTextAreaElement
  expect(fallback.closest('details')?.open).toBe(true)
  expect(fallback.readOnly).toBe(true)
  expect(fallback.disabled).toBe(false)
  expect(fallback.value).toBe(HOSTED_URL)
  fallback.focus()
  fallback.select()
  expect(document.activeElement).toBe(fallback)
  expect(fallback.selectionEnd - fallback.selectionStart).toBe(fallback.value.length)
  expect(screen.queryByRole('status')).toBeNull()
})

test('copies the selected client commands and replaces the previous copy acknowledgement', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  const requests = mount()
  await screen.findByText('Hosted setup configured')
  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy install commands' }))
  await screen.findByRole('status')
  expect(writeText.mock.calls[0]![0]).toBe('codex plugin marketplace add Canonry/canonry\ncodex plugin add canonry@canonry')

  fireEvent.change(screen.getByRole('combobox', { name: 'Your client' }), { target: { value: 'claude' } })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy install commands' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
  expect(writeText.mock.calls[1]![0]).toBe('claude plugin marketplace add Canonry/canonry\nclaude plugin install canonry@canonry')

  fireEvent.change(screen.getByRole('combobox', { name: 'Your client' }), { target: { value: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: 'Copy MCP command' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3))
  expect(writeText.mock.calls[2]![0]).toBe('canonry-mcp')
  expect(requests).toEqual([{ path: '/health', method: 'GET' }])
})

test('records only successful copies as schema-valid actions without copied content', async () => {
  const sent: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async event => { sent.push(event); return { accepted: true } } })
  setUiPageFromRoute('/agent-setup')
  const writeText = vi.fn<(text: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('Permission denied'))
    .mockResolvedValue(undefined)
  setClipboard({ writeText })
  mount()
  await screen.findByText('Hosted setup configured')
  fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
  await screen.findByText('Copy unavailable. Select the text below.')
  expect(sent.filter(event => event.event === 'ui.action')).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
  await waitFor(() => expect(sent.filter(event => event.event === 'ui.action')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Copy verification prompt' }))
  await waitFor(() => expect(sent.filter(event => event.event === 'ui.action')).toHaveLength(2))
  expect(sent).toEqual([
    { event: 'ui.page_viewed', page: '/agent-setup', eventId: expect.any(String), uiSessionId: expect.any(String) },
    { event: 'ui.action', action: 'agent_setup.copy', page: '/agent-setup', eventId: expect.any(String), uiSessionId: expect.any(String) },
    { event: 'ui.action', action: 'agent_setup.verify_copy', page: '/agent-setup', eventId: expect.any(String), uiSessionId: expect.any(String) },
  ])
  for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
})

test.each(['demo', 'embed'] as const)('%s does not offer instance connection prompts or probe health', mode => {
  window.__CANONRY_CONFIG__ = mode === 'demo'
    ? { demo: { enabled: true, readOnly: true, sampleData: true } }
    : { embed: { enabled: true } }
  const requests = mount()
  expect(screen.getByRole('link', { name: 'Read the connection guide' }).getAttribute('href')).toBe('https://github.com/Canonry/canonry/blob/main/docs/mcp.md')
  expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(requests).toEqual([])
})
