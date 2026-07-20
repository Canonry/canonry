/**
 * Dates on the visibility trend chart.
 *
 * Two things this file pins that nothing else could:
 *
 *  1. The fixtures use FULL ISO timestamps, exactly what the API emits
 *     (`toISOString()`). `visibility-trend-section.test.tsx` feeds date-only
 *     strings like '2026-04-01', which exercises a branch production never
 *     takes — the one branch that was already guarded against timezone shift.
 *  2. The timezone is pinned WEST of UTC. A UTC-midnight bucket boundary
 *     rendered in New York reads as the previous day, which is how a sweep that
 *     ran 2026-07-20T01:52:51Z ended up displayed as "Jul 9, 2026". Under the
 *     default UTC test environment that shift is invisible.
 */
process.env.TZ = 'America/New_York'

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

afterEach(cleanup)

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
import { formatChartDateLabel, formatChartDateTick } from '../src/components/shared/ChartPrimitives.js'
import {
  formatBucketDateLabel,
  formatBucketDateTick,
  readBucketObservedRange,
} from '../src/lib/visibility-trend-helpers.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

// The reported production case: 66 days of history → 14-day buckets anchored at
// UTC midnight of the earliest run, so the final boundary is 2026-07-10 while
// the sweeps inside it ran on 07-14 and 07-20.
const BOUNDARY = '2026-07-10T00:00:00.000Z'
const POOLED_SWEEP = '2026-07-14T09:00:00.000Z'
const LATEST_SWEEP = '2026-07-20T01:52:51.000Z'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 1, total: 4, mentionRate, mentionedCount: 2 }
}

function bucket(over: Record<string, unknown>) {
  return {
    startDate: '2026-05-15T00:00:00.000Z',
    endDate: '2026-05-29T00:00:00.000Z',
    dataStartDate: '2026-05-15T19:38:00.000Z',
    dataEndDate: '2026-05-15T19:38:00.000Z',
    sweepCount: 1,
    citationRate: 0.25, cited: 1, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 },
    byProvider: { gemini: provider(0.25, 0.5) },
    modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-2.0-flash' } },
    ...over,
  }
}

const SINGLE_SWEEP_BUCKET = bucket({
  startDate: BOUNDARY,
  endDate: '2026-07-24T00:00:00.000Z',
  dataStartDate: LATEST_SWEEP,
  dataEndDate: LATEST_SWEEP,
  sweepCount: 1,
})

const POOLED_BUCKET = bucket({
  startDate: BOUNDARY,
  endDate: '2026-07-24T00:00:00.000Z',
  dataStartDate: POOLED_SWEEP,
  dataEndDate: LATEST_SWEEP,
  sweepCount: 2,
})

test('the pinned timezone really is west of UTC (guards the assertions below)', () => {
  // If this ever fails the rest of the file proves nothing — every assertion
  // would pass trivially under a UTC runner.
  expect(new Date(BOUNDARY).getUTCDate() - new Date(BOUNDARY).getDate()).toBe(1)
})

test('a bucket is dated from the sweep that produced it, not from its boundary', () => {
  // The bug in one assertion: the boundary says July 10, the sweep really ran
  // on July 20 at 01:52Z — which is the evening of July 19 for a New York
  // viewer, and that is the honest local answer to "when did this happen".
  expect(formatBucketDateLabel(SINGLE_SWEEP_BUCKET)).toBe('Jul 19, 2026')
  expect(formatBucketDateLabel(SINGLE_SWEEP_BUCKET)).not.toBe('Jul 9, 2026')
  expect(formatBucketDateTick(SINGLE_SWEEP_BUCKET)).toBe('7/19')
})

test('a bucket that pools several sweeps says so, with the real range', () => {
  expect(formatBucketDateLabel(POOLED_BUCKET)).toBe('Jul 14, 2026 – Jul 19, 2026 · 2 sweeps combined')
})

test('a bucket from an older API is reported as unavailable, never dated from the boundary', () => {
  const legacy = { ...SINGLE_SWEEP_BUCKET } as Record<string, unknown>
  delete legacy.dataStartDate
  delete legacy.dataEndDate
  delete legacy.sweepCount
  const legacyBucket = legacy as unknown as Parameters<typeof formatBucketDateLabel>[0]

  expect(readBucketObservedRange(legacyBucket)).toBeNull()
  expect(formatBucketDateLabel(legacyBucket)).toBe('Sweep date unavailable')
  // Blank rather than a boundary printed as a date.
  expect(formatBucketDateTick(legacyBucket)).toBe('')
})

test('the calendar formatters never shift a UTC-stamped value a day early', () => {
  // These take day-stamped values, which have no clock reading to localize.
  // 2026-07-10T00:00:00Z used to render "Jul 9, 2026" for a New York viewer.
  expect(formatChartDateLabel(BOUNDARY)).toBe('Jul 10, 2026')
  expect(formatChartDateTick(BOUNDARY)).toBe('7/10')
  // Date-only input is unchanged.
  expect(formatChartDateLabel('2026-03-15')).toBe('Mar 15, 2026')
  expect(formatChartDateTick('2026-03-15')).toBe('3/15')
})

function metricsDto(buckets: unknown[]) {
  return {
    window: 'all',
    buckets,
    overall: provider(0.5, 0.5),
    byProvider: { gemini: provider(0.5, 0.5) },
    trend: 'improving',
    mentionTrend: 'stable',
    queryChanges: [],
    modelAttribution: {},
  }
}

test('the rendered trend never shows a bucket boundary as a date', async () => {
  const restore = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto([bucket({}), POOLED_BUCKET]))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={[]} />
    </QueryClientProvider>,
  )

  // The accessible data table is the one surface that names every bucket.
  await screen.findByText('Jul 14, 2026 – Jul 19, 2026 · 2 sweeps combined')
  expect(screen.getByText('May 15, 2026')).toBeTruthy()

  // Neither the boundary's own day nor the day it shifts to in this timezone.
  expect(screen.queryByText(/Jul 10, 2026/)).toBeNull()
  expect(screen.queryByText(/Jul 9, 2026/)).toBeNull()
})
