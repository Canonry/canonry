import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { formatCalendarDay } from '@ainyc/canonry-contracts'

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
import { cancelledSweepBetweenMetrics, removedAndReAddedMetrics, roundTripInsidePointMetrics } from './basket-scenarios-fixture.js'

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

/** The "What changed" disclosure under the trend card. */
function whatChanged(): HTMLElement {
  return document.querySelector<HTMLElement>('details.av-wc')!
}

/** Each change row as [group, date, from, to]; a continued group names itself for screen readers only. */
function changeRows(root: HTMLElement): string[][] {
  return [...root.querySelectorAll('.av-change-table tbody tr')].map(row => [...row.children].map(cell => (cell.textContent ?? '').replace(/\u00a0/g, ' ')))
}

/** The bullets of the Details list directly under `root`. */
function detailsText(root: Element): string[] {
  const details = [...root.querySelectorAll(':scope > details.av-details, :scope .av-wc-body > details.av-details')][0]
  return [...(details?.querySelectorAll('li') ?? [])].map(item => item.textContent ?? '')
}

function renderSection(competitorDomains: readonly string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={competitorDomains} />
    </QueryClientProvider>,
  )
}

// These model events and anchors are observed instants at UTC midnight, not
// calendar dates. A New York viewer saw them on the preceding evening.
const MODEL_EVENT_TIMEZONES = [
  { timezone: 'UTC', changeDay: 'Apr 8', anchorDay: 'Mar 25' },
  { timezone: 'America/New_York', changeDay: 'Apr 7', anchorDay: 'Mar 24' },
  { timezone: 'Pacific/Auckland', changeDay: 'Apr 8', anchorDay: 'Mar 25' },
]

function observeInTimezone(timezone: string) {
  const original = process.env.TZ
  process.env.TZ = timezone
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T14:00:00.000Z'))
  onTestFinished(() => {
    vi.useRealTimers()
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
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

  expect(screen.getByRole('heading', { name: /AI answers over time/ })).toBeTruthy()

  // The legend only renders once the DTO has loaded (and only in by-engine
  // mode) — wait on it rather than the chart skeleton, which shares the
  // `.visibility-trend-chart` class.
  const legend = await screen.findByRole('list', { name: 'Engines' })

  // The controls are radio groups, like every AI Visibility card's. Metric is
  // Cited / Mentioned / Mention share (no "Both"); Mentioned is the default.
  expect(screen.queryByRole('radio', { name: 'Both' })).toBeNull()
  expect(screen.getByRole('radio', { name: 'Cited' })).toBeTruthy()
  expect(screen.getByRole('radio', { name: 'Mention share' })).toBeTruthy()
  const mentioned = screen.getByRole('radio', { name: 'Mentioned' })
  expect(mentioned.getAttribute('aria-checked')).toBe('true')
  expect(mentioned.getAttribute('title')).toBeNull()
  const mentionedDescriptionId = mentioned.getAttribute('aria-describedby')
  expect(mentionedDescriptionId).toBeTruthy()
  expect(document.getElementById(mentionedDescriptionId!)?.textContent).toBe('Your brand or domain appears in the answer text.')

  // By engine is the default breakdown; All engines is the other mode.
  const byEngine = screen.getByRole('radio', { name: 'By engine' })
  const allEngines = screen.getByRole('radio', { name: 'All engines' })
  expect(byEngine.getAttribute('aria-checked')).toBe('true')
  expect(allEngines.getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('radio', { name: 'All' })).toBeTruthy()

  // The headline pools every answer, with its base beside it, and Details says
  // it is not an engine average. Mentioned sits at 0.5 in both buckets and the
  // query set held still, so its change reads as none.
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('no change')
  expect(document.querySelector('.visibility-trend-current-detail')?.textContent).toBe('· 2 of 4 answers')
  expect(screen.getByText('Mentioned rate across 2 sweeps. Latest 50.0%, no change over the period.')).toBeTruthy()
  expect(detailsText(document.querySelector('.visibility-trend')!)).toEqual([
    expect.stringMatching(/^Base: Apr 3(, 2026)? point$/),
    '50.0% pools all answers; not an average of engines',
  ])

  // The legend lists each engine with its latest value (a direct read of the
  // rightmost plotted point — gemini 50% in both buckets, openai 25% then gone),
  // in the shared one-decimal percent format.
  expect(within(legend).getByText('Gemini')).toBeTruthy()
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).getByText('50.0%')).toBeTruthy()
  expect(within(legend).getByText('25.0%')).toBeTruthy()

  // Switching to All engines presses it (no refetch) and drops the per-engine
  // legend and the pooling note: the headline now matches the one plotted line.
  act(() => { fireEvent.click(allEngines) })
  expect(allEngines.getAttribute('aria-checked')).toBe('true')
  expect(byEngine.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('list', { name: 'Engines' })).toBeNull()
  expect(screen.queryByText(/pools all answers/)).toBeNull()
})

test.each(MODEL_EVENT_TIMEZONES)('keeps model names out of the legend and lists each model change in What changed ($timezone)', async ({ timezone, changeDay }) => {
  observeInTimezone(timezone)
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
  expect(within(legend).getByText('OpenAI')).toBeTruthy()
  expect(within(legend).queryByText(/gemini-2|Unknown model/)).toBeNull()

  const changes = whatChanged()
  // The latest point (Apr 11) brought nothing new, so the line names the newest change.
  expect(changes.querySelector('.av-wc-summary')?.textContent).toBe(`No changes since ${changeDay}`)
  expect(changes.querySelector('.av-wc-toggle')?.textContent).toMatch(/^Show all 1/)
  expect(changeRows(changes)).toEqual([
    ['Gemini', changeDay, 'gemini-2.0-flash', 'gemini-2.0-flash, gemini-2.5-flash'],
  ])
  // Model names left the legend, so a latest point that pools two models is said in Details.
  expect(detailsText(changes)).toEqual(['Apr 11 point mixes Gemini models: gemini-2.0-flash and gemini-2.5-flash'])
  // Neither optional field is present on this DTO, so the change is dated
  // plainly and no partial-history note appears.
  expect(screen.queryByText(/on or before/)).toBeNull()
  expect(screen.queryByText(/most recent/)).toBeNull()
})

test.each(MODEL_EVENT_TIMEZONES)('dates an anchored change "on or before" and says how much history is shown ($timezone)', async ({ timezone, changeDay }) => {
  observeInTimezone(timezone)
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
  expect(await screen.findByText(`on or before ${changeDay}`)).toBeTruthy()
  // The server caps per provider, so the note must name the engine whose
  // history is clipped rather than implying every engine's list is partial.
  expect(detailsText(whatChanged())).toContain('Gemini: most recent 1 of 84 changes')
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
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })

  expect(screen.getByText(/No answer-text brand mentions for you or tracked competitors in all answers/)).toBeTruthy()
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
  const mentionShare = screen.getByRole('radio', { name: 'Mention share' })
  act(() => { fireEvent.click(mentionShare) })

  expect(mentionShare.getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('radiogroup', { name: 'Series' })).toBeNull()
  expect(screen.queryByRole('list', { name: 'Engines' })).toBeNull()
  expect(document.querySelector('.visibility-trend-current-value')?.textContent).toBe('75.0%')
  // 0.25 to 0.75 across the two plotted points, in words, over its base.
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('up 50.0 points')
  expect(document.querySelector('.visibility-trend-current-detail')?.textContent).toBe('· 3 of 4 tracked-brand mentions')
  expect(screen.getByText(/Latest 75\.0%, up 50\.0 points over the period\./)).toBeTruthy()
  // The headline names mention share's scope, as it did before the cleanup,
  // and assistive tech hears it with the name.
  expect(document.querySelector('.visibility-trend-current-label')?.textContent).toBe('Mention share in non-brand answers')
  expect(screen.getByRole('img', { name: /^Mention share in non-brand answers trend chart/ })).toBeTruthy()
  expect(screen.getByText(/75\.0% mention share in non-brand answers, 3 of 4 tracked-brand mentions were you/)).toBeTruthy()
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
  expect(document.querySelector('.visibility-trend-current-value')?.textContent).toBe('<0.1%')
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('down 99.9 points')
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
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Cited' })) })

  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('up 12.3 points')
  expect(screen.queryByText('up 50.0 points')).toBeNull()
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
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })

  // "All answers", as the title's ⓘ says, never "pooled".
  expect(screen.getByRole('img', { name: /^Mention share in all answers trend chart/ })).toBeTruthy()
  expect(document.querySelector('.visibility-trend-current-label')?.textContent).toBe('Mention share in all answers')
  expect(screen.queryByText(/pooled|classification unavailable/i)).toBeNull()
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
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })

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

test.each(MODEL_EVENT_TIMEZONES)('files a change inherited from before the window under its own heading, not among the dated changes ($timezone)', async ({ timezone, changeDay, anchorDay }) => {
  observeInTimezone(timezone)
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

  // Dated "on or before", so nothing places it on a date inside the chart...
  expect(await screen.findByText(`on or before ${changeDay}`)).toBeTruthy()
  // ...and the lower bound is surfaced, so the operator gets a closed range.
  expect(detailsText(whatChanged())).toContain(`Changed before this date range, after the ${anchorDay} sweep: Gemini`)
})

test('flags a real substitution as its own amber row', async () => {
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

  const substitutions = await screen.findByRole('list', { name: 'Model substitutions' })
  expect(substitutions.textContent).toBe('OpenAIselected gpt-5.6 · answered gpt-5.6-solsubstituted')
})

test('never flags a Perplexity preset, and says in What changed which model it answered with', async () => {
  const withPreset = metricsDto(TWO_BUCKETS)
  const at = '2026-04-11T08:05:00.000Z'
  Object.assign(withPreset, {
    modelAttribution: {
      perplexity: {
        latestObservation: { observedAt: at, state: { status: 'known', model: 'fast' } },
        events: [{ observedAt: at, bucketStartDate: '2026-04-08T00:00:00.000Z', from: { status: 'known', model: 'perplexity/sonar' }, to: { status: 'known', model: 'fast' } }],
      },
    },
    servedModelAttribution: {
      perplexity: {
        latestObservation: { observedAt: at, state: { status: 'known', model: 'openai/gpt-6-luna' } },
        events: [{ observedAt: at, bucketStartDate: '2026-04-08T00:00:00.000Z', from: { status: 'known', model: 'perplexity/sonar' }, to: { status: 'known', model: 'openai/gpt-6-luna' } }],
        eventTotal: 1,
        latestServedModelIds: ['openai/gpt-6-luna'],
      },
    },
    modelServiceMismatch: {
      perplexity: { observedAt: at, configured: { status: 'known', model: 'fast' }, served: { status: 'known', model: 'openai/gpt-6-luna' } },
    },
  })
  const restore = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/analytics/metrics')) return jsonResponse(withPreset)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByRole('list', { name: 'Model substitutions' })).toBeNull()
  expect(changeRows(whatChanged())).toEqual([['Perplexity', expect.stringMatching(/^Apr 11/), 'perplexity/sonar', 'fast']])
  expect(within(whatChanged()).getByRole('button', { name: 'Preset picks its own model. Answered with openai/gpt-6-luna (was perplexity/sonar).' })).toBeTruthy()
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

  await screen.findByText('What changed')
  expect(screen.queryByRole('list', { name: 'Model substitutions' })).toBeNull()
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
  expect(screen.queryByText('What changed')).toBeNull()
  expect(screen.queryByText('Setup changed')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Model substitutions' })).toBeNull()
  expect(screen.queryByText('Only one sweep so far. The trend line fills in after the next run.')).toBeNull()

  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })
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

  const note = await screen.findByText(/The model behind OpenAI/)
  expect(note.textContent).toBe(
    `The model behind OpenAI was updated on ${formatCalendarDay('2026-06-24')}, inside this period. `
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

  const note = await screen.findByText(/The model behind OpenAI/)
  expect(note.textContent).toBe(
    `The model behind OpenAI was updated on ${formatCalendarDay('2026-06-24')}, inside this period. `
    + `The model behind Perplexity was updated on ${formatCalendarDay('2026-06-10')}, inside this period. `
    + `Some of the movement in these numbers may come from these updates ${CLOSING_LINE}`,
  )
  // Two engines are two facts and ONE warning. Repeating the consequence per
  // engine read as two separate alarms about the same three numbers.
  const sentences = note.textContent!.split('. ').map(s => s.trim())
  expect(new Set(sentences).size).toBe(sentences.length)
})

test('puts a moving model id with no update on record in What changed, never in the banner', async () => {
  onTestFinished(mockMetrics({
    modelPointerChanges: { openai: { modelIds: ['chat-latest'], changeCount: 0, unverifiedChangeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false } },
  }))

  renderSection()

  await screen.findByRole('list', { name: 'Engines' })
  expect(screen.queryByText(/The model behind/)).toBeNull()
  // OpenAI has no change row here to carry it, so the note is a short Details
  // line with the whole explanation behind its ⓘ.
  expect(detailsText(whatChanged())).toContain('OpenAI: no model updates on record')
  expect(within(whatChanged()).getByRole('button', {
    name: 'No model updates are on record for OpenAI in this period. This engine can be moved onto a different underlying model'
      + ' without the data ever showing a different model name, so we check each period against a record of known updates.'
      + ` Nothing is listed inside this one. We last checked for model updates on ${formatCalendarDay('2026-07-20')}, and this period runs past that`
      + ' date, so there may be later updates we do not know about.',
  })).toBeTruthy()
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

// ── Query-set changes: what the server's restated points can and cannot say ──

function basketPoint(day: string, rate: 0 | 0.5 | 1, queryCount: number, revision: number) {
  return {
    startDate: `${day}T00:00:00.000Z`, endDate: `${day}T23:59:59.999Z`,
    dataStartDate: `${day}T12:00:00.000Z`, dataEndDate: `${day}T12:00:00.000Z`, sweepCount: 1,
    citationRate: rate, cited: 4 * rate, total: 4, queryCount, mentionRate: rate, mentionedCount: 4 * rate,
    mentionShare: { scope: 'non-brand', rate: null, projectMentionSnapshots: 4 * rate, competitorMentionSnapshots: 0 },
    byProvider: { gemini: provider(rate, rate) },
    modelEvidenceByProvider: {}, basketRevision: revision,
  }
}

function basketMetrics(buckets: unknown[], windowChange: WindowChange, basketChanges: unknown[]) {
  return { ...metricsDto(buckets, 'non-brand', windowChange), modelAttribution: {}, basketChanges, referenceBasketRevision: basketChanges.length + 1 }
}

function renderMetrics(metrics: unknown) {
  const restore = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/analytics/metrics')) return jsonResponse(metrics)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  renderSection()
}

function trendDetails(): string[] {
  return detailsText(document.querySelector('section.visibility-trend')!)
}

test('prints the change after a query is removed, since the server restates both points to the queries still tracked', async () => {
  const change = { first: 0, latest: 1, delta: 1 }
  renderMetrics(basketMetrics(
    [basketPoint('2026-07-01', 0, 1, 1), basketPoint('2026-07-05', 1, 1, 2)],
    { citationRate: change, mentionRate: change, mentionShare: null },
    [{ revision: 2, at: '2026-07-05T12:00:00.000Z', added: [], removed: ['query b'] }],
  ))
  await screen.findByRole('list', { name: 'Engines' })

  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Cited' })) })
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('up 100.0 points')
  expect(trendDetails().filter(item => item.startsWith('Not the same queries'))).toEqual([])

  // The removal is still listed as the event it was.
  expect(changeRows(whatChanged())).toEqual([['Queries', expect.stringMatching(/^Jul 5/), '1 query removed']])
  expect(detailsText(whatChanged())).toEqual([expect.stringMatching(/^Removed Jul 5(, 2026)?: query b$/)])
})

test('names a query-set change without counting queries the points only happened to answer', async () => {
  // {a, b} became {a, b, c}, and the Sep 28 sweep lost "b" to engine errors:
  // both points answered 2 queries. Counting back from that printed 1 to 2.
  const flat = { first: 0.5, latest: 0.5, delta: 0 }
  renderMetrics(basketMetrics(
    [basketPoint('2026-09-20', 0.5, 2, 1), basketPoint('2026-09-28', 0.5, 2, 2)],
    { citationRate: flat, mentionRate: flat, mentionShare: null },
    [{ revision: 2, at: '2026-09-28T12:00:00.000Z', added: ['c'], removed: [] }],
  ))
  await screen.findByRole('list', { name: 'Engines' })

  expect(changeRows(whatChanged())).toEqual([['Queries', expect.stringMatching(/^Sep 28/), '1 query added']])
  // The change still shows, qualified in view, with the reason in Details.
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('no change (not the same queries)')
  expect(trendDetails()[0]).toMatch(/^Not the same queries: 1 query added Sep 28(, 2026)?; first and latest points cover different queries$/)
  expect(document.querySelector('section.visibility-trend')?.textContent).not.toMatch(/\d+ quer(y|ies) (?:and|to|->) /)
})

test('says the points answered different numbers of queries when no recorded change explains it', async () => {
  // The query set held still; one query went unanswered in the latest sweep.
  const change = { first: 0.5, latest: 1, delta: 0.5 }
  renderMetrics(basketMetrics(
    [basketPoint('2026-09-20', 0.5, 3, 1), basketPoint('2026-09-28', 1, 2, 1)],
    { citationRate: change, mentionRate: change, mentionShare: null },
    [],
  ))
  await screen.findByRole('list', { name: 'Engines' })

  // Shown, never withheld: qualified in view and never tone-coloured as a win.
  const delta = document.querySelector('.visibility-trend-current-delta')!
  expect(delta.textContent).toBe('up 50.0 points (not the same queries)')
  expect(delta.className).toContain('text-muted')
  expect(delta.className).not.toContain('text-positive-400')
  expect(trendDetails()[0]).toBe('Not the same queries: first and latest points have answers for 3 and 2 queries')
  expect(screen.getByText('Mentioned rate across 2 sweeps. Latest 100%, up 50.0 points over the period, not the same queries.')).toBeTruthy()
})

test('prints the change when a query was removed and added back before the latest point', async () => {
  // Both points read a and b: the server rejoins b's first answers once it is tracked again.
  renderMetrics(removedAndReAddedMetrics())
  await screen.findByRole('list', { name: 'Engines' })

  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Cited' })) })
  expect(document.querySelector('.visibility-trend-current-delta')?.textContent).toBe('up 50.0 points')
  expect(trendDetails().filter(item => item.startsWith('Not the same queries'))).toEqual([])
})

test('says what a pooled point\'s two sweeps differ by, not every query a change between them touched', async () => {
  vi.stubEnv('TZ', 'UTC')
  onTestFinished(() => { vi.unstubAllEnvs() })
  renderMetrics(cancelledSweepBetweenMetrics())
  await waitFor(() => expect(document.querySelector('.visibility-trend-current-value')).not.toBeNull())

  expect(trendDetails().map(detail => detail.replace(/\u202f/g, ' '))).toContainEqual(expect.stringMatching(/^Jul 5(, 2026)? point mixes the 8:00 AM sweep and the 10:00 AM sweep, with 1 query added between them$/))
  expect(trendDetails().join('\n')).not.toMatch(/2 queries/)
})

test('says nothing of a mix when both of a point\'s sweeps read the same queries', async () => {
  renderMetrics(roundTripInsidePointMetrics())
  await waitFor(() => expect(document.querySelector('.visibility-trend-current-value')).not.toBeNull())

  expect(trendDetails().filter(item => item.includes('point mixes'))).toEqual([])
})

test('names a query removed and added back inside a point of more than two sweeps without claiming a mix', async () => {
  renderMetrics(roundTripInsidePointMetrics({ sweepCount: 3 }))
  await waitFor(() => expect(document.querySelector('.visibility-trend-current-value')).not.toBeNull())

  expect(trendDetails()).toContainEqual(expect.stringMatching(/^Jul 1(, 2026)? point pools 3 sweeps, with 1 query removed and added back between the first and last$/))
})
