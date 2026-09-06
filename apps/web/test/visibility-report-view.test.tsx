import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import { parseVisibilitySelection, patchVisibilitySelection } from '../src/lib/measurement-view-url.js'
import { VisibilityReportView, VisibilityWorkspace } from '../src/components/project/VisibilityTrendSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

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

describe('shared production visibility view', () => {
  it('renders server rates without dividing counts and keeps unavailable values explicit', () => {
    const html = renderToStaticMarkup(<VisibilityReportView report={reportFixture()} onSelectionChange={() => {}} />)
    expect(html).toContain('43%')
    expect(html).toContain('1 of 3')
    expect(html).not.toContain('33%')
    expect(html).toContain('Not measured')
    expect(html).toContain('Query results')
    expect(html).toContain('View answers')
    expect(html).not.toContain('Run AI sweep')
  })

  it('explains frozen prior measurement without claiming new assignments have answers', () => {
    const html = renderToStaticMarkup(<VisibilityReportView report={reportFixture()} onSelectionChange={() => {}} />)
    expect(html).toContain('Measured under revision 2')
    expect(html).toContain('Project has 15 assignments awaiting sweep')
    expect(html).not.toContain('Published revision 4')
  })

  it('keeps all classes as separate report sections and offers searchable scope', () => {
    const report = reportFixture()
    report.selection.queryClass = 'all'
    report.populations = ['branded', 'non-brand', 'unknown'].map(queryClass => ({ ...report.populations[0]!, queryClass: queryClass as 'branded' | 'non-brand' | 'unknown' }))
    const html = renderToStaticMarkup(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(html).toContain('Branded queries')
    expect(html).toContain('Non-brand queries')
    expect(html).toContain('Unclassified queries')
    expect(html).toContain('Search scopes')
    expect(html).not.toContain('Pooled')
  })

  it('searches a large scope picker and preserves measurement-only navigation keys', () => {
    const report = reportFixture()
    report.scopeOptions.push(...Array.from({ length: 225 }, (_, index) => ({ id: `property-${index}`, label: `Property ${index}`, kind: 'property' as const, targetCount: 1 })))
    const select = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    fireEvent.click(screen.getByText('Whole site', { selector: 'summary' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Property 224' } })
    expect(screen.queryByRole('button', { name: /Property 223/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Property 224/ }))
    expect(select).toHaveBeenLastCalledWith({ measurementScope: 'property', measurementScopeKey: 'property-224' })
    fireEvent.click(screen.getByText('Query results', { selector: 'span' }).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: /View answers for apartments near transit/ }))
    const answerPatch = select.mock.lastCall?.[0]
    expect(answerPatch).toMatchObject({ measurementQueryKey: 'query-context' })
    expect(answerPatch).not.toHaveProperty('queryClass')
    expect(answerPatch).not.toHaveProperty('measurementProvider')
    expect(answerPatch).not.toHaveProperty('measurementModel')
    expect(answerPatch).not.toHaveProperty('measurementLocation')
    expect(select.mock.calls.every(([patch]) => !('runId' in patch))).toBe(true)
  }, 15_000)

  it('labels scope alongside the other filters and returns focus when its search closes', () => {
    render(<VisibilityReportView report={reportFixture()} onSelectionChange={() => {}} />)
    const label = screen.getByText('Measurement scope')
    const trigger = screen.getByText('Whole site', { selector: 'summary' })
    expect(trigger.getAttribute('aria-labelledby')).toContain(label.id)
    const picker = trigger.closest('details')!
    picker.open = true
    const search = screen.getByRole('searchbox', { name: 'Search scopes' })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(picker.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('makes legacy classification visible and gives access to the stored query rows', () => {
    const report = reportFixture()
    report.selection.mode = 'simple'
    report.selection.provenance = { kind: 'legacy-simple', definitionRevision: null }
    const select = vi.fn()
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    fireEvent.click(screen.getByRole('button', { name: 'View unclassified results' }))
    expect(select).toHaveBeenCalledWith({ queryClass: 'unknown', measurementQueryKey: undefined })
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
    const view = render(<VisibilityReportView report={report} onSelectionChange={select} />)

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

    report.selection.provider = 'gemini'
    view.rerender(<VisibilityReportView report={report} onSelectionChange={select} />)
    expect(modelChoices()).toEqual([
      { value: '', label: 'All models' },
      { value: 'shared-model', label: 'shared-model' },
    ])
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
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    const disclosure = screen.getByText('More filters', { selector: 'summary' }).closest('details')!
    expect(disclosure.open).toBe(false)
    fireEvent.click(screen.getByText('More filters', { selector: 'summary' }))
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
      ['branded', false], ['non-brand', true], ['unknown', false],
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
    render(<VisibilityReportView report={report} onSelectionChange={select} />)
    const summary = screen.getByText('Query results', { selector: 'span' }).closest('summary')!
    expect(summary.textContent).toContain('12 results')
    expect(summary.textContent).toContain('Whole site')
    expect(summary.closest('details')!.open).toBe(false)
    // jsdom does not implement native details clipping. The open attribute
    // owns visibility and keyboard access in the browser.
    expect(screen.getByText('Queries measured')).toBeTruthy()
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
    expect(screen.getByRole('columnheader', { name: 'Properties' })).toBeTruthy()
    const targets = screen.getByText('2 properties', { selector: 'summary' })
    expect(targets.closest('details')!.open).toBe(false)
    fireEvent.click(targets)
    expect(targets.closest('details')!.textContent).toContain('Harbor House')
    expect(targets.closest('details')!.textContent).toContain('Lake House')
  })

  it('keeps query management without an agent copy action', () => {
    const manageQueries = vi.fn()
    render(<VisibilityReportView report={reportFixture()} onSelectionChange={() => {}} onManageQueries={manageQueries} />)
    expect(screen.queryByRole('button', { name: 'Copy for agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manage queries' }))
    expect(manageQueries).toHaveBeenCalledOnce()
    expect(screen.getByText('Query results', { selector: 'span' }).closest('details')!.open).toBe(false)
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
      return <VisibilityWorkspace projectName="demo" selection={parseVisibilitySelection(url)} onSelectionChange={patch => setUrl(previous => patchVisibilitySelection(previous, patch))} />
    }
    const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const view = render(<QueryClientProvider client={client()}><Harness startingSearch={initialSearch} /></QueryClientProvider>)
    await screen.findByRole('combobox', { name: 'Answer engine' })
    fireEvent.click(screen.getAllByText('Query results', { selector: 'span' })[1]!.closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'View answers for apartments near transit · gemini' }))
    expect(await screen.findByText('Stored negative evidence for this exact context.')).toBeTruthy()
    expect(screen.getByText('Not mentioned')).toBeTruthy()
    expect(screen.getByText('Not cited')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Query type' })).toHaveProperty('value', 'all')
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', '')
    expect(screen.getByRole('combobox', { name: 'Search location' })).toHaveProperty('value', '')
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.getByRole('button', { name: 'View answers for apartments near transit · openai' })).toBeTruthy()
    for (const key of ['queryClass', 'measurementScope', 'measurementScopeKey', 'measurementProvider', 'measurementModel', 'measurementLocation', 'measurementRevision', 'measurementFrom', 'measurementTo', 'measurementRunId', 'runId', 'evidenceId']) {
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
    expect(screen.getByRole('combobox', { name: 'Query type' })).toHaveProperty('value', 'all')
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', '')
    expect(screen.queryByText('0%')).toBeNull()
    expect(Object.fromEntries(Object.entries(currentSearch).filter(([, value]) => value !== undefined))).toEqual(initialSearch)
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
    expect(await screen.findByText('Answer with no disclosed model or location.')).toBeTruthy()
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
      ['branded', false], ['non-brand', true], ['unknown', false],
    ])
    expect(document.activeElement?.textContent).toContain('Saved answer from beyond the first query page.')
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
    render(<QueryClientProvider client={queryClient}><VisibilityWorkspace projectName="demo" selection={{ measurementScope: 'project', queryClass: 'non-brand', queryKey: 'query-context' }} onSelectionChange={() => {}} /></QueryClientProvider>)
    expect(await screen.findByRole('button', { name: 'Retry answers' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Answer engine' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View answers for apartments near transit · gemini' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI visibility unavailable' })).toBeNull()
    failEvidence = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry answers' }))
    expect(await screen.findByText('Recovered saved evidence.')).toBeTruthy()
    expect(requests.filter(request => !request.searchParams.has('queryKey'))).toHaveLength(1)
    expect(requests.filter(request => request.searchParams.has('queryKey'))).toHaveLength(2)
  })

  it('shows properties when the selected scope has no group breakdown', () => {
    const report = reportFixture()
    report.populations[0]!.breakdown.properties = [{ ...report.populations[0]!.breakdown.groups[0]!, id: 'p1', label: 'Northstar Alpha 01' }]
    report.populations[0]!.breakdown.groups = []
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Northstar Alpha 01' })).toBeTruthy()
  })
})
