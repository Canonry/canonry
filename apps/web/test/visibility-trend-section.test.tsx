import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MentionShareNoLocationBucket } from '@ainyc/canonry-contracts'

afterEach(cleanup)

// ChartPrimitives re-exports recharts; mock the whole module so the chart is
// inert in jsdom and the test can focus on controls + states.
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const nul = () => null
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    CartesianGrid: nul,
    XAxis: nul,
    YAxis: nul,
    Tooltip: nul,
    Legend: nul,
    Line: nul,
    Area: nul,
    Bar: nul,
    BarChart: passthrough,
    Cell: nul,
    ReferenceArea: nul,
  }
})

import { MentionShareTrendSection, VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 1, total: 4, mentionRate, mentionedCount: 2 }
}

function mentionShareObservation(
  rate: number | null,
  projectMentionEvents: number,
  competitorMentionEvents: number,
  answerObservations = 4,
  totalObservations = answerObservations,
) {
  const brandObservationTotal = projectMentionEvents + competitorMentionEvents
  return {
    rate,
    projectMentionEvents,
    competitorMentionEvents,
    projectMentionSnapshots: projectMentionEvents,
    competitorMentionSnapshots: competitorMentionEvents,
    brandMentionEvents: projectMentionEvents + competitorMentionEvents,
    answerObservations,
    totalObservations,
    projectOnlyObservations: projectMentionEvents,
    sharedObservations: 0,
    competitorOnlyObservations: competitorMentionEvents,
    unmentionedObservations: Math.max(answerObservations - brandObservationTotal, 0),
  }
}

function mentionShareMetric(
  rate: number | null,
  projectMentionEvents: number,
  competitorMentionEvents: number,
  answerObservations = 4,
  totalObservations = answerObservations,
  byProvider = {},
  byLocation = {},
) {
  return {
    ...mentionShareObservation(rate, projectMentionEvents, competitorMentionEvents, answerObservations, totalObservations),
    byProvider,
    byLocation,
  }
}

function metricsDto(buckets: unknown[]) {
  return {
    window: 'all',
    buckets,
    overall: provider(0.5, 0.5),
    byProvider: { gemini: provider(0.5, 0.5) },
    trend: 'improving',
    mentionTrend: 'stable',
    queryChanges: [],
  }
}

const TWO_BUCKETS = [
  {
    startDate: '2026-04-01', endDate: '2026-04-08',
    citationRate: 0.25, cited: 1, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: mentionShareMetric(0.25, 1, 3, 4, 4, {
      gemini: mentionShareObservation(0.25, 1, 3),
      openai: mentionShareObservation(0.25, 1, 3),
    }, {
      [MentionShareNoLocationBucket]: mentionShareObservation(0.25, 1, 3),
    }),
    byProvider: { gemini: provider(0.25, 0.5), openai: provider(0.5, 0.25) },
  },
  {
    startDate: '2026-04-08', endDate: '2026-04-15',
    citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: mentionShareMetric(0.75, 3, 1, 4, 4, {
      gemini: mentionShareObservation(0.75, 3, 1),
    }, {
      [MentionShareNoLocationBucket]: mentionShareObservation(0.75, 3, 1),
    }),
    byProvider: { gemini: provider(0.75, 0.5) },
  },
]

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" />
    </QueryClientProvider>,
  )
}

function renderMentionShareSection(competitorDomains: readonly string[] = ['competitor.com']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MentionShareTrendSection projectName="test-project" competitorDomains={competitorDomains} />
    </QueryClientProvider>,
  )
}

test('defaults to the by-engine view with a per-engine legend, and toggles to all-engines', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  expect(screen.getByText('Citations & mentions over time')).toBeTruthy()

  // The legend only renders once the DTO has loaded (and only in by-engine
  // mode) — wait on it rather than the chart skeleton, which shares the
  // `.visibility-trend-chart` class.
  const legend = await screen.findByRole('list', { name: 'Engines' })

  // Segmented controls are toggle buttons (aria-pressed). Metric is Cited /
  // Mentioned (no "Both"); Mentioned is the default.
  expect(screen.queryByRole('button', { name: 'Both' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Cited' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mentioned' }).getAttribute('aria-pressed')).toBe('true')

  // By engine is the default breakdown; All engines is the other mode.
  const byEngine = screen.getByRole('button', { name: 'By engine' })
  const allEngines = screen.getByRole('button', { name: 'All engines' })
  expect(byEngine.getAttribute('aria-pressed')).toBe('true')
  expect(allEngines.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()

  // The headline is the blended average across engines, tagged "avg".
  expect(screen.getByText('avg')).toBeTruthy()
  expect(screen.getByText('2 / 4 observations')).toBeTruthy()

  // The legend lists each engine with its latest value (a direct read of the
  // rightmost plotted point — gemini 50% in both buckets, openai 25% then gone).
  expect(within(legend).getByText('Gemini')).toBeTruthy()
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).getByText('50%')).toBeTruthy()
  expect(within(legend).getByText('25%')).toBeTruthy()

  // Switching to All engines presses it (no refetch) and drops the per-engine
  // legend + "avg" tag — the headline now matches the single plotted line.
  act(() => { fireEvent.click(allEngines) })
  expect(allEngines.getAttribute('aria-pressed')).toBe('true')
  expect(byEngine.getAttribute('aria-pressed')).toBe('false')
  expect(screen.queryByRole('list', { name: 'Engines' })).toBeNull()
  expect(screen.queryByText('avg')).toBeNull()
})

test('shows an empty state when there are no buckets yet', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto([]))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  await waitFor(() => {
    expect(screen.getByText(/Run a sweep to start tracking/)).toBeTruthy()
  })
})

test('renders mention-share trend from bucket metrics', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderMentionShareSection()

  expect(await screen.findByText('Mention distribution over time')).toBeTruthy()
  await waitFor(() => {
    expect(screen.getAllByText('75%').length).toBeGreaterThan(0)
  })
  expect(screen.getByText('Latest sample')).toBeTruthy()
  expect(screen.getByText('answer observations')).toBeTruthy()
  expect(screen.getByText('3 / 4 brand events were you')).toBeTruthy()
  expect(screen.getByText('3 project-only, 0 shared, 1 competitor-only, 0 neither')).toBeTruthy()
  expect(screen.getByText('75% derived share')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Outcome mix' }).getAttribute('aria-pressed')).toBe('true')
  const outcomes = screen.getByRole('list', { name: 'Observation outcomes' })
  expect(within(outcomes).getByText('Project only')).toBeTruthy()
  expect(within(outcomes).getByText('Competitor only')).toBeTruthy()
  expect(within(outcomes).getByText('Neither')).toBeTruthy()
  expect(within(outcomes).getByText('3 obs')).toBeTruthy()

  act(() => { fireEvent.click(screen.getByRole('button', { name: 'By engine' })) })
  const engines = screen.getByRole('list', { name: 'Engines' })
  expect(within(engines).getByText('Gemini')).toBeTruthy()
  expect(within(engines).getByText('OpenAI')).toBeTruthy()
  expect(within(engines).getByText('3 / 4 events, 4 obs')).toBeTruthy()

  act(() => { fireEvent.click(screen.getByRole('button', { name: 'By location' })) })
  const locations = await screen.findByRole('list', { name: 'Locations' })
  expect(within(locations).getByText('No location')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()
})

test('keeps mention-share headline counts aligned to the latest plotted bucket', async () => {
  const trailingNullBuckets = [
    TWO_BUCKETS[0],
    {
      ...TWO_BUCKETS[1],
      mentionShare: mentionShareMetric(null, 0, 0, 8, 8, {
        gemini: mentionShareObservation(null, 0, 0, 8, 8),
      }, {
        [MentionShareNoLocationBucket]: mentionShareObservation(null, 0, 0, 8, 8),
      }),
    },
  ]
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(trailingNullBuckets))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderMentionShareSection()

  await waitFor(() => {
    expect(screen.getByText('No brand mention events in sample')).toBeTruthy()
  })
  expect(screen.getByText('0 project-only, 0 shared, 0 competitor-only, 8 neither')).toBeTruthy()
  expect(screen.queryByText('25% derived share')).toBeNull()
})

test('prompts for competitors before rendering mention-share history', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderMentionShareSection([])

  await waitFor(() => {
    expect(screen.getByText(/Add tracked competitors/)).toBeTruthy()
  })
})

test('refetches mention-share metrics when the competitor frame changes', async () => {
  const requests: string[] = []
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      requests.push(url)
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MentionShareTrendSection projectName="test-project" competitorDomains={['competitor.com']} />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(requests).toHaveLength(1)
  })

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <MentionShareTrendSection projectName="test-project" competitorDomains={['competitor.com', 'new-rival.com']} />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(requests).toHaveLength(2)
  })
})
