import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import {
  getApiV1ProjectsQueryKey,
  getApiV1TelemetryQueryKey,
} from '@canonry/canonry-api-client/react-query'
import { onboardingTelemetryEventSchema, projectSetupDtoSchema, type ProjectSetupDto } from '@canonry/canonry-contracts'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  delete window.__CANONRY_CONFIG__
})

function projectDto(project: { id: string; name: string; displayName: string; canonicalDomain: string; country?: string; language?: string }) {
  return {
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
    providers: [], providerModels: {}, locations: [], defaultLocation: null,
    measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...project,
  }
}

type ProjectFixture = ReturnType<typeof projectDto>

const EXAMPLE = projectDto({ id: 'project-example', name: 'example-com', displayName: 'Example', canonicalDomain: 'example.com' })
const HARBOR = projectDto({ id: 'project-harbor', name: 'harbor-law', displayName: 'Harbor Law', canonicalDomain: 'harbor.law' })

/** A project's setup read with neither track started, validated by the contract so it cannot drift. */
function setupRead(project: ProjectFixture, aiVisibility: Partial<ProjectSetupDto['tracks']['aiVisibility']> = {}): ProjectSetupDto {
  return projectSetupDtoSchema.parse({
    project: { name: project.name, displayName: project.displayName, canonicalDomain: project.canonicalDomain },
    complete: false,
    firstResultAt: null,
    nextAction: 'run_agent_readiness',
    tracks: {
      agentReadiness: { state: 'not_started', runId: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null },
      aiVisibility: {
        state: 'not_started', runId: null, runIds: [], startedAt: null, finishedAt: null, baselineRunId: null, blockedBy: 'no_queries', engines: ['gemini'],
        queries: { total: 0, nonBrand: 0, branded: 0, unclassified: 0 },
        progress: null, providerFailures: null, result: null, error: null, failedEngines: null,
        ...aiVisibility,
      },
    },
  })
}

/**
 * The setup API as a server answers it: the project list (a create shows up in
 * the next read), project creation, each project's setup read and detail, and
 * the onboarding telemetry collector. `route` answers a request first.
 */
function mockSetupApi(options: {
  projects?: ProjectFixture[]
  listProjects?: () => Response | Promise<Response>
  create?: (body: Record<string, unknown>) => Response | Promise<Response>
  /** Holds the create response until it settles, so the saving state can be seen. */
  createGate?: Promise<unknown>
  route?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined
} = {}) {
  const projects = [...(options.projects ?? [])]
  const requests: Array<{ path: string; method: string; body?: string }> = []
  const events: Array<Record<string, unknown>> = []
  onTestFinished(mockFetch(async (url, init) => {
    const path = pathOf(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({ path, method, body })
    const routed = options.route?.(path, init)
    if (routed) return routed
    if (path === '/api/v1/telemetry/onboarding') {
      events.push(JSON.parse(String(body)) as Record<string, unknown>)
      return jsonResponse({ accepted: true }, 202)
    }
    if (path === '/api/v1/projects' && method === 'POST') {
      const request = JSON.parse(String(body)) as Record<string, string>
      if (options.create) return options.create(request)
      if (options.createGate) await options.createGate
      const created = projectDto({
        id: `project-${request.name}`,
        name: request.name!,
        displayName: request.displayName!,
        canonicalDomain: request.canonicalDomain!,
        country: request.country!,
        language: request.language!,
      })
      projects.push(created)
      return jsonResponse(created, 201)
    }
    if (path === '/api/v1/projects') return options.listProjects?.() ?? jsonResponse(projects)
    const projectPath = /^\/api\/v1\/projects\/([^/?]+)(\/[^?]*)?/.exec(path)
    const project = projects.find(entry => entry.name === decodeURIComponent(projectPath?.[1] ?? ''))
    if (project && projectPath?.[2] === '/setup') return jsonResponse(setupRead(project))
    if (project && projectPath?.[2] === undefined) return jsonResponse(project)
    if (path.endsWith('/queries') || path.includes('/runs')) return jsonResponse([])
    return jsonResponse({})
  }))
  return { projects, requests, events }
}

/**
 * `/setup` in the app's router. `dashboardProjects` are the names the shell and
 * the AI Visibility panel know about; the setup page itself reads the API's
 * project list.
 */
async function renderSetup(pathname: string, options: { dashboardProjects?: string[]; seedProjects?: unknown[] } = {}) {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  const template = fixture.dashboard.projects[0]!
  const dashboardFor = (names: string[]) => ({
    ...fixture.dashboard,
    projects: names.map(name => ({
      ...structuredClone(template),
      project: { ...structuredClone(template.project), name },
      queryCounts: { cited: 0, total: 0, citationNotMeasured: 0 },
      competitors: [],
    })),
    runs: [],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (options.seedProjects) queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), options.seedProjects)
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()
  const tree = (names: string[]) => (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: dashboardFor(names), health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>
  )
  const rendered = render(tree(options.dashboardProjects ?? []))
  return {
    router,
    queryClient,
    rerenderDashboard: (names: string[]) => rendered.rerender(tree(names)),
  }
}

/** A tracker row: the list item under its heading. */
function rowOf(name: string): HTMLElement {
  return screen.getByRole('heading', { level: 2, name }).closest('li')!
}

async function findRow(name: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { level: 2, name })).closest('li')!
}

function nonTelemetryWrites(requests: Array<{ path: string; method: string }>) {
  return requests.filter(request => request.method !== 'GET' && request.path !== '/api/v1/telemetry/onboarding').map(request => `${request.method} ${request.path}`)
}

// ── A bare /setup ──

test('a fresh install leads with its website, then two tracks that have not started', async () => {
  mockSetupApi()
  await renderSetup('/setup')

  expect(await screen.findByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  expect(screen.getByText('Add your first website to get its Agent Readiness score and first AI Visibility result.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Set up with an agent' }).getAttribute('href')).toBe('/agent-setup')

  // The same rows, in the same order, as the project's tracker once it exists.
  const tracker = screen.getByRole('region', { name: 'Setup progress' })
  expect(within(tracker).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['Website', 'Agent Readiness', 'AI Visibility'])
  const website = rowOf('Website')
  expect(within(website).getByText('Required')).toBeTruthy()
  expect(within(website).getByRole('textbox', { name: 'Website URL' })).toHaveProperty('required', true)
  expect(within(website).getByRole('textbox', { name: 'Brand name', description: 'Answers that name this brand count as mentions.' })).toBeTruthy()
  // Name and market wait behind a closed disclosure that says what they will be.
  const details = within(website).getByText('Project details').closest('details')!
  expect(details.open).toBe(false)
  expect(within(details).getByText('United States · English')).toBeTruthy()
  expect(within(website).getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  expect(within(website).queryByRole('button', { name: 'Reset unsaved fields' })).toBeNull()

  const scan = rowOf('Agent Readiness')
  expect(within(scan).getByText('How well AI agents can read your site')).toBeTruthy()
  expect(within(scan).getByText('Not started')).toBeTruthy()
  const ai = rowOf('AI Visibility')
  expect(within(ai).getByText('Whether AI answers mention your brand and cite your site')).toBeTruthy()
  expect(within(ai).getByText('Not started')).toBeTruthy()

  // Nothing here crawls or spends, so there is no consent to give and no step to skip.
  const page = screen.getByRole('main')
  expect(within(page).queryAllByRole('checkbox')).toEqual([])
  expect(within(page).queryByText(/optional|skipped|skip/i)).toBeNull()
})

test.each([
  { scenario: 'Add project on an install with one project', pathname: '/setup?experience=platform', projects: [EXAMPLE], finished: false },
  { scenario: 'a bare /setup on an install with several projects', pathname: '/setup', projects: [EXAMPLE, HARBOR], finished: false },
  // A finished project's setup is done; the sidebar's Setup link adds a project instead of reopening it as the first setup.
  { scenario: 'a bare /setup on an install whose only project finished setup', pathname: '/setup', projects: [EXAMPLE], finished: true },
])('$scenario adds a project without the first-run framing', async ({ pathname, projects, finished }) => {
  mockSetupApi({
    projects,
    route: path => finished && path === `/api/v1/projects/${EXAMPLE.name}/setup` ? jsonResponse({ ...setupRead(EXAMPLE), complete: true }) : undefined,
  })
  const { router } = await renderSetup(pathname, { dashboardProjects: projects.map(project => project.name) })

  expect(await screen.findByRole('heading', { level: 1, name: 'Add a project' })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Website URL' })).toBeTruthy()
  expect(screen.queryByText(/Add your first website/)).toBeNull()
  expect(screen.queryByRole('link', { name: 'Set up with an agent' })).toBeNull()
  // No project's setup opens in its place, and the address names the page, so its breadcrumb does too.
  expect(router.state.location.href).toBe('/setup?experience=platform')
})

test('adding a project can be cancelled back to Projects, which drops its draft; the first setup offers no Cancel', async () => {
  mockSetupApi({ projects: [EXAMPLE] })
  const { router } = await renderSetup('/setup?experience=platform', { dashboardProjects: [EXAMPLE.name] })
  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'cedar.example' } })
  fireEvent.click(screen.getByRole('link', { name: 'Cancel' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
  cleanup()

  // Cancelling is not leaving by accident: the half-typed website does not come back.
  await renderSetup('/setup?experience=platform', { dashboardProjects: [EXAMPLE.name] })
  expect((await screen.findByRole('textbox', { name: 'Website URL' }) as HTMLInputElement).value).toBe('')
  cleanup()

  mockSetupApi()
  await renderSetup('/setup')
  expect(await screen.findByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Cancel' })).toBeNull()
})

test('a bare /setup on an install with one project opens that project’s setup', async () => {
  const api = mockSetupApi({ projects: [EXAMPLE] })
  const { router } = await renderSetup('/setup', { dashboardProjects: [EXAMPLE.name] })

  await waitFor(() => expect(router.state.location.search).toEqual({ project: 'example-com', onboarding: 'first-run' }))
  // Replaced, so Back does not return to a page that only redirects.
  expect(router.history.length).toBe(1)
  expect(await screen.findByText('Example · example.com')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Website URL' })).toBeNull()
  expect(nonTelemetryWrites(api.requests)).toEqual([])
})

test('decides from a fresh project list, never from a cached one', async () => {
  // The cache predates a project an agent has since created.
  let respond: ((response: Response) => void) | undefined
  mockSetupApi({ projects: [EXAMPLE], listProjects: () => new Promise<Response>(resolve => { respond = resolve }) })
  const { router } = await renderSetup('/setup', { seedProjects: [] })

  expect((await screen.findByText('Loading projects…')).closest('[role="status"]')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Website URL' })).toBeNull()
  await waitFor(() => expect(respond).toBeTypeOf('function'))
  respond?.(jsonResponse([EXAMPLE]))

  await waitFor(() => expect(router.state.location.search).toEqual({ project: 'example-com', onboarding: 'first-run' }))
  expect(await screen.findByText('Example · example.com')).toBeTruthy()
})

test('a failed project read pauses setup with a retry instead of guessing', async () => {
  let failed = true
  mockSetupApi({
    listProjects: () => failed
      ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'temporary outage' } }, 503)
      : jsonResponse([]),
  })
  await renderSetup('/setup')

  expect(await screen.findByRole('heading', { level: 1, name: 'Can’t load projects' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Website URL' })).toBeNull()

  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry project check' }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Website URL' })).toBeTruthy()
})

test('keeps typed website input mounted through a background project refetch', async () => {
  let reads = 0
  let finishRefetch: ((response: Response) => void) | undefined
  mockSetupApi({
    listProjects: () => ++reads === 1
      ? jsonResponse([])
      : new Promise<Response>(resolve => { finishRefetch = resolve }),
  })
  const { queryClient } = await renderSetup('/setup')

  const domain = await screen.findByRole('textbox', { name: 'Website URL' }) as HTMLInputElement
  fireEvent.change(domain, { target: { value: 'example.com' } })
  domain.focus()
  const refetch = queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })
  await waitFor(() => expect(finishRefetch).toBeTypeOf('function'))

  const current = screen.getByRole('textbox', { name: 'Website URL' }) as HTMLInputElement
  expect(current.value).toBe('example.com')
  expect(document.activeElement).toBe(current)
  expect(screen.queryByText('Loading projects…')).toBeNull()

  finishRefetch?.(jsonResponse([]))
  await refetch
})

// ── Saving the website ──

test('saving the website creates the project and opens its setup, starting no scan and no check', async () => {
  let release: (() => void) | undefined
  const api = mockSetupApi({ createGate: new Promise<void>(resolve => { release = resolve }) })
  const { router } = await renderSetup('/setup')

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'https://www.example.com/pricing' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Brand name' }), { target: { value: 'Example Brand' } })
  fireEvent.click(screen.getByText('Project details'))
  fireEvent.change(screen.getByRole('combobox', { name: 'Country' }), { target: { value: 'GB' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'fr' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  expect(await screen.findByRole('button', { name: 'Creating project…' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Reset unsaved fields' })).toHaveProperty('disabled', true)
  release?.()

  await waitFor(() => expect(router.state.location.search).toEqual({ project: 'example-com', onboarding: 'first-run' }))
  expect(router.history.length).toBe(1)
  // The project's own tracker: each track starts from its own button.
  expect(await within(await findRow('Agent Readiness')).findByRole('button', { name: 'Run audit scan' })).toBeTruthy()
  expect(screen.getByText('Example Brand · example.com')).toBeTruthy()

  expect(nonTelemetryWrites(api.requests)).toEqual(['POST /api/v1/projects'])
  const create = api.requests.find(request => request.method === 'POST' && request.path === '/api/v1/projects')!
  expect(JSON.parse(create.body!)).toEqual({ name: 'example-com', displayName: 'Example Brand', canonicalDomain: 'example.com', country: 'GB', language: 'fr' })

  // The first-run funnel: a start, then the project step. Schema-valid, and nothing identifying.
  await waitFor(() => expect(api.events.map(event => [event.event, event.step])).toEqual([
    ['onboarding.started', 'project'],
    ['onboarding.step_completed', 'project'],
  ]))
  for (const event of api.events) expect(onboardingTelemetryEventSchema.parse(event)).toMatchObject({ surface: 'platform' })
  expect(api.events[1]).toMatchObject({ method: 'manual' })
  expect(JSON.stringify(api.events)).not.toMatch(/example/i)

  // Saving cleared the draft, so the next project starts blank.
  cleanup()
  await renderSetup('/setup?experience=platform')
  expect((await screen.findByRole('textbox', { name: 'Website URL' }) as HTMLInputElement).value).toBe('')
})

test('adding a project opens that project’s setup without the first-run frame', async () => {
  const api = mockSetupApi({ projects: [EXAMPLE] })
  const { router } = await renderSetup('/setup?experience=platform', { dashboardProjects: [EXAMPLE.name] })

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'harbor.law' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  await waitFor(() => expect(router.state.location.search).toEqual({ project: 'harbor-law' }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Project setup' })).toBeTruthy()
  expect(await screen.findByText('Harbor · harbor.law')).toBeTruthy()
  expect(nonTelemetryWrites(api.requests)).toEqual(['POST /api/v1/projects'])
})

test('suggests the brand and project names from the website without typing them into the fields', async () => {
  const api = mockSetupApi()
  await renderSetup('/setup')

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'https://www.example.com/pricing' } })
  const brand = screen.getByRole('textbox', { name: 'Brand name' }) as HTMLInputElement
  // A suggestion shown as text would be appended to by typing.
  expect(brand.value).toBe('')
  // The brand people would say, not the domain.
  expect(brand.placeholder).toBe('Example')
  fireEvent.change(brand, { target: { value: 'Example' } })
  expect(brand.value).toBe('Example')
  // Clearing the field leaves it empty; the suggestion does not come back as text.
  fireEvent.change(brand, { target: { value: '' } })
  expect(brand.value).toBe('')
  fireEvent.click(screen.getByText('Project details'))
  const projectName = screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement
  expect(projectName.value).toBe('')
  expect(projectName.placeholder).toBe('example-com')
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  // Fields left blank use the names derived from the website.
  await waitFor(() => expect(nonTelemetryWrites(api.requests)).toEqual(['POST /api/v1/projects']))
  const create = api.requests.find(request => request.method === 'POST' && request.path === '/api/v1/projects')!
  expect(JSON.parse(create.body!)).toMatchObject({ name: 'example-com', displayName: 'Example', canonicalDomain: 'example.com' })
})

test('a name collision opens Project details on the name to change and links the project that holds it', async () => {
  // Stored before names were normalized; the server still compares it as example-com.
  const legacy = projectDto({ id: 'project-legacy', name: 'Example.com', displayName: 'Example', canonicalDomain: 'example.com' })
  const api = mockSetupApi({
    projects: [legacy],
    create: () => jsonResponse({ error: { code: 'ALREADY_EXISTS', message: "Project 'example-com' already exists" } }, 409),
  })
  await renderSetup('/setup?experience=platform', { dashboardProjects: [legacy.name] })

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'example.com' } })
  const details = screen.getByText('Project details').closest('details')!
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  const message = 'A project with this name already exists. Change the project name, or open the existing project.'
  expect((await screen.findByRole('alert')).textContent).toContain(message)
  const projectName = screen.getByRole('textbox', { name: 'Project name', description: message })
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(projectName)
  expect(projectName.getAttribute('aria-invalid')).toBe('true')
  expect((await screen.findByRole('link', { name: 'Open Example.com' })).getAttribute('href')).toBe('/projects/Example.com')
  // The collision starts nothing else, and the funnel records the block.
  expect(nonTelemetryWrites(api.requests)).toEqual(['POST /api/v1/projects'])
  await waitFor(() => expect(api.events.find(event => event.event === 'onboarding.blocked')).toBeDefined())
  expect(onboardingTelemetryEventSchema.parse(api.events.find(event => event.event === 'onboarding.blocked'))).toMatchObject({ step: 'project', action: 'save', surface: 'platform' })

  // A new name gets its own answer on submit, so the stale collision clears.
  fireEvent.change(projectName, { target: { value: 'example-two' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('link', { name: /^Open / })).toBeNull()
  expect(projectName.getAttribute('aria-invalid')).toBe('false')
})

test('on a first run, a create that lost a race keeps its conflict on screen instead of opening the winner', async () => {
  const winner = projectDto({ id: 'project-winner', name: 'example-com', displayName: 'Example', canonicalDomain: 'example.com' })
  let listed: ProjectFixture[] = []
  mockSetupApi({
    listProjects: () => jsonResponse(listed),
    create: () => {
      // Another session created the same project a moment earlier.
      listed = [winner]
      return jsonResponse({ error: { code: 'ALREADY_EXISTS', message: "Project 'example-com' already exists" } }, 409)
    },
  })
  const { router } = await renderSetup('/setup')

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  expect((await screen.findByRole('alert')).textContent).toContain('A project with this name already exists.')
  // The list reread after the conflict now holds exactly one project; the page
  // keeps the form and its recovery link instead of redirecting to that project.
  expect((await screen.findByRole('link', { name: 'Open example-com' })).getAttribute('href')).toBe('/projects/example-com')
  expect(screen.getByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  expect(router.state.location.href).toBe('/setup')
})

test('keeps unsaved website fields through a reload until they are reset', async () => {
  mockSetupApi()
  await renderSetup('/setup')
  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'cedar.example' } })
  fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'CA' } })
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } })
  cleanup()

  await renderSetup('/setup')
  expect((await screen.findByRole('textbox', { name: 'Website URL' }) as HTMLInputElement).value).toBe('cedar.example')
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('CA')
  expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('fr')
  fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved fields' }))
  expect((screen.getByRole('textbox', { name: 'Website URL' }) as HTMLInputElement).value).toBe('')
  expect(screen.queryByRole('button', { name: 'Reset unsaved fields' })).toBeNull()
  cleanup()

  await renderSetup('/setup')
  expect((await screen.findByRole('textbox', { name: 'Website URL' }) as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('US')
})

test('offers accessible supported locale selects with exact API codes', async () => {
  mockSetupApi()
  await renderSetup('/setup')

  await screen.findByRole('textbox', { name: 'Website URL' })
  fireEvent.click(screen.getByText('Project details'))
  const country = screen.getByRole('combobox', { name: 'Country' }) as HTMLSelectElement
  const language = screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement

  expect(country.value).toBe('US')
  expect(language.value).toBe('en')
  expect([...country.options].every(option => /^[A-Z]{2}$/.test(option.value))).toBe(true)
  expect([...language.options].every(option => /^[a-z]{2}$/.test(option.value))).toBe(true)
  expect([...country.options].some(option => option.value === 'ZZ')).toBe(false)

  fireEvent.change(country, { target: { value: 'GB' } })
  fireEvent.change(language, { target: { value: 'fr' } })
  expect(country.value).toBe('GB')
  expect(language.value).toBe('fr')
  expect(screen.getByText('United Kingdom · French')).toBeTruthy()
})

const COARSE = '@media (pointer: coarse)'
const BELOW_MD = '@media (width < 48rem)'
/** Each element's compiled min-height in px beside a desktop mouse, on a narrow screen and under a finger; 0 where none is set. */
async function minHeights(elements: Element[]) {
  const rules = parseCompiledCss(await compileAppStyles(elements.flatMap(element => [...element.classList])))
  return elements.map(element => [undefined, BELOW_MD, COARSE].map(context => {
    const value = compiledElementProperty(rules, element, 'min-height', context)
    return value === undefined ? 0 : cssLengthPx(value, rules)
  }))
}

test('the website form stays compact beside a mouse and gives each control a 44px target under a finger', async () => {
  mockSetupApi()
  await renderSetup('/setup')

  const targets = [
    await screen.findByRole('textbox', { name: 'Website URL' }),
    screen.getByText('Project details').closest('summary')!,
    screen.getByRole('button', { name: 'Continue' }),
  ]
  expect(await minHeights(targets)).toEqual([[0, 44, 44], [36, 44, 44], [0, 44, 44]])
})

test('every website field shares the one input style, with none set apart', async () => {
  mockSetupApi()
  await renderSetup('/setup')

  fireEvent.change(await screen.findByRole('textbox', { name: 'Website URL' }), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByText('Project details'))
  const fields = ['Website URL', 'Brand name', 'Project name', 'Country', 'Language'].map(label => screen.getByLabelText(label))
  const rules = parseCompiledCss(await compileAppStyles(fields.flatMap(field => [...field.classList])))
  const looks = fields.map((field) => {
    const property = (name: string, context?: string) => compiledElementProperty(rules, field, name, context)
    return {
      height: cssLengthPx(property('height') ?? '0', rules),
      border: property('border-color'),
      background: property('background-color'),
      // 16px below md so a phone does not zoom into the field on focus.
      text: [property('font-size'), property('font-size', BELOW_MD)],
    }
  })
  // The shared field's resting edge; its stronger focus edge is pinned in design-tokens.test.ts.
  const shared = { height: 40, border: 'var(--color-border-base)', background: 'var(--color-bg)', text: ['14px', '16px'] }
  expect(looks).toEqual([shared, shared, shared, shared, shared])
  expect(await minHeights(fields)).toEqual([[0, 44, 44], [0, 44, 44], [0, 44, 44], [0, 44, 44], [0, 44, 44]])
})

// ── A project's setup ──

test.each([
  { pathname: '/setup?project=example-com', title: 'Project setup' },
  { pathname: '/setup?project=example-com&onboarding=first-run', title: 'Set up Canonry' },
  // Links from before the tracker named their project in first-run setup.
  { pathname: '/setup?onboarding=site-health&setupProject=example-com&siteHealthRunId=scan-1', title: 'Set up Canonry' },
  { pathname: '/setup?onboarding=complete&setupProject=example-com&skipped=visibility', title: 'Set up Canonry' },
])('$pathname opens the project’s setup tracker', async ({ pathname, title }) => {
  // Two projects, so only the link itself can name the one to open.
  const api = mockSetupApi({ projects: [EXAMPLE, HARBOR] })
  const { router } = await renderSetup(pathname, { dashboardProjects: [EXAMPLE.name, HARBOR.name] })

  expect(await screen.findByText('Example · example.com')).toBeTruthy()
  expect(router.state.location.href).toBe(pathname)
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy()
  expect(within(rowOf('Agent Readiness')).getByText('Not started')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Website URL' })).toBeNull()
  // Opening setup starts nothing.
  expect(nonTelemetryWrites(api.requests)).toEqual([])
})

test('a link to the AI Visibility row opens its panel at the step the server says comes next', async () => {
  // A fresh project has no queries yet, so the panel opens on them.
  mockSetupApi({ projects: [EXAMPLE] })
  await renderSetup('/setup?project=example-com&track=ai-visibility', { dashboardProjects: [EXAMPLE.name] })

  const ai = await findRow('AI Visibility')
  expect(await within(ai).findByRole('heading', { level: 3, name: 'Add queries' })).toBeTruthy()
  expect(await within(ai).findByRole('textbox', { name: 'Queries (one per line)' })).toBeTruthy()
})

// ── The established wizard, kept as a rescue path ──

test.each([
  { mode: 'platform', pathname: '/setup?experience=legacy' },
  { mode: 'legacy', pathname: '/setup' },
] as const)('$pathname with the $mode onboarding mode opens the established wizard', async ({ mode, pathname }) => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: mode } }
  mockSetupApi()
  await renderSetup(pathname)

  expect(await screen.findByRole('heading', { level: 1, name: 'Setup' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Create project' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Website URL' })).toBeNull()
})

test.each(['project', 'setupProject'])('the established wizard sets up AI Visibility for the project its %s names', async param => {
  mockSetupApi({ projects: [EXAMPLE] })
  await renderSetup(`/setup?experience=legacy&${param}=example-com`, { dashboardProjects: [EXAMPLE.name] })

  const heading = await screen.findByRole('heading', { level: 1, name: 'Set up AI Visibility' })
  expect(document.activeElement).toBe(heading)
  expect(screen.getByRole('heading', { level: 2, name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Setup progress' })).toBeNull()
})

test('the established wizard never falls back to another project when the one it names is missing', async () => {
  mockSetupApi()
  const { rerenderDashboard } = await renderSetup('/setup?experience=legacy&project=missing-project', { dashboardProjects: ['different-project'] })

  const heading = await screen.findByRole('heading', { level: 1, name: 'Set up AI Visibility' })
  expect(document.activeElement).toBe(heading)
  expect(screen.getByRole('heading', { name: 'Project not found' })).toBeTruthy()
  expect(screen.getByText(/could not find missing-project/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'View projects' }).getAttribute('href')).toBe('/projects')
  expect(screen.queryByRole('heading', { name: 'Add queries' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  rerenderDashboard(['missing-project'])

  const resolvedHeading = await screen.findByRole('heading', { level: 1, name: 'Set up AI Visibility' })
  expect(resolvedHeading).not.toBe(heading)
  expect(document.activeElement).toBe(resolvedHeading)
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
})

// ── Telemetry preference ──

/**
 * A dashboard built with its own API key signs requests with that key, the
 * only way a browser can present an operator credential; otherwise requests
 * carry the session cookie, which the server never treats as an operator.
 */
function signWithBrowserKey() {
  vi.stubEnv('VITE_API_KEY', 'test-browser-key')
  onTestFinished(() => { vi.unstubAllEnvs() })
}

test.each([
  { scenario: 'a cookie session in first setup', key: false, pathname: '/setup', projects: [] as ProjectFixture[], title: 'Set up Canonry' },
  { scenario: 'an operator key adding a project', key: true, pathname: '/setup?experience=platform', projects: [EXAMPLE], title: 'Add a project' },
])('$scenario never asks for operator-only telemetry', async ({ key, pathname, projects, title }) => {
  if (key) signWithBrowserKey()
  const api = mockSetupApi({
    projects,
    // Answered as it would be for an operator, so only the page decides whether it is read.
    route: path => path === '/api/v1/telemetry' ? jsonResponse({ enabled: true, anonymousId: 'abcd1234...' }) : undefined,
  })
  const { queryClient } = await renderSetup(pathname, { dashboardProjects: projects.map(project => project.name) })

  expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy()
  await waitFor(() => expect(api.events.some(event => event.event === 'onboarding.started')).toBe(true))
  expect(queryClient.getQueryState(getApiV1TelemetryQueryKey({ client: heyClient }))).toMatchObject({ status: 'pending', fetchStatus: 'idle' })
  expect(api.requests.map(request => request.path)).not.toContain('/api/v1/telemetry')
  expect(screen.queryByRole('checkbox', { name: /Share anonymous product telemetry/ })).toBeNull()
})

test.each([false, true])('hides internal telemetry after operator denial without blocking setup (cached: %s)', async cached => {
  signWithBrowserKey()
  let allowed = cached
  mockSetupApi({
    route: path => path !== '/api/v1/telemetry'
      ? undefined
      : allowed
        ? jsonResponse({ enabled: true, anonymousId: 'abcd1234...' })
        : jsonResponse({ error: { code: 'FORBIDDEN', message: 'Host-approved operator required.' } }, 403),
  })
  const { queryClient } = await renderSetup('/setup')
  const key = getApiV1TelemetryQueryKey({ client: heyClient })
  if (cached) {
    await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ })
    allowed = false
    await queryClient.invalidateQueries({ queryKey: key })
  }
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))
  expect(screen.queryByRole('checkbox', { name: /Share anonymous product telemetry/ })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Website URL' })).toBeTruthy()
})

function mockTelemetryPreferences(initialEnabled: boolean, update?: (enabled: boolean) => Response | Promise<Response>) {
  signWithBrowserKey()
  let serverEnabled = initialEnabled
  const updates: boolean[] = []
  mockSetupApi({
    route: (path, init) => {
      if (path !== '/api/v1/telemetry') return undefined
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ enabled: serverEnabled, anonymousId: 'abcd1234...' })
      return (async () => {
        const requested = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled
        updates.push(requested)
        const response = update
          ? await update(requested)
          : jsonResponse({ enabled: requested, anonymousId: 'abcd1234...' })
        if (response.ok) serverEnabled = ((await response.clone().json()) as { enabled: boolean }).enabled
        return response
      })()
    },
  })
  return {
    updates,
    setServerEnabled(enabled: boolean) { serverEnabled = enabled },
  }
}

test('discloses the enabled fresh-install preference and toggles telemetry through its label in both directions', async () => {
  const server = mockTelemetryPreferences(true)
  const { queryClient } = await renderSetup('/setup')
  const telemetryKey = getApiV1TelemetryQueryKey({ client: heyClient })

  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ }) as HTMLInputElement
  expect(control.checked).toBe(true)
  expect(screen.getByText(/does not send raw domains, URLs, queries, answer content, or credentials/i)).toBeTruthy()
  expect(server.updates).toEqual([])

  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  }))
  expect(control.checked).toBe(false)
  await waitFor(() => expect(control.disabled).toBe(false))

  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: true,
    anonymousId: 'abcd1234...',
  }))
  expect(control.checked).toBe(true)
  expect(server.updates).toEqual([false, true])

  // A later server preference must replace the last mutation response.
  server.setServerEnabled(false)
  await queryClient.invalidateQueries({ queryKey: telemetryKey })
  await waitFor(() => expect(control.checked).toBe(false))
  expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})

test('preserves an existing telemetry opt-out until the user chooses to enable it', async () => {
  const server = mockTelemetryPreferences(false)
  const { queryClient } = await renderSetup('/setup')
  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ }) as HTMLInputElement
  expect(control.checked).toBe(false)
  expect(server.updates).toEqual([])
  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: true,
    anonymousId: 'abcd1234...',
  }))
  await waitFor(() => expect(control.disabled).toBe(false))
  await waitFor(() => expect(server.updates).toEqual([true]))
  expect(control.checked).toBe(true)
})

test('shows the requested telemetry preference while saving and blocks duplicate label clicks', async () => {
  let resolveUpdate: ((response: Response) => void) | undefined
  const server = mockTelemetryPreferences(true, () => new Promise<Response>(resolve => { resolveUpdate = resolve }))
  const { queryClient } = await renderSetup('/setup')
  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ }) as HTMLInputElement
  fireEvent.click(screen.getByText('Share anonymous product telemetry'))

  expect((await screen.findByText('Saving preference…')).closest('[role="status"]')).toBeTruthy()
  expect(control.checked).toBe(false)
  expect(control.disabled).toBe(true)
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: true,
    anonymousId: 'abcd1234...',
  })
  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(server.updates).toEqual([false]))
  await waitFor(() => expect(resolveUpdate).toBeTypeOf('function'))
  resolveUpdate?.(jsonResponse({ enabled: false, anonymousId: 'abcd1234...' }))

  await waitFor(() => expect(control.disabled).toBe(false))
  expect(control.checked).toBe(false)
  expect(screen.queryByText('Saving preference…')).toBeNull()
  expect(server.updates).toEqual([false])
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})

test('rolls back a rejected telemetry update and lets the user retry', async () => {
  let rejectNext = true
  const server = mockTelemetryPreferences(true, enabled => {
    if (rejectNext) {
      rejectNext = false
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Preference could not be saved' } }, 503)
    }
    return jsonResponse({ enabled, anonymousId: 'abcd1234...' })
  })
  const { queryClient } = await renderSetup('/setup')
  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ }) as HTMLInputElement
  fireEvent.click(screen.getByText('Share anonymous product telemetry'))

  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not update telemetry. Try again.')
  expect(control.checked).toBe(true)
  expect(control.disabled).toBe(false)
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: true,
    anonymousId: 'abcd1234...',
  })

  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(server.updates).toEqual([false, false]))
  await waitFor(() => expect(control.disabled).toBe(false))
  expect(control.checked).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})

test('explains when server settings keep telemetry off after an enable request', async () => {
  const server = mockTelemetryPreferences(false, () => jsonResponse({ enabled: false, anonymousId: 'abcd1234...' }))
  const { queryClient } = await renderSetup('/setup')
  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ }) as HTMLInputElement
  fireEvent.click(screen.getByText('Share anonymous product telemetry'))

  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The server kept telemetry off. Check its telemetry settings.')
  expect(control.checked).toBe(false)
  expect(control.disabled).toBe(false)
  expect(server.updates).toEqual([true])
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})
