import { afterEach, describe, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameVisibilityReportQueryKey } from '@canonry/canonry-api-client/react-query'
import { RunKinds, type VisibilityReportResponse } from '@canonry/canonry-contracts'

import { heyClient } from '../src/api.js'
import { CitationVisibilitySection } from '../src/components/project/CitationVisibilitySection.js'
import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function reportFixture(): VisibilityReportResponse {
  const missing = { numerator: null, denominator: null, rate: null, reason: 'no-population' as const }
  const zero = { numerator: 0, denominator: 2, rate: 0 }
  const half = { numerator: 1, denominator: 2, rate: 0.5 }
  const full = { numerator: 1, denominator: 1, rate: 1 }
  return {
    selection: {
      mode: 'simple', queryClass: 'all', scope: { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: null,
      run: { id: 'run-complete', explicit: false }, provenance: { kind: 'frozen-simple', definitionRevision: null },
      measurement: { state: 'measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-01T10:00:00Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [], filterOptions: { providers: ['openai'], models: [], locations: [{ kind: 'none' }] },
    populations: (['branded', 'non-brand', 'unknown'] as const).map(queryClass => {
      const count = queryClass === 'unknown' ? 0 : queryClass === 'branded' ? 1 : 2
      const mentionCoverage = queryClass === 'unknown' ? missing : queryClass === 'branded' ? full : zero
      const citationCoverage = queryClass === 'unknown' ? missing : queryClass === 'branded' ? full : half
      return {
        queryClass,
        summary: { queryCount: count, answerCount: count, mentionCoverage, citationCoverage, propertyReach: missing, outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 1 } },
        trend: [], queries: { items: [], total: count, nextCursor: null }, evidence: { items: [], total: 0, nextCursor: null },
        competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
        breakdown: { properties: [], groups: [], providers: count === 0 ? [] : [{ provider: 'openai', queryCount: count, answerCount: count, mentionCoverage, citationCoverage }] },
      }
    }),
  }
}

function renderCard(data: VisibilityReportResponse | { failed: unknown }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const key = [{ ...getApiV1ProjectsByNameVisibilityReportQueryKey({ client: heyClient, path: { name: 'demo' }, query: { queryClass: 'all', limit: 1 } })[0], tags: ['no-sweep'] }]
  if ('failed' in data) {
    queryClient.getQueryCache().build(queryClient, { queryKey: key }).setState({ status: 'error', error: data.failed as Error, fetchStatus: 'idle' })
  } else queryClient.setQueryData(key, data)
  onTestFinished(() => queryClient.clear())
  return render(<QueryClientProvider client={queryClient}><CitationVisibilitySection projectName="demo" /></QueryClientProvider>)
}

describe('By engine report', () => {
  test('keeps the non-brand and branded server denominators separate and renders rates without recalculating', () => {
    const report = reportFixture()
    report.populations[1]!.breakdown.providers![0]!.provider = 'openrouter:google/gemini-2.5-flash'
    // Deliberately not numerator / denominator: the UI presents the wire rate.
    report.populations[1]!.breakdown.providers![0]!.citationCoverage = { numerator: 1, denominator: 2, rate: 0.43 }
    renderCard(report)
    const nonBrand = screen.getByRole('table', { name: 'By engine, non-brand queries' })
    const model = within(nonBrand).getByRole('rowheader', { name: 'Gemini 2.5 Flash via OpenRouter' })
    expect(within(model).getByText('Gemini 2.5 Flash')).toBeTruthy()
    expect(within(model).getByText('via OpenRouter')).toBeTruthy()
    expect(within(nonBrand).getByText('43.0%')).toBeTruthy()
    expect(within(nonBrand).getByText('0 of 2 answers')).toBeTruthy()
    expect(within(nonBrand).getByText('1 of 2 answers')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    const branded = screen.getByRole('table', { name: 'By engine, branded queries' })
    expect(within(branded).getAllByText('1 of 1 answers')).toHaveLength(2)
    expect(within(branded).queryByText('0 of 2 answers')).toBeNull()
  })

  test('shows an incomplete engine as unavailable instead of a measured zero', () => {
    const report = reportFixture()
    report.selection.measurement.state = 'partial'
    const engine = report.populations[1]!.breakdown.providers![0]!
    engine.answerCount = 1
    engine.mentionCoverage = { numerator: null, denominator: null, rate: null, reason: 'incomplete' }
    engine.citationCoverage = { numerator: 0, denominator: 1, rate: 0, unchecked: 1 }
    renderCard(report)
    expect(screen.getByText('Awaiting answers')).toBeTruthy()
    expect(screen.getByText('0 of 1 answers')).toBeTruthy()
    expect(screen.getByText('1 unchecked')).toBeTruthy()
    expect(screen.getByText(/^Latest check .* · incomplete$/)).toBeTruthy()
    expect(screen.queryByText('0 of 2 answers')).toBeNull()
  })

  test('does not relabel unclassified legacy evidence as non-brand', () => {
    const report = reportFixture()
    const legacy = report.populations[1]!
    report.populations[2] = { ...legacy, queryClass: 'unknown' }
    report.populations[1] = { ...legacy, summary: { ...legacy.summary, queryCount: 0, answerCount: 0 }, breakdown: { properties: [], groups: [], providers: [] } }
    renderCard(report)
    expect(screen.getByText('No non-brand queries in this check.')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Unclassified' }))
    expect(screen.getByRole('table', { name: 'By engine, unclassified queries' })).toBeTruthy()
  })

  test.each(['first-sweep', 'older-server'] as const)('keeps %s evidence unavailable', state => {
    const report = reportFixture()
    if (state === 'first-sweep') report.selection.run.id = null
    else delete report.populations[1]!.breakdown.providers
    renderCard(report)
    expect(screen.getByText(state === 'first-sweep' ? 'Engine results appear after your first check.' : 'Engine breakdown unavailable for this report.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  test.each(['run-revision', 'completion-event'] as const)('refreshes a cached first-sweep state through %s without reloading the page', async refresh => {
    let saved = reportFixture()
    saved.selection.run.id = null
    onTestFinished(mockFetch(() => jsonResponse(saved)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    onTestFinished(() => client.clear())
    const view = render(<QueryClientProvider client={client}><CitationVisibilitySection projectName="demo" revision="before" /></QueryClientProvider>)
    await screen.findByText('Engine results appear after your first check.')
    saved = reportFixture()
    if (refresh === 'run-revision') view.rerender(<QueryClientProvider client={client}><CitationVisibilitySection projectName="demo" revision="after" /></QueryClientProvider>)
    else invalidateQueriesForRunKind(client, RunKinds['answer-visibility'], 'demo')
    const table = await screen.findByRole('table', { name: 'By engine, non-brand queries' })
    expect(within(table).getByText('0 of 2 answers')).toBeTruthy()
    expect(screen.queryByText('Engine results appear after your first check.')).toBeNull()
  })

  test.each([
    new Error('engine results store unavailable'),
    { error: { code: 'INTERNAL_ERROR', message: 'engine results store unavailable' } },
  ])('offers recovery for a failed report read', failed => {
    renderCard({ failed })
    expect(screen.getByText('Could not load engine results: engine results store unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('By engine with an engine that returns no sources', () => {
  test('shows Not measured in the Cited cell and keeps the engine\'s mention rate', () => {
    const report = reportFixture()
    // The server reads a Local answer's citation as not measured, never as not cited.
    report.populations[1]!.breakdown.providers!.push({
      provider: 'local', queryCount: 2, answerCount: 2,
      mentionCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
      citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'citation-not-measured' },
    })
    renderCard(report)

    const nonBrand = screen.getByRole('table', { name: 'By engine, non-brand queries' })
    const row = within(nonBrand).getByRole('rowheader', { name: 'Local' }).closest('tr')!
    const [mentioned, cited] = within(row).getAllByRole('cell')
    expect(within(mentioned!).getByText('50.0%', { exact: false })).toBeTruthy()
    expect(within(mentioned!).getByText('1 of 2 answers')).toBeTruthy()
    expect(within(cited!).getByText('Not measured')).toBeTruthy()
    // No rate and no answer count: nothing was measured, so nothing reads as a 0.
    expect(cited!.textContent).not.toMatch(/%|answers/)
  })
})
