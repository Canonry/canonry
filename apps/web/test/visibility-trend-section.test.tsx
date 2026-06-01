import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    byProvider: { gemini: provider(0.25, 0.5), openai: provider(0.5, 0.25) },
  },
  {
    startDate: '2026-04-08', endDate: '2026-04-15',
    citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
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

test('renders header, control toggles, and trend badges from the DTO', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  const { container } = renderSection()

  expect(screen.getByText('Citations & mentions over time')).toBeTruthy()

  // Chart renders once the DTO has loaded — wait on it.
  await waitFor(() => {
    expect(container.querySelector('.visibility-trend-chart')).toBeTruthy()
  })

  // Segmented controls are toggle buttons (aria-pressed). Metric is Cited /
  // Mentioned (no "Both"); Mentioned is the default.
  expect(screen.queryByRole('button', { name: 'Both' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Cited' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mentioned' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Overall' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'By provider' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()

  // Switching to By provider presses it (no refetch).
  const byProvider = screen.getByRole('button', { name: 'By provider' })
  expect(byProvider.getAttribute('aria-pressed')).toBe('false')
  act(() => { fireEvent.click(byProvider) })
  expect(byProvider.getAttribute('aria-pressed')).toBe('true')
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
