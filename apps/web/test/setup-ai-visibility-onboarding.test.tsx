import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey, getApiV1ProjectsByNameRunPreviewQueryKey, getApiV1RunsByIdQueryKey, getApiV1RunsQueryKey } from '@canonry/canonry-api-client/react-query'
import type { ReactNode } from 'react'
import { onboardingTelemetryEventSchema, querySnapshotDtoSchema, runDetailDtoSchema, type RunDetailDto } from '@canonry/canonry-contracts'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { clearOnboardingRunLaunched, readOnboardingLaunchedRun } from '../src/lib/onboarding-telemetry.js'
import { getToasts } from '../src/lib/toast-store.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { MANAGED_SWEEPS_COPY, MANAGED_SWEEPS_UNAVAILABLE_COPY } from '../src/components/project/ManagedSweepStatus.js'
import { connectionFixture } from './provider-settings-fixtures.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

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
  window.sessionStorage.clear()
})

// The administrator settings read the OpenRouter picker uses, with the given catalog.
function openRouterSettings(models: Array<{ id: string; displayName: string }>) {
  const body = { providers: [{ name: 'openrouter', configured: true }], providerCatalog: [{ name: 'openrouter', displayName: 'OpenRouter', mode: 'api', modelConfigurable: true, defaultModel: '', knownModels: [{ id: 'vendor/model-a', displayName: 'Model A', tier: 'standard' }, { id: 'vendor/model-b', displayName: 'Model B', tier: 'standard' }], modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.' }], google: { configured: false }, bing: { configured: false } }
  body.providerCatalog[0]!.knownModels = models.map(model => ({ ...model, tier: 'standard' }))
  return body
}

function runPreviewFixture(queryCount: number, canStart = true) {
  return { mode: 'simple', revision: null, queryCount, assignmentCount: null,
    queryClasses: [{ queryClass: 'non-brand', queryCount, assignmentCount: null }],
    requestCount: queryCount, expectedRequestCount: queryCount,
    engines: [{ provider: 'gemini', models: ['gemini-flash-latest'], requestCount: queryCount, expectedRequestCount: queryCount, available: true }],
    locations: [{ location: null, requestCount: queryCount }],
    admission: { refused: false, retryAfter: null, providers: {} }, activeRunId: null, canStart, blockedReason: canStart ? null : 'no-provider' }
}

function renderProjectSetup(options: {
  onboarding: boolean
  projectScoped?: boolean
  onboardingFinish?: boolean
  complete?: boolean
  providerReady?: boolean
  projectProviders?: string[]
  readyProviderNames?: string[]
  cdpStatus?: { connected?: boolean; browserVersion?: string }
  cdpResponse?: () => Response | Promise<Response>
  apiKey?: ApiKeyAccess
  queryResponse?: (init?: RequestInit) => Response | Promise<Response>
  providerResponse?: () => Response | Promise<Response>
  runResponse?: (init?: RequestInit) => Response | Promise<Response>
  previewResponse?: () => Response | Promise<Response>
  includeLocalProvider?: boolean
  /** More connections that still need setup, as `/settings` lists them. */
  extraProviders?: Array<{ name: string; displayName: string }>
  openRouter?: boolean
  /** Replaces the administrator settings read (the OpenRouter catalog source). */
  settingsResponse?: () => Response | Promise<Response>
  /** Answers `POST /projects/:name/queries/generate`. */
  generateResponse?: (init?: RequestInit) => Response | Promise<Response>
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
    // `/settings` names the model a blank model field runs (the Local adapter's default).
    fixture.dashboard.settings.providerStatuses.push({ name: 'local', defaultModel: 'llama3', state: 'needs-config', detail: 'Base URL is missing.' })
  }
  for (const provider of options.extraProviders ?? []) {
    fixture.dashboard.settings.providerStatuses.push({ ...provider, state: 'needs-config', detail: 'API key is missing.' })
  }
  if (options.openRouter) fixture.dashboard.settings.providerStatuses.push({ name: 'openrouter', displayName: 'OpenRouter', state: 'ready', detail: 'Connected.' })

  const requests: Array<{ path: string; method?: string; body?: RequestInit['body'] }> = []
  let canonicalQueryCount = options.complete ? 1 : 0
  const restore = mockFetch(async (url, init) => {
    requests.push({ path: pathOf(url), method: init?.method, body: init?.body })
    if (options.openRouter && pathOf(url) === `/api/v1/projects/${encodeURIComponent(project.project.name)}`) {
      if (init?.method === 'PUT') Object.assign(project.project, JSON.parse(String(init.body)))
      return jsonResponse(project.project)
    }
    if (pathOf(url) === '/api/v1/projects' || pathOf(url).split('?')[0] === '/api/v1/runs') return jsonResponse([])
    if (options.runResponse && (/\/projects\/[^/]+\/runs$/.test(pathOf(url)) || /^\/api\/v1\/runs\/[^/]+$/.test(pathOf(url)))) return options.runResponse(init)
    if (pathOf(url) === '/api/v1/settings') {
      if (options.settingsResponse) return options.settingsResponse()
      if (pathOf(url) === '/api/v1/settings') return jsonResponse(options.openRouter ? {
        providers: [{ name: 'openrouter', configured: true }],
        providerCatalog: [{ name: 'openrouter', displayName: 'OpenRouter', mode: 'api', modelConfigurable: true, defaultModel: '', knownModels: [{ id: 'vendor/model-a', displayName: 'Model A', tier: 'standard' }, { id: 'vendor/model-b', displayName: 'Model B', tier: 'standard' }], modelValidationPattern: { source: '^[a-z0-9._-]+/[a-z0-9._:-]+$', flags: '' }, modelValidationHint: 'Use a vendor/model ID.' }],
        google: { configured: false }, bing: { configured: false },
      } : { providers: [] })
    }
    if (pathOf(url).includes('/runs?kind=site-audit')) return jsonResponse([])
    if (pathOf(url).endsWith('/run-preview')) return options.previewResponse?.() ?? jsonResponse(runPreviewFixture(canonicalQueryCount))
    if (pathOf(url).endsWith('/measurement-setup')) return jsonResponse({ answerVisibilityProviderReady: options.providerReady !== false })
    if (pathOf(url) === '/api/v1/cdp/status') return options.cdpResponse?.() ?? jsonResponse(options.cdpStatus ?? {})
    if (pathOf(url).startsWith('/api/v1/settings/providers/')) return options.providerResponse?.() ?? jsonResponse(init?.method === 'GET' ? connectionFixture({ name: pathOf(url).split('/').at(-1) ?? 'gemini', displayName: 'Gemini' }) : { name: 'gemini', configured: true })
    if (pathOf(url).endsWith('/queries/generate') && options.generateResponse) return options.generateResponse(init)
    if (pathOf(url).endsWith('/queries')) {
      const response = options.queryResponse ? await options.queryResponse(init) : jsonResponse(options.complete ? [{ id: 'query-1', query: 'best local dentist' }] : [])
      if (response.ok) canonicalQueryCount = (await response.clone().json() as unknown[]).length
      return response
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
            visibilityProjectName={options.projectScoped === false ? undefined : project.project.name}
            siteHealthOnboarding={options.onboarding}
            {...(options.onboardingFinish === undefined ? {} : { onboardingFinish: options.onboardingFinish })}
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
    switchProjectName: (name: string) => {
      project.project.name = name
      rendered.rerender(content())
    },
    markProviderReady: (name: string) => {
      fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => (
        provider.name.toLowerCase() === name.toLowerCase() ? { ...provider, state: 'ready' } : provider
      ))
      rendered.rerender(content())
    },
  }
}

test('picks and saves several OpenRouter models in the provider step before allowing the first sweep', async () => {
  const { requests, projectName } = renderProjectSetup({ onboarding: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]) })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(true))
  expect(await screen.findByText('Choose models')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
  // The models are picked right here: one picker with no Add models step, and
  // changing the key stays a secondary action.
  const picker = await screen.findByRole('group', { name: 'Choose OpenRouter models' })
  expect(screen.queryByRole('button', { name: 'Add models', exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Use a different provider' })).toBeTruthy()
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'Model A' }))
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'Model B' }))
  fireEvent.click(within(picker).getByRole('button', { name: 'Save 2 models' }))
  await waitFor(() => expect(launch.disabled).toBe(false))
  const projectPath = `/api/v1/projects/${encodeURIComponent(projectName)}`
  const saveIndex = requests.findIndex(request => request.path === projectPath && request.method === 'PUT')
  expect(JSON.parse(String(requests[saveIndex]?.body))).toMatchObject({ providers: ['openrouter:vendor/model-a', 'openrouter:vendor/model-b'], providerModels: {} })
  // Readiness is read again after the save, and the step now reads as configured.
  expect(requests.slice(saveIndex + 1).some(request => request.path === '/api/v1/projects' && request.method === 'GET')).toBe(true)
  expect(screen.queryByRole('heading', { name: 'AI engines' })).toBeNull()
  expect(screen.getByText('Change engines', { selector: 'summary' }).closest('details')?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }))
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect(screen.getByText('Configured')).toBeTruthy()
  // The saved models are named from OpenRouter's catalog, not by raw ID.
  const engines = await screen.findByRole('list', { name: 'Connected AI engines' })
  expect(within(engines).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Model AOpenRouter', 'Model BOpenRouter'])
  expect(screen.queryByText('Choose models')).toBeNull()
  expect(screen.queryByRole('group', { name: 'Choose OpenRouter models' })).toBeNull()
  expect(requests.some(request => request.path.endsWith('/runs') && request.method === 'POST')).toBe(false)
})

test('a corrected OpenRouter key refreshes the model list without leaving the step', async () => {
  // A wrong key leaves the catalog empty. Fixing it in place must bring the
  // models in right away, not after the settings read goes stale.
  let models: Array<{ id: string; displayName: string }> = []
  renderProjectSetup({
    onboarding: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => jsonResponse(openRouterSettings(models)),
    providerResponse: () => jsonResponse(connectionFixture({ name: 'openrouter', displayName: 'OpenRouter', kind: 'model-gateway' })),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(await screen.findByText(/Couldn't load OpenRouter's model list/)).toBeTruthy()
  const settingsLink = screen.getByRole('link', { name: 'Settings' })
  expect(settingsLink.getAttribute('target')).toBe('_blank')

  fireEvent.click(screen.getByRole('button', { name: 'Use a different provider' }))
  // OpenRouter is already connected: no free-tier pitch, and the OpenRouter
  // form says how it bills.
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'openrouter' } })
  expect(await screen.findByPlaceholderText('Leave blank to keep the saved key')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'sk-or-v1-corrected' } })
  models = [{ id: 'vendor/model-a', displayName: 'Model A' }]
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  const picker = await screen.findByRole('group', { name: 'Choose OpenRouter models' })
  expect(await within(picker).findByRole('checkbox', { name: 'Model A' })).toBeTruthy()
})

test('shows the model list loading, and a failed read offers Retry', async () => {
  let respond: () => Response | Promise<Response> = () => new Promise<Response>(() => {})
  renderProjectSetup({
    onboarding: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => respond(),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(await screen.findByText('Loading OpenRouter models…')).toBeTruthy()
  cleanup()

  respond = () => jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500)
  renderProjectSetup({
    onboarding: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => respond(),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(await screen.findByText("Couldn't load OpenRouter's model list.")).toBeTruthy()
  respond = () => jsonResponse(openRouterSettings([{ id: 'vendor/model-a', displayName: 'Model A' }]))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const picker = await screen.findByRole('group', { name: 'Choose OpenRouter models' })
  expect(await within(picker).findByRole('checkbox', { name: 'Model A' })).toBeTruthy()
})

test('marks AI Visibility as the optional final onboarding stage and can skip to the finish step', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByText('System check')).toBeNull()
  expect(screen.queryByText('Create project')).toBeNull()
  expect(screen.queryByText('Competitors')).toBeNull()
  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(progress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith({
      to: '/setup',
      search: { onboarding: 'complete', setupProject: projectName, skipped: 'visibility' },
      replace: true,
    })
  })
})

test('setup actions stay compact beside a mouse and are 44px targets under a finger', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })
  // Main's calmer onboarding names the provider step "AI engines".
  await screen.findByRole('heading', { name: 'AI engines' })
  fireEvent.click(await screen.findByText('Research queries with your agent', { selector: 'summary' }))
  const targets = [
    screen.getByRole('button', { name: 'Skip AI Visibility' }),
    screen.getByRole('button', { name: 'Refresh connections' }),
    screen.getByRole('button', { name: 'Copy research prompt' }),
  ]
  const rules = parseCompiledCss(await compileAppStyles(targets.flatMap(element => [...element.classList])))
  // Beside a desktop mouse, on a narrow screen, and under a finger. Buttons keep the shared Button height beside a mouse.
  const minHeights = targets.map(element => [undefined, '@media (width < 48rem)', '@media (pointer: coarse)'].map(context => {
    const value = compiledElementProperty(rules, element, 'min-height', context)
    return value === undefined ? 0 : cssLengthPx(value, rules)
  }))
  expect(minHeights).toEqual([[0, 44, 44], [0, 44, 44], [0, 44, 44]])
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
  expect(screen.getByRole('button', { name: /administrator/ })).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
})

test('keeps Gemini onboarding guidance out of administrator-only setup for a read-only key', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    apiKey: { id: 'read-only-key', scopes: ['read'], projectId: null, readOnly: true },
  })
  expect(await screen.findByText('Set up AI Visibility is for administrators')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
})

test('introduces Gemini free-tier setup before the API key field with its limits and official links', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })
  const heading = await screen.findByRole('heading', { name: 'Connect Gemini' })
  const keyInput = screen.getByLabelText('API key')
  expect(heading.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const keyLink = screen.getByRole('link', { name: 'Get a key in Google AI Studio ↗' })
  expect(keyLink.getAttribute('href')).toBe('https://aistudio.google.com/apikey')
  expect(keyLink.getAttribute('target')).toBe('_blank')
  expect(keyLink.getAttribute('rel')).toContain('noopener')
  expect(keyLink.closest('p')?.textContent).toBe('Get a key in Google AI Studio ↗. Free usage depends on the model and your account. Pricing and limits')
  const pricingLink = screen.getByRole('link', { name: 'Pricing and limits' })
  expect(pricingLink.getAttribute('href')).toBe('https://ai.google.dev/gemini-api/docs/pricing')
  expect(pricingLink.getAttribute('target')).toBe('_blank')
  expect(screen.queryByRole('link', { name: 'Get API key ↗' })).toBeNull()
})

test('switches Gemini free-tier guidance with the selected provider and preserves other key links', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false })
  expect(await screen.findByRole('heading', { name: 'Connect Gemini' })).toBeTruthy()
  const provider = screen.getByLabelText('Provider to connect')
  fireEvent.change(provider, { target: { value: 'Claude' } })
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Pricing and limits' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Get API key ↗' }).getAttribute('href')).toBe('https://platform.claude.com/settings/keys')

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  expect(screen.getByRole('heading', { name: 'Connect Gemini' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeTruthy()
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
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(screen.getByLabelText('API key')).toHaveProperty('value', 'synthetic-gemini-key')
  fireEvent.change(selector, { target: { value: 'Claude' } })
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Provider to connect')))
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Model (optional)') as HTMLInputElement).value).toBe('')
  expect((screen.getByPlaceholderText('Concurrent') as HTMLInputElement).value).toBe('')
  expect(screen.getByText('Advanced provider settings').closest('details')?.open).toBe(false)
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query draft')

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(screen.getByLabelText('Provider to connect')).toHaveProperty('value', 'Gemini'))
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Provider to connect')))
  expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('')
  expect(requests.filter(request => request.method === 'PUT')).toEqual([])
})

function renderColdScopedSetup(readinessResponse: () => Response | Promise<Response>, existingRun?: Partial<RunDetailDto> & Pick<RunDetailDto, 'status'>, overviewResponse?: () => Response | Promise<Response>, runDetailsResponse?: () => Response | Promise<Response>, savedQueries?: Array<{ id: string; query: string; queryClass?: 'branded' | 'non-brand' | null }>) {
  const project = { ...createDashboardFixture().dashboard.projects[0]!.project, name: 'scoped-project', displayName: 'City Point Dental', providers: ['gemini'] }
  const requests: string[] = []
  const telemetryEvents: Array<{ event: string; step?: string }> = []
  const run = { id: 'scoped-run', projectId: project.id, projectName: project.name, kind: 'answer-visibility', status: 'queued', createdAt: '2026-09-05T12:00:00Z', ...existingRun }
  let hasRun = Boolean(existingRun)
  let queries: Array<{ id: string; query: string; queryClass?: 'branded' | 'non-brand' | null }> = savedQueries ?? [{ id: 'saved-query', query: 'best local dentist' }]
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    requests.push(path)
    if (path === '/api/v1/projects') return jsonResponse([project])
    if (path.split('?')[0] === '/api/v1/runs') return jsonResponse(hasRun ? [run] : [])
    if (path.endsWith('/overview') && overviewResponse) return overviewResponse()
    if (path === '/api/v1/settings') return jsonResponse({ providers: [{ name: 'gemini', configured: true }] })
    if (path.endsWith('/run-preview')) return jsonResponse(runPreviewFixture(queries.length))
    if (path.endsWith('/measurement-setup')) return readinessResponse()
    if (path === '/api/v1/projects/scoped-project/runs' && init?.method === 'POST') {
      hasRun = true
      return jsonResponse(run, 202)
    }
    if (path === '/api/v1/runs/scoped-run') return runDetailsResponse?.() ?? jsonResponse(run)
    if (path.endsWith('/queries')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { queries: string[] }
        queries = body.queries.map((query, index) => ({ id: `query-${index}`, query }))
      }
      return jsonResponse(queries)
    }
    if (path === '/health') return jsonResponse({ version: 'test', databaseUrlConfigured: true })
    if (path.endsWith('/telemetry/onboarding')) {
      telemetryEvents.push(JSON.parse(String(init?.body)) as { event: string; step?: string })
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
  return { requests, queryClient, telemetryEvents, updateRun: (update: Partial<RunDetailDto>) => { Object.assign(run, update) } }
}

test('uses project-readable provider readiness for a cold scoped-writer setup', async () => {
  const { requests, queryClient, telemetryEvents } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Run your first AI Visibility check' }))
  await waitFor(() => expect(queryClient.getQueryState(['health'])?.status).toBe('success'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(false))
  expect(requests).toContain('/api/v1/projects/scoped-project/measurement-setup')
  expect(requests).not.toContain('/api/v1/settings')
  expect(requests).not.toContain('/api/v1/cdp/status')
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  expect(await screen.findByText('Your check is running. You can leave this page and return to its progress.')).toBeTruthy()
  expect(requests).toContain('/api/v1/projects/scoped-project/runs')
  expect(requests).not.toContain('/api/v1/settings')
  expect(telemetryEvents.some(event => event.event === 'run.requested')).toBe(false)
})

test('waits for resumed check evidence before deciding whether a completed check saved answers', async () => {
  let resolveDetails: ((response: Response) => void) | undefined
  renderColdScopedSetup(
    () => jsonResponse({ answerVisibilityProviderReady: true }),
    { status: 'completed' },
    undefined,
    () => new Promise(resolve => { resolveDetails = resolve }),
  )
  expect(await screen.findByText('Loading saved check…')).toBeTruthy()
  expect(screen.queryByText('Failed', { exact: true })).toBeNull()
  expect(screen.queryByText('The check finished without saving any engine results.')).toBeNull()
  resolveDetails?.(jsonResponse(runDetailDtoSchema.parse({
    id: 'scoped-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'completed',
    createdAt: '2026-09-05T12:00:00Z', snapshots: [setupResultSnapshot({ answerText: 'A saved answer after resuming.' })],
  })))
  expect(await screen.findByRole('heading', { name: 'Saved answers' })).toBeTruthy()
  // The saved answer shows once its details load.
  expect(screen.getByText('A saved answer after resuming.')).toBeTruthy()
})

// Launched-run markers written before they recorded a run kind.
function writeLegacyLaunchedRun(runId: string) {
  window.sessionStorage.setItem('canonry.onboarding-launched-run.v1', JSON.stringify({ projectName: 'scoped-project', runId, handled: false }))
}

test('opens on the queries when a marker without a kind holds a run outside the AI Visibility list', async () => {
  // The onboarding Agent Readiness scan shared this marker.
  writeLegacyLaunchedRun('onboarding-scan')
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }))

  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Run your first AI Visibility check' })).toBeNull()
  await waitFor(() => expect(requests).toContain('/api/v1/projects/scoped-project/queries'))
  expect(requests).not.toContain('/api/v1/runs/onboarding-scan')
})

test('still resumes and reports a listed AI Visibility check from a marker without a kind', async () => {
  writeLegacyLaunchedRun('scoped-run')
  const { telemetryEvents } = renderColdScopedSetup(
    () => jsonResponse({ answerVisibilityProviderReady: true }),
    { status: 'completed', snapshots: [setupResultSnapshot({ answerText: 'A saved answer from before the upgrade.' })] },
  )

  expect(await screen.findByRole('heading', { name: 'Saved answers' })).toBeTruthy()
  await waitFor(() => expect(readOnboardingLaunchedRun('scoped-project', true)).toEqual({ projectName: 'scoped-project', runId: 'scoped-run', handled: true }))
  expect(telemetryEvents.filter(event => event.event === 'onboarding.step_completed' && event.step === 'run')).toHaveLength(1)
})

test('keeps scoped-writer launch blocked while project provider readiness loads', async () => {
  let resolveReadiness: ((response: Response) => void) | undefined
  renderColdScopedSetup(() => new Promise(resolve => { resolveReadiness = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  expect(launch.disabled).toBe(true)
  expect(launch.title).toBe('Checking provider connections before launch.')
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
  expect(await screen.findByText('Provider connections could not be checked. Try again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry provider check' }))
  expect(await within(screen.getByRole('region', { name: 'AI engines' })).findByText('Configured')).toBeTruthy()
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
  const launch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }))
  const providerSection = within(screen.getByRole('region', { name: 'AI engines' }))
  expect(await providerSection.findByText('Provider connections could not be checked. Try again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Continue', exact: true }))
  const blockedLaunch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  expect(blockedLaunch.disabled).toBe(true)
  expect(blockedLaunch.title).toBe('Provider connections could not be checked. Try again.')
})

test('keeps a confirmed missing provider blocked for scoped writers without credential controls', async () => {
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: false }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.title).toBe('Launch is blocked until a provider allowed by this project is configured.'))
  expect(launch.disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Ask an administrator to connect an AI engine for this project. You can save queries now.' })).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
})

test.each([
  { status: 'completed' as const, snapshots: [], expected: 'The check finished without saving any engine results.' },
  { status: 'failed' as const, snapshots: [], error: { message: 'Provider quota exceeded' }, expected: 'Provider quota exceeded' },
].flatMap(scenario => [false, true].map(managedSweeps => ({ ...scenario, managedSweeps }))))('gives a scoped writer coherent guidance after a $status sweep (managed=$managedSweeps)', async ({ status, snapshots, error, expected, managedSweeps }) => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps } }
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status, snapshots, ...(error ? { error } : {}) })

  expect(await screen.findByText(expected)).toBeTruthy()
  expect(screen.getByText(managedSweeps ? MANAGED_SWEEPS_COPY : 'Ask an administrator to review the provider and query configuration.')).toBeTruthy()
  expect(screen.queryByText('Fix provider or query configuration if needed, then retry without leaving setup.')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry check' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Open project dashboard →' })).toBeTruthy()
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
    to: '/setup',
    search: { onboarding: 'complete', setupProject: projectName, skipped: 'visibility' },
    replace: true,
  })
})

test('finishing the project-scoped onboarding lands on the finish step', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true, complete: true })

  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/setup',
    search: { onboarding: 'complete', setupProject: projectName },
    replace: true,
  })
})

test('keeps the existing project-scoped setup destination outside Agent Readiness onboarding', async () => {
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
  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  expect(requests.find(request => request.method === 'PUT' && request.path === `/api/v1/projects/${encodeURIComponent(projectName)}/queries`)).toMatchObject({
    body: JSON.stringify({ queries: ['best local dentist', 'researched dental query'] }),
  })
})

test('lets a project save queries before a provider is configured', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })

  const queries = await screen.findByLabelText('Queries (one per line)')
  fireEvent.change(queries, { target: { value: 'best local dentist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
})

test('offers provider setup before queries and keeps the draft after saving and refreshing readiness', async () => {
  const { requests, markProviderReady } = renderProjectSetup({ onboarding: true, providerReady: false })
  expect(await screen.findByText('Not connected')).toBeTruthy()
  const providerHeading = screen.getByRole('heading', { name: 'AI engines' })
  const queryHeading = screen.getByRole('heading', { name: 'Add queries' })
  expect(providerHeading.compareDocumentPosition(queryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const saveConnection = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement
  expect(saveConnection.disabled).toBe(true)
  expect(saveConnection.parentElement).toBe(screen.getByRole('button', { name: 'Refresh connections' }).parentElement)
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
  // The notice names the provider as people know it, not by its internal id.
  expect(getToasts().map(toast => toast.detail)).toContain('Gemini configuration saved.')
  expect(requests.find(request => request.path === '/api/v1/settings/providers/gemini')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ apiKey: 'synthetic-test-key' }),
  })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(requests.some(request => request.path === '/api/v1/settings')).toBe(true)
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()

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
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
  expect(screen.getByLabelText('API key (optional)')).toBeTruthy()
  // A blank model field names the model it runs, from the server's settings.
  screen.getByText('Advanced provider settings', { selector: 'summary' }).closest('details')!.open = true
  expect(screen.getByRole('textbox', { name: 'Model (optional)', description: 'Default model: llama3' })).toHaveProperty('value', '')
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
  expect(await screen.findByText('Checking')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Checking connected AI engines. You can choose queries meanwhile.' })).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  await waitFor(() => expect(resolveCdp).toBeTypeOf('function'))
  resolveCdp?.(jsonResponse({}))
  expect(await screen.findByText('Not connected')).toBeTruthy()
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
  fireEvent.click(await screen.findByText('Research queries with your agent', { selector: 'summary' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy research prompt' }))
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
  expect(prompt).toContain('Do not change tracked queries or launch an AI Visibility check')
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
  fireEvent.click(await screen.findByText('Research queries with your agent', { selector: 'summary' }))
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

  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  expect(screen.getByText(/provider allowed by this project/i)).toBeTruthy()
  expect((screen.getByLabelText('Provider to connect') as HTMLSelectElement).value).toBe('Claude')
  expect(within(screen.getByLabelText('Provider to connect')).queryByRole('option', { name: 'Gemini' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
})

test('treats a registered project-selected CDP provider as runnable', async () => {
  let savedQueries: Array<{ id: string; query: string }> = []
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    projectProviders: ['cdp:chatgpt'],
    cdpStatus: { connected: false, browserVersion: 'Chrome/140' },
    queryResponse: init => {
      if (init?.method === 'PUT') savedQueries = [{ id: 'query-cdp', query: 'best local dentist' }]
      return jsonResponse(savedQueries)
    },
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  const launch = screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(false))
  expect(screen.queryByRole('link', { name: 'Use a different provider' })).toBeNull()
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

test.each([true, false])('keeps reset blocked until saved queries are confirmed (project-scoped: %s)', async projectScoped => {
  let resolveQueries: ((response: Response) => void) | undefined
  renderProjectSetup({
    onboarding: projectScoped,
    projectScoped,
    readyProviderNames: ['gemini'],
    queryResponse: () => new Promise<Response>((resolve) => { resolveQueries = resolve }),
  })

  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
  await waitFor(() => expect(resolveQueries).toBeTypeOf('function'))
  expect((screen.getByRole('button', { name: 'Reset unsaved fields' }) as HTMLButtonElement).disabled).toBe(true)
  if (projectScoped) {
    expect(screen.getByText('Loading saved queries…').closest('[role="status"]')).toBeTruthy()
    expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
    expect(screen.queryByRole('button', { name: /Save .*quer/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Finish without AI Visibility' })).toBeNull()
  }

  resolveQueries?.(jsonResponse([{ id: 'query-saved', query: 'saved canonical query' }]))
  if (!projectScoped) {
    await screen.findByRole('heading', { name: 'Add competitors' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  }
  expect(await screen.findByText('saved canonical query')).toBeTruthy()
  expect(screen.queryByText('Loading saved queries…')).toBeNull()
  expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
  expect((screen.getByRole('button', { name: 'Reset unsaved fields' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved fields' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('saved canonical query')
})


test('managed sweeps finishes setup without offering to launch or retry a sweep', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const scheduleStatus = await screen.findByText(MANAGED_SWEEPS_UNAVAILABLE_COPY)
  expect(scheduleStatus.closest('[role="status"]')).toBeTruthy()
  expect(scheduleStatus.querySelector('time')).toBeNull()
  expect(screen.queryByRole('button', { name: /Launch AI Visibility check|Retry AI Visibility check/ })).toBeNull()
  expect(screen.queryByText(/Run a first check/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open project dashboard →' }))
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})

test.each(['queued', 'running', 'failed', 'completed'] as const)('managed setup preserves the %s sweep state', async status => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), {
    status,
    ...(status === 'failed' ? { error: { message: 'Provider quota exceeded' } } : {}),
    snapshots: status === 'completed' ? [querySnapshotDtoSchema.parse({ id: 'snapshot_completed', runId: 'scoped-run', queryId: 'saved-query', query: 'best local dentist', provider: 'gemini', citationState: 'cited', answerMentioned: true, createdAt: '2026-09-05T12:01:00Z' })] : [],
  })
  await screen.findByRole('heading', { name: 'AI Visibility', exact: true })
  if (status === 'completed') {
    await screen.findByText('Mentioned', { selector: 'dt' })
    expect(resultFigures()).toEqual([
      ['Mentioned', 'Unavailable · all queries'],
      ['Cited', 'Unavailable · all queries'],
      ['Engine results', '1 · all queries'],
    ])
  } else if (status === 'failed') {
    expect(await screen.findByText('Provider quota exceeded')).toBeTruthy()
  } else {
    expect(await screen.findByText('Your check is running. You can leave this page and return to its progress.')).toBeTruthy()
    expect(screen.getByText(status === 'queued' ? 'Queued' : 'Running')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Setup complete' })).toBeNull()
  }
  expect(screen.queryByRole('button', { name: /Launch AI Visibility check|Retry AI Visibility check/ })).toBeNull()
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})

function setupResultSnapshot(overrides: Record<string, unknown>) {
  return querySnapshotDtoSchema.parse({
    id: 'snapshot_one',
    runId: 'scoped-run',
    queryId: 'query_one',
    query: 'best local dentist',
    provider: 'gemini',
    citationState: 'cited',
    answerMentioned: true,
    createdAt: '2026-09-05T12:01:00Z',
    ...overrides,
  })
}

/** The first result's summary row as [label, value], including each value's screen-reader class text. */
function resultFigures() {
  const summary = screen.getByText('Mentioned', { selector: 'dt' }).closest('dl')!
  const values = within(summary).getAllByRole('definition')
  return within(summary).getAllByRole('term').map((term, index) => [term.textContent, values[index]!.textContent])
}

test.each([
  {
    scenario: 'one query across two positive providers',
    status: 'completed',
    snapshots: [setupResultSnapshot({}), setupResultSnapshot({ id: 'snapshot_two', provider: 'openai' })],
    queryCounts: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1 },
    mentioned: '1 of 1 query', cited: '1 of 1 query', checks: '2',
  },
  {
    scenario: 'distinct query IDs with identical display text',
    status: 'completed',
    snapshots: [setupResultSnapshot({}), setupResultSnapshot({ id: 'snapshot_two', queryId: 'query_two' })],
    queryCounts: { totalQueries: 2, citedQueries: 2, mentionedQueries: 2 },
    mentioned: '2 of 2 queries', cited: '2 of 2 queries', checks: '2',
  },
  {
    scenario: 'an identified query without optional display text',
    status: 'completed',
    snapshots: [setupResultSnapshot({ query: undefined })],
    queryCounts: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1 },
    mentioned: '1 of 1 query', cited: '1 of 1 query', checks: '1',
  },
  {
    scenario: 'independent citation and mention signals',
    status: 'completed',
    snapshots: [
      setupResultSnapshot({ answerMentioned: false }),
      setupResultSnapshot({ id: 'snapshot_two', provider: 'openai', citationState: 'not-cited' }),
      setupResultSnapshot({ id: 'snapshot_three', queryId: 'query_two', query: 'another query', citationState: 'not-cited', answerMentioned: false }),
    ],
    queryCounts: { totalQueries: 2, citedQueries: 1, mentionedQueries: 1 },
    mentioned: '1 of 2 queries', cited: '1 of 2 queries', checks: '3',
  },
  {
    scenario: 'server summary values independent from snapshot positives',
    status: 'completed',
    snapshots: [setupResultSnapshot({})],
    queryCounts: { totalQueries: 7, citedQueries: 2, mentionedQueries: 3 },
    mentioned: '3 of 7 queries', cited: '2 of 7 queries', checks: '1',
  },
  {
    scenario: 'a successful partial run presents the server summary',
    status: 'partial',
    snapshots: [setupResultSnapshot({})],
    queryCounts: { totalQueries: 4, citedQueries: 1, mentionedQueries: 0 },
    mentioned: '0 of 4 queries', cited: '1 of 4 queries', checks: '1',
  },
  {
    scenario: 'an unavailable API summary keeps query metrics unavailable',
    status: 'completed',
    snapshots: [setupResultSnapshot({})],
    queryCounts: null,
    mentioned: 'Unavailable', cited: 'Unavailable', checks: '1',
  },
])('setup results render the per-run API summary: $scenario', async ({ status, snapshots, queryCounts, mentioned, cited, checks }) => {
  const run = runDetailDtoSchema.parse({
    id: 'scoped-run', projectId: 'project_citypoint', kind: 'answer-visibility', status,
    createdAt: '2026-09-05T12:00:00Z', snapshots, queryCounts,
  })
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), run)
  const resultHeading = await screen.findByRole('heading', { name: 'Saved answers', level: 2 })

  // Branded and non-brand queries share these counts, so the class is named once beside the project.
  expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'City Point Dental · all queries')).toBeTruthy()
  expect(resultFigures()).toEqual([
    ['Mentioned', `${mentioned} · all queries`],
    ['Cited', `${cited} · all queries`],
    ['Engine results', `${checks} · all queries`],
  ])
  // In view on arrival, not behind a disclosure.
  const summary = screen.getByText('Mentioned', { selector: 'dt' }).closest('dl')!
  expect(summary.closest('details')).toBeNull()
  let resultCard = resultHeading.parentElement!
  while (!resultCard.contains(summary)) resultCard = resultCard.parentElement!
  expect(within(resultCard).getByText('Complete')).toBeTruthy()
  expect(screen.queryByText('Your check is running. You can leave this page and return to its progress.')).toBeNull()
  expect(requests).toContain('/api/v1/runs/scoped-run')
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})

test('features a non-brand answer over a branded one that names the brand', async () => {
  const snapshots = [
    setupResultSnapshot({ id: 'snapshot_branded', queryId: 'query_branded', query: 'city point dental reviews', answerMentioned: true, citationState: 'not-cited', answerText: 'An answer to a branded query naming City Point Dental.' }),
    setupResultSnapshot({ id: 'snapshot_nonbrand', queryId: 'query_nonbrand', query: 'best local dentist', answerMentioned: true, citationState: 'not-cited', answerText: 'A non-brand answer naming City Point Dental.' }),
  ]
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status: 'completed', snapshots }, undefined, undefined, [
    { id: 'query_branded', query: 'city point dental reviews', queryClass: 'branded' },
    { id: 'query_nonbrand', query: 'best local dentist', queryClass: 'non-brand' },
  ])
  const featured = await screen.findByRole('region', { name: 'Your first saved answer' })
  // A branded query hands the engine the brand's name; the non-brand mention is the proof.
  await waitFor(() => expect(within(featured).getByRole('heading', { level: 3 }).textContent).toBe('best local dentist'))
  expect(within(featured).getByText('A non-brand answer naming City Point Dental.')).toBeTruthy()
})

test.each([
  {
    scenario: 'an answer that names the brand comes first',
    snapshots: [
      setupResultSnapshot({ id: 'snapshot_neither', queryId: 'query_neither', query: 'generic dental query', answerMentioned: false, citationState: 'not-cited', answerText: 'An answer naming neither.' }),
      setupResultSnapshot({ id: 'snapshot_cited', queryId: 'query_cited', query: 'cited dental query', answerMentioned: false, citationState: 'cited', answerText: 'An answer citing the site.' }),
      setupResultSnapshot({ id: 'snapshot_mentioned', queryId: 'query_mentioned', query: 'mentioned dental query', answerMentioned: true, citationState: 'not-cited', answerText: 'An answer naming City Point Dental.' }),
    ],
    query: 'mentioned dental query', answer: 'An answer naming City Point Dental.', signals: ['Mentioned', 'Not cited'],
  },
  {
    scenario: 'with no mention, an answer that cites the site',
    snapshots: [
      setupResultSnapshot({ id: 'snapshot_neither', queryId: 'query_neither', query: 'generic dental query', answerMentioned: false, citationState: 'not-cited', answerText: 'An answer naming neither.' }),
      setupResultSnapshot({ id: 'snapshot_cited', queryId: 'query_cited', query: 'cited dental query', answerMentioned: false, citationState: 'cited', answerText: 'An answer citing the site.' }),
    ],
    query: 'cited dental query', answer: 'An answer citing the site.', signals: ['Not mentioned', 'Cited'],
  },
  {
    scenario: 'with neither signal, the first answer',
    snapshots: [
      setupResultSnapshot({ id: 'snapshot_first', queryId: 'query_first', query: 'first dental query', answerMentioned: false, citationState: 'not-cited', answerText: 'The first answer.' }),
      setupResultSnapshot({ id: 'snapshot_second', queryId: 'query_second', query: 'second dental query', answerMentioned: false, citationState: 'not-cited', answerText: 'The second answer.' }),
    ],
    query: 'first dental query', answer: 'The first answer.', signals: ['Not mentioned', 'Not cited'],
  },
  {
    scenario: 'a mention with no saved text gives way to an answer that can be read',
    snapshots: [
      setupResultSnapshot({ id: 'snapshot_textless', queryId: 'query_textless', query: 'textless dental query', answerMentioned: true, citationState: 'not-cited', answerText: null }),
      setupResultSnapshot({ id: 'snapshot_cited', queryId: 'query_cited', query: 'cited dental query', answerMentioned: false, citationState: 'cited', answerText: 'An answer citing the site.' }),
    ],
    query: 'cited dental query', answer: 'An answer citing the site.', signals: ['Not mentioned', 'Cited'],
  },
])('features the most informative saved answer after the summary: $scenario', async ({ snapshots, query, answer, signals }) => {
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status: 'completed', snapshots })
  const featured = await screen.findByRole('region', { name: 'Your first saved answer' })
  expect(within(featured).getByRole('heading', { level: 3 }).textContent).toBe(query)
  expect(within(featured).getByText(answer)).toBeTruthy()
  for (const signal of signals) expect(within(featured).getByText(signal, { exact: true })).toBeTruthy()
  for (const other of snapshots.filter(snapshot => snapshot.answerText && snapshot.answerText !== answer)) {
    expect(screen.queryByText(other.answerText!)).toBeNull()
  }
  const summary = screen.getByText('Mentioned', { selector: 'dt' }).closest('dl')!
  expect(summary.compareDocumentPosition(featured) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test.each([
  { length: 650, truncated: false },
  { length: 651, truncated: true },
])('offers the full answer only when its preview is cut ($length characters)', async ({ length, truncated }) => {
  const answerText = 'a'.repeat(length)
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status: 'completed', snapshots: [setupResultSnapshot({ answerText })] })
  const featured = await screen.findByRole('region', { name: 'Your first saved answer' })
  // The preview ends at 650 characters, as AnswerMarkdown cuts it.
  expect(within(featured).getAllByText(truncated ? `${'a'.repeat(650)}…` : answerText)).toHaveLength(1)
  expect(within(featured).queryByText('Read full answer', { selector: 'summary' }) !== null).toBe(truncated)
  // One copy action either way: on a preview that shows everything, else on the full answer.
  const copy = within(featured).getAllByRole('button', { name: 'Copy answer', hidden: true })
  expect(copy).toHaveLength(1)
  expect(copy[0]!.closest('details') !== null).toBe(truncated)
})

test.each([true, false])('AI-first setup records the direct project handoff once in its journey (skipped: %s)', async skipped => {
  const { projectName, requests } = renderProjectSetup({ onboarding: false, onboardingFinish: true, complete: !skipped })
  if (!skipped) fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const finish = await screen.findByRole('button', { name: skipped ? 'Finish without AI Visibility' : 'Open project dashboard →' })
  fireEvent.click(finish)
  fireEvent.click(finish)

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName',
    params: { projectName },
    replace: true,
  })
  await waitFor(() => {
    const events = requests.filter(request => request.path.endsWith('/telemetry/onboarding')).map(request => onboardingTelemetryEventSchema.parse(JSON.parse(String(request.body))))
    const started = events.find(event => event.event === 'onboarding.started')
    expect(started).toBeDefined()
    expect(events.filter(event => event.event === 'onboarding.step_completed' && event.step === 'finish')).toEqual([
      expect.objectContaining({
        onboardingSessionId: started!.onboardingSessionId,
        surface: 'wizard',
        event: 'onboarding.step_completed',
        step: 'finish',
        method: skipped ? 'skipped' : 'manual',
        nextAction: 'open_project',
      }),
    ])
  })
})


test('restores unsaved setup queries after reload and resets to saved queries without retaining credentials', async () => {
  const options = { onboarding: true, providerReady: false, queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'saved customer query' }]) }
  renderProjectSetup(options)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit queries' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries (one per line)' }), { target: { value: 'saved customer query\nunsaved customer query' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-unsaved-provider-secret' } })
  expect(Object.values(window.sessionStorage).join(' ')).not.toContain('synthetic-unsaved-provider-secret')
  cleanup()
  renderProjectSetup(options)
  expect((await screen.findByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((await screen.findByRole('textbox', { name: 'Queries (one per line)' }) as HTMLTextAreaElement).value).toBe('saved customer query\nunsaved customer query')
  expect(screen.queryByRole('button', { name: 'Edit queries' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved fields' }))
  expect(await screen.findByRole('button', { name: 'Edit queries' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  expect((screen.getByRole('textbox', { name: 'Queries (one per line)' }) as HTMLTextAreaElement).value).toBe('saved customer query')
})


test('switching setup projects isolates the unsaved query draft', async () => {
  const { switchProjectName } = renderProjectSetup({ onboarding: true, providerReady: false })
  fireEvent.change(await screen.findByRole('textbox', { name: 'Queries (one per line)' }), { target: { value: 'first project unsaved query' } })
  switchProjectName('another-fictional-project')
  expect((await screen.findByRole('textbox', { name: 'Queries (one per line)' }) as HTMLTextAreaElement).value).toBe('')
})


test('global setup reset preserves queries saved during this visit', async () => {
  let saved = [{ id: 'saved-a', query: 'saved query A' }]
  const { requests } = renderProjectSetup({
    onboarding: false,
    projectScoped: false,
    readyProviderNames: ['gemini'],
    queryResponse: init => {
      if (init?.method === 'PUT') saved = [{ id: 'saved-a', query: 'saved query A' }, { id: 'saved-b', query: 'saved query B' }]
      return jsonResponse(saved)
    },
  })
  await screen.findByRole('heading', { name: 'Add competitors' })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  fireEvent.change(screen.getByLabelText('Queries (one per line)'), { target: { value: 'saved query A\nsaved query B' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 2 queries' }))
  await screen.findByRole('heading', { name: 'Add competitors' })
  expect(requests.find(request => request.method === 'PUT' && request.path.endsWith('/queries'))?.body).toBe(JSON.stringify({ queries: ['saved query A', 'saved query B'] }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved fields' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('saved query A\nsaved query B')
})


test('counts and saves a pasted repeat once, then reviews the canonical saved queries', async () => {
  let saved: Array<{ id: string; query: string }> = []
  const { requests } = renderProjectSetup({
    onboarding: true,
    queryResponse: init => {
      if (init?.method === 'PUT') saved = [{ id: 'canonical-query', query: 'best local dentist' }]
      return jsonResponse(saved)
    },
  })
  // Repeats differ only in case and surrounding spaces, as the server's query replace treats them.
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'best local dentist\n  Best Local Dentist  \nbest local dentist' } })
  expect(within(screen.getByRole('region', { name: 'Add queries' })).getByText('1 query')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))
  await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })
  expect(requests.find(request => request.method === 'PUT' && request.path.endsWith('/queries'))?.body).toBe(JSON.stringify({ queries: ['best local dentist'] }))
  fireEvent.click(screen.getByText('Review saved queries', { selector: 'summary' }))
  expect(within(screen.getByRole('list', { name: 'Queries in this check' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['best local dentist'])
  const checkDetails = await screen.findByRole('region', { name: 'Check details' })
  expect(within(checkDetails).getByText((_, element) => element?.tagName === 'P' && element.textContent === '1 query')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  expect(screen.getByLabelText('Queries (one per line)')).toHaveProperty('value', 'best local dentist')
  const events = requests.filter(request => request.path.endsWith('/telemetry/onboarding')).map(request => JSON.parse(String(request.body)))
  expect(events).toContainEqual(expect.objectContaining({ event: 'onboarding.step_completed', step: 'queries', countBucket: '1' }))
})


test('repairs a failed connection inline and retries without repeating project or query setup', async () => {
  let attempts = 0
  const { requests } = renderProjectSetup({
    onboarding: true,
    projectProviders: ['gemini'],
    readyProviderNames: ['gemini'],
    queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'best local dentist' }]),
    runResponse: init => {
      if (init?.method === 'POST') attempts += 1
      return jsonResponse(runDetailDtoSchema.parse({ id: `failed-run-${attempts}`, projectId: 'project_citypoint', kind: 'answer-visibility', status: 'failed', createdAt: '2026-09-05T12:00:00Z', error: { message: 'Provider authentication failed' }, snapshots: [] }))
    },
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Repair connection' }))
  const key = await screen.findByLabelText('Replace API key')
  expect(key).toHaveProperty('value', '')
  const model = screen.getByText('Instance model: gpt-default', { selector: 'summary' })
  expect(model.closest('details')?.open).toBe(false)
  fireEvent.change(key, { target: { value: 'replacement-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  await waitFor(() => expect(screen.queryByLabelText('Replace API key')).toBeNull())
  expect(requests.find(request => request.path.endsWith('/providers/gemini') && request.method === 'PUT')?.body).toBe(JSON.stringify({ expectedRevision: 'saved-revision', apiKey: 'replacement-test-key' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Retry check' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Retry check' }))
  await waitFor(() => expect(attempts).toBe(2))
  await waitFor(() => {
    const outcomes = requests.filter(request => request.path.endsWith('/telemetry/onboarding')).map(request => JSON.parse(String(request.body))).filter(event => event.event === 'onboarding.blocked' && event.step === 'run')
    expect(outcomes).toHaveLength(2)
  })
  expect(navigate).not.toHaveBeenCalled()
  expect(requests.filter(request => request.path.endsWith('/queries') && request.method === 'PUT')).toEqual([])
})


test('keeps the first saved answer mounted while a completed run refreshes the project overview', async () => {
  let completed = false
  let resolveOverview: ((response: Response) => void) | undefined
  const { queryClient, updateRun } = renderColdScopedSetup(
    () => jsonResponse({ answerVisibilityProviderReady: true }),
    undefined,
    () => completed ? new Promise<Response>(resolve => { resolveOverview = resolve }) : jsonResponse(null),
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run check' })).toHaveProperty('disabled', false))
  expect(screen.queryByRole('region', { name: 'AI engines' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  await screen.findByText('Your check is running. You can leave this page and return to its progress.')
  // The start time reads in the viewer's zone, as the dashboard's "Last sweep" does.
  const started = document.querySelector('p[role="status"] time')!
  expect(started.textContent).toBe(formatSweepInstant(started.getAttribute('dateTime')!))
  expect(started.textContent).not.toContain('UTC')

  completed = true
  updateRun({ status: 'completed', snapshots: [setupResultSnapshot({ provider: 'local', answerText: 'A saved answer from the engine.' })] })
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsByIdQueryKey({ client: heyClient, path: { id: 'scoped-run' } }) })
  await screen.findByRole('heading', { name: 'Your first AI Visibility result' })
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient, query: { kind: 'answer-visibility' } }) })
  await waitFor(() => expect(resolveOverview).toBeTypeOf('function'))
  expect(screen.getByRole('heading', { name: 'Saved answers' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Your first saved answer' })).getByText('Local')).toBeTruthy()
  expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'City Point Dental · all queries')).toBeTruthy()
  expect(resultFigures()).toContainEqual(['Engine results', '1 · all queries'])
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reset unsaved fields' })).toBeNull()
  resolveOverview?.(jsonResponse(null))
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  expect(screen.getByRole('heading', { name: 'Your first AI Visibility result' })).toBeTruthy()
})


test.each([false, true])('refuses a stale successful preview after a failed refresh and allows recovery (retry: %s)', async retry => {
  let previewFailed = false
  const { queryClient, projectName, requests } = renderProjectSetup({
    onboarding: false,
    queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'best local dentist' }]),
    previewResponse: () => previewFailed
      ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Preview unavailable' } }, 503)
      : jsonResponse(runPreviewFixture(1)),
    runResponse: () => jsonResponse(runDetailDtoSchema.parse({ id: 'failed-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'failed', createdAt: '2026-09-05T12:00:00Z', error: { message: 'Provider authentication failed' }, snapshots: [] })),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run check' })).toHaveProperty('disabled', false))
  if (retry) fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  const actionName = retry ? 'Retry check' : 'Run check'
  await waitFor(() => expect(screen.getByRole('button', { name: actionName })).toHaveProperty('disabled', false))

  previewFailed = true
  const previewKey = getApiV1ProjectsByNameRunPreviewQueryKey({ client: heyClient, path: { name: projectName } })
  await queryClient.invalidateQueries({ queryKey: previewKey })
  await screen.findByText('Could not load the check details.')
  expect(queryClient.getQueryData(previewKey)).toMatchObject({ canStart: true })
  expect(screen.getByRole('button', { name: actionName })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: actionName }))
  const launches = () => requests.filter(request => request.path.endsWith('/runs') && request.method === 'POST')
  expect(launches()).toHaveLength(retry ? 1 : 0)

  previewFailed = false
  fireEvent.click(screen.getByRole('button', { name: 'Refresh check details' }))
  await waitFor(() => expect(screen.getByRole('button', { name: actionName })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: actionName }))
  await waitFor(() => expect(launches()).toHaveLength(retry ? 2 : 1))
})


test('names the engine step and marks the first check complete once it saves answers', async () => {
  renderProjectSetup({
    onboarding: false,
    queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'best local dentist' }]),
    runResponse: () => jsonResponse(runDetailDtoSchema.parse({
      id: 'first-check', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'completed', createdAt: '2026-09-05T12:00:00Z',
      snapshots: [setupResultSnapshot({ runId: 'first-check', answerText: 'A saved answer.' })],
    })),
  })
  const steps = () => within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem')
    .map(step => ({ text: step.textContent, current: step.getAttribute('aria-current') }))
  const proceed = await screen.findByRole('button', { name: 'Continue' })
  // The step starts with connecting an engine when none is ready.
  expect(steps()).toEqual([{ text: '1Engines and queries', current: 'step' }, { text: '2First check', current: null }])
  fireEvent.click(proceed)
  expect(steps()).toEqual([{ text: '✓Engines and queriesComplete', current: null }, { text: '2First check', current: 'step' }])

  await waitFor(() => expect(screen.getByRole('button', { name: 'Run check' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  await screen.findByRole('heading', { name: 'Your first AI Visibility result' })
  expect(steps()).toEqual([{ text: '✓Engines and queriesComplete', current: null }, { text: '✓First checkComplete', current: null }])
})

test('appends only new generated queries, says how many repeats it skipped, and saves each query once', async () => {
  const generated = [
    () => jsonResponse({ error: { code: 'PROVIDER_ERROR', message: 'The provider could not suggest queries.' } }, 502),
    () => jsonResponse({ queries: ['Best Local Dentist', 'emergency dentist', 'emergency dentist', 'family dentist'], provider: 'gemini' }),
    () => jsonResponse({ queries: [' kids dentist ', 'teeth whitening'], provider: 'gemini' }),
  ]
  let attempt = 0
  const { requests } = renderProjectSetup({
    onboarding: true,
    queryResponse: init => jsonResponse(init?.method === 'PUT'
      ? (JSON.parse(String(init.body)) as { queries: string[] }).queries.map((query, index) => ({ id: `query-${index}`, query }))
      : []),
    generateResponse: () => generated[attempt++]!(),
  })
  const input = await screen.findByLabelText('Queries (one per line)') as HTMLTextAreaElement
  // Neutral guidance rather than one industry's example queries.
  expect(input.placeholder).toBe('One query per line')
  fireEvent.change(input, { target: { value: 'best local dentist\nkids dentist' } })
  const panel = screen.getByText('Generate query suggestions', { selector: 'summary' }).closest('details')!
  fireEvent.click(within(panel).getByText('Generate query suggestions', { selector: 'summary' }))

  fireEvent.click(within(panel).getByRole('button', { name: 'Generate' }))
  expect((await within(panel).findByRole('alert')).textContent).toBe('The provider could not suggest queries.')

  fireEvent.click(await within(panel).findByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(input.value).toBe('best local dentist\nkids dentist\nemergency dentist\nfamily dentist'))
  expect(within(panel).queryByRole('alert')).toBeNull()
  expect(within(panel).getByRole('status').textContent).toBe('2 duplicates skipped')

  fireEvent.click(await within(panel).findByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(input.value).toBe('best local dentist\nkids dentist\nemergency dentist\nfamily dentist\nteeth whitening'))
  expect(within(panel).getByRole('status').textContent).toBe('1 duplicate skipped')

  // A repeat typed or pasted by hand counts once as well.
  fireEvent.change(input, { target: { value: `${input.value}\nFamily Dentist` } })
  expect(within(screen.getByRole('region', { name: 'Add queries' })).getByText('5 queries')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save 5 queries' }))
  await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })
  expect(requests.find(request => request.method === 'PUT' && request.path.endsWith('/queries'))?.body).toBe(JSON.stringify({
    queries: ['best local dentist', 'kids dentist', 'emergency dentist', 'family dentist', 'teeth whitening'],
  }))
})

test('reviews the website, market and location as one list before the first check', async () => {
  const { domain } = renderProjectSetup({ onboarding: false, queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'best local dentist' }]) })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const details = await screen.findByRole('region', { name: 'Check details' })
  const values = within(details).getAllByRole('definition')
  expect(within(details).getAllByRole('term').map((term, index) => [term.textContent, values[index]!.textContent])).toEqual([
    ['Website', domain],
    ['Market', 'United States · English'],
    ['Location', 'No location targeting'],
  ])
})

test('counts saved engine results against the requests previewed for the check launched here', async () => {
  let snapshots: RunDetailDto['snapshots'] = []
  const startedAt = '2026-09-05T12:00:30Z'
  const { queryClient } = renderProjectSetup({
    onboarding: false,
    queryResponse: () => jsonResponse([
      { id: 'query-1', query: 'best local dentist' },
      { id: 'query-2', query: 'emergency dentist' },
      { id: 'query-3', query: 'family dentist' },
    ]),
    runResponse: init => jsonResponse(runDetailDtoSchema.parse(init?.method === 'POST'
      ? { id: 'progress-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'queued', createdAt: '2026-09-05T12:00:00Z' }
      : { id: 'progress-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'running', createdAt: '2026-09-05T12:00:00Z', startedAt, snapshots })),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  // The preview counts 3 provider requests: three queries on one engine.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run check' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  const progress = (text: string) => (_: string, element: Element | null) => element?.getAttribute('role') === 'status' && element.textContent === text
  expect(await screen.findByText(progress(`0 of 3 engine results saved · Started ${formatSweepInstant(startedAt)}`))).toBeTruthy()

  snapshots = [setupResultSnapshot({ runId: 'progress-run' })]
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsByIdQueryKey({ client: heyClient, path: { id: 'progress-run' } }) })
  expect(await screen.findByText(progress(`1 of 3 engine results saved · Started ${formatSweepInstant(startedAt)}`))).toBeTruthy()
})

test('a check resumed from an earlier visit shows its saved results without a planned total', async () => {
  const startedAt = '2026-09-05T12:00:30Z'
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status: 'running', startedAt, snapshots: [setupResultSnapshot({})] })
  expect(await screen.findByText((_, element) => element?.getAttribute('role') === 'status'
    && element.textContent === `1 engine result saved · Started ${formatSweepInstant(startedAt)}`)).toBeTruthy()
})

test('says what each provider to connect is and what connecting it takes', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    includeLocalProvider: true,
    extraProviders: [
      { name: 'perplexity', displayName: 'Perplexity' },
      { name: 'muse', displayName: 'Muse' },
      { name: 'openrouter', displayName: 'OpenRouter' },
    ],
  })
  const provider = () => screen.getByRole('combobox', { name: 'Provider to connect' }) as HTMLSelectElement
  // Gemini stays the first choice.
  expect((await screen.findByRole('combobox', { name: 'Provider to connect' }) as HTMLSelectElement).value).toBe('Gemini')
  for (const [value, guidance] of [
    ['Gemini', "Google's Gemini models, answering with Google Search. Needs an API key."],
    ['OpenAI', "OpenAI's GPT models, answering with web search. Needs an API key."],
    ['Claude', "Anthropic's Claude models, answering with web search. Needs an API key."],
    ['local', 'A model you run on an OpenAI-compatible server, without web search. Needs its base URL; an API key is optional.'],
    ['perplexity', 'Perplexity, answering with web search. Needs an API key.'],
    ['muse', "Meta's Muse models, answering with web search. Needs a Meta Model API key."],
    ['openrouter', 'Models from several makers through one key. You choose which models to check. Needs an API key.'],
  ] as const) {
    if (provider().value !== value) fireEvent.change(provider(), { target: { value } })
    expect(screen.getByRole('combobox', { name: 'Provider to connect', description: guidance })).toHaveProperty('value', value)
  }
})
