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

function mountSection({ propertyId = 'sc-domain:example.com', sitemapList = 'listed', failedSync = false }: {
  propertyId?: string | null
  /** Google's stored list: some sitemaps, none, or never read. */
  sitemapList?: 'listed' | 'empty' | 'unread'
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
    if (path.endsWith('/google/gsc/sitemaps')) throw new Error('the sitemap card reads the stored list, never the live one')
    if (path.endsWith('/sitemaps')) return jsonResponse({
      site: { scannedAt: null, runId: null, sitemaps: [] },
      google: sitemapList === 'unread' ? null : {
        syncedAt: '2026-11-04T06:00:00.000Z',
        sitemaps: sitemapList === 'empty' ? [] : [{ url: `https://${path.split('/')[4]}.example.com/sitemap.xml`, parentUrl: null, isIndex: false, type: 'sitemap', state: 'ok', statusLabel: 'Success', warnings: 0, errors: 0, urlCount: 3, submittedAt: '2026-10-01T00:00:00.000Z', lastReadAt: null }],
        missing: [],
      },
      bing: null,
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

test('connected mount reads the stored sitemap list, never Google live', async () => {
  const { requests } = mountSection()
  await screen.findByRole('heading', { name: 'Search performance' })
  expect(requests.filter(path => path.endsWith('/google/properties') || path.endsWith('/google/gsc/sitemaps'))).toEqual([])
  for (const suffix of ['/performance', '/performance/daily', '/inspections', '/coverage', '/projects/sample/sitemaps']) {
    expect(requests.some(path => path.endsWith(suffix))).toBe(true)
  }
  expect(await screen.findByTitle('https://sample.example.com/sitemap.xml')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Resubmit all' }))
  expect((screen.getByRole('menuitem', { name: /^Resubmit all files/ }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('menuitem', { name: /^Resubmit all sitemaps/ }) as HTMLButtonElement).disabled).toBe(false)
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

test('an empty stored list reads as none, and an unread one says when it arrives', async () => {
  mountSection({ sitemapList: 'empty' })
  expect(await screen.findByText('Google lists no sitemaps for this site, and Canonry found none to add.')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Resubmit all' })).toBeNull()
  cleanup()
  mountSection({ sitemapList: 'unread' })
  expect(await screen.findByText(/Google's sitemap list arrives with the next Google sync/)).not.toBeNull()
})

test('a saved failed sync remains visible without testing Google access on mount', async () => {
  const { requests } = mountSection({ failedSync: true })
  await screen.findByText(/Saved authorization failure/)
  expect(requests.filter(path => path.endsWith('/google/properties') || path.endsWith('/google/gsc/sitemaps'))).toEqual([])
})

test('switching projects reads the other project\'s stored list', async () => {
  const { requests, switchProject } = mountSection()
  expect(await screen.findByTitle('https://sample.example.com/sitemap.xml')).not.toBeNull()
  switchProject('second-sample')
  expect(await screen.findByTitle('https://second-sample.example.com/sitemap.xml')).not.toBeNull()
  expect(screen.queryByTitle('https://sample.example.com/sitemap.xml')).toBeNull()
  expect(requests.filter(path => path.endsWith('/sitemaps'))).toEqual(['/api/v1/projects/sample/sitemaps', '/api/v1/projects/second-sample/sitemaps'])
})
