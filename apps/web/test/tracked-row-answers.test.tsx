import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { QueryTrackingAnswerRow, QueryTrackingResultsResponse } from '@canonry/canonry-contracts'

import { TrackedRowAnswers } from '../src/components/project/queries/advanced/TrackedRowAnswers.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

const RUN = { id: 'run-7', createdAt: '2026-10-07T12:00:00.000Z', completedAt: '2026-10-07T12:10:00.000Z', status: 'completed' as const, revision: 4, matchesCurrentTracking: true }
const LABELS: Record<string, string> = { harbor: 'Harbor Point', river: 'River Point', summit: 'Summit Lofts' }
const targetLabel = (key: string) => LABELS[key] ?? key

const answer = (overrides: Partial<QueryTrackingAnswerRow>): QueryTrackingAnswerRow => ({
  resultId: 'result-1',
  searchLocation: null,
  targetKeys: ['harbor', 'river', 'summit'],
  mentioned: false,
  cited: false,
  mentionedTargetKeys: [],
  citedTargetKeys: [],
  namedInstead: [],
  ...overrides,
})
const engine = (provider: string, answerRows: QueryTrackingAnswerRow[]) => ({
  provider,
  expectedAnswers: answerRows.length,
  answers: answerRows.length,
  mentionedAnswers: answerRows.filter(row => row.mentioned).length,
  citedAnswers: answerRows.filter(row => row.cited).length,
  uncheckedSourceAnswers: 0,
  mentioned: answerRows.some(row => row.mentioned),
  cited: answerRows.some(row => row.cited),
  answerRows,
})
function response(overrides: Partial<QueryTrackingResultsResponse> = {}): QueryTrackingResultsResponse {
  return {
    mode: 'advanced',
    scope: { kind: 'project', key: null },
    run: RUN,
    engines: ['claude', 'gemini', 'openai'],
    rows: [{
      queryId: 'q-uptown',
      queryText: 'best apartments in Uptown',
      queryClass: 'non-brand',
      engines: [
        engine('gemini', [answer({ resultId: 'result-gemini', mentioned: true, mentionedTargetKeys: ['river'], namedInstead: ['Rival A'] })]),
        engine('openai', [answer({ resultId: 'result-openai', namedInstead: ['Rival A', 'Rival B', 'Rival C', 'Rival D'] })]),
        engine('claude', [answer({ resultId: null, mentioned: null, cited: null })]),
      ],
    }],
    pendingRows: 0,
    ...overrides,
  } as QueryTrackingResultsResponse
}

function renderAnswers(results: () => Response, answerText = 'Rival A is the best pick in Uptown.') {
  const requests: string[] = []
  const restore = mockFetch(url => {
    const parsed = new URL(url)
    requests.push(`${parsed.pathname.replace('/api/v1/projects/demo', '')}${parsed.search}`)
    if (parsed.pathname.endsWith('/query-tracking/results')) return results()
    if (parsed.pathname.endsWith('/measurement-question-result')) return jsonResponse({ answer: answerText })
    throw new Error(`Unexpected fetch: ${parsed.pathname}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TrackedRowAnswers projectName="demo" selection={{ measurementScope: 'market', measurementScopeKey: 'uptown' }} queryId="q-uptown" runId="run-7" targetLabel={targetLabel} />
    </QueryClientProvider>,
  )
  return { requests, restore }
}

const lines = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map(row => [...(row as HTMLTableRowElement).cells].map(cell => cell.textContent))

describe('TrackedRowAnswers', () => {
  test('reads the one query on the sweep the list reads, and shows what each engine answered', async () => {
    const { requests, restore } = renderAnswers(() => jsonResponse(response()))
    await screen.findByRole('table')
    expect(requests).toEqual(['/query-tracking/results?scope=market&scopeKey=uptown&queryId=q-uptown&runId=run-7'])
    expect(screen.getByRole('heading', { level: 4 }).textContent).toMatch(/^Last sweep /)
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Engine', 'Result', 'Location mentioned', 'Mentioned instead', 'Answer'])
    expect(lines()).toEqual([
      ['Gemini', 'MC', 'River Point', 'Rival A', 'Read answer'],
      ['OpenAI', 'MC', 'None', 'Rival A · Rival B · Rival C +1', 'Read answer'],
      ['Claude', 'MC', 'None', 'None', 'No answer saved'],
    ])
    // Each line's marks are that answer's own.
    expect(screen.getByLabelText('Gemini: Mentioned, Not cited')).toBeTruthy()
    expect(screen.getByLabelText('OpenAI: Not mentioned, Not cited')).toBeTruthy()
    restore()
  })

  test('opens one answer at a time, read under the location the answer counts for', async () => {
    const { requests, restore } = renderAnswers(() => jsonResponse(response()))
    fireEvent.click(await screen.findByRole('button', { name: 'Read the Gemini answer' }))
    expect(await screen.findByText('Rival A is the best pick in Uptown.')).toBeTruthy()
    expect(requests.at(-1)).toBe('/measurement-question-result?targetKey=harbor&resultId=result-gemini&fallback=last-sweep')
    expect(screen.getByRole('button', { name: 'Hide the Gemini answer' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Read the OpenAI answer' }))
    expect(screen.getByRole('button', { name: 'Read the Gemini answer' }).getAttribute('aria-expanded')).toBe('false')
    restore()
  })

  test('drops a column that cannot tell the lines apart: one location covered, one type, one search location', async () => {
    const one = response({ rows: [{ ...response().rows[0]!, engines: [engine('gemini', [answer({ targetKeys: ['harbor'], mentionedTargetKeys: ['harbor'], mentioned: true })])] }] })
    const { restore } = renderAnswers(() => jsonResponse(one))
    await screen.findByRole('table')
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Engine', 'Result', 'Mentioned instead', 'Answer'])
    restore()
  })

  test('says when no sweep has finished, when the query is newer than the last sweep, and when the read fails', async () => {
    let { restore } = renderAnswers(() => jsonResponse(response({ run: null, rows: [] })))
    expect(await screen.findByText('Not measured')).toBeTruthy()
    restore(); cleanup()
    ;({ restore } = renderAnswers(() => jsonResponse(response({ rows: [] }))))
    expect(await screen.findByText('Not in last sweep')).toBeTruthy()
    restore(); cleanup()
    let fail = true
    ;({ restore } = renderAnswers(() => fail ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500) : jsonResponse(response())))
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Answers unavailable/)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry answers' }))
    expect(await screen.findByRole('table')).toBeTruthy()
    restore()
  })
})
