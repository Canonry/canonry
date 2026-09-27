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
    ReferenceLine: nul,
  }
})

import { VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 1, total: 4, mentionRate, mentionedCount: 2 }
}

type RateChange = { first: number; latest: number; delta: number } | null
interface WindowChange { citationRate: RateChange; mentionRate: RateChange; mentionShare: RateChange }

const NO_WINDOW_CHANGE: WindowChange = { citationRate: null, mentionRate: null, mentionShare: null }

function metricsDto(
  buckets: unknown[],
  mentionShareScope: 'non-brand' | 'pooled' = 'non-brand',
  windowChange: WindowChange = NO_WINDOW_CHANGE,
) {
  return {
    window: 'all',
    mentionShareScope,
    buckets,
    overall: provider(0.5, 0.5),
    byProvider: { gemini: provider(0.5, 0.5) },
    trend: 'improving',
    mentionTrend: 'stable',
    windowChange,
    queryChanges: [],
    modelAttribution: {
      gemini: {
        latestObservation: {
          observedAt: '2026-04-08T00:00:00.000Z',
          state: { status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false },
        },
        events: [{
          observedAt: '2026-04-08T00:00:00.000Z',
          bucketStartDate: '2026-04-08T00:00:00.000Z',
          from: { status: 'known', model: 'gemini-2.0-flash' },
          to: { status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false },
        }],
      },
    },
  }
}

// Shaped like the API actually emits: FULL ISO everywhere (the route stamps
// `toISOString()`), with the synthetic bucket boundary deliberately NOT equal to
// the sweep times inside it — that gap is what production looks like and what a
// date-only fixture cannot reproduce. Date rendering itself is pinned in
// `visibility-trend-dates.test.tsx`, which also pins a non-UTC timezone.
const TWO_BUCKETS = [
  {
    startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-08T00:00:00.000Z',
    dataStartDate: '2026-04-03T14:20:00.000Z', dataEndDate: '2026-04-03T14:20:00.000Z', sweepCount: 1,
    citationRate: 0.25, cited: 1, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { scope: 'non-brand', rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 },
    byProvider: { gemini: provider(0.25, 0.5), openai: provider(0.5, 0.25) },
    modelEvidenceByProvider: {
      gemini: { status: 'known', model: 'gemini-2.0-flash' },
      openai: { status: 'unknown' },
    },
  },
  {
    startDate: '2026-04-08T00:00:00.000Z', endDate: '2026-04-15T00:00:00.000Z',
    dataStartDate: '2026-04-11T08:05:00.000Z', dataEndDate: '2026-04-11T08:05:00.000Z', sweepCount: 1,
    citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { scope: 'non-brand', rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 },
    byProvider: { gemini: provider(0.75, 0.5) },
    modelEvidenceByProvider: {
      gemini: { status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false },
    },
  },
]

/** What the server reports for TWO_BUCKETS: first bucket to latest, per series. */
const TWO_BUCKETS_CHANGE: WindowChange = {
  citationRate: { first: 0.25, latest: 0.75, delta: 0.5 },
  mentionRate: { first: 0.5, latest: 0.5, delta: 0 },
  mentionShare: { first: 0.25, latest: 0.75, delta: 0.5 },
}

function renderSection(competitorDomains: readonly string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={competitorDomains} />
    </QueryClientProvider>,
  )
}

test('defaults to the by-engine view with a per-engine legend, and toggles to all-engines', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
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

  // The headline is the blended average across engines, tagged "avg". Mentioned
  // sits at 0.5 in both buckets, so its change reads as none.
  expect(screen.getByText('avg')).toBeTruthy()
  expect(screen.getByText('0 pts')).toBeTruthy()
  expect(screen.getByText('Mentioned rate across 2 sweeps. Latest 50.0%, no change over the period.')).toBeTruthy()

  // The legend lists each engine with its latest value (a direct read of the
  // rightmost plotted point — gemini 50% in both buckets, openai 25% then gone),
  // in the shared one-decimal percent format.
  expect(within(legend).getByText('Gemini')).toBeTruthy()
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).getByText('50.0%')).toBeTruthy()
  expect(within(legend).getByText('25.0%')).toBeTruthy()

  // Switching to All engines presses it (no refetch) and drops the per-engine
  // legend + "avg" tag — the headline now matches the single plotted line.
  act(() => { fireEvent.click(allEngines) })
  expect(allEngines.getAttribute('aria-pressed')).toBe('true')
  expect(byEngine.getAttribute('aria-pressed')).toBe('false')
  expect(screen.queryByRole('list', { name: 'Engines' })).toBeNull()
  expect(screen.queryByText('avg')).toBeNull()
})

test('labels per-engine legend entries from analytics bucket evidence and surfaces categorical model changes', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  const legend = await screen.findByRole('list', { name: 'Engines' })
  expect(within(legend).getByText('Gemini')).toBeTruthy()
  expect(within(legend).getByText('Mixed: gemini-2.0-flash, gemini-2.5-flash')).toBeTruthy()
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).getByText('Unknown model')).toBeTruthy()
  expect(screen.getByText('Model evidence changes')).toBeTruthy()
  expect(screen.getByText(/Gemini: gemini-2.0-flash → Mixed: gemini-2.0-flash, gemini-2.5-flash/)).toBeTruthy()
  // Neither optional field is present on this DTO, so the change is dated
  // plainly and no partial-history note appears.
  expect(screen.queryByText(/on or before/)).toBeNull()
  expect(screen.queryByText(/Showing the/)).toBeNull()
})

test('dates an anchored change "on or before" and says how much history is shown', async () => {
  const anchored = metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE)
  Object.assign(anchored.modelAttribution.gemini.events[0]!, { fromPreWindowAnchor: true })
  Object.assign(anchored.modelAttribution.gemini, { eventTotal: 84 })

  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(anchored)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  // The change can only be dated to the last sweep BEFORE the window, so the
  // row must not read as an event that happened on that bucket's date.
  expect(await screen.findByText(/on or before/)).toBeTruthy()
  // The server caps per provider, so the note must name the engine whose
  // history is clipped rather than implying every engine's list is partial.
  expect(screen.getByText(/^Gemini: showing the most recent 1 of 84 changes\.$/)).toBeTruthy()
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

test('carries pooled classification-unavailable scope through an empty response', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto([], 'pooled'))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection(['competitor.com'])
  await screen.findByText('Run a sweep to start tracking citations and mentions over time.')
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Mention share' })) })

  expect(screen.getByText(/pooled queries.*classification unavailable/i)).toBeTruthy()
})

test('renders mention-share as a metric view and hides the engine split', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
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
  expect(screen.getByText('75.0%')).toBeTruthy()
  // 0.25 to 0.75 across the two plotted points.
  expect(screen.getByText('+50.0 pts')).toBeTruthy()
  expect(screen.getByText(/Latest 75\.0%, up 50\.0 points over the period\./)).toBeTruthy()
  expect(screen.getByRole('img', { name: /Mention share.*non-brand queries.*trend chart/i })).toBeTruthy()
  expect(screen.getByText(/75\.0% mention share for non-brand queries, 3 of 4 brand mentions were you/)).toBeTruthy()
  expect(screen.getAllByText('Mention share · non-brand queries').length).toBeGreaterThan(0)
})

test('reads the head and legend from the API rates, so a rate near either end never prints as 0% or 100%', async () => {
  // The chart rows round 0.0004 to 0 and 0.9996 to 100 for the axis.
  const edgeBuckets = [
    { ...TWO_BUCKETS[0]!, mentionRate: 0.9996, byProvider: { gemini: provider(0.25, 0.5) } },
    { ...TWO_BUCKETS[1]!, mentionRate: 0.0004, byProvider: { gemini: provider(0.75, 0.9996) } },
  ]
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(edgeBuckets, 'non-brand', {
        ...TWO_BUCKETS_CHANGE,
        mentionRate: { first: 0.9996, latest: 0.0004, delta: -0.9992 },
      }))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  const legend = await screen.findByRole('list', { name: 'Engines' })
  // Head: the blended mentioned rate, 0.9996 then 0.0004.
  expect(screen.getByText('<0.1%')).toBeTruthy()
  expect(screen.getByText('-99.9 pts')).toBeTruthy()
  expect(screen.getByText('Mentioned rate across 2 sweeps. Latest <0.1%, down 99.9 points over the period.')).toBeTruthy()
  // Legend: gemini's latest mentioned rate.
  expect(within(legend).getByText('>99.9%')).toBeTruthy()
  expect(screen.queryByText('0%')).toBeNull()
  expect(screen.queryByText('100%')).toBeNull()
})

test('prints the server change across the window, never a subtraction of the plotted rates', async () => {
  // The buckets plot 0.25 then 0.75 for Cited, but the server reports its own
  // change. The head must print that figure, so a client-side subtraction
  // (+50.0 pts) would fail here.
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', {
        ...TWO_BUCKETS_CHANGE,
        citationRate: { first: 0.25, latest: 0.75, delta: 0.1234 },
      }))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()
  await screen.findByRole('list', { name: 'Engines' })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cited' })) })

  expect(screen.getByText('+12.3 pts')).toBeTruthy()
  expect(screen.queryByText('+50.0 pts')).toBeNull()
  expect(screen.getByText('Cited rate across 2 sweeps. Latest 75.0%, up 12.3 points over the period.')).toBeTruthy()
})

test('shows the latest rate with no change when the server has none to report', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', NO_WINDOW_CHANGE))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()
  await screen.findByRole('list', { name: 'Engines' })

  // Two plotted buckets, but no server change: the head prints the latest
  // rate and no delta, rather than deriving one.
  expect(document.querySelector('.visibility-trend-current-value')?.textContent).toBe('50.0%')
  expect(document.querySelector('.visibility-trend-current-delta')).toBeNull()
  expect(screen.getByText('Mentioned rate across 2 sweeps. Latest 50.0%.')).toBeTruthy()
})

test('labels a pooled mention-share trend as classification unavailable', async () => {
  const pooledBuckets = TWO_BUCKETS.map(bucket => ({
    ...bucket,
    mentionShare: { ...bucket.mentionShare, scope: 'pooled' },
  }))
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(pooledBuckets, 'non-brand', TWO_BUCKETS_CHANGE))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection(['competitor.com'])
  await screen.findByRole('list', { name: 'Engines' })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Mention share' })) })

  expect(screen.getByRole('img', { name: /Mention share.*pooled queries.*classification unavailable.*trend chart/i })).toBeTruthy()
  expect(screen.getAllByText('Mention share · pooled queries · classification unavailable').length).toBeGreaterThan(0)
})

test('prompts for competitors before rendering the mention-share metric view', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
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
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
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

test('files a change inherited from before the window under its own heading, not among the dated changes', async () => {
  const anchored = metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE)
  Object.assign(anchored.modelAttribution.gemini.events[0]!, {
    fromPreWindowAnchor: true,
    anchorObservedAt: '2026-03-25T00:00:00.000Z',
  })

  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(anchored)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  // Grouped separately, so nothing places it on a date inside the chart…
  expect(await screen.findByText('Changed before this date range')).toBeTruthy()
  // …and the lower bound is surfaced, so the operator gets a closed range.
  expect(screen.getByText(/last seen gemini-2\.0-flash on/)).toBeTruthy()
})

test('says what the engines actually answered with and flags a substitution in plain language', async () => {
  const withServed = metricsDto(TWO_BUCKETS)
  Object.assign(withServed, {
    servedModelAttribution: {
      openai: {
        latestObservation: {
          observedAt: '2026-04-08T00:00:00.000Z',
          state: { status: 'known', model: 'gpt-5.6-sol' },
        },
        events: [],
        eventTotal: 0,
        latestServedModelIds: ['gpt-5.6-sol'],
      },
    },
    modelServiceMismatch: {
      openai: {
        observedAt: '2026-04-08T00:00:00.000Z',
        configured: { status: 'known', model: 'gpt-5.6' },
        served: { status: 'known', model: 'gpt-5.6-sol' },
      },
    },
  })

  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(withServed)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  expect(await screen.findByText('What the engines answered with')).toBeTruthy()
  expect(screen.getByText(/OpenAI: gpt-5\.6-sol — not the gpt-5\.6 you selected/)).toBeTruthy()
})

test('says nothing about served models when the API omits them', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS, 'non-brand', TWO_BUCKETS_CHANGE))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  await screen.findByText('Model evidence changes')
  expect(screen.queryByText('What the engines answered with')).toBeNull()
})

test('hides model details and sweep commentary when there are no model changes', async () => {
  const unchanged = metricsDto([TWO_BUCKETS[0]])
  Object.assign(unchanged, {
    modelAttribution: {
      gemini: {
        latestObservation: {
          observedAt: '2026-04-03T14:20:00.000Z',
          state: { status: 'known', model: 'gemini-2.0-flash' },
        },
        events: [],
      },
    },
    servedModelAttribution: {
      gemini: {
        latestObservation: {
          observedAt: '2026-04-03T14:20:00.000Z',
          state: { status: 'known', model: 'gemini-2.0-flash' },
        },
        events: [],
        eventTotal: 0,
        latestServedModelIds: ['gemini-2.0-flash'],
      },
    },
  })

  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(unchanged)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection(['competitor.com'])

  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByText('Model evidence changes')).toBeNull()
  expect(screen.queryByText('No model evidence changes in this window.')).toBeNull()
  expect(screen.queryByText('What the engines answered with')).toBeNull()
  expect(screen.queryByText('Only one sweep so far. The trend line fills in after the next run.')).toBeNull()

  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Mention share' })) })
  expect(screen.queryByText(/Only one .* mention-share point so far/)).toBeNull()
})

const CLOSING_LINE = 'rather than from a real change in how AI answers about you, so compare periods carefully.'

/** One confirmed update. The `summary` is a LEGACY field an older server used
 *  to send, kept here deliberately: it is the hostile wording this lane
 *  replaced, so a surface that ever renders the server's sentence again instead
 *  of building its own fails these tests loudly. */
const OPENAI_CHANGE = {
  modelIds: ['chat-latest'],
  changeCount: 1,
  unverifiedChangeCount: 0,
  firstChangeDate: '2026-06-24',
  lastChangeDate: '2026-06-24',
  summary: 'The model behind "chat-latest" changed on 2026-06-24, inside this reporting period. '
    + 'Part of any movement in this number comes from that change and not from how often AI names you.',
}

const PERPLEXITY_CHANGE = {
  modelIds: ['sonar-latest'],
  changeCount: 1,
  unverifiedChangeCount: 0,
  firstChangeDate: '2026-06-10',
  lastChangeDate: '2026-06-10',
  summary: 'The model behind "sonar-latest" changed on 2026-06-10, inside this reporting period. '
    + 'Part of any movement in this number comes from that change and not from how often AI names you.',
}

function mockMetrics(extra?: Record<string, unknown>) {
  return mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse({ ...metricsDto(TWO_BUCKETS), ...extra })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

test('meets the reader with the model-update caveat before the headline number', async () => {
  onTestFinished(mockMetrics({ modelPointerChanges: { openai: OPENAI_CHANGE } }))

  renderSection()

  const note = await screen.findByText(/The model behind ChatGPT/)
  expect(note.textContent).toBe(
    'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
    + `Some of the movement in these numbers may come from this update ${CLOSING_LINE}`,
  )
  // The point of the placement: the number the operator is about to send to a
  // client must not be readable before the caveat. Above the chart is not
  // enough — the headline value and its delta sit in the section head, above
  // the chart too.
  const headline = document.querySelector('.visibility-trend-current-value')!
  expect(note.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const chart = document.querySelector('.visibility-trend-chart')!
  expect(note.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('states one fact per affected engine and closes with a single consequence', async () => {
  onTestFinished(mockMetrics({
    modelPointerChanges: { openai: OPENAI_CHANGE, perplexity: PERPLEXITY_CHANGE },
  }))

  renderSection()

  const note = await screen.findByText(/The model behind ChatGPT/)
  expect(note.textContent).toBe(
    'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
    + 'The model behind Perplexity was updated on 2026-06-10, inside this period. '
    + `Some of the movement in these numbers may come from these updates ${CLOSING_LINE}`,
  )
  // Two engines are two facts and ONE warning. Repeating the consequence per
  // engine read as two separate alarms about the same three numbers.
  const sentences = note.textContent!.split('. ').map(s => s.trim())
  expect(new Set(sentences).size).toBe(sentences.length)
})

test('does not render model-pointer commentary when no update is on record', async () => {
  onTestFinished(mockMetrics({
    modelPointerChanges: { openai: { modelIds: ['chat-latest'], changeCount: 0, unverifiedChangeCount: 0 } },
  }))

  renderSection()

  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByText('No model updates are on record for ChatGPT in this period.')).toBeNull()
})

test('renders nothing at all when the API omits the field or reports no exposure', async () => {
  const restore = mockMetrics()
  onTestFinished(restore)

  renderSection()

  // Wait for the loaded chart before asserting an absence, so this cannot pass
  // merely because the DTO had not arrived yet.
  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByText(/The model behind/)).toBeNull()
  expect(screen.queryByText(/No model updates are on record/)).toBeNull()

  cleanup()
  restore()

  onTestFinished(mockMetrics({ modelPointerChanges: {} }))
  renderSection()
  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByText(/The model behind/)).toBeNull()
  expect(screen.queryByText(/No model updates are on record/)).toBeNull()
})
