import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
import type { ApiGscPerformanceRow } from '../src/api.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

function performanceRows(count: number, start = 0): ApiGscPerformanceRow[] {
  return Array.from({ length: count }, (_, index) => {
    const row = start + index
    return {
      date: '2026-07-25',
      query: `search query ${String(row).padStart(3, '0')}`,
      page: `https://example.com/page-${String(row).padStart(3, '0')}`,
      clicks: count - index,
      impressions: count * 10 - index,
      ctr: 0.1,
      position: 2.5,
    }
  })
}

function renderSection() {
  const expandedRows = performanceRows(60)
  const pagedRows = performanceRows(31)
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [],
        providerCatalog: [],
        google: { configured: true },
        bing: { configured: false },
      })
    }
    if (path.endsWith('/google/connections')) {
      return jsonResponse([{
        id: 'gsc-1',
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        sitemapUrl: 'https://example.com/sitemap.xml',
        scopes: [],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }])
    }
    if (path.includes('/google/properties')) {
      return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    }
    if (path.includes('/google/gsc/performance/daily')) {
      // Mirrors the real response shape, `window` included — the endpoint
      // always returns it, and a mock that omits a field the component reads
      // is a mock that cannot catch a crash on it.
      return jsonResponse({
        totals: { clicks: 0, impressions: 0, ctr: 0, days: 0 },
        daily: [],
        window: { startDate: null, endDate: null, latestDataDate: null, daysSinceLatestData: null },
      })
    }
    if (path.includes('/google/gsc/performance')) {
      const query = new URL(url).searchParams
      // The route returns a page envelope: `totalMatching` is the COUNT over
      // the same WHERE, which is what drives "has next page" now.
      if (query.get('limit') === '500') {
        return jsonResponse({
          rows: expandedRows,
          totalMatching: expandedRows.length,
          truncated: false,
          latestAvailableDate: '2026-07-25',
        })
      }
      const offset = Number(query.get('offset') ?? 0)
      // Honour the requested limit. Hardcoding a page size here let the mock
      // return more rows than the component asked for, which is exactly the
      // over-fetch the component no longer does.
      const limit = Number(query.get('limit') ?? 25)
      const rows = pagedRows.slice(offset, offset + limit)
      return jsonResponse({
        rows,
        totalMatching: pagedRows.length,
        truncated: offset + rows.length < pagedRows.length,
        latestAvailableDate: '2026-07-25',
      })
    }
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({
        sitemaps: [],
        summary: { total: 0, indexes: 0, files: 0 },
        preferredSubmissionUrls: [],
      })
    }
    if (path.includes('/google/gsc/inspections')) return jsonResponse([])
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GscSection projectName="test-project" refreshNonce={0} />
    </QueryClientProvider>,
  )
}

test('uses server pagination when unfiltered and client pagination for expanded results', async () => {
  renderSection()

  await waitFor(() => expect(screen.getByText('1 to 25+ rows')).not.toBeNull())
  expect(screen.getByText('search query 000')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('26 to 31 rows')).not.toBeNull())
  expect(screen.getByText('search query 025')).not.toBeNull()
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter search queries' }), {
    target: { value: 'search' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

  await waitFor(() => expect(screen.getByText('1 to 25 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 024')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('26 to 50 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 025')).not.toBeNull()
  expect(screen.queryByText('search query 024')).toBeNull()

  const performancePeriod = screen.getByRole('group', { name: 'Search Console time period' })
  expect(within(performancePeriod).getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(within(performancePeriod).getByRole('button', { name: '7d' }))
  expect(within(performancePeriod).getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe('true')
  await waitFor(() => expect(screen.getByText('1 to 25 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 000')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()
})

function renderSitemapSection({
  sitemaps,
  preferredSubmissionUrls = [],
  childrenByIndex = {},
  onSubmit,
}: {
  sitemaps: Array<Record<string, unknown>>
  preferredSubmissionUrls?: string[]
  childrenByIndex?: Record<string, Array<Record<string, unknown>>>
  onSubmit: (urls: string[], attempt: number) => Response | Promise<Response>
}) {
  let submitAttempt = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connections')) return jsonResponse([{
      id: 'gsc-1', domain: 'example.com', connectionType: 'gsc', propertyId: 'sc-domain:example.com', sitemapUrl: 'https://example.com/sitemap.xml',
      scopes: ['https://www.googleapis.com/auth/webmasters'], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    }])
    if (path.includes('/google/properties')) return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.includes('/google/gsc/inspections') || path.includes('/google/gsc/deindexed') || path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    if (path.includes('/google/gsc/sitemaps/submit')) {
      const urls = JSON.parse(String(init?.body)).sitemapUrls as string[]
      submitAttempt += 1
      return onSubmit(urls, submitAttempt)
    }
    if (path.includes('/google/gsc/sitemaps')) {
      const sitemapIndex = new URL(url).searchParams.get('sitemapIndex')
      return jsonResponse({
        sitemaps: sitemapIndex ? (childrenByIndex[sitemapIndex] ?? []) : sitemaps,
        summary: { total: sitemaps.length, indexes: sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).length, files: sitemaps.filter((sitemap) => !sitemap.isSitemapsIndex).length },
        preferredSubmissionUrls,
      })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)
}

test('reports completed batches and stops after a later sitemap submission transport failure', async () => {
  const sitemaps = Array.from({ length: 100 }, (_, index) => ({ path: `https://example.com/sitemap-${index}.xml`, isSitemapsIndex: false }))
  const submitted: string[][] = []
  renderSitemapSection({
    sitemaps,
    preferredSubmissionUrls: sitemaps.map((sitemap) => String(sitemap.path)),
    onSubmit: (urls, attempt) => {
      submitted.push(urls)
      if (attempt === 2) return Promise.reject(new Error('network down'))
      return jsonResponse({ summary: { total: urls.length, accepted: urls.length, failed: 0 }, results: [] })
    },
  })

  await waitFor(() => expect(screen.getByRole('button', { name: 'Resubmit all sitemaps' })).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Resubmit all sitemaps' }))
  await waitFor(() => expect(screen.getByText(/50 accepted, 0 failed, 50 unconfirmed, 0 not attempted/i)).not.toBeNull())
  expect(submitted).toHaveLength(2)
  expect(submitted).toEqual([expect.any(Array), expect.any(Array)])
})

test('resubmit all files excludes a parent index and includes standalone and child sitemap files', async () => {
  const index = 'https://example.com/sitemap-index.xml'
  const standalone = 'https://example.com/sitemap.xml'
  const child = 'https://example.com/posts.xml'
  const submitted: string[][] = []
  renderSitemapSection({
    sitemaps: [{ path: index, isSitemapsIndex: true }, { path: standalone, isSitemapsIndex: false }],
    childrenByIndex: { [index]: [{ path: child, isSitemapsIndex: false }] },
    onSubmit: (urls) => {
      submitted.push(urls)
      return jsonResponse({ summary: { total: urls.length, accepted: urls.length, failed: 0 }, results: [] })
    },
  })

  await waitFor(() => expect(screen.getByRole('button', { name: 'Resubmit all files' })).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Resubmit all files' }))
  await waitFor(() => expect(submitted).toHaveLength(1))
  expect(submitted[0]).toEqual(expect.arrayContaining([standalone, child]))
  expect(submitted[0]).not.toContain(index)
})

test('refreshes the cached OAuth connection immediately after popup authorization', async () => {
  let fullScopeGranted = false
  let connectionReads = 0
  const sitemapUrl = 'https://example.com/sitemap.xml'
  const popup = { closed: false } as unknown as Window
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup)
  onTestFinished(() => openSpy.mockRestore())

  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connect')) {
      return jsonResponse({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
        redirectUri: 'http://localhost:4100/api/v1/google/callback',
      })
    }
    if (path.endsWith('/google/connections')) {
      connectionReads += 1
      return jsonResponse([{
        id: 'gsc-1',
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        sitemapUrl,
        scopes: [fullScopeGranted
          ? 'https://www.googleapis.com/auth/webmasters'
          : 'https://www.googleapis.com/auth/webmasters.readonly'],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }])
    }
    if (path.includes('/google/properties')) return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.includes('/google/gsc/inspections') || path.includes('/google/gsc/deindexed') || path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({
        sitemaps: [{ path: sitemapUrl, isSitemapsIndex: false }],
        summary: { total: 1, indexes: 0, files: 1 },
        preferredSubmissionUrls: [sitemapUrl],
      })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)

  await waitFor(() => expect(screen.getByText(/current Canonry OAuth grant is read-only/i)).not.toBeNull())
  expect(screen.getByText('Default sitemap')).not.toBeNull()
  expect(screen.queryByText('Use for audits')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await waitFor(() => expect(openSpy).toHaveBeenCalledOnce())

  fullScopeGranted = true
  fireEvent(window, new MessageEvent('message', {
    origin: 'http://localhost:4100',
    source: popup,
    data: {
      type: 'canonry:google-oauth-complete',
      connectionType: 'gsc',
    },
  }))

  await waitFor(() => expect(screen.queryByText(/current Canonry OAuth grant is read-only/i)).toBeNull())
  expect(connectionReads).toBeGreaterThanOrEqual(2)
})

test('manual GSC refresh actions bypass the one-minute query cache', async () => {
  let propertyReads = 0
  let inspectionReads = 0
  let coverageReads = 0
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
    if (path.includes('/google/properties')) {
      propertyReads += 1
      return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    }
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.includes('/google/gsc/inspections')) {
      inspectionReads += 1
      return jsonResponse([])
    }
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) {
      coverageReads += 1
      return jsonResponse(null)
    }
    if (path.includes('/google/gsc/sitemaps')) return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)

  await waitFor(() => {
    expect(propertyReads).toBe(1)
    expect(inspectionReads).toBe(1)
    expect(coverageReads).toBe(1)
  })

  fireEvent.click(screen.getByRole('button', { name: 'Setup & Configuration' }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh properties' }))
  await waitFor(() => expect(propertyReads).toBe(2))

  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
  await waitFor(() => expect(inspectionReads).toBe(2))

  fireEvent.click(screen.getByRole('button', { name: 'Reload saved coverage' }))
  await waitFor(() => expect(coverageReads).toBe(2))
})

test('connection-owned sitemap changes stay fresh after a remount', async () => {
  const oldSitemap = 'https://example.com/old-sitemap.xml'
  const newSitemap = 'https://example.com/new-sitemap.xml'
  let savedSitemap = oldSitemap
  let connectionReads = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connections')) {
      connectionReads += 1
      return jsonResponse([{
        id: 'gsc-1',
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        sitemapUrl: savedSitemap,
        scopes: ['https://www.googleapis.com/auth/webmasters'],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }])
    }
    if (path.endsWith('/google/connections/gsc/sitemap') && init?.method === 'PUT') {
      savedSitemap = (JSON.parse(String(init.body)) as { sitemapUrl: string }).sitemapUrl
      return jsonResponse({ sitemapUrl: savedSitemap })
    }
    if (path.includes('/google/properties')) return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.includes('/google/gsc/inspections') || path.includes('/google/gsc/deindexed') || path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    if (path.includes('/google/gsc/sitemaps')) return jsonResponse({
      sitemaps: [
        { path: oldSitemap, isSitemapsIndex: false },
        { path: newSitemap, isSitemapsIndex: false },
      ],
      summary: { total: 2, indexes: 0, files: 2 },
      preferredSubmissionUrls: [oldSitemap, newSitemap],
    })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const firstRender = render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)

  const newSitemapRow = await screen.findByText(newSitemap).then((cell) => cell.closest('tr'))
  if (!newSitemapRow) throw new Error('New sitemap row was not rendered')
  fireEvent.click(within(newSitemapRow).getByRole('button', { name: 'Set as default' }))
  await waitFor(() => expect(within(newSitemapRow).getByText('Default sitemap')).not.toBeNull())

  firstRender.unmount()
  render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)

  await waitFor(() => expect(connectionReads).toBeGreaterThanOrEqual(2))
  const remountedRow = await screen.findByText(newSitemap).then((cell) => cell.closest('tr'))
  if (!remountedRow) throw new Error('New sitemap row was not rendered after remount')
  expect(within(remountedRow).getByText('Default sitemap')).not.toBeNull()
})
