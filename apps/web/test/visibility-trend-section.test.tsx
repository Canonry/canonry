import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

import { VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import type { CitationInsightVm } from '../src/view-models.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 1, total: 4, mentionRate, mentionedCount: 2 }
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
    mentionShare: { rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 },
    byProvider: { gemini: provider(0.25, 0.5), openai: provider(0.5, 0.25) },
  },
  {
    startDate: '2026-04-08', endDate: '2026-04-15',
    citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 },
    byProvider: { gemini: provider(0.75, 0.5) },
  },
]

function renderSection(competitorDomains: readonly string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={competitorDomains} />
    </QueryClientProvider>,
  )
}

function renderSectionWithEvidence(visibilityEvidence: readonly CitationInsightVm[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" visibilityEvidence={visibilityEvidence} />
    </QueryClientProvider>,
  )
}

function evidence(providerName: string, models: string[]): CitationInsightVm {
  return {
    id: `${providerName}-evidence`,
    query: `${providerName} query`,
    provider: providerName,
    model: models.at(-1) ?? null,
    location: null,
    citationState: 'cited',
    visibilityState: 'visible',
    changeLabel: 'Stable',
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: models.map((model, index) => ({
      runId: `${providerName}-${index}`,
      citationState: 'cited',
      createdAt: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      model,
    })),
  }
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

  expect(screen.getByText('Answer-engine trend')).toBeTruthy()

  // The legend only renders once the DTO has loaded (and only in by-engine
  // mode) — wait on it rather than the chart skeleton, which shares the
  // `.visibility-trend-chart` class.
  const legend = await screen.findByRole('list', { name: 'Engines' })

  // Segmented controls are toggle buttons (aria-pressed). Metric is Cited /
  // Mentioned (no "Both"); Mentioned is the default.
  expect(screen.queryByRole('button', { name: 'Both' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Cited' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mention share' })).toBeTruthy()
  const mentioned = screen.getByRole('button', { name: 'Mentioned' })
  expect(mentioned.getAttribute('aria-pressed')).toBe('true')
  expect(mentioned.getAttribute('title')).toBeNull()
  const mentionedDescriptionId = mentioned.getAttribute('aria-describedby')
  expect(mentionedDescriptionId).toBeTruthy()
  expect(document.getElementById(mentionedDescriptionId!)?.textContent).toBe('Your brand or domain appears in the answer text.')

  // By engine is the default breakdown; All engines is the other mode.
  const byEngine = screen.getByRole('button', { name: 'By engine' })
  const allEngines = screen.getByRole('button', { name: 'All engines' })
  expect(byEngine.getAttribute('aria-pressed')).toBe('true')
  expect(allEngines.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()

  // The headline is the blended average across engines, tagged "avg".
  expect(screen.getByText('avg')).toBeTruthy()

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

test('labels per-engine legend entries with model versions and model changes', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSectionWithEvidence([
    evidence('gemini', ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash']),
    evidence('openai', ['gpt-5.4']),
  ])

  const legend = await screen.findByRole('list', { name: 'Engines' })
  expect(within(legend).getByText('Gemini')).toBeTruthy()
  expect(within(legend).getByText('gemini-2.5-flash')).toBeTruthy()
  expect(within(legend).getByText('gemini-2.0-flash')).toBeTruthy()
  expect(within(legend).queryByText('gemini-1.5-flash')).toBeNull()
  expect(within(legend).getByText('+1')).toBeTruthy()
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).getByText('gpt-5.4')).toBeTruthy()
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

test('renders mention-share as a metric view and hides the engine split', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection(['competitor.com'])

  await screen.findByRole('list', { name: 'Engines' })
  const mentionShare = screen.getByRole('button', { name: 'Mention share' })
  act(() => { fireEvent.click(mentionShare) })

  expect(mentionShare.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('group', { name: 'Series' })).toBeNull()
  expect(screen.queryByRole('list', { name: 'Engines' })).toBeNull()
  expect(screen.getByText('75%')).toBeTruthy()
  expect(screen.getByRole('img', { name: /Mention share trend chart/i })).toBeTruthy()
  expect(screen.getByText(/75% mention share, 3 of 4 brand mentions were you/)).toBeTruthy()
})

test('prompts for competitors before rendering the mention-share metric view', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection([])

  await screen.findByRole('list', { name: 'Engines' })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Mention share' })) })

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
      <VisibilityTrendSection projectName="test-project" competitorDomains={['competitor.com']} />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(requests).toHaveLength(1)
  })

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={['competitor.com', 'new-rival.com']} />
    </QueryClientProvider>,
  )

  await waitFor(() => {
    expect(requests).toHaveLength(2)
  })
})
