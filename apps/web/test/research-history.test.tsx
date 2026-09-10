import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.historyMore }))
  await screen.findByText(RESEARCH_COPY.historyMoreError)
  expect(screen.getByText(newest.queries[0]!.answerText!)).toBeTruthy()
  failOlder = false
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.historyMore }))
  await waitFor(() => expect(screen.queryByRole('button', { name: RESEARCH_COPY.historyMore })).toBeNull())
  expect(screen.getByText(newest.queries[0]!.answerText!)).toBeTruthy()
  const row = screen.getAllByRole('row').find(item => item.textContent?.includes(older.resolvedModel))!
  fireEvent.click(row.querySelector('button')!)
  await screen.findByText(older.queries[0]!.answerText!)
  expect(cursors).toEqual([null, 'older-page', 'older-page'])
})
