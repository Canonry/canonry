import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey } from '@ainyc/canonry-api-client/react-query'
import type { ReactNode } from 'react'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { clearOnboardingRunLaunched } from '../src/lib/onboarding-telemetry.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ children, to, target, rel }: { children: ReactNode; to: string; target?: string; rel?: string }) => <a href={to} target={target} rel={rel}>{children}</a>,
  }
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
  navigate.mockReset()
  clearOnboardingRunLaunched()
})

function renderProjectSetup(options: {
  onboarding: boolean
  complete?: boolean
  providerReady?: boolean
  projectProviders?: string[]
  readyProviderNames?: string[]
  cdpStatus?: { connected?: boolean; browserVersion?: string }
  cdpResponse?: () => Response | Promise<Response>
  apiKey?: ApiKeyAccess
  queryResponse?: () => Response | Promise<Response>
  providerResponse?: () => Response | Promise<Response>
  includeLocalProvider?: boolean
}) {
  const fixture = createDashboardFixture()
  // Match the key destinations published by the provider adapter catalog.
  const providerKeyUrls: Record<string, string> = {
    gemini: 'https://aistudio.google.com/apikey',
    claude: 'https://platform.claude.com/settings/keys',
  }
  fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({
    ...provider,
    keyUrl: providerKeyUrls[provider.name.toLowerCase()] ?? provider.keyUrl,
  }))
  const project = structuredClone(fixture.dashboard.projects[0]!)
  project.project.providers = options.projectProviders ?? project.project.providers
  fixture.dashboard.projects = [project]
  fixture.dashboard.runs = options.complete
    ? fixture.dashboard.runs.filter(run => run.projectId === project.project.id)
    : []

  if (!options.complete) {
    project.queryCounts = { cited: 0, total: 0 }
    project.competitors = []
  }
  if (options.providerReady === false) {
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({ ...provider, state: 'needs-config' }))
  } else if (options.readyProviderNames) {
    const ready = new Set(options.readyProviderNames.map(name => name.toLowerCase()))
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({
      ...provider,
      state: ready.has(provider.name.toLowerCase()) ? 'ready' as const : 'needs-config' as const,
    }))
  }
  if (options.includeLocalProvider) {
    fixture.dashboard.settings.providerStatuses.push({ name: 'local', state: 'needs-config', detail: 'Base URL is missing.' })
  }

  const requests: Array<{ path: string; method?: string; body?: RequestInit['body'] }> = []
  const restore = mockFetch((url, init) => {
    requests.push({ path: pathOf(url), method: init?.method, body: init?.body })
    if (pathOf(url) === '/api/v1/projects' || pathOf(url).split('?')[0] === '/api/v1/runs') return jsonResponse([])
    if (pathOf(url) === '/api/v1/settings') return jsonResponse({ providers: [] })
    if (pathOf(url).endsWith('/measurement-setup')) return jsonResponse({ answerVisibilityProviderReady: options.providerReady !== false })
    if (pathOf(url) === '/api/v1/cdp/status') return options.cdpResponse?.() ?? jsonResponse(options.cdpStatus ?? {})
    if (pathOf(url).startsWith('/api/v1/settings/providers/')) return options.providerResponse?.() ?? jsonResponse({ name: 'gemini', configured: true })
    if (pathOf(url).endsWith('/queries')) {
      if (options.queryResponse) return options.queryResponse()
      return jsonResponse(options.complete ? [{ id: 'query-1', query: 'best local dentist' }] : [])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={options.apiKey}>
        <DashboardProvider value={fixture}>
          <SetupPage
            visibilityProjectName={project.project.name}
            siteHealthOnboarding={options.onboarding}
          />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>
  )
  const rendered = render(content())

  return {
    projectId: project.project.id,
    projectName: project.project.name,
    domain: project.project.canonicalDomain,
    queryClient,
    requests,
    markProviderReady: (name: string) => {
      fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => (
        provider.name.toLowerCase() === name.toLowerCase() ? { ...provider, state: 'ready' } : provider
      ))
      rendered.rerender(content())
    },
  }
}

test('marks AI Visibility as the optional final onboarding stage and can skip to the project', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.getByText('Step 1 of 2')).toBeTruthy()
  expect(screen.queryByText('System check')).toBeNull()
  expect(screen.queryByText('Create project')).toBeNull()
  expect(screen.queryByText('Competitors')).toBeNull()
  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(progress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith({
      to: '/projects/$projectName/technical-aeo',
      params: { projectName },
      replace: true,
    })
  })
})

test('allows a project-scoped write key to configure its exact project', async () => {
  renderProjectSetup({
    onboarding: true,
    apiKey: {
      id: 'project-writer',
      scopes: ['*'],
      projectId: 'project_citypoint',
      readOnly: false,
    },
  })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByText(/for administrators/i)).toBeNull()
  expect(screen.getByText(/Provider settings are managed by an administrator/)).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
})

test('keeps Gemini onboarding guidance out of administrator-only setup for a read-only key', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    apiKey: { id: 'read-only-key', scopes: ['read'], projectId: null, readOnly: true },
  })
  expect(await screen.findByText('Set up AI Visibility is for administrators')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
})

test('introduces Gemini free-tier setup before the API key field with its limits and official links', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })
  const heading = await screen.findByRole('heading', { name: 'Start with Gemini’s free tier' })
  const keyInput = screen.getByLabelText('API key')
  expect(heading.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const keyLink = screen.getByRole('link', { name: 'Get a free Gemini API key ↗' })
  expect(keyLink.getAttribute('href')).toBe('https://aistudio.google.com/apikey')
  expect(keyLink.getAttribute('target')).toBe('_blank')
  expect(keyLink.getAttribute('rel')).toContain('noopener')
  expect(screen.getByText('Get a key in Google AI Studio, then paste it below. Free usage has model and rate limits; paid usage is billed by Google.')).toBeTruthy()
  const pricingLink = screen.getByRole('link', { name: 'Pricing and limits' })
  expect(pricingLink.getAttribute('href')).toBe('https://ai.google.dev/gemini-api/docs/pricing')
  expect(pricingLink.getAttribute('target')).toBe('_blank')
  expect(screen.queryByRole('link', { name: 'Get API key ↗' })).toBeNull()
})

test('switches Gemini free-tier guidance with the selected provider and preserves other key links', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false })
  expect(await screen.findByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeTruthy()
  const provider = screen.getByLabelText('Provider to connect')
  fireEvent.change(provider, { target: { value: 'Claude' } })
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Pricing and limits' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Get API key ↗' }).getAttribute('href')).toBe('https://platform.claude.com/settings/keys')

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  expect(screen.getByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Get API key ↗' })).toBeNull()
  expect(requests.filter(request => request.method === 'PUT')).toEqual([])
})

test('keeps provider-switch keyboard focus while resetting credentials and advanced fields', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false, includeLocalProvider: true })
  const queries = await screen.findByLabelText('Queries (one per line)')
  fireEvent.change(queries, { target: { value: 'keep this query draft' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-gemini-key' } })
  const advanced = screen.getByText('Advanced provider settings').closest('details')!
  advanced.open = true
  fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: 'gemini-test-model' } })
  fireEvent.change(screen.getByPlaceholderText('Concurrent'), { target: { value: '3' } })

  const selector = screen.getByLabelText('Provider to connect') as HTMLSelectElement
  selector.focus()
  fireEvent.change(selector, { target: { value: 'Claude' } })
  expect(document.activeElement).toBe(screen.getByLabelText('Provider to connect'))
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Model (optional)') as HTMLInputElement).value).toBe('')
  expect((screen.getByPlaceholderText('Concurrent') as HTMLInputElement).value).toBe('')
  expect(screen.getByText('Advanced provider settings').closest('details')?.open).toBe(false)
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query draft')

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  expect(document.activeElement).toBe(screen.getByLabelText('Provider to connect'))
  expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('')
  expect(requests.filter(request => request.method === 'PUT')).toEqual([])
})

function renderColdScopedSetup(readinessResponse: () => Response | Promise<Response>, existingRun?: {
  status: 'queued' | 'running' | 'failed' | 'completed'
  error?: { message: string }
  snapshots?: Array<{ query: string; citationState: string; answerMentioned: boolean }>
}) {
  const project = { ...createDashboardFixture().dashboard.projects[0]!.project, name: 'scoped-project', providers: ['gemini'] }
  const requests: string[] = []
  const telemetryEvents: Array<{ event: string }> = []
  const run = { id: 'scoped-run', projectId: project.id, projectName: project.name, kind: 'answer-visibility', status: 'queued', createdAt: '2026-09-05T12:00:00Z', ...existingRun }
  let queries = [{ id: 'saved-query', query: 'best local dentist' }]
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    requests.push(path)
    if (path === '/api/v1/projects') return jsonResponse([project])
    if (path.split('?')[0] === '/api/v1/runs') return jsonResponse(existingRun ? [run] : [])
    if (path === '/api/v1/settings') return jsonResponse({ providers: [{ name: 'gemini', configured: true }] })
    if (path.endsWith('/measurement-setup')) return readinessResponse()
    if (path === '/api/v1/projects/scoped-project/runs' && init?.method === 'POST') return jsonResponse(run, 202)
    if (path === '/api/v1/runs/scoped-run') return jsonResponse(run)
    if (path.endsWith('/queries')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { queries: string[] }
        queries = body.queries.map((query, index) => ({ id: `query-${index}`, query }))
      }
      return jsonResponse(queries)
    }
    if (path === '/health') return jsonResponse({ version: 'test', databaseUrlConfigured: true })
    if (path.endsWith('/telemetry/onboarding')) {
      telemetryEvents.push(JSON.parse(String(init?.body)) as { event: string })
      return jsonResponse({ accepted: true })
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'No stored overview' } }, 404)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={{ id: 'scoped-writer', scopes: ['*'], projectId: project.id, readOnly: false }}>
        <SetupPage visibilityProjectName={project.name} siteHealthOnboarding />
      </AccountProvider>
    </QueryClientProvider>,
  )
  onTestFinished(() => { queryClient.clear() })
  return { requests, queryClient, telemetryEvents }
}

test('uses project-readable provider readiness for a cold scoped-writer setup', async () => {
  const { requests, queryClient, telemetryEvents } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(queryClient.getQueryState(['health'])?.status).toBe('success'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement).disabled).toBe(false))
  expect(requests).toContain('/api/v1/projects/scoped-project/measurement-setup')
  expect(requests).not.toContain('/api/v1/settings')
  expect(requests).not.toContain('/api/v1/cdp/status')
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Launch visibility sweep' }))
  expect(await screen.findByText('Sweep running. This usually takes 30 to 60 seconds.')).toBeTruthy()
  expect(requests).toContain('/api/v1/projects/scoped-project/runs')
  expect(requests).not.toContain('/api/v1/settings')
  expect(telemetryEvents.some(event => event.event === 'run.requested')).toBe(false)
})

test('keeps scoped-writer launch blocked while project provider readiness loads', async () => {
  let resolveReadiness: ((response: Response) => void) | undefined
  renderColdScopedSetup(() => new Promise(resolve => { resolveReadiness = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement
  expect(launch.disabled).toBe(true)
  expect(launch.title).toBe('Checking provider readiness before launch.')
  expect(screen.queryByText(/Launch is blocked until a provider allowed by this project/)).toBeNull()
  await waitFor(() => expect(resolveReadiness).toBeTypeOf('function'))
  resolveReadiness?.(jsonResponse({ answerVisibilityProviderReady: true }))
  await waitFor(() => expect(launch.disabled).toBe(false))
})

test('retries a failed scoped-provider readiness read without losing the query draft', async () => {
  let attempts = 0
  const { requests } = renderColdScopedSetup(() => ++attempts === 1
    ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Temporary readiness failure' } }, 503)
    : jsonResponse({ answerVisibilityProviderReady: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit queries' }))
  fireEvent.change(screen.getByLabelText('Queries (one per line)'), { target: { value: 'keep this query draft' } })
  expect(await screen.findByText('Provider readiness could not be checked. Try again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry provider check' }))
  expect(await screen.findByText('An answer engine is available for this project.')).toBeTruthy()
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query draft')
  expect(attempts).toBe(2)
  expect(requests).not.toContain('/api/v1/settings')
})

test('does not keep a stale ready result after a scoped-provider refresh fails', async () => {
  let attempts = 0
  renderColdScopedSetup(() => ++attempts === 1
    ? jsonResponse({ answerVisibilityProviderReady: true })
    : jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Temporary readiness failure' } }, 503))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  const providerSection = within(screen.getByRole('region', { name: 'Answer engine provider' }))
  expect(await providerSection.findByText('Provider readiness could not be checked. Try again.')).toBeTruthy()
  expect(launch.disabled).toBe(true)
  expect(launch.title).toBe('Provider readiness could not be checked. Try again.')
})

test('keeps a confirmed missing provider blocked for scoped writers without credential controls', async () => {
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: false }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement
  await waitFor(() => expect(launch.title).toBe('Launch is blocked until a provider allowed by this project is configured.'))
  expect(launch.disabled).toBe(true)
  expect(screen.getByText('Ask an administrator to connect an answer engine for this project. You can save queries now.')).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
})

test('keeps a stale project-list handoff scoped to the exact onboarding project', async () => {
  const fixture = createDashboardFixture()
  fixture.dashboard.projects = []
  fixture.dashboard.runs = []
  const projectName = 'newly-created-project'
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={fixture}>
        <SetupPage visibilityProjectName={projectName} siteHealthOnboarding />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName/technical-aeo',
    params: { projectName },
    replace: true,
  })
})

test('finishing the project-scoped onboarding replaces the wizard with the project', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true, complete: true })

  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Finish and open project' }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName/technical-aeo',
    params: { projectName },
    replace: true,
  })
})

test('keeps the existing project-scoped setup destination outside Site Health onboarding', async () => {
  const { projectName } = renderProjectSetup({ onboarding: false, complete: true })

  expect(screen.queryByRole('list', { name: 'Onboarding progress' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Skip AI Visibility' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open project dashboard/ }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName',
    params: { projectName },
    replace: true,
  })
})

test('lets an existing query list be refined with researched queries before continuing', async () => {
  const { projectName, requests } = renderProjectSetup({ onboarding: true, complete: true })
  expect(await screen.findByText('best local dentist')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  const input = screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement
  expect(input.value).toBe('best local dentist')
  fireEvent.change(input, { target: { value: 'best local dentist\nresearched dental query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 2 queries' }))
  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(requests.find(request => request.method === 'PUT' && request.path === `/api/v1/projects/${encodeURIComponent(projectName)}/queries`)).toMatchObject({
    body: JSON.stringify({ queries: ['best local dentist', 'researched dental query'] }),
  })
})

test('lets a project save queries before a provider is configured', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })

  const queries = await screen.findByLabelText('Queries (one per line)')
  fireEvent.change(queries, { target: { value: 'best local dentist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Connect a provider' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
})

test('offers provider setup before queries and keeps the draft after saving and refreshing readiness', async () => {
  const { requests, markProviderReady } = renderProjectSetup({ onboarding: true, providerReady: false })
  const providerHeading = await screen.findByRole('heading', { name: 'Connect a provider' })
  const queryHeading = screen.getByRole('heading', { name: 'Add queries' })
  expect(providerHeading.compareDocumentPosition(queryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const saveConnection = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement
  expect(saveConnection.disabled).toBe(true)
  expect(saveConnection.parentElement).toBe(screen.getByRole('button', { name: 'Check again' }).parentElement)
  expect(screen.getByRole('region', { name: 'Add queries' }).tagName).toBe('SECTION')
  expect(screen.getByRole('list', { name: 'Onboarding progress' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  expect(screen.getByText('Advanced provider settings').closest('details')?.open).toBe(false)
  // This is a provider secret, not the dashboard login password.
  const apiKeyField = screen.getByLabelText('API key')
  expect(apiKeyField.getAttribute('autocomplete')).toBe('new-password')
  expect(apiKeyField.getAttribute('autocapitalize')).toBe('none')
  expect(apiKeyField.getAttribute('spellcheck')).toBe('false')

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'unsubmitted customer question' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  expect(requests.find(request => request.path === '/api/v1/settings/providers/gemini')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ apiKey: 'synthetic-test-key' }),
  })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(requests.some(request => request.path === '/api/v1/settings')).toBe(true)
  expect(screen.getByRole('heading', { name: 'Connect a provider' })).toBeTruthy()

  // Readiness comes from refreshed settings, not an optimistic key-save result.
  markProviderReady('gemini')
  expect(await screen.findByText('Configured')).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(navigate).not.toHaveBeenCalled()
  expect(requests.filter(request => request.method === 'POST' && /\/(?:runs|generate)$/.test(request.path))).toEqual([])
})

test('keeps failed provider setup retryable without losing queries', async () => {
  let attempt = 0
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    providerResponse: () => ++attempt === 1
      ? jsonResponse({ error: { message: 'Key could not be saved', code: 'VALIDATION_ERROR' } }, 400)
      : jsonResponse({ name: 'gemini', configured: true }),
  })
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'keep this query' } })
  const keyInput = await screen.findByLabelText('API key')
  fireEvent.change(keyInput, { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Key could not be saved')).toBeTruthy()
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query')
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Provider updated.')).toBeTruthy()
})

test('requires the local endpoint, not an API key, when Local is selected', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false, projectProviders: ['local'], includeLocalProvider: true })
  const baseUrl = await screen.findByLabelText('Base URL')
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.getByLabelText('API key (optional)')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(baseUrl, { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  expect(requests.find(request => request.path === '/api/v1/settings/providers/local')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ baseUrl: 'http://localhost:11434/v1' }),
  })
})

test('keeps unknown browser readiness distinct from missing configuration', async () => {
  let resolveCdp: ((response: Response) => void) | undefined
  renderProjectSetup({
    onboarding: true, providerReady: false,
    cdpResponse: () => new Promise<Response>(resolve => { resolveCdp = resolve }),
  })
  expect(await screen.findByText('Checking available providers. You can choose queries while this finishes.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Connect a provider' })).toBeNull()
  expect(screen.queryByText('Not connected')).toBeNull()
  await waitFor(() => expect(resolveCdp).toBeTypeOf('function'))
  resolveCdp?.(jsonResponse({}))
  expect(await screen.findByRole('heading', { name: 'Connect a provider' })).toBeTruthy()
})

test('copies a project-specific Research request without starting provider work or changing tracking', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  const { projectName, domain, requests } = renderProjectSetup({ onboarding: true, providerReady: false })
  fireEvent.click(await screen.findByRole('button', { name: 'Copy research prompt' }))
  expect(await screen.findByRole('button', { name: 'Research prompt copied' })).toBeTruthy()
  const prompt = writeText.mock.calls[0]?.[0] as string
  expect(prompt).toContain(projectName)
  expect(prompt).toContain(domain)
  expect(prompt).toContain("Canonry's Research flow")
  expect(prompt).toContain('saved answers and any available sources')
  expect(prompt).toContain('unavailable citation evidence is not a "not cited" result')
  expect(prompt).toContain('Text-only routes can inform query research but cannot establish an AI Visibility baseline')
  expect(prompt).toContain('Research does not add queries to tracking')
  expect(prompt).toContain("configured connection's capabilities")
  expect(prompt).toContain('preserve existing queries')
  expect(prompt).toContain('Do not change tracked queries or launch a visibility sweep')
  expect(prompt).toContain('for me to paste into setup')
  expect(requests.filter(request => request.method === 'POST' && /\/(?:runs|queries|generate)$/.test(request.path))).toEqual([])
})

test('offers a selectable research prompt if clipboard access fails', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  renderProjectSetup({ onboarding: true })
  fireEvent.click(screen.getByRole('button', { name: 'Copy research prompt' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not copy. Select and copy the prompt above.')
  expect(screen.getByLabelText('Agent query research prompt').closest('details')?.open).toBe(true)
})

test('blocks launch when the ready provider is outside the project allowlist', async () => {
  renderProjectSetup({
    onboarding: true,
    projectProviders: ['claude'],
    readyProviderNames: ['gemini'],
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByText(/provider allowed by this project/i)).toBeTruthy()
  expect((screen.getByLabelText('Provider to connect') as HTMLSelectElement).value).toBe('Claude')
  expect(within(screen.getByLabelText('Provider to connect')).queryByRole('option', { name: 'Gemini' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement).disabled).toBe(true)
})

test('treats a registered project-selected CDP provider as runnable', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    projectProviders: ['cdp:chatgpt'],
    cdpStatus: { connected: false, browserVersion: 'Chrome/140' },
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  const launch = screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement
  expect(launch.disabled).toBe(false)
  expect(screen.queryByRole('link', { name: 'Configure a provider' })).toBeNull()
})

test('invalidates project query and dashboard caches after project-scoped query setup', async () => {
  const { projectId, projectName, queryClient } = renderProjectSetup({
    onboarding: true,
    providerReady: false,
  })
  const queriesKey = getApiV1ProjectsByNameQueriesQueryKey({
    client: heyClient,
    path: { name: projectName },
  })
  const dashboardKey = ['project-dashboard-full', projectId, 'none'] as const
  queryClient.setQueryData(queriesKey, [])
  queryClient.setQueryData(dashboardKey, { queries: [] })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  await waitFor(() => {
    expect(queryClient.getQueryState(queriesKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(dashboardKey)?.isInvalidated).toBe(true)
  })
})

test('keeps project-scoped query controls blocked until the canonical query read settles', async () => {
  let resolveQueries: ((response: Response) => void) | undefined
  renderProjectSetup({
    onboarding: true,
    queryResponse: () => new Promise<Response>((resolve) => { resolveQueries = resolve }),
  })

  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
  await waitFor(() => expect(resolveQueries).toBeTypeOf('function'))
  expect(screen.getByText('Loading saved queries…').closest('[role="status"]')).toBeTruthy()
  expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
  expect(screen.queryByRole('button', { name: /Save .*quer/i })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Finish without AI Visibility' })).toBeNull()

  resolveQueries?.(jsonResponse([{ id: 'query-saved', query: 'saved canonical query' }]))

  expect(await screen.findByText('saved canonical query')).toBeTruthy()
  expect(screen.queryByText('Loading saved queries…')).toBeNull()
  expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
})


test('managed sweeps finishes setup without offering to launch or retry a sweep', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(await screen.findByText('Sweeps are run by your Canonry team')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Launch visibility sweep|Retry visibility sweep/ })).toBeNull()
  expect(screen.queryByText(/Run a first sweep/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open project dashboard →' }))
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})

test.each(['queued', 'running', 'failed', 'completed'] as const)('managed setup preserves the %s sweep state', async status => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), {
    status,
    ...(status === 'failed' ? { error: { message: 'Provider quota exceeded' } } : {}),
    snapshots: status === 'completed' ? [{ query: 'best local dentist', citationState: 'cited', answerMentioned: true }] : [],
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  if (status === 'completed') {
    expect(await screen.findByText('Mentioned')).toBeTruthy()
    expect(screen.getByText('Cited')).toBeTruthy()
    expect(screen.getByText('Results')).toBeTruthy()
  } else if (status === 'failed') {
    expect(await screen.findByText('Provider quota exceeded')).toBeTruthy()
  } else {
    expect(await screen.findByText('Sweep running. This usually takes 30 to 60 seconds.')).toBeTruthy()
    expect(screen.getByText(status)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Setup complete' })).toBeNull()
  }
  expect(screen.queryByRole('button', { name: /Launch visibility sweep|Retry visibility sweep/ })).toBeNull()
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})
