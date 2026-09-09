import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passthrough, ComposedChart: passthrough, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }
})

import { GscSection } from '../src/components/project/GscSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('public demo reads stored Google evidence without configuration or live sitemap requests', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const requests: string[] = []
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    requests.push(path)
    if (path.endsWith('/google/connections')) return jsonResponse([{
      id: 'gsc-1', domain: 'example.com', connectionType: 'gsc', propertyId: 'sc-domain:example.com', sitemapUrl: 'https://example.com/sitemap.xml',
      scopes: [], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    }])
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({
      totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 4, positionDays: 1, days: 1 }, daily: [], trends: { clicks: null, impressions: null, ctr: null, position: null },
      window: { startDate: '2026-07-24', endDate: '2026-07-24', latestDataDate: '2026-07-24', daysSinceLatestData: 1 },
    })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: '2026-07-24' })
    if (path.includes('/google/gsc/inspections')) return jsonResponse([])
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={{ id: 'demo', scopes: ['read'], projectId: null, readOnly: true }}>
        <GscSection projectName="test-project" refreshNonce={0} />
      </AccountProvider>
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Search performance' })).not.toBeNull())
  expect(requests).not.toContain('/api/v1/settings')
  expect(requests.some((path) => path.includes('/google/properties'))).toBe(false)
  expect(requests.some((path) => path.includes('/google/gsc/sitemaps'))).toBe(false)
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reload from Google' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Submit sitemap to Google' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Inspect URL' })).toBeNull()
  expect(screen.queryByText('Setup & Configuration')).toBeNull()
})
