import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { RunKinds, RunStatuses, RunTriggers, type RunKind } from '@canonry/canonry-contracts'
import { afterEach, expect, test } from 'vitest'
import { toRunListItem } from '../src/build-dashboard.js'
import { PastSweeps } from '../src/components/project/PastSweeps.js'
import { RunRow } from '../src/components/shared/RunRow.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { OverviewPage } from '../src/pages/OverviewPage.js'

// Exercise the real list controls and router: a mocked drawer cannot detect a
// refresh sent to the sweep drawer or a link that drops Advanced context.
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
})

const advancedContext = {
  measurementScope: 'property', measurementScopeKey: 'property-fr',
  measurementMarketKey: 'fr', queryClass: 'non-brand', provider: 'openai',
}
type Surface = 'overview' | 'past checks' | 'run history'

async function mount(surface: Surface, kind: RunKind = RunKinds['seo-sync'], overrides: Partial<Parameters<typeof toRunListItem>[0]> = {}) {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.portfolioOverview.projects[0]!.project
  project.name = 'canonical-slug'
  project.displayName = 'Customer-facing display name'
  const run = toRunListItem({
    id: 'selected-refresh', projectId: project.id, kind,
    status: RunStatuses.completed, trigger: RunTriggers.manual,
    createdAt: '2026-10-20T12:00:00Z', startedAt: '2026-10-20T12:00:00Z', finishedAt: '2026-10-20T12:01:00Z',
    ...overrides,
  }, project.displayName)
  fixture.dashboard.portfolioOverview.recentRuns = [run]
  const sourcePath = surface === 'overview' ? '/' : surface === 'past checks' ? '/projects/$projectName' : '/runs'
  const initialPath = surface === 'past checks' ? '/projects/canonical-slug' : sourcePath
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const root = createRootRoute({ validateSearch: (search: Record<string, unknown>) => search })
  const source = createRoute({ getParentRoute: () => root, path: sourcePath, component: () =>
    surface === 'overview' ? <OverviewPage /> : surface === 'past checks'
      ? <PastSweeps runs={[run]} projectName={project.name} />
      : <RunRow run={run} projectSlug={project.name} />,
  })
  const destination = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/seo-data', component: () => <h1>Saved SEO refresh</h1> })
  const search = new URLSearchParams({ ...advancedContext, seoProfileId: 'old-profile', runId: 'old-sweep', evidenceId: 'old-answer' })
  const router = createRouter({ routeTree: root.addChildren([source, destination]), history: createMemoryHistory({ initialEntries: [`${initialPath}?${search}`] }) })
  await router.load()
  render(<QueryClientProvider client={client}><DashboardProvider value={fixture}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider>)
  return { router, initialPath }
}

test.each<Surface>(['overview', 'past checks', 'run history'])('%s opens the exact SEO refresh under its canonical project while preserving Advanced context', async surface => {
  const { router } = await mount(surface)
  const name = surface === 'overview' ? /Customer-facing display name/ : surface === 'past checks' ? /^View SEO refresh from/ : 'View refresh'
  fireEvent.click(screen.getByRole('link', { name }))
  await screen.findByRole('heading', { name: 'Saved SEO refresh' })
  expect(router.state.location.pathname).toBe('/projects/canonical-slug/seo-data')
  expect(router.state.location.search).toMatchObject({ ...advancedContext, seoRunId: 'selected-refresh' })
  expect(router.state.location.search.seoProfileId).toBeUndefined()
  expect(router.state.location.search.runId).toBeUndefined()
  expect(router.state.location.search.evidenceId).toBeUndefined()
})

test('past checks still opens an AI sweep in the current page drawer', async () => {
  const { router, initialPath } = await mount('past checks', RunKinds['answer-visibility'])
  fireEvent.click(screen.getByRole('button', { name: /^View the .* check$/ }))
  await waitFor(() => expect(router.state.location.search.runId).toBe('selected-refresh'))
  expect(router.state.location.pathname).toBe(initialPath)
  expect(router.state.location.search).toMatchObject(advancedContext)
  expect(router.state.location.search.evidenceId).toBeUndefined()
  expect(router.state.location.search.seoRunId).toBeUndefined()
})

test.each<Surface>(['past checks', 'run history'])('%s opens a scheduled SEO refresh that never started in the run drawer, where its reason is shown', async surface => {
  const { router, initialPath } = await mount(surface, RunKinds['seo-sync'], {
    status: RunStatuses.failed, trigger: RunTriggers.scheduled, startedAt: undefined,
    error: { message: 'Scheduled SEO refresh for profile "main" did not start: SEO refresh is unavailable under the current policy.' },
  })
  fireEvent.click(screen.getByRole('button', { name: surface === 'past checks' ? /^View the .* check$/ : 'View run' }))
  await waitFor(() => expect(router.state.location.search.runId).toBe('selected-refresh'))
  expect(router.state.location.pathname).toBe(initialPath)
  expect(router.state.location.search.seoRunId).toBeUndefined()
})
