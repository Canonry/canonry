/**
 * "AI answers over time" and "What changed" on ainyc's stored analytics, read
 * in New York time on Sep 29, 2026, as the approved mockups were drawn: the
 * All window's latest point pools both Sep 29 sweeps, the second of which
 * added three branded queries, and every engine moved to a new model.
 */
process.env.TZ = 'America/New_York'

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { compileQueryClassifier, formatPercent } from '@ainyc/canonry-contracts'

/** What the chart's hover tooltip is showing, set per test: Recharts itself is inert in jsdom. */
const tooltip: { current: Record<string, unknown> | null } = { current: null }

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const nul = () => null
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    CartesianGrid: nul,
    XAxis: nul,
    YAxis: nul,
    Tooltip: ({ content }: { content?: React.ReactElement }) =>
      content && tooltip.current ? <div data-testid="trend-tooltip">{React.cloneElement(content, tooltip.current)}</div> : null,
    Legend: nul,
    Line: nul,
    Area: nul,
    Bar: nul,
    BarChart: passthrough,
    Cell: nul,
    ReferenceArea: nul,
    ReferenceLine: ({ x }: { x: string }) => <span data-marker={x} />,
  }
})

import { VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import { AINYC_SWEEP_TIMES, ainycComparison, ainycEvidence, ainycMetrics } from './ainyc-visibility-fixture.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T14:00:00.000Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  tooltip.current = null
})

const QUERY_TEXTS = [...new Set([...ainycEvidence().map(row => row.query), ...ainycComparison().addedQueries])]
const classifier = compileQueryClassifier(['Canonry'])
const classifyQuery = (text: string) => classifier?.classify(text) ?? null

function renderAinyc(window: 'all' | '7d' = 'all', props: { sweepTimes?: readonly string[] } = { sweepTimes: AINYC_SWEEP_TIMES }) {
  const restore = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/ainyc/analytics/metrics')) return jsonResponse(ainycMetrics(window))
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VisibilityTrendSection
        projectName="ainyc"
        competitorDomains={['pbjmarketing.com']}
        queryTexts={QUERY_TEXTS}
        classifyQuery={classifyQuery}
        {...props}
      />
    </QueryClientProvider>,
  )
}

function trendCard(): HTMLElement {
  return document.querySelector<HTMLElement>('section.visibility-trend')!
}

function whatChanged(): HTMLElement {
  return document.querySelector<HTMLElement>('details.av-wc')!
}

function bullets(details: Element | null): string[] {
  return [...(details?.querySelectorAll('li') ?? [])].map(item => item.textContent ?? '')
}

/** Cell text with its no-break spaces read as spaces: a date never splits across lines. */
function changeRows(): string[][] {
  return [...whatChanged().querySelectorAll('.av-change-table tbody tr')].map(row => [...row.children].map(cell => (cell.textContent ?? '').replace(/\u00a0/g, ' ')))
}

function readout(): Record<'value' | 'change' | 'base', string | null> {
  return {
    value: document.querySelector('.visibility-trend-current-value')?.textContent ?? null,
    change: document.querySelector('.visibility-trend-current-delta')?.textContent ?? null,
    base: document.querySelector('.visibility-trend-current-detail')?.textContent ?? null,
  }
}

test('reads 25.0% of 100 answers on Sep 29 with no change figure, and says why', async () => {
  renderAinyc()

  const legend = await screen.findByRole('list', { name: 'Engines' })
  const card = trendCard()
  expect(within(card).getByText('AI answers over time')).toBeTruthy()
  expect(card.querySelector('.av-card-meta')?.textContent).toBe('Sep 29 · 2 sweeps')
  expect(within(card).getByRole('button', {
    name: 'Mentioned = share of answers that name you. Cited = share that link to your site. Mention share = your share of tracked-brand mentions in non-brand answers.',
  })).toBeTruthy()

  // +4.5 would come entirely from the 3 branded queries added Sep 29, so the
  // headline carries no change figure (decision 3).
  expect(readout()).toEqual({ value: '25.0%', change: null, base: '· 25 of 100 answers' })
  expect(bullets(card.querySelector(':scope > details.av-details'))).toEqual([
    'No change figure: Sep 29 point mixes the 5:41 AM sweep and the 5:59 AM sweep, with 3 queries added between them',
    '25.0% pools all answers; not an average of engines',
  ])
  expect(screen.getByText('Mentioned rate across 5 sweeps. Latest 25.0%.')).toBeTruthy()

  // The legend names engines and their latest rate, never a model.
  expect([...legend.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    'Claude20.0%', 'Gemini36.0%', 'OpenAI12.0%', 'Perplexity32.0%',
  ])

  // Setup changes are marked where the first point's model moves and where
  // Sep 29 changed models and queries, under one key. The caption is gone.
  expect([...document.querySelectorAll('[data-marker]')].map(marker => marker.getAttribute('data-marker')))
    .toEqual(['2026-03-14T00:00:00.000Z', '2026-09-10T00:00:00.000Z'])
  expect(within(card).getByText('Setup changed')).toBeTruthy()
  expect(screen.queryByText(/Query set changed/)).toBeNull()

  // The window picker reads in words, as the other cards' window controls do.
  expect(within(screen.getByRole('radiogroup', { name: 'Time window' })).getAllByRole('radio').map(radio => radio.textContent))
    .toEqual(['7 days', '30 days', '90 days', 'All'])
})

test('keeps the Cited change hidden too, and mention share\'s change because only branded queries were added', async () => {
  renderAinyc()
  await screen.findByRole('list', { name: 'Engines' })

  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Cited' })) })
  expect(readout()).toEqual({ value: '27.0%', change: null, base: '· 27 of 100 answers' })

  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })
  expect(readout()).toEqual({ value: '31.7%', change: 'down 2.9 points', base: '· 13 of 41 tracked-brand mentions' })
  expect(bullets(trendCard().querySelector(':scope > details.av-details'))).toEqual(['Base: Mar 13 to Apr 8 point'])
})

test('collapses What changed to one line and opens a table by engine, newest first', async () => {
  renderAinyc()
  await screen.findByRole('list', { name: 'Engines' })

  const changes = whatChanged()
  expect(changes.open).toBe(false)
  expect(changes.querySelector('.av-wc-summary')?.textContent).toBe('Sep 29 · 3 queries added · 4 new models')
  expect(changes.querySelector('.av-wc-when-closed:not(.av-wc-summary)')?.textContent).toBe('Show all 11 ▸')

  expect(changeRows()).toEqual([
    ['Queries', 'Sep 29', '3 queries added'],
    ['Claude', 'Sep 29', 'claude-sonnet-4-6', 'claude-sonnet-5'],
    ['Claude', 'Mar 20', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    ['Claude', 'Mar 14', 'claude-sonnet-4-6', 'claude-opus-4-6'],
    ['Gemini', 'Sep 29', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
    ['Gemini', 'Apr 7', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
    ['Gemini', 'Mar 26', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    ['Gemini', 'Mar 14', 'gemini-2.5-flash', 'gemini-3-flash-preview'],
    ['OpenAI', 'Sep 29', 'gpt-5.4', 'chat-latest'],
    ['OpenAI', 'Mar 14', 'gpt-4o', 'gpt-5.4'],
    ['Perplexity', 'Sep 29', 'sonar', 'fast'],
  ])
  // A group's first row is its header; the rest name it for screen readers only.
  expect(changes.querySelectorAll('tbody th[scope="row"]')).toHaveLength(5)

  expect(within(changes).getByRole('button', {
    name: 'First sweep on the new model or query set. Sep 29 = the 5:41 AM and 5:59 AM sweeps. Sweep before: Jul 14.',
  })).toBeTruthy()
  // chat-latest has no update on record and was last checked Jul 20: that
  // note rides on its row, never as the banner above the readout.
  // Named as its row is: "OpenAI", not ChatGPT.
  expect(within(changes).getByRole('button', { name: /^No model updates are on record for OpenAI in this period\. .*We last checked for model updates on Jul 20, and this period runs past that date/ })).toBeTruthy()
  expect(screen.queryByText(/The model behind/)).toBeNull()
  // fast is a Perplexity preset: its served model is the preset working, so no
  // amber row, and the preset's own answer model is named on its row.
  expect(within(changes).getByRole('button', { name: 'Preset picks its own model. Answered with openai/gpt-6-luna (was sonar).' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Model substitutions' })).toBeNull()

  // Stored keys are lowercase; Details names the queries as they were written.
  expect(bullets(changes.querySelector('.av-wc-body > details.av-details'))).toEqual([
    'Added Sep 29: Canonry, Canonry AEO agency, Canonry reviews',
  ])
})

test('dates every model change "on or before" Sep 29 on 7 days, bounded by the Jul 14 sweep', async () => {
  // No recent-sweep list at all: the inherited changes' own lower bound dates the sweep before.
  renderAinyc('7d', {})
  await screen.findByRole('list', { name: 'Engines' })

  expect(trendCard().querySelector('.av-card-meta')?.textContent).toBe('Sep 29 · 2 sweeps')
  // One point: no change figure to withhold, but the point still mixes two query sets.
  expect(bullets(trendCard().querySelector(':scope > details.av-details'))).toEqual([
    'Sep 29 point mixes the 5:41 AM sweep and the 5:59 AM sweep, with 3 queries added between them',
    '25.0% pools all answers; not an average of engines',
  ])

  const changes = whatChanged()
  expect(changes.querySelector('.av-wc-summary')?.textContent).toBe('Sep 29 · 3 queries added · 4 new models')
  expect(changeRows().map(row => row.slice(0, 2))).toEqual([
    ['Queries', 'Sep 29'],
    ['Claude', 'on or before Sep 29'],
    ['Gemini', 'on or before Sep 29'],
    ['OpenAI', 'on or before Sep 29'],
    ['Perplexity', 'on or before Sep 29'],
  ])
  expect(bullets(changes.querySelector('.av-wc-body > details.av-details'))).toEqual([
    'Added Sep 29: Canonry, Canonry AEO agency, Canonry reviews',
    'Changed before this date range, after the Jul 14 sweep: Claude, Gemini, OpenAI and Perplexity',
  ])
  expect(within(changes).getByRole('button', { name: /Sweep before: Jul 14\.$/ })).toBeTruthy()

  // Mention share reads non-brand answers only, which the branded additions left alone.
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })
  expect(bullets(trendCard().querySelector(':scope > details.av-details'))).toEqual([])
})

test('the first and latest point tooltips carry their own dates, counts and models', async () => {
  const metrics = ainycMetrics('all')
  const payload = ['claude', 'gemini', 'openai', 'perplexity'].map(provider => ({ dataKey: provider, name: provider }))
  const tooltipText = () => [...screen.getByTestId('trend-tooltip').querySelectorAll('p, .trend-tooltip-row')].map(node => node.textContent)

  tooltip.current = { active: true, label: metrics.buckets[0]!.startDate, payload }
  renderAinyc()
  await screen.findByRole('list', { name: 'Engines' })
  expect(tooltipText()).toEqual([
    'Mar 13 to Apr 8 · 41 sweeps',
    'Claude51.9%147 of 283',
    'Gemini3.3%10 of 307',
    'OpenAI22.3%67 of 300',
    'Perplexity1.8%4 of 220',
    'claude-opus-4-6, claude-sonnet-4-6; gemini-2.5-flash, gemini-3-flash-preview; gpt-4o, gpt-5.4; sonar',
  ])
  cleanup()

  tooltip.current = { active: true, label: metrics.buckets.at(-1)!.startDate, payload }
  renderAinyc()
  await screen.findByRole('list', { name: 'Engines' })
  expect(tooltipText()).toEqual([
    'Sep 29 · 2 sweeps',
    '3 queries added 5:59 AM',
    'Claude20.0%5 of 25',
    'Gemini36.0%9 of 25',
    'OpenAI12.0%3 of 25',
    'Perplexity32.0%8 of 25',
    'claude-sonnet-5; gemini-3.5-flash; chat-latest; fast',
  ])
})

test('mention share names its class in the headline and tooltip, and the tooltip counts competitors (restored)', async () => {
  const metrics = ainycMetrics('all')
  const tooltipText = () => [...screen.getByTestId('trend-tooltip').querySelectorAll('p, .trend-tooltip-row')].map(node => node.textContent)

  tooltip.current = { active: true, label: metrics.buckets.at(-1)!.startDate, payload: [] }
  renderAinyc()
  await screen.findByRole('list', { name: 'Engines' })
  act(() => { fireEvent.click(screen.getByRole('radio', { name: 'Mention share' })) })

  expect(document.querySelector('.visibility-trend-current-label')?.textContent).toBe('Mention share in non-brand answers')
  const bucket = metrics.buckets.at(-1)!.mentionShare
  const total = bucket.projectMentionSnapshots + bucket.competitorMentionSnapshots
  expect(tooltipText()).toContain(`Mention share in non-brand answers${formatPercent(bucket.rate)}`)
  expect(tooltipText()).toContain(`You ${bucket.projectMentionSnapshots} of ${total} tracked-brand mentions. Competitors ${bucket.competitorMentionSnapshots}.`)
})
