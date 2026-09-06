import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { VisibilityReportView } from '../src/components/project/VisibilityTrendSection.js'

afterEach(cleanup)

function fixture(kind: 'project' | 'group' | 'property' = 'project'): VisibilityReportResponse {
  const rate = { numerator: 4, denominator: 4, rate: 1 }
  const scope = { id: kind === 'project' ? 'project' : kind === 'group' ? 'metro-alpha' : 'p1', label: kind === 'project' ? 'Whole site' : kind === 'group' ? 'Metro Alpha' : 'Northstar One', kind, targetCount: kind === 'property' ? 1 : 15 }
  const row = { queryCount: 2, mentionCoverage: rate, citationCoverage: rate }
  return {
    selection: {
      mode: 'advanced', queryClass: 'non-brand', scope,
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: 2, run: { id: 'run-2', explicit: false },
      provenance: { kind: 'frozen-advanced', definitionRevision: 2 },
      measurement: { state: 'measured', activeRevision: 3, measuredRevision: 2, awaitingSweep: true, pendingAssignmentCount: 15, completedAt: '2026-09-01T10:00:00Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: 15 },
      { id: 'metro-alpha', label: 'Metro Alpha', kind: 'group', targetCount: 15 },
      { id: 'market-alpha', label: 'Metro Alpha', kind: 'market', targetCount: 15 },
      { id: 'p1', label: 'Northstar One', kind: 'property', targetCount: 1 },
    ],
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'none' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: { queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, propertyReach: { numerator: 15, denominator: 15, rate: 1 }, outcomes: { bothSignals: 15, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 15 } },
      trend: [{ runId: 'run-2', createdAt: '2026-09-01T10:00:00Z', revision: 2, provenance: { kind: 'frozen-advanced', definitionRevision: 2 }, queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, continuity: { state: 'first', comparedRunId: null } }],
      queries: { items: [], total: 0, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
      competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
      breakdown: { groups: [{ ...row, id: 'metro-alpha', label: 'Metro Alpha' }], properties: [{ ...row, id: 'p1', label: 'Northstar One' }] },
    }],
  }
}

test('labels aggregate answer coverage separately from property reach and explains the chart', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  expect(screen.getByText('Answers mentioning a property')).toBeTruthy()
  expect(screen.getByText('Answers citing a property')).toBeTruthy()
  expect(screen.getByText('Properties mentioned')).toBeTruthy()
  const legend = screen.getByRole('list', { name: 'Trend legend' })
  expect(within(legend).getByText('Mentioned')).toBeTruthy()
  expect(within(legend).getByText('Cited')).toBeTruthy()
  const outcomes = screen.getByText('Property outcomes', { selector: 'summary' }).closest('details')!
  expect(outcomes.open).toBe(false)
  const trend = screen.getByRole('img', { name: /mention and citation trend/ })
  expect(trend.compareDocumentPosition(outcomes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('a group opens its properties while a property avoids a redundant group summary', () => {
  const { rerender } = render(<VisibilityReportView report={fixture('group')} onSelectionChange={() => {}} />)
  const breakdown = screen.getByRole('region', { name: 'Scope breakdown' })
  expect(within(breakdown).getByRole('button', { name: 'Northstar One' })).toBeTruthy()
  expect(within(breakdown).queryByRole('button', { name: 'Metro Alpha' })).toBeNull()
  rerender(<VisibilityReportView report={fixture('property')} onSelectionChange={() => {}} />)
  expect(screen.queryByRole('region', { name: 'Scope breakdown' })).toBeNull()
})

test('scope choices distinguish a property group from a market query context', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  const trigger = screen.getByText('Whole site', { selector: 'summary' })
  trigger.closest('details')!.open = true
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Metro Alpha' } })
  expect(screen.getByRole('button', { name: /Metro Alpha.*Group.*15 properties/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Metro Alpha.*Market.*query context/ })).toBeTruthy()
})

test('keeps revision mechanics behind help, with pending assignments visible', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  expect(screen.getByText('15 query assignments pending')).toBeTruthy()
  expect(screen.queryByText(/Measured under revision/)).toBeNull()
  expect(screen.getByRole('button', { name: /Measured under revision 2/ })).toBeTruthy()
})
