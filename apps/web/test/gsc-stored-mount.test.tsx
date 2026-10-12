import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passthrough, ComposedChart: passthrough, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }
})

import { GscSection } from '../src/components/project/GscSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function mountSection({ propertyId = 'sc-domain:example.com', emptySitemaps = false, failedSync = false }: {
  propertyId?: string | null
  emptySitemaps?: boolean
  failedSync?: boolean
} = {}) {
  const requests: string[] = []
  const restore = mockFetch((url) => {
    const path = new URL(url).pathname
    requests.push(path)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connections')) return jsonResponse([{
      id: 'gsc-1', domain: 'example.com', connectionType: 'gsc', propertyId, sitemapUrl: 'https://example.com/sitemap.xml',
      scopes: ['https://www.googleapis.com/auth/webmasters'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    }])
    if (path.endsWith('/runs')) {
      expect(new URL(url).searchParams.get('kind')).toBe('gsc-sync')
      expect(new URL(url).searchParams.get('limit')).toBe('1')
      return jsonResponse(failedSync ? [{ id: 'sync-1', projectId: 'project-1', kind: 'gsc-sync', status: 'failed', trigger: 'manual', createdAt: '2026-10-01T00:00:00.000Z', error: { message: 'Saved authorization failure' } }] : [])
    }
    if (path.endsWith('/google/properties')) return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    if (path.endsWith('/google/gsc/sitemaps')) return jsonResponse({
      sitemaps: emptySitemaps ? [] : [{ path: 'https://example.com/sitemap.xml', isSitemapsIndex: false }],
      summary: { total: emptySitemaps ? 0 : 1, indexes: 0, files: emptySitemaps ? 0 : 1 }, preferredSubmissionUrls: [],
    })
    if (path.endsWith('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.endsWith('/google/gsc/performance')) return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    if (path.endsWith('/google/gsc/coverage')) return jsonResponse(null)
    if (['/inspections', '/deindexed', '/coverage/history'].some(suffix => path.endsWith(suffix))) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  const mounted = render(<QueryClientProvider client={client}><GscSection projectName="sample" refreshNonce={0} /></QueryClientProvider>)
  return { requests, ...mounted, switchProject: (name: string) => mounted.rerender(
    <QueryClientProvider client={client}><GscSection projectName={name} refreshNonce={0} /></QueryClientProvider>,
  ) }
}

test('connected mount reads stored evidence and leaves both resubmit controls disabled until a live load', async () => {
  const { requests } = mountSection()
  await screen.findByRole('heading', { name: 'Search performance' })
  expect(requests.filter(path => path.endsWith('/google/properties') || path.endsWith('/google/gsc/sitemaps'))).toEqual([])
  for (const suffix of ['/performance', '/performance/daily', '/inspections', '/coverage']) {
    expect(requests.some(path => path.endsWith(suffix))).toBe(true)
  }
  for (const name of ['Resubmit all sitemaps', 'Resubmit all files']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Load from Google' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Resubmit all files' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByRole('button', { name: 'Resubmit all sitemaps' }) as HTMLButtonElement).disabled).toBe(false)
  expect(requests.filter(path => path.endsWith('/google/gsc/sitemaps'))).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Reload from Google' })).not.toBeNull()
})

test('opening setup loads properties once and reopening uses the minute cache', async () => {
  const { requests } = mountSection()
  await screen.findByRole('heading', { name: 'Search performance' })
  fireEvent.click(screen.getByRole('button', { name: 'Setup & Configuration' }))
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Property URL' }) as HTMLSelectElement).value).toBe('sc-domain:example.com'))
  fireEvent.click(screen.getByRole('button', { name: 'Setup & Configuration' }))
  fireEvent.click(screen.getByRole('button', { name: 'Setup & Configuration' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh properties' }) as HTMLButtonElement).disabled).toBe(false))
  expect(requests.filter(path => path.endsWith('/google/properties'))).toHaveLength(1)
})

test('a connection awaiting property selection still loads its picker on mount', async () => {
  const { requests } = mountSection({ propertyId: null })
  await screen.findByRole('heading', { name: 'Search performance' })
  expect(requests.filter(path => path.endsWith('/google/properties'))).toHaveLength(1)
  expect(requests.filter(path => path.endsWith('/google/gsc/sitemaps'))).toHaveLength(0)
})

test('an empty sitemap result is reported only after the operator loads it', async () => {
  mountSection({ emptySitemaps: true })
  await screen.findByRole('heading', { name: 'Search performance' })
  expect(screen.queryByText(/No sitemaps found/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load from Google' }))
  await screen.findByText('No sitemaps found in this GSC property. Submit one here to start Google processing it.')
})

test('a saved failed sync remains visible without testing Google access on mount', async () => {
  const { requests } = mountSection({ failedSync: true })
  await screen.findByText(/Saved authorization failure/)
  expect(requests.filter(path => path.endsWith('/google/properties') || path.endsWith('/google/gsc/sitemaps'))).toEqual([])
})

test('switching projects discards the previously loaded live sitemap list', async () => {
  const { requests, switchProject } = mountSection()
  fireEvent.click(await screen.findByRole('button', { name: 'Load from Google' }))
  await screen.findByRole('button', { name: 'Reload from Google' })
  switchProject('second-sample')
  await screen.findByRole('button', { name: 'Load from Google' })
  expect((screen.getByRole('button', { name: 'Resubmit all files' }) as HTMLButtonElement).disabled).toBe(true)
  expect(requests.filter(path => path.endsWith('/google/gsc/sitemaps'))).toHaveLength(1)
})
