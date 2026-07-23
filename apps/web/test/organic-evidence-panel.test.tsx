import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { OrganicEvidencePanel } from '../src/components/project/ActivitySection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

type Period = {
  label: 'earliest' | 'middle' | 'previous' | 'latest'
  startDate: string
  endDate: string
}

function periods(period: 60 | 90): Period[] {
  if (period === 60) {
    return [
      { label: 'previous', startDate: '2026-05-22', endDate: '2026-06-20' },
      { label: 'latest', startDate: '2026-06-21', endDate: '2026-07-20' },
    ]
  }
  return [
    { label: 'earliest', startDate: '2026-04-22', endDate: '2026-05-21' },
    { label: 'middle', startDate: '2026-05-22', endDate: '2026-06-20' },
    { label: 'latest', startDate: '2026-06-21', endDate: '2026-07-20' },
  ]
}

function makeEvidence(
  period: 60 | 90,
  overrides?: {
    acquisitionStatus?: 'ready' | 'error'
    acquisitionError?: string | null
    leadScope?: 'landing-page' | 'channel'
  },
) {
  const sourcePeriods = periods(period)
  const sessionValues = period === 90 ? [10, 35, 16] : [35, 16]
  const paidValues = period === 90 ? [0, 0, 50] : [0, 50]
  const leadValues = period === 90 ? [2, 4, 0] : [4, 0]
  const impressionValues = period === 90 ? [384, 313, 495] : [313, 495]
  const clickValues = period === 90 ? [2, 4, 0] : [4, 0]
  const acquisitionStatus = overrides?.acquisitionStatus ?? 'ready'
  const leadScope = overrides?.leadScope ?? 'landing-page'

  const sessionPeriods = (values: number[]) => sourcePeriods.map((row, index) => ({
    ...row,
    sessions: values[index] ?? 0,
  }))
  const eventPeriods = (values: number[]) => sourcePeriods.map((row, index) => ({
    ...row,
    eventCount: values[index] ?? 0,
  }))
  return {
    contractVersion: 'organic-evidence/v1',
    periodDays: period,
    asOfDate: '2026-07-20',
    cohorts: sourcePeriods.map(row => ({ name: row.label, ...row })),
    coverage: { gsc: true, ga4: true, server: true, visibility: false },
    sourceCoverage: {
      gsc: { startDate: '2026-04-22', endDate: '2026-07-20', observedDays: 90 },
      ga4: { startDate: '2026-04-24', endDate: '2026-07-22', observedDays: 90 },
      server: { startDate: '2026-07-11', endDate: '2026-07-22', observedDays: 12 },
      visibility: null,
    },
    measurement: {
      window: `${period}d`,
      bucketDays: 30,
      filters: {
        hostScope: 'marketing',
        marketingHosts: ['demand-iq.com', 'demandiq.com'],
        pathPrefix: null,
        brandTerms: ['DemandIQ', 'Demand IQ'],
        queryMixScope: 'property',
      },
      acquisition: {
        status: acquisitionStatus,
        error: overrides?.acquisitionError ?? null,
        syncedAt: '2026-07-23T12:00:00.000Z',
        periods: sessionPeriods(sessionValues.map((value, index) => value + (paidValues[index] ?? 0))),
        channels: [
          { channelGroup: 'Paid Search', periods: sessionPeriods(paidValues) },
          { channelGroup: 'Organic Search', periods: sessionPeriods(sessionValues) },
        ],
        pages: [],
      },
      leads: {
        status: 'ready',
        error: null,
        syncedAt: '2026-07-23T12:00:00.000Z',
        attributionScope: leadScope,
        hostAndPathFiltersApplied: leadScope === 'landing-page',
        periods: eventPeriods(leadValues),
        channels: [
          { channelGroup: 'Organic Search', periods: eventPeriods(leadValues) },
        ],
      },
      searchDemand: {
        status: 'ready',
        latestDate: '2026-07-20',
        periods: sourcePeriods.map((row, index) => ({
          ...row,
          propertyClicks: period === 90 ? [5, 10, 10][index] : [10, 10][index],
          propertyImpressions: period === 90 ? [400, 500, 700][index] : [500, 700][index],
          reportedQueryClicks: period === 90 ? [4, 10, 10][index] : [10, 10][index],
          reportedQueryImpressions: period === 90 ? [300, 313, 500][index] : [313, 500][index],
          brandedClicks: period === 90 ? [3, 6, 8][index] : [6, 8][index],
          brandedImpressions: period === 90 ? [100, 120, 150][index] : [120, 150][index],
          nonBrandedClicks: period === 90 ? [1, 4, 2][index] : [4, 2][index],
          nonBrandedImpressions: period === 90 ? [200, 193, 350][index] : [193, 350][index],
          unreportedClicks: period === 90 ? [1, 0, 0][index] : [0, 0][index],
          unreportedImpressions: period === 90 ? [100, 187, 200][index] : [187, 200][index],
        })),
        queries: [],
        pages: [],
      },
    },
    gsc: {
      propertyTotals: { clicks: 25, impressions: 1_600 },
      namedBrand: { clicks: 17, impressions: 370 },
      namedNonBrand: { clicks: 7, impressions: 743 },
      suppressedOrUnreportedResidual: { clicks: 1, impressions: 487 },
      cohorts: sourcePeriods.map((row, index) => ({
        name: row.label,
        ...row,
        totals: {
          clicks: period === 90 ? [5, 10, 10][index] : [10, 10][index],
          impressions: period === 90 ? [400, 500, 700][index] : [500, 700][index],
        },
      })),
    },
    ga4: {
      organicSessions: sessionValues.reduce((sum, value) => sum + value, 0),
      blogOrganicSessions: sessionValues.reduce((sum, value) => sum + value, 0),
      cohorts: sourcePeriods.map((row, index) => ({
        name: row.label,
        ...row,
        organicSessions: sessionValues[index] ?? 0,
      })),
    },
    gaAiReferrals: null,
    blog: {
      pathRule: '/blog and descendants',
      gsc: {
        cohorts: sourcePeriods.map((row, index) => ({
          name: row.label,
          ...row,
          totals: {
            clicks: clickValues[index] ?? 0,
            impressions: impressionValues[index] ?? 0,
          },
        })),
      },
      ga4: {
        cohorts: sourcePeriods.map((row, index) => ({
          name: row.label,
          ...row,
          organicSessions: sessionValues[index] ?? 0,
        })),
      },
      server: {
        crawlerHits: { verified: 7, claimedUnverified: 0, unknownAiLike: 0 },
        userFetchHits: { verified: 5, claimedUnverified: 0, unknownAiLike: 0 },
        referralSessions: { total: 3, paid: 0, organic: 3, unknown: 0 },
      },
    },
    server: {
      crawlerHits: { verified: 7, claimedUnverified: 0, unknownAiLike: 0 },
      userFetchHits: { verified: 5, claimedUnverified: 0, unknownAiLike: 0 },
      referralSessions: { total: 3, paid: 0, organic: 3, unknown: 0 },
    },
    visibility: null,
    pages: [],
    findings: [
      {
        tone: 'positive',
        title: 'Blog search visibility increased',
        detail: 'Google showed blog pages 495 in the latest cohort versus 313 prior (+58%).',
      },
      {
        tone: 'caution',
        title: 'Blog clicks have not followed visibility yet',
        detail: 'Blog pages recorded 0 Google clicks in the latest cohort versus 4 prior.',
      },
      {
        tone: 'neutral',
        title: 'Lead trend is measured, not causal',
        detail: 'GA4 recorded 0 lead events in the latest cohort versus 4 prior; this does not establish cause.',
      },
      {
        tone: 'neutral',
        title: 'Paid-assisted brand search remains plausible',
        detail: 'GA4 recorded 50 Paid Search sessions and GSC reported 8 branded clicks; this is not proof of an assisted path.',
      },
    ],
    limitations: [
      {
        code: 'lead-attribution-not-causal',
        detail: 'Lead attribution is observational and does not prove SEO caused leads.',
      },
      ...(acquisitionStatus === 'error'
        ? [{
            code: 'acquisition-sync-error',
            detail: 'GA acquisition sync failed; last-good rows remain visible.',
          }]
        : []),
      ...(leadScope === 'channel'
        ? [{
            code: 'lead-channel-scope',
            detail: 'Lead attribution is channel-level; marketing-host and path filters do not apply.',
          }]
        : []),
    ],
  }
}

function renderPanel(handler?: Parameters<typeof mockFetch>[0]) {
  const restoreFetch = mockFetch(handler ?? ((url) => {
    const parsed = new URL(url, 'http://canonry.test')
    if (parsed.pathname.endsWith('/projects/test-project/organic-evidence')) {
      const period = Number(parsed.searchParams.get('period') ?? '90') as 60 | 90
      return jsonResponse(makeEvidence(period))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganicEvidencePanel projectName="test-project" />
    </QueryClientProvider>,
  )
}

test('shows decision-ready 90-day evidence without collapsing native GA channels into Other', async () => {
  renderPanel()

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Organic growth evidence' })).toBeTruthy()
  })

  expect(screen.getByRole('button', { name: '90 days' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('Blog search visibility increased')).toBeTruthy()
  expect(screen.getByText('Blog clicks have not followed visibility yet')).toBeTruthy()

  const blog = within(screen.getByRole('table', { name: 'Blog search and traffic cohorts' }))
  expect(within(blog.getByRole('row', { name: /Impressions/ })).getByText('495')).toBeTruthy()
  expect(within(blog.getByRole('row', { name: /Impressions/ })).getByText('313')).toBeTruthy()
  expect(within(blog.getByRole('row', { name: /Google clicks/ })).getByText('0')).toBeTruthy()
  expect(within(blog.getByRole('row', { name: /Google clicks/ })).getByText('4')).toBeTruthy()

  const acquisition = within(screen.getByRole('table', { name: 'GA4 sessions by native channel' }))
  const organic = within(acquisition.getByRole('row', { name: /Organic Search/ }))
  expect(organic.getByText('10')).toBeTruthy()
  expect(organic.getByText('35')).toBeTruthy()
  expect(organic.getByText('16')).toBeTruthy()
  const paid = within(acquisition.getByRole('row', { name: /Paid Search/ }))
  expect(paid.getByText('50')).toBeTruthy()
  expect(acquisition.queryByText('Other')).toBeNull()

  const leads = within(screen.getByRole('table', { name: 'GA4 lead events by cohort' }))
  expect(within(leads.getByRole('row', { name: /All measured leads/ })).getByText('0')).toBeTruthy()
  expect(within(leads.getByRole('row', { name: /All measured leads/ })).getByText('4')).toBeTruthy()
  expect(screen.getByText('Landing-page attribution')).toBeTruthy()

  const demand = within(screen.getByRole('table', { name: 'Latest Google search demand mix' }))
  expect(within(demand.getByRole('row', { name: /Branded/ })).getByText('8')).toBeTruthy()
  expect(within(demand.getByRole('row', { name: /Non-branded/ })).getByText('2')).toBeTruthy()
  expect(within(demand.getByRole('row', { name: /Suppressed or unreported/ })).getByText('200')).toBeTruthy()

  const server = within(screen.getByRole('table', { name: 'Server-side AI evidence' }))
  expect(within(server.getByRole('row', { name: /Verified crawler hits/ })).getByText('7')).toBeTruthy()
  expect(within(server.getByRole('row', { name: /Verified user fetches/ })).getByText('5')).toBeTruthy()
  expect(within(server.getByRole('row', { name: /Organic AI referral sessions/ })).getByText('3')).toBeTruthy()
})

test('refetches the composite as a real 60-day comparison', async () => {
  const requestedPeriods: string[] = []
  renderPanel((url) => {
    const parsed = new URL(url, 'http://canonry.test')
    if (parsed.pathname.endsWith('/projects/test-project/organic-evidence')) {
      const requested = parsed.searchParams.get('period') ?? '90'
      requestedPeriods.push(requested)
      return jsonResponse(makeEvidence(Number(requested) as 60 | 90))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await waitFor(() => expect(screen.getByText('Blog search visibility increased')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '60 days' }))

  await waitFor(() => {
    expect(screen.getByRole('button', { name: '60 days' }).getAttribute('aria-pressed')).toBe('true')
    expect(requestedPeriods).toContain('60')
  })

  const acquisition = within(screen.getByRole('table', { name: 'GA4 sessions by native channel' }))
  expect(acquisition.getByText('Previous')).toBeTruthy()
  expect(acquisition.getByText('Latest')).toBeTruthy()
  expect(acquisition.queryByText('Earliest')).toBeNull()
  expect(within(acquisition.getByRole('row', { name: /Organic Search/ })).getByText('35')).toBeTruthy()
  expect(within(acquisition.getByRole('row', { name: /Organic Search/ })).getByText('16')).toBeTruthy()
})

test('shows last-good sync errors, channel-only lead scope, and causal caveats beside the data', async () => {
  renderPanel((url) => {
    const parsed = new URL(url, 'http://canonry.test')
    if (parsed.pathname.endsWith('/projects/test-project/organic-evidence')) {
      return jsonResponse(makeEvidence(90, {
        acquisitionStatus: 'error',
        acquisitionError: 'quota exhausted',
        leadScope: 'channel',
      }))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await waitFor(() => expect(screen.getByText('Blog search visibility increased')).toBeTruthy())

  expect(screen.getByText(/GA4 acquisition sync error: quota exhausted/)).toBeTruthy()
  expect(screen.getByText('Showing last-good acquisition data')).toBeTruthy()
  expect(screen.getByText('Channel-level attribution')).toBeTruthy()
  expect(screen.getByText(/marketing-host and path filters do not apply/i)).toBeTruthy()
  expect(screen.getByText(/Lead attribution is observational and does not prove SEO caused leads/)).toBeTruthy()
  expect(screen.getByText('Paid-assisted brand search remains plausible')).toBeTruthy()
  expect(screen.getByText(/not proof of an assisted path/)).toBeTruthy()
  expect(screen.queryByText(/SEO generated leads/i)).toBeNull()
})
