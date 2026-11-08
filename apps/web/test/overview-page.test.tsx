import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
})

const projectsKey = getApiV1ProjectsQueryKey({ client: heyClient })

/**
 * Opens Overview with a project list the server cannot load. Counts its reads,
 * and can hold them in flight so the retrying state is observable.
 */
async function renderUnavailableOverview() {
  let projectReads = 0
  let holding = false
  const held: Array<() => void> = []
  const failure = () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Database unavailable' } }, 503)
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects') {
      projectReads += 1
      return holding ? new Promise<Response>(resolve => { held.push(() => resolve(failure())) }) : failure()
    }
    if (path.startsWith('/api/v1/runs')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return {
    queryClient,
    projectReads: () => projectReads,
    holdReads: () => { holding = true },
    releaseReads: () => { holding = false; held.splice(0).forEach(release => release()) },
  }
}

// The failure keeps the destination's one name, the sidebar link's.
test('when the project list cannot load, the page is named Overview and offers a retry', async () => {
  await renderUnavailableOverview()

  expect(await screen.findByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(screen.getByText('Canonry could not load the project list.')).toBeTruthy()
  expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry loading projects' })).toBeTruthy()
  const sidebar = screen.getByRole('complementary', { name: 'Primary navigation' })
  expect(within(sidebar).getByRole('link', { name: 'Overview', exact: true }).getAttribute('href')).toBe('/')
})

// A failed read retries through `pending`. The shell used to swap the page for
// its skeleton then, and the page's remount retried at once: thousands of
// reads a second, with the failure never on screen.
test('a failed project list is read a bounded number of times, not in a loop', async () => {
  const { projectReads } = await renderUnavailableOverview()

  await screen.findByRole('heading', { level: 1, name: 'Overview unavailable' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  // The route's check and the shell's and page's mounts read it three times;
  // the slack allows a 2s poll on a slow run. The loop read it thousands.
  expect(projectReads()).toBeLessThan(10)
})

test('Retry keeps the failure and focus in place while the read is retried', async () => {
  const { queryClient, projectReads, holdReads, releaseReads } = await renderUnavailableOverview()
  const retry = await screen.findByRole('button', { name: 'Retry loading projects' })
  await waitFor(() => expect(queryClient.getQueryState(projectsKey)?.fetchStatus).toBe('idle'))
  const readsBefore = projectReads()

  holdReads()
  retry.focus()
  fireEvent.click(retry)
  await waitFor(() => expect(projectReads()).toBeGreaterThan(readsBefore))
  // The query drops its error while the retry is in flight.
  expect(queryClient.getQueryState(projectsKey)?.status).toBe('pending')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(screen.getByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(document.activeElement).toBe(retry)

  releaseReads()
  await waitFor(() => expect(queryClient.getQueryState(projectsKey)?.status).toBe('error'))
  expect(screen.getByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(document.activeElement).toBe(retry)
})
