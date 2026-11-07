import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

async function renderProjects(apiKey?: ApiKeyAccess, emptyPortfolio = false, configure?: (fixture: ReturnType<typeof createDashboardFixture>) => void) {
  const fixture = createDashboardFixture({ emptyPortfolio })
  if (emptyPortfolio) fixture.dashboard.projects = []
  configure?.(fixture)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={apiKey}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { fixture, router }
}

test.each([false, true])('routes Add project through AI-first setup without starting a scan (empty=%s)', async emptyPortfolio => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'legacy' } }
  const requests: Array<{ path: string; method: string }> = []
  const restore = mockFetch((url, init) => {
    requests.push({ path: pathOf(url), method: init?.method ?? 'GET' })
    return jsonResponse({})
  })
  onTestFinished(restore)
  const { router } = await renderProjects(undefined, emptyPortfolio)

  fireEvent.click(await screen.findByRole('button', { name: emptyPortfolio ? 'Add a project' : 'Add project' }))

  await waitFor(() => expect(router.state.location.pathname).toBe('/setup'))
  expect(router.state.location.search).toEqual({ experience: 'platform' })
  expect(await screen.findByRole('heading', { name: 'Track your brand in AI answers' })).toBeTruthy()
  expect(screen.getByLabelText('Website URL')).toBeTruthy()
  expect(screen.getByLabelText('Brand name')).toBeTruthy()
  expect(screen.queryByLabelText('Canonical domain')).toBeNull()
  expect(requests.some(request => request.path === '/api/v1/projects' && request.method === 'POST')).toBe(false)
})

test('hides instance project creation from a project-scoped write key', async () => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects({
    id: 'project-writer',
    scopes: ['*'],
    projectId: 'project_citypoint',
    readOnly: false,
  })

  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  fireEvent.click(screen.getByText('Import configuration'))
  expect(screen.getByRole('textbox', { name: 'Configuration YAML' })).toBeTruthy()
})

test.each([
  ['read-only', { id: 'reader', scopes: ['read'], projectId: null, readOnly: true }],
  ['narrow', { id: 'ads-writer', scopes: ['ads.write'], projectId: null, readOnly: false }],
] as const)('hides project and YAML write affordances from a %s key', async (_label, apiKey) => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects(apiKey)

  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Configuration YAML' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
})

test('does not offer project creation in a read-only empty state', async () => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)

  await renderProjects({
    id: 'reader',
    scopes: ['read'],
    projectId: null,
    readOnly: true,
  }, true)

  expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add a project' })).toBeNull()
})


test.each([true, false])('Projects renders server coverage (measured=%s) without pooling branded evidence or using a legacy score', async measured => {
  const restore = mockFetch(() => jsonResponse({}))
  onTestFinished(restore)
  const { fixture } = await renderProjects(undefined, false, fixture => {
    fixture.dashboard.projects = [fixture.dashboard.projects[0]!]
    fixture.dashboard.projects[0]!.mentionSummary.value = '99.9%'
    fixture.dashboard.projects[0]!.mentionCoverage = {
      selection: {
        mode: 'simple', queryClass: 'all', scope: { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
        provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: null,
        run: { id: 'completed', explicit: false }, provenance: { kind: 'frozen-simple', definitionRevision: null },
        measurement: { state: 'measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-11-06T12:00:00Z' },
        availability: { state: 'available' },
      },
      populations: [
        { queryClass: 'non-brand', queryCount: 2, answerCount: 4, mentionCoverage: measured ? { numerator: 1, denominator: 4, rate: 0.25 } : { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }, citationCoverage: { numerator: 0, denominator: 4, rate: 0 } },
        { queryClass: 'branded', queryCount: 1, answerCount: 2, mentionCoverage: { numerator: 2, denominator: 2, rate: 1 }, citationCoverage: { numerator: 0, denominator: 2, rate: 0 } },
      ],
    }
  })
  expect(await screen.findByRole('columnheader', { name: 'Mentions · non-brand' })).toBeTruthy()
  const project = fixture.dashboard.projects[0]!.project
  const row = within(screen.getByRole('table')).getByRole('link', { name: project.displayName || project.name }).closest('tr')!
  expect(row.textContent).toContain(measured ? '25.0%' : 'Not measured')
  if (measured) expect(row.textContent).toContain('1 of 4 answers')
  expect(row.textContent).not.toContain('null')
  expect(row.textContent).not.toContain('99.9%')
  const branded = screen.getByText('Branded queries').closest('details')!
  expect(branded.open).toBe(false)
  fireEvent.click(screen.getByText('Branded queries'))
  expect(branded.textContent).toContain('100% · 2 of 2 answers')
})
