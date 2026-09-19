import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { AGENT_SETUP_GUIDE_URL, AGENT_SETUP_REQUEST, resolveAutoResumeTarget } from '../src/pages/OnboardingSetupPage.js'

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

  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
  expect(screen.getByText('Use your agent instead')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy setup request' })).toBeTruthy()
})

test('the legacy rescue query wins over an enabled platform flag', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  await renderSetup('/setup?experience=legacy')

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
})

test('auto resumes Site Health for an existing project instead of the provider-gated wizard', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
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

  const { router } = await renderSetup('/setup')

  await waitFor(() => {
    expect(router.state.location.search).toMatchObject({
      onboarding: 'site-health',
      setupProject: 'example-com',
    })
  })
  expect(await screen.findByRole('region', { name: 'Explicit Site Health' })).toBeTruthy()
  expect(screen.getByText('example-com:project-example:latest:true')).toBeTruthy()
  expect(screen.queryByText('Launch is blocked until at least one provider is configured.')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Scan your site' })).toBeNull()
})

const AUTO_RESUME_PROJECT = {
  id: 'project-example',
  name: 'example-com',
  displayName: 'Example',
  canonicalDomain: 'example.com',
  ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
  providers: [], providerModels: {}, locations: [], defaultLocation: null,
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
  autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function mockAutoResumeApi(siteAuditRuns: unknown[]) {
  return mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects') return jsonResponse([AUTO_RESUME_PROJECT])
    // `pathOf` keeps the query string, and `/api/v1/runs/<id>` is a different
    // endpoint the resumed page also reads.
    if (path === '/api/v1/runs' || path.startsWith('/api/v1/runs?')) return jsonResponse(siteAuditRuns)
    if (path.startsWith('/api/v1/runs/')) {
      return jsonResponse({ id: 'run_active', projectId: 'project-example', kind: 'site-audit', status: 'running', createdAt: '2026-02-02T00:00:00.000Z' })
    }
    return jsonResponse([])
  })
}

test('auto resume pins the project\'s latest scan so the resumed session can report an outcome', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  onTestFinished(mockAutoResumeApi([
    { id: 'run_active', projectId: 'project-example', kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: '2026-02-02T00:00:00.000Z' },
  ]))

  const { router } = await renderSetup('/setup')

  await waitFor(() => {
    expect(router.state.location.search).toMatchObject({
      onboarding: 'site-health',
      setupProject: 'example-com',
      siteHealthRunId: 'run_active',
    })
  })
  expect(screen.getByText('example-com:project-example:run_active:true')).toBeTruthy()
})

test('auto resume leaves a scanned install on the wizard instead of reopening first-run setup', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  onTestFinished(mockAutoResumeApi([
    { id: 'run_done', projectId: 'project-example', kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: '2026-02-02T00:00:00.000Z' },
  ]))

  const { router } = await renderSetup('/setup')

  expect(await screen.findByText(/Step \d of 5/)).toBeTruthy()
  expect(router.state.location.search).not.toMatchObject({ onboarding: 'site-health' })
  expect(screen.queryByRole('region', { name: 'Explicit Site Health' })).toBeNull()
})

test('resolveAutoResumeTarget agrees with the serve banner', () => {
  const projects = [
    { id: 'a', name: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', name: 'bravo', createdAt: '2026-01-02T00:00:00.000Z' },
  ] as unknown as Parameters<typeof resolveAutoResumeTarget>[0]

  // Nothing scanned: the oldest project, and no run to pin.
  expect(resolveAutoResumeTarget(projects, [])).toEqual({ projectName: 'alpha', runId: undefined })

  // The first UNSCANNED one, exactly like `buildServeOpenLine`.
  expect(resolveAutoResumeTarget(projects, [
    { id: 'r1', projectId: 'a', status: 'completed', trigger: 'manual' },
  ])).toEqual({ projectName: 'bravo', runId: undefined })

  // Everything scanned: no redirect at all.
  expect(resolveAutoResumeTarget(projects, [
    { id: 'r1', projectId: 'a', status: 'completed', trigger: 'manual' },
    { id: 'r2', projectId: 'b', status: 'partial', trigger: 'scheduled' },
  ])).toBeNull()

  // A probe is not a scan the operator asked for, so it neither marks the
  // project scanned nor gets pinned. The newest non-probe run wins.
  expect(resolveAutoResumeTarget(projects, [
    { id: 'r_probe', projectId: 'a', status: 'completed', trigger: 'probe' },
    { id: 'r_failed', projectId: 'a', status: 'failed', trigger: 'manual' },
  ])).toEqual({ projectName: 'alpha', runId: 'r_failed' })
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
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  expect(screen.queryByText('System check')).toBeNull()
  expect(screen.queryByText('Create project')).toBeNull()
  expect(screen.queryByText('Competitors')).toBeNull()
  const onboardingProgress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(onboardingProgress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Scan your site' })).toBeNull()
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

  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
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
  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
})

test('auto waits for a successful authoritative empty project list before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
  expect(screen.getByText('Enter your public website to see its pages, structure, internal links, and technical SEO scores.')).toBeTruthy()
  const setupForm = screen.getByRole('form', { name: 'Scan your site' })
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
  expect(screen.getByText('Project name and locale')).toBeTruthy()
  expect(screen.getByText('United States · English')).toBeTruthy()
  const crawlApproval = screen.getByRole('checkbox', {
    name: 'Allow Canonry to scan this public site.',
  })
  expect(crawlApproval).toBeTruthy()
  expect(crawlApproval.getAttribute('aria-describedby')).toBe('local-crawl-note')
  expect(screen.getByText(/The crawl runs on this Canonry instance, follows internal links, and stores its results locally\./)).toBeTruthy()
  expect(screen.queryByText('Allow Canonry to scan this public site and follow internal links.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Scan site' })).toBeTruthy()
  const onboardingProgress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(onboardingProgress).getByText('Scan site').closest('[aria-current="step"]')).toBeTruthy()
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
  fireEvent.click(screen.getByText('Project name and locale'))
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

test.each([false, true])('hides internal telemetry after operator denial without blocking setup (cached: %s)', async cached => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  let allowed = cached
  const restore = mockFetch(async url => {
    const path = pathOf(url)
    if (path === '/api/v1/telemetry') return allowed
      ? jsonResponse({ enabled: true, anonymousId: 'abcd1234...' })
      : jsonResponse({ error: { code: 'FORBIDDEN', message: 'Host-approved operator required.' } }, 403)
    if (path === '/api/v1/telemetry/onboarding') return jsonResponse({ accepted: true }, 202)
    return jsonResponse({})
  })
  onTestFinished(restore)
  const { queryClient } = await renderSetup()
  const key = getApiV1TelemetryQueryKey({ client: heyClient })
  if (cached) {
    await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ })
    allowed = false
    await queryClient.invalidateQueries({ queryKey: key })
  }
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))
  expect(screen.queryByRole('checkbox', { name: /Share anonymous product telemetry/ })).toBeNull()
  expect(screen.getByLabelText('Website URL')).toBeTruthy()
})

function mockTelemetryPreferences(initialEnabled: boolean, update?: (enabled: boolean) => Response | Promise<Response>) {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  let serverEnabled = initialEnabled
  const updates: boolean[] = []
  const restore = mockFetch(async (url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/telemetry/onboarding') return jsonResponse({ accepted: true }, 202)
    if (path === '/api/v1/telemetry' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ enabled: serverEnabled, anonymousId: 'abcd1234...' })
    }
    if (path === '/api/v1/telemetry' && init?.method === 'PUT') {
      const requested = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled
      updates.push(requested)
      const response = update
        ? await update(requested)
        : jsonResponse({ enabled: requested, anonymousId: 'abcd1234...' })
      if (response.ok) serverEnabled = ((await response.clone().json()) as { enabled: boolean }).enabled
      return response
    }
    return jsonResponse({})
  })
  onTestFinished(restore)
  return {
    updates,
    setServerEnabled(enabled: boolean) { serverEnabled = enabled },
  }
}

test('discloses the enabled fresh-install preference and toggles telemetry through its label in both directions', async () => {
  const server = mockTelemetryPreferences(true)
  const { queryClient } = await renderSetup()
  const telemetryKey = getApiV1TelemetryQueryKey({ client: heyClient })

  const control = await screen.findByRole('checkbox', { name: /Share anonymous product telemetry/ })
  expect((control as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText(/does not send raw domains, URLs, queries, answer content, or credentials/i)).toBeTruthy()
  expect(server.updates).toEqual([])

  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  }))
  expect((control as HTMLInputElement).checked).toBe(false)
  await waitFor(() => expect((control as HTMLInputElement).disabled).toBe(false))

  fireEvent.click(screen.getByText('Share anonymous product telemetry'))
  await waitFor(() => expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: true,
    anonymousId: 'abcd1234...',
  }))
  expect((control as HTMLInputElement).checked).toBe(true)
  expect(server.updates).toEqual([false, true])

  // A later server preference must replace the last mutation response.
  server.setServerEnabled(false)
  await queryClient.invalidateQueries({ queryKey: telemetryKey })
  await waitFor(() => expect((control as HTMLInputElement).checked).toBe(false))
  expect(queryClient.getQueryData(telemetryKey)).toEqual({
    enabled: false,
    anonymousId: 'abcd1234...',
  })
})

test('preserves an existing telemetry opt-out until the user chooses to enable it', async () => {
  const server = mockTelemetryPreferences(false)
  const { queryClient } = await renderSetup()
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
  const { queryClient } = await renderSetup()
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
  const { queryClient } = await renderSetup()
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
  const { queryClient } = await renderSetup()
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


test('the README carries the same setup request the dashboard copies', () => {
  // Two hand-maintained copies of the same instructions, and they had already
  // drifted: the README's was missing the bounded page budget and the
  // scan-reuse rule. Whichever one an operator finds has to be the live one.
  // Walk up from the vitest cwd rather than `import.meta.url`, which is not a
  // file URL in this environment.
  let dir = resolve(process.cwd())
  while (!existsSync(join(dir, 'pnpm-workspace.yaml')) && dirname(dir) !== dir) dir = dirname(dir)
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  const fence = '```'
  const start = readme.indexOf(`${fence}text\nHelp me set up Canonry for my public site.`)
  expect(start).toBeGreaterThan(-1)
  const body = readme.slice(start + fence.length + 'text\n'.length)
  expect(body.slice(0, body.indexOf(`\n${fence}`))).toBe(AGENT_SETUP_REQUEST)
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
  expect(AGENT_SETUP_REQUEST).toContain('technical-aeo crawl')
  expect(AGENT_SETUP_REQUEST).toContain('only one of these commands that carries `termination`')
  // `--wait` has no timeout, and rerunning the scan is the wrong recovery.
  expect(AGENT_SETUP_REQUEST).toContain('technical-aeo progress')
  expect(AGENT_SETUP_REQUEST).toContain('do not rerun the scan')
  // A time limit needs a SMALLER scan, which is the counterintuitive direction.
  expect(AGENT_SETUP_REQUEST).toContain('a time limit needs a smaller scan')
  expect(AGENT_SETUP_REQUEST).toContain('never present it as a full-site result')
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
  expect(AGENT_SETUP_REQUEST).toContain('cnry start')
  expect(AGENT_SETUP_REQUEST).toContain('cnry project list --format json')
  expect(AGENT_SETUP_REQUEST).toContain('npm install -g @canonry/canonry')
  expect(AGENT_SETUP_REQUEST.indexOf('Ask for my public domain')).toBeLessThan(AGENT_SETUP_REQUEST.indexOf('cnry start'))
  expect(AGENT_SETUP_REQUEST).toContain('wait for separate approval before scanning')
  expect(AGENT_SETUP_REQUEST).toContain('--max-pages 100')
  expect(AGENT_SETUP_REQUEST).toContain('never ask me to paste passwords, API keys, OAuth credentials, or command output')
  expect(AGENT_SETUP_REQUEST).toContain('Tell me the termination reason in plain words')
  expect(AGENT_SETUP_REQUEST).toContain('read that scan instead of starting a new one')
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
  expect(screen.queryByRole('heading', { name: 'Scan your site' })).toBeNull()

  resolveProjects?.(jsonResponse([]))
  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
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
  expect(screen.queryByRole('heading', { name: 'Scan your site' })).toBeNull()
  expect(document.querySelector('.app-shell-focus')).toBeTruthy()
  expect(document.querySelector('#desktop-sidebar')).toBeNull()
  expect(document.querySelector('#mobile-nav')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull()

  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry project check' }))
  expect(await screen.findByRole('heading', { name: 'Scan your site' })).toBeTruthy()
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
  fireEvent.click(screen.getByText('Project name and locale'))
  fireEvent.change(screen.getByRole('combobox', { name: 'Country' }), { target: { value: 'GB' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'fr' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Allow Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Scan site' }))

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
  expect(JSON.parse(siteAudit?.body ?? '{}')).toEqual({ checkDeadLinks: true, maxPages: 100 })
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
  fireEvent.click(screen.getByRole('button', { name: 'Scan site' }))

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
  fireEvent.click(screen.getByRole('button', { name: 'Scan site' }))

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
  fireEvent.click(screen.getByRole('button', { name: 'Scan site' }))

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
  fireEvent.click(screen.getByRole('button', { name: 'Scan site' }))

  expect(await screen.findByRole('button', { name: 'View projects' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
})
