import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameCitationsVisibilityQueryKey } from '@ainyc/canonry-api-client/react-query'
import { emptyCitationVisibility, type CitationVisibilityResponse } from '@ainyc/canonry-contracts'

import { heyClient } from '../src/api.js'
import { byEngineClasses, CitationVisibilitySection } from '../src/components/project/CitationVisibilitySection.js'
import { ainycCitationVisibility, ainycClassify } from './ainyc-visibility-fixture.js'

afterEach(cleanup)

function renderCard(data: CitationVisibilityResponse, { hasCompetitors = true, classify = ainycClassify } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getApiV1ProjectsByNameCitationsVisibilityQueryKey({ client: heyClient, path: { name: 'ainyc' } }), data)
  return render(
    <QueryClientProvider client={queryClient}>
      <CitationVisibilitySection projectName="ainyc" classify={classify} hasCompetitors={hasCompetitors} />
    </QueryClientProvider>,
  )
}

function gridText(table: HTMLElement): string[][] {
  return [...table.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent ?? ''))
}

function bullets(container: HTMLElement): string[] {
  return [...container.querySelectorAll('details.av-details li')].map(item => item.textContent ?? '')
}

describe('byEngineClasses', () => {
  test('splits ainyc by class with one answer per query and engine', () => {
    const [nonBrand, branded, ...rest] = byEngineClasses(ainycCitationVisibility(), ainycClassify)

    expect(rest).toEqual([])
    expect(nonBrand).toMatchObject({ key: 'non-brand', queries: 11, answers: 44, competitorCited: 8, citedNotNamed: 0, namedNotCited: 0, unanswered: 0 })
    expect(nonBrand!.engines.map(({ provider, mentioned, cited }) => [provider, mentioned, cited])).toEqual([
      ['claude', 1, 2], ['gemini', 3, 3], ['openai', 0, 0], ['perplexity', 3, 4],
    ])
    expect(branded).toMatchObject({ key: 'branded', queries: 3, answers: 12, competitorCited: 0 })
    expect(branded!.engines.map(({ mentioned, cited }) => [mentioned, cited])).toEqual([[3, 2], [3, 3], [3, 2], [3, 3]])
  })

  test('counts a competitor gap only for an answer the grid counts, so it never exceeds its base', () => {
    const data = ainycCitationVisibility()
    const gap = data.competitorGaps[0]!
    // The server keeps gap rows from an engine no longer configured, and from a
    // query no longer tracked; neither is one of the answers the base counts.
    data.competitorGaps.push({ ...gap, provider: 'muse' }, { ...gap, queryId: 'query_removed', query: 'removed query' })
    const [nonBrand] = byEngineClasses(data, ainycClassify)
    expect(nonBrand).toMatchObject({ answers: 44, competitorCited: 8 })
  })

  test('a project that cannot classify gets one Unclassified class, never Non-brand', () => {
    const classes = byEngineClasses(ainycCitationVisibility(), () => null)
    expect(classes.map(entry => [entry.key, entry.queries, entry.answers, entry.competitorCited])).toEqual([['unclassified', 14, 56, 8]])
  })

  test('counts the split queries and leaves unanswered queries and missing engines out of the counts', () => {
    const data = ainycCitationVisibility()
    // Claude has no answer for the first query, and one query has none at all.
    data.byQuery[0]!.providers = data.byQuery[0]!.providers.filter(entry => entry.provider !== 'claude')
    data.byQuery.push({ queryId: 'query_new', query: 'new AEO query', providers: [], citedCount: 0, mentionedCount: 0, totalProviders: 0 })
    // "AI SEO agency NYC": Gemini cites without naming you.
    data.byQuery[2]!.providers[1] = { ...data.byQuery[2]!.providers[1]!, cited: true, citationState: 'cited' }
    // "best AEO agency New York": OpenAI names you without citing.
    const best = data.byQuery.find(row => row.query === 'best AEO agency New York')!
    best.providers[2] = { ...best.providers[2]!, mentioned: true }

    const nonBrand = byEngineClasses(data, text => ainycClassify(text) ?? 'non-brand')[0]!
    expect(nonBrand).toMatchObject({ queries: 11, unanswered: 1, answers: 43, citedNotNamed: 1, namedNotCited: 1 })
    expect(nonBrand.engines[0]).toMatchObject({ provider: 'claude', answered: 10 })
  })
})

describe('By engine card', () => {
  test('reads ainyc as the approved card', () => {
    const { container } = renderCard(ainycCitationVisibility())

    expect(screen.getByRole('heading', { name: 'By engine' })).toBeTruthy()
    const control = screen.getByRole('radiogroup', { name: 'Query type' })
    expect(within(control).getAllByRole('radio').map(option => [option.textContent, option.getAttribute('aria-checked')])).toEqual([
      ['Non-brand', 'true'], ['Branded', 'false'],
    ])
    const grid = screen.getByRole('table', { name: 'By engine, non-brand queries' })
    expect(gridText(grid)).toEqual([
      ['Of 11 queries', 'Claude', 'Gemini', 'OpenAI', 'Perplexity'],
      ['Mentioned', '1', '3', '0', '3'],
      ['Cited', '2', '3', '0', '4'],
    ])
    // Non-brand counts below 70% read amber, as the approved card draws them; never red.
    expect(grid.querySelectorAll('.av-n-sm.text-caution-400')).toHaveLength(8)
    expect(grid.querySelectorAll('.text-negative-400')).toHaveLength(0)
    expect(container.querySelector('.av-card-line')?.textContent).toBe('Competitor cited instead of you8 of 44 answers · non-brand queries')

    const details = container.querySelector<HTMLDetailsElement>('details.av-details')!
    expect(details.open).toBe(false)
    expect(bullets(container)).toEqual(['Cited but not named: 0 of 11 queries', 'Named but not cited: 0 of 11 queries'])
    // The tiles, per-query dots and per-model rate table are gone.
    expect(container.textContent).not.toMatch(/Invisible|Cited by \d|Citation rate by model|Competitor gaps/)
  })

  test('the Branded tab has its own base and is never tone-coloured', () => {
    const { container } = renderCard(ainycCitationVisibility())
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))

    const grid = screen.getByRole('table', { name: 'By engine, branded queries' })
    expect(gridText(grid)).toEqual([
      ['Of 3 queries', 'Claude', 'Gemini', 'OpenAI', 'Perplexity'],
      ['Mentioned', '3', '3', '3', '3'],
      ['Cited', '2', '3', '2', '3'],
    ])
    expect(grid.querySelectorAll('.text-negative-400, .text-caution-400, .text-positive-400')).toHaveLength(0)
    expect(container.querySelector('.av-card-line')?.textContent).toBe('Competitor cited instead of you0 of 12 answers · branded queries')
  })

  test('names the one class instead of a control, and says when no competitor is tracked', () => {
    const { container } = renderCard(ainycCitationVisibility(), { hasCompetitors: false, classify: () => null })

    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(container.querySelector('.mention-share-class')?.textContent).toBe('Unclassified')
    expect(container.querySelector('.av-card-line')?.textContent).toBe('Competitor cited instead of youNo competitors tracked')
  })

  test('names an engine that did not answer every query', () => {
    const data = ainycCitationVisibility()
    data.byQuery[0]!.providers = data.byQuery[0]!.providers.filter(entry => entry.provider !== 'claude')
    const { container } = renderCard(data)

    expect(bullets(container)).toContain('Claude: answered 10 of 11 queries')
  })

  test.each([
    ['no-queries', 'Add queries to start tracking AI citations.'],
    ['no-runs-yet', 'Engine results appear after the first AI Visibility sweep.'],
  ] as const)('keeps a plain state when there is nothing to count (%s)', (reason, copy) => {
    const { container } = renderCard(emptyCitationVisibility(reason))

    expect(screen.getByText(copy)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(container.querySelector('details.av-details')).toBeNull()
  })
})
