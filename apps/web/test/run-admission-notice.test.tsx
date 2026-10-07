import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { ProviderAccountStreak } from '@ainyc/canonry-contracts'
import { RunAdmissionNoticeView, useRunAdmission } from '../src/components/project/RunAdmissionNotice.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'

// The dashboard's notice for a project whose next sweep is refused, or leaves
// out providers that keep failing on their accounts. It renders the API's
// admission as sent: which providers, why, and until when.

const RETRY = '2026-10-08T09:00:00.000Z'
const LATER = '2026-10-08T11:00:00.000Z'
const AUTH: ProviderAccountStreak = { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: '2026-10-01T00:00:00.000Z', latestRunId: 'run-9', retryAfter: RETRY }
const BILLING: ProviderAccountStreak = { ...AUTH, code: 'PROVIDER_BILLING', retryAfter: LATER }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render `node` inside a router (the settings action is a router link) and a query client. */
async function renderInApp(node: () => React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const rootRoute = createRootRoute({ component: () => <>{node()}<Outlet /></> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'settings', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return client
}

const notice = (name: string) => screen.getByRole('region', { name })

test('the project page reads the run admission of its own project', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ refused: false, retryAfter: null, providers: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  function Probe() {
    const admission = useRunAdmission('acme', true).data
    return admission ? <RunAdmissionNoticeView admission={admission} canFix /> : null
  }
  const client = await renderInApp(() => <Probe />)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(new URL((request.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe('/api/v1/projects/acme/run-admission')
  // Every provider is called: nothing to say.
  expect(screen.queryByRole('region')).toBeNull()
})

test('a refused sweep says when the hold lifts and links an administrator to the rejected key', async () => {
  await renderInApp(() => <RunAdmissionNoticeView admission={{ refused: true, retryAfter: RETRY, providers: { openai: AUTH } }} canFix />)
  const region = notice('Sweeps are on hold')
  expect(region.querySelector('p')?.textContent).toBe(
    `OpenAI's key was rejected or access was denied in each of its last 10 runs, so a sweep would fail the same way. `
    + `The hold lifts ${formatSweepInstant(RETRY)}, or as soon as its key, model or endpoint is saved.`,
  )
  expect(region.querySelector('time')?.dateTime).toBe(RETRY)
  expect(screen.getByRole('link', { name: 'Update OpenAI key' }).getAttribute('href')).toBe('/settings#provider-openai')
})

test('several providers left out are listed with their own reasons and times, and a viewer is told who can fix them', async () => {
  await renderInApp(() => <RunAdmissionNoticeView admission={{ refused: false, retryAfter: null, providers: { claude: BILLING, openai: AUTH } }} canFix={false} />)
  const region = notice('2 providers are left out of sweeps')
  expect([...region.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    `Claude: out of credit, until ${formatSweepInstant(LATER)}`,
    `OpenAI: key rejected or access denied, until ${formatSweepInstant(RETRY)}`,
  ])
  expect(region.textContent).toContain('Ask an administrator to fix these providers.')
  expect(screen.queryByRole('link')).toBeNull()
})

test('a provider out of credit is fixed in its own console, so there is no settings action', async () => {
  await renderInApp(() => <RunAdmissionNoticeView admission={{ refused: false, retryAfter: null, providers: { claude: BILLING } }} canFix />)
  const region = notice('Claude is left out of sweeps')
  expect(region.querySelector('p')?.textContent).toBe(
    `It ran out of credit in each of its last 10 runs. Sweeps run without it until ${formatSweepInstant(LATER)}; add credit in Claude's console before then.`,
  )
  expect(screen.queryByRole('link')).toBeNull()
})
