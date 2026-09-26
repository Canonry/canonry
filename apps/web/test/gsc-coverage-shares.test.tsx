import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { GscCoverageSummaryDto } from '@ainyc/canonry-contracts'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
  }
})

import { GscSection } from '../src/components/project/GscSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

function inspection(url: string, indexingState: string) {
  return { id: url, url, indexingState, coverageState: null, richResults: [], referringUrls: [], inspectedAt: '2026-07-25T00:00:00.000Z' }
}

/**
 * Three of four pages indexed, but shares the counts could never produce: a
 * donut that divided the counts itself would print 75.0%, so these prove the
 * section draws and prints the server's own fractions.
 */
const COVERAGE: GscCoverageSummaryDto = {
  summary: { total: 4, indexed: 3, notIndexed: 1, deindexed: 0, percentage: 75, indexedShare: 0.9996, notIndexedShare: 0.0004 },
  lastInspectedAt: '2026-07-25T00:00:00.000Z',
  lastSyncedAt: '2026-07-25T00:00:00.000Z',
  indexed: [
    inspection('https://example.com/a', 'INDEXING_ALLOWED'),
    inspection('https://example.com/b', 'INDEXING_ALLOWED'),
    inspection('https://example.com/c', 'INDEXING_ALLOWED'),
  ],
  notIndexed: [inspection('https://example.com/d', 'BLOCKED')],
  deindexed: [],
  reasonGroups: [],
}

function renderSection(coverage: GscCoverageSummaryDto) {
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connections')) return jsonResponse([{
      id: 'gsc-1',
      domain: 'example.com',
      connectionType: 'gsc',
      propertyId: 'sc-domain:example.com',
      sitemapUrl: 'https://example.com/sitemap.xml',
      scopes: ['https://www.googleapis.com/auth/webmasters'],
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }])
    if (path.includes('/google/properties')) return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.includes('/google/gsc/inspections') || path.includes('/google/gsc/deindexed') || path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(coverage)
    if (path.includes('/google/gsc/sitemaps')) return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)
}

test('the coverage donut prints and draws the server shares, never the counts divided here', async () => {
  const { container } = renderSection(COVERAGE)

  // formatPercent(0.9996): a near-complete share keeps its >99.9% edge.
  await waitFor(() => expect(screen.getByText('>99.9%')).toBeTruthy())
  expect(screen.queryByText('75.0%')).toBeNull()

  // The not-indexed arc is the server's notIndexedShare of the ring.
  const ring = 2 * Math.PI * 54
  const arcs = [...container.querySelectorAll('svg circle')]
  const notIndexedArc = arcs.find(circle => (circle.getAttribute('stroke-dasharray') ?? '').includes(' '))
  expect(notIndexedArc?.getAttribute('stroke-dasharray')).toBe(`${ring * 0.0004} ${ring - ring * 0.0004}`)
  // And the indexed arc leaves exactly the rest of the ring uncovered.
  const indexedArc = arcs.find(circle => circle.getAttribute('stroke-dashoffset') === String(ring * (1 - 0.9996)))
  expect(indexedArc).toBeTruthy()
})
