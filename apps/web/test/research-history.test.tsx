import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResearchRunDetailDto } from '@ainyc/canonry-contracts'
import { RESEARCH_COPY, ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function savedRun(id: string, createdAt: string): ResearchRunDetailDto {
  return {
    id, projectId: 'demo', status: 'completed', provider: 'openai', requestedModel: id, resolvedModel: id,
    location: null, scope: null, totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null,
    initiatedBy: null, startedAt: null, finishedAt: null, createdAt,
    queries: [{ id: id + '-query', position: 0, query: id + ' query', status: 'completed',
      requestedModel: id, resolvedModel: id, servedModel: id, answerText: id + ' answer',
      groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
      answerMentioned: false, citationState: 'not-cited', error: null, startedAt: null, finishedAt: null, createdAt }],
  }
}

test('older history pages can be retried without losing the selected answer or loaded runs', async () => {
  const newest = savedRun('newest', '2026-09-10T12:00:00.000Z')
  const older = savedRun('older', '2026-09-09T12:00:00.000Z')
  const cursors: Array<string | null> = []
  let failOlder = true
  const restore = mockFetch((url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/research/runs')) {
      const cursor = parsed.searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor && failOlder) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503)
      return jsonResponse({ runs: [cursor ? older : newest], providers: [], access: { canRun: false, dailyRunLimit: null }, nextCursor: cursor ? null : 'older-page' })
    }
    if (parsed.pathname.endsWith('/research/runs/' + newest.id)) return jsonResponse(newest)
    if (parsed.pathname.endsWith('/research/runs/' + older.id)) return jsonResponse(older)
    if (parsed.pathname === '/api/v1/projects/demo') return jsonResponse({ name: 'demo', providers: [], providerModels: {}, locations: [], defaultLocation: null })
    if (parsed.pathname === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [] })
    throw new Error('Unexpected request: ' + url)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)
  await screen.findByText(newest.queries[0]!.answerText!)
  // Past research is closed until asked for. Its count is the runs loaded, with a plus while an older page is left to load.
  const history = screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).closest('details')!
  expect(history.open).toBe(false)
  expect(history.querySelector('summary')!.textContent).toBe('Past research1+ runs')
  fireEvent.click(history.querySelector('summary')!)
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.historyMore }))
  // The failed page is one short label with its sentence in the tooltip, and the same button becomes its Retry.
  const failed = await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. ${RESEARCH_COPY.historyMoreError}` })
  expect(failed.textContent).toBe('Could not load')
  expect(failed.closest('[role="alert"]')).toBeTruthy()
  expect(screen.queryByRole('button', { name: RESEARCH_COPY.historyMore })).toBeNull()
  expect(screen.getByText(newest.queries[0]!.answerText!)).toBeTruthy()
  failOlder = false
  const retry = screen.getByRole('button', { name: 'Retry older runs' })
  expect(retry.textContent).toBe(RESEARCH_COPY.retry)
  fireEvent.click(retry)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry older runs' })).toBeNull())
  expect(screen.queryByRole('button', { name: RESEARCH_COPY.historyMore })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(newest.queries[0]!.answerText!)).toBeTruthy()
  // Both pages are in, and no older one is left.
  expect(history.querySelector('summary')!.textContent).toBe('Past research2 runs')
  const row = screen.getAllByRole('row').find(item => item.textContent?.includes(older.resolvedModel))!
  fireEvent.click(row.querySelector('button')!)
  await screen.findByText(older.queries[0]!.answerText!)
  expect(cursors).toEqual([null, 'older-page', 'older-page'])
})

test('past research names each run by engine, Subject and search location, and a failed read offers one Retry', async () => {
  const market = { ...savedRun('market-run', '2026-09-10T12:00:00.000Z'), provider: 'gemini', scope: { kind: 'market' as const, key: 'harbor-point', label: 'Harbor Point', planRevision: 3 }, location: { label: 'Northbridge', city: 'Northbridge', region: 'IL', country: 'US' } }
  const plain = savedRun('plain-run', '2026-09-09T12:00:00.000Z')
  let reads = 0
  let fail = true
  const restore = mockFetch((url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/research/runs')) {
      reads += 1
      if (fail) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503)
      return jsonResponse({ runs: [market, plain], providers: [], access: { canRun: false, dailyRunLimit: null }, nextCursor: null })
    }
    if (parsed.pathname.endsWith('/research/runs/' + market.id)) return jsonResponse(market)
    if (parsed.pathname.endsWith('/research/runs/' + plain.id)) return jsonResponse(plain)
    if (parsed.pathname === '/api/v1/projects/demo') return jsonResponse({ name: 'demo', providers: [], providerModels: {}, locations: [], defaultLocation: null })
    if (parsed.pathname === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [] })
    throw new Error('Unexpected request: ' + url)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  expect(screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).textContent).toBe('Past research')
  expect(screen.getByRole('status', { name: 'Loading past research' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle })).getByRole('status', { name: RESEARCH_COPY.resultsLoading })).toBeTruthy()
  const failed = await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. ${RESEARCH_COPY.historyError}` })
  expect(failed.textContent).toBe('Could not load')
  // The failure shows on the Past research row itself, never inside a closed disclosure.
  expect(failed.closest('details')).toBeNull()
  expect(failed.closest('[role="alert"]')!.textContent).toBe('Past researchCould not loadRetry')
  // No results card and no table are drawn over a history that did not load.
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('region', { name: RESEARCH_COPY.resultsTitle })).toBeNull()
  const readsBefore = reads
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry past research' }))
  const history = (await screen.findAllByRole('table'))[0]!
  expect(reads).toBe(readsBefore + 1)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(within(history).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Run', 'Engine', 'Subject', 'Search location', 'Progress', 'Status'])
  const cells = (id: string) => within(within(history).getAllByRole('row').find(row => row.textContent?.includes(id))!).getAllByRole('cell').slice(1).map(cell => cell.textContent)
  expect(cells(market.id)).toEqual([`Gemini${market.id}`, 'Harbor Point', 'Northbridge', '1 of 1', 'Completed'])
  // A run saved under no Subject and asked from no search location says so in those words.
  expect(cells(plain.id)).toEqual([`OpenAI${plain.id}`, RESEARCH_COPY.notSet, RESEARCH_COPY.noSearchLocation, '1 of 1', 'Completed'])
  // The whole history is loaded, so its count is exact. The table sits in the disclosure, closed until opened.
  const disclosure = history.closest('details')!
  expect(disclosure.querySelector('summary')!.textContent).toBe('Past research2 runs')
  expect(disclosure.open).toBe(false)
})

test('with no saved runs the page says No research yet and draws no Results card', async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/research/runs')) return jsonResponse({ runs: [], providers: [], access: { canRun: false, dailyRunLimit: null }, nextCursor: null })
    if (parsed.pathname === '/api/v1/projects/demo') return jsonResponse({ name: 'demo', providers: [], providerModels: {}, locations: [], defaultLocation: null })
    if (parsed.pathname === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [] })
    throw new Error('Unexpected request: ' + url)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  expect((await screen.findByText(RESEARCH_COPY.emptyHistory)).textContent).toBe('No research yet')
  expect(screen.queryByRole('table')).toBeNull()
  // Nothing to open and nothing to show results for: one row says so.
  expect(screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).closest('details')).toBeNull()
  expect(screen.queryByRole('region', { name: RESEARCH_COPY.resultsTitle })).toBeNull()
})

test('a run whose results did not load offers Retry and reads them again', async () => {
  const run = savedRun('only-run', '2026-09-10T12:00:00.000Z')
  let fail = true
  const restore = mockFetch((url) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/research/runs')) return jsonResponse({ runs: [run], providers: [], access: { canRun: false, dailyRunLimit: null }, nextCursor: null })
    if (parsed.pathname.endsWith('/research/runs/' + run.id)) return fail ? jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503) : jsonResponse(run)
    if (parsed.pathname === '/api/v1/projects/demo') return jsonResponse({ name: 'demo', providers: [], providerModels: {}, locations: [], defaultLocation: null })
    if (parsed.pathname === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [] })
    throw new Error('Unexpected request: ' + url)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  render(<QueryClientProvider client={client}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const failed = await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. ${RESEARCH_COPY.resultsError}` })
  expect(failed.textContent).toBe('Could not load')
  // The failure is the body of the Results card, under the run it belongs to, with its Retry beside it.
  const results = screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle })
  expect(within(results).getByRole('heading').textContent).toBe('Results')
  expect(within(results).getByRole('alert').textContent).toBe('Run only-runCould not loadRetry')
  expect(within(within(results).getByRole('alert')).getAllByRole('button').map(button => button.textContent)).toEqual(['Could not load', 'Retry'])
  // The run list is still there to pick another run from.
  expect(screen.getAllByRole('table')).toHaveLength(1)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry results' }))
  await screen.findByText(run.queries[0]!.answerText!)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.querySelector('[role="region"] dl > div')!.textContent).toBe('Runonly-run')
})
