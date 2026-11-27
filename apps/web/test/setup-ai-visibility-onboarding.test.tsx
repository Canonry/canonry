import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey, getApiV1ProjectsByNameRunPreviewQueryKey, getApiV1RunsByIdQueryKey, getApiV1RunsQueryKey } from '@canonry/canonry-api-client/react-query'
import type { ReactNode } from 'react'
import { querySnapshotDtoSchema, runDetailDtoSchema, type ProviderConnectionLastTestDto, type RunDetailDto } from '@canonry/canonry-contracts'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { clearOnboardingRunLaunched, readOnboardingLaunchedRun } from '../src/lib/onboarding-telemetry.js'
import { getToasts } from '../src/lib/toast-store.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { AiVisibilitySetupPanel, type SetupPanelStep } from '../src/components/setup/AiVisibilitySetupPanel.js'
import { MANAGED_SWEEPS_COPY, MANAGED_SWEEPS_UNAVAILABLE_COPY } from '../src/components/project/ManagedSweepStatus.js'
import { connectionFixture, settingsFixture } from './provider-settings-fixtures.js'
import { PROVIDER_CONNECTION_TEST_COPY } from '../src/components/settings/ProviderConnectionTest.js'
import { ProviderConnectionsSection } from '../src/components/settings/ProviderConfigForm.js'
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
  /**
   * Render the setup tracker's AI Visibility panel, with spy callbacks, instead
   * of the page (the project-scoped page, or the whole wizard without a project).
   */
  panel: boolean
  /** Where the panel opens: the tracker picks it from the server's blocker. */
  panelStep?: SetupPanelStep
  /** The tracker's `hasBaseline`: the setup read names a baseline run. */
  panelHasBaseline?: boolean
  projectScoped?: boolean
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
  /** Answers `POST /settings/providers/:name/test`. */
  providerTestResponse?: (name: string) => Response | Promise<Response>
  /** The stored last test an administrator's settings read carries, by provider name. */
  providerLastTests?: Record<string, ProviderConnectionLastTestDto | null>
  /** The saved connection revision an administrator's settings read carries, by provider name. */
  providerRevisions?: Record<string, string>
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
    project.queryCounts = { cited: 0, total: 0, citationNotMeasured: 0 }
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
  for (const [name, lastTest] of Object.entries(options.providerLastTests ?? {})) {
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => (
      provider.name.toLowerCase() === name ? { ...provider, revision: `${name}-revision`, lastTest } : provider
    ))
  }
  for (const [name, revision] of Object.entries(options.providerRevisions ?? {})) {
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => (
      provider.name.toLowerCase() === name ? { ...provider, revision } : provider
    ))
  }

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
    const tested = pathOf(url).match(/^\/api\/v1\/settings\/providers\/([^/]+)\/test$/)
    if (tested && init?.method === 'POST' && options.providerTestResponse) return options.providerTestResponse(decodeURIComponent(tested[1]!))
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
  const panel = {
    initialStep: options.panelStep ?? 'engine',
    onClose: vi.fn<() => void>(),
    onLaunched: vi.fn<(runId: string) => void>(),
  }
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={options.apiKey}>
        <DashboardProvider value={fixture}>
          {options.panel
            ? <AiVisibilitySetupPanel projectName={project.project.name} initialStep={panel.initialStep} hasBaseline={options.panelHasBaseline} onClose={panel.onClose} onLaunched={panel.onLaunched} />
            : <SetupPage visibilityProjectName={options.projectScoped === false ? undefined : project.project.name} />}
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
    panel,
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

test('picks and saves several OpenRouter models in the AI engine step before allowing the first check', async () => {
  const { requests, projectName } = renderProjectSetup({ panel: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]) })
  expect(await screen.findByText('Choose models')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
  // The models are picked right here: one picker with no Add models step, and
  // changing the key stays a secondary action.
  const picker = await screen.findByRole('group', { name: 'Choose OpenRouter models' })
  expect(screen.queryByRole('button', { name: 'Add models', exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Connect another engine' })).toBeTruthy()
  // Until models are saved, the picker carries the step's action and Continue stays secondary.
  expect(screen.getByRole('button', { name: 'Continue' }).classList.contains('bg-accent')).toBe(false)
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'Model A' }))
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'Model B' }))
  fireEvent.click(within(picker).getByRole('button', { name: 'Save 2 models' }))
  const projectPath = `/api/v1/projects/${encodeURIComponent(projectName)}`
  await waitFor(() => expect(requests.some(request => request.path === projectPath && request.method === 'PUT')).toBe(true))
  const saveIndex = requests.findIndex(request => request.path === projectPath && request.method === 'PUT')
  expect(JSON.parse(String(requests[saveIndex]?.body))).toMatchObject({ providers: ['openrouter:vendor/model-a', 'openrouter:vendor/model-b'], providerModels: {} })
  // Readiness is read again after the save, and the step now reads as configured.
  await waitFor(() => expect(requests.slice(saveIndex + 1).some(request => request.path === '/api/v1/projects' && request.method === 'GET')).toBe(true))
  expect(await screen.findByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
  // The saved models are named from OpenRouter's catalog, not by raw ID.
  const engines = await screen.findByRole('list', { name: 'Saved AI engines' })
  expect(within(engines).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Model AOpenRouter', 'Model BOpenRouter'])
  expect(screen.queryByText('Choose models')).toBeNull()
  expect(screen.queryByRole('group', { name: 'Choose OpenRouter models' })).toBeNull()

  // On through the saved queries to the check, which can now start.
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const launch = await screen.findByRole('button', { name: 'Run first check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(false))
  expect(screen.getByText('Change engines', { selector: 'summary' }).closest('details')?.open).toBe(false)
  expect(requests.some(request => request.path.endsWith('/runs') && request.method === 'POST')).toBe(false)
})

test('a corrected OpenRouter key refreshes the model list without leaving the step', async () => {
  // A wrong key leaves the catalog empty. Fixing it in place must bring the
  // models in right away, not after the settings read goes stale.
  let models: Array<{ id: string; displayName: string }> = []
  renderProjectSetup({
    panel: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => jsonResponse(openRouterSettings(models)),
    providerResponse: () => jsonResponse(connectionFixture({ name: 'openrouter', displayName: 'OpenRouter', kind: 'model-gateway' })),
  })
  expect(await screen.findByText(/Couldn't load OpenRouter's model list/)).toBeTruthy()
  const settingsLink = screen.getByRole('link', { name: 'Settings' })
  expect(settingsLink.getAttribute('target')).toBe('_blank')

  fireEvent.click(screen.getByRole('button', { name: 'Connect another engine' }))
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
    panel: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => respond(),
  })
  expect(await screen.findByText('Loading OpenRouter models…')).toBeTruthy()
  cleanup()

  respond = () => jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500)
  renderProjectSetup({
    panel: true, openRouter: true, projectProviders: [], readyProviderNames: [], queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    settingsResponse: () => respond(),
  })
  expect(await screen.findByText("Couldn't load OpenRouter's model list.")).toBeTruthy()
  respond = () => jsonResponse(openRouterSettings([{ id: 'vendor/model-a', displayName: 'Model A' }]))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const picker = await screen.findByRole('group', { name: 'Choose OpenRouter models' })
  expect(await within(picker).findByRole('checkbox', { name: 'Model A' })).toBeTruthy()
})

test('the tracker panel shows one step at a time under the row: the AI engine, then queries, with no page header or skip', async () => {
  const { panel } = renderProjectSetup({ panel: true, providerReady: false })

  // The tracker row is the panel's heading, so a step's sections sit one level below it.
  const engines = await screen.findByRole('heading', { level: 3, name: 'AI engines' })
  // The panel replaced the button that opened it, so its first heading takes the focus.
  await waitFor(() => expect(document.activeElement).toBe(engines))
  const steps = screen.getByRole('list', { name: 'AI Visibility steps' })
  expect(within(steps).getAllByRole('listitem').map(item => [item.textContent, item.getAttribute('aria-current')])).toEqual([
    ['1AI engine', 'step'],
    ['·2Queries', null],
    ['·3First check', null],
  ])
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()
  expect(screen.queryAllByRole('heading', { level: 1 })).toEqual([])
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  // The provider form's Save connection is this step's one primary action.
  expect(screen.getByRole('button', { name: 'Save connection' }).classList.contains('bg-accent')).toBe(true)
  expect(screen.getByRole('button', { name: 'Continue' }).classList.contains('bg-accent')).toBe(false)
  // Not starting AI Visibility is the skip, so the panel offers none.
  for (const name of ['Reset unsaved fields', 'Finish without AI Visibility', 'Skip for now']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }

  // Queries can be saved before an engine is connected, so the step moves on without one.
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  const queries = await screen.findByRole('heading', { level: 3, name: 'Add queries' })
  await waitFor(() => expect(document.activeElement).toBe(queries))
  expect(screen.queryByRole('heading', { name: 'AI engines' })).toBeNull()
  expect(within(steps).getByText('Queries').closest('li')?.getAttribute('aria-current')).toBe('step')
  expect(screen.getByRole('textbox', { name: 'Queries (one per line)' })).toBeTruthy()

  // Back steps through the panel before it hands the row back to the tracker; nothing navigates.
  fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
  expect(await screen.findByRole('heading', { level: 3, name: 'AI engines' })).toBeTruthy()
  expect(panel.onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(panel.onClose).toHaveBeenCalledTimes(1)
  expect(navigate).not.toHaveBeenCalled()
})

test.each([
  { complete: false, heading: 'Run your first AI Visibility check', run: 'Run first check', step: '·3First check' },
  // A project with a baseline reviews a later check, not its first.
  { complete: true, heading: 'Run an AI Visibility check', run: 'Run check', step: '·3Check' },
])('the tracker panel opened at the check review shows it and nothing to skip (saved baseline: $complete)', async ({ complete, heading, run, step }) => {
  const { panel } = renderProjectSetup({ panel: true, panelStep: 'first-check', complete, panelHasBaseline: complete, queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]) })

  expect(await screen.findByRole('heading', { level: 3, name: heading })).toBeTruthy()
  expect(screen.getByRole('button', { name: run })).toBeTruthy()
  expect(within(screen.getByRole('list', { name: 'AI Visibility steps' })).getAllByRole('listitem').at(-1)?.textContent).toBe(step)
  // A saved baseline does not turn the review into an exit: the tracker asked for a check.
  expect(screen.queryByText(/has saved AI Visibility results/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Finish without running' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()

  // Back moves between the panel's steps before it closes the panel.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(await screen.findByRole('heading', { level: 3, name: 'Add queries' })).toBeTruthy()
  expect(panel.onClose).not.toHaveBeenCalled()
})

test('launching from the tracker panel hands the queued run to the tracker', async () => {
  const { panel, requests } = renderProjectSetup({
    panel: true,
    panelStep: 'first-check',
    queryResponse: () => jsonResponse([{ id: 'query-1', query: 'best local dentist' }]),
    runResponse: init => jsonResponse(runDetailDtoSchema.parse({ id: 'panel-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'queued', createdAt: '2026-09-05T12:00:00Z' }), init?.method === 'POST' ? 202 : 200),
  })
  const launch = await screen.findByRole('button', { name: 'Run first check' })
  await waitFor(() => expect(launch).toHaveProperty('disabled', false))
  expect(panel.onLaunched).not.toHaveBeenCalled()

  fireEvent.click(launch)

  await waitFor(() => expect(panel.onLaunched).toHaveBeenCalledWith('panel-run'))
  expect(panel.onLaunched).toHaveBeenCalledTimes(1)
  expect(requests.filter(request => request.method === 'POST' && request.path.endsWith('/runs'))).toHaveLength(1)
  expect(panel.onClose).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
})

test('setup actions stay compact beside a mouse and are 44px targets under a finger', async () => {
  renderProjectSetup({ panel: true, providerReady: false })
  // Beside a desktop mouse, on a narrow screen, and under a finger. Buttons keep the shared Button height beside a mouse.
  const minHeights = async (element: HTMLElement) => {
    const rules = parseCompiledCss(await compileAppStyles([...element.classList]))
    return [undefined, '@media (width < 48rem)', '@media (pointer: coarse)'].map(context => {
      const value = compiledElementProperty(rules, element, 'min-height', context)
      return value === undefined ? 0 : cssLengthPx(value, rules)
    })
  }
  // Main's calmer onboarding names the provider step "AI engines".
  await screen.findByRole('heading', { name: 'AI engines' })
  expect(await minHeights(screen.getByRole('button', { name: 'Refresh connections' }))).toEqual([0, 44, 44])
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByText('Research queries with your agent', { selector: 'summary' }))
  expect(await minHeights(screen.getByRole('button', { name: 'Copy research prompt' }))).toEqual([0, 44, 44])
})

test('allows a project-scoped write key to configure its exact project', async () => {
  renderProjectSetup({
    panel: true,
    apiKey: {
      id: 'project-writer',
      scopes: ['*'],
      projectId: 'project_citypoint',
      readOnly: false,
    },
  })

  expect(await screen.findByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect(screen.queryByText(/for administrators/i)).toBeNull()
  expect(screen.getByRole('button', { name: /administrator/ })).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
})

test('keeps Gemini onboarding guidance out of administrator-only setup for a read-only key', async () => {
  // The tracker never opens its panel for a key that cannot write; the page is where this account lands.
  renderProjectSetup({
    panel: false,
    providerReady: false,
    apiKey: { id: 'read-only-key', scopes: ['read'], projectId: null, readOnly: true },
  })
  expect(await screen.findByText('Set up AI Visibility is for administrators')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
})

test('introduces Gemini free-tier setup before the API key field with its limits and official links', async () => {
  renderProjectSetup({ panel: true, providerReady: false })
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
  const { requests } = renderProjectSetup({ panel: true, providerReady: false })
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
  const { requests } = renderProjectSetup({ panel: true, providerReady: false, includeLocalProvider: true })
  // A query drafted on the next step survives everything the provider form does.
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'keep this query draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'synthetic-gemini-key' } })
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

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(screen.getByLabelText('Provider to connect')).toHaveProperty('value', 'Gemini'))
  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'local' } })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Provider to connect')))
  expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('')
  expect(requests.filter(request => request.method === 'PUT')).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect((await screen.findByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query draft')
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
        <SetupPage visibilityProjectName={project.name} />
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
  expect(await screen.findByText(RUNNING_NOTE)).toBeTruthy()
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
  // The onboarding Agent Readiness audit scan shared this marker.
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
  expect(await within(screen.getByRole('region', { name: 'AI engines' })).findByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
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

test('project-scoped setup with a saved baseline exits to the project dashboard in its place', async () => {
  const { projectName } = renderProjectSetup({ panel: false, complete: true })

  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open project dashboard/ }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName',
    params: { projectName },
    replace: true,
  })
})

test('lets an existing query list be refined with researched queries before continuing', async () => {
  const { projectName, requests } = renderProjectSetup({ panel: true, panelStep: 'queries', complete: true })
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

test('lets a project save queries before an engine is connected, then the check leads back to the AI engine step', async () => {
  let saved: Array<{ id: string; query: string }> = []
  renderProjectSetup({
    panel: true,
    panelStep: 'queries',
    providerReady: false,
    queryResponse: init => {
      if (init?.method === 'PUT') saved = [{ id: 'query-1', query: 'best local dentist' }]
      return jsonResponse(saved)
    },
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'best local dentist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
  // The check cannot run without an engine, so its one action is to connect one, not a disabled run.
  expect(screen.queryByRole('button', { name: 'Run first check' })).toBeNull()
  expect(screen.queryByText(/provider allowed by this project/i)).toBeNull()
  const connect = screen.getByRole('button', { name: 'Connect an AI engine' })
  expect(connect.classList.contains('bg-accent')).toBe(true)
  fireEvent.click(connect)
  expect(await screen.findByRole('heading', { name: 'AI engines' })).toBeTruthy()
  const steps = screen.getByRole('list', { name: 'AI Visibility steps' })
  expect(within(steps).getAllByRole('listitem').map(item => item.textContent)).toEqual(['1AI engine', '·Queries, done', '·3First check'])
})

test('offers provider setup before queries and keeps the draft after saving and refreshing readiness', async () => {
  const { requests, markProviderReady } = renderProjectSetup({ panel: true, providerReady: false })
  expect(await screen.findByText('Not connected')).toBeTruthy()
  // The engine is the panel's first step; queries wait on the next one.
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()
  const saveConnection = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement
  expect(saveConnection.disabled).toBe(true)
  expect(saveConnection.parentElement).toBe(screen.getByRole('button', { name: 'Refresh connections' }).parentElement)
  expect(screen.getByText('Advanced provider settings').closest('details')?.open).toBe(false)
  // This is a provider secret, not the dashboard login password.
  const apiKeyField = screen.getByLabelText('API key')
  expect(apiKeyField.getAttribute('autocomplete')).toBe('new-password')
  expect(apiKeyField.getAttribute('autocapitalize')).toBe('none')
  expect(apiKeyField.getAttribute('spellcheck')).toBe('false')

  // A query drafted on the next step survives the key save and the readiness refresh.
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'unsubmitted customer question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  // The notice names the provider as people know it, not by its internal id.
  expect(getToasts().map(toast => toast.detail)).toContain('Gemini configuration saved.')
  expect(requests.find(request => request.path === '/api/v1/settings/providers/gemini')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ apiKey: 'synthetic-test-key' }),
  })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect(requests.some(request => request.path === '/api/v1/settings')).toBe(true)
  expect(screen.getByRole('heading', { name: 'AI engines' })).toBeTruthy()

  // Readiness comes from refreshed settings, not an optimistic key-save result.
  markProviderReady('gemini')
  expect(await screen.findByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
  // With the engine connected, Continue is the step's primary action.
  const next = screen.getByRole('button', { name: 'Continue' })
  expect(next.classList.contains('bg-accent')).toBe(true)
  fireEvent.click(next)
  expect((await screen.findByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(navigate).not.toHaveBeenCalled()
  expect(requests.filter(request => request.method === 'POST' && /\/(?:runs|generate)$/.test(request.path))).toEqual([])
})

test.each([
  {
    outcome: 'passes',
    result: { status: 'connected', ok: true, message: 'gemini api key verified' },
    badge: PROVIDER_CONNECTION_TEST_COPY.connected,
    line: `Gemini: ${PROVIDER_CONNECTION_TEST_COPY.connectedLine} ${PROVIDER_CONNECTION_TEST_COPY.checkedAt('2026-11-08T10:00:00.000Z')}`,
  },
  {
    outcome: 'fails',
    result: { status: 'failed', ok: false, message: '400 API key not valid.' },
    badge: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified,
    line: `Gemini: ${PROVIDER_CONNECTION_TEST_COPY.failed('400 API key not valid.')} ${PROVIDER_CONNECTION_TEST_COPY.checkedAt('2026-11-08T10:00:00.000Z')}`,
  },
])('the engine step tests the saved connection and reads $badge when the test $outcome', async ({ result, badge, line }) => {
  const tested: string[] = []
  renderProjectSetup({
    panel: true,
    readyProviderNames: ['gemini'],
    providerTestResponse: name => {
      tested.push(name)
      return jsonResponse({ provider: name, displayName: 'Gemini', model: 'gemini-2.5-flash', checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 900, ...result })
    },
  })
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  expect(within(engines).getByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
  expect(tested).toEqual([])
  // The test is a live request on the provider account, so the button says so before it is pressed.
  fireEvent.click(within(engines).getByRole('button', { name: PROVIDER_CONNECTION_TEST_COPY.testOne, description: 'Sends one short request to Gemini, using your provider account.' }))
  const results = await within(engines).findByRole('list', { name: PROVIDER_CONNECTION_TEST_COPY.results })
  expect(within(results).getAllByRole('listitem').map(item => item.textContent)).toEqual([line])
  expect(within(engines).getByText(badge)).toBeTruthy()
  expect(tested).toEqual(['gemini'])
})

test('the engine step reads a stored passing test as Connected without testing again', async () => {
  const tested: string[] = []
  const checkedAt = '2026-01-05T09:30:00.000Z'
  renderProjectSetup({
    panel: true,
    readyProviderNames: ['gemini'],
    providerLastTests: { gemini: { status: 'connected', ok: true, message: 'gemini api key verified', model: 'gemini-2.5-flash', checkedAt, durationMs: 800 } },
    providerTestResponse: name => { tested.push(name); return jsonResponse({}) },
  })
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  expect(within(engines).getByText(PROVIDER_CONNECTION_TEST_COPY.connected)).toBeTruthy()
  const results = within(engines).getByRole('list', { name: PROVIDER_CONNECTION_TEST_COPY.results })
  expect(within(results).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    `Gemini: ${PROVIDER_CONNECTION_TEST_COPY.connectedLine} ${PROVIDER_CONNECTION_TEST_COPY.checkedAt(checkedAt)}`,
  ])
  expect(tested).toEqual([])
})

test('tests each saved connection behind the listed engines once, and says first what that sends', async () => {
  const tested: string[] = []
  renderProjectSetup({
    panel: true,
    openRouter: true,
    readyProviderNames: ['gemini'],
    projectProviders: ['gemini', 'openrouter:vendor/model-a', 'openrouter:vendor/model-b'],
    providerTestResponse: name => {
      tested.push(name)
      return jsonResponse({ provider: name, displayName: name, status: 'connected', ok: true, message: `${name} verified`, model: null, checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 500 })
    },
  })
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  // Both OpenRouter models run on the one OpenRouter connection, which is what gets tested.
  const button = await within(engines).findByRole('button', {
    name: PROVIDER_CONNECTION_TEST_COPY.testMany,
    description: 'Sends one short request each to Gemini and OpenRouter, using your provider accounts.',
  })
  fireEvent.click(button)
  await within(engines).findByText(PROVIDER_CONNECTION_TEST_COPY.connected)
  expect([...tested].sort()).toEqual(['gemini', 'openrouter'])
})

test.each([
  { settings: 'unchanged', tested: 'gemini-saved', revision: 'gemini-saved', badge: PROVIDER_CONNECTION_TEST_COPY.connected, stale: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified },
  { settings: 'changed elsewhere since (the CLI or another tab)', tested: 'gemini-saved', revision: 'gemini-rotated', badge: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified, stale: PROVIDER_CONNECTION_TEST_COPY.connected },
  // Setup's read named no revision (no connection details), so the test cannot vouch for these settings.
  { settings: 'unknown to setup when it tested them', tested: undefined, revision: 'gemini-saved', badge: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified, stale: PROVIDER_CONNECTION_TEST_COPY.connected },
])('a pass in setup reads $badge in Settings when the saved settings are $settings', async ({ tested, revision, badge, stale }) => {
  const { queryClient } = renderProjectSetup({
    panel: true,
    readyProviderNames: ['gemini'],
    ...(tested ? { providerRevisions: { gemini: tested } } : {}),
    providerTestResponse: name => jsonResponse({ provider: name, displayName: 'Gemini', status: 'connected', ok: true, message: 'gemini api key verified', model: 'gemini-2.5-flash', checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 900 }),
    settingsResponse: () => jsonResponse(settingsFixture([connectionFixture({ name: 'gemini', displayName: 'Gemini', revision })])),
  })
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  fireEvent.click(within(engines).getByRole('button', { name: PROVIDER_CONNECTION_TEST_COPY.testOne }))
  await within(engines).findByText(PROVIDER_CONNECTION_TEST_COPY.connected)
  // Leave setup for Settings in the same tab.
  cleanup()
  render(<QueryClientProvider client={queryClient}><ProviderConnectionsSection projects={[]} /></QueryClientProvider>)
  const row = await waitFor(() => {
    const found = document.getElementById('provider-gemini')
    if (!found) throw new Error('No Gemini row yet')
    return found
  })
  expect(within(row).getByText(badge)).toBeTruthy()
  expect(within(row).queryByText(stale)).toBeNull()
})

test('keeps failed provider setup retryable without losing queries', async () => {
  let attempt = 0
  renderProjectSetup({
    panel: true,
    providerReady: false,
    providerResponse: () => ++attempt === 1
      ? jsonResponse({ error: { message: 'Key could not be saved', code: 'VALIDATION_ERROR' } }, 400)
      : jsonResponse({ name: 'gemini', configured: true }),
  })
  // A query drafted on the next step survives a failed key save.
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'keep this query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  const keyInput = await screen.findByLabelText('API key')
  fireEvent.change(keyInput, { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Key could not be saved')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect((await screen.findByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query')
})

test('requires the local endpoint, not an API key, when Local is selected', async () => {
  const { requests } = renderProjectSetup({ panel: true, providerReady: false, projectProviders: ['local'], includeLocalProvider: true })
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
    panel: true, providerReady: false,
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
  const { projectName, domain, requests } = renderProjectSetup({ panel: true, panelStep: 'queries', providerReady: false })
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
  renderProjectSetup({ panel: true, panelStep: 'queries' })
  fireEvent.click(await screen.findByText('Research queries with your agent', { selector: 'summary' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy research prompt' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not copy. Select and copy the prompt above.')
  expect(screen.getByLabelText('Agent query research prompt').closest('details')?.open).toBe(true)
})

test('blocks launch when the ready provider is outside the project allowlist', async () => {
  renderProjectSetup({
    panel: true,
    panelStep: 'queries',
    projectProviders: ['claude'],
    readyProviderNames: ['gemini'],
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByRole('heading', { name: 'Run your first AI Visibility check' })).toBeTruthy()
  // The ready engine is not one this project allows, so the check cannot run and leads to the AI engine step.
  expect(screen.queryByRole('button', { name: 'Run first check' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect an AI engine' }))
  expect((await screen.findByLabelText('Provider to connect') as HTMLSelectElement).value).toBe('Claude')
  expect(within(screen.getByLabelText('Provider to connect')).queryByRole('option', { name: 'Gemini' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Connect Gemini' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a key in Google AI Studio ↗' })).toBeNull()
})

test('treats a registered project-selected CDP provider as runnable', async () => {
  let savedQueries: Array<{ id: string; query: string }> = []
  renderProjectSetup({
    panel: true,
    panelStep: 'queries',
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
  const launch = screen.getByRole('button', { name: 'Run first check' }) as HTMLButtonElement
  await waitFor(() => expect(launch.disabled).toBe(false))
  expect(screen.queryByRole('link', { name: 'Connect another engine' })).toBeNull()
})

test('invalidates project query and dashboard caches after project-scoped query setup', async () => {
  const { projectId, projectName, queryClient } = renderProjectSetup({
    panel: true,
    panelStep: 'queries',
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
    panel: false,
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
    await screen.findByRole('table', { name: RESULT_TABLE })
    expect(resultRows()).toEqual([['All queries', 'Unavailable', 'Unavailable']])
    expect(resultSummary('City Point Dental · 1 answer')).toBeTruthy()
  } else if (status === 'failed') {
    expect(await screen.findByText('Provider quota exceeded')).toBeTruthy()
  } else {
    expect(await screen.findByText(RUNNING_NOTE)).toBeTruthy()
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
const RESULT_TABLE = 'First AI Visibility check by query class'
/** The running check's reassurance, after its start time. */
const RUNNING_NOTE = /You can leave this page\. The check keeps running\./

/** The first result's rows as [query class, mentioned, cited]. */
function resultRows() {
  const table = screen.getByRole('table', { name: RESULT_TABLE })
  return within(table).getAllByRole('row').slice(1).map(row => [
    within(row).getByRole('rowheader').textContent,
    ...within(row).getAllByRole('cell').map(cell => cell.textContent),
  ])
}

/** The line above the table: the project and how many answers the run saved. */
function resultSummary(text: string) {
  return screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === text)
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
  // Local (no web access) returns no sources: its citation is never measured.
  {
    scenario: 'a first run whose engine returns no sources reads cited as not measured, never 0',
    status: 'completed',
    snapshots: [setupResultSnapshot({ provider: 'local', citationState: 'not-measured', answerText: 'City Point Dental is a common pick.' })],
    queryCounts: { totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 1 },
    mentioned: '1 of 1 query', cited: 'Not measured', checks: '1',
    featuredCitation: 'Not measured',
  },
  {
    scenario: 'queries only an engine without sources answered leave the cited base',
    status: 'completed',
    snapshots: [setupResultSnapshot({}), setupResultSnapshot({ id: 'snapshot_two', provider: 'local', citationState: 'not-measured' })],
    queryCounts: { totalQueries: 3, citedQueries: 1, mentionedQueries: 2, citationNotMeasuredQueries: 1 },
    mentioned: '2 of 3 queries', cited: '1 of 2 queries', checks: '2',
  },
])('setup results render the per-run API summary: $scenario', async (row) => {
  const { status, snapshots, queryCounts, mentioned, cited, checks } = row
  const run = runDetailDtoSchema.parse({
    id: 'scoped-run', projectId: 'project_citypoint', kind: 'answer-visibility', status,
    createdAt: '2026-09-05T12:00:00Z', snapshots, queryCounts,
  })
  const { requests } = renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), run)
  const resultHeading = await screen.findByRole('heading', { name: 'Saved answers', level: 2 })

  // A server without the class split gives pooled counts, so the one row says it is all queries.
  expect(resultSummary(`City Point Dental · ${checks} ${checks === '1' ? 'answer' : 'answers'}`)).toBeTruthy()
  expect(resultRows()).toEqual([['All queries', mentioned, cited]])
  // In view on arrival, not behind a disclosure.
  const summary = screen.getByRole('table', { name: RESULT_TABLE })
  expect(summary.closest('details')).toBeNull()
  let resultCard = resultHeading.parentElement!
  while (!resultCard.contains(summary)) resultCard = resultCard.parentElement!
  expect(within(resultCard).getByText('Complete')).toBeTruthy()
  expect(screen.queryByText(RUNNING_NOTE)).toBeNull()
  if ('featuredCitation' in row) {
    // The first saved answer says the same as the Cited figure: an engine without sources is never "Not cited".
    const featured = await screen.findByRole('region', { name: 'Your first saved answer' })
    expect(within(featured).getByText(row.featuredCitation)).toBeTruthy()
    expect(within(featured).queryByText('Not cited')).toBeNull()
  }
  expect(requests).toContain('/api/v1/runs/scoped-run')
  expect(requests).not.toContain('/api/v1/projects/scoped-project/runs')
})

test.each([
  {
    scenario: 'non-brand leads and branded keeps its own denominator',
    byClass: {
      nonBrand: { totalQueries: 3, citedQueries: 1, mentionedQueries: 0, citationNotMeasuredQueries: 0 },
      branded: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
      unclassifiedQueries: 0,
    },
    rows: [['Non-brand', '0 of 3 queries', '1 of 3 queries'], ['Branded', '1 of 1 query', '1 of 1 query']],
    note: null,
  },
  {
    scenario: 'a class with no queries gets no row, and unmeasured citations read not measured',
    byClass: {
      nonBrand: { totalQueries: 2, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 2 },
      branded: { totalQueries: 0, citedQueries: 0, mentionedQueries: 0, citationNotMeasuredQueries: 0 },
      unclassifiedQueries: 0,
    },
    rows: [['Non-brand', '1 of 2 queries', 'Not measured']],
    note: null,
  },
  {
    scenario: 'queries with no single class are named, not counted',
    byClass: {
      nonBrand: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
      branded: { totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
      unclassifiedQueries: 2,
    },
    rows: [['Non-brand', '1 of 1 query', '1 of 1 query'], ['Branded', '1 of 1 query', '0 of 1 query']],
    note: '2 queries have no single query class and are not counted above.',
  },
])('setup results show each query class on its own row: $scenario', async ({ byClass, rows, note }) => {
  // The pooled counts disagree with the split on purpose: the rows must come from queryCountsByClass alone.
  const run = runDetailDtoSchema.parse({
    id: 'scoped-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'completed',
    createdAt: '2026-09-05T12:00:00Z', snapshots: [setupResultSnapshot({})],
    queryCounts: { totalQueries: 9, citedQueries: 9, mentionedQueries: 9, citationNotMeasuredQueries: 0 },
    queryCountsByClass: byClass,
  })
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), run)
  await screen.findByRole('table', { name: RESULT_TABLE })
  expect(resultRows()).toEqual(rows)
  expect(screen.queryByRole('rowheader', { name: 'All queries' })).toBeNull()
  if (note) expect(screen.getByText(note)).toBeTruthy()
  else expect(screen.queryByText(/no single query class/)).toBeNull()
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
  const summary = screen.getByRole('table', { name: RESULT_TABLE })
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

test('finishing project-scoped setup without AI Visibility returns to the project', async () => {
  const { projectName } = renderProjectSetup({ panel: false })
  fireEvent.click(await screen.findByRole('button', { name: 'Finish without AI Visibility' }))
  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName',
    params: { projectName },
    replace: true,
  })
})


test('restores unsaved setup queries after reload and resets to saved queries without retaining credentials', async () => {
  const options = { panel: false, providerReady: false, queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'saved customer query' }]) }
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
  const { switchProjectName } = renderProjectSetup({ panel: true, panelStep: 'queries', providerReady: false })
  fireEvent.change(await screen.findByRole('textbox', { name: 'Queries (one per line)' }), { target: { value: 'first project unsaved query' } })
  switchProjectName('another-fictional-project')
  expect((await screen.findByRole('textbox', { name: 'Queries (one per line)' }) as HTMLTextAreaElement).value).toBe('')
})


test('global setup reset preserves queries saved during this visit', async () => {
  let saved = [{ id: 'saved-a', query: 'saved query A' }]
  const { requests } = renderProjectSetup({
    panel: false,
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
    panel: false,
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
    panel: false,
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
  await screen.findByText(RUNNING_NOTE)
  // The start time reads in the viewer's zone, as the dashboard's "Last sweep" does.
  const started = screen.getByText(RUNNING_NOTE).querySelector('time')!
  expect(started.textContent).toBe(formatSweepInstant(started.getAttribute('dateTime')!, new Date().toISOString()))
  expect(started.textContent).not.toContain('UTC')

  completed = true
  updateRun({ status: 'completed', snapshots: [setupResultSnapshot({ provider: 'local', answerText: 'A saved answer from the engine.' })] })
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsByIdQueryKey({ client: heyClient, path: { id: 'scoped-run' } }) })
  await screen.findByRole('heading', { name: 'Your first AI Visibility result' })
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient, query: { kind: 'answer-visibility' } }) })
  await waitFor(() => expect(resolveOverview).toBeTypeOf('function'))
  expect(screen.getByRole('heading', { name: 'Saved answers' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Your first saved answer' })).getByText('Local')).toBeTruthy()
  expect(resultSummary('City Point Dental · 1 answer')).toBeTruthy()
  expect(resultRows()).toEqual([['All queries', 'Unavailable', 'Unavailable']])
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reset unsaved fields' })).toBeNull()
  resolveOverview?.(jsonResponse(null))
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  expect(screen.getByRole('heading', { name: 'Your first AI Visibility result' })).toBeTruthy()
})


test.each([false, true])('refuses a stale successful preview after a failed refresh and allows recovery (retry: %s)', async retry => {
  let previewFailed = false
  const { queryClient, projectName, requests } = renderProjectSetup({
    panel: false,
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
    panel: false,
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
    panel: false,
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
  const { domain } = renderProjectSetup({ panel: false, queryResponse: () => jsonResponse([{ id: 'saved-query', query: 'best local dentist' }]) })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  const details = await screen.findByRole('region', { name: 'Check details' })
  const values = within(details).getAllByRole('definition')
  expect(within(details).getAllByRole('term').map((term, index) => [term.textContent, values[index]!.textContent])).toEqual([
    ['Website', domain],
    ['Market', 'United States · English'],
    ['Location', 'No location targeting'],
  ])
})

test('counts saved answers against the previewed requests until the run records its own total', async () => {
  // What the run detail reports: the answers saved so far, and its own total once the sweep records one.
  const reported: { snapshots: RunDetailDto['snapshots']; plannedAnswers?: number } = { snapshots: [] }
  const startedAt = '2026-09-05T12:00:30Z'
  const { queryClient } = renderProjectSetup({
    panel: false,
    queryResponse: () => jsonResponse([
      { id: 'query-1', query: 'best local dentist' },
      { id: 'query-2', query: 'emergency dentist' },
      { id: 'query-3', query: 'family dentist' },
    ]),
    runResponse: init => jsonResponse(runDetailDtoSchema.parse(init?.method === 'POST'
      ? { id: 'progress-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'queued', createdAt: '2026-09-05T12:00:00Z' }
      : { id: 'progress-run', projectId: 'project_citypoint', kind: 'answer-visibility', status: 'running', createdAt: '2026-09-05T12:00:00Z', startedAt, ...reported })),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  // The preview counts 3 provider requests: three queries on one engine.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run check' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  // The count is plain text, not a live region: it changes every few seconds.
  expect(await screen.findByText('0 of 3 answers saved')).toBeTruthy()
  const bar = screen.getByRole('progressbar', { name: 'AI Visibility check progress' })
  expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['0', '3'])
  expect(screen.getByText(RUNNING_NOTE).textContent).toBe(`Started ${formatSweepInstant(startedAt, new Date().toISOString())}. You can leave this page. The check keeps running.`)

  // The sweep records what it set out to collect (one engine it could not reach
  // is left out), and that total replaces the preview's.
  reported.plannedAnswers = 2
  reported.snapshots = [setupResultSnapshot({ runId: 'progress-run' })]
  await queryClient.invalidateQueries({ queryKey: getApiV1RunsByIdQueryKey({ client: heyClient, path: { id: 'progress-run' } }) })
  expect(await screen.findByText('1 of 2 answers saved')).toBeTruthy()
  const filled = screen.getByRole('progressbar', { name: 'AI Visibility check progress' })
  expect([filled.getAttribute('aria-valuenow'), filled.getAttribute('aria-valuemax')]).toEqual(['1', '2'])
  // Running is not a success: the fill stays neutral, never success green.
  const fill = filled.firstElementChild!
  const fillColor = compiledElementProperty(parseCompiledCss(await compileAppStyles([...fill.classList])), fill, 'background-color')
  expect(fillColor).toBeDefined()
  expect(fillColor).not.toMatch(/positive|success|green/)
})

test.each([
  { scenario: 'without a recorded total pulses instead of filling', plannedAnswers: undefined, count: '1 answer saved', scale: [null, null] },
  { scenario: 'counts against the total its run recorded', plannedAnswers: 4, count: '1 of 4 answers saved', scale: ['1', '4'] },
])('a check resumed from an earlier visit $scenario', async ({ plannedAnswers, count, scale }) => {
  const startedAt = '2026-09-05T12:00:30Z'
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), { status: 'running', startedAt, snapshots: [setupResultSnapshot({})], plannedAnswers })
  expect(await screen.findByText(count)).toBeTruthy()
  // A bounded scale only against a total the server sent; this visit previewed nothing.
  const bar = screen.getByRole('progressbar', { name: 'AI Visibility check progress' })
  expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(scale)
})

test('a running check says which engine is failing before it ends, with its message one step away', async () => {
  renderColdScopedSetup(() => jsonResponse({ answerVisibilityProviderReady: true }), {
    status: 'running', startedAt: '2026-09-05T12:00:30Z', snapshots: [],
    providerFailures: {
      'openrouter:google/gemini-3.8-flash': { message: 'OpenRouter request failed (HTTP 402): Insufficient credits.', failedQueries: 2, stopped: true },
    },
  })
  await screen.findByText(RUNNING_NOTE)
  const message = screen.getByText('OpenRouter request failed (HTTP 402): Insufficient credits.')
  const note = message.closest('[role="status"]')!
  // One line per engine; the engine's own message waits behind a closed disclosure.
  expect(note.querySelector('p')!.textContent).toMatch(/: 2 queries failed, so this check stopped asking it\.$/)
  const disclosure = message.closest('details')!
  expect(disclosure.open).toBe(false)
  expect(within(disclosure).getByText('Engine message', { selector: 'summary' })).toBeTruthy()
})

test('says what each provider to connect is and what connecting it takes', async () => {
  renderProjectSetup({
    panel: true,
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
    ['openrouter', 'Models from several makers through one API key. Save the key, then choose which models to check.'],
  ] as const) {
    if (provider().value !== value) fireEvent.change(provider(), { target: { value } })
    expect(screen.getByRole('combobox', { name: 'Provider to connect', description: guidance })).toHaveProperty('value', value)
  }
})

test('names every engine it can connect, and that more can follow, until one is connected', async () => {
  const extraProviders = [
    { name: 'perplexity', displayName: 'Perplexity' },
    { name: 'muse', displayName: 'Muse' },
    { name: 'openrouter', displayName: 'OpenRouter' },
  ]
  renderProjectSetup({ panel: true, providerReady: false, includeLocalProvider: true, extraProviders })
  // The form opens on Gemini, so this line is where the others show up: the
  // server's own list, OpenRouter's one key spelled out, local models last.
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  expect(await within(engines).findByText(
    'Works with Gemini, OpenAI, Claude, Perplexity, Muse, OpenRouter (many models with one key) and models you run yourself. Start with one and add more any time in Settings.',
  )).toBeTruthy()
  cleanup()

  renderProjectSetup({ panel: true, includeLocalProvider: true, extraProviders })
  const connected = await screen.findByRole('region', { name: 'AI engines' })
  // Connected: the step offers another engine instead of a first connection.
  expect(await within(connected).findByRole('button', { name: 'Connect another engine' })).toBeTruthy()
  expect(within(connected).queryByText(/^Works with /)).toBeNull()
})

test('offers to connect another engine only while one this project can use is unconnected', async () => {
  // Gemini is connected and others are not: the button adds one, opening on the next.
  renderProjectSetup({ panel: true, projectProviders: [], readyProviderNames: ['gemini'] })
  const engines = await screen.findByRole('region', { name: 'AI engines' })
  fireEvent.click(await within(engines).findByRole('button', { name: 'Connect another engine' }))
  expect((screen.getByRole('combobox', { name: 'Provider to connect' }) as HTMLSelectElement).value).toBe('OpenAI')
  cleanup()

  // The project may only use Gemini, and Gemini is connected: the form can only
  // edit that saved connection, so the button does not promise another engine.
  renderProjectSetup({ panel: true, projectProviders: ['gemini'], readyProviderNames: ['gemini'] })
  const limited = await screen.findByRole('region', { name: 'AI engines' })
  fireEvent.click(await within(limited).findByRole('button', { name: 'Change engine settings' }))
  expect(within(limited).queryByRole('button', { name: 'Connect another engine' })).toBeNull()
  // The form reads the saved connection first, then lists the one engine it can edit.
  const only = await screen.findByRole('combobox', { name: 'Provider to connect' }) as HTMLSelectElement
  expect([...only.options].map(option => option.value)).toEqual(['Gemini'])
})

test('says saving a first OpenRouter key leads to choosing its models, and only then', async () => {
  const openRouter = [{ name: 'openrouter', displayName: 'OpenRouter' }]
  // No engine is connected yet, so saving OpenRouter opens its model picker in this step.
  renderProjectSetup({ panel: true, providerReady: false, extraProviders: openRouter })
  const provider = await screen.findByRole('combobox', { name: 'Provider to connect' })
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeTruthy()
  fireEvent.change(provider, { target: { value: 'openrouter' } })
  expect(await screen.findByRole('button', { name: 'Save and choose models' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save connection' })).toBeNull()
  cleanup()

  // Gemini is already connected, so OpenRouter's models are chosen later and the button only saves.
  renderProjectSetup({ panel: true, projectProviders: [], readyProviderNames: ['gemini'], extraProviders: openRouter })
  fireEvent.click(await screen.findByRole('button', { name: 'Connect another engine' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Provider to connect' }), { target: { value: 'openrouter' } })
  expect(await screen.findByRole('button', { name: 'Save connection' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save and choose models' })).toBeNull()
})
