import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Recharts needs a sized container (jsdom has none); stub it like the other
// chart-bearing section tests so we assert on the textual layer, not the SVG.
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    BarChart: passthrough,
    Bar: () => null,
    Line: () => null,
    Area: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
    ReferenceArea: () => null,
    Cell: () => null,
  }
})

import { ClickThroughActivity } from '../src/components/project/ActivitySection.js'
import type { ApiGaTrafficAiLandingPage } from '../src/api.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

function emptyBucket() {
  return { sessions: 0, sharePct: 0, sharePctDisplay: '0%' }
}

/** A full ApiGaTraffic fixture with a parametrizable set of AI landing-page rows. */
function makeTraffic(aiReferralLandingPages: ApiGaTrafficAiLandingPage[]) {
  return {
    totalSessions: 0,
    totalOrganicSessions: 0,
    totalDirectSessions: 0,
    totalUsers: 0,
    topPages: [],
    aiReferrals: [],
    aiReferralLandingPages,
    aiSessionsDeduped: 0,
    paidAiSessionsDeduped: 0,
    organicAiSessionsDeduped: 0,
    aiSessionsBySession: 0,
    paidAiSessionsBySession: 0,
    organicAiSessionsBySession: 0,
    socialReferrals: [],
    socialSessions: 0,
    socialUsers: 0,
    channelBreakdown: {
      organic: emptyBucket(),
      social: emptyBucket(),
      direct: emptyBucket(),
      ai: emptyBucket(),
      other: emptyBucket(),
    },
    organicSharePct: 0,
    aiSharePct: 0,
    aiSharePctBySession: 0,
    paidAiSharePct: 0,
    paidAiSharePctBySession: 0,
    organicAiSharePct: 0,
    organicAiSharePctBySession: 0,
    socialSharePct: 0,
    directSharePct: 0,
    organicSharePctDisplay: '0%',
    aiSharePctDisplay: '0%',
    aiSharePctBySessionDisplay: '0%',
    paidAiSharePctDisplay: '0%',
    paidAiSharePctBySessionDisplay: '0%',
    organicAiSharePctDisplay: '0%',
    organicAiSharePctBySessionDisplay: '0%',
    socialSharePctDisplay: '0%',
    directSharePctDisplay: '0%',
    otherSessions: 0,
    otherSharePct: 0,
    otherSharePctDisplay: '0%',
    lastSyncedAt: '2026-06-09T00:00:00.000Z',
    periodStart: '2026-05-10',
    periodEnd: '2026-06-09',
  }
}

/** N AI landing-page rows with descending sessions so sort order is deterministic. */
function makeLandingPages(count: number): ApiGaTrafficAiLandingPage[] {
  return Array.from({ length: count }, (_, i) => ({
    source: 'chatgpt.com',
    medium: 'referral',
    trafficClass: 'organic',
    sourceDimension: 'session' as const,
    landingPage: `/page-${String(i).padStart(3, '0')}`,
    sessions: count - i,
  }))
}

function renderPanel(landingPages: ApiGaTrafficAiLandingPage[]) {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '123456',
        clientEmail: 'svc@example.com',
        lastSyncedAt: '2026-06-09T00:00:00.000Z',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-06-09T00:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) {
      return jsonResponse(makeTraffic(landingPages))
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" />
    </QueryClientProvider>,
  )
}

test('shows 25 landing-page rows per page and paginates the rest', async () => {
  renderPanel(makeLandingPages(60))

  // Page 1: first 25 rows render, the 26th does not.
  await waitFor(() => expect(screen.getByText('1 to 25 of 60 rows')).toBeTruthy())
  expect(screen.getByText('/page-000')).toBeTruthy()
  expect(screen.getByText('/page-024')).toBeTruthy()
  expect(screen.queryByText('/page-025')).toBeNull()

  // Controls: Page 1 of 3, Previous disabled, Next enabled.
  expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  const prev = screen.getByRole('button', { name: 'Previous' })
  const next = screen.getByRole('button', { name: 'Next' })
  expect(prev.hasAttribute('disabled')).toBe(true)
  expect(next.hasAttribute('disabled')).toBe(false)

  // Advance: page 2 shows the next 25 rows.
  fireEvent.click(next)
  await waitFor(() => expect(screen.getByText('26 to 50 of 60 rows')).toBeTruthy())
  expect(screen.getByText('Page 2 of 3')).toBeTruthy()
  expect(screen.getByText('/page-025')).toBeTruthy()
  expect(screen.getByText('/page-049')).toBeTruthy()
  expect(screen.queryByText('/page-024')).toBeNull()
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(false)

  // Page 3 shows the remaining 10 rows, and Next is now disabled.
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('51 to 60 of 60 rows')).toBeTruthy())
  expect(screen.getByText('Page 3 of 3')).toBeTruthy()
  expect(screen.getByText('/page-050')).toBeTruthy()
  expect(screen.getByText('/page-059')).toBeTruthy()
  expect(screen.queryByText('/page-049')).toBeNull()
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
})

test('renders no pagination controls when there are 25 or fewer rows', async () => {
  renderPanel(makeLandingPages(25))

  await waitFor(() => expect(screen.getByText('25 rows')).toBeTruthy())
  // The shared footer always reports the visible range, but omits page controls
  // when there is only one page.
  expect(screen.getByText('1 to 25 of 25 rows')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
  expect(screen.queryByText(/Page \d+ of/)).toBeNull()
})

test('changing the sort resets to page 1', async () => {
  renderPanel(makeLandingPages(60))

  // Jump to page 2.
  await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy())

  // Re-sorting (click the "Landing Page" header) snaps back to page 1.
  fireEvent.click(screen.getByRole('button', { name: /Landing Page/ }))
  await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeTruthy())
  expect(screen.getByText('1 to 25 of 60 rows')).toBeTruthy()
})

test('middle-truncates long URLs while preserving the full value for filtering and accessibility', async () => {
  const landingPage = `/audit?olref=${'summer-launch-'.repeat(8)}&campaign=summer-launch&content=footer-link`
  renderPanel([
    {
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'manual_utm',
      landingPage,
      sessions: 12,
      users: 9,
    },
    ...makeLandingPages(30),
  ])

  await waitFor(() => expect(screen.getByText('1 to 25 of 31 rows')).toBeTruthy())
  const expectedDisplay = `${[...landingPage].slice(0, 36).join('')}…${[...landingPage].slice(-18).join('')}`
  const displayedUrl = screen.getByText(expectedDisplay)
  expect(displayedUrl.getAttribute('aria-hidden')).toBe('true')
  expect(displayedUrl.parentElement?.getAttribute('title')).toBe(landingPage)
  expect(displayedUrl.parentElement?.querySelector('.sr-only')?.textContent).toBe(landingPage)

  const filter = screen.getByRole('searchbox', { name: 'Filter landing page URLs or query parameters' })
  fireEvent.change(filter, { target: { value: 'olref campaign summer footer' } })

  await waitFor(() => expect(screen.getByText('1 match')).toBeTruthy())
  expect(screen.getByText(expectedDisplay)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()

  fireEvent.change(filter, { target: { value: 'campaign=missing' } })
  await waitFor(() => expect(screen.getByText('0 matches')).toBeTruthy())
  expect(screen.getByText('No landing pages match this filter')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
  await waitFor(() => expect(screen.getByText('1 to 25 of 31 rows')).toBeTruthy())
})
