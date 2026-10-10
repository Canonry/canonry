import { aggregateSentiment, createSentimentEvaluationDefinition, VISIBILITY_DISPLAY_COPY } from '@ainyc/canonry-contracts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { SentimentSummary, VisibilityReportResponse } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import { parseVisibilitySelection, patchVisibilitySelection } from '../src/lib/measurement-view-url.js'
import { REPORT_TREND_UNCHECKED_NOTE, UNCHECKED_SOURCES_COPY, VisibilityOverview, VisibilityReportView, VisibilityResultsToolbar, VisibilityWorkspace, VISIBILITY_ANSWERS_LABEL, VISIBILITY_CLOSE_ANSWERS_LABEL, VISIBILITY_SCOPE_RECOVERY_COPY } from '../src/components/project/VisibilityTrendSection.js'
import { formatObservedInstantLabel, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { ANSWER_SOURCES_LABEL } from '../src/components/shared/AnswerMarkdown.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { expectCautionNote } from './caution-note.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { SENTIMENT_COPY, SentimentScopeProvider } from '../src/components/project/SentimentSection.js'

afterEach(cleanup)

export function reportFixture(): VisibilityReportResponse {
  const rate = { numerator: 1, denominator: 3, rate: 0.43 }
  const missing = { numerator: null, denominator: null, rate: null, reason: 'no-population' as const }
  return {
    selection: {
      mode: 'advanced', queryClass: 'non-brand',
      scope: { id: 'project', label: 'Whole site', kind: 'project', targetCount: 225 },
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: 2, run: { id: 'run-2', explicit: false },
      provenance: { kind: 'frozen-advanced', definitionRevision: 2 },
      measurement: { state: 'measured', activeRevision: 3, measuredRevision: 2, awaitingSweep: true, pendingAssignmentCount: 15, completedAt: '2026-09-01T10:00:00Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 225 }, { id: 'metro-alpha', label: 'Metro Alpha', kind: 'group', targetCount: 15 }],
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'none' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: { queryCount: 1, answerCount: 3, mentionCoverage: rate, citationCoverage: missing, propertyReach: missing, outcomes: { bothSignals: 0, mentionedOnly: 1, citedOnly: 0, neither: 0, notMeasured: 224, total: 225 } },
      trend: [],
      queries: { items: [{ queryKey: 'query-context', queryId: 'q1', query: 'apartments near transit', provider: 'gemini', model: null, location: null, targetKeys: ['p1'], answerCount: 3, mentionCoverage: rate, citationCoverage: missing }], total: 1, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null }, competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
      breakdown: { properties: [], groups: [{ id: 'metro-alpha', label: 'Metro Alpha', queryCount: 1, mentionCoverage: rate, citationCoverage: missing }] },
    }],
  }
}

function reportWithAnswer(queryKey: string, answerText: string): VisibilityReportResponse {
  const report = reportFixture()
  const population = report.populations[0]!
  population.queries.items[0] = { ...population.queries.items[0]!, queryKey }
  population.evidence = {
    items: [{
      answerId: `answer-${queryKey}`,
      runId: 'run-2',
      queryKey,
      query: 'apartments near transit',
      provider: 'gemini',
      model: null,
      location: null,
      targetKeys: ['p1'],
      mentioned: true,
      cited: false,
      answerText,
      sources: [],
      createdAt: '2026-09-01T10:00:00Z',
    }],
    total: 1,
    nextCursor: null,
  }
  return report
}

function legacyReportFixture(): VisibilityReportResponse {
  const report = reportWithAnswer('query-context', 'A saved answer from an older sweep.')
  report.selection.mode = 'simple'
  report.selection.queryClass = 'all'
  report.selection.provenance = { kind: 'legacy-simple', definitionRevision: null }
  report.selection.revision = null
  report.selection.measurement = { ...report.selection.measurement, activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0 }
  report.selection.scope = { ...report.selection.scope, targetCount: 1 }
  report.scopeOptions = [report.selection.scope]
  const saved = report.populations[0]!
  const missing = { numerator: null, denominator: null, rate: null, reason: 'no-population' as const }
  report.populations = (['branded', 'non-brand', 'unknown'] as const).map(queryClass => {
    const summary = queryClass === 'unknown' ? saved.summary : { ...saved.summary, queryCount: 0, answerCount: 0, mentionCoverage: missing, citationCoverage: missing }
    return {
      ...saved, queryClass, summary,
      trend: [{ runId: 'run-2', createdAt: '2026-09-01T10:00:00Z', revision: null, provenance: report.selection.provenance, queryCount: summary.queryCount, answerCount: summary.answerCount, mentionCoverage: summary.mentionCoverage, citationCoverage: summary.citationCoverage, continuity: { state: 'first' } }],
      queries: queryClass === 'unknown' ? saved.queries : { items: [], total: 0, nextCursor: null },
      evidence: queryClass === 'unknown' ? saved.evidence : { items: [], total: 0, nextCursor: null },
    }
  })
  return report
}

describe('shared production visibility view', () => {
  it('shows the completed measurement date in the results toolbar without its clock time', () => {
    const report = reportFixture()
    const measuredDate = formatObservedInstantLabel(observedInstant('2026-09-01T10:00:00Z'))
    const { container } = render(<>
      <VisibilityResultsToolbar report={report} selection={parseVisibilitySelection({ queryClass: 'non-brand' })} onSelectionChange={() => {}} />
      <VisibilityReportView report={report} onSelectionChange={() => {}} />
    </>)
    const toolbar = container.querySelector<HTMLElement>('.visibility-results-toolbar')!
    expect(within(toolbar).getByText(measuredDate, { selector: 'span' })).toBeTruthy()
    expect(within(toolbar).getByText('Complete')).toBeTruthy()
    expect(toolbar.textContent).not.toMatch(/\d{1,2}:\d{2}/)
    // The results view no longer repeats the run state below the toolbar.
    const results = screen.getByRole('region', { name: 'AI visibility results' })
    expect(within(results).queryByText('Complete')).toBeNull()
    expect(results.textContent).not.toContain(measuredDate)
  })

  it('recovers a retired group link without changing query class, engine, or unrelated URL state', async () => {
    const requests: URL[] = []
    onTestFinished(mockFetch(url => {
      const request = new URL(url); requests.push(request)
      if (request.searchParams.get('scope') === 'group') return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'group scope "removed" is not in this frozen definition.', details: { reason: 'retired-scope', kind: 'group', key: 'removed' } } }, 400)
      return jsonResponse(reportFixture())
    }))
    let currentSearch: Record<string, unknown> = { measurementScope: 'group', measurementScopeKey: 'removed', queryClass: 'non-brand', measurementProvider: 'gemini', tab: 'overview' }
    function Workspace() {
      const [search, setSearch] = useState(currentSearch)
      return <VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => { currentSearch = patchVisibilitySelection(previous, patch); return currentSearch })} />
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>)
    const recovery = await screen.findByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite })
    expect(screen.getByRole('alert').textContent).not.toContain('VALIDATION_ERROR')
    expect(screen.getByRole('alert').textContent).toContain(VISIBILITY_SCOPE_RECOVERY_COPY.retiredScope)
    expect(screen.queryByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets })).toBeNull()
    fireEvent.click(recovery)
    await screen.findByRole('region', { name: 'Non-brand queries', exact: true })
    expect(currentSearch).toMatchObject({ measurementScope: 'project', queryClass: 'non-brand', measurementProvider: 'gemini', tab: 'overview' })
    expect(currentSearch.measurementScopeKey).toBeUndefined()
    expect(requests.at(-1)!.searchParams.get('scope')).toBe('project')
  })

  it('recovers a retired market by clearing only the market', async () => {
    const requests: URL[] = []
    onTestFinished(mockFetch(url => {
      const request = new URL(url); requests.push(request)
      if (request.searchParams.get('marketKey') === 'gone-market') return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Market "gone-market" is not in this frozen definition.', details: { reason: 'retired-market', kind: 'market', key: 'gone-market' } } }, 400)
      return jsonResponse(reportFixture())
    }))
    let currentSearch: Record<string, unknown> = { measurementScope: 'group', measurementScopeKey: 'metro-alpha', measurementMarketKey: 'gone-market', queryClass: 'non-brand', measurementProvider: 'gemini', tab: 'overview' }
    function Workspace() {
      const [search, setSearch] = useState(currentSearch)
      return <VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => { currentSearch = patchVisibilitySelection(previous, patch); return currentSearch })} />
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>)
    const recovery = await screen.findByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets })
    expect(screen.getByRole('alert').textContent).toContain(VISIBILITY_SCOPE_RECOVERY_COPY.retiredMarket)
    expect(screen.queryByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite })).toBeNull()
    fireEvent.click(recovery)
    await screen.findByRole('region', { name: 'Non-brand queries', exact: true })
    expect(currentSearch).toMatchObject({ measurementScope: 'group', measurementScopeKey: 'metro-alpha', queryClass: 'non-brand', measurementProvider: 'gemini', tab: 'overview' })
    expect(currentSearch.measurementMarketKey).toBeUndefined()
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({ scope: 'group', scopeKey: 'metro-alpha', queryClass: 'non-brand', provider: 'gemini', limit: '25' })
  })

  it('offers Retry instead of a scope recovery when an error carries no retired-scope details', async () => {
    onTestFinished(mockFetch(() => jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'group scope "removed" is not in this frozen definition.' } }, 400)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection({ measurementScope: 'group', measurementScopeKey: 'removed', queryClass: 'non-brand' })} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showWholeSite })).toBeNull()
    expect(screen.queryByRole('button', { name: VISIBILITY_SCOPE_RECOVERY_COPY.showAllMarkets })).toBeNull()
  })

  it('normalizes a clean URL to the served class without adding a history entry', async () => {
    onTestFinished(mockFetch(() => {
      const report = reportFixture()
      report.selection.queryClass = 'all'
      return jsonResponse(report)
    }))
    const onSelectionChange = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection({})} onSelectionChange={onSelectionChange} /></QueryClientProvider>)
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalled())
    expect(onSelectionChange.mock.calls).toStrictEqual([[{ queryClass: 'non-brand' }, { replace: true }]])
  })

  it.each(['non-brand', 'branded', 'unknown'] as const)('reuses the measured %s population across URL normalization and still refreshes after invalidation', async queryClass => {
    const requests: URL[] = []
    let queryCount = 7
    onTestFinished(mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      const report = reportFixture()
      report.selection.queryClass = request.searchParams.get('queryClass') as VisibilityReportResponse['selection']['queryClass']
      report.populations[0]!.queryClass = queryClass
      report.populations[0]!.summary.queryCount = queryCount
      return jsonResponse(report)
    }))
    const client = createQueryClient()
    onTestFinished(() => client.clear())
    function Workspace() {
      const [search, setSearch] = useState<Record<string, unknown>>({ measurementScope: 'group', measurementScopeKey: 'metro-alpha', measurementProvider: 'gemini' })
      return <VisibilityOverview projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => patchVisibilitySelection(previous, patch))} />
    }
    render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>)
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement).value).toBe(queryClass))
    // The caption counts the population; the class itself is named by the heading.
    await waitFor(() => expect(screen.getByText('7 queries · 3 answers')).toBeTruthy())
    expect(requests.map(request => request.searchParams.get('queryClass'))).toEqual(['all'])
    expect(requests[0]!.searchParams.get('scopeKey')).toBe('metro-alpha')
    expect(requests[0]!.searchParams.get('provider')).toBe('gemini')
    queryCount = 8
    await client.invalidateQueries()
    await waitFor(() => expect(screen.getByText('8 queries · 3 answers')).toBeTruthy())
    expect(requests.map(request => request.searchParams.get('queryClass'))).toEqual(['all', queryClass])
  })

  it('loads legacy simple history as all classes once, then normalizes a clean URL to its saved unclassified population', async () => {
    const requests: URL[] = []
    onTestFinished(mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      const report = legacyReportFixture()
      const queryClass = request.searchParams.get('queryClass') ?? 'non-brand'
      report.selection.queryClass = queryClass as VisibilityReportResponse['selection']['queryClass']
      if (queryClass !== 'all') report.populations = report.populations.filter(population => population.queryClass === queryClass)
      return jsonResponse(report)
    }))
    let currentSearch: Record<string, unknown> = {}
    function Workspace() {
      const [search, setSearch] = useState<Record<string, unknown>>({})
      return <VisibilityOverview projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => (currentSearch = patchVisibilitySelection(previous, patch)))} />
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><Workspace /></QueryClientProvider>)
    // Recording the served class remounts the keyed results once, as on the page.
    await waitFor(() => expect(currentSearch.queryClass).toBe('unknown'))
    const population = await screen.findByRole('region', { name: 'Unclassified queries', exact: true })
    expect(requests[0]!.searchParams.get('queryClass')).toBe('all')
    expect(requests.map(request => request.searchParams.get('queryClass'))).toEqual(['all'])
    expect((screen.getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement).value).toBe('unknown')
    expect([...((screen.getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement).options)].map(option => option.value)).not.toContain('all')
    expect(within(population).getByText('1 query · 3 answers')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Branded queries', exact: true })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
    fireEvent.click(within(population).getByText('Query results', { selector: 'span' }).closest('summary')!)
    fireEvent.click(within(population).getByRole('button', { name: /View answers for/ }))
    expect(await screen.findByText('A saved answer from an older sweep.')).toBeTruthy()
    expect(requests.at(-1)!.searchParams.get('queryClass')).toBe('unknown')
    expect(requests.at(-1)!.searchParams.get('runId')).toBe('run-2')
  })

  it('renders one explicitly selected class, including its empty state, instead of stacking report populations', () => {
    const report = legacyReportFixture()
    report.selection.queryClass = 'branded'
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByRole('region', { name: 'Branded queries', exact: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Unclassified queries', exact: true })).toBeNull()
    expect(screen.getAllByRole('region').filter(region => /queries$/.test(region.getAttribute('aria-label') ?? ''))).toHaveLength(1)
    expect(document.querySelectorAll('details[data-query-results]')).toHaveLength(1)
    expect(screen.queryByRole('img', { name: /mention and citation trend/ })).toBeNull()
  })

  it('switches the one report population through the existing query-type dropdown', async () => {
    const requests: URL[] = []
    onTestFinished(mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      const report = legacyReportFixture()
      const queryClass = request.searchParams.get('queryClass') ?? 'all'
      report.selection.queryClass = queryClass as VisibilityReportResponse['selection']['queryClass']
      if (queryClass !== 'all') report.populations = report.populations.filter(population => population.queryClass === queryClass)
      return jsonResponse(report)
    }))
    function Workspace() {
      const [search, setSearch] = useState<Record<string, unknown>>({ queryClass: 'non-brand' })
      return <VisibilityOverview projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => patchVisibilitySelection(previous, patch))} />
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><Workspace /></QueryClientProvider>)
    await screen.findByRole('region', { name: 'Non-brand queries', exact: true })
    fireEvent.change(screen.getByRole('combobox', { name: 'Query type' }), { target: { value: 'unknown' } })
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('queryClass')).toBe('unknown'))
    // The keyed results reload under the toolbar, which already shows the new class.
    expect((screen.getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement).value).toBe('unknown')
    expect(await screen.findByRole('region', { name: 'Unclassified queries', exact: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
    expect(screen.getAllByRole('img', { name: /mention and citation trend/ })).toHaveLength(1)
  })

  it.each(['simple', 'advanced'] as const)('replaces unavailable %s trend plots with an explicit empty state', mode => {
    const report = legacyReportFixture()
    report.selection.mode = mode
    report.selection.queryClass = 'non-brand'
    report.populations = [report.populations[1]!]
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Non-brand queries', exact: true })).toBeTruthy()
    expect(screen.getByText('No measured trend for this selection.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /mention and citation trend/ })).toBeNull()
  })

  it.each(['simple', 'advanced'] as const)('retains %s partial-sweep dates and model changes when no rates can be plotted', mode => {
    const report = reportFixture()
    report.selection.mode = mode
    report.selection.measurement.state = 'partial'
    const population = report.populations[0]!
    const unavailable = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' as const }
    population.summary = { ...population.summary, queryCount: 2, answerCount: 1, mentionCoverage: unavailable, citationCoverage: unavailable }
    population.trend = ['2026-09-03T12:00:00Z', '2026-09-04T12:00:00Z'].map((createdAt, index) => ({
      runId: `partial-${index}`, createdAt, revision: report.selection.revision,
      provenance: report.selection.provenance, queryCount: 2, answerCount: 1,
      mentionCoverage: unavailable, citationCoverage: unavailable,
      continuity: index === 0 ? { state: 'first', comparedRunId: null } : { state: 'model-changed', comparedRunId: 'partial-0' },
    }))
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)

    const table = screen.getByRole('table', { name: 'Non-brand queries trend data' })
    expect(table.parentElement!.classList.contains('sr-only')).toBe(false)
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    for (const point of population.trend) {
      expect(within(table).getByText(new Date(point.createdAt).toLocaleDateString())).toBeTruthy()
    }
    expect(within(table).getByText('model changed')).toBeTruthy()
    expect(within(table).getAllByText('Not measured')).toHaveLength(4)
    expect(screen.queryByRole('img', { name: /mention and citation trend/ })).toBeNull()
    expect(screen.getByText('No measured trend for this selection.')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Trend legend' })).toBeNull()
  })

  it.each([
    { mode: 'simple' as const, showUnmeasuredFallback: true, expectsFallback: true },
    { mode: 'simple' as const, showUnmeasuredFallback: false, expectsFallback: false },
    { mode: 'advanced' as const, showUnmeasuredFallback: true, expectsFallback: false },
  ])('uses unmeasured onboarding only when opted in for simple tracking ($mode, $showUnmeasuredFallback)', async ({ mode, showUnmeasuredFallback, expectsFallback }) => {
    const report = reportFixture()
    report.selection.mode = mode
    report.selection.measurement.state = 'not-measured'
    onTestFinished(mockFetch(() => jsonResponse(report)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><VisibilityWorkspace projectName="demo" selection={{ measurementScope: 'project', queryClass: 'all' }} onSelectionChange={() => {}} fallback={<p>First sweep onboarding</p>} showUnmeasuredFallback={showUnmeasuredFallback} /></QueryClientProvider>)
    if (expectsFallback) expect(await screen.findByText('First sweep onboarding')).toBeTruthy()
    else {
      expect(await screen.findByText('Query results', { selector: 'span' })).toBeTruthy()
      expect(screen.queryByText('First sweep onboarding')).toBeNull()
    }
  })

  it.each(['group', 'market'] as const)('names the selected %s kind while preserving the measured scope', kind => {
    const report = reportFixture()
    report.scopeOptions.push(...(['group', 'market'] as const).map(scopeKind => ({ id: `${scopeKind}-beta`, label: 'Metro Beta', kind: scopeKind, targetCount: 15 })))
    report.selection.scope = report.scopeOptions.find(scope => scope.id === `${kind}-beta`)!
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const kindLabel = kind === 'group' ? 'Group' : 'Market'
    expect(screen.getByText(`1 result · Metro Beta · ${kindLabel}`)).toBeTruthy()
  })

  it('leaves the scope control to the project context row', () => {
    const report = reportFixture()
    expect(report.scopeOptions).toHaveLength(2)
    const { container } = render(<>
      <VisibilityResultsToolbar report={report} selection={parseVisibilitySelection({ queryClass: 'non-brand' })} onSelectionChange={() => {}} />
      <VisibilityReportView report={report} onSelectionChange={() => {}} />
    </>)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(container.querySelector('.visibility-scope-trigger')).toBeNull()
    expect(screen.queryByRole('searchbox', { name: 'Search places' })).toBeNull()
    const toolbar = container.querySelector<HTMLElement>('.visibility-results-toolbar')!
    expect(within(toolbar).getAllByRole('combobox').map(control => control.getAttribute('aria-label'))).toEqual(['Query type'])
    const filters = screen.getByRole('group', { name: 'Visibility filters' })
    expect(filters.hasAttribute('data-has-scope')).toBe(false)
    expect(within(filters).getAllByRole('combobox').map(control => (control as HTMLSelectElement).labels[0]?.textContent)).toEqual(['Answer engine', 'Requested search location', 'AI model', 'Results from'])
    expect(within(screen.getByRole('region', { name: 'AI visibility results' })).queryAllByRole('combobox')).toEqual([])
  })

  it('paginates large property breakdowns and searches all properties without changing server metrics', () => {
    const report = reportFixture()
    const population = report.populations[0]!
    population.breakdown.properties = Array.from({ length: 225 }, (_, index) => ({ ...population.breakdown.groups[0]!, id: `property-${index}`, label: `Property ${index}` }))
    population.breakdown.groups = []
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const breakdown = screen.getByRole('region', { name: 'By place' })
    expect(within(breakdown).getAllByRole('row')).toHaveLength(26)
    expect(within(breakdown).queryByRole('button', { name: 'Property 25', exact: true })).toBeNull()
    fireEvent.click(within(breakdown).getByRole('button', { name: 'Next', exact: true }))
    expect(within(breakdown).getByRole('button', { name: 'Property 25', exact: true })).toBeTruthy()
    fireEvent.change(within(breakdown).getByRole('searchbox', { name: 'Search breakdown' }), { target: { value: 'Property 224' } })
    expect(within(breakdown).getByRole('button', { name: 'Property 224', exact: true })).toBeTruthy()
    expect(within(breakdown).getAllByRole('row')).toHaveLength(2)
    expect(screen.getAllByText('43.0%').length).toBeGreaterThan(0)
    expect(screen.getByText('1 query · 3 answers')).toBeTruthy()
  })

  it('requests a bounded page of query results while retaining server cursor paging', async () => {
    const requests: URL[] = []
    const report = reportFixture()
    report.populations[0]!.queries.nextCursor = 'next-result-page'
    report.populations[0]!.queries.total = 225
    onTestFinished(mockFetch(url => { requests.push(new URL(url)); return jsonResponse(report) }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><VisibilityWorkspace projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand' }} onSelectionChange={() => {}} /></QueryClientProvider>)
    const results = await screen.findByText('Query results', { selector: 'span' })
    fireEvent.click(results.closest('summary')!)
    expect(requests[0]!.searchParams.get('limit')).toBe('25')
    fireEvent.click(screen.getByRole('button', { name: 'Next queries' }))
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('cursor')).toBe('next-result-page'))
    expect(requests.at(-1)!.searchParams.get('limit')).toBe('25')
  })
  it('renders server rates without dividing counts and keeps unavailable values explicit', () => {
    const html = renderToStaticMarkup(<VisibilityReportView report={reportFixture()} onSelectionChange={() => {}} />)
    expect(html).toContain('43.0%')
    expect(html).toContain('1 of 3')
    // 1 of 3 divided in the UI would read 33.3% in the shared format (33% before it).
    expect(html).not.toContain('33.3%')
    expect(html).not.toContain('33%')
    expect(html).toContain('Not measured')
    expect(html).toContain('Query results')
    expect(html).toContain('View answers')
    expect(html).not.toContain('Run AI sweep')
  })

  it.each([
    { mode: 'simple' as const, showsProperties: false },
    { mode: 'advanced' as const, showsProperties: true },
  ])('groups each tracked query once while preserving every $mode engine context and its rates', ({ mode, showsProperties }) => {
    const report = reportFixture()
    report.selection.mode = mode
    const population = report.populations[0]!
    population.queries.items.push({
      ...population.queries.items[0]!,
      provider: 'openai',
      model: 'gpt-5.6',
      location: 'Detroit',
      targetKeys: ['p2'],
      answerCount: 1,
      mentionCoverage: { numerator: 0, denominator: 1, rate: 0 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
    })
    population.queries.total = 2
    if (showsProperties) report.scopeOptions.push(
      { id: 'p1', label: 'Northstar Alpha 01', kind: 'property', targetCount: 1 },
      { id: 'p2', label: 'Harbor House', kind: 'property', targetCount: 1 },
    )

    const { container } = render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)

    const table = container.querySelector('table.measurement-responsive-table')!
    expect(table.querySelectorAll('[data-query-key="query-context"]')).toHaveLength(1)
    expect(within(table).getByRole('button', { name: 'View answers for apartments near transit · gemini' })).toBeTruthy()
    expect(within(table).getByRole('button', { name: 'View answers for apartments near transit · openai' })).toBeTruthy()
    expect(within(table).getByText('gpt-5.6')).toBeTruthy()
    expect(within(table).getByText('Requested search location: Detroit')).toBeTruthy()
    if (showsProperties) {
      expect(within(table).getByText('Northstar Alpha 01')).toBeTruthy()
      expect(within(table).getByText('Harbor House')).toBeTruthy()
    } else {
      expect(within(table).queryByRole('columnheader', { name: 'Properties' })).toBeNull()
    }
    expect(within(table).getByText('1 of 3')).toBeTruthy()
    expect(within(table).getByText('No')).toBeTruthy()
    expect(within(table).getByText('Yes')).toBeTruthy()
    expect(container.textContent).toContain('1 query · 2 engine results shown of 2 results')
  })

  it('keeps same-query location criticism and sentiment evidence scoped to each Advanced group', async () => {
    const report = reportFixture()
    const first = report.populations[0]!.queries.items[0]!
    report.populations[0]!.queries.items = [
      { ...first, queryKey: 'harbor-query', provider: 'openai', location: 'Harbor', sourceSnapshotIds: ['harbor-answer'] },
      { ...first, queryKey: 'marina-query', provider: 'gemini', location: 'Marina', sourceSnapshotIds: ['marina-answer'] },
    ]
    // Non-brand rows show only their unfavorable and mixed answers: Harbor one
    // mixed, Marina one unfavorable. The query's pooled row has both, so a row
    // reading the pool instead of its own location would show both.
    const mixed = aggregateSentiment([{ assessmentId: 'harbor', sourceSnapshotId: 'harbor-answer', outcome: 'mixed' }])
    const unfavorable = aggregateSentiment([{ assessmentId: 'marina', sourceSnapshotId: 'marina-answer', outcome: 'unfavorable' }])
    const aggregate = aggregateSentiment([{ assessmentId: 'harbor', sourceSnapshotId: 'harbor-answer', outcome: 'mixed' }, { assessmentId: 'marina', sourceSnapshotId: 'marina-answer', outcome: 'unfavorable' }])
    const dto: SentimentSummary = {
      ...aggregate, reason: null, configured: true, evaluationDefinition: createSentimentEvaluationDefinition(), breakdowns: [],
      selection: { mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run-2', revision: 2, evaluationDefinitionId: 'definition' },
      queries: [{ ...aggregate, reason: null, queryId: first.queryId!, queryText: first.query, queryClass: 'non-brand', sourceSnapshotIds: ['harbor-answer', 'marina-answer'], assessments: [], locations: [
        { ...mixed, reason: null, location: 'Harbor', sourceSnapshotIds: ['harbor-answer'] },
        { ...unfavorable, reason: null, location: 'Marina', sourceSnapshotIds: ['marina-answer'] },
      ] }],
    }
    const evidenceReads: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse({ installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 1, evaluationDefinitionId: 'definition', actions: { configure: false, backfill: false }, experimental: true, disclosure: 'Experimental sentiment' })
      if (request.pathname.endsWith('/evidence')) { evidenceReads.push(request); return jsonResponse({ state: 'complete', selection: dto.selection, items: [], nextCursor: null }) }
      return jsonResponse({ ...dto, selection: { ...dto.selection, queryClass: request.searchParams.get('queryClass') } })
    })
    const client = createQueryClient()
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run-2', revision: 2 }}><VisibilityReportView report={report} onSelectionChange={vi.fn()} /></SentimentScopeProvider></QueryClientProvider>)
      fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
      const table = screen.getByRole('table', { name: 'Non-brand queries engine results' })
      const harbor = table.querySelector('[data-query-key="harbor-query"]')! as HTMLElement
      const marina = table.querySelector('[data-query-key="marina-query"]')! as HTMLElement
      const name = 'View unfavorable and mixed answers for apartments near transit'
      const counts = (group: HTMLElement) => [...within(group).getByRole('button', { name }).querySelectorAll('span')].map(count => count.textContent)
      await waitFor(() => expect(counts(harbor)).toEqual([SENTIMENT_COPY.nonBrand.rowLabel, '1 mixed']))
      expect(counts(marina)).toEqual([SENTIMENT_COPY.nonBrand.rowLabel, '1 unfavorable'])
      // A non-brand row never shows a favorable share.
      for (const group of [harbor, marina]) expect(within(group).getByRole('button', { name }).textContent).not.toContain('%')
      for (const [group, location] of [[harbor, 'Harbor'], [marina, 'Marina']] as const) {
        fireEvent.click(within(group).getByRole('button', { name }))
        await screen.findByText('No stored sentiment evidence for this query and scope.')
        expect(evidenceReads.at(-1)!.searchParams.get('location')).toBe(location)
        expect(evidenceReads.at(-1)!.searchParams.get('runId')).toBe('run-2')
        expect(evidenceReads.at(-1)!.searchParams.get('queryId')).toBe(first.queryId)
        expect(evidenceReads.at(-1)!.searchParams.getAll('outcome')).toEqual(['mixed', 'unfavorable'])
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
      }
    } finally { cleanup(); client.clear(); restore() }
  })

  it('keeps unfinished non-brand rows in their own state rather than announcing no criticism', async () => {
    const report = reportFixture()
    const first = report.populations[0]!.queries.items[0]!
    report.populations[0]!.queries.items = [
      { ...first, queryKey: 'harbor-query', provider: 'openai', location: 'Harbor', sourceSnapshotIds: ['harbor-answer'] },
      { ...first, queryKey: 'marina-query', provider: 'gemini', location: 'Marina', sourceSnapshotIds: ['marina-answer'] },
    ]
    // Harbor's one assessment is still pending; Marina's was never admitted (eligible, not stored).
    // Neither has an unfavorable or mixed answer, and neither establishes that it has none.
    const pending = aggregateSentiment([{ assessmentId: 'harbor', sourceSnapshotId: 'harbor-answer', outcome: 'pending' }])
    const unadmitted = aggregateSentiment([], { eligibleAssessments: 1, eligibleAnswers: 1 })
    expect([pending.state, unadmitted.state, unadmitted.coverage.unadmittedAssessments]).toEqual(['processing', 'not-measured', 1])
    const dto: SentimentSummary = {
      ...pending, reason: null, configured: true, evaluationDefinition: createSentimentEvaluationDefinition(), breakdowns: [],
      selection: { mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run-2', revision: 2, evaluationDefinitionId: 'definition' },
      queries: [{ ...pending, state: 'partial', provisional: true, reason: null, queryId: first.queryId!, queryText: first.query, queryClass: 'non-brand', sourceSnapshotIds: ['harbor-answer', 'marina-answer'], assessments: [], locations: [
        { ...pending, reason: null, location: 'Harbor', sourceSnapshotIds: ['harbor-answer'] },
        { ...unadmitted, reason: null, location: 'Marina', sourceSnapshotIds: ['marina-answer'] },
      ] }],
    }
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse({ installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 1, evaluationDefinitionId: 'definition', actions: { configure: false, backfill: false }, experimental: true, disclosure: 'Experimental sentiment' })
      return jsonResponse({ ...dto, selection: { ...dto.selection, queryClass: request.searchParams.get('queryClass') } })
    })
    const client = createQueryClient()
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run-2', revision: 2 }}><VisibilityReportView report={report} onSelectionChange={vi.fn()} /></SentimentScopeProvider></QueryClientProvider>)
      fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
      const table = screen.getByRole('table', { name: 'Non-brand queries engine results' })
      const harbor = table.querySelector<HTMLElement>('[data-query-key="harbor-query"]')!
      const marina = table.querySelector<HTMLElement>('[data-query-key="marina-query"]')!
      await waitFor(() => expect(harbor.textContent).toContain(SENTIMENT_COPY.states.processing))
      expect(marina.textContent).toContain(SENTIMENT_COPY.states['not-measured'])
      for (const group of [harbor, marina]) {
        expect(group.textContent).not.toContain(SENTIMENT_COPY.nonBrand.rowNone)
        expect(within(group).queryByRole('button', { name: /View unfavorable and mixed answers/ })).toBeNull()
      }
    } finally { cleanup(); client.clear(); restore() }
  })

  describe('Advanced overview sentiment', () => {
    const sentimentSettings = { installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 1, evaluationDefinitionId: 'definition', actions: { configure: true, backfill: true }, experimental: true, disclosure: 'Experimental sentiment' }
    function sentimentDto(queryClass: string | null): SentimentSummary {
      const aggregate = aggregateSentiment(Array.from({ length: 10 }, (_, index) => ({ assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome: 'favorable' as const })))
      return { ...aggregate, reason: null, configured: true, evaluationDefinition: createSentimentEvaluationDefinition(), breakdowns: [], queries: [], selection: { mode: 'advanced', scope: 'project', queryClass: queryClass === 'non-brand' ? 'non-brand' : 'branded', runId: 'run-older', revision: null, evaluationDefinitionId: 'definition' } }
    }

    it('reads the displayed sweep\'s sentiment at its own revision, never the report\'s restated one, and offers Manage sentiment once, in the Sentiment title row', async () => {
      const sentimentReads: URL[] = []
      onTestFinished(mockFetch(url => {
        const request = new URL(url)
        if (request.pathname.endsWith('/sentiment/settings')) return jsonResponse(sentimentSettings)
        if (request.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
        if (request.pathname.endsWith('/sentiment')) { sentimentReads.push(request); return jsonResponse(sentimentDto(request.searchParams.get('queryClass'))) }
        // An older sweep the report restates onto the current plan, revision 3.
        const report = reportFixture()
        report.selection.run = { id: 'run-older', explicit: true }
        report.selection.revision = 3
        return jsonResponse(report)
      }))
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      onTestFinished(() => client.clear())
      // The page's sentiment selection carries the URL's revision too; the resolved sweep replaces both.
      render(<QueryClientProvider client={client}><SentimentScopeProvider waitForResolvedRun projectName="demo" selection={{ mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run-older', revision: 3 }}>
        <VisibilityOverview projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand', measurementRunId: 'run-older' }} onSelectionChange={() => {}} />
      </SentimentScopeProvider></QueryClientProvider>)
      await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(sentimentReads).toHaveLength(2))
      // Both class reads name the sweep and no revision, so the server reads the revision that sweep ran under.
      expect(sentimentReads.map(request => [request.searchParams.get('queryClass'), request.searchParams.get('runId'), request.searchParams.has('revision')]).sort()).toEqual([['branded', 'run-older', false], ['non-brand', 'run-older', false]])
      // One Manage sentiment, in the report's Sentiment block title row; none above the workspace.
      const manage = await screen.findAllByRole('button', { name: 'Manage sentiment' })
      expect(manage).toHaveLength(1)
      const title = manage[0]!.closest('.sentiment-headlines-title')!
      expect(within(title as HTMLElement).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
      expect(screen.getByRole('region', { name: 'AI visibility results' }).contains(manage[0]!)).toBe(true)
    })

    it('keeps Manage sentiment reachable above the workspace when the report fails', async () => {
      onTestFinished(mockFetch(url => {
        const request = new URL(url)
        if (request.pathname.endsWith('/sentiment/settings')) return jsonResponse(sentimentSettings)
        if (request.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
        if (request.pathname.endsWith('/sentiment')) return jsonResponse(sentimentDto(request.searchParams.get('queryClass')))
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Report failed' } }, 500)
      }))
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      onTestFinished(() => client.clear())
      render(<QueryClientProvider client={client}><SentimentScopeProvider waitForResolvedRun projectName="demo" selection={{ mode: 'advanced', scope: 'project', queryClass: 'non-brand' }}>
        <VisibilityOverview projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand' }} onSelectionChange={() => {}} />
      </SentimentScopeProvider></QueryClientProvider>)
      await screen.findByRole('heading', { name: 'AI visibility unavailable' })
      const manage = await screen.findAllByRole('button', { name: 'Manage sentiment' })
      expect(manage).toHaveLength(1)
      expect(manage[0]!.closest('.sentiment-headlines-title')).toBeNull()
      expect(screen.queryByRole('group', { name: 'Favorable answer scores' })).toBeNull()
    })
  })

  it.each(['simple', 'advanced'] as const)('shares identical query context once and distinguishes a negative answer from missing evidence in %s reports', mode => {
    const report = reportFixture()
    report.selection.mode = mode
    const first = { ...report.populations[0]!.queries.items[0]!, answerCount: 1, targetKeys: ['p1', 'p2'], model: 'gemini-test', mentionCoverage: { numerator: 0, denominator: 1, rate: 0 }, citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' as const } }
    report.populations[0]!.queries.items = [first, { ...first, provider: 'openai', model: 'gpt-test', targetKeys: ['p2', 'p1'], mentionCoverage: { numerator: 1, denominator: 1, rate: 1 }, citationCoverage: { numerator: 0, denominator: 1, rate: 0 } }]
    report.scopeOptions.push({ id: 'p1', label: 'Park House', kind: 'property', targetCount: 1 }, { id: 'p2', label: 'Lake House', kind: 'property', targetCount: 1 })
    const select = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    const table = screen.getByRole('table', { name: 'Non-brand queries engine results' })
    expect(within(table).getAllByText('apartments near transit')).toHaveLength(1)
    expect(within(table).getAllByText('No location requested')).toHaveLength(1)
    expect(within(table).getAllByText('No')).toHaveLength(2)
    expect(within(table).getByText('Yes')).toBeTruthy()
    expect(within(table).getByText('Not measured')).toBeTruthy()
    expect(within(table).queryByText('0%')).toBeNull()
    expect(within(table).getByRole('button', { name: /The saved evidence is incomplete/ })).toBeTruthy()
    if (mode === 'advanced') {
      expect(within(table).getAllByText('2 locations')).toHaveLength(1)
      expect(within(table).getByText('Park House')).toBeTruthy()
      expect(within(table).getByText('Lake House')).toBeTruthy()
    } else expect(within(table).queryByText('2 locations')).toBeNull()
    fireEvent.click(within(table).getByRole('button', { name: 'View answers for apartments near transit · openai' }))
    expect(JSON.parse(select.mock.lastCall![0].measurementAnswer)).toMatchObject({ queryKey: 'query-context', provider: 'openai', model: 'gpt-test', location: null, runId: 'run-2', revision: 2 })
  })

  it('resolves an all-class response to historical non-brand data before current branded data, then to branded when non-brand has no history', () => {
    const historicalNonBrand = legacyReportFixture()
    historicalNonBrand.selection.queryClass = 'all'
    historicalNonBrand.populations[1]!.trend[0] = { ...historicalNonBrand.populations[2]!.trend[0]!, queryCount: 1 }
    historicalNonBrand.populations[2]!.summary = { ...historicalNonBrand.populations[2]!.summary, queryCount: 0, answerCount: 0 }
    render(<VisibilityReportView report={historicalNonBrand} onSelectionChange={() => {}} />)
    expect(screen.getByRole('region', { name: 'Non-brand queries', exact: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Branded queries', exact: true })).toBeNull()
    cleanup()

    const brandedOnly = legacyReportFixture()
    brandedOnly.selection.queryClass = 'all'
    brandedOnly.populations[0]!.summary = brandedOnly.populations[2]!.summary
    brandedOnly.populations[0]!.queries = brandedOnly.populations[2]!.queries
    brandedOnly.populations[1]!.summary = { ...brandedOnly.populations[1]!.summary, queryCount: 0, answerCount: 0 }
    brandedOnly.populations[1]!.trend = []
    brandedOnly.populations[2]!.summary = { ...brandedOnly.populations[2]!.summary, queryCount: 0, answerCount: 0 }
    brandedOnly.populations[2]!.trend = []
    render(<VisibilityReportView report={brandedOnly} onSelectionChange={() => {}} />)
    expect(screen.getByRole('region', { name: 'Branded queries', exact: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
  })

  it('keeps a branded answer deep link in its branded population when the aggregate selection is all', async () => {
    const report = reportWithAnswer('branded-query', 'Saved branded answer.')
    report.selection.queryClass = 'all'
    report.populations[0]!.queryClass = 'branded'
    const requests: URL[] = []
    onTestFinished(mockFetch(url => {
      requests.push(new URL(url))
      return jsonResponse(report)
    }))
    const answer = { queryKey: 'branded-query', queryClass: 'branded' as const, provider: 'gemini', model: null, location: null, runId: 'run-2', revision: 2 }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><VisibilityOverview projectName="demo" selection={parseVisibilitySelection({ queryClass: 'all', measurementQueryKey: answer.queryKey, measurementAnswer: JSON.stringify(answer) })} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByText('Saved branded answer.')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Query type' })).toHaveProperty('value', 'branded')
    expect(screen.getByRole('region', { name: 'Branded queries', exact: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
    expect(requests.find(request => request.searchParams.has('queryKey'))?.searchParams.get('queryClass')).toBe('branded')
  })

  it('uses the resolved non-brand population for an all-class report response', () => {
    const report = reportFixture()
    report.selection.queryClass = 'all'
    report.populations = ['branded', 'non-brand', 'unknown'].map(queryClass => ({ ...report.populations[0]!, queryClass: queryClass as 'branded' | 'non-brand' | 'unknown' }))
    const html = renderToStaticMarkup(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(html).not.toContain('Branded queries')
    expect(html).toContain('Non-brand queries')
    expect(html).not.toContain('Unclassified queries')
    expect(html).not.toContain('Search places')
    expect(html).not.toContain('Pooled')
  })

  it('opens answers with measurement-only navigation keys', () => {
    const select = vi.fn()
    render(<VisibilityReportView report={reportFixture()} onSelectionChange={select} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: /View answers for apartments near transit/ }))
    expect(select).toHaveBeenCalledTimes(1)
    const answerPatch = select.mock.lastCall?.[0]
    expect(answerPatch).toMatchObject({ measurementQueryKey: 'query-context' })
    expect(answerPatch).not.toHaveProperty('queryClass')
    expect(answerPatch).not.toHaveProperty('measurementProvider')
    expect(answerPatch).not.toHaveProperty('measurementModel')
    expect(answerPatch).not.toHaveProperty('measurementLocation')
    expect(answerPatch).not.toHaveProperty('runId')
  })

  it('makes legacy classification visible and gives access to the stored query rows', () => {
    const report = reportFixture()
    report.selection.mode = 'simple'
    report.selection.provenance = { kind: 'legacy-simple', definitionRevision: null }
    const select = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    expect(screen.getByText("These saved results aren't separated by query type.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View all saved results' }))
    expect(select).toHaveBeenCalledWith({ queryClass: 'all', measurementQueryKey: undefined })
  })

  it('keeps observed competitor names separate from unavailable historical rates', () => {
    const report = reportFixture()
    report.populations[0]!.competitorAvailability = { state: 'unavailable', reason: 'frozen-competitor-identity-missing' }
    report.populations[0]!.observedCompetitors = [{ name: 'Eastbank Homes', answerCount: 2 }]
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByText('Competitor rates unavailable for this historical definition.')).toBeTruthy()
    expect(screen.getByText('Eastbank Homes')).toBeTruthy()
    expect(screen.getByText('2 answers')).toBeTruthy()
    expect(screen.queryByText('No measured competitors in this selection.')).toBeNull()
  })

  it('keeps shared model ids provider-neutral and filters their choices by the selected engine', () => {
    const report = reportFixture()
    report.filterOptions = {
      ...report.filterOptions,
      providers: ['gemini', 'openai'],
      models: [
        { provider: 'gemini', model: 'shared-model' },
        { provider: 'openai', model: 'shared-model' },
        { provider: 'openai', model: 'openai-only' },
      ],
    }
    const select = vi.fn()
    const view = render(<VisibilityResultsToolbar report={report} selection={parseVisibilitySelection({ queryClass: 'non-brand' })} onSelectionChange={select} />)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))

    const modelChoices = () => [...(screen.getByLabelText('AI model') as HTMLSelectElement).options]
      .map(option => ({ value: option.value, label: option.text }))
    expect(modelChoices()).toEqual([
      { value: '', label: 'All models' },
      { value: 'shared-model', label: 'shared-model' },
      { value: 'openai-only', label: 'openai-only' },
    ])
    expect(screen.queryByRole('option', { name: /gemini.*shared-model|openai.*shared-model/i })).toBeNull()

    fireEvent.change(screen.getByLabelText('AI model'), { target: { value: 'shared-model' } })
    expect(select).toHaveBeenLastCalledWith({ measurementModel: 'shared-model', measurementQueryKey: undefined })

    // Choices follow the engine in the URL, not the displayed report's echo.
    view.rerender(<VisibilityResultsToolbar report={report} selection={parseVisibilitySelection({ queryClass: 'non-brand', measurementProvider: 'gemini' })} onSelectionChange={select} />)
    expect(report.selection.provider).toBeNull()
    expect(modelChoices()).toEqual([
      { value: '', label: 'All models' },
      { value: 'shared-model', label: 'shared-model' },
    ])
  })

  it('keeps the answers whose sources could not be checked behind a caution icon beside each Cited query and competitor count, never beside Mentioned', () => {
    const report = reportFixture()
    const population = report.populations[0]!
    // Three saved answers, one with incomplete source capture: Cited reads 1 of the 2 checked.
    population.queries.items[0] = { ...population.queries.items[0]!, answerCount: 3, mentionCoverage: { numerator: 1, denominator: 3, rate: 1 / 3 }, citationCoverage: { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 } }
    population.competitors = [{ domain: 'rival.example', answerCount: 3, mentionCoverage: { numerator: 2, denominator: 3, rate: 2 / 3 }, citationCoverage: { numerator: 0, denominator: 2, rate: 0, unchecked: 1 } }]
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const line = '1 of 3 answers had sources that could not be checked'

    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    const engine = within(screen.getByRole('table', { name: 'Non-brand queries engine results' })).getByRole('button', { name: 'View answers for apartments near transit · gemini' }).closest('tr')!
    const [, mentioned, cited] = [...engine.querySelectorAll('td')]
    expect(mentioned!.textContent).toBe('Mentioned33.3%1 of 3')
    expect(mentioned!.querySelector('.info-tooltip-trigger-caution')).toBeNull()
    expect(cited!.textContent).toBe('Cited50.0%1 of 2')
    expectCautionNote(cited!, line, '1 of 2')

    const competitors = screen.getByRole('group', { name: 'Non-brand queries competitors' })
    fireEvent.click(within(competitors).getByText('Competitors', { selector: 'span' }).closest('summary')!)
    const [, competitorMentioned, competitorCited] = [...within(competitors).getByText('rival.example').closest('tr')!.querySelectorAll('td')]
    expect(competitorMentioned!.textContent).toBe('66.7%2 of 3')
    expect(competitorMentioned!.querySelector('.info-tooltip-trigger-caution')).toBeNull()
    expect(competitorCited!.textContent).toBe('0%0 of 2')
    expectCautionNote(competitorCited!, line, '0 of 2')
  })

  it('shows what a partly saved answer cited on its engine row and explains why it is out of Cited', () => {
    const report = reportFixture()
    const population = report.populations[0]!
    report.scopeOptions.push({ id: 'p1', label: 'Park House', kind: 'property', targetCount: 1 }, { id: 'p2', label: 'Lake House', kind: 'property', targetCount: 1 })
    const unavailable = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' as const }
    const base = { ...population.queries.items[0]!, answerCount: 1, mentionCoverage: { numerator: 1, denominator: 1, rate: 1 } }
    population.queries.items = [
      // One answer, sources partly saved, and the saved link cites Park House.
      { ...base, provider: 'gemini', targetKeys: ['p1', 'p2'], citationCoverage: unavailable, uncheckedSources: { answers: 1, citedAnswers: 1, citedTargetKeys: ['p1'] } },
      // One answer, sources partly saved, nothing for Lake House among the saved links.
      { ...base, provider: 'openai', targetKeys: ['p2'], citationCoverage: unavailable, uncheckedSources: { answers: 1, citedAnswers: 0, citedTargetKeys: [] } },
      // Three answers, one partly saved: the rate's own caution note counts it, so it is not repeated.
      { ...base, provider: 'claude', answerCount: 3, targetKeys: ['p1'], citationCoverage: { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 }, uncheckedSources: { answers: 1, citedAnswers: 1, citedTargetKeys: ['p1'] } },
    ]
    population.summary = { ...population.summary, notMeasuredUnchecked: 2 }
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)

    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    const table = screen.getByRole('table', { name: 'Non-brand queries engine results' })
    const cited = (provider: string) => [...within(table).getByRole('button', { name: `View answers for apartments near transit · ${provider}` }).closest('tr')!.querySelectorAll('td')][2]!
    expect(cited('gemini').textContent).toBe(`CitedNot measured${UNCHECKED_SOURCES_COPY.partlySaved(1)}Saved links cite Park House`)
    expect(cited('openai').textContent).toBe(`CitedNot measured${UNCHECKED_SOURCES_COPY.partlySaved(1)}No saved link cites Lake House`)
    expect(cited('claude').textContent).toBe('Cited50.0%1 of 2Saved links cite Park House')
    expectCautionNote(cited('claude'), '1 of 3 answers had sources that could not be checked', '1 of 2')
    // "Unchecked" is explained in plain words instead of the missing-evidence note.
    for (const provider of ['gemini', 'openai', 'claude']) {
      expect(within(cited(provider)).getByRole('button', { name: UNCHECKED_SOURCES_COPY.help })).toBeTruthy()
      expect(within(cited(provider)).queryByRole('button', { name: /The saved evidence is incomplete/ })).toBeNull()
    }

    // Location outcomes says why two of its locations read not measured.
    const outcomes = screen.getByRole('group', { name: 'Non-brand queries location outcomes' })
    expect(within(outcomes).getByText(UNCHECKED_SOURCES_COPY.outcomes(2))).toBeTruthy()
    expect(UNCHECKED_SOURCES_COPY.outcomes(2)).toBe("2 not measured only because an answer's sources were partly saved. Query results shows which answer.")
  })

  it('keeps the missing-evidence note on a row with no partly saved answer, and adds no outcome line', () => {
    const report = reportFixture()
    const population = report.populations[0]!
    population.queries.items[0] = { ...population.queries.items[0]!, answerCount: 1, citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' } }
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    const table = screen.getByRole('table', { name: 'Non-brand queries engine results' })
    expect(within(table).getByRole('button', { name: /The saved evidence is incomplete/ })).toBeTruthy()
    expect(within(table).queryByText(UNCHECKED_SOURCES_COPY.partlySaved(1))).toBeNull()
    expect(screen.queryByText(/only because an answer's sources were partly saved/)).toBeNull()
  })

  it('notes beside the Cited legend entry that Cited counts only checked answers when a plotted point left some out, and only then', () => {
    const report = reportFixture()
    const population = report.populations[0]!
    const point = (index: number, citationCoverage: typeof population.summary.citationCoverage) => ({
      runId: `run-${index}`, createdAt: `2026-09-0${index + 1}T10:00:00Z`, revision: 1,
      provenance: report.selection.provenance, queryCount: 1, answerCount: 3,
      mentionCoverage: population.summary.mentionCoverage, citationCoverage,
      continuity: { state: index === 0 ? 'first' as const : 'comparable' as const, comparedRunId: index === 0 ? null : 'run-0' },
    })
    population.trend = [point(0, { numerator: 1, denominator: 3, rate: 1 / 3 }), point(1, { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 })]
    const view = render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(REPORT_TREND_UNCHECKED_NOTE).toBe('Cited counts only answers whose sources could be checked.')
    expectCautionNote(screen.getByRole('group', { name: 'Trend legend' }), REPORT_TREND_UNCHECKED_NOTE, '')
    view.unmount()
    population.trend = [point(0, { numerator: 1, denominator: 3, rate: 1 / 3 }), point(1, { numerator: 2, denominator: 3, rate: 2 / 3 })]
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.queryByRole('button', { name: REPORT_TREND_UNCHECKED_NOTE })).toBeNull()
    expect(document.body.textContent).not.toContain(REPORT_TREND_UNCHECKED_NOTE)
  })

  it.each(['definition-changed', 'model-changed', 'legacy-unknown'] as const)('explains %s trend gaps beside the chart', state => {
    const report = reportFixture()
    const population = report.populations[0]!
    population.trend = ['first', state].map((continuity, index) => ({
      runId: `run-${index}`, createdAt: `2026-09-0${index + 1}T10:00:00Z`, revision: index + 1,
      provenance: report.selection.provenance, queryCount: 1, answerCount: 3,
      mentionCoverage: population.summary.mentionCoverage,
      citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' },
      continuity: { state: continuity as typeof state | 'first', comparedRunId: index === 0 ? null : 'run-0' },
    }))
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const chart = screen.getByRole('img', { name: /mention and citation trend/ })
    const explanation = document.getElementById(chart.getAttribute('aria-describedby')!)!
    expect(explanation.textContent).toContain(state === 'definition-changed' ? 'changes to what was measured' : state === 'model-changed' ? 'changes to answer engines or models' : 'Older runs lack')
    expect(explanation.textContent).toContain('Missing citation results mean the saved evidence is incomplete.')
    expect(explanation.closest('details')).toBeNull()
  })

  it('uses plain labels for saved-result filters without changing the selection contract', () => {
    const report = reportFixture()
    report.populations[0]!.trend = ['run-1', 'run-2'].map((runId, index) => ({
      runId, createdAt: `2026-09-0${index + 1}T10:00:00Z`, revision: 2,
      provenance: report.selection.provenance, queryCount: 1, answerCount: 3,
      mentionCoverage: report.populations[0]!.summary.mentionCoverage,
      citationCoverage: report.populations[0]!.summary.citationCoverage,
      continuity: { state: 'first', comparedRunId: null },
    }))
    const select = vi.fn()
    render(<VisibilityResultsToolbar report={report} selection={parseVisibilitySelection({ queryClass: 'non-brand' })} onSelectionChange={select} />)
    const disclosure = screen.getByRole('button', { name: 'Filters' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText('Measured run')).toBeNull()
    expect(screen.queryByText('All observed models')).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose a saved AI sweep to view its results. No new sweep starts.' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: '2026-09-01' } })
    expect(select).toHaveBeenLastCalledWith({ measurementFrom: '2026-09-01T00:00:00.000Z' })
    fireEvent.change(screen.getByLabelText('End date (UTC)'), { target: { value: '2026-09-02' } })
    expect(select).toHaveBeenLastCalledWith({ measurementTo: '2026-09-02T23:59:59.999Z' })

    const results = screen.getByRole('combobox', { name: 'Results from' }) as HTMLSelectElement
    expect(results.options[0]!.text).toBe('Latest saved sweep')
    expect([...results.options].map(option => option.value)).toEqual(['', 'run-2', 'run-1'])
    fireEvent.change(results, { target: { value: 'run-1' } })
    expect(select).toHaveBeenLastCalledWith({ measurementRunId: 'run-1', measurementQueryKey: undefined })
    fireEvent.change(results, { target: { value: '' } })
    expect(select).toHaveBeenLastCalledWith({ measurementRunId: undefined, measurementQueryKey: undefined })
    expect(select.mock.calls.every(([patch]) => !('runId' in patch))).toBe(true)
  })

  it('moves keyboard focus to the selected answer detail', () => {
    render(<VisibilityReportView report={reportFixture()} queryKey="query-context" onSelectionChange={() => {}} />)
    expect(screen.getByText('Query results', { selector: 'span' }).closest('details')!.open).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Measured answers' }))
  })

  it('returns focus to the exact engine button that opened the answer', () => {
    const report = reportWithAnswer('query-context', 'Saved Gemini answer.')
    const population = report.populations[0]!
    const secondEngine = { ...population.queries.items[0]!, provider: 'openai' }
    population.queries.items.push(secondEngine)
    population.queries.total = 2
    population.evidence.items.push({
      ...population.evidence.items[0]!, answerId: 'answer-openai', provider: secondEngine.provider,
      answerText: 'Saved OpenAI answer.',
    })
    population.evidence.total = 2
    function Harness() {
      const [search, setSearch] = useState<Record<string, unknown>>({ queryClass: 'non-brand' })
      const selection = parseVisibilitySelection(search)
      return <VisibilityReportView report={report} queryKey={selection.queryKey} answerSelection={selection.answer}
        onSelectionChange={patch => setSearch(previous => patchVisibilitySelection(previous, patch))} />
    }
    render(<Harness />)
    fireEvent.click(document.querySelector('details[data-query-results] > summary')!)
    const trigger = screen.getByRole('button', { name: name => name.endsWith(`${secondEngine.query} · ${secondEngine.provider}`) })
    trigger.focus()
    fireEvent.click(trigger)

    const answers = screen.getByRole('region', { name: VISIBILITY_ANSWERS_LABEL })
    expect(document.activeElement).toBe(answers)
    expect(within(answers).getByText('Saved OpenAI answer.')).toBeTruthy()
    expect(within(answers).queryByText('Saved Gemini answer.')).toBeNull()
    fireEvent.click(within(answers).getByRole('button', { name: VISIBILITY_CLOSE_ANSWERS_LABEL }))

    expect(screen.queryByRole('region', { name: VISIBILITY_ANSWERS_LABEL })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('opens the matching query class for an all-class answer deep link', () => {
    const report = reportWithAnswer('query-context', 'Saved non-brand answer.')
    const population = report.populations[0]!
    report.selection.queryClass = 'all'
    report.populations = ['branded', 'non-brand', 'unknown'].map(queryClass => queryClass === 'non-brand' ? population : {
      ...population, queryClass: queryClass as 'branded' | 'unknown',
      queries: { items: [], total: 0, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
    })
    const view = render(<VisibilityReportView report={report} queryKey="query-context" onSelectionChange={() => {}} />)
    const disclosures = [...view.container.querySelectorAll<HTMLDetailsElement>('details[data-query-results]')]
    expect(disclosures.map(details => [details.dataset.queryResults, details.open])).toEqual([
      ['non-brand', true],
    ])
    expect(screen.getAllByRole('region', { name: 'Measured answers' })).toHaveLength(1)
    expect(document.activeElement?.textContent).toContain('Saved non-brand answer.')
  })

  it('does not steal search focus when saved answer detail reloads', () => {
    const report = reportWithAnswer('query-context', 'Saved answer.')
    const view = render(<VisibilityReportView report={report} queryKey="query-context" onSelectionChange={() => {}} onSearch={() => {}} />)
    const searchInput = screen.getByRole('searchbox', { name: 'Search Non-brand queries' })
    searchInput.focus()
    view.rerender(<VisibilityReportView report={report} isRefreshing onSelectionChange={() => {}} onSearch={() => {}} search="transit" />)
    view.rerender(<VisibilityReportView report={structuredClone(report)} queryKey="query-context" onSelectionChange={() => {}} onSearch={() => {}} search="transit" />)
    expect(document.activeElement).toBe(searchInput)
  })

  it('starts with a compact query summary and reveals results without changing the report', () => {
    const report = reportFixture()
    report.populations[0]!.queries.total = 12
    const select = vi.fn()
    const view = render(<VisibilityReportView report={report} onSelectionChange={select} />)
    const summary = screen.getByText('Query results', { selector: 'span' }).closest('summary')!
    expect(summary.textContent).toBe('Query results12 results · All locations')
    // The page names the whole project as its place picker does.
    view.rerender(<VisibilityReportView report={report} rootLabel="All of Citypoint" onSelectionChange={select} />)
    expect(summary.textContent).toBe('Query results12 results · All of Citypoint')
    expect(summary.closest('details')!.open).toBe(false)
    // jsdom does not implement native details clipping. The open attribute
    // owns visibility and keyboard access in the browser.
    expect(screen.getByText('1 query · 3 answers')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Metro Alpha' })).toBeTruthy()
    fireEvent.click(summary)
    expect(summary.closest('details')!.open).toBe(true)
    expect(screen.getByRole('button', { name: /View answers for/ })).toBeTruthy()
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(summary)
    expect(summary.closest('details')!.open).toBe(false)
  })

  it('shows the measured properties instead of implying each result covers the whole site', () => {
    const report = reportFixture()
    report.scopeOptions.push(
      { id: 'p1', label: 'Harbor House', kind: 'property', targetCount: 1 },
      { id: 'p2', label: 'Lake House', kind: 'property', targetCount: 1 },
    )
    report.populations[0]!.queries.items[0]!.targetKeys = ['p1', 'p2']
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    expect(screen.getByRole('table', { name: 'Non-brand queries engine results' }).querySelector('[data-query-key="query-context"]')?.textContent).toContain('2 locations')
    const targets = screen.getByText('2 locations', { selector: 'summary' })
    expect(targets.closest('details')!.open).toBe(false)
    fireEvent.click(targets)
    expect(targets.closest('details')!.textContent).toContain('Harbor House')
    expect(targets.closest('details')!.textContent).toContain('Lake House')
  })

  it('says No locations for a result that names none', () => {
    const report = reportFixture()
    for (const row of report.populations[0]!.queries.items) row.targetKeys = []
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    expect(within(screen.getByRole('table', { name: 'Non-brand queries engine results' })).getByText('No locations')).toBeTruthy()
  })

  it('keeps query management in the results toolbar without an agent copy action', async () => {
    onTestFinished(mockFetch(() => jsonResponse(reportFixture())))
    const manageQueries = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(<QueryClientProvider client={queryClient}><VisibilityOverview projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand' }} onSelectionChange={() => {}} onManageQueries={manageQueries} /></QueryClientProvider>)
    const results = await screen.findByRole('region', { name: 'AI visibility results' })
    const toolbar = container.querySelector<HTMLElement>('.visibility-results-toolbar')!
    expect(screen.queryByRole('button', { name: 'Copy for agent' })).toBeNull()
    expect(within(results).queryByRole('button', { name: 'Manage queries' })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Manage queries' }))
    expect(manageQueries).toHaveBeenCalledOnce()
    expect(within(results).getByText('Query results', { selector: 'span' }).closest('details')!.open).toBe(false)
  })

  it('keeps competitor details collapsed while exposing their availability', () => {
    const report = reportFixture()
    report.populations[0]!.competitorAvailability = { state: 'unavailable', reason: 'frozen-competitor-identity-missing' }
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const summary = screen.getByText('Competitors', { selector: 'span' }).closest('summary')!
    expect(summary.closest('details')!.open).toBe(false)
    expect(summary.textContent).toContain('Not available')
    fireEvent.click(summary)
    expect(summary.closest('details')!.open).toBe(true)
    expect(screen.getByText('Competitor rates unavailable for this historical definition.')).toBeTruthy()
  })

  it('never shows prior answers while only the selected query key changes', async () => {
    const oldReport = reportWithAnswer('query-old', 'Answer from the prior query.')
    const newReport = reportWithAnswer('query-new', 'Answer from the newly selected query.')
    const requestedQueryKeys: string[] = []
    let resolveNewReport: ((response: Response) => void) | undefined
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname !== '/api/v1/projects/demo/visibility-report') return jsonResponse({ code: 'NOT_FOUND' }, 404)
      const queryKey = request.searchParams.get('queryKey')
      requestedQueryKeys.push(queryKey ?? '')
      if (queryKey === 'query-old') return jsonResponse(oldReport)
      if (queryKey === 'query-new') return new Promise<Response>(resolve => { resolveNewReport = resolve })
      return jsonResponse(reportFixture())
    })
    onTestFinished(() => {
      resolveNewReport?.(jsonResponse(newReport))
      restore()
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const aggregateSelection = {
      measurementScope: 'project',
      queryClass: 'non-brand',
    } satisfies VisibilitySelectionState
    const onSelectionChange = vi.fn()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <VisibilityWorkspace projectName="demo" selection={{ ...aggregateSelection, queryKey: 'query-old' }} onSelectionChange={onSelectionChange} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Answer from the prior query.')).toBeTruthy()
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <VisibilityWorkspace projectName="demo" selection={{ ...aggregateSelection, queryKey: 'query-new' }} onSelectionChange={onSelectionChange} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(requestedQueryKeys).toContain('query-new'))
    expect(screen.queryByText('Answer from the prior query.')).toBeNull()
    resolveNewReport?.(jsonResponse(newReport))
    expect(await screen.findByText('Answer from the newly selected query.')).toBeTruthy()
  })

  it.each([false, true])('preserves aggregate filters and the exact answer context on reload and close (filtered: %s)', async filtered => {
    const initialSearch: Record<string, unknown> = {
      queryClass: 'all', runId: 'drawer-run', evidenceId: 'drawer-evidence',
      ...(filtered ? {
        measurementScope: 'group', measurementScopeKey: 'metro-alpha',
        measurementModel: 'shared-model', measurementRevision: '2',
        measurementFrom: '2026-08-01T00:00:00.000Z', measurementTo: '2026-09-02T23:59:59.999Z',
        measurementRunId: 'run-2',
      } : {}),
    }
    const report = reportFixture()
    report.selection.queryClass = 'all'
    report.selection.model = filtered ? 'shared-model' : null
    report.selection.scope = filtered ? report.scopeOptions[1]! : report.scopeOptions[0]!
    report.selection.run.explicit = filtered
    report.filterOptions.providers = ['gemini', 'openai']
    report.filterOptions.models = [{ provider: 'gemini', model: 'shared-model' }, { provider: 'openai', model: 'shared-model' }]
    report.filterOptions.locations = [{ kind: 'exact', value: 'Detroit' }, { kind: 'none' }]
    const population = report.populations[0]!
    population.queries.items[0] = { ...population.queries.items[0]!, model: 'shared-model', location: 'Detroit' }
    population.queries.items.push({ ...population.queries.items[0]!, provider: 'openai', location: null })
    population.queries.total = 2
    report.populations = [
      { ...population, queryClass: 'branded', queries: { items: [], total: 0, nextCursor: null } },
      population,
      { ...population, queryClass: 'unknown', queries: { items: [], total: 0, nextCursor: null } },
    ]
    const detail = reportWithAnswer('query-context', 'Stored negative evidence for this exact context.')
    detail.populations[0]!.evidence.items[0] = {
      ...detail.populations[0]!.evidence.items[0]!, model: 'shared-model', location: 'Detroit', mentioned: false, cited: false,
    }
    // This narrow response must never replace the aggregate rates or query rows.
    detail.populations[0]!.summary.mentionCoverage = { numerator: 0, denominator: 1, rate: 0 }
    const requests: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      return jsonResponse(request.searchParams.has('queryKey') ? detail : report)
    })
    onTestFinished(restore)
    let currentSearch = initialSearch
    function Harness({ startingSearch }: { startingSearch: Record<string, unknown> }) {
      const [url, setUrl] = useState(startingSearch)
      currentSearch = url
      return <VisibilityOverview projectName="demo" selection={parseVisibilitySelection(url)} onSelectionChange={patch => setUrl(previous => patchVisibilitySelection(previous, patch))} />
    }
    const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const view = render(<QueryClientProvider client={client()}><Harness startingSearch={initialSearch} /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
    fireEvent.click((await screen.findByText('Query results', { selector: 'span' })).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'View answers for apartments near transit · gemini' }))
    expect((await screen.findByText('Stored negative evidence for this exact context.')).closest('article')?.textContent).toContain('Requested search location: Detroit')
    expect(screen.getByText('Not mentioned')).toBeTruthy()
    expect(screen.getByText('Not cited')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Query type' })).toHaveProperty('value', 'non-brand')
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', '')
    expect(screen.getByRole('combobox', { name: 'Requested search location' })).toHaveProperty('value', '')
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.getByRole('button', { name: 'View answers for apartments near transit · openai' })).toBeTruthy()
    expect(currentSearch.queryClass).toBe('non-brand')
    for (const key of ['measurementScope', 'measurementScopeKey', 'measurementProvider', 'measurementModel', 'measurementLocation', 'measurementRevision', 'measurementFrom', 'measurementTo', 'measurementRunId', 'runId', 'evidenceId']) {
      expect(currentSearch[key]).toEqual(initialSearch[key])
    }
    const expectedDetailParams = {
      queryKey: 'query-context', queryClass: 'non-brand', provider: 'gemini', model: 'shared-model', location: 'Detroit', runId: 'run-2', revision: '2',
    }
    expect(Object.fromEntries(requests.find(request => request.searchParams.has('queryKey'))!.searchParams)).toMatchObject(expectedDetailParams)

    const bookmarkedSearch = { ...currentSearch }
    view.unmount()
    render(<QueryClientProvider client={client()}><Harness startingSearch={bookmarkedSearch} /></QueryClientProvider>)
    expect(await screen.findByText('Stored negative evidence for this exact context.')).toBeTruthy()
    const detailRequests = requests.filter(request => request.searchParams.has('queryKey'))
    expect(detailRequests).toHaveLength(2)
    expect(Object.fromEntries(detailRequests[1]!.searchParams)).toMatchObject(expectedDetailParams)
    fireEvent.click(screen.getByRole('button', { name: 'Close answers' }))
    expect(screen.queryByRole('region', { name: 'Measured answers' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Query type' })).toHaveProperty('value', 'non-brand')
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', '')
    expect(screen.queryByText('0%')).toBeNull()
    expect(Object.fromEntries(Object.entries(currentSearch).filter(([, value]) => value !== undefined))).toEqual({ ...initialSearch, queryClass: 'non-brand' })
  })

  it('keeps an undisclosed-model drilldown exact while paging without paging the aggregate', async () => {
    const answer = { queryKey: 'query-context', queryClass: 'non-brand', provider: 'gemini', model: null, location: null, runId: 'run-2', revision: 2 }
    const firstPage = reportWithAnswer('query-context', 'Answer from a different disclosed model.')
    firstPage.populations[0]!.evidence.items[0]!.model = 'disclosed-model'
    firstPage.populations[0]!.evidence.nextCursor = 'null-model-page-2'
    const secondPage = reportWithAnswer('query-context', 'Answer with no disclosed model or location.')
    const requests: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      if (!request.searchParams.has('queryKey')) return jsonResponse(reportFixture())
      return jsonResponse(request.searchParams.has('cursor') ? secondPage : firstPage)
    })
    onTestFinished(restore)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    render(<QueryClientProvider client={queryClient}><VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection({ measurementQueryKey: 'query-context', measurementAnswer: JSON.stringify(answer) })} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByText('No matching answers on this page. Continue to the next answers.')).toBeTruthy()
    expect(screen.queryByText('Answer from a different disclosed model.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next answers' }))
    expect((await screen.findByText('Answer with no disclosed model or location.')).closest('article')?.textContent).toContain('No location requested')
    expect(screen.getByRole('button', { name: 'View answers for apartments near transit · gemini' })).toBeTruthy()
    expect(requests.filter(request => !request.searchParams.has('queryKey'))).toHaveLength(1)
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({ provider: 'gemini', location: 'none', runId: 'run-2', revision: '2', cursor: 'null-model-page-2' })
    expect(requests.at(-1)!.searchParams.has('model')).toBe(false)
  })

  it('opens the matching class after a legacy all-class deep link loads beyond the first query page', async () => {
    const aggregate = reportFixture()
    aggregate.selection.queryClass = 'all'
    aggregate.populations = ['branded', 'non-brand', 'unknown'].map(queryClass => ({
      ...aggregate.populations[0]!, queryClass: queryClass as 'branded' | 'non-brand' | 'unknown',
      queries: { items: [], total: 100, nextCursor: 'next-query-page' },
    }))
    const restore = mockFetch(url => jsonResponse(new URL(url).searchParams.has('queryKey')
      ? reportWithAnswer('beyond-first-page', 'Saved answer from beyond the first query page.')
      : aggregate))
    onTestFinished(restore)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={queryClient}><VisibilityWorkspace projectName="demo" selection={{ measurementScope: 'project', queryClass: 'all', queryKey: 'beyond-first-page' }} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByText('Saved answer from beyond the first query page.')).toBeTruthy()
    const disclosures = [...view.container.querySelectorAll<HTMLDetailsElement>('details[data-query-results]')]
    expect(disclosures.map(details => [details.dataset.queryResults, details.open])).toEqual([
      ['non-brand', true],
    ])
    expect(document.activeElement?.textContent).toContain('Saved answer from beyond the first query page.')
  })

  it('waits for delayed branded evidence before normalizing an off-page query-only all-class link', async () => {
    const aggregate = reportFixture()
    aggregate.selection.queryClass = 'all'
    aggregate.populations = (['branded', 'non-brand', 'unknown'] as const).map(queryClass => ({
      ...aggregate.populations[0]!, queryClass,
      queries: { items: [], total: 100, nextCursor: 'next-query-page' },
      evidence: { items: [], total: 0, nextCursor: null },
    }))
    const brandedEvidence = reportWithAnswer('branded-off-page', 'Saved branded answer beyond the aggregate page.')
    brandedEvidence.selection.queryClass = 'branded'
    brandedEvidence.populations[0]!.queryClass = 'branded'
    const requests: URL[] = []
    let releaseEvidence: ((response: Response) => void) | undefined
    const restore = mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      if (!request.searchParams.has('queryKey')) {
        const report = structuredClone(aggregate)
        const queryClass = request.searchParams.get('queryClass') ?? 'all'
        report.selection.queryClass = queryClass as VisibilityReportResponse['selection']['queryClass']
        if (queryClass !== 'all') report.populations = report.populations.filter(population => population.queryClass === queryClass)
        return jsonResponse(report)
      }
      if (request.searchParams.get('queryClass') === 'all') return new Promise<Response>(resolve => { releaseEvidence = resolve })
      return jsonResponse(brandedEvidence)
    })
    onTestFinished(() => { releaseEvidence?.(jsonResponse(brandedEvidence)); restore() })
    function Harness() {
      const [search, setSearch] = useState<Record<string, unknown>>({ queryClass: 'all', measurementQueryKey: 'branded-off-page' })
      return <VisibilityWorkspace key={String(search.queryClass ?? 'all')} projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => patchVisibilitySelection(previous, patch))} />
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>)
    await waitFor(() => expect(requests.some(request => request.searchParams.has('queryKey') && request.searchParams.get('queryClass') === 'all')).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(requests.filter(request => !request.searchParams.has('queryKey')).map(request => request.searchParams.get('queryClass'))).toEqual(['all'])

    releaseEvidence!(jsonResponse(brandedEvidence))
    expect(await screen.findByRole('region', { name: 'Branded queries', exact: true })).toBeTruthy()
    await waitFor(() => expect(requests.some(request => request.searchParams.has('queryKey') && request.searchParams.get('queryClass') === 'branded')).toBe(true))
    expect(await screen.findByText('Saved branded answer beyond the aggregate page.')).toBeTruthy()
    expect(requests.filter(request => !request.searchParams.has('queryKey')).map(request => request.searchParams.get('queryClass'))).toEqual(['all'])
    expect(screen.queryByRole('region', { name: 'Non-brand queries', exact: true })).toBeNull()
  })

  it('keeps the report available when an answer request fails and retries only the detail', async () => {
    const requests: URL[] = []
    let failEvidence = true
    const restore = mockFetch(url => {
      const request = new URL(url)
      requests.push(request)
      if (!request.searchParams.has('queryKey')) return jsonResponse(reportFixture())
      return failEvidence ? jsonResponse({ message: 'Saved evidence temporarily unavailable.' }, 500) : jsonResponse(reportWithAnswer('query-context', 'Recovered saved evidence.'))
    })
    onTestFinished(restore)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    render(<QueryClientProvider client={queryClient}><VisibilityOverview projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand', queryKey: 'query-context' }} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByRole('button', { name: 'Retry answers' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View answers for apartments near transit · gemini' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI visibility unavailable' })).toBeNull()
    failEvidence = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry answers' }))
    expect(await screen.findByText('Recovered saved evidence.')).toBeTruthy()
    expect(requests.filter(request => !request.searchParams.has('queryKey'))).toHaveLength(1)
    expect(requests.filter(request => request.searchParams.has('queryKey'))).toHaveLength(2)
  })

  it('starts the breakdown with top-level groups and opens a group on its properties', () => {
    const report = reportFixture()
    const root = report.scopeOptions[1]!
    report.scopeOptions.push({ id: 'subgroup', label: 'Central District', kind: 'group', targetCount: 1, parentGroupIds: [root.id] })
    const groupRow = report.populations[0]!.breakdown.groups[0]!
    report.populations[0]!.breakdown.groups.push({ ...groupRow, id: 'subgroup', label: 'Central District' })
    report.populations[0]!.breakdown.properties = [{ ...groupRow, id: 'property', label: 'Harbor House' }]
    const view = render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(within(screen.getByRole('region', { name: 'By place' })).queryByRole('button', { name: 'Central District' })).toBeNull()
    report.selection.scope = root
    view.rerender(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const breakdown = within(screen.getByRole('region', { name: 'By place' }))
    expect(breakdown.getByRole('button', { name: 'Harbor House' })).toBeTruthy()
    fireEvent.click(breakdown.getByRole('button', { name: 'Groups', exact: true }))
    expect(breakdown.getByRole('button', { name: 'Central District' })).toBeTruthy()
    expect(breakdown.queryByRole('button', { name: 'Metro Alpha' })).toBeNull()
  })

  it('shows properties when the selected scope has no group breakdown', () => {
    const report = reportFixture()
    report.populations[0]!.breakdown.properties = [{ ...report.populations[0]!.breakdown.groups[0]!, id: 'p1', label: 'Northstar Alpha 01' }]
    report.populations[0]!.breakdown.groups = []
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Northstar Alpha 01' })).toBeTruthy()
  })
})


it('ambiguous property identity remains unverified in rates and saved answer evidence', () => {
  const report = reportWithAnswer('query-context', 'Which same-named property do you mean?')
  const population = report.populations[0]!
  population.summary.mentionCoverage = { numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous' }
  population.evidence.items[0] = { ...population.evidence.items[0]!, mentioned: null, mentionUnavailableReason: 'identity-ambiguous' }
  render(<VisibilityReportView report={report} onSelectionChange={() => {}} evidenceReport={report} queryKey="query-context" />)
  expect(within(screen.getByRole('region', { name: VISIBILITY_ANSWERS_LABEL })).getByText(VISIBILITY_DISPLAY_COPY.ambiguous)).toBeTruthy()
})


describe('market-aware report selection', () => {
  const market = { id: 'market-one', label: 'Market One', kind: 'market' as const, targetCount: 1, parentGroupIds: ['group-one'] }
  const property = { id: 'property-one', label: 'Property One', kind: 'property' as const, targetCount: 1, parentGroupIds: ['group-one'], marketKeys: [market.id, 'market-two'] }

  it('retains the market when drilling from a group breakdown into a property', () => {
    const report = reportFixture()
    const group = { id: 'group-one', label: 'Group One', kind: 'group' as const, targetCount: 1, marketKeys: [market.id] }
    report.selection.scope = group
    report.selection.market = market
    report.scopeOptions.push(group, market, property)
    report.populations[0]!.breakdown = { groups: [], properties: [{ id: property.id, label: property.label, queryCount: 1, mentionCoverage: report.populations[0]!.summary.mentionCoverage, citationCoverage: report.populations[0]!.summary.citationCoverage }] }
    const onSelectionChange = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={onSelectionChange} />)
    fireEvent.click(screen.getByRole('button', { name: property.label, exact: true }))
    expect(onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'property', measurementScopeKey: property.id, measurementMarketKey: market.id })
  })

  it.each([undefined, 'market-one', 'market-two'])('keeps the displayed market filter when opening a group row: %s', marketKey => {
    const report = reportFixture()
    const group = { id: 'group-one', label: 'Group One', kind: 'group' as const, targetCount: 1, marketKeys: [market.id] }
    if (marketKey) report.selection.market = { ...market, id: marketKey }
    report.scopeOptions.push(group, market, property)
    report.populations[0]!.breakdown = { properties: [], groups: [{ id: group.id, label: group.label, queryCount: 1, mentionCoverage: report.populations[0]!.summary.mentionCoverage, citationCoverage: report.populations[0]!.summary.citationCoverage }] }
    const onSelectionChange = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={onSelectionChange} />)
    fireEvent.click(screen.getByRole('button', { name: group.label, exact: true }))
    expect(onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'group', measurementScopeKey: group.id, measurementMarketKey: marketKey })
  })

  it('groups a standalone property question list by saved market without repeating shared questions', () => {
    const report = reportFixture()
    report.selection.scope = property
    const secondMarket = { ...market, id: 'market-two', label: 'Market Two' }
    report.scopeOptions.push(market, secondMarket, property)
    const row = report.populations[0]!.queries.items[0]!
    report.populations[0]!.queries.items = [
      { ...row, queryKey: 'second-query', query: 'second saved question', targetKeys: [property.id], marketKeys: [secondMarket.id] },
      { ...row, queryKey: 'first-query', query: 'first saved question', targetKeys: [property.id], marketKeys: [market.id] },
      { ...row, queryKey: 'first-query', query: 'first saved question', provider: 'openai', targetKeys: [property.id], marketKeys: [market.id] },
    ]
    const view = render(<VisibilityReportView report={report} onSelectionChange={vi.fn()} />)
    const queryDetails = view.container.querySelector('details[data-query-results]')!
    fireEvent.click(queryDetails.querySelector('summary')!)
    expect(within(queryDetails as HTMLElement).getByRole('heading', { name: market.label })).toBeTruthy()
    expect(within(queryDetails as HTMLElement).getByRole('heading', { name: secondMarket.label })).toBeTruthy()
    expect(view.container.querySelectorAll('tbody[data-query-key]')).toHaveLength(2)
    expect([...view.container.querySelectorAll('tbody[data-query-key]')].map(element => element.getAttribute('data-query-key'))).toEqual(['first-query', 'second-query'])
    expect(view.container.querySelectorAll('tbody[data-query-key="first-query"] tr.measurement-engine-result')).toHaveLength(2)
  })

  it('sends the same market in aggregate and answer requests and separates cached markets', async () => {
    const requests: URL[] = []
    const savedText = 'A recorded answer from the selected market.'
    onTestFinished(mockFetch(url => {
      const request = new URL(url); requests.push(request)
      const report = reportWithAnswer('query-context', savedText)
      report.selection.scope = property
      report.selection.market = { ...market, id: request.searchParams.get('marketKey')! }
      report.scopeOptions.push(market, property)
      return jsonResponse(report)
    }))
    const client = createQueryClient()
    onTestFinished(() => client.clear())
    const base = { measurementScope: 'property' as const, measurementScopeKey: property.id, queryClass: 'non-brand' as const, marketKey: market.id, queryKey: 'query-context' }
    const view = render(<QueryClientProvider client={client}><VisibilityWorkspace projectName="demo" selection={base} onSelectionChange={vi.fn()} /></QueryClientProvider>)
    await screen.findByText(savedText)
    expect(requests.some(request => request.searchParams.has('queryKey'))).toBe(true)
    expect(requests.every(request => request.searchParams.get('marketKey') === market.id)).toBe(true)
    const before = requests.length
    view.rerender(<QueryClientProvider client={client}><VisibilityWorkspace projectName="demo" selection={{ ...base, marketKey: 'market-two' }} onSelectionChange={vi.fn()} /></QueryClientProvider>)
    await waitFor(() => expect(requests.slice(before).filter(request => request.searchParams.get('marketKey') === 'market-two')).toHaveLength(2))
  })
})


it('keeps a saved group-only URL on its original population after linking a market', async () => {
  const group = { id: 'saved-group', kind: 'group' as const, label: 'Saved group', targetCount: 1, marketKeys: ['saved-market'] }
  const market = { id: 'saved-market', kind: 'market' as const, label: 'Saved market', targetCount: 1, parentGroupIds: [group.id] }
  const requests: URL[] = []
  onTestFinished(mockFetch(url => {
    const request = new URL(url); requests.push(request)
    const report = reportFixture()
    report.selection.scope = group
    if (request.searchParams.get('marketKey')) report.selection.market = market
    report.scopeOptions.push(group, market)
    return jsonResponse(report)
  }))
  let currentSearch: Record<string, unknown> = { measurementScope: 'group', measurementScopeKey: group.id, queryClass: 'non-brand' }
  function Workspace() {
    const [search, setSearch] = useState(currentSearch)
    return <VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => { currentSearch = patchVisibilitySelection(previous, patch); return currentSearch })} />
  }
  const client = createQueryClient()
  onTestFinished(() => client.clear())
  const view = render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>)
  await waitFor(() => expect(view.container.querySelector('.visibility-report')).toBeTruthy())
  expect(requests).toHaveLength(1)
  expect(requests[0]!.searchParams.has('marketKey')).toBe(false)
  expect(currentSearch.measurementMarketKey).toBeUndefined()
})

it('formats saved answer Markdown while keeping links safe and remote images inactive', () => {
  const queryKey = reportFixture().populations[0]!.queries.items[0]!.queryKey
  const heading = reportFixture().populations[0]!.queries.items[0]!.query
  const source = 'https://example.com/source'
  const answer = `## ${heading}\n\n**${queryKey}**\n\n- ${queryKey}\n- ${heading}\n\n[${source}](${source})\n\n[${queryKey}](javascript:alert%281%29)\n\n![${heading}](https://example.com/pixel.png)`
  const report = reportWithAnswer(queryKey, answer)
  render(<VisibilityReportView report={report} evidenceReport={report} queryKey={queryKey} onSelectionChange={() => {}} />)
  const region = screen.getByRole('region', { name: VISIBILITY_ANSWERS_LABEL })
  expect(within(region).getByRole('heading', { name: heading, level: 4 })).toBeTruthy()
  expect(region.querySelector('.answer-markdown strong')?.textContent).toBe(queryKey)
  expect(within(region).getAllByRole('listitem')).toHaveLength(2)
  const link = within(region).getByRole('link', { name: source })
  expect(link.getAttribute('href')).toBe(source)
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(within(region).getAllByRole('link')).toHaveLength(1)
  expect(within(region).queryByRole('img')).toBeNull()
})

it('keeps saved answer sources collapsed and preserves safe links in their recorded order', () => {
  const report = reportWithAnswer('query-context', 'Read the saved recommendation.')
  const sources = ['https://guide.example/harbour', 'javascript:alert(1)', 'https://locations.example/harbor-house']
  report.populations[0]!.evidence.items[0]!.sources = sources
  render(<VisibilityReportView report={report} queryKey="query-context" onSelectionChange={() => {}} />)
  const region = screen.getByRole('region', { name: VISIBILITY_ANSWERS_LABEL })
  const summary = within(region).getByText(`${ANSWER_SOURCES_LABEL} (${sources.length})`, { selector: 'summary' })
  const disclosure = summary.closest('details')!

  expect(disclosure.open).toBe(false)
  expect(within(region).getByText('Read the saved recommendation.')).toBeTruthy()
  fireEvent.click(summary)

  expect(disclosure.open).toBe(true)
  expect(within(disclosure).getAllByRole('listitem').map(item => item.textContent)).toEqual(sources)
  const links = within(disclosure).getAllByRole('link')
  expect(links.map(link => link.getAttribute('href'))).toEqual([sources[0], sources[2]])
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  }
  expect(within(disclosure).queryByRole('link', { name: sources[1] })).toBeNull()
  fireEvent.click(summary)
  expect(disclosure.open).toBe(false)
})
