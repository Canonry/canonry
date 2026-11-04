import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passthrough, ComposedChart: passthrough, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }
})

import { BingSection, bingPositionChange } from '../src/components/project/BingSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const SITE = 'https://example.com/'
const SYNCED_AT = '2026-11-04T06:12:00.000Z'

const traffic = {
  rows: [
    { date: '2026-10-30', clicks: 10, impressions: 200, ctr: 0.05 },
    { date: '2026-10-31', clicks: 14, impressions: 220, ctr: 14 / 220 },
  ],
  totals: { clicks: 24, impressions: 420, ctr: 24 / 420 },
  window: { startDate: '2026-10-02', endDate: '2026-10-31' },
  latestAvailableDate: '2026-10-31',
  earliestAvailableDate: '2026-07-01',
  trends: { clicks: null, impressions: null, ctr: null },
  periodComparison: {
    days: 30, basis: 'prior-window', comparable: true,
    prior: { startDate: '2026-09-02', endDate: '2026-10-01', clicks: 16, impressions: 400, ctr: 0.04, position: null, source: 'property-daily' },
    trailing: { startDate: '2026-10-02', endDate: '2026-10-31', clicks: 24, impressions: 420, ctr: 24 / 420, position: null, source: 'property-daily' },
    change: { clicks: 0.5, impressions: 0.05, ctr: null, position: null },
    difference: { clicks: 8, impressions: 20, ctr: 0.01714286, position: null },
  },
}

const weeklyTotals = { clicks: 30, impressions: 500, ctr: 0.06, avgImpressionPosition: 7.4, avgClickPosition: null, weeks: 4 }

function listBody(groupBy: string, key: 'query' | 'page', rows: unknown[]) {
  return {
    groupBy, rows: groupBy === 'week' ? [] : rows,
    weekly: groupBy === 'week' ? [{ date: '2026-10-24', ...weeklyTotals, weeks: 1 }] : [],
    totalMatching: rows.length, truncated: false, window: traffic.window, latestAvailableDate: '2026-10-31',
    totals: weeklyTotals,
    comparison: { days: 30, prior: { ...weeklyTotals, avgImpressionPosition: 8 }, difference: { clicks: 4, impressions: 20, ctr: 0.004, avgImpressionPosition: -0.6 } },
    [key === 'query' ? 'unusedKey' : 'unusedPage']: undefined,
  }
}

const snapshot = (kind: string, payload: unknown, status = 'ok', error: string | null = null) => ({ kind, status, payload, error, syncedAt: SYNCED_AT })

function mountBing({ synced = true, liveFails = false, embed = false, sitemapIndex = false, crawlErrors = 0, trafficSplit = false, readsFail = false }: { synced?: boolean; liveFails?: boolean; embed?: boolean; sitemapIndex?: boolean; crawlErrors?: number; trafficSplit?: boolean; readsFail?: boolean } = {}) {
  if (embed) window.__CANONRY_CONFIG__ = { embed: { enabled: true } } as typeof window.__CANONRY_CONFIG__
  const requests: Array<{ method: string; path: string; search: URLSearchParams }> = []
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    requests.push({ method: init?.method ?? 'GET', path, search: parsed.searchParams })
    if (path.endsWith('/bing/status')) return jsonResponse({ connected: true, domain: 'example.com', siteUrl: SITE, createdAt: SYNCED_AT, updatedAt: SYNCED_AT })
    if (path.endsWith('/bing/sync')) return jsonResponse({ id: 'run-1', projectId: 'p1', kind: 'bing-sync', status: 'queued', trigger: 'manual', createdAt: SYNCED_AT })
    if (readsFail && (path.endsWith('/bing/traffic') || path.endsWith('/bing/site') || path.endsWith('/bing/sitemaps'))) {
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'database is locked' } }, 500)
    }
    if (path.endsWith('/bing/traffic') && trafficSplit) {
      // Too little history for the window before: the window's own halves, 15 days each.
      return jsonResponse({ ...traffic, periodComparison: { ...traffic.periodComparison, days: 15, basis: 'split-window' } })
    }
    if (path.endsWith('/bing/traffic')) {
      return jsonResponse(synced ? traffic : { ...traffic, rows: [], totals: { clicks: 0, impressions: 0, ctr: 0 }, window: { startDate: null, endDate: null }, latestAvailableDate: null, earliestAvailableDate: null, periodComparison: null })
    }
    if (path.endsWith('/bing/queries')) return jsonResponse(listBody(parsed.searchParams.get('groupBy') ?? 'query', 'query', synced ? [{ query: 'garage heater', clicks: 6, impressions: 60, ctr: 0.1, avgImpressionPosition: 4.2, avgClickPosition: null, weeks: 3 }] : []))
    if (path.endsWith('/bing/pages')) return jsonResponse(listBody(parsed.searchParams.get('groupBy') ?? 'page', 'page', [{ page: `${SITE}pricing/`, clicks: 2, impressions: 30, ctr: 2 / 30, avgImpressionPosition: 6, avgClickPosition: null, weeks: 2 }]))
    if (path.endsWith('/trends')) return jsonResponse({ project: 'sample', surface: 'index-coverage', window: '30d', startDate: null, endDate: null, groups: [] })
    if (path.endsWith('/bing/keyword-demand')) return jsonResponse({ market: { country: 'us', language: 'en-US' }, rows: [{ query: 'garage heater', country: 'us', language: 'en-US', latestWeek: '2026-10-25', latestImpressions: 510, latestBroadImpressions: 900, avgWeeklyImpressions: 480.4, weeks: 26, syncedAt: SYNCED_AT }], history: [] })
    if (path.endsWith('/bing/coverage')) return jsonResponse({ summary: { total: 3, indexed: 2, notIndexed: 1, unknown: 0, percentage: 66.7 }, lastInspectedAt: SYNCED_AT, indexed: [], notIndexed: [{ id: 'n1', url: `${SITE}old/`, httpCode: 404, inIndex: false, lastCrawledDate: null, inIndexDate: null, inspectedAt: SYNCED_AT }], unknown: [] })
    if (path.endsWith('/bing/inspections')) return jsonResponse([])
    if (path.endsWith('/bing/crawl-stats')) {
      return jsonResponse(crawlErrors > 0
        ? { rows: [{ date: '2026-10-31', crawledPages: 40, inIndex: 2, crawlErrors, inLinks: 9, code2xx: 35, code301: 1, code302: 0, code4xx: 2, code5xx: 0, allOtherCodes: 0, blockedByRobotsTxt: 0, connectionTimeout: 0, containsMalware: 0, dnsFailures: 0 }], window: traffic.window, latestAvailableDate: '2026-10-31' }
        : { rows: [], window: traffic.window, latestAvailableDate: null })
    }
    if (path.endsWith('/bing/sitemaps')) {
      const row = (url: string, extra: Record<string, unknown> = {}) => ({ url: `${SITE}${url}`, parentUrl: null, type: 'Sitemap', status: 'Success', urlCount: 12, fileSize: 0, compressed: false, submittedAt: null, lastCrawledAt: SYNCED_AT, syncedAt: SYNCED_AT, ...extra })
      const list = sitemapIndex
        ? [row('sitemap_index.xml', { type: 'Sitemap Index' }), row('page-sitemap.xml', { parentUrl: `${SITE}sitemap_index.xml` })]
        : [row('sitemap.xml')]
      return jsonResponse(synced ? { syncedAt: SYNCED_AT, sitemaps: list } : { syncedAt: null, sitemaps: [] })
    }
    if (path.endsWith('/bing/site')) {
      return jsonResponse(synced ? { syncedAt: SYNCED_AT, snapshots: [
        snapshot('url-submission-quota', { dailyQuota: 87, monthlyQuota: 2410 }),
        snapshot('blocked-urls', [{ url: `${SITE}old/`, date: '2026-09-02T00:00:00.000Z', daysToExpire: 62, entityType: 'page', requestType: 'full-removal' }, { url: `${SITE}staging/`, date: null, daysToExpire: 17, entityType: 'directory', requestType: 'full-removal' }]),
        snapshot('site-roles', null, 'unauthorized', 'NotAuthorized'),
      ] } : { syncedAt: null, snapshots: [] })
    }
    if (path.endsWith('/bing/query-pages')) {
      return liveFails
        ? jsonResponse({ error: { code: 'PROVIDER_ERROR', message: 'Bing could not read query pages: InvalidParameter' } }, 502)
        : jsonResponse({ query: 'garage heater', rows: [{ date: '2026-10-24', key: `${SITE}pricing/`, clicks: 3, impressions: 40, ctr: 0.075, avgImpressionPosition: 5.5, avgClickPosition: null }] })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><BingSection projectName="sample" refreshNonce={0} /></QueryClientProvider>)
  return { requests }
}

test('the search figures show the API totals and its comparison, position from the weekly read', async () => {
  const { requests } = mountBing()
  expect(await screen.findByRole('button', { name: 'Clicks 24, up 50.0% vs prior 30 days, an improvement' })).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Impressions 420, up 5.0% vs prior 30 days, an improvement' })).not.toBeNull()
  // A smaller position is a better rank, so the API's -0.6 reads as an improvement.
  expect(await screen.findByRole('button', { name: 'Avg position 7.4, down 0.6 vs prior 30 days, an improvement' })).not.toBeNull()
  expect(requests.find((r) => r.path.endsWith('/bing/traffic'))!.search.get('window')).toBe('30d')
  expect(requests.some((r) => r.path.endsWith('/bing/queries') && r.search.get('groupBy') === 'week')).toBe(true)
  // Nothing on mount asks Bing live.
  expect(requests.some((r) => r.path.endsWith('/bing/query-pages') || r.path.endsWith('/bing/page-queries'))).toBe(false)
})

test('each figure keeps its own basis when position was compared over a different period', async () => {
  mountBing({ trafficSplit: true })
  await screen.findByRole('button', { name: 'Avg position 7.4, down 0.6 vs prior 30 days, an improvement' })
  // No shared label: clicks, impressions and CTR name their 15 days, position its 30.
  expect(screen.getAllByText('vs prior 15 days')).toHaveLength(3)
  expect(screen.getByText('vs prior 30 days')).not.toBeNull()
})

test('a shared basis is printed once when every figure used the same period', async () => {
  mountBing()
  await screen.findByRole('button', { name: 'Avg position 7.4, down 0.6 vs prior 30 days, an improvement' })
  expect(screen.getAllByText('vs prior 30 days')).toHaveLength(1)
})

test('a failed load says so instead of claiming there is no data yet', async () => {
  mountBing({ readsFail: true })
  expect(await screen.findByText(/Could not load Bing data:/)).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'No Bing search data yet' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Sync Bing data now' })).toBeNull()
})

test('a row opens on its own stored weeks and asks Bing only on request', async () => {
  const { requests } = mountBing({ liveFails: true })
  fireEvent.click(await screen.findByRole('button', { name: 'Show details for garage heater' }))
  await waitFor(() => expect(requests.some((r) => r.path.endsWith('/bing/queries') && r.search.get('match') === 'exact' && r.search.get('query') === 'garage heater' && r.search.get('groupBy') === 'week')).toBe(true))
  expect(await screen.findByText('By week')).not.toBeNull()
  expect(requests.some((r) => r.path.endsWith('/bing/query-pages'))).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: /Load pages from Bing/ }))
  // The caution label reads "Bing refused this read"; its button is named by the reason.
  expect(await screen.findByRole('button', { name: /InvalidParameter.*Nothing was stored/ })).not.toBeNull()
  expect(screen.getByText('Bing refused this read')).not.toBeNull()
  expect(requests.filter((r) => r.path.endsWith('/bing/query-pages'))).toHaveLength(1)
  expect(screen.getByRole('button', { name: /Retry/ })).not.toBeNull()
})

test('a loaded drill-down lists Bing rows as sent', async () => {
  mountBing()
  fireEvent.click(await screen.findByRole('button', { name: 'Show details for garage heater' }))
  fireEvent.click(await screen.findByRole('button', { name: /Load pages from Bing/ }))
  expect(await screen.findByText('from Bing, by week')).not.toBeNull()
  expect(screen.getAllByTitle(`${SITE}pricing/`).length).toBeGreaterThan(0)
})

test('before the first sync the tab offers a sync and keeps index coverage', async () => {
  const { requests } = mountBing({ synced: false })
  const button = await screen.findByRole('button', { name: 'Sync Bing data now' })
  expect(screen.getByRole('heading', { name: 'No Bing search data yet' })).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'Index and crawl' })).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Search performance' })).toBeNull()
  fireEvent.click(button)
  await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/bing/sync'))).toBe(true))
  expect(await screen.findByRole('button', { name: 'Sync running…' })).not.toBeNull()
})

test('site settings list one value per setting and open a setting to its rows', async () => {
  mountBing()
  expect(await screen.findByText('2 blocked URLs')).not.toBeNull()
  expect(screen.getByRole('button', { name: /Bing is keeping 2 URLs out of its results/ })).not.toBeNull()
  const settings = within(await screen.findByRole('list', { name: 'Bing site settings' }))
  await waitFor(() => expect(settings.getByText('Owner key needed')).not.toBeNull())
  expect(settings.getByRole('button', { name: /only to the site owner key/ })).not.toBeNull()
  expect(settings.getByText('87 today \u00b7 2,410 this month')).not.toBeNull()
  // A setting the last sync never read shows a dash, not a zero.
  expect(settings.getAllByText('\u2014').length).toBeGreaterThan(0)
  // Each setting is a list item; a disclosure sits inside one, never as one.
  for (const item of settings.getAllByRole('listitem')) expect(item.tagName).toBe('DIV')
  const blocked = settings.getByText('Blocked URLs').closest('details') as HTMLDetailsElement
  expect(within(blocked).getByText('2')).not.toBeNull()
  expect(within(blocked).queryByText('Full removal')).toBeNull()
  blocked.open = true
  blocked.dispatchEvent(new Event('toggle'))
  await waitFor(() => expect(within(blocked).getAllByText('Full removal')).toHaveLength(2))
  expect(within(blocked).getByText('Sep 2, 2026')).not.toBeNull()
})

test('a sitemap index starts closed and opens on its sitemaps', async () => {
  mountBing({ sitemapIndex: true })
  const toggle = await screen.findByRole('button', { name: 'Show the sitemaps in /sitemap_index.xml' })
  expect(screen.getByText('Index \u00b7 1 sitemap')).not.toBeNull()
  expect(screen.queryByTitle(`${SITE}page-sitemap.xml`)).toBeNull()
  fireEvent.click(toggle)
  expect(await screen.findByTitle(`${SITE}page-sitemap.xml`)).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Hide the sitemaps in /sitemap_index.xml' })).not.toBeNull()
})

test('crawl figures live in Crawl by day, with errors flagged on the card', async () => {
  mountBing({ crawlErrors: 3 })
  expect(await screen.findByText('3 crawl errors')).not.toBeNull()
  expect(screen.getByRole('button', { name: /Bingbot got errors from 3 URLs on Oct 31, 2026/ })).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Crawl by day' }))
  const day = (await screen.findByText('Oct 31, 2026', { selector: 'td' })).closest('tr') as HTMLElement
  expect(within(day).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Oct 31, 2026', '40', '3', '2', '35', '1', '0', '2', '0', '0', '0', '0', '0', '0', '9'])
})

test('an embed shows the stored data with no live reads or writes', async () => {
  mountBing({ embed: true })
  fireEvent.click(await screen.findByRole('button', { name: 'Show details for garage heater' }))
  expect(await screen.findByText('Not available here.')).not.toBeNull()
  expect(screen.queryByRole('button', { name: /Load pages from Bing/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Submit all to Bing' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Inspect URLs' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
})

test('the position change follows the API difference, and says when there is none', () => {
  expect(bingPositionChange(null)).toEqual({ kind: 'note', text: 'No comparison period' })
  const base = { days: 30, prior: weeklyTotals, difference: { clicks: 0, impressions: 0, ctr: 0, avgImpressionPosition: 1.25 } }
  expect(bingPositionChange(base)).toEqual({ kind: 'delta', amount: '1.3', direction: 'up', tone: 'worse', basis: 'vs prior 30 days' })
  expect(bingPositionChange({ ...base, difference: { ...base.difference, avgImpressionPosition: 0 } })).toMatchObject({ direction: 'flat', tone: 'neutral' })
  expect(bingPositionChange({ ...base, difference: { ...base.difference, avgImpressionPosition: null } })).toEqual({ kind: 'note', text: 'No position in the prior 30 days' })
})
