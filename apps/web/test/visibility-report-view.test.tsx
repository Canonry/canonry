import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
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
    expect(html).toContain('Query performance')
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
    fireEvent.click(screen.getByRole('button', { name: /View answers for apartments near transit/ }))
    expect(select).toHaveBeenLastCalledWith({ queryClass: 'non-brand', measurementQueryKey: 'query-context', measurementProvider: 'gemini', measurementModel: undefined, measurementLocation: 'none' })
    expect(select.mock.calls.every(([patch]) => !('runId' in patch))).toBe(true)
  }, 15_000)

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

    const modelChoices = () => [...(screen.getByLabelText('Model') as HTMLSelectElement).options]
      .map(option => ({ value: option.value, label: option.text }))
    expect(modelChoices()).toEqual([
      { value: '', label: 'All observed models' },
      { value: 'shared-model', label: 'shared-model' },
      { value: 'openai-only', label: 'openai-only' },
    ])
    expect(screen.queryByRole('option', { name: /gemini.*shared-model|openai.*shared-model/i })).toBeNull()

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'shared-model' } })
    expect(select).toHaveBeenLastCalledWith({ measurementModel: 'shared-model', measurementQueryKey: undefined })

    report.selection.provider = 'gemini'
    view.rerender(<VisibilityReportView report={report} onSelectionChange={select} />)
    expect(modelChoices()).toEqual([
      { value: '', label: 'All observed models' },
      { value: 'shared-model', label: 'shared-model' },
    ])
  })

  it('moves keyboard focus to the selected answer detail', () => {
    render(<VisibilityReportView report={reportFixture()} queryKey="query-context" onSelectionChange={() => {}} />)
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Measured answers' }))
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
      return jsonResponse({ code: 'NOT_FOUND' }, 404)
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
    expect(screen.queryByRole('region', { name: 'Measured answers' })).toBeNull()
    expect(screen.queryByText('Answer from the prior query.')).toBeNull()
    resolveNewReport?.(jsonResponse(newReport))
    expect(await screen.findByText('Answer from the newly selected query.')).toBeTruthy()
  })

  it('shows properties when the selected scope has no group breakdown', () => {
    const report = reportFixture()
    report.populations[0]!.breakdown.properties = [{ ...report.populations[0]!.breakdown.groups[0]!, id: 'p1', label: 'Northstar Alpha 01' }]
    report.populations[0]!.breakdown.groups = []
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Northstar Alpha 01' })).toBeTruthy()
  })
})
