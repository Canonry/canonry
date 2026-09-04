import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import {
  getApiV1ProjectsQueryKey,
  getApiV1TelemetryQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { getRunTrackerState, resetRunTracker } from '../src/lib/run-tracker-store.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

vi.mock('../src/components/project/SiteHealthSection.js', () => ({
  SiteHealthSection: ({
    projectName,
    projectId,
    initialRunId,
    showOnboardingActions,
    onReleaseInitialRun,
    onContinueOnboarding,
    onSkipOnboarding,
  }: {
    projectName: string
    projectId: string
    initialRunId?: string
    showOnboardingActions?: boolean
    onReleaseInitialRun?: () => void
    onContinueOnboarding?: () => void
    onSkipOnboarding?: () => void
  }) => (
    <section aria-label="Explicit Site Health">
      <p>{`${projectName}:${projectId}:${initialRunId ?? 'latest'}:${String(showOnboardingActions)}`}</p>
      <button type="button" onClick={onReleaseInitialRun}>Release initial scan</button>
      <button type="button" onClick={onContinueOnboarding}>Continue onboarding</button>
      <button type="button" onClick={onSkipOnboarding}>Skip onboarding</button>
    </section>
  ),
}))

const AGENT_SETUP_REQUEST = `Help me set up Canonry for my public site.

Use Canonry's official docs:
- Agent quickstart: https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent
- CLI reference: https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md
- Plugin setup: https://github.com/Canonry/canonry/blob/main/docs/plugins.md
- MCP setup: https://github.com/Canonry/canonry/blob/main/docs/mcp.md

Use an existing Canonry installation or connected plugin/MCP if one is already available. Do not create a duplicate. The \`cnry\` and \`canonry\` commands are interchangeable.

1. Ask for my public domain, country, and language. Do not create or scan anything yet.
2. Check the local setup with \`command -v cnry\`, \`cnry --version\`, \`cnry doctor --format json\`, and \`cnry project list --format json\`. If Canonry is missing, propose \`npm install -g @canonry/canonry\` and wait for approval. If initialization is required, tell me to run \`cnry bootstrap\` in my private terminal and wait. Never ask me to paste passwords, API keys, OAuth credentials, or \`cnry bootstrap\` output.
3. Show the normalized domain, proposed project name, exact \`cnry project create ...\` command, and wait for explicit approval before creating it.
4. Propose a bounded Site Health scan, including \`--max-pages\` and whether dead-link checking is enabled. Show the exact \`cnry technical-aeo run ... --wait --format json\` command and wait for separate approval before scanning.
5. After the crawl, summarize the findings and propose AI Visibility setup. Ask before adding queries, connecting providers, starting any provider-backed or quota-consuming run, editing files, or publishing.`
const AGENT_SETUP_GUIDE_URL = 'https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  resetRunTracker()
  resetToasts()
  delete window.__CANONRY_CONFIG__
})

async function renderSetup(
  pathname = '/setup',
  options: {
    seedEmptyProjectsCache?: boolean
    mappedProjectName?: string
    providerReady?: boolean
  } = {},
) {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  const mappedProject = options.mappedProjectName
    ? structuredClone(fixture.dashboard.projects[0])
    : undefined
  // `emptyPortfolio` controls only the overview fixture. The established
  // wizard derives its resume state from the durable project/run collections.
  fixture.dashboard.projects = mappedProject
    ? [{
        ...mappedProject,
        project: {
          ...mappedProject.project,
          name: options.mappedProjectName ?? mappedProject.project.name,
        },
        queryCounts: { cited: 0, total: 0 },
        competitors: [],
      }]
    : []
  fixture.dashboard.runs = []
  if (options.providerReady === false) {
    fixture.dashboard.settings.providerStatuses = []
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (options.seedEmptyProjectsCache) {
    queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), [])
  }
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  const renderTree = (dashboard: typeof fixture.dashboard) => (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>
  )
  const rendered = render(renderTree(fixture.dashboard))

  return {
    queryClient,
    router,
    resolveMappedProject(projectName: string) {
      const nextDashboard = structuredClone(fixture.dashboard)
      const project = nextDashboard.projects[0]
      if (!project) throw new Error('A mapped project fixture is required')
      nextDashboard.projects = [{
        ...project,
        project: { ...project.project, name: projectName },
      }]
      rendered.rerender(renderTree(nextDashboard))
    },
  }
}

test('defaults a fresh install to the domain-first Site Health flow', async () => {
  const restore = mockFetch((url) => pathOf(url) === '/api/v1/projects'
    ? jsonResponse([])
    : jsonResponse({}))
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
  expect(screen.getByText('Use your agent instead')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy setup request' })).toBeTruthy()
})

test('the legacy rescue query wins over an enabled platform flag', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  await renderSetup('/setup?experience=legacy')

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
})

test('an explicit Site Health handoff wins over the configured legacy surface and resumes the exact run', async () => {
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects') {
      return jsonResponse([{
        id: 'project-example',
        name: 'example-com',
        displayName: 'Example',
        canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }])
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  const { router } = await renderSetup('/setup?onboarding=site-health&setupProject=example-com&siteHealthRunId=site-audit-1')

  expect(await screen.findByRole('region', { name: 'Explicit Site Health' })).toBeTruthy()
  expect(screen.getByText('example-com:project-example:site-audit-1:true')).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Release initial scan' }))
  await waitFor(() => {
    expect(router.state.location.search).toMatchObject({
      onboarding: 'site-health',
      setupProject: 'example-com',
    })
    expect(router.state.location.search).not.toHaveProperty('siteHealthRunId')
  })

  fireEvent.click(screen.getByRole('button', { name: 'Continue onboarding' }))
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/setup')
    expect(router.state.location.search).toMatchObject({
      experience: 'legacy',
      setupProject: 'example-com',
      onboarding: 'site-health',
    })
    expect(router.state.location.search).not.toHaveProperty('siteHealthRunId')
  })
})

test('the explicit Site Health handoff never falls back to a different project', async () => {
  const restore = mockFetch((url) => pathOf(url) === '/api/v1/projects'
    ? jsonResponse([{
        id: 'project-different',
        name: 'different-project',
        displayName: 'Different',
        canonicalDomain: 'different.example',
        ownedDomains: [], aliases: [], country: 'GB', language: 'fr', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }])
    : jsonResponse([]))
  onTestFinished(restore)

  await renderSetup('/setup?onboarding=site-health&setupProject=missing-project&siteHealthRunId=site-audit-1')

  expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeTruthy()
  expect(screen.getByText(/missing-project/)).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Explicit Site Health' })).toBeNull()
})

test('a malformed AI Visibility handoff never falls back to the first project', async () => {
  await renderSetup('/setup?experience=legacy&onboarding=site-health', {
    mappedProjectName: 'different-project',
  })

  expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeTruthy()
  expect(screen.getByText('This setup link does not identify a project.')).toBeTruthy()
  expect(screen.queryByText('Step 3 of 5')).toBeNull()
})

test('the explicit Site Health handoff can be skipped to the mapped project', async () => {
  const restore = mockFetch((url) => pathOf(url) === '/api/v1/projects'
    ? jsonResponse([{
        id: 'project-example',
        name: 'example-com',
        displayName: 'Example',
        canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }])
    : jsonResponse([]))
  onTestFinished(restore)

  const { router } = await renderSetup('/setup?onboarding=site-health&setupProject=example-com&siteHealthRunId=site-audit-1')
  fireEvent.click(await screen.findByRole('button', { name: 'Skip onboarding' }))

  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/projects/example-com/technical-aeo')
    expect(router.state.location.search).toEqual({})
  })
})

test('continues a mapped project into focused AI Visibility setup', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects/example-com/queries') return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)
  await renderSetup('/setup?experience=legacy&onboarding=site-health&setupProject=example-com', {
    mappedProjectName: 'example-com',
  })

  const heading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(heading).toBeTruthy()
  expect(document.activeElement).toBe(heading)
  expect(screen.getByText('Step 1 of 2')).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).toContain('Queries')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).toContain('First sweep')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).not.toContain('System check')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).not.toContain('Create project')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).not.toContain('Competitors')
  const onboardingProgress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(onboardingProgress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Map your site' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Set up Advanced measurement instead' })).toBeNull()
})

test('does not resume another project when the Site Health handoff is stale', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch(() => jsonResponse([]))
  onTestFinished(restore)
  const { resolveMappedProject } = await renderSetup('/setup?experience=legacy&setupProject=missing-project', {
    mappedProjectName: 'different-project',
  })

  const heading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(heading).toBeTruthy()
  expect(document.activeElement).toBe(heading)
  expect(screen.getByRole('heading', { name: 'Project not found' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  expect(screen.getByRole('link', { name: 'View projects' }).getAttribute('href')).toBe('/projects')

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  resolveMappedProject('missing-project')

  const resolvedHeading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(resolvedHeading).not.toBe(heading)
  expect(document.activeElement).toBe(resolvedHeading)
  expect(screen.getByText('Step 1 of 2')).toBeTruthy()
})

test('keeps the fresh-install launchpad focused until a project exists', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'View projects' })).toBeNull()
})

test('creates without a crawl and enters provider-free query setup for the exact project', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const requests: Array<{ path: string; method: string }> = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    const method = init?.method ?? 'GET'
    requests.push({ path, method })
    if (path === '/api/v1/projects' && method === 'POST') {
      return jsonResponse({
        id: 'project-example',
        name: 'example-com',
        displayName: 'example.com',
        canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'GB', language: 'fr', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }, 201)
    }
    if (path === '/api/v1/projects/example-com/queries') return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)
  const { router } = await renderSetup('/setup', {
    mappedProjectName: 'example-com',
    providerReady: false,
  })

  const escape = await screen.findByRole('link', { name: 'Set up without a site scan' })
  fireEvent.click(escape)

  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/setup')
    expect(router.state.location.search).toMatchObject({
      experience: 'platform',
      onboarding: 'first-run',
      siteScan: 'skip',
    })
  })
  expect(await screen.findByRole('heading', { name: 'Create a project' })).toBeTruthy()
  expect(screen.getByText('No site scan will run.', { exact: false })).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: /Allow Canonry to scan/i })).toBeNull()

  fireEvent.change(screen.getByLabelText('Website URL'), { target: { value: 'https://www.example.com/pricing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.getByText('Step 1 of 2')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
  expect(router.state.location.search).toMatchObject({
    experience: 'legacy',
    onboarding: 'first-run',
    setupProject: 'example-com',
  })
  expect(router.state.location.search).not.toHaveProperty('siteScan')
  expect(requests.filter(request => request.path === '/api/v1/projects' && request.method === 'POST')).toHaveLength(1)
  expect(requests.some(request => request.path.endsWith('/technical-aeo/runs') && request.method === 'POST')).toBe(false)
})

test('keeps the auto launchpad in an accessible loading state until the project list resolves', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let resolveProjects: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) {
      return new Promise<Response>((resolve) => { resolveProjects = resolve })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect((await screen.findByRole('status')).textContent).toContain('Loading projects')
  resolveProjects?.(jsonResponse([]))
  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
})

test('auto waits for a successful authoritative empty project list before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
  expect(screen.getByText('Enter your public website to see its pages, structure, and internal links.')).toBeTruthy()
  const setupForm = screen.getByRole('form', { name: 'Map your site' })
  const agentOption = screen.getByRole('region', { name: 'Use your agent instead' })
  expect(Boolean(setupForm.compareDocumentPosition(agentOption) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(screen.getByText('Copy a complete CLI setup request into any coding agent.')).toBeTruthy()
  const agentGuide = screen.getByRole('link', { name: /Agent quickstart/i })
  expect(agentGuide.getAttribute('href')).toBe(AGENT_SETUP_GUIDE_URL)
  expect(agentGuide.getAttribute('target')).toBe('_blank')
  expect(agentGuide.getAttribute('rel')).toContain('noopener')
  expect(agentGuide.getAttribute('rel')).toContain('noreferrer')
  expect(screen.getByLabelText('Website URL')).toHaveProperty('required', true)
  expect(screen.getByText('Only public pages are scanned.')).toBeTruthy()
  expect(screen.getByText('Advanced settings')).toBeTruthy()
  expect(screen.getByText('United States · English')).toBeTruthy()
  const crawlApproval = screen.getByRole('checkbox', {
    name: 'Allow Canonry to scan this public site.',
  })
  expect(crawlApproval).toBeTruthy()
  expect(crawlApproval.getAttribute('aria-describedby')).toBe('local-crawl-note')
  expect(screen.getByText('The crawl runs on this Canonry instance, follows internal links, and stores its results locally.')).toBeTruthy()
  expect(screen.queryByText('Allow Canonry to scan this public site and follow internal links.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Map site' })).toBeTruthy()
  const onboardingProgress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(onboardingProgress).getByText('Site audit').closest('[aria-current="step"]')).toBeTruthy()
  expect(within(onboardingProgress).getByText('AI Visibility')).toBeTruthy()
  expect(within(onboardingProgress).getByText('Optional')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy setup request' }).getAttribute('type')).toBe('button')
  expect(screen.queryByText(/The crawl does not call answer providers/i)).toBeNull()
  expect(screen.queryByText(/Aero is enabled/i)).toBeNull()
  expect(screen.queryByText(/configured agent provider/i)).toBeNull()
  expect(screen.queryByText('Start with a publicly reachable site.')).toBeNull()
})

test('offers accessible supported locale selects with exact API codes', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)
  await renderSetup()

  await screen.findByLabelText('Website URL')
  fireEvent.click(screen.getByText('Advanced settings'))
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

test('discloses and controls anonymous telemetry when the host supports it', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  let updated: boolean | undefined
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/telemetry/onboarding') return jsonResponse({ accepted: true }, 202)
    if (path === '/api/v1/telemetry' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ enabled: true, anonymousId: 'abcd1234...' })
    }
    if (path === '/api/v1/telemetry' && init?.method === 'PUT') {
      updated = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled
      return jsonResponse({ enabled: updated, anonymousId: 'abcd1234...' })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)
  const { queryClient } = await renderSetup()

  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ })
  expect((control as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText(/does not send raw domains, URLs, queries, answer content, or credentials/i)).toBeTruthy()

  fireEvent.click(control)
  await waitFor(() => expect(updated).toBe(false))
  expect((control as HTMLInputElement).checked).toBe(false)
  expect(queryClient.getQueryData(getApiV1TelemetryQueryKey({ client: heyClient }))).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})

test('gives an agent a copyable setup request', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const writeText = vi.fn(async () => {})
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  onTestFinished(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  await renderSetup()
  fireEvent.click(await screen.findByRole('button', { name: 'Copy setup request' }))

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_REQUEST)
  })
  expect(AGENT_SETUP_REQUEST).toContain('https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent')
  expect(AGENT_SETUP_REQUEST).toContain('https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md')
  expect(AGENT_SETUP_REQUEST).toContain('https://github.com/Canonry/canonry/blob/main/docs/plugins.md')
  expect(AGENT_SETUP_REQUEST).toContain('https://github.com/Canonry/canonry/blob/main/docs/mcp.md')
  expect(AGENT_SETUP_REQUEST).toContain('cnry doctor --format json')
  expect(AGENT_SETUP_REQUEST).toContain('cnry project list --format json')
  expect(AGENT_SETUP_REQUEST).toContain('npm install -g @canonry/canonry')
  expect(AGENT_SETUP_REQUEST.indexOf('Ask for my public domain')).toBeLessThan(AGENT_SETUP_REQUEST.indexOf('cnry project create'))
  expect(AGENT_SETUP_REQUEST).toContain('wait for separate approval before scanning')
  expect(AGENT_SETUP_REQUEST).toContain('If initialization is required, tell me to run `cnry bootstrap`')
  expect(AGENT_SETUP_REQUEST).toContain('Never ask me to paste passwords, API keys, OAuth credentials, or `cnry bootstrap` output')
  expect(screen.getByRole('button', { name: 'Copied setup request' })).toBeTruthy()
})

test('offers the agent guide when the Clipboard API is unavailable', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
  onTestFinished(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  await renderSetup()
  fireEvent.click(await screen.findByRole('button', { name: 'Copy setup request' }))

  await waitFor(() => {
    expect(getToasts()).toContainEqual(expect.objectContaining({
      tone: 'negative',
      title: 'Could not copy setup request',
      detail: 'Open the agent quickstart to continue with the CLI instead.',
    }))
  })
  expect(screen.queryByRole('button', { name: 'Copied setup request' })).toBeNull()
  expect(screen.getByRole('link', { name: /Agent quickstart/i })).toBeTruthy()
})

test('auto confirms a cached empty project list after mount before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let resolveProjects: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects') {
      return new Promise<Response>((resolve) => { resolveProjects = resolve })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup('/setup', { seedEmptyProjectsCache: true })

  expect((await screen.findByRole('status')).textContent).toContain('Loading projects')
  expect(screen.queryByRole('heading', { name: 'Map your site' })).toBeNull()

  resolveProjects?.(jsonResponse([]))
  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
})

test('keeps typed launchpad input mounted through an in-flight shared project refetch', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let projectListReads = 0
  let resolveBackgroundRefetch: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects') {
      projectListReads += 1
      if (projectListReads === 1) return jsonResponse([])
      return new Promise<Response>((resolve) => {
        resolveBackgroundRefetch = resolve
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const { queryClient } = await renderSetup()
  const domain = await screen.findByLabelText('Website URL') as HTMLInputElement
  fireEvent.change(domain, { target: { value: 'example.com' } })
  const approval = screen.getByRole('checkbox', { name: /Allow Canonry/i }) as HTMLInputElement
  fireEvent.click(approval)
  domain.focus()

  const refetch = queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
  })
  await waitFor(() => {
    expect(resolveBackgroundRefetch).toBeTypeOf('function')
  })

  expect((screen.getByLabelText('Website URL') as HTMLInputElement).value).toBe('example.com')
  expect((screen.getByRole('checkbox', { name: /Allow Canonry/i }) as HTMLInputElement).checked).toBe(true)
  expect(document.activeElement).toBe(screen.getByLabelText('Website URL'))
  expect(screen.queryByText('Loading projects…')).toBeNull()

  resolveBackgroundRefetch?.(jsonResponse([]))
  await refetch
})

test('auto shows a retry shell when the authoritative project-list read fails', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let failed = true
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) {
      return failed
        ? jsonResponse({ error: { message: 'temporary outage' } }, 503)
        : jsonResponse([])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: /load projects/i })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Map your site' })).toBeNull()
  expect(document.querySelector('.app-shell-focus')).toBeTruthy()
  expect(document.querySelector('#desktop-sidebar')).toBeNull()
  expect(document.querySelector('#mobile-nav')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()

  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry project check' }))
  expect(await screen.findByRole('heading', { name: 'Map your site' })).toBeTruthy()
})

test('creates once, queues the canonical Site Health run, and hands off with exact URL state', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const requests: Array<{ path: string; method: string; body: string }> = []
  const restore = mockFetch(async (url, init) => {
    const path = pathOf(url)
    const method = init?.method ?? 'GET'
    requests.push({ path, method, body: String(init?.body ?? '') })
    if (path === '/api/v1/projects' && method === 'POST') {
      return jsonResponse({
        id: 'project-example',
        name: 'example-com',
        displayName: 'example.com',
        canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }, 201)
    }
    if (path === '/api/v1/projects/example-com/technical-aeo/runs' && method === 'POST') {
      return jsonResponse({ runId: 'site-audit-1', status: 'queued' }, 202)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  const { router } = await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website URL'), { target: { value: 'https://www.example.com/pricing' } })
  fireEvent.click(screen.getByText('Advanced settings'))
  fireEvent.change(screen.getByRole('combobox', { name: 'Country' }), { target: { value: 'GB' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'fr' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Map site' }))

  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/setup')
    expect(router.state.location.search).toMatchObject({
      siteHealthRunId: 'site-audit-1',
      onboarding: 'site-health',
      setupProject: 'example-com',
    })
  })

  expect(router.state.location.search).toMatchObject({
    siteHealthRunId: 'site-audit-1',
    onboarding: 'site-health',
    setupProject: 'example-com',
  })
  expect(router.state.location.search).not.toHaveProperty('runId')
  expect(getRunTrackerState().runs['site-audit-1']).toMatchObject({
    projectId: 'project-example',
    kind: 'site-audit',
    sourceAction: 'site-audit',
  })
  const create = requests.find((request) => request.path === '/api/v1/projects')
  expect(create).toMatchObject({ method: 'POST' })
  expect(JSON.parse(create?.body ?? '{}')).toMatchObject({
    name: 'example-com',
    canonicalDomain: 'example.com',
    country: 'GB',
    language: 'fr',
  })
  const siteAudit = requests.find((request) => request.path.endsWith('/technical-aeo/runs') && request.method === 'POST')
  expect(siteAudit).toBeDefined()
  expect(JSON.parse(siteAudit?.body ?? '{}')).toEqual({ checkDeadLinks: true })
})

test('preserves a created project with retry and setup recovery when dispatch fails', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      return jsonResponse({
        id: 'project-example', name: 'example-com', displayName: 'example.com', canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
        locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }, 201)
    }
    if (path.endsWith('/technical-aeo/runs') && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'worker unavailable' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website URL'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Map site' }))

  expect(await screen.findByRole('heading', { name: 'Project created' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry Site Health scan' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue setup' })).toBeTruthy()
  expect(getToasts().filter((toast) => toast.tone === 'negative')).toHaveLength(0)
})

test('keeps auto mode on project-created recovery after the project list becomes non-empty', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let created = false
  const project = {
    id: 'project-example', name: 'example-com', displayName: 'example.com', canonicalDomain: 'example.com',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
    locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      created = true
      return jsonResponse(project, 201)
    }
    if (path === '/api/v1/projects' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(created ? [project] : [])
    }
    if (path.endsWith('/technical-aeo/runs') && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'worker unavailable' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website URL'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Map site' }))

  expect(await screen.findByRole('heading', { name: 'Project created' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
})

test('surfaces a create-only name collision and never starts a scan', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const requests: string[] = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'Project already exists', code: 'ALREADY_EXISTS' } }, 409)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website URL'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Map site' }))

  expect(await screen.findByText(/project with this name already exists/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'View projects' })).toBeTruthy()
  expect(requests.some((request) => request.includes('technical-aeo/runs'))).toBe(false)
})

test('keeps auto mode on actionable conflict recovery after the project list becomes non-empty', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let conflictReturned = false
  const existingProject = {
    id: 'project-existing', name: 'example-com', displayName: 'Example', canonicalDomain: 'example.com',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
    locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      conflictReturned = true
      return jsonResponse({ error: { message: 'Project already exists', code: 'ALREADY_EXISTS' } }, 409)
    }
    if (path === '/api/v1/projects') return jsonResponse(conflictReturned ? [existingProject] : [])
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website URL'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Map site' }))

  expect(await screen.findByRole('button', { name: 'View projects' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
})
