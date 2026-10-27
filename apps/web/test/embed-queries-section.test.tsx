import React from 'react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { EMBED_QUERIES_COPY, EmbedQueriesSection } from '../src/components/project/EmbedQueriesSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const VERSION_A = `qtw_${'a'.repeat(64)}`
const VERSION_B = `qtw_${'b'.repeat(64)}`
const TOKEN = `qtp_${'c'.repeat(64)}`
const REVIEWED_AT = '2026-10-26T12:00:00.000Z'
const BASE = '/api/v1/projects/summit/query-tracking'

type Call = { path: string; method: string; body?: Record<string, unknown> }

let questions: string[]
let version: string
let calls: Call[]
let respond: (call: Call) => Response | undefined
let restoreFetch: () => void

function row(text: string) {
  return {
    queryId: `q-${text.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    queryText: text,
    normalizedText: text.toLowerCase(),
    provenance: null,
    state: 'tracked',
    lastMeasuredAt: null,
    assignments: [],
  }
}

function workspace(mode: 'simple' | 'advanced' = 'simple') {
  return {
    mode, workspaceVersion: version, active: null, defaultContexts: [], targets: [], groups: [], markets: [],
    tracked: questions.map(row), savedSources: { research: [], discovery: [] },
  }
}

const diff = (noOp = false) => ({ added: [], removed: [], reused: [], unchanged: [], noOp })
const workload = {
  existingNodes: 0, existingProviderCalls: 0, nextSweepNodes: 0, nextSweepProviderCalls: 0,
  addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0,
}

/** A fake engine: review mirrors the change, save applies it and moves the version. */
function engine(call: Call): Response {
  if (call.method === 'GET' && call.path === BASE) return jsonResponse(workspace())
  const body = call.body ?? {}
  const additions = (body.additions as Array<{ input: { text: string } }> | undefined) ?? []
  const removals = (body.removals as Array<{ queryId: string }> | undefined) ?? []
  const added = additions.map(addition => addition.input.text)
  const noOp = added.length > 0 && added.every(text => questions.some(q => q.toLowerCase() === text.toLowerCase()))
  if (call.path === `${BASE}/preview`) {
    return jsonResponse({ mode: 'simple', workspaceVersion: version, previewToken: TOKEN, reviewedAt: REVIEWED_AT, active: null, tracked: [], diff: diff(noOp), workload })
  }
  if (call.path === `${BASE}/commit`) {
    questions = [...questions.filter(q => !removals.some(removal => removal.queryId === row(q).queryId)), ...added]
    version = version === VERSION_A ? VERSION_B : VERSION_A
    return jsonResponse({ committed: true, mode: 'simple', workspaceVersion: version, reviewedAt: REVIEWED_AT, active: null, diff: diff(), workload })
  }
  return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404)
}

beforeEach(() => {
  questions = ['best hvac company in denver', 'furnace repair cost denver', 'emergency ac repair near me']
  version = VERSION_A
  calls = []
  respond = () => undefined
  window.sessionStorage.clear()
  restoreFetch = mockFetch(async (url, init) => {
    const call: Call = {
      path: pathOf(url).split('?')[0]!,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    }
    calls.push(call)
    return respond(call) ?? engine(call)
  })
})

afterEach(() => {
  restoreFetch()
  cleanup()
})

function renderSection(limit = 10) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmbedQueriesSection projectName="summit" limit={limit} />
    </QueryClientProvider>,
  )
}

const input = () => screen.getByLabelText(EMBED_QUERIES_COPY.inputLabel) as HTMLInputElement
const addButton = () => screen.getByRole('button', { name: EMBED_QUERIES_COPY.add })
const writes = () => calls.filter(call => call.method === 'POST').map(call => call.path.replace(`${BASE}/`, ''))

async function typeAndAdd(text: string) {
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.click(addButton())
}

test('lists the questions with the count and how results arrive, naming no date', async () => {
  renderSection()
  expect(await screen.findByText('best hvac company in denver')).toBeTruthy()
  expect(screen.getByText('3 of 10 queries')).toBeTruthy()
  expect(screen.getByText(/New queries show results after the next check/)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3)
})

test('adds a question with one review and one save, then clears the field', async () => {
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('  Who installs heat pumps near Aurora?  ')

  expect(await screen.findByText('Who installs heat pumps near Aurora?')).toBeTruthy()
  expect(writes()).toEqual(['preview', 'commit'])
  const [review, save] = calls.filter(call => call.method === 'POST')
  expect(review!.body).toEqual({
    additions: [{ input: { source: 'manual', text: 'Who installs heat pumps near Aurora?' } }],
    removals: [],
    expectedWorkspaceVersion: VERSION_A,
  })
  expect(save!.body).toMatchObject({ previewToken: TOKEN, reviewedAt: REVIEWED_AT, expectedWorkspaceVersion: VERSION_A })
  await waitFor(() => expect(input().value).toBe(''))
  expect(screen.getByText('4 of 10 queries')).toBeTruthy()
  expect(window.sessionStorage.getItem('canonry:embed-query-draft:summit')).toBeNull()
})

test('says a question is already tracked without saving anything', async () => {
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('Best HVAC  company in Denver')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', EMBED_QUERIES_COPY.duplicate)
  expect(writes()).toEqual([])
  expect(input().getAttribute('aria-invalid')).toBe('true')
})

test('trusts the engine when it finds the duplicate', async () => {
  respond = call => call.path.endsWith('/preview')
    ? jsonResponse({ mode: 'simple', workspaceVersion: version, previewToken: TOKEN, reviewedAt: REVIEWED_AT, active: null, tracked: [], diff: diff(true), workload })
    : undefined
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('a question the engine already has')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', EMBED_QUERIES_COPY.duplicate)
  expect(writes()).toEqual(['preview'])
})

test('reviews once more when the list changed underneath', async () => {
  let stale = true
  respond = call => {
    if (call.path.endsWith('/preview') && stale) {
      stale = false
      version = VERSION_B
      return jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'stale' } }, 409)
    }
    return undefined
  }
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('Who installs heat pumps near Aurora?')
  expect(await screen.findByText('Who installs heat pumps near Aurora?')).toBeTruthy()
  const reviews = calls.filter(call => call.path.endsWith('/preview'))
  expect(reviews.map(call => call.body?.expectedWorkspaceVersion)).toEqual([VERSION_A, VERSION_B])
})

test('explains the limit when the engine refuses an add', async () => {
  respond = call => call.path.endsWith('/preview')
    ? jsonResponse({ error: { code: 'EMBED_QUERY_LIMIT', message: 'limit', details: { limit: 10, attempted: 11 } } }, 409)
    : undefined
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('one too many')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', EMBED_QUERIES_COPY.limit(10))
})

test('turns the field off at the limit, keeping it focusable, and says why', async () => {
  renderSection(3)
  await screen.findByText('best hvac company in denver')
  expect(input().readOnly).toBe(true)
  expect(input().getAttribute('aria-disabled')).toBe('true')
  expect(input().disabled).toBe(false)
  expect((addButton() as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(EMBED_QUERIES_COPY.limit(3))).toBeTruthy()
})

test('shows the limit as soon as an add fills the list', async () => {
  renderSection(4)
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('Who installs heat pumps near Aurora?')
  expect(await screen.findByText(EMBED_QUERIES_COPY.limit(4))).toBeTruthy()
  expect(input().getAttribute('aria-disabled')).toBe('true')
})

test('removes a question, moves focus to the next one, and can undo', async () => {
  renderSection()
  await screen.findByText('furnace repair cost denver')
  fireEvent.click(screen.getByRole('button', { name: 'Remove furnace repair cost denver' }))

  expect(await screen.findByText(EMBED_QUERIES_COPY.removed('furnace repair cost denver'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove furnace repair cost denver' })).toBeNull()
  const [review] = calls.filter(call => call.path.endsWith('/preview'))
  expect(review!.body).toMatchObject({ additions: [], removals: [{ queryId: row('furnace repair cost denver').queryId }] })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove emergency ac repair near me' })))

  fireEvent.click(screen.getByRole('button', { name: EMBED_QUERIES_COPY.undo }))
  expect(await screen.findByText('furnace repair cost denver')).toBeTruthy()
  expect(writes()).toEqual(['preview', 'commit', 'preview', 'commit'])
  await waitFor(() => expect(document.activeElement).toBe(input()))
})

test('says a failed save plainly and keeps the typed question', async () => {
  respond = call => call.path.endsWith('/commit') ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : undefined
  renderSection()
  await screen.findByText('best hvac company in denver')
  await typeAndAdd('Who installs heat pumps near Aurora?')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', EMBED_QUERIES_COPY.failed)
  expect(input().value).toBe('Who installs heat pumps near Aurora?')
})

test('keeps an unsent question across the host page reloading the dashboard', async () => {
  const first = renderSection()
  await screen.findByText('best hvac company in denver')
  fireEvent.change(input(), { target: { value: 'half typed' } })
  first.unmount()

  renderSection()
  await screen.findByText('best hvac company in denver')
  expect(input().value).toBe('half typed')
})

test('shows an advanced portfolio read-only', async () => {
  respond = call => call.method === 'GET' ? jsonResponse(workspace('advanced')) : undefined
  renderSection()
  expect(await screen.findByText('best hvac company in denver')).toBeTruthy()
  expect(screen.getByText(/Your agency manages these queries/)).toBeTruthy()
  expect(screen.queryByLabelText(EMBED_QUERIES_COPY.inputLabel)).toBeNull()
  expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
})
