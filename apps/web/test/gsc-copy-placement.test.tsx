import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Recharts is irrelevant here and expensive to render; this suite is about
// WHERE explanatory copy lives, not about the chart.
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

// The not-yet-connected state links to Settings, and a real `Link` needs a
// router context this suite has no reason to build.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}))

import { AccountProvider } from '../src/contexts/account-context.js'
import { GscSection, GSC_MANAGED_EMPTY_COPY } from '../src/components/project/GscSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

/**
 * The copy under test lives in THREE different render states, and a test that
 * only ever arranges one of them is unfalsifiable for the other two:
 *
 *   - the data sections render when a connection exists
 *   - the property picker is inside a COLLAPSED "Setup & Configuration"
 *     disclosure, so it is absent until something clicks it open
 *   - the connect-state line renders only with NO connection and NO configured
 *     OAuth app
 *
 * Asserting "this paragraph is gone" against a state that never rendered it
 * passes identically before and after the change.
 */
function renderSection({ connected, googleConfigured = true, viewer = false }: { connected: boolean; googleConfigured?: boolean; viewer?: boolean }) {
  const settingsRead = vi.fn()
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') {
      settingsRead()
      return jsonResponse({
        providers: [], providerCatalog: [],
        google: { configured: googleConfigured }, bing: { configured: false },
      })
    }
    if (path.endsWith('/google/connections')) {
      return jsonResponse(connected
        ? [{
            id: 'gsc-1', domain: 'example.com', connectionType: 'gsc',
            propertyId: 'sc-domain:example.com', sitemapUrl: 'https://example.com/sitemap.xml',
            scopes: [], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
          }]
        : [])
    }
    if (path.includes('/google/properties')) {
      return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    }
    if (path.includes('/google/gsc/performance/daily')) {
      return jsonResponse({
        totals: { clicks: 0, impressions: 0, ctr: 0, position: null, positionDays: 0, days: 0 },
        daily: [],
        trends: { clicks: null, impressions: null, ctr: null, position: null },
      })
    }
    if (path.includes('/google/gsc/performance')) {
      return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: null })
    }
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
    }
    if (path.includes('/google/gsc/inspections')) return jsonResponse([])
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={viewer ? { name: 'analyst', role: 'viewer' } : null}>
        <GscSection projectName="test-project" refreshNonce={0} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { ...result, settingsRead }
}

/**
 * Copy that EXPLAINS, so the rule sends it to a tooltip.
 *
 * `phrase` is anchored on wording common to the OLD paragraph and the NEW
 * tooltip, which is what makes the negative assertion mean anything: the
 * sitemap sentence was reworded on the way into the tooltip ("Google is asked
 * to refetch" -> "Submitting asks Google to refetch"), so a negative written
 * against the new phrasing was already null on `main` and could not have
 * detected the paragraph coming back.
 */
const MOVED = [
  { heading: 'Index coverage', phrase: /Indexing API is intended for eligible JobPosting/ },
  { heading: 'Sitemap operations', phrase: /refetch these sitemaps/ },
] as const

test('explanatory copy is a tooltip trigger, not body prose', async () => {
  renderSection({ connected: true })
  await waitFor(() => expect(screen.queryByText('Index coverage')).not.toBeNull())

  for (const { phrase } of MOVED) {
    expect(screen.queryByText(phrase), `${phrase} must not be body copy`).toBeNull()
    expect(screen.getByRole('button', { name: phrase })).not.toBeNull()
  }
})

test('each tooltip is a SIBLING of its heading, so it stays out of the heading name', async () => {
  // apps/web/AGENTS.md: "an InfoTooltip is placed as a SIBLING of a heading,
  // never a child, or its help text joins the heading's accessible name and
  // any aria-labelledby landmark that points at it."
  renderSection({ connected: true })
  await waitFor(() => expect(screen.queryByText('Index coverage')).not.toBeNull())

  for (const heading of ['Search performance', ...MOVED.map((m) => m.heading)]) {
    const el = screen.getByRole('heading', { name: heading })
    // Exact match: a nested trigger folds its aria-label into the name, so the
    // heading would read as the heading PLUS a paragraph of help text.
    expect(el.textContent?.trim(), `${heading} accessible name`).toBe(heading)
    expect(el.querySelector('button'), `${heading} must not contain the trigger`).toBeNull()
  }
})

test('the property picker moved its explanation too, asserted with the card OPEN', async () => {
  renderSection({ connected: true })
  await waitFor(() => expect(screen.queryByText('Search performance')).not.toBeNull())

  // Prove the disclosure starts closed, so the expansion below is what puts
  // the card on the page and the assertions are not passing on absence.
  expect(screen.queryByText('Pick the Search Console property')).toBeNull()
  fireEvent.click(screen.getByText(/Setup & Configuration/))
  await waitFor(() => expect(screen.queryByText('Pick the Search Console property')).not.toBeNull())

  expect(screen.queryByText(/used for future syncs and URL inspections/)).toBeNull()
  expect(screen.getByRole('button', { name: /used for future syncs and URL inspections/ })).not.toBeNull()
  const heading = screen.getByRole('heading', { name: 'Pick the Search Console property' })
  expect(heading.textContent?.trim()).toBe('Pick the Search Console property')
})

test('the connect-state line stays inline, asserted in the state that renders it', async () => {
  // Onboarding states are exempt from the tooltip rule: this line is the only
  // content of the not-yet-connected card, and the reader needs it where they
  // are looking. It renders ONLY with no connection AND no configured OAuth
  // app, so a connected fixture cannot tell "kept inline" from "not rendered".
  renderSection({ connected: false, googleConfigured: false })
  await waitFor(() => expect(screen.queryByText('Domain authorization')).not.toBeNull())

  expect(screen.getByText(/shared across all projects/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /shared across all projects/ })).toBeNull()
})


test('restricted readers see managed setup without requesting administrator settings', async () => {
  const { container, settingsRead } = renderSection({ connected: false, viewer: true })
  await screen.findByText(GSC_MANAGED_EMPTY_COPY)
  expect(settingsRead).not.toHaveBeenCalled()
  expect(container.querySelector('a[href="/settings"]')).toBeNull()
})
