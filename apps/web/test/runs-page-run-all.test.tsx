import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { AccountProvider, VIEW_ONLY_LABEL, type SignedInAccount } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
})

/** Renders /runs over a project list of `projectCount` and records every run-all request. */
async function renderRuns({ projectCount = 3, account = null }: { projectCount?: number; account?: SignedInAccount | null } = {}) {
  const fixture = createDashboardFixture({})
  fixture.dashboard.projects = fixture.dashboard.projects.slice(0, projectCount)
  const projects = fixture.dashboard.projects.map(entry => entry.project)
  const runAllBodies: unknown[] = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects' && method === 'GET') return jsonResponse(projects)
    if (path === '/api/v1/runs' && method === 'POST') {
      runAllBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return jsonResponse([], 207)
    }
    if (path.startsWith('/api/v1/runs') && method === 'GET') return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/runs'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={account}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { runAllBodies }
}

test.each([
  [3, 'Checks all 3 projects. Each runs its saved queries on its selected engines. Provider charges apply.', 'Run 3 projects'],
  [1, 'Checks 1 project. It runs its saved queries on its selected engines. Provider charges apply.', 'Run 1 project'],
])('Run all projects reviews %i project(s) before anything is queued, and Cancel returns focus', async (projectCount, description, confirm) => {
  const { runAllBodies } = await renderRuns({ projectCount })
  const trigger = await screen.findByRole('button', { name: 'Run all projects' })
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')

  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'Review AI Visibility checks' })
  expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(description)
  expect(within(dialog).getByText('Runs once. Schedules stay unchanged. Projects already running or not set up are skipped.')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: confirm })).toBeTruthy()
  expect(runAllBodies).toEqual([])

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(runAllBodies).toEqual([])
})

test('confirming the review queues every project once, closes it, and returns focus', async () => {
  const { runAllBodies } = await renderRuns()
  const trigger = await screen.findByRole('button', { name: 'Run all projects' })

  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'Review AI Visibility checks' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Run 3 projects' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(runAllBodies).toEqual([{}])
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

test('a view-only account cannot open the review', async () => {
  await renderRuns({ account: { name: 'viewer', role: 'viewer' } })
  const trigger = await screen.findByRole('button', { name: 'Run all projects' }) as HTMLButtonElement

  expect(trigger.disabled).toBe(true)
  expect(trigger.title).toBe(VIEW_ONLY_LABEL)
})

test('with no projects there is nothing to run, so no Run all control', async () => {
  await renderRuns({ projectCount: 0 })

  expect(await screen.findByRole('heading', { name: 'Runs', level: 1 })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Run all projects' })).toBeNull()
})
