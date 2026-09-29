import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { CitationInsightVm } from '../src/view-models.js'

const { openEvidence } = vi.hoisted(() => ({ openEvidence: vi.fn() }))
vi.mock('../src/hooks/use-drawer.js', () => ({ useDrawer: () => ({ openEvidence }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

function evidence(query: string, provider: string, overrides: Partial<CitationInsightVm> = {}): CitationInsightVm {
  const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
  return { ...seed, id: `${query}-${provider}`, query, provider, queryClass: 'non-brand', ...overrides }
}

function selectEngine(provider: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Answer engine' }), { target: { value: provider } })
}

test('filters engine evidence before grouping, including counts, history, both signals and answer actions', () => {
  const history = { runId: 'run-1', createdAt: '2026-09-01T12:00:00Z' }
  render(<EvidenceTable evidence={[
    evidence('Best widgets', 'claude', {
      citationState: 'not-cited', answerMentioned: true, visibilityState: 'visible',
      runHistory: [{ ...history, citationState: 'not-cited', answerMentioned: true }],
    }),
    evidence('Best widgets', 'gemini', {
      citationState: 'cited', answerMentioned: false, visibilityState: 'not-visible',
      runHistory: [{ ...history, citationState: 'cited', answerMentioned: false }],
    }),
    evidence('Gemini only', 'gemini'),
  ]} />)
  expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', '')
  selectEngine('claude')
  const row = screen.getByText('Best widgets').closest('tr')!
  expect(screen.queryByText('Gemini only')).toBeNull()
  // Engines read by their display names, never the stored lowercase ids.
  expect(within(row).getByText('Claude')).toBeTruthy()
  expect(within(row).queryByText('Gemini')).toBeNull()
  expect(within(row).getByTitle('1 of 1 engines mentioned').textContent).toBe('1/1')
  expect(within(row).getByText('First mention')).toBeTruthy()
  expect(within(row).getByText('No citation')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  expect(within(row).getByTitle('0 of 1 engines cited').textContent).toBe('0/1')
  fireEvent.click(screen.getByRole('button', { name: 'Best widgets', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'View', exact: true }))
  expect(openEvidence).toHaveBeenCalledWith('Best widgets-claude')
  selectEngine('')
  expect(within(row).getByTitle('1 of 2 engines cited').textContent).toBe('1/2')
  expect(screen.getByText('Gemini only')).toBeTruthy()
})

test('engine selection composes with class, search and location grouping', () => {
  render(<EvidenceTable compareLocations evidence={[
    evidence('Best widgets', 'claude', { id: 'claude-east', location: 'East' }),
    evidence('Best widgets', 'claude', { id: 'claude-west', location: 'West' }),
    evidence('Best widgets', 'gemini', { location: 'East' }),
    evidence('Northwind widgets', 'claude', { queryClass: 'branded', location: 'East' }),
    evidence('Imported widgets', 'custom-engine', { queryClass: null, location: 'East' }),
  ]} />)
  selectEngine('claude')
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a query' }), { target: { value: 'widgets' } })
  expect(screen.getAllByText('Best widgets')).toHaveLength(2)
  expect(screen.queryByText('Northwind widgets')).toBeNull()
  expect(screen.queryByText('Imported widgets')).toBeNull()
  const rows = screen.getAllByText('Best widgets').map(query => query.closest('tr')!)
  expect(within(rows[0]!).getByText('East')).toBeTruthy()
  expect(within(rows[1]!).getByText('West')).toBeTruthy()
  for (const row of rows) expect(within(row).queryByText('Gemini')).toBeNull()
  selectEngine('custom-engine')
  expect(screen.getByText('No tracked queries match this filter.')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'unclassified' } })
  expect(screen.getByText('Imported widgets')).toBeTruthy()
})

test.each([
  ['engine name', 'claude'],
  ['location', 'East'],
  ['answer text', 'unicorn'],
  ['source URL', 'https://hotel.example/rooms'],
])('query search ignores %s unless it appears in the query text', (_field, term) => {
  const metadata: Partial<CitationInsightVm> = {
    location: 'East',
    answerSnippet: 'The answer recommends a unicorn hotel.',
    evidenceUrls: ['https://hotel.example/rooms'],
    groundingSources: [{ uri: 'https://hotel.example/rooms', title: 'Hotel rooms' }],
  }
  const matchingQuery = `Find ${term} recommendations`
  render(<EvidenceTable compareLocations evidence={[
    evidence('Best widgets', 'claude', metadata),
    evidence(matchingQuery, 'claude', metadata),
    evidence(matchingQuery, 'gemini', metadata),
  ]} />)
  selectEngine('claude')
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a query' }), { target: { value: term } })
  expect(screen.queryByText('Best widgets')).toBeNull()
  const row = screen.getByText(matchingQuery).closest('tr')!
  expect(within(row).queryByText('Gemini')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: matchingQuery, exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'View', exact: true }))
  expect(openEvidence).toHaveBeenCalledWith(`${matchingQuery}-claude`)
})

test('changing engines returns to the first page and keeps the signal selection', () => {
  render(<EvidenceTable evidence={['claude', 'gemini'].flatMap(provider =>
    Array.from({ length: 30 }, (_, i) => evidence(`Widget ${provider} ${i}`, provider)),
  )} />)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  selectEngine('gemini')
  expect(screen.getByText('Widget gemini 0')).toBeTruthy()
  expect(screen.queryByText('Widget gemini 29')).toBeNull()
  expect(screen.getByRole('tab', { name: 'Citations' }).getAttribute('aria-selected')).toBe('true')
})

test('keeps the engine control recoverable when location or data changes remove its evidence', () => {
  const { rerender } = render(<EvidenceTable evidence={[evidence('Best widgets', 'claude')]} />)
  selectEngine('claude')
  rerender(<EvidenceTable evidence={[]} />)
  expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', 'claude')
  expect(screen.getByText('No tracked queries match this filter.')).toBeTruthy()
  rerender(<EvidenceTable evidence={[evidence('Other widgets', 'gemini')]} />)
  expect(screen.queryByText('Other widgets')).toBeNull()
  selectEngine('')
  expect(screen.getByText('Other widgets')).toBeTruthy()
})

test('pending queries without an engine do not create a duplicate All engines option', () => {
  render(<EvidenceTable evidence={[
    evidence('Pending query', '', { citationState: 'pending', visibilityState: 'pending', runHistory: [] }),
    evidence('Measured query', 'claude'),
  ]} />)
  const selector = screen.getByRole('combobox', { name: 'Answer engine' })
  expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual(['All engines', 'Claude'])
  expect(screen.getByText('Pending query')).toBeTruthy()
  selectEngine('claude')
  expect(screen.queryByText('Pending query')).toBeNull()
  expect(screen.getByText('Measured query')).toBeTruthy()
  selectEngine('')
  expect(screen.getByText('Pending query')).toBeTruthy()
})
