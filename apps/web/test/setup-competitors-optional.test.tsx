import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { clearOnboardingRunLaunched } from '../src/lib/onboarding-telemetry.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

afterEach(() => {
  cleanup()
  clearOnboardingRunLaunched()
})

/** The full wizard, resumed on a project that has queries but no competitors. */
function renderAtCompetitorsStep() {
  const fixture = createDashboardFixture()
  const project = structuredClone(fixture.dashboard.projects[0]!)
  project.competitors = []
  project.queryCounts = { cited: 0, total: 0 }
  fixture.dashboard.projects = [project]
  fixture.dashboard.runs = []
  fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses
    .map(provider => ({ ...provider, state: 'ready' as const }))

  const restore = mockFetch((url) => {
    const path = pathOf(url)
    if (path.endsWith('/queries')) return jsonResponse([{ id: 'query-1', query: 'best local dentist' }])
    if (path === '/api/v1/projects' || path.split('?')[0] === '/api/v1/runs') return jsonResponse([])
    if (path.endsWith('/measurement-setup')) return jsonResponse({ answerVisibilityProviderReady: true })
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null}>
        <DashboardProvider value={fixture}>
          <SetupPage />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
}

test('an empty competitors step offers a primary way forward instead of a disabled save', async () => {
  renderAtCompetitorsStep()
  expect(await screen.findByRole('heading', { name: 'Add competitors' })).toBeTruthy()
  expect(screen.getByText(/^Optional\./)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Save 0 competitors/ })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Continue without competitors' }))
  expect(await screen.findByText(/Step 5 of 5/)).toBeTruthy()
})

test('once a competitor is entered, saving and skipping are both offered', async () => {
  renderAtCompetitorsStep()
  fireEvent.change(await screen.findByLabelText('Competitor domains (one per line)'), { target: { value: 'rival.example' } })
  expect(screen.getByRole('button', { name: 'Save 1 competitor' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Continue without competitors' })).toBeNull()
})
