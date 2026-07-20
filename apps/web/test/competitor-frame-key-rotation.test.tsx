import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

afterEach(cleanup)

// Same recharts stub as visibility-trend-section.test.tsx — the chart is inert
// in jsdom and this test only cares about the query key the section mounts.
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
    ReferenceLine: nul,
  }
})

import { VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

const EMPTY_METRICS = {
  window: 'all',
  buckets: [],
  overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
  byProvider: {},
  trend: 'stable',
  mentionTrend: 'stable',
  queryChanges: [],
  modelAttribution: {},
}

function analyticsMetricsKeys(queryClient: QueryClient): unknown[][] {
  return queryClient.getQueryCache()
    .getAll()
    .map(q => q.queryKey as unknown[])
    .filter(key => key[0] === 'analytics-metrics')
}

/**
 * `ProjectPage.handleAddCompetitor` / `handleRemoveCompetitor` deliberately do
 * NOT invalidate `['analytics-metrics', projectName]` after the write — the
 * same trade-off `queries/run-invalidations.ts` makes for a completed sweep.
 * Both rely on a key segment rotating instead: here it is `metricsFrameKey`,
 * `competitorFrameKey(competitorDomains)` of the same DB competitor list the
 * server builds the mention-share denominator from. This test is what makes
 * that deletion safe — if the frame key ever stops depending on the competitor
 * list, the page would silently serve a stale mention share with nothing left
 * to correct it.
 */
test('the trend key rotates when the competitor list changes, so no invalidation is needed', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(EMPTY_METRICS)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={['rival.example']} />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(analyticsMetricsKeys(queryClient).length).toBe(1))
  const before = analyticsMetricsKeys(queryClient)[0]!

  // A competitor add/remove reaches the section as a new `competitorDomains`.
  rerender(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection
        projectName="test-project"
        competitorDomains={['rival.example', 'newcomer.example']}
      />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(analyticsMetricsKeys(queryClient).length).toBe(2))
  const after = analyticsMetricsKeys(queryClient).find(key => key !== before)!
  expect(after).not.toEqual(before)
  // Only the frame-key segment moved: same project, window and revision.
  expect([after[0], after[1], after[2], after[4]]).toEqual([before[0], before[1], before[2], before[4]])
  expect(after[3]).not.toEqual(before[3])
})

test('a competitor list that differs only in order or case does not rotate the key', async () => {
  // The frame key normalizes (trim + lowercase + sort) before joining, so a
  // reordered or re-cased list is the same cache entry — a re-fetch there
  // would be pure waste, since the server denominator is unchanged too.
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(EMPTY_METRICS)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={['a.example', 'b.example']} />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(analyticsMetricsKeys(queryClient).length).toBe(1))

  rerender(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={[' B.example ', 'a.example']} />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(analyticsMetricsKeys(queryClient).length).toBe(1))
})
