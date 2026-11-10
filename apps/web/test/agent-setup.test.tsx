import React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { uiTelemetryEventSchema, type UiTelemetryEvent } from '@canonry/canonry-contracts'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'

import { AgentSetupPage } from '../src/pages/AgentSetupPage.js'
import { AGENT_SETUP_REQUEST, agentSetupRequest } from '../src/lib/agent-setup-request.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { configureUiTelemetry, resetUiTelemetryForTests, setUiPageFromRoute } from '../src/lib/ui-telemetry.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

// jsdom serves the page from localhost; a test can pretend the dashboard is on another computer.
const dashboardHost = vi.hoisted(() => ({ remote: false }))
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>()
  return { ...actual, isLoopbackHostname: (hostname: string) => !dashboardHost.remote && actual.isLoopbackHostname(hostname) }
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
  vi.unstubAllEnvs()
  resetUiTelemetryForTests()
  dashboardHost.remote = false
})

/** The README's Quick start, read from the repository root. */
function readme(): string {
  let dir = resolve(process.cwd())
  while (!existsSync(join(dir, 'pnpm-workspace.yaml')) && dirname(dir) !== dir) dir = dirname(dir)
  return readFileSync(join(dir, 'README.md'), 'utf8')
}

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
  // Without hosted setup, the agent on this computer leads, already open.
  expect(screen.queryByText('Local plugins and other MCP clients')).toBeNull()
  expect(screen.getByRole('button', { name: 'Copy setup request' })).toBeTruthy()
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
  expect(screen.getByRole('button', { name: 'Copy Claude Code commands' })).toBeTruthy()
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

test('copies each client’s plugin commands exactly as the README lists them', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  const requests = mount()
  await screen.findByText('Hosted setup configured')
  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  expect(screen.queryByRole('combobox', { name: 'Your client' })).toBeNull()
  for (const [index, button] of ['Copy Claude Code commands', 'Copy Codex commands', 'Copy MCP command'].entries()) {
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(index + 1))
  }
  const [claude, codex, mcp] = writeText.mock.calls.map(call => call[0])
  expect(claude).toBe('claude plugin marketplace add Canonry/canonry\nclaude plugin install canonry@canonry')
  expect(codex).toBe('codex plugin marketplace add Canonry/canonry\ncodex plugin add canonry@canonry')
  expect(mcp).toBe('canonry-mcp')

  // The local-first install in the README lists the same commands, so either one works.
  const text = readme()
  const fence = '```'
  const start = text.indexOf(`### With the plugin\n\n${fence}bash\n`)
  expect(start).toBeGreaterThan(-1)
  const body = text.slice(start + `### With the plugin\n\n${fence}bash\n`.length)
  expect(body.slice(0, body.indexOf(`\n${fence}`))).toBe(`# Claude Code\n${claude}\n\n# Codex\n${codex}`)
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

test('leads with this workspace’s Canonry plugin steps when the instance is registered with a gateway', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  mount({ mcp: { status: 'available', hosted: { status: 'ready', url: HOSTED_URL, plugin: { gatewayUrl: 'https://mcp.example/mcp', workspace: 'tenant.example' } } } }, 200, 'viewer')
  await screen.findByRole('heading', { name: 'Use the Canonry plugin' })
  expect(screen.getByText('tenant.example')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Copy plugin install commands' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  expect(writeText.mock.calls[0]![0]).toBe('codex plugin marketplace add Canonry/canonry\ncodex plugin add canonry-remote@canonry')
  fireEvent.click(screen.getByRole('button', { name: 'Copy workspace' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
  expect(writeText.mock.calls[1]![0]).toBe('tenant.example')

  // Direct connection stays available for Claude and other clients, collapsed.
  const direct = screen.getByText('Connect directly (Claude and other MCP clients)').closest('details')
  expect(direct?.open).toBe(false)
  fireEvent.click(screen.getByText('Connect directly (Claude and other MCP clients)'))
  expect(screen.getByRole('button', { name: 'Copy MCP URL' })).toBeTruthy()
  expect(screen.getByText(/In Claude, set the OAuth client to “Register automatically”/)).toBeTruthy()
})

test('keeps the direct connection as the only path without a registered gateway', async () => {
  mount()
  await screen.findByText('Hosted setup configured')
  expect(screen.queryByRole('heading', { name: 'Use the Canonry plugin' })).toBeNull()
  expect(screen.queryByText('Connect directly (Claude and other MCP clients)')).toBeNull()
  expect(screen.getByRole('button', { name: 'Copy MCP URL' })).toBeTruthy()
  expect(screen.getByText(/On Claude Team and Enterprise plans, an Owner adds the connector first/)).toBeTruthy()
})

test.each([true, false])('leads with the README setup request and plugin commands when hosted setup is not ready (resource links: %s)', async showResourceLinks => {
  window.__CANONRY_CONFIG__ = { dashboard: { showResourceLinks } }
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  mount({ mcp: { status: 'available', hosted: { status: 'unavailable', reason: 'public-url-required' } } }, 200, 'admin')

  await screen.findByText('Hosted setup needs attention')
  // Local setup comes first and open; hosted clients follow with their status beside their heading.
  const setup = screen.getByRole('heading', { name: 'Set up with your agent' })
  const plugin = screen.getByRole('heading', { name: 'Or use the plugin' })
  const hostedClients = screen.getByRole('heading', { name: 'Connect ChatGPT or Claude Desktop' })
  expect(setup.compareDocumentPosition(plugin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(plugin.compareDocumentPosition(hostedClients) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(hostedClients.parentElement?.textContent).toContain('Hosted setup needs attention')
  expect(screen.getByText('Configure this instance’s public URL before connecting a hosted client.')).toBeTruthy()
  expect(screen.queryByText('Local plugins and other MCP clients')).toBeNull()
  expect(screen.getByRole('button', { name: 'Copy Claude Code commands' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy local verification prompt' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Copy setup request' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  const request = writeText.mock.calls[0]![0]
  // The README's request, then the one line only the dashboard can add: which install serves it.
  const readmeRequest = agentSetupRequest(showResourceLinks)
  expect(readmeRequest === AGENT_SETUP_REQUEST).toBe(showResourceLinks)
  expect(request).toBe(`${readmeRequest}\n\nThis Canonry dashboard is already running at ${window.location.origin}. Work only with the install that serves it. If \`cnry doctor\` reports no config, or you cannot confirm your config belongs to this dashboard, stop and ask me which config folder it uses, then pass that folder as \`CANONRY_CONFIG_DIR\` on every \`cnry\` command. Do not bootstrap, start, or create another install.`)
  expect(request.includes('github.com')).toBe(showResourceLinks)
})

test('the README carries the same setup request the dashboard copies', () => {
  // Two hand-maintained copies of the same instructions, and they had already
  // drifted: the README's was missing the bounded page budget and the
  // scan-reuse rule. Whichever one an operator finds has to be the live one.
  const text = readme()
  const fence = '```'
  const start = text.indexOf(`${fence}text\nHelp me set up Canonry for my public site.`)
  expect(start).toBeGreaterThan(-1)
  const body = text.slice(start + fence.length + 'text\n'.length)
  expect(body.slice(0, body.indexOf(`\n${fence}`))).toBe(AGENT_SETUP_REQUEST)
})

test('the setup request asks before it acts, bounds the first scan, and never asks for secrets', () => {
  // It learns what to set up before it touches the install.
  expect(AGENT_SETUP_REQUEST.indexOf('Ask for my public domain')).toBeLessThan(AGENT_SETUP_REQUEST.indexOf('cnry start'))
  expect(AGENT_SETUP_REQUEST).toContain('propose `npm install -g @canonry/canonry` and wait for approval')
  // It reuses what exists instead of creating or scanning twice.
  expect(AGENT_SETUP_REQUEST).toContain('cnry project list --format json')
  expect(AGENT_SETUP_REQUEST).toContain('read that scan instead of starting a new one')
  // The crawl is its own approval, and the first one is bounded.
  expect(AGENT_SETUP_REQUEST).toContain('wait for separate approval before scanning')
  expect(AGENT_SETUP_REQUEST).toContain('--max-pages 100')
  expect(AGENT_SETUP_REQUEST).toContain('never ask me to paste passwords, API keys, OAuth credentials, or command output')
  expect(AGENT_SETUP_REQUEST).toContain('Tell me the termination reason in plain words')
})

test('the setup request cannot strand an agent or point it at the wrong install', () => {
  // Each of these is a failure a fresh agent actually hit when following an
  // earlier version of this text.
  // A connected tool cannot see a shell env var, so "prefer connected tools"
  // silently acted on the operator's real install.
  expect(AGENT_SETUP_REQUEST).toContain('never sees `CANONRY_CONFIG_DIR`')
  // `bootstrap` is not interactive; handing it over and waiting deadlocks.
  expect(AGENT_SETUP_REQUEST).toContain('run `cnry bootstrap` yourself')
  expect(AGENT_SETUP_REQUEST).toContain('The interactive command is `cnry init`')
  expect(AGENT_SETUP_REQUEST).not.toContain('tell me to run `cnry bootstrap`')
  // `cnry --version` succeeds on an unconfigured install, so it cannot detect
  // missing config; `doctor` is the command that can.
  expect(AGENT_SETUP_REQUEST).toContain('cnry doctor --format json')
  expect(AGENT_SETUP_REQUEST).toContain('does not read config')
  // The product's own CONNECTION_ERROR text recommends the foreground command.
  expect(AGENT_SETUP_REQUEST).toContain('not `cnry serve`, which runs in the foreground')
  // `score` reports aggregateScore 0 with hasData false for a never-scanned
  // project, which reads as a real score of zero.
  expect(AGENT_SETUP_REQUEST).toContain('Read the `hasData` field, not the score')
  // Neither `score` nor `pages` carries the termination reason.
  expect(AGENT_SETUP_REQUEST).toContain('agent-readiness overview')
  expect(AGENT_SETUP_REQUEST).toContain('only one of these commands that carries `termination`')
  // `--wait` gives up after 15 minutes and exits 0 with a non-terminal status,
  // which must not read as a finished scan. Rerunning is the wrong recovery.
  expect(AGENT_SETUP_REQUEST).toContain('polls for up to 15 minutes')
  expect(AGENT_SETUP_REQUEST).toContain('the scan has not finished')
  expect(AGENT_SETUP_REQUEST).not.toContain('no timeout')
  expect(AGENT_SETUP_REQUEST).toContain('agent-readiness progress')
  expect(AGENT_SETUP_REQUEST).toContain('do not rerun it')
  // A time limit needs a SMALLER scan, which is the counterintuitive direction.
  expect(AGENT_SETUP_REQUEST).toContain('a time limit needs a smaller scan')
  expect(AGENT_SETUP_REQUEST).toContain('never present it as a full-site result')
})

test.each([
  { label: 'needs attention', hosted: { status: 'unavailable', reason: 'account-required' }, badge: 'Hosted setup needs attention' },
  { label: 'is ready', hosted: { status: 'ready', url: HOSTED_URL }, badge: 'Hosted setup configured' },
])('a hosted deployment leads with hosted setup when it $label, with local setup collapsed', async ({ hosted, badge }) => {
  dashboardHost.remote = true
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  setClipboard({ writeText })
  mount({ mcp: { status: 'available', hosted } }, 200, 'admin')

  await screen.findByText(badge)
  expect(screen.queryByRole('heading', { name: 'Set up with your agent' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy setup request' })).toBeNull()
  const local = screen.getByText('Local plugins and other MCP clients').closest('details')!
  expect(local.open).toBe(false)
  // Hosted setup comes before the collapsed local instructions.
  const hostedStep = screen.queryByRole('heading', { name: 'Before you connect a hosted client' }) ?? screen.getByRole('heading', { name: '1. Add Canonry to your client' })
  expect(hostedStep.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  fireEvent.click(screen.getByText('Local plugins and other MCP clients'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy local setup prompt' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  expect(writeText.mock.calls[0]![0]).toContain(`existing Canonry instance: ${window.location.origin}\n`)
  expect(writeText.mock.calls[0]![0]).not.toContain('Help me set up Canonry')
  expect(screen.getByRole('button', { name: 'Copy Codex commands' })).toBeTruthy()
})
