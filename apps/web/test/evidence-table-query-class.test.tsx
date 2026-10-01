import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { CitationInsightVm } from '../src/view-models.js'

const { openEvidence } = vi.hoisted(() => ({ openEvidence: vi.fn() }))

vi.mock('../src/hooks/use-drawer.js', () => ({
  useDrawer: () => ({ openEvidence }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function evidence(query: string, queryClass: 'branded' | 'non-brand' | null, overrides: Partial<CitationInsightVm> = {}): CitationInsightVm {
  const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
  return { ...seed, id: query, query, queryClass, ...overrides }
}

test('labels each query class without confusing it with the mention or citation signal', () => {
  render(<EvidenceTable evidence={[
    evidence('About Northwind', 'branded'),
    evidence('Best widgets', 'non-brand'),
    evidence('Imported question', null),
  ]} />)

  const row = screen.getByText('About Northwind').closest('tr')!
  expect(within(row).getByText('Branded')).toBeTruthy()
  expect(within(screen.getByText('Best widgets').closest('tr')!).getByText('Non-brand')).toBeTruthy()
  expect(within(screen.getByText('Imported question').closest('tr')!).getByText('Unclassified')).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Query class' })).toHaveProperty('value', 'all')
  expect(screen.getByRole('tab', { name: 'Mentions' }).getAttribute('aria-selected')).toBe('true')
})

test('signal tabs support arrow, Home and End keys with one linked panel and roving focus', () => {
  render(<EvidenceTable evidence={[evidence('Best widgets', 'non-brand')]} />)
  const mentions = screen.getByRole('tab', { name: 'Mentions' })
  const citations = screen.getByRole('tab', { name: 'Citations' })
  const panel = screen.getByRole('tabpanel', { name: 'Mentions' })
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(mentions.getAttribute('aria-controls')).toBe(panel.id)
  expect(citations.getAttribute('aria-controls')).toBe(panel.id)
  mentions.focus()

  for (const [key, next] of [
    ['ArrowRight', citations],
    ['ArrowLeft', mentions],
    ['ArrowLeft', citations],
    ['ArrowRight', mentions],
    ['End', citations],
    ['Home', mentions],
  ] as const) {
    fireEvent.keyDown(document.activeElement!, { key })
    const other = next === mentions ? citations : mentions
    expect(document.activeElement).toBe(next)
    expect(next.getAttribute('aria-selected')).toBe('true')
    expect(next.tabIndex).toBe(0)
    expect(other.getAttribute('aria-selected')).toBe('false')
    expect(other.tabIndex).toBe(-1)
    expect(panel.getAttribute('aria-labelledby')).toBe(next.id)
    expect(screen.getByRole('tabpanel', { name: next.textContent! })).toBe(panel)
    expect(within(panel).getByRole('columnheader', { name: next === mentions ? 'Mention History' : 'Citation History' })).toBeTruthy()
  }
})

test('native query buttons expand by pointer and keyboard activation and open answer evidence', () => {
  render(<EvidenceTable evidence={[evidence('Best widgets', 'non-brand')]} />)

  const queryButton = screen.getByRole('button', { name: 'Best widgets', exact: true })
  expect(queryButton.tagName).toBe('BUTTON')
  expect(queryButton.getAttribute('type')).toBe('button')
  expect(queryButton.closest('tr')!.getAttribute('role')).not.toBe('button')
  expect(queryButton.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'View', exact: true })).toBeNull()

  fireEvent.click(queryButton)
  expect(queryButton.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'View', exact: true }))
  expect(openEvidence).toHaveBeenCalledWith('Best widgets')

  queryButton.focus()
  expect(document.activeElement).toBe(queryButton)
  // Browsers activate native buttons from Enter/Space with a detail-zero click;
  // jsdom does not synthesize that default action from a keydown event.
  fireEvent.click(queryButton, { detail: 0 })
  expect(queryButton.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(queryButton, { detail: 0 })
  expect(queryButton.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(queryButton)
})

test('answer previews toggle independently of expanded engines and their answer actions', () => {
  const answerSnippet = 'A saved recommendation for local widget makers.'
  render(<EvidenceTable evidence={[evidence('Best widgets', 'non-brand', { answerSnippet })]} />)
  const previews = screen.getByRole('checkbox', { name: 'Show answer previews' })
  const queryButton = screen.getByRole('button', { name: 'Best widgets', exact: true })
  expect(previews).toHaveProperty('checked', true)
  expect(screen.queryByRole('tab', { name: 'Compact' })).toBeNull()
  expect(screen.queryByRole('tab', { name: 'Detailed' })).toBeNull()
  expect(screen.queryByText(answerSnippet)).toBeNull()

  fireEvent.click(queryButton)
  expect(screen.getByText(answerSnippet)).toBeTruthy()
  fireEvent.click(previews)
  expect(previews).toHaveProperty('checked', false)
  expect(screen.queryByText(answerSnippet)).toBeNull()
  expect(queryButton.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'View', exact: true }))
  expect(openEvidence).toHaveBeenCalledWith('Best widgets')

  fireEvent.click(previews)
  expect(screen.getByText(answerSnippet)).toBeTruthy()
})

test('Expand page and Collapse page affect the current page and retain other pages', () => {
  render(<EvidenceTable evidence={Array.from({ length: 26 }, (_, index) => evidence(`Widget query ${index}`, 'non-brand'))} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand page', exact: true }))
  expect(screen.getAllByRole('button', { name: /^Widget query / }).map(button => button.getAttribute('aria-expanded')))
    .toEqual(Array<string>(25).fill('true'))
  expect(screen.getAllByRole('button', { name: 'View', exact: true })).toHaveLength(25)

  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }))
  const lastQuery = screen.getByRole('button', { name: 'Widget query 25', exact: true })
  expect(lastQuery.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Expand page', exact: true }))
  expect(lastQuery.getAttribute('aria-expanded')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: 'Previous', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse page', exact: true }))
  expect(screen.getAllByRole('button', { name: /^Widget query / }).map(button => button.getAttribute('aria-expanded')))
    .toEqual(Array<string>(25).fill('false'))
  expect(screen.queryByRole('button', { name: 'View', exact: true })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }))
  expect(screen.getByRole('button', { name: 'Widget query 25', exact: true }).getAttribute('aria-expanded')).toBe('true')
})

test('class filtering composes with search and both independent evidence signals', () => {
  render(<EvidenceTable evidence={[
    evidence('Northwind pricing', 'branded'),
    evidence('Best widgets', 'non-brand'),
    evidence('Local widget makers', 'non-brand'),
    evidence('Imported question', null),
  ]} />)

  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'branded' } })
  expect(screen.getByText('Northwind pricing')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  expect(screen.getByText('Northwind pricing')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()

  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a query' }), { target: { value: 'local' } })
  expect(screen.getByText('Local widget makers')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()
  expect(screen.queryByText('Northwind pricing')).toBeNull()
  expect(screen.queryByText('Imported question')).toBeNull()
})

test('never treats missing classification as non-brand and names an empty selected class', () => {
  render(<EvidenceTable evidence={[evidence('Imported question', null)]} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  expect(screen.queryByText('Imported question')).toBeNull()
  expect(screen.getByText('No tracked queries match this filter.')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'unclassified' } })
  expect(screen.getByText('Imported question')).toBeTruthy()
})

test('keeps distinct classes separate for the same query and location', () => {
  render(<EvidenceTable compareLocations evidence={[
    evidence('Shared question', 'branded', { id: 'a', location: 'nyc' }),
    evidence('Shared question', 'non-brand', { id: 'b', location: 'nyc' }),
  ]} />)
  expect(screen.getAllByText('Shared question')).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'branded' } })
  expect(screen.getAllByText('Shared question')).toHaveLength(1)
  expect(within(screen.getByText('Shared question').closest('tr')!).getByText('Branded')).toBeTruthy()
})

test('same-query buttons describe their class, compared location and engines independently', () => {
  render(<EvidenceTable compareLocations evidence={[
    evidence('Best widgets', 'non-brand', { id: 'east-claude', location: 'East', provider: 'claude' }),
    evidence('Best widgets', 'non-brand', { id: 'east-gemini', location: 'East', provider: 'gemini' }),
    evidence('Best widgets', 'non-brand', { id: 'west-claude', location: 'West', provider: 'claude' }),
  ]} />)
  const east = screen.getByRole('button', { name: 'Best widgets', exact: true, description: /Non-brand.*East.*Claude.*Gemini/ })
  const west = screen.getByRole('button', { name: 'Best widgets', exact: true, description: /Non-brand.*West.*Claude/ })
  expect(east.getAttribute('aria-describedby')).not.toBe(west.getAttribute('aria-describedby'))
  expect(screen.getAllByRole('button', { name: 'Best widgets', exact: true })).toHaveLength(2)
  fireEvent.click(east)
  expect(east.getAttribute('aria-expanded')).toBe('true')
  expect(west.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getAllByRole('button', { name: 'View', exact: true })).toHaveLength(2)
})

test('changing class resets pagination while preserving the independent signal selection', () => {
  render(<EvidenceTable evidence={[
    ...Array.from({ length: 30 }, (_, i) => evidence(`Northwind ${i}`, 'branded')),
    ...Array.from({ length: 30 }, (_, i) => evidence(`Widget category ${i}`, 'non-brand')),
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  expect(screen.getByText('Widget category 0')).toBeTruthy()
  expect(screen.queryByText('Widget category 29')).toBeNull()
  expect(screen.getByRole('tab', { name: 'Citations' }).getAttribute('aria-selected')).toBe('true')
})

function classHeadings(): string[] {
  return [...document.querySelectorAll('tr.query-evidence-group th')].map(heading => heading.textContent ?? '')
}

test('groups rows Non-brand first, then Branded, then Unclassified, each under a counted row-group heading', () => {
  render(<EvidenceTable evidence={[
    evidence('Northwind pricing', 'branded'),
    evidence('Imported question', null),
    evidence('Best widgets', 'non-brand'),
    evidence('Northwind reviews', 'branded'),
    evidence('Local widget makers', 'non-brand'),
  ]} />)

  expect(classHeadings()).toEqual(['Non-brand (2)', 'Branded (2)', 'Unclassified (1)'])
  for (const heading of document.querySelectorAll('tr.query-evidence-group th')) expect(heading.getAttribute('scope')).toBe('rowgroup')
  // Within a class, rows keep their evidence order.
  expect([...document.querySelectorAll('button.query-evidence-query')].map(button => button.getAttribute('aria-label'))).toEqual([
    'Best widgets', 'Local widget makers', 'Northwind pricing', 'Northwind reviews', 'Imported question',
  ])
  expect(screen.getByText('1 to 5 of 5 queries')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a query' }), { target: { value: 'northwind' } })
  expect(classHeadings()).toEqual(['Branded (2)'])
  expect(screen.getByText('1 to 2 of 2 matches')).toBeTruthy()
})

test('a class heading counts queries across pages, not location rows', () => {
  render(<EvidenceTable compareLocations evidence={Array.from({ length: 14 }, (_, index) => ['East', 'West'].map(location =>
    evidence(`Widget query ${index}`, 'non-brand', { id: `${index}-${location}`, location }),
  )).flat()} />)
  // 28 location rows over two pages, 14 queries under one heading on each.
  expect(classHeadings()).toEqual(['Non-brand (14)'])
  expect(screen.getByText('1 to 25 of 28 queries')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }))
  expect(classHeadings()).toEqual(['Non-brand (14)'])
  expect(screen.getByText('26 to 28 of 28 queries')).toBeTruthy()
})

test('"new query" marks only the latest sweep\'s added queries; an engine new to an old query keeps "First mention"', () => {
  const before = { runId: 'run-1', createdAt: '2026-09-29T09:41:26.139Z' }
  const latest = { runId: 'run-2', createdAt: '2026-09-29T09:59:38.415Z' }
  const mentioned = { citationState: 'not-cited' as const, answerMentioned: true }
  render(<EvidenceTable
    addedQueries={['canonry reviews']}
    evidence={[
      evidence('Canonry reviews', 'branded', { id: 'new-claude', provider: 'claude', runHistory: [{ ...latest, ...mentioned }] }),
      evidence('Canonry reviews', 'branded', { id: 'new-gemini', provider: 'gemini', runHistory: [{ ...latest, ...mentioned }] }),
      evidence('Best widgets', 'non-brand', { id: 'old-claude', provider: 'claude', runHistory: [{ ...before, ...mentioned }, { ...latest, ...mentioned }] }),
      // Gemini answered this old query for the first time in the latest sweep.
      evidence('Best widgets', 'non-brand', { id: 'old-gemini', provider: 'gemini', runHistory: [{ ...latest, ...mentioned }] }),
    ]}
  />)

  // Matched case-insensitively against the stored key.
  const added = screen.getByText('Canonry reviews').closest('tr')!
  expect(within(added).getByText('new query').className).toContain('query-evidence-new')
  expect(within(added).queryByText('First mention')).toBeNull()
  const old = screen.getByText('Best widgets').closest('tr')!
  expect(within(old).queryByText('new query')).toBeNull()
  expect(within(old).getByText('Still mentioned')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Best widgets', exact: true }))
  const engineRows = [...document.querySelectorAll('tr.query-evidence-engine-row')]
  expect(engineRows.map(row => [row.querySelector('td')!.textContent, row.querySelector('.evidence-change-cell')!.textContent])).toEqual([
    ['Claude', 'Still mentionedNo citation'],
    ['Gemini', 'First mentionNo citation'],
  ])

  fireEvent.click(screen.getByRole('button', { name: 'Best widgets', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Canonry reviews', exact: true }))
  // Every engine is new with the query, so its rows repeat no "First mention".
  expect([...document.querySelectorAll('tr.query-evidence-engine-row .evidence-change-cell')].map(cell => cell.textContent)).toEqual(['', ''])
  expect(screen.queryAllByText('new query')).toHaveLength(1)
})

test('without added queries a first sweep still reads "First mention"', () => {
  render(<EvidenceTable evidence={[
    evidence('Best widgets', 'non-brand', { runHistory: [{ runId: 'run-1', createdAt: '2026-09-29T09:41:26.139Z', citationState: 'cited', answerMentioned: true }] }),
  ]} />)
  const row = screen.getByText('Best widgets').closest('tr')!
  expect(within(row).getByText('First mention')).toBeTruthy()
  expect(within(row).queryByText('new query')).toBeNull()
})
