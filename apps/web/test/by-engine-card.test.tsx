import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameCitationsVisibilityQueryKey } from '@ainyc/canonry-api-client/react-query'
import { emptyCitationVisibility, type CitationVisibilityResponse } from '@ainyc/canonry-contracts'

import { heyClient } from '../src/api.js'
import { byEngineClasses, CitationVisibilitySection, uncountedCompetitorGaps } from '../src/components/project/CitationVisibilitySection.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'
import type { ProjectCommandCenterVm } from '../src/view-models.js'
import { ainycCitationVisibility, ainycClassify, ainycProviderScores } from './ainyc-visibility-fixture.js'

afterEach(cleanup)

function renderCard(
  data: CitationVisibilityResponse | { failed: unknown },
  { hasCompetitors = true, classify = ainycClassify, providerScores = [] as ProjectCommandCenterVm['providerScores'] } = {},
) {
  // A read that already failed stays failed on mount, so the card shows its error.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const key = getApiV1ProjectsByNameCitationsVisibilityQueryKey({ client: heyClient, path: { name: 'ainyc' } })
  if ('failed' in data) {
    queryClient.getQueryCache().build(queryClient, { queryKey: key }).setState({ status: 'error', error: data.failed as Error, fetchStatus: 'idle' })
  } else {
    queryClient.setQueryData(key, data)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <CitationVisibilitySection projectName="ainyc" classify={classify} hasCompetitors={hasCompetitors} providerScores={providerScores} />
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
    // The old tiles, engine counts and competitor gap rows are Details lines.
    expect(bullets(container)).toEqual([
      'Cited and named: 4 of 11 queries',
      'Cited but not named: 0 of 11 queries',
      'Named but not cited: 0 of 11 queries',
      'Not cited or named: 7 of 11 queries',
      'All queries: cited by 4 of 4 engines, named by 4 of 4',
      '"AEO Agency in NYC" (Claude): pbjmarketing.com cited instead of you',
      '"AEO Agency in NYC" (OpenAI): pbjmarketing.com cited instead of you',
      '"AEO Agency NYC" (Claude): pbjmarketing.com cited instead of you',
      '"AEO Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
      '"Answer Engine Optimization Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
      '"best AEO agency New York" (Claude): pbjmarketing.com cited instead of you',
      '"best AEO agency New York" (Perplexity): pbjmarketing.com cited instead of you',
      '"NYC AEO Agency" (OpenAI): pbjmarketing.com cited instead of you',
    ])
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

describe('By engine restored figures (a cleanup never removes data)', () => {
  const GAP_LINES = [
    '"AEO Agency in NYC" (Claude): pbjmarketing.com cited instead of you',
    '"AEO Agency in NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"AEO Agency NYC" (Claude): pbjmarketing.com cited instead of you',
    '"AEO Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"Answer Engine Optimization Agency NYC" (OpenAI): pbjmarketing.com cited instead of you',
    '"best AEO agency New York" (Claude): pbjmarketing.com cited instead of you',
    '"best AEO agency New York" (Perplexity): pbjmarketing.com cited instead of you',
    '"NYC AEO Agency" (OpenAI): pbjmarketing.com cited instead of you',
  ]

  test('names the competitors cited on each gap answer in the active class', () => {
    const { container } = renderCard(ainycCitationVisibility())
    for (const line of GAP_LINES) expect(bullets(container)).toContain(line)
    // Every ainyc gap is non-brand, so the Branded tab lists none.
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(bullets(container).some(line => line.includes('cited instead of you'))).toBe(false)
  })

  test('lists a gap only for an answer the card counts, and every competitor on it', () => {
    const data = ainycCitationVisibility()
    const gap = data.competitorGaps[0]!
    data.competitorGaps[0] = { ...gap, citingCompetitors: ['pbjmarketing.com', 'rival.example'] }
    data.competitorGaps.push({ ...gap, provider: 'muse' })
    const { container } = renderCard(data)
    expect(bullets(container)).toContain('"AEO Agency in NYC" (Claude): pbjmarketing.com, rival.example cited instead of you')
    expect(bullets(container).filter(line => line.endsWith('cited instead of you'))).toHaveLength(8)
    // The engine the counts leave out is listed on its own, as not counted.
    expect(bullets(container).filter(line => line.includes('not counted'))).toEqual([
      '"AEO Agency in NYC" (Muse): pbjmarketing.com cited instead of you, not counted (engine no longer configured)',
    ])
  })

  test('restores the cited-and-named and neither counts beside the other two splits', () => {
    const { container } = renderCard(ainycCitationVisibility())
    expect(bullets(container).slice(0, 4)).toEqual([
      'Cited and named: 4 of 11 queries',
      'Cited but not named: 0 of 11 queries',
      'Named but not cited: 0 of 11 queries',
      'Not cited or named: 7 of 11 queries',
    ])
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(bullets(container).slice(0, 4)).toEqual([
      'Cited and named: 3 of 3 queries',
      'Cited but not named: 0 of 3 queries',
      'Named but not cited: 0 of 3 queries',
      'Not cited or named: 0 of 3 queries',
    ])
  })

  test('restores the citation rate by model, labelled as all queries', () => {
    const { container } = renderCard(ainycCitationVisibility(), { providerScores: ainycProviderScores() })
    expect(bullets(container)).toEqual(expect.arrayContaining([
      'Claude (claude-sonnet-5) citation rate: 28.6%, 4 of 14 answers, all queries',
      'Gemini (gemini-3.5-flash) citation rate: 42.9%, 6 of 14 answers, all queries',
      'OpenAI (chat-latest) citation rate: 14.3%, 2 of 14 answers, all queries',
      'Perplexity (fast) citation rate: 50.0%, 7 of 14 answers, all queries',
    ]))
    // Per-model figures pool both classes, so they never enter the class grid.
    expect(gridText(screen.getByRole('table')).flat().some(cell => cell.includes('%'))).toBe(false)
  })

  test('names an engine without a recorded model by the engine alone', () => {
    const { container } = renderCard(ainycCitationVisibility(), { providerScores: [{ provider: 'gemini', model: null, score: 75, cited: 3, total: 4 }] })
    expect(bullets(container)).toContain('Gemini citation rate: 75.0%, 3 of 4 answers, all queries')
  })

  test('restores the latest run time in the card head', () => {
    const { container } = renderCard(ainycCitationVisibility())
    const latestRunAt = ainycCitationVisibility().summary.latestRunAt!
    expect(container.querySelector('.av-card-head .av-card-meta')?.textContent).toBe(`Latest run ${formatSweepInstant(latestRunAt)}`)
    cleanup()
    const data = ainycCitationVisibility()
    data.summary = { ...data.summary, latestRunAt: null }
    const without = renderCard(data)
    expect(without.container.querySelector('.av-card-head .av-card-meta')).toBeNull()
  })

  test('lists the gap answers outside the counts, from an engine no longer configured or a query no longer tracked', () => {
    const data = ainycCitationVisibility()
    const gap = data.competitorGaps[0]!
    data.competitorGaps.push(
      { ...gap, provider: 'mistral', citingCompetitors: ['beta.example'] },
      { ...gap, queryId: 'query_removed', query: 'removed query', provider: 'claude', citingCompetitors: ['beta.example', 'gamma.example'] },
    )
    expect(uncountedCompetitorGaps(data)).toEqual([
      { query: 'AEO Agency in NYC', provider: 'mistral', competitors: ['beta.example'], reason: 'engine' },
      { query: 'removed query', provider: 'claude', competitors: ['beta.example', 'gamma.example'], reason: 'query' },
    ])
    const { container } = renderCard(data)
    const outside = [
      '"AEO Agency in NYC" (Mistral): beta.example cited instead of you, not counted (engine no longer configured)',
      '"removed query" (Claude): beta.example, gamma.example cited instead of you, not counted (query no longer tracked)',
    ]
    expect(bullets(container).slice(-2)).toEqual(outside)
    // They belong to no class, so every tab lists them; the counts never include them.
    expect(container.querySelector('.av-card-line')?.textContent).toBe('Competitor cited instead of you8 of 44 answers · non-brand queries')
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(bullets(container).slice(-2)).toEqual(outside)
  })

  test.each([
    ['an Error', new Error('engine results store unavailable')],
    // What the generated SDK throws for a failed read: the API's error envelope.
    ['the API error envelope', { error: { code: 'INTERNAL_ERROR', message: 'engine results store unavailable' } }],
  ])('says why engine results could not load (%s)', (_shape, failed) => {
    renderCard({ failed })
    expect(screen.getByText('Could not load engine results: engine results store unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  test('restores how many engines cite you and name you', () => {
    const data = ainycCitationVisibility()
    data.summary = { ...data.summary, providersCiting: 3, providersMentioning: 4 }
    const { container } = renderCard(data)
    expect(bullets(container)).toContain('All queries: cited by 3 of 4 engines, named by 4 of 4')
  })
})
