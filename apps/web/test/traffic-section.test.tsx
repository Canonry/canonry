import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

afterEach(cleanup)

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Area: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  }
})

import { TrafficSection } from '../src/components/project/TrafficSection.js'

function renderTrafficSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TrafficSection projectName="test-project" />
    </QueryClientProvider>,
  )
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('loads connected GA4 data without changing hook order', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '999888',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        authMethod: 'service-account',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
        createdAt: '2026-03-31T12:00:00.000Z',
        updatedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) {
      return jsonResponse({
        totalSessions: 120,
        totalOrganicSessions: 70,
        totalDirectSessions: 30,
        totalUsers: 95,
        topPages: [
          { landingPage: '/pricing', sessions: 80, organicSessions: 50, directSessions: 20, users: 60 },
        ],
        aiReferrals: [
          { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 12, users: 9 },
        ],
        aiReferralLandingPages: [
          { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', landingPage: '/pricing', sessions: 12, users: 9 },
        ],
        aiSessionsDeduped: 12,
        aiUsersDeduped: 9,
        aiSessionsBySession: 12,
        aiUsersBySession: 9,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, users: 6 },
        ],
        socialSessions: 8,
        socialUsers: 6,
        organicSharePct: 58,
        aiSharePct: 10,
        aiSharePctBySession: 10,
        directSharePct: 25,
        socialSharePct: 7,
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-history')) {
      return jsonResponse([
        { date: '2026-03-30', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 5, users: 4 },
        { date: '2026-03-31', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 7, users: 5 },
      ])
    }
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) {
      return jsonResponse([
        { date: '2026-03-30', sessions: 50, organicSessions: 30, users: 40 },
        { date: '2026-03-31', sessions: 70, organicSessions: 40, users: 55 },
      ])
    }
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) {
      return jsonResponse([])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => consoleErrorSpy.mockRestore())

  renderTrafficSection()

  await waitFor(() => {
    expect(screen.getByText('AI vs. total sessions')).toBeTruthy()
  })

  expect(screen.getByText(/Top AI referrer:/)).toBeTruthy()
  expect(
    consoleErrorSpy.mock.calls.flat().some((arg) =>
      String(arg).includes('change in the order of Hooks')
      || String(arg).includes('Rendered more hooks than during the previous render'),
    ),
  ).toBe(false)
})

test('renders four-channel breakdown with Organic, Social, Direct, and Known AI referrers (lower bound)', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '999888',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        authMethod: 'service-account',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
        createdAt: '2026-03-31T12:00:00.000Z',
        updatedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) {
      return jsonResponse({
        totalSessions: 120,
        totalOrganicSessions: 70,
        totalDirectSessions: 30,
        totalUsers: 95,
        topPages: [
          { landingPage: '/pricing', sessions: 80, organicSessions: 50, directSessions: 20, users: 60 },
        ],
        aiReferrals: [
          { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 12, users: 9 },
          { source: 'claude.ai', medium: 'referral', sourceDimension: 'first_user', sessions: 30, users: 24 },
        ],
        aiReferralLandingPages: [
          { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', landingPage: '/pricing', sessions: 12, users: 9 },
          { source: 'claude.ai', medium: 'referral', sourceDimension: 'first_user', landingPage: '/guide', sessions: 30, users: 24 },
        ],
        // Cross-cutting dedup includes firstUserSource → 12 + 30 = 42
        aiSessionsDeduped: 42,
        aiUsersDeduped: 33,
        // Session-source-only count is disjoint from Direct/Organic/Social → 12
        aiSessionsBySession: 12,
        aiUsersBySession: 9,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, users: 6 },
        ],
        socialSessions: 8,
        socialUsers: 6,
        organicSharePct: 58,
        aiSharePct: 35,
        aiSharePctBySession: 10,
        directSharePct: 25,
        socialSharePct: 7,
        organicSharePctDisplay: '58%',
        aiSharePctDisplay: '35%',
        aiSharePctBySessionDisplay: '10%',
        directSharePctDisplay: '25%',
        socialSharePctDisplay: '7%',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderTrafficSection()

  await waitFor(() => {
    expect(screen.getByText('Channel breakdown')).toBeTruthy()
  })

  // Scope queries to the breakdown card so column headers in unrelated tables don't collide.
  const card = screen.getByText('Channel breakdown').closest('div.surface-card') as HTMLElement
  expect(card).toBeTruthy()
  const breakdown = within(card)

  // Four labeled channels appear in the breakdown card
  expect(breakdown.getByText('Organic')).toBeTruthy()
  expect(breakdown.getByText('Social')).toBeTruthy()
  expect(breakdown.getByText('Direct')).toBeTruthy()
  expect(breakdown.getByText(/Known AI referrers/)).toBeTruthy()
  expect(breakdown.getByText(/lower bound/i)).toBeTruthy()

  // Direct cell shows the share from API (25%)
  expect(breakdown.getByText('25%')).toBeTruthy()

  // AI cell uses the session-source-only share (10%, disjoint from Direct/Organic/Social),
  // NOT the cross-cutting aiSharePct (35%) which would overlap with other channels.
  expect(breakdown.getByText('10%')).toBeTruthy()
  expect(breakdown.queryByText('35%')).toBeNull()

  // The misleading old framing is gone: panel title "Attributable AI visits" must not appear
  expect(screen.queryByText('Attributable AI visits')).toBeNull()

  expect(screen.getByText('Known AI referrers — landing pages')).toBeTruthy()
  const row = screen.getAllByText('/pricing')
    .map((cell) => cell.closest('tr') as HTMLElement | null)
    .find((candidate): candidate is HTMLElement => Boolean(candidate && within(candidate).queryByText('chatgpt.com')))
  expect(row).toBeTruthy()
  expect(within(row).getByText('chatgpt.com')).toBeTruthy()
  expect(within(row).getByText('12')).toBeTruthy()
})

test('social table collapses to top 25 with show-all toggle and surfaces Other-source rollup', async () => {
  // 30 sources keeps the table over the 25-row default cap and forces top-N + Other in the chart
  const longCampaignName = (i: number) =>
    `HVAC+Facebook+Groups+Q1+2026+|+Closed+|+US+CAN+|+1k+sources+(${i.toString().padStart(2, '0')})`
  const referrals = Array.from({ length: 30 }, (_, i) => ({
    source: longCampaignName(i),
    medium: 'paid_facebook_Mobile_Feed',
    channelGroup: 'Paid Social' as const,
    sessions: 100 - i,
    users: 90 - i,
  }))
  const history = referrals.flatMap((r) => [
    { date: '2026-04-01', source: r.source, medium: r.medium, channelGroup: r.channelGroup, sessions: r.sessions, users: r.users },
    { date: '2026-04-02', source: r.source, medium: r.medium, channelGroup: r.channelGroup, sessions: Math.max(1, r.sessions - 5), users: Math.max(1, r.users - 5) },
  ])

  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '999888',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        authMethod: 'service-account',
        lastSyncedAt: '2026-04-02T12:00:00.000Z',
        createdAt: '2026-04-02T12:00:00.000Z',
        updatedAt: '2026-04-02T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) {
      const totalSessions = referrals.reduce((acc, r) => acc + r.sessions, 0)
      return jsonResponse({
        totalSessions,
        totalOrganicSessions: 0,
        totalDirectSessions: 0,
        totalUsers: referrals.reduce((acc, r) => acc + r.users, 0),
        topPages: [],
        aiReferrals: [],
        aiReferralLandingPages: [],
        aiSessionsDeduped: 0,
        aiUsersDeduped: 0,
        aiSessionsBySession: 0,
        aiUsersBySession: 0,
        socialReferrals: referrals,
        socialSessions: totalSessions,
        socialUsers: referrals.reduce((acc, r) => acc + r.users, 0),
        organicSharePct: 0,
        aiSharePct: 0,
        aiSharePctBySession: 0,
        directSharePct: 0,
        socialSharePct: 100,
        lastSyncedAt: '2026-04-02T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse(history)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderTrafficSection()

  await waitFor(() => {
    expect(screen.getByText('Source / medium')).toBeTruthy()
  })

  // Top-N + Other notice: 30 sources, top 6 plotted, 24 collapsed into Other
  expect(screen.getByText(/Showing top 6 sources · 24 more grouped as Other/)).toBeTruthy()

  // Source / medium table starts collapsed at the default limit of 25
  const breakdownCard = screen.getByText('Source / medium').closest('div.surface-card') as HTMLElement
  expect(breakdownCard).toBeTruthy()
  const breakdown = within(breakdownCard)
  expect(breakdown.getByText('Top 25 of 30')).toBeTruthy()
  expect(breakdown.queryAllByRole('row').length - 1 /* header */).toBe(25)

  // Long source names render decoded — `+` becomes space — but the title attribute keeps the raw value
  const decodedCell = breakdown.getAllByText(/HVAC Facebook Groups Q1 2026/)[0]!
  expect(decodedCell).toBeTruthy()
  expect(decodedCell.getAttribute('title')).toMatch(/HVAC\+Facebook\+Groups\+Q1\+2026/)

  // Toggling the Show-all button expands to all 30 rows; toggling back returns to the cap
  const showAllButton = breakdown.getByRole('button', { name: /Show all 30 sources/ })
  act(() => {
    fireEvent.click(showAllButton)
  })
  await waitFor(() => {
    expect(breakdown.queryAllByRole('row').length - 1).toBe(30)
  })
  expect(breakdown.getByText('30 rows')).toBeTruthy()

  const collapseButton = breakdown.getByRole('button', { name: /Show top 25/ })
  act(() => {
    fireEvent.click(collapseButton)
  })
  await waitFor(() => {
    expect(breakdown.queryAllByRole('row').length - 1).toBe(25)
  })
})
