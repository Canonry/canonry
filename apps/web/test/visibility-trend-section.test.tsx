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

function metricsDto(buckets: unknown[]) {
  return {
    window: 'all',
    buckets,
    overall: provider(0.5, 0.5),
    byProvider: { gemini: provider(0.5, 0.5) },
    trend: 'improving',
    mentionTrend: 'stable',
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
    mentionShare: { rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 },
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
    mentionShare: { rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 },
    byProvider: { gemini: provider(0.75, 0.5) },
    modelEvidenceByProvider: {
      gemini: { status: 'mixed', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], includesUnknown: false },
    },
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

test('labels per-engine legend entries from analytics bucket evidence and surfaces categorical model changes', async () => {
  const restore = mockFetch((url) => {
    const path = url.split('?')[0]!
    if (path.endsWith('/projects/test-project/analytics/metrics')) {
      return jsonResponse(metricsDto(TWO_BUCKETS))
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
  const anchored = metricsDto(TWO_BUCKETS)
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

test('files a change inherited from before the window under its own heading, not among the dated changes', async () => {
  const anchored = metricsDto(TWO_BUCKETS)
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
      return jsonResponse(metricsDto(TWO_BUCKETS))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  renderSection()

  await screen.findByText('Model evidence changes')
  expect(screen.queryByText('What the engines answered with')).toBeNull()
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

test('reports an engine that can be updated with nothing on record, quietly', async () => {
  onTestFinished(mockMetrics({
    modelPointerChanges: { openai: { modelIds: ['chat-latest'], changeCount: 0, unverifiedChangeCount: 0 } },
  }))

  renderSection()

  const line = await screen.findByText('No model updates are on record for ChatGPT in this period.')
  // Quiet: no caution box, and the explanation is in a tooltip rather than set
  // as prose on the surface. This renders on every load for anyone on a moving
  // model id, so weight matters as much as the words.
  expect(line.className).not.toContain('caution')
  expect(within(line).getByRole('button')).toBeTruthy()
  // And it does NOT jump the headline — nothing is being caveated.
  const headline = document.querySelector('.visibility-trend-current-value')!
  expect(line.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
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

test('tells the reader how recently the update record was checked', async () => {
  // The quiet line on its own is indistinguishable from a record nobody has
  // updated in six months. The date is what separates "we looked and found
  // nothing" from "nobody has looked", so it has to reach the reader — not
  // merely ride on the DTO, which is where an earlier cut left it.
  onTestFinished(mockMetrics({
    modelPointerChanges: {
      openai: {
        modelIds: ['chat-latest'],
        changeCount: 0,
        unverifiedChangeCount: 0,
        knownGoodAsOf: '2026-07-20',
        checkedThroughPeriodEnd: true,
      },
    },
  }))

  renderSection()

  const line = await screen.findByText('No model updates are on record for ChatGPT in this period.')
  const tip = within(line).getByRole('button')
  expect(tip.getAttribute('aria-label')).toContain('We last checked for model updates on 2026-07-20.')
})

test('says when the period runs past the last time the record was checked', async () => {
  onTestFinished(mockMetrics({
    modelPointerChanges: {
      openai: {
        modelIds: ['chat-latest'],
        changeCount: 0,
        unverifiedChangeCount: 0,
        knownGoodAsOf: '2026-07-20',
        checkedThroughPeriodEnd: false,
      },
    },
  }))

  renderSection()

  const line = await screen.findByText('No model updates are on record for ChatGPT in this period.')
  const tip = within(line).getByRole('button')
  expect(tip.getAttribute('aria-label')).toContain(
    'We last checked for model updates on 2026-07-20, and this period runs past that date,'
    + ' so there may be later updates we do not know about.',
  )
})
