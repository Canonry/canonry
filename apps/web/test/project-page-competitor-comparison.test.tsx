import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { AccountProvider } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { COMPETITOR_COMPARISON_COPY } from '../src/pages/ProjectPage.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
}, 60_000)

afterEach(cleanup)

const SIMPLE_SETUP = {
  state: 'simple',
  nextAction: 'start_setup',
  mode: 'simple',
  answerVisibilityProviderReady: true,
  activeRevision: null,
  activeSchemaVersion: null,
  draft: null,
}

/** The Simple overview of the fixture's Citypoint project, with or without its tracked competitors. */
async function renderOverview({ competitors, role }: { competitors: 'none' | 'fixture'; role?: 'viewer' }) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/measurement-plan')) return jsonResponse({ active: null })
    if (path.endsWith('/measurement-setup')) return jsonResponse(SIMPLE_SETUP)
    if (/^\/api\/v1\/(?:projects\/[^/]+\/)?runs$/.test(path)) return jsonResponse([])
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  const fixture = createDashboardFixture({})
  const project = fixture.dashboard.projects.find(entry => entry.project.id === 'project_citypoint')!
  if (competitors === 'none') project.competitors = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects/project_citypoint'] })
  await router.load()
  return render(
    <AccountProvider account={role ? { name: 'operator', role } : null}>
      <QueryClientProvider client={queryClient}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </QueryClientProvider>
    </AccountProvider>,
  )
}

function gapLabels(details: HTMLElement): Array<string | null | undefined> {
  return [...details.querySelectorAll('.aeo-hero-row-label')].map(label => label.firstChild?.textContent)
}

test('with no tracked competitors the comparison says so instead of showing zero gaps, and opens where competitors are added', async () => {
  const page = await renderOverview({ competitors: 'none' })
  const heading = await page.findByRole('heading', { name: 'Compare competitors' })
  const summary = heading.closest('summary')!
  const details = summary.closest('details')!
  expect(details.open).toBe(false)
  // The toggle is named by its heading alone; the check it reads describes it.
  expect(summary.getAttribute('aria-labelledby')).toBe(heading.id)
  expect(document.getElementById(summary.getAttribute('aria-describedby')!)?.textContent).toBe('Latest check')

  fireEvent.click(summary)
  expect(details.open).toBe(true)
  const comparison = within(details)
  expect(comparison.getByText(COMPETITOR_COMPARISON_COPY.emptyTitle)).toBeTruthy()
  expect(comparison.getByText(COMPETITOR_COMPARISON_COPY.emptyDetail)).toBeTruthy()
  // Neither zero-gap figure nor its bar: with no competitor tracked, both can only read 0.
  expect(gapLabels(details)).toEqual([])
  expect(details.querySelector('.aeo-hero-row-bar')).toBeNull()
  expect(details.querySelector('.competitive-gaps-scope')).toBeNull()
  // Mention share keeps its own reading above the empty state.
  expect(comparison.getByRole('heading', { name: 'Mention share' })).toBeTruthy()

  const history = page.getByText('Competitor history', { selector: 'summary > span' }).closest('details')!
  expect(history.open).toBe(false)
  fireEvent.click(comparison.getByRole('button', { name: COMPETITOR_COMPARISON_COPY.add }))
  await waitFor(() => expect(history.open).toBe(true))
  await waitFor(() => expect(document.activeElement).toBe(history.querySelector('summary')))
})

test('a view-only account sees the same empty comparison without an action it cannot take', async () => {
  const page = await renderOverview({ competitors: 'none', role: 'viewer' })
  const details = (await page.findByRole('heading', { name: 'Compare competitors' })).closest('details')!
  const comparison = within(details)
  expect(comparison.getByText(COMPETITOR_COMPARISON_COPY.emptyTitle)).toBeTruthy()
  expect(comparison.getByText(COMPETITOR_COMPARISON_COPY.emptyDetail)).toBeTruthy()
  expect(comparison.queryByRole('button', { name: COMPETITOR_COMPARISON_COPY.add })).toBeNull()
  expect(gapLabels(details)).toEqual([])
})

test('with tracked competitors the comparison opens on both gap rows and no empty state', async () => {
  const page = await renderOverview({ competitors: 'fixture' })
  const heading = await page.findByRole('heading', { name: 'Where competitors are winning' })
  const summary = heading.closest('summary')!
  const details = summary.closest('details')!
  expect(details.open).toBe(true)
  expect(summary.getAttribute('aria-labelledby')).toBe(heading.id)
  expect(gapLabels(details)).toEqual(['Mention gaps', 'Citation gaps'])
  expect(details.querySelector('.competitive-gaps-scope')?.textContent).toBe('All queries')
  expect(within(details).queryByText(COMPETITOR_COMPARISON_COPY.emptyTitle)).toBeNull()
  expect(within(details).queryByRole('button', { name: COMPETITOR_COMPARISON_COPY.add })).toBeNull()
})
