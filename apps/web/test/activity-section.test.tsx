import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

afterEach(cleanup)

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  // The chart's rows, captured so `Line` can run the real dot renderer against
  // them. React renders a parent before its children, so this is populated by
  // the time any `Line` below is called.
  let chartRows: Record<string, unknown>[] = []
  const ComposedChart = ({ children, data }: { children?: React.ReactNode; data?: Record<string, unknown>[] }) => {
    chartRows = data ?? []
    return <div>{children}</div>
  }
  return {
    ResponsiveContainer: passthrough,
    ComposedChart,
    Area: () => null,
    // A `dot` RENDERER is invoked once per row and its output mounted, so a test
    // can prove an isolated reading is actually drawn. Recharts does this into
    // SVG that jsdom cannot meaningfully assert on; object/false dots stay inert.
    Line: ({ dataKey, dot }: { dataKey?: string; dot?: unknown }) =>
      typeof dot === 'function'
        ? (
          <div data-testid={`dots-${dataKey}`}>
            {chartRows.map((_, i) =>
              (dot as (p: Record<string, unknown>) => React.ReactNode)({ cx: i, cy: 1, index: i, key: `dot-${i}` }))}
          </div>
        )
        : null,
    CartesianGrid: () => null,
    Bar: () => null,
    BarChart: passthrough,
    Cell: () => null,
    ReferenceArea: () => null,
    ReferenceLine: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    // Rendered as a marker so a test can prove the legend exists at all. The
    // real Legend draws to canvas-ish SVG that jsdom cannot meaningfully assert.
    Legend: () => <div data-testid="chart-legend" />,
  }
})

import { ActivitySection, ClickThroughActivity } from '../src/components/project/ActivitySection.js'
import { AiTrafficHistoryPanel } from '../src/components/project/AiTrafficHistoryPanel.js'

function renderActivitySection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ActivitySection projectName="test-project" />
    </QueryClientProvider>,
  )
}

import { mockFetch, jsonResponse } from './mock-fetch.js'

test('loads connected GA4 data without changing hook order and keeps it above AI traffic', async () => {
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
          { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 12 },
        ],
        aiReferralLandingPages: [
          { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/pricing', sessions: 12 },
        ],
        aiSessionsDeduped: 12,
        paidAiSessionsDeduped: 0,
        organicAiSessionsDeduped: 12,
        aiSessionsBySession: 12,
        paidAiSessionsBySession: 0,
        organicAiSessionsBySession: 12,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, users: 6 },
        ],
        socialSessions: 8,
        socialUsers: 6,
        organicSharePct: 58,
        aiSharePct: 10,
        aiSharePctBySession: 10,
        paidAiSharePct: 0,
        paidAiSharePctBySession: 0,
        organicAiSharePct: 10,
        organicAiSharePctBySession: 10,
        directSharePct: 25,
        socialSharePct: 7,
        organicSharePctDisplay: '58%',
        aiSharePctDisplay: '10%',
        aiSharePctBySessionDisplay: '10%',
        paidAiSharePctDisplay: '0%',
        paidAiSharePctBySessionDisplay: '0%',
        organicAiSharePctDisplay: '10%',
        organicAiSharePctBySessionDisplay: '10%',
        directSharePctDisplay: '25%',
        socialSharePctDisplay: '7%',
        otherSessions: 10,
        otherSharePct: 8,
        otherSharePctDisplay: '8%',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) {
      return jsonResponse({
        days: [
          { date: '2026-03-30', sessions: 5, paidSessions: 0, organicSessions: 5, bySource: [{ source: 'chatgpt.com', sessions: 5, paidSessions: 0, organicSessions: 5 }] },
          { date: '2026-03-31', sessions: 7, paidSessions: 0, organicSessions: 7, bySource: [{ source: 'chatgpt.com', sessions: 7, paidSessions: 0, organicSessions: 7 }] },
        ],
        sources: ['chatgpt.com'],
        totalSessions: 12,
        totalPaidSessions: 0,
        totalOrganicSessions: 12,
      })
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
    if (urlPath.endsWith('/projects/test-project/traffic/sources')) {
      return jsonResponse({ sources: [] })
    }
    if (urlPath.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: {
          crawlerHits: 1,
          crawlerContentHits: 1,
          aiUserFetchHits: 1,
          aiReferralHits: 1,
          aiReferralLandedHits: 1,
        },
        series: {
          granularity: 'day',
          coverageStart: '2026-03-31T00:00:00.000Z',
          trends: {
            crawlerContentHits: null,
            aiUserFetchHits: null,
            aiReferralLandedHits: null,
          },
          points: [{
            bucket: '2026-03-31',
            measured: true,
            crawlerHits: 1,
            crawlerContentHits: 1,
            aiUserFetchHits: 1,
            aiReferralHits: 1,
            aiReferralLandedHits: 1,
          }],
        },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => consoleErrorSpy.mockRestore())

  renderActivitySection()

  await waitFor(() => {
    expect(screen.getByText('AI vs. total sessions')).toBeTruthy()
  })

  const trafficPeriod = screen.getByRole('group', { name: 'Traffic time period' })
  expect(within(trafficPeriod).getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true')

  const siteTraffic = screen.getByText('Site Traffic')
  const machineTraffic = await screen.findByRole('heading', { name: 'Machines reading your site' })
  const visitorTraffic = screen.getByRole('heading', { name: 'People arriving from AI' })
  expect(siteTraffic.compareDocumentPosition(machineTraffic) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(siteTraffic.compareDocumentPosition(visitorTraffic) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

  expect(screen.getByText(/Top AI referrer:/)).toBeTruthy()
  expect(
    consoleErrorSpy.mock.calls.flat().some((arg) =>
      String(arg).includes('change in the order of Hooks')
      || String(arg).includes('Rendered more hooks than during the previous render'),
    ),
  ).toBe(false)
})

test('renders five-channel breakdown with disjoint Organic, Social, Direct, Known AI, and Other buckets', async () => {
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
          { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 12 },
          { source: 'claude.ai', medium: 'referral', trafficClass: 'organic', sourceDimension: 'first_user', sessions: 30 },
        ],
        aiReferralLandingPages: [
          { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', landingPage: '/pricing', sessions: 12 },
          { source: 'claude.ai', medium: 'referral', trafficClass: 'organic', sourceDimension: 'first_user', landingPage: '/guide', sessions: 30 },
        ],
        // Cross-cutting dedup includes firstUserSource → 12 + 30 = 42
        aiSessionsDeduped: 42,
        paidAiSessionsDeduped: 0,
        organicAiSessionsDeduped: 42,
        // Session-source-only count becomes the dedicated Known AI bucket.
        aiSessionsBySession: 12,
        paidAiSessionsBySession: 0,
        organicAiSessionsBySession: 12,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, users: 6 },
        ],
        socialSessions: 8,
        socialUsers: 6,
        channelBreakdown: {
          organic: { sessions: 70, sharePct: 58, sharePctDisplay: '58%' },
          social: { sessions: 8, sharePct: 7, sharePctDisplay: '7%' },
          direct: { sessions: 30, sharePct: 25, sharePctDisplay: '25%' },
          ai: { sessions: 12, sharePct: 10, sharePctDisplay: '10%' },
          other: { sessions: 0, sharePct: 0, sharePctDisplay: '0%' },
        },
        organicSharePct: 58,
        aiSharePct: 35,
        aiSharePctBySession: 10,
        paidAiSharePct: 0,
        paidAiSharePctBySession: 0,
        organicAiSharePct: 35,
        organicAiSharePctBySession: 10,
        directSharePct: 25,
        socialSharePct: 7,
        organicSharePctDisplay: '58%',
        aiSharePctDisplay: '35%',
        aiSharePctBySessionDisplay: '10%',
        paidAiSharePctDisplay: '0%',
        paidAiSharePctBySessionDisplay: '0%',
        organicAiSharePctDisplay: '35%',
        organicAiSharePctBySessionDisplay: '10%',
        directSharePctDisplay: '25%',
        socialSharePctDisplay: '7%',
        otherSessions: 0,
        otherSharePct: 0,
        otherSharePctDisplay: '0%',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderActivitySection()

  await waitFor(() => {
    expect(screen.getByText('Sessions by channel')).toBeTruthy()
  })

  // Scope queries to the breakdown card so column headers in unrelated tables don't collide.
  const card = screen.getByText('Sessions by channel').closest('div.surface-card') as HTMLElement
  expect(card).toBeTruthy()
  const breakdown = within(card)

  // Five labeled channels appear in the breakdown card
  expect(breakdown.getByText('Organic')).toBeTruthy()
  expect(breakdown.getByText('Social')).toBeTruthy()
  expect(breakdown.getByText('Direct')).toBeTruthy()
  expect(breakdown.getByText(/Visitors from AI/)).toBeTruthy()
  expect(breakdown.getByText('Other channels')).toBeTruthy()
  expect(breakdown.getByText(/at least/i)).toBeTruthy()

  // Direct cell shows the share from API (25%)
  expect(breakdown.getByText('25%')).toBeTruthy()

  // AI cell uses the dedicated channelBreakdown AI share (10%), NOT the
  // cross-cutting aiSharePct (35%) which would overlap with other channels.
  expect(breakdown.getByText('10%')).toBeTruthy()
  expect(breakdown.queryByText('35%')).toBeNull()

  // The misleading old framing is gone: panel title "Attributable AI visits" must not appear
  expect(screen.queryByText('Attributable AI visits')).toBeNull()

  expect(screen.getByText('Pages AI visitors landed on')).toBeTruthy()
  const row = screen.getAllByText('/pricing')
    .map((cell) => cell.closest('tr') as HTMLElement | null)
    .find((candidate): candidate is HTMLElement => Boolean(candidate && within(candidate).queryByText('chatgpt.com')))
  expect(row).toBeTruthy()
  expect(within(row).getByText('chatgpt.com')).toBeTruthy()
  expect(within(row).getByText('12')).toBeTruthy()
})

test('renders each referral and landing-page share the API sent, never one divided from counts', async () => {
  // Every share disagrees with its counts on purpose. Dividing counts would read
  // chatgpt.com 12/42 = 28.6%, claude.ai 30/42 = 71.4%, facebook.com 8/8 = 100%
  // and /pricing 50/80 = 62.5%. The tables must show the API's values instead.
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
          { landingPage: '/pricing', sessions: 80, organicSessions: 50, directSessions: 20, users: 60, organicShare: 0.25 },
        ],
        aiReferrals: [
          { source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 12, share: 0.375 },
          { source: 'claude.ai', medium: 'referral', trafficClass: 'organic', sourceDimension: 'first_user', sessions: 30, share: 0.625 },
        ],
        aiReferralLandingPages: [],
        aiSessionsDeduped: 42,
        paidAiSessionsDeduped: 0,
        organicAiSessionsDeduped: 42,
        aiSessionsBySession: 12,
        paidAiSessionsBySession: 0,
        organicAiSessionsBySession: 12,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, share: 0.0004 },
        ],
        socialSessions: 8,
        channelBreakdown: {
          organic: { sessions: 70, sharePct: 58, sharePctDisplay: '58.3%' },
          social: { sessions: 8, sharePct: 7, sharePctDisplay: '6.7%' },
          direct: { sessions: 30, sharePct: 25, sharePctDisplay: '25.0%' },
          ai: { sessions: 12, sharePct: 10, sharePctDisplay: '10.0%' },
          other: { sessions: 0, sharePct: 0, sharePctDisplay: '0%' },
        },
        organicSharePct: 58,
        aiSharePct: 35,
        aiSharePctBySession: 10,
        paidAiSharePct: 0,
        paidAiSharePctBySession: 0,
        organicAiSharePct: 35,
        organicAiSharePctBySession: 10,
        directSharePct: 25,
        socialSharePct: 7,
        organicSharePctDisplay: '58.3%',
        aiSharePctDisplay: '35.0%',
        aiSharePctBySessionDisplay: '10.0%',
        paidAiSharePctDisplay: '0%',
        paidAiSharePctBySessionDisplay: '0%',
        organicAiSharePctDisplay: '35.0%',
        organicAiSharePctBySessionDisplay: '10.0%',
        directSharePctDisplay: '25.0%',
        socialSharePctDisplay: '6.7%',
        otherSessions: 0,
        otherSharePct: 0,
        otherSharePctDisplay: '0%',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
        windowStart: '2026-03-02',
        windowEnd: '2026-03-31',
        windowDays: 30,
        periodStart: '2026-03-02',
        periodEnd: '2026-03-31',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderActivitySection()

  await waitFor(() => {
    expect(screen.getByText('Where AI visitors came from')).toBeTruthy()
  })

  const shareCell = (row: HTMLElement) => within(row).getAllByRole('cell').at(-1)?.textContent
  const rowOf = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('tr') as HTMLElement

  const aiCard = screen.getByText('Where AI visitors came from').closest('div.surface-card') as HTMLElement
  expect(shareCell(rowOf(aiCard, 'chatgpt.com'))).toBe('37.5%')
  expect(shareCell(rowOf(aiCard, 'claude.ai'))).toBe('62.5%')

  const socialCard = screen.getByText('Social sources').closest('div.surface-card') as HTMLElement
  expect(shareCell(rowOf(socialCard, 'facebook.com'))).toBe('<0.1%')

  const pagesSection = screen.getByRole('heading', { name: /Top Landing Pages/ }).closest('section') as HTMLElement
  expect(shareCell(rowOf(pagesSection, '/pricing'))).toBe('25.0%')
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
        paidAiSessionsDeduped: 0,
        organicAiSessionsDeduped: 0,
        aiSessionsBySession: 0,
        paidAiSessionsBySession: 0,
        organicAiSessionsBySession: 0,
        socialReferrals: referrals,
        socialSessions: totalSessions,
        socialUsers: referrals.reduce((acc, r) => acc + r.users, 0),
        organicSharePct: 0,
        aiSharePct: 0,
        aiSharePctBySession: 0,
        paidAiSharePct: 0,
        paidAiSharePctBySession: 0,
        organicAiSharePct: 0,
        organicAiSharePctBySession: 0,
        directSharePct: 0,
        socialSharePct: 100,
        organicSharePctDisplay: '0%',
        aiSharePctDisplay: '0%',
        aiSharePctBySessionDisplay: '0%',
        paidAiSharePctDisplay: '0%',
        paidAiSharePctBySessionDisplay: '0%',
        organicAiSharePctDisplay: '0%',
        organicAiSharePctBySessionDisplay: '0%',
        directSharePctDisplay: '0%',
        socialSharePctDisplay: '100%',
        otherSessions: 0,
        otherSharePct: 0,
        otherSharePctDisplay: '0%',
        lastSyncedAt: '2026-04-02T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) return jsonResponse([])
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) return jsonResponse(history)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderActivitySection()

  await waitFor(() => {
    expect(screen.getByText('Social sources')).toBeTruthy()
  })

  // Top-N + Other notice: 30 sources, top 6 plotted, 24 collapsed into Other
  expect(screen.getByText(/Showing top 6 sources · 24 more grouped as Other/)).toBeTruthy()

  // Social sources table starts collapsed at the default limit of 25
  const breakdownCard = screen.getByText('Social sources').closest('div.surface-card') as HTMLElement
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

test('top time picker reloads every GA surface and replaces all Social data', async () => {
  const seen = new Set<string>()
  const requestQueries = new Map<string, URLSearchParams>()
  const sources = {
    '7d': { source: 'linkedin.com', sessions: 7, start: '2026-08-11', end: '2026-08-17' },
    '30d': { source: 'facebook.com', sessions: 30, start: '2026-07-19', end: '2026-08-17' },
    '90d': { source: 'x.com', sessions: 90, start: '2026-05-20', end: '2026-08-17' },
    all: { source: 'reddit.com', sessions: 120, start: null, end: null },
  } as const
  const surfaces = ['traffic', 'ai-referral-daily', 'session-history', 'social-referral-history'] as const

  const restoreFetch = mockFetch((url) => {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '999888',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        authMethod: 'service-account',
        lastSyncedAt: '2026-08-17T12:00:00.000Z',
        createdAt: '2026-08-17T12:00:00.000Z',
        updatedAt: '2026-08-17T12:00:00.000Z',
      })
    }

    const surface = surfaces.find(candidate => parsed.pathname.endsWith(`/ga/${candidate}`))
    if (!surface) throw new Error(`Unexpected fetch: ${url}`)
    const selectedWindow = surface === 'social-referral-history'
      ? (Object.keys(sources) as Array<keyof typeof sources>).find((key) => {
          const source = sources[key]
          return parsed.searchParams.get('startDate') === source.start
            && parsed.searchParams.get('endDate') === source.end
        })
      : (parsed.searchParams.get('window') ?? 'all') as keyof typeof sources
    if (!selectedWindow) throw new Error(`Request did not match a picker window: ${url}`)
    const selected = sources[selectedWindow]
    seen.add(`${surface}:${selectedWindow}`)
    requestQueries.set(`${surface}:${selectedWindow}`, parsed.searchParams)

    if (surface === 'traffic') {
      const emptyBucket = { sessions: 0, sharePct: 0, sharePctDisplay: '0%' }
      const socialBucket = { sessions: selected.sessions, sharePct: 50, sharePctDisplay: '50%' }
      return jsonResponse({
        totalSessions: selected.sessions * 2,
        totalOrganicSessions: 0,
        totalDirectSessions: 0,
        totalUsers: selected.sessions,
        topPages: [],
        aiReferrals: [],
        aiReferralLandingPages: [],
        aiSessionsDeduped: 0,
        paidAiSessionsDeduped: 0,
        organicAiSessionsDeduped: 0,
        aiSessionsBySession: 0,
        paidAiSessionsBySession: 0,
        organicAiSessionsBySession: 0,
        socialReferrals: [{
          source: selected.source,
          medium: 'social',
          channelGroup: 'Organic Social',
          sessions: selected.sessions,
          users: selected.sessions,
        }],
        socialSessions: selected.sessions,
        socialUsers: selected.sessions,
        channelBreakdown: {
          organic: emptyBucket,
          social: socialBucket,
          direct: emptyBucket,
          ai: emptyBucket,
          other: emptyBucket,
        },
        organicSharePct: 0,
        aiSharePct: 0,
        aiSharePctBySession: 0,
        paidAiSharePct: 0,
        paidAiSharePctBySession: 0,
        organicAiSharePct: 0,
        organicAiSharePctBySession: 0,
        directSharePct: 0,
        socialSharePct: 50,
        organicSharePctDisplay: '0%',
        aiSharePctDisplay: '0%',
        aiSharePctBySessionDisplay: '0%',
        paidAiSharePctDisplay: '0%',
        paidAiSharePctBySessionDisplay: '0%',
        organicAiSharePctDisplay: '0%',
        organicAiSharePctBySessionDisplay: '0%',
        directSharePctDisplay: '0%',
        socialSharePctDisplay: '50%',
        otherSessions: 0,
        otherSharePct: 0,
        otherSharePctDisplay: '0%',
        lastSyncedAt: '2026-08-17T12:00:00.000Z',
        windowStart: selected.start,
        windowEnd: selected.end,
        windowDays: selected.start ? selected.sessions : null,
        periodStart: selected.start,
        periodEnd: selected.end,
      })
    }
    if (surface === 'social-referral-history') {
      return jsonResponse([{
        date: selected.end ?? '2026-08-17',
        source: selected.source,
        medium: 'social',
        channelGroup: 'Organic Social',
        sessions: selected.sessions,
        users: selected.sessions,
      }])
    }
    if (surface === 'ai-referral-daily') {
      return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    }
    return jsonResponse([])
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window="30d" />
    </QueryClientProvider>,
  )

  const assertWindow = async (windowKey: keyof typeof sources) => {
    const selected = sources[windowKey]
    await waitFor(() => {
      for (const surface of surfaces) expect(seen.has(`${surface}:${windowKey}`)).toBe(true)
      expect(screen.getAllByText(selected.source).length).toBeGreaterThan(0)
    })
    for (const surface of surfaces) {
      const query = requestQueries.get(`${surface}:${windowKey}`)!
      if (surface === 'social-referral-history') {
        expect(query.get('window')).toBeNull()
        expect(query.get('startDate')).toBe(selected.start)
        expect(query.get('endDate')).toBe(selected.end)
      } else {
        expect(query.get('window')).toBe(windowKey === 'all' ? null : windowKey)
      }
    }
    const socialSection = screen.getByText('Social Media Traffic').closest('section') as HTMLElement
    for (const [otherWindow, other] of Object.entries(sources)) {
      if (otherWindow !== windowKey) expect(within(socialSection).queryByText(other.source)).toBeNull()
    }
  }

  await assertWindow('30d')
  // The picker now lives in ActivitySection, which owns the shared range, so
  // this drives the same reload through the prop ClickThroughActivity receives.
  // 'All' is gone: it meant unbounded to GA and 90 days to the server lane.
  rerender(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window="7d" />
    </QueryClientProvider>,
  )
  await assertWindow('7d')
  rerender(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window="90d" />
    </QueryClientProvider>,
  )
  await assertWindow('90d')
})

/**
 * The panel is a SIBLING of the GA4 click-through panel, never a child. That
 * panel early-returns a connect prompt when no property is bound, so a
 * server-fed chart nested inside it would vanish for exactly the projects it
 * serves: server-side traffic needs no GA4 at all.
 *
 * Mounted standalone here, with no GA4 fetch stubbed at all, which is the
 * strongest form of that claim: the panel cannot be reading GA4 state.
 */
test('AI traffic history renders server data even when the GA4 overlay fails', async () => {
  const restoreFetch = mockFetch((url) => {
    // The GA4 overlay is decoration on a server-fed chart. If it 500s the panel
    // must still render every server number, because server-side traffic needs
    // no GA4 at all and this panel is the only place it is charted.
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) {
      return new Response('nope', { status: 500 })
    }
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, crawlerContentHits: 12, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day',
          points: [
            { bucket: '2026-08-01', crawlerHits: 20, crawlerContentHits: 8, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2 },
            { bucket: '2026-08-02', crawlerHits: 10, crawlerContentHits: 4, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2 },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch in this test: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('AI crawlers')).toBeTruthy()

  // The tiles must read the HONEST fields: content crawls (12), not the 30 that
  // counts robots and sitemaps; landed visits (4), not the 5 that counts
  // redirect hops. Scoped per tile, because the Last 24h strip repeats these
  // same figures for the newest day and an unscoped query is ambiguous.
  const tileFor = (label: string) =>
    screen.getByText(label).closest('div.rounded-lg') as HTMLElement
  expect(within(tileFor('AI crawlers')).getByText('12')).toBeTruthy()
  expect(within(tileFor('AI page fetches')).getByText('7')).toBeTruthy()
  expect(within(tileFor('AI visitors')).getByText('4')).toBeTruthy()
  // The inflated figures must appear nowhere: not in a tile, not in the strip.
  expect(screen.queryByText('30')).toBeNull()
  expect(screen.queryByText('5')).toBeNull()

  // The source toggle exists and does not require GA4 to have loaded.
  expect(screen.getByRole('group', { name: /Visit measurement source/i })).toBeTruthy()
})

/**
 * Review finding: a failed request and a quiet window were both rendered as "no
 * activity". The API densifies the window, so a measured-but-empty range returns
 * zero-valued points, not none. These pin the three states apart.
 */
test('AI traffic history separates a failed request from a measured-empty window', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return new Response('boom', { status: 500 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // An error must never read as a measured zero.
  expect(await screen.findByText(/Could not load AI traffic history/i)).toBeTruthy()
  expect(screen.getByText(/not a reading of zero activity/i)).toBeTruthy()
  expect(screen.queryByText(/No AI activity recorded/i)).toBeNull()
})

test('AI traffic history reports a measured-empty window as measured, not unconnected', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        // Densified: the window WAS measured, it just held nothing. coverageStart
        // is what makes that claim; without it the honest read is "never recorded".
        series: {
          granularity: 'day',
          coverageStart: '2026-07-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [
            { bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: true },
            { bucket: '2026-08-02', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: true },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No AI activity recorded in this period/i)).toBeTruthy()
  // Points exist, so this is NOT the "no source connected" case.
  expect(screen.queryByText(/No server-side traffic source connected/i)).toBeNull()
  expect(screen.queryByText(/Could not load/i)).toBeNull()
})

test('the traffic range picker survives a disconnected GA4', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/ga/status')) {
      return jsonResponse({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ClickThroughActivity projectName="test-project" window="30d" />
    </QueryClientProvider>,
  )

  // The picker now lives in ActivitySection, so the GA panel must NOT own one.
  // Its disappearance on disconnect was the defect.
  await screen.findByText(/Connect Google Analytics 4/i)
  expect(screen.queryByRole('group', { name: /Traffic time period/i })).toBeNull()
})

/**
 * Regression: this panel took the whole Activity page down in production with
 * "Cannot read properties of undefined (reading 'toLocaleString')".
 *
 * Cause was version skew, not bad data. A deploy put this client in front of an
 * API that predates `crawlerContentHits` / `measured` on the series, and the
 * Last 24h strip dereferenced a field the schema says is required. The schema is
 * a promise about the code, not about the server that happens to be running.
 *
 * The fixture is deliberately an OLD-SHAPE payload: the four fields the API used
 * to return, and nothing else.
 */
test('AI traffic history survives an API older than the client', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [],
        eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day',
          // No crawlerContentHits. No measured. No trends. No coverageStart.
          points: [
            { bucket: '2026-08-01', crawlerHits: 20, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2 },
            { bucket: '2026-08-02', crawlerHits: 10, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2 },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // It must RENDER, not throw. The crawler tile degrades to 0 because the old
  // API cannot answer it; the fields that do exist still read correctly.
  expect(await screen.findByText('Latest day (UTC)')).toBeTruthy()
  const tileFor = (label: string) =>
    screen.getByText(label).closest('div.rounded-lg') as HTMLElement
  expect(within(tileFor('AI page fetches')).getByText('7')).toBeTruthy()
  expect(within(tileFor('AI visitors')).getByText('4')).toBeTruthy()

  // A missing `measured` must not paint the whole range as unmeasured.
  expect(screen.queryByText('not measured')).toBeNull()
})

/**
 * Two things the mock specified that shipped late, pinned so they cannot quietly
 * revert: every chart carries a legend, and social reads tiles -> chart -> table.
 * Without a legend the only thing naming a series is the hover tooltip, so a
 * glance cannot tell the lines apart.
 */
test('AI traffic charts carry a legend', async () => {
  const restoreFetch = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    if (url.split('?')[0]!.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 20, crawlerContentHits: 12, aiUserFetchHits: 7, aiReferralHits: 5, aiReferralLandedHits: 4 },
        series: {
          granularity: 'day', coverageStart: '2026-08-01',
          points: [
            { bucket: '2026-08-01', crawlerHits: 10, crawlerContentHits: 8, aiUserFetchHits: 3, aiReferralHits: 3, aiReferralLandedHits: 2, measured: true },
            { bucket: '2026-08-02', crawlerHits: 10, crawlerContentHits: 4, aiUserFetchHits: 4, aiReferralHits: 2, aiReferralLandedHits: 2, measured: true },
          ],
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  await screen.findByText('AI crawlers')
  // One per chart: machines, and people arriving.
  expect(screen.getAllByTestId('chart-legend').length).toBe(2)
})

/**
 * Review finding: an isolated GA4 reading rendered as NOTHING. The line runs
 * with `connectNulls={false}`, so a lone point has no neighbour to draw a
 * segment to, and dots were off entirely. GA4 days with no referrals are ABSENT
 * rather than zero, so `[null, 7, null]` is the ordinary shape of a quiet week,
 * and that day's visits simply vanished from a chart measuring visits.
 *
 * One fixture proves BOTH halves, because "draw the invisible point" could
 * otherwise be satisfied by turning every dot on, which is a different chart:
 * a RUN of three readings must contribute no dots (it draws as a line), and the
 * lone reading after the gap must contribute exactly one.
 */
test('AI traffic history draws isolated GA4 readings without speckling runs', async () => {
  const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/ga/status')) return jsonResponse({ connected: true, propertyId: 'p', clientEmail: null, lastSyncedAt: null })
    if (path.endsWith('/ga/ai-referral-daily')) {
      // A run of three, a gap, then ONE alone, then a gap.
      return jsonResponse({ days: [
        { date: '2026-08-01', sessions: 4 },
        { date: '2026-08-02', sessions: 4 },
        { date: '2026-08-03', sessions: 4 },
        { date: '2026-08-05', sessions: 9 },
      ] })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 30, crawlerContentHits: 30, aiUserFetchHits: 6, aiReferralHits: 6, aiReferralLandedHits: 6 },
        series: {
          granularity: 'day', coverageStart: '2026-07-01T00:00:00.000Z',
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: days.map((bucket) => ({
            bucket, crawlerHits: 5, crawlerContentHits: 5, aiUserFetchHits: 1,
            aiReferralHits: 1, aiReferralLandedHits: 1, measured: true,
          })),
        },
      })
    }
    return jsonResponse({ sources: [{ id: 's1', status: 'connected' }] })
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  // The GA4 overlay resolves after the server series, so wait for the settled
  // count rather than sampling the chart mid-flight.
  await waitFor(() => {
    const dots = screen.getByTestId('dots-ga4Visits')
    // Exactly one: the lone 2026-08-05. Zero is the reported bug; four would
    // mean the run got speckled too.
    expect(dots.querySelectorAll('circle').length).toBe(1)
  })
})

/**
 * Review finding: "nothing recorded" was rendered as "nothing connected".
 * `coverageStart === null` is equally true of a source connected an hour ago
 * that has not reported yet, so a CONNECTED source was told to connect one,
 * directly contradicting the connected badge above this panel.
 */
test('AI traffic history does not tell a connected source to connect a source', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/traffic/sources')) {
      return jsonResponse({ sources: [{ id: 'src-1', status: 'connected', sourceType: 'wordpress' }] })
    }
    if (path.endsWith('/projects/test-project/traffic/events')) {
      // Connected, but has never recorded anything: coverageStart is null.
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        series: {
          granularity: 'day', coverageStart: null,
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: false }],
        },
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No AI activity recorded yet/i)).toBeTruthy()
  // The contradiction: a connected source must never be told to connect one.
  expect(screen.queryByText(/Connect a traffic source/i)).toBeNull()
  expect(screen.queryByText(/No server-side traffic source connected/i)).toBeNull()
})

/**
 * The converse still has to work: with genuinely no source, say so.
 */
test('AI traffic history still reports a genuinely unconnected project', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/traffic/sources')) return jsonResponse({ sources: [] })
    if (path.endsWith('/projects/test-project/traffic/events')) {
      return jsonResponse({
        events: [], eventRows: { total: 0, returned: 0, truncated: false },
        totals: { crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0 },
        series: {
          granularity: 'day', coverageStart: null,
          trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
          points: [{ bucket: '2026-08-01', crawlerHits: 0, crawlerContentHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0, measured: false }],
        },
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiTrafficHistoryPanel projectName="test-project" sinceMinutes={43200} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No server-side traffic source connected yet/i)).toBeTruthy()
  expect(screen.getByText(/Connect a traffic source/i)).toBeTruthy()
})
