import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey } from '@ainyc/canonry-api-client/react-query'
import type { ReactNode } from 'react'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="/projects">{children}</a>,
  }
})

afterEach(() => {
  cleanup()
  navigate.mockReset()
})

function renderProjectSetup(options: {
  onboarding: boolean
  complete?: boolean
  providerReady?: boolean
  projectProviders?: string[]
  readyProviderNames?: string[]
  cdpStatus?: { connected?: boolean; browserVersion?: string }
  apiKey?: ApiKeyAccess
  queryResponse?: () => Response | Promise<Response>
}) {
  const fixture = createDashboardFixture()
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
    fixture.dashboard.settings.providerStatuses = []
  } else if (options.readyProviderNames) {
    const ready = new Set(options.readyProviderNames.map(name => name.toLowerCase()))
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({
      ...provider,
      state: ready.has(provider.name.toLowerCase()) ? 'ready' as const : 'needs-config' as const,
    }))
  }

  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/cdp/status') return jsonResponse(options.cdpStatus ?? {})
    if (pathOf(url).endsWith('/queries')) {
      if (options.queryResponse) return options.queryResponse()
      return jsonResponse(options.complete ? [{ id: 'query-1', query: 'best local dentist' }] : [])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={options.apiKey}>
        <DashboardProvider value={fixture}>
          <SetupPage
            visibilityProjectName={project.project.name}
            siteHealthOnboarding={options.onboarding}
          />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )

  return {
    projectId: project.project.id,
    projectName: project.project.name,
    queryClient,
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

test('lets a project save queries before a provider is configured', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })

  const queries = await screen.findByLabelText('Queries (one per line)')
  fireEvent.change(queries, { target: { value: 'best local dentist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Configure a provider' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
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
  expect(screen.getByRole('link', { name: 'Configure a provider' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Launch visibility sweep' })).toBeNull()
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
