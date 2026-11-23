import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { getApiV1ProjectsByNameTrafficSourcesQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

beforeAll(preloadAllLazyRoutes, 60_000)
afterEach(cleanup)

const sources = [
  { id: 'origin', displayName: 'Origin logs', status: 'paused' },
  { id: 'edge', displayName: 'Edge logs', status: 'connected' },
].map(source => ({ ...source, sourceType: 'cloudflare', lastSyncedAt: null, lastError: null }))

async function openTab(state: 'configured' | 'empty' | 'error', viewer = false) {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!.project
  const traffic = `/api/v1/projects/${encodeURIComponent(project.name)}/traffic`
  onTestFinished(mockFetch(url => {
    const { pathname, searchParams } = new URL(url, 'http://localhost')
    if (pathname === traffic + '/sources') return state === 'error'
      ? jsonResponse({ error: { message: 'Traffic sources temporarily unavailable' } }, 503)
      : jsonResponse({ sources: state === 'empty' ? [] : sources })
    const source = sources.find(item => pathname === traffic + '/sources/' + item.id
      || (pathname === traffic + '/events' && searchParams.get('sourceId') === item.id))
    if (source) {
      const content = source.id === 'edge' ? 137 : 246
      const totals = {
        crawlerHits: content, crawlerContentHits: content, crawlerInfraHits: 0,
        crawlerSegments: { content, sitemap: 0, robots: 0, asset: 0, other: 0 },
        aiUserFetchHits: 0, aiUserFetchLikelyFakeHits: 0, aiReferralHits: 0,
        aiReferralLandedHits: 0, aiReferralRedirectedHits: 0, sampleCount: 0,
      }
      return pathname.endsWith('/events')
        ? jsonResponse({ series: { points: [] }, totals, eventRows: { total: 0, returned: 0, truncated: false }, events: [] })
        : jsonResponse({ ...source, totals24h: totals, latestRun: null })
    }
    return jsonResponse({ error: { message: 'Unavailable' } }, 503)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (state === 'configured') {
    // An operator can connect sources outside the browser between tab visits.
    const key = getApiV1ProjectsByNameTrafficSourcesQueryKey({ client: heyClient, path: { name: project.name } })
    client.setQueryData(key, { sources: [] }, { updatedAt: 1 })
  }
  onTestFinished(() => client.clear())
  const router = createAppRouter(client, { initialEntries: [`/projects/${encodeURIComponent(project.name)}/history`] })
  await router.load()
  render(<AccountProvider account={viewer ? { name: 'Client', role: 'viewer' } : null}>
    <QueryClientProvider client={client}><DashboardProvider value={fixture}>
      <RouterProvider router={router} />
    </DashboardProvider></QueryClientProvider>
  </AccountProvider>)
  fireEvent.click(within(await screen.findByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Server traffic' }))
}

test('opening Server traffic shows detailed activity and switching sources changes its events', async () => {
  await openTab('configured')
  expect(await screen.findByText(/^137 content crawls ·/)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: /source/i }), { target: { value: 'origin' } })
  expect(await screen.findByText(/^246 content crawls ·/)).toBeTruthy()
})

test('a project without sources opens setup and lets the operator dismiss it', async () => {
  await openTab('empty')
  const dialog = await screen.findByRole('dialog', { name: 'Connect a traffic source' })
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('button', { name: /connect a source/i })).toBeTruthy()
})

test('a viewer sees the empty state without a setup prompt', async () => {
  await openTab('empty', true)
  expect(await screen.findByText(/no traffic sources connected/i)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /connect a source/i })).toBeNull()
})

test('a failed source read reports the failure without opening setup', async () => {
  await openTab('error')
  const section = await screen.findByRole('region', { name: 'Server traffic' })
  expect((await within(section).findByRole('alert')).textContent).toContain('Could not load traffic sources')
  expect(screen.queryByRole('dialog')).toBeNull()
})
