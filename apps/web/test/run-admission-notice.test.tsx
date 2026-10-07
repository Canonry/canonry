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
import type { ProviderAccountStreak, RunAdmissionDto } from '@ainyc/canonry-contracts'
import { RunAdmissionNotice } from '../src/components/project/RunAdmissionNotice.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'

// The dashboard's notice for a project whose next sweep is refused, or leaves
// out providers that keep failing on their accounts. It renders the API's
// admission as sent: which providers, why, and when each is tried again.

const RETRY = '2026-10-08T09:00:00.000Z'
const OPENAI: ProviderAccountStreak = { code: 'PROVIDER_BILLING', consecutiveRuns: 10, since: '2026-10-01T00:00:00.000Z', latestRunId: 'run-9', retryAfter: RETRY }
const CLAUDE: ProviderAccountStreak = { ...OPENAI, code: 'PROVIDER_AUTH' }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderNotice(admission: RunAdmissionDto, canFix = false) {
  const request = vi.fn(async () => new Response(JSON.stringify(admission), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const rootRoute = createRootRoute({ component: () => <><RunAdmissionNotice projectName="acme" canFix={canFix} /><Outlet /></> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'settings', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const page = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  return { ...page, request }
}

test('reads the run admission and shows nothing while every provider is called', async () => {
  const { request } = await renderNotice({ refused: false, retryAfter: null, providers: {} })
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.pathname).toBe('/api/v1/projects/acme/run-admission')
  expect(screen.queryByRole('status')).toBeNull()
})

test('says sweeps are on hold, with each provider, why, and when one runs', async () => {
  const { container } = await renderNotice({ refused: true, retryAfter: RETRY, providers: { claude: CLAUDE, openai: OPENAI } })
  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('Sweeps are on hold')
  expect(notice.textContent).toContain(`Every provider failed on its account in each of its last 10 runs, so a new sweep would fail the same way. One sweep runs after ${formatSweepInstant(RETRY)}, or as soon as a provider's key, model or endpoint is saved.`)
  expect([...notice.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    `Claude: key rejected or access denied. Tried again after ${formatSweepInstant(RETRY)}.`,
    `OpenAI: out of credit. Tried again after ${formatSweepInstant(RETRY)}.`,
  ])
  expect([...container.querySelectorAll('time')].map(time => time.dateTime)).toEqual([RETRY, RETRY])
  // A viewer cannot fix provider keys, so no settings action.
  expect(screen.queryByRole('link')).toBeNull()
})

test('names a provider left out of sweeps, and offers an administrator the provider settings', async () => {
  await renderNotice({ refused: false, retryAfter: null, providers: { openai: OPENAI } }, true)
  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('OpenAI is left out of sweeps')
  expect(notice.textContent).toContain('It failed on its account in each of its last 10 runs. Sweeps call the other providers and try it again after the time below')
  expect(screen.getByRole('link', { name: 'Open provider settings' }).getAttribute('href')).toBe('/settings')
})
