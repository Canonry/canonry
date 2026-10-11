import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResearchBatchCreate, ResearchRunDetailDto } from '@ainyc/canonry-contracts'

import { QueriesSection, type QueriesSectionProps } from '../src/components/project/DiscoverySection.js'
import { RESEARCH_COPY, ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { FIND_COPY } from '../src/components/project/queries/FindQueriesSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

// Research as one page under Tracked | Research: where it opens, what "Start from" offers, the places a pattern repeats for, the select over a batch's results, Find ideas, and tracking ticked results on an Advanced project.

afterEach(() => { cleanup(); resetToasts(); delete window.__CANONRY_CONFIG__ })

const MARKETS = ['Harbor Point', 'Northbridge', 'Old Mill', 'Riverside', 'Lakeshore']
const slug = (label: string) => label.toLowerCase().replace(/\s+/g, '-')
/** The server's own list of places. The plan's `markets` and `targets` hold other names, so a list rebuilt from them would show. */
const scopeOptions = [
  { id: 'project', label: 'Acme Homes', kind: 'project', targetCount: 2 },
  { id: 'metro', label: 'Lakeshore Metro', kind: 'group', targetCount: 2 },
  ...MARKETS.map(label => ({ id: slug(label), label, kind: 'market', targetCount: 0 })),
  { id: 'lofts', label: 'Acme Homes Lofts', kind: 'property', targetCount: 1 },
]
const downtown = { label: 'Downtown', city: 'Downtown', region: 'IL', country: 'US' }
const session = {
  id: 'session-one-1', projectId: 'project_demo', status: 'completed', icpDescription: null,
  probeCount: 9, citedCount: 2, aspirationalCount: 4, wastedCount: 3,
  competitorMap: [{ domain: 'rentals.example', hits: 5 }], createdAt: '2026-10-01T10:00:00.000Z',
}
/** A run still at work: it has no results yet. */
const testing = { ...session, id: 'testing-two-2', status: 'probing', probeCount: 4, citedCount: 0, aspirationalCount: 0, wastedCount: 0, competitorMap: [] }
/** Three results for a run that says it tested nine, so a count taken from the run would show. */
const probes = [
  { id: 'probe-cited', query: 'Lofts near transit', bucket: 'cited', citationState: 'cited', citedDomains: ['demo.example'], answerMentioned: true },
  { id: 'probe-skip', query: 'Cheapest storage units', bucket: 'wasted-surface', citationState: 'not-cited', citedDomains: [], answerMentioned: false },
  { id: 'probe-none', query: 'Storage near the harbor', bucket: null, citationState: 'not-cited', citedDomains: [], answerMentioned: false },
].map(probe => ({ ...probe, sessionId: session.id, projectId: session.projectId, createdAt: session.createdAt }))

type Options = {
  engine?: boolean; scopeOptions?: boolean; searchLocations?: boolean; sessions?: Array<typeof session>; failSessions?: boolean; failResults?: boolean; savedRunStatus?: ResearchRunDetailDto['status']
  /** A plan that holds the places research is saved under, so a result can be tracked for one. */
  plan?: boolean
  /** Saved runs beside the older one, newest first. */
  saved?: ResearchRunDetailDto[]
  /** The results of a finished Find ideas run, in place of the three. */
  probes?: typeof probes
}

const workspaceVersion = `qtw_${'a'.repeat(64)}`
const reviewedVersion = `qtw_${'f'.repeat(64)}`
const previewToken = `qtp_${'b'.repeat(64)}`
const reviewedAt = '2026-10-02T12:30:00.000Z'
const activePlan = { revision: 7, compiledChecksum: 'c'.repeat(64) }
const searchContext = { providers: ['openai'], models: { openai: 'model-a' }, location: downtown }
/** One location per market, so each market reads as holding one. Harbor Point holds Acme Homes Lofts. */
const planTargets = MARKETS.map(label => label === 'Harbor Point' ? { stableKey: 'lofts', label: 'Acme Homes Lofts' } : { stableKey: `${slug(label)}-homes`, label: `${label} Homes` })
const planMarkets = MARKETS.map((label, index) => ({ stableKey: slug(label), label, usageEdges: [{ executionNodeKey: `node-${index}`, targetKey: planTargets[index]!.stableKey, queryId: `seed-${index}` }] }))
type TrackedFixture = { queryId: string; queryText: string; focus: { kind: 'market' | 'property'; key: string } | { kind: 'not-asked' } }
/** `normalizedText` as the server stores it: trimmed, single-spaced and lower case. */
const trackedRow = ({ queryId, queryText, focus }: TrackedFixture) => ({
  queryId, queryText, normalizedText: queryText.trim().replace(/\s+/g, ' ').toLowerCase(), provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-30T12:00:00.000Z' },
  state: 'awaiting-sweep', lastMeasuredAt: null, assignments: [], focus, queryClasses: focus.kind === 'not-asked' ? [] : ['non-brand'],
})

function installApi(options: Options = {}) {
  const state = {
    paths: [] as string[], posts: [] as Array<{ path: string; body: unknown }>, runs: [] as ResearchRunDetailDto[],
    failSessions: options.failSessions ?? false, failResults: options.failResults ?? false, holdResults: null as Promise<void> | null,
    /** The tracked queries of the plan. A publish adds to them, as the server does. */
    tracked: [] as TrackedFixture[], failWorkspace: false,
  }
  const listedProbes = options.probes ?? probes
  const catalog = [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'model-a', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }]
  const restore = mockFetch(async (url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') state.posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    else state.paths.push(path)
    if (path === '/api/v1/projects/demo/research/batches' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as ResearchBatchCreate
      state.runs = body.runs.map((run, index) => ({
        id: `batch-run-${index}`, projectId: 'project_demo', status: index === 1 ? 'partial' : 'completed', provider: run.provider, requestedModel: run.model, resolvedModel: run.model,
        location: run.location, scope: run.scope ? { kind: run.scope.kind, key: run.scope.key, label: scopeOptions.find(option => option.id === run.scope!.key)!.label, planRevision: run.scope.expectedPlanRevision! } : null,
        template: null, totalQueries: run.queries.length, completedQueries: run.queries.length, failedQueries: 0, error: null,
        initiatedBy: null, startedAt: null, finishedAt: null, createdAt: '2026-10-02T12:00:00.000Z',
        queries: run.queries.map((query, position) => ({
          id: `batch-run-${index}-query-${position}`, position, query, queryClass: 'non-brand', status: 'completed', requestedModel: run.model, resolvedModel: run.model, servedModel: run.model,
          answerText: `Answer to ${query}`, groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
          answerMentioned: index % 2 === 0, citationState: 'not-cited', error: null, startedAt: null, finishedAt: null, createdAt: '2026-10-02T12:00:00.000Z',
        })),
      }))
      // The batch answers before any run has started. What each run came to is read from past research.
      return jsonResponse({ runs: state.runs.map(run => ({ ...run, status: 'queued', completedQueries: 0, queries: [] })) }, 202)
    }
    if (path === '/api/v1/projects/demo/discover/run' && method === 'POST') return jsonResponse({ runId: 'run-1', sessionId: session.id, status: 'queued' }, 202)
    const saved = [...state.runs, ...(options.saved ?? []), { ...older, status: options.savedRunStatus ?? older.status }]
    if (options.plan && method === 'POST' && (path === '/api/v1/projects/demo/query-tracking/preview' || path === '/api/v1/projects/demo/query-tracking/commit')) {
      const body = JSON.parse(String(init!.body)) as { additions: Array<{ input: { researchRunQueryId?: string; discoveryProbeId?: string }; audience: { marketKeys?: string[]; targetKeys?: string[] } }> }
      // The server reads each query's text from the saved row its addition names.
      const added = body.additions.map(({ input, audience }, index): TrackedFixture => ({
        queryId: `tracked-new-${state.tracked.length + index}`,
        queryText: input.researchRunQueryId ? saved.flatMap(run => run.queries).find(query => query.id === input.researchRunQueryId)!.query : listedProbes.find(probe => probe.id === input.discoveryProbeId)!.query,
        focus: audience.targetKeys ? { kind: 'property', key: audience.targetKeys[0]! } : { kind: 'market', key: audience.marketKeys![0]! },
      }))
      const diff = { added: added.map(row => ({ queryId: row.queryId, queryText: row.queryText, assignmentCount: 1 })), removed: [], reused: [], unchanged: [], noOp: false }
      const workload = { existingNodes: 5, existingProviderCalls: 5, nextSweepNodes: 5 + added.length, nextSweepProviderCalls: 5 + added.length, addedNodes: added.length, addedProviderCalls: added.length, removedNodes: 0, removedProviderCalls: 0 }
      if (path.endsWith('/preview')) return jsonResponse({ mode: 'advanced', workspaceVersion: reviewedVersion, previewToken, reviewedAt, active: activePlan, tracked: [...state.tracked, ...added].map(trackedRow), diff, workload })
      state.tracked.push(...added)
      return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion: reviewedVersion, reviewedAt, active: activePlan, diff, workload })
    }
    if (method !== 'GET') throw new Error(`Unexpected ${method}: ${path}`)
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: saved.map(({ queries: _queries, ...run }) => run), nextCursor: null })
    if (path.startsWith('/api/v1/projects/demo/research/runs/')) return jsonResponse(saved.find(run => path.endsWith(`/${run.id}`)))
    if (path === '/api/v1/projects/demo/query-tracking' && state.failWorkspace) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503)
    if (path === '/api/v1/projects/demo/query-tracking') return jsonResponse({
      mode: 'advanced', workspaceVersion, active: activePlan, defaultContexts: options.plan ? [searchContext] : [],
      ...(options.plan ? { targets: planTargets, markets: planMarkets } : { targets: [{ stableKey: 'plan-target', label: 'Plan target' }], markets: [{ stableKey: 'plan-market', label: 'Plan market', usageEdges: [] }] }), groups: [],
      ...(options.scopeOptions === false ? {} : { scopeOptions }), tracked: state.tracked.map(trackedRow), savedSources: { research: [], discovery: [] },
    })
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    if (path === '/api/v1/projects/demo/discover/sessions') return state.failSessions ? jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503) : jsonResponse(options.sessions ?? [])
    const found = (options.sessions ?? []).find(item => path === `/api/v1/projects/demo/discover/sessions/${item.id}`)
    if (found) {
      if (state.holdResults) await state.holdResults
      if (state.failResults) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503)
      return jsonResponse({ ...found, probes: found.status === 'completed' ? listedProbes : [] })
    }
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', displayName: 'Acme Homes', canonicalDomain: 'https://www.demo.example/', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {}, locations: options.searchLocations === false ? [] : [downtown], defaultLocation: null,
      autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({ providers: options.engine === false ? [] : [{ name: 'openai', displayName: 'OpenAI', configured: true }], providerCatalog: catalog })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restore)
  return state
}

/** A run saved before this visit, so the page has results to show on arrival. */
const older: ResearchRunDetailDto = {
  id: 'older-run', projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: 'model-a', resolvedModel: 'model-a',
  location: null, scope: null, template: null, totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null,
  initiatedBy: null, startedAt: null, finishedAt: null, createdAt: '2026-10-01T12:00:00.000Z',
  queries: [{
    id: 'older-query', position: 0, query: 'Older saved query', queryClass: 'non-brand', status: 'completed', requestedModel: 'model-a', resolvedModel: 'model-a', servedModel: 'model-a',
    answerText: 'Older saved answer', groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
    answerMentioned: false, citationState: 'not-cited', error: null, startedAt: null, finishedAt: null, createdAt: '2026-10-01T12:00:00.000Z',
  }],
}

function renderPage(props: Partial<QueriesSectionProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const page = (next: Partial<QueriesSectionProps>) => <QueryClientProvider client={queryClient}><QueriesSection projectName="demo" queryWorkspace="research" {...next} /></QueryClientProvider>
  const view = render(page(props))
  return { rerender: (next: Partial<QueriesSectionProps>) => view.rerender(page(next)) }
}

const RUN = /^Run(?: \d+ answers?)?$/
const choices = (name: string) => within(screen.getByRole('radiogroup', { name })).getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked')])
const start = (name: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Start from' })).getByRole('radio', { name }))
/** An arrow key on the checked choice of "Start from": the next or the previous choice takes its place. */
const arrow = (key: 'ArrowRight' | 'ArrowLeft') => fireEvent.keyDown(within(screen.getByRole('radiogroup', { name: 'Start from' })).getByRole('radio', { checked: true }), { key })
const results = () => within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
const resultQueries = () => results().getAllByRole('row').slice(1).map(row => within(row).getAllByRole('button')[0]!.textContent)
/** The run's facts under the Results heading, in order. */
const facts = () => [...screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }).querySelectorAll('dl > div')].map(item => item.querySelector('dt')!.textContent)
const ready = () => screen.findByRole('option', { name: 'OpenAI' })
/** A run's date as the page prints it, worked out apart from the page. */
const shownDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
/** The runs under Recent runs, each as one line of text. */
const recentRuns = () => screen.getAllByRole('button').filter(button => button.hasAttribute('aria-pressed')).map(button => button.textContent)
/** The Results table's rows as text, cell by cell. A box has no text, so its cell reads empty. */
const resultRows = () => results().getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))
/** Each result's query and what its Tracked cell says. */
const trackedColumn = () => {
  const at = results().getAllByRole('columnheader').findIndex(header => header.textContent === 'Tracked')
  return results().getAllByRole('row').slice(1).map(row => [within(row).getAllByRole('button')[0]!.textContent, within(row).getAllByRole('cell')[at]!.textContent])
}
const box = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name })
/** The bar for the ticked rows of the form in view. A hidden form's bar is hidden with it. */
const bar = () => within(screen.getByRole('region', { name: 'Selected queries' }))
/** A run saved before this visit under a market or a location. */
const savedRun = (id: string, scope: NonNullable<ResearchRunDetailDto['scope']>, queries: string[]): ResearchRunDetailDto => ({
  ...older, id, scope, totalQueries: queries.length, completedQueries: queries.length, createdAt: '2026-10-01T18:00:00.000Z',
  queries: queries.map((query, position) => ({ ...older.queries[0]!, id: `${id}-query-${position}`, position, query, answerText: `Answer to ${query}` })),
})
/** Presses Review in the Track sheet and waits for the server's review. */
async function reviewTracking(title: string) {
  const sheet = within(await screen.findByRole('dialog', { name: title }))
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await sheet.findByRole('heading', { name: /^Review \d+ changes?$/ })
  return sheet
}

test('with no researchMode a writer lands on Write, and each choice of Start from is handed to the host', async () => {
  const state = installApi()
  const onResearchModeChange = vi.fn()
  renderPage({ onResearchModeChange })
  await ready()

  // Two levels only: Tracked | Research, then the page. No row of tabs under it.
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Tracked', 'Research'])
  expect(screen.getAllByRole('tablist')).toHaveLength(1)
  expect(choices('Start from')).toEqual([['Write', 'true'], ['Pattern', 'false'], ['Find ideas', 'false']])
  expect(screen.getByRole('button', { name: RESEARCH_COPY.introHelpWithFind })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  // Write reads saved runs and the plan. It reads no discovery and starts nothing.
  await screen.findByText('Older saved answer')
  expect(state.paths).toContain('/api/v1/projects/demo/research/runs')
  expect(state.paths).toContain('/api/v1/projects/demo/query-tracking')
  expect(state.paths.some(path => path.includes('/discover/'))).toBe(false)

  start('Pattern')
  expect(onResearchModeChange).toHaveBeenLastCalledWith('pattern')
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'true'], ['Find ideas', 'false']])
  expect(screen.getByRole('textbox', { name: 'Pattern' })).toBeTruthy()

  start('Find ideas')
  expect(onResearchModeChange).toHaveBeenLastCalledWith('find')
  // The same control heads Find ideas, so the way back is where the way in was. Focus lands on it, so arrow keys carry on.
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'false'], ['Find ideas', 'true']])
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Find ideas' }))
  expect(screen.getByRole('textbox', { name: FIND_COPY.customer })).toBeTruthy()
  await waitFor(() => expect(state.paths).toContain('/api/v1/projects/demo/discover/sessions'))
  start('Write')
  expect(onResearchModeChange).toHaveBeenLastCalledWith('write')
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Write' }))
  expect(state.posts).toEqual([])
})

test('arrow keys through Start from keep what each form holds: a draft, a preview and the last batch', async () => {
  const state = installApi()
  renderPage()
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'first query\nsecond query' } })

  arrow('ArrowRight')
  // Places are known once the plan has loaded: two markets, one pattern line, and an edit to the first previewed row.
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Old Mill' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Riverside' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'quiet apartments in {market}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Old Mill' }), { target: { value: 'my own wording' } })

  // An arrow key passes through every choice. Find ideas takes the page, and Write and Pattern are out of reach until it gives it back.
  arrow('ArrowRight')
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'false'], ['Find ideas', 'true']])
  expect(screen.queryByRole('textbox', { name: 'Pattern' })).toBeNull()
  expect(screen.queryByRole('region', { name: RESEARCH_COPY.resultsTitle })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: FIND_COPY.customer }), { target: { value: 'Renters moving for work' } })

  arrow('ArrowLeft')
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'true'], ['Find ideas', 'false']])
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Pattern' }))
  expect((screen.getByRole('textbox', { name: 'Pattern' }) as HTMLTextAreaElement).value).toBe('quiet apartments in {market}')
  expect((screen.getByRole('checkbox', { name: 'Old Mill' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('textbox', { name: 'Query 1 for Old Mill' }) as HTMLTextAreaElement).value).toBe('my own wording')
  expect(screen.queryByRole('textbox', { name: FIND_COPY.customer })).toBeNull()
  arrow('ArrowLeft')
  expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe('first query\nsecond query')

  // Find ideas kept its own draft too.
  arrow('ArrowLeft')
  expect((screen.getByRole('textbox', { name: FIND_COPY.customer }) as HTMLTextAreaElement).value).toBe('Renters moving for work')

  // The select over the last batch outlives the trip as well. Leaving Pattern for Write started a new selection, so the places are ticked again.
  arrow('ArrowLeft')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Old Mill' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Riverside' }))
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.refreshPreview }))
  fireEvent.click(screen.getByRole('button', { name: 'Run 2 answers' }))
  const subject = await results().findByRole('combobox', { name: 'Subject' }) as HTMLSelectElement
  arrow('ArrowRight')
  arrow('ArrowLeft')
  expect(results().getByRole('combobox', { name: 'Subject' })).toBe(subject)
  expect([...subject.options].map(option => option.value)).toEqual(['batch-run-0', 'batch-run-1'])
  expect(state.posts.map(post => post.path)).toEqual(['/api/v1/projects/demo/research/batches'])
})

test('a mode change that comes from the host leaves focus where the reader put it', async () => {
  installApi()
  const view = renderPage({ researchMode: 'write', onResearchModeChange: vi.fn() })
  await ready()
  // The places are in, so Pattern has its form to show.
  await screen.findByRole('combobox', { name: 'Subject' })
  // A press on the choice already checked changes nothing, and arms nothing.
  start('Write')
  const editor = screen.getByRole('textbox', { name: 'Queries' })
  editor.focus()
  view.rerender({ researchMode: 'pattern', onResearchModeChange: vi.fn() })
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'true'], ['Find ideas', 'false']])
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Pattern' }))

  // A choice the reader makes lands focus on it once. The host's next change is not that choice again.
  start('Write')
  view.rerender({ researchMode: 'write', onResearchModeChange: vi.fn() })
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Write' }))
  screen.getByRole('textbox', { name: 'Queries' }).focus()
  view.rerender({ researchMode: 'pattern', onResearchModeChange: vi.fn() })
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Pattern' }))
})

test('runs still at work are read again only while their own form is in view', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  onTestFinished(() => { vi.useRealTimers() })
  const state = installApi({ savedRunStatus: 'running', sessions: [testing] })
  const reads = (path: string) => state.paths.filter(item => item === `/api/v1/projects/demo/${path}`).length
  renderPage()
  await screen.findByText('Older saved answer')
  const first = reads('research/runs')
  await vi.advanceTimersByTimeAsync(3100)
  await waitFor(() => expect(reads('research/runs')).toBeGreaterThan(first))

  // Behind Find ideas the saved runs wait, and Find ideas reads its own run that is still testing.
  start('Find ideas')
  await screen.findByRole('button', { name: /^testing-/ })
  const hidden = { runs: reads('research/runs'), sessions: reads('discover/sessions') }
  await vi.advanceTimersByTimeAsync(6200)
  await waitFor(() => expect(reads('discover/sessions')).toBeGreaterThan(hidden.sessions))
  expect(reads('research/runs')).toBe(hidden.runs)

  // Back on Write it is the other way round.
  start('Write')
  const shown = reads('discover/sessions')
  await vi.advanceTimersByTimeAsync(6200)
  await waitFor(() => expect(reads('research/runs')).toBeGreaterThan(hidden.runs))
  expect(reads('discover/sessions')).toBe(shown)
  expect(state.posts).toEqual([])
})

test('a link that names pattern opens Pattern, and one that names find opens Find ideas without reading the plan', async () => {
  const state = installApi()
  const view = renderPage({ researchMode: 'pattern' })
  await ready()
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'true'], ['Find ideas', 'false']])
  // The server's places, by kind. The plan's own lists hold other names, and a group is never offered.
  await waitFor(() => expect(choices('For each')).toEqual([['Market', 'true'], ['Location', 'false'], ['Search location', 'false']]))
  expect(within(screen.getByRole('group', { name: 'Markets' })).getAllByRole('checkbox').map(box => box.closest('label')!.textContent)).toEqual(MARKETS)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Northbridge' }))
  expect(screen.getByText('1 selected')).toBeTruthy()

  // The mode is the host's: moving to Write and back, as Back and Forward do, starts a new selection.
  view.rerender({ researchMode: 'write' })
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  view.rerender({ researchMode: 'pattern' })
  expect(screen.getByText('0 selected')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: 'Northbridge' }) as HTMLInputElement).checked).toBe(false)

  cleanup()
  state.paths.length = 0
  // Known to be Advanced or not: with no run there is no result to track, so nothing of the plan is read.
  renderPage({ researchMode: 'find', trackedMode: 'advanced' })
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'false'], ['Find ideas', 'true']])
  await screen.findByText(FIND_COPY.noRuns)
  expect(state.paths).toEqual(['/api/v1/projects/demo/discover/sessions'])
})

test('a server that sends no list of places offers a pattern across search locations only', async () => {
  installApi({ scopeOptions: false })
  renderPage({ researchMode: 'pattern' })
  await ready()
  await screen.findByRole('checkbox', { name: downtown.label })
  // One kind of place is no choice: it is named in plain text, with no control to press.
  expect(screen.queryByRole('radiogroup', { name: 'For each' })).toBeNull()
  expect(screen.getByText('For each').parentElement!.textContent).toBe('For eachSearch location')
  expect(screen.queryByRole('checkbox', { name: 'Plan market' })).toBeNull()
})

test('a project with no search location says so in Pattern, with nothing to search and Run off', async () => {
  const state = installApi({ scopeOptions: false, searchLocations: false })
  renderPage({ researchMode: 'pattern' })
  await ready()
  const note = await screen.findByRole('button', { name: `${RESEARCH_COPY.noSearchLocations}. ${RESEARCH_COPY.noSearchLocationsDetail}` })
  expect(note.textContent).toBe('No search locations')
  expect(screen.getByText('For each').parentElement!.textContent).toBe('For eachSearch location')
  expect(screen.queryByRole('searchbox', { name: 'Search' })).toBeNull()
  // No place to tick in the form. The results under it have boxes of their own.
  expect(within(screen.getByText('For each').closest('.surface-card') as HTMLElement).queryByRole('checkbox')).toBeNull()
  // A pattern can still be written. With no place to repeat for there is nothing to preview or run.
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'best apartments in {location}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  const run = screen.getByRole('button', { name: RUN }) as HTMLButtonElement
  expect([run.textContent, run.disabled]).toEqual(['Run', true])
  expect(state.posts).toEqual([])
})

test('a pattern across five markets saves five runs, and the Subject select over the results swaps between them', async () => {
  const state = installApi()
  renderPage({ researchMode: 'pattern' })
  await ready()
  for (const market of MARKETS) fireEvent.click(await screen.findByRole('checkbox', { name: market }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'apartments with a dog park in {market}\nquiet apartments in {market}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  // Two lines for five markets: ten answers from the one engine.
  const run = screen.getByRole('button', { name: RUN }) as HTMLButtonElement
  expect(run.textContent).toBe('Run 10 answers')
  fireEvent.click(run)
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]).toEqual({ path: '/api/v1/projects/demo/research/batches', body: {
    idempotencyKey: expect.any(String),
    runs: MARKETS.map(market => ({
      queries: [`apartments with a dog park in ${market}`, `quiet apartments in ${market}`], provider: 'openai', model: 'model-a', location: null,
      scope: { kind: 'market', key: slug(market), expectedPlanRevision: 7 },
    })),
  } })

  // One choice per run, named by its Subject and the status past research now reports for it. The first run's results show.
  const subject = await results().findByRole('combobox', { name: 'Subject' }) as HTMLSelectElement
  await waitFor(() => expect([...subject.options].map(option => option.text)).toEqual(['Harbor Point · Completed', 'Northbridge · Partial', 'Old Mill · Completed', 'Riverside · Completed', 'Lakeshore · Completed']))
  expect(subject.value).toBe('batch-run-0')
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Harbor Point', 'quiet apartments in Harbor Point']))
  // The form cleared, which dropped focus: it is on the select, and the save is said once for a screen reader.
  expect(document.activeElement).toBe(subject)
  expect(screen.getAllByRole('status').map(status => status.textContent)).toContain('5 runs saved')
  // The select names the Subject, so the run's own facts do not repeat it.
  expect(facts()).toEqual(['Run', 'Engine', 'Model', 'Search location'])
  expect(screen.queryByText('Saved runs')).toBeNull()

  fireEvent.change(subject, { target: { value: 'batch-run-3' } })
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Riverside', 'quiet apartments in Riverside']))
  expect(results().getByText('Answer to apartments with a dog park in Riverside')).toBeTruthy()
  // The run's status beside the heading is that run's own.
  fireEvent.change(subject, { target: { value: 'batch-run-1' } })
  await waitFor(() => expect(results().getByRole('heading').parentElement!.textContent).toBe('ResultsPartial'))

  // Past research comes after the results it changes. A run picked there shows above, and focus goes to the Results heading.
  const history = screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).closest('details')!
  expect(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }).compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(within(history).getAllByRole('button').at(-1)!)
  expect(document.activeElement).toBe(results().getByRole('heading'))
  await waitFor(() => expect(resultQueries()).toEqual(['Older saved query']))
  // That run is not one of the batch's. The select stays as the way back, with no run chosen, and the run's facts name its own Subject.
  const lastBatch = results().getByRole('combobox', { name: RESEARCH_COPY.lastBatch }) as HTMLSelectElement
  expect([lastBatch.value, lastBatch.options[0]!.text, lastBatch.options.length]).toEqual(['', 'Pick a run', 6])
  expect(facts()).toEqual(['Run', 'Engine', 'Model', 'Search location', 'Subject'])
  fireEvent.change(lastBatch, { target: { value: 'batch-run-2' } })
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Old Mill', 'quiet apartments in Old Mill']))
  expect((results().getByRole('combobox', { name: 'Subject' }) as HTMLSelectElement).value).toBe('batch-run-2')
  // The form cleared and stayed on Pattern, for the same kind of place.
  expect(choices('For each')).toEqual([['Market', 'true'], ['Location', 'false'], ['Search location', 'false']])
  expect(screen.getByRole('button', { name: RUN }).textContent).toBe('Run')
})

test('a run clears the form and keeps what the pattern repeats for', async () => {
  const state = installApi()
  renderPage({ researchMode: 'pattern' })
  await ready()
  fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'For each' })).getByRole('radio', { name: 'Location' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Homes Lofts' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'Is {property} pet friendly?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 answer' }))
  await waitFor(() => expect(state.posts).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Pattern' }) as HTMLTextAreaElement).value).toBe(''))
  expect(choices('For each')).toEqual([['Market', 'false'], ['Location', 'true'], ['Search location', 'false']])
  expect((screen.getByRole('checkbox', { name: 'Acme Homes Lofts' }) as HTMLInputElement).checked).toBe(false)
  // One run has no select to land on: focus is on the Results heading.
  expect(document.activeElement).toBe(results().getByRole('heading'))
  expect(screen.getAllByRole('status').map(status => status.textContent)).toContain('1 run saved')
})

test('Pattern names no kind of place until the places have loaded, and a first tick keeps its kind through a late list', async () => {
  installApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const places = scopeOptions as NonNullable<React.ComponentProps<typeof ResearchQueriesSection>['scopeOptions']>
  const section = (props: Partial<React.ComponentProps<typeof ResearchQueriesSection>>) => <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" start="pattern" planRevision={7} scopeOptions={[]} {...props} /></QueryClientProvider>
  const view = render(section({ scopePending: true }))
  await ready()
  // Which kinds of place the project has is not known yet. Nothing that depends on one can be touched, so nothing has to move when they land.
  expect(screen.getByRole('status', { name: 'Loading places' })).toBeTruthy()
  expect(screen.queryByRole('radiogroup', { name: 'For each' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Pattern' })).toBeNull()
  expect(screen.queryByRole('button', { name: /name$|^Preview queries$/ })).toBeNull()
  view.rerender(section({ scopeOptions: places }))
  expect(screen.queryByRole('status', { name: 'Loading places' })).toBeNull()
  expect(choices('For each')).toEqual([['Market', 'true'], ['Location', 'false'], ['Search location', 'false']])
  expect(screen.getByRole('textbox', { name: 'Pattern' })).toBeTruthy()

  // A places read that failed leaves search locations only. A tick there holds through the list its Retry brings.
  cleanup()
  const again = render(section({ scopeError: true }))
  fireEvent.click(await screen.findByRole('checkbox', { name: downtown.label }))
  again.rerender(section({ scopeOptions: places }))
  expect(choices('For each')).toEqual([['Market', 'false'], ['Location', 'false'], ['Search location', 'true']])
  expect((screen.getByRole('checkbox', { name: downtown.label }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText('1 selected')).toBeTruthy()
})

test('with no engine key the page renders, a pattern still previews, and Run stays off', async () => {
  const state = installApi({ engine: false })
  renderPage({ researchMode: 'pattern' })
  const note = await screen.findByRole('button', { name: `${RESEARCH_COPY.noEngineKey}. ${RESEARCH_COPY.noEngineKeyDetail}` })
  expect(note.textContent).toBe('No engine key')
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Old Mill' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'best apartments in {market}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  expect((screen.getByRole('textbox', { name: 'Query 1 for Old Mill' }) as HTMLTextAreaElement).value).toBe('best apartments in Old Mill')
  const run = screen.getByRole('button', { name: 'Run 1 answer' }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  // Stored results still show: the legend names the company and the project's domain, without its scheme or www.
  await screen.findByText('Older saved answer')
  expect(results().getAllByRole('listitem').slice(0, 2).map(item => item.textContent)).toEqual(['N Names Acme Homes', 'C Cites demo.example'])
  // The run's date, as its row in Past research shows it.
  expect(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }).querySelector('dl > div')!.textContent).toBe(`Run${shownDate(older.createdAt)}`)
  expect(state.posts).toEqual([])
})

test('a viewer reads a saved answer with no Review for tracking button', async () => {
  window.__CANONRY_CONFIG__ = { research: { allowViewers: true, viewerDailyRunLimit: 7 } }
  const state = installApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
    <QueryClientProvider client={queryClient}><QueriesSection projectName="demo" queryWorkspace="research" researchMode="find" /></QueryClientProvider>
  </AccountProvider>)
  // The answer panel is drawn, so a button would have a place to show.
  await screen.findByText('Older saved answer')
  expect(results().getByText('Selected query').nextElementSibling!.textContent).toBe('Older saved query')
  // A viewer starts from Write or Pattern, whatever the link names.
  expect(choices('Start from')).toEqual([['Write', 'true'], ['Pattern', 'false']])
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()
  // A viewer reads which queries are tracked and ticks none: no box, and so no bar.
  expect(results().getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Type', 'Status', 'Tracked', 'OpenAI'])
  expect(resultRows().map(cells => cells.slice(0, 4))).toEqual([['Older saved queryNon-brand', 'Non-brand', 'Completed', 'No']])
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
  expect(state.paths.some(path => path.includes('/discover/') || path.endsWith('/settings'))).toBe(false)
})

/** The text a reader can meet, one run of text per line. */
function shownText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const text: string[] = []
  while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) text.push(walker.currentNode.textContent.trim())
  return text
}

test('Find ideas is short labels with the sentences behind them, and a finished run lists its cited sites and results', async () => {
  const state = installApi({ sessions: [session, testing] })
  renderPage({ researchMode: 'find' })
  await screen.findByText('Lofts near transit')

  // Each field is a label with its sentence in the help beside it. The framing stays: a candidate is a question a customer might ask.
  const customer = screen.getByRole('textbox', { name: FIND_COPY.customer }) as HTMLTextAreaElement
  expect(customer.placeholder).toBe('Saved profile if blank')
  expect(screen.getByRole('button', { name: FIND_COPY.customerHelp }).getAttribute('aria-label')).toContain('questions your customers might ask')
  expect(screen.getByRole('textbox', { name: FIND_COPY.count })).toHaveProperty('value', '100')
  expect(screen.getByRole('button', { name: FIND_COPY.countHelp })).toBeTruthy()
  expect(screen.getByText('Runs on Gemini')).toBeTruthy()
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Queries', 'Recent runs', 'Run session-', 'Results'])
  // The action is named for what it starts, apart from the choice of "Start from" above it.
  expect(screen.getByRole('button', { name: FIND_COPY.runAction }).textContent).toBe('Start run')
  // Each run under Recent runs: its status in the page's words, then the server's three numbers.
  expect(recentRuns()).toEqual(['session-CompletedCited queries2Worth tracking4Skip3', 'testing-TestingCited queries0Worth tracking0Skip0'])

  // The run's numbers are the server's own fields, each under its label.
  const tiles = Object.fromEntries([...document.querySelectorAll('dl > div')].map(tile => [tile.querySelector('dt')!.textContent, tile.querySelector('dd')!.textContent]))
  expect(tiles).toEqual({ 'Questions tested': '9', 'Cited queries': '2', 'Worth tracking': '4', Skip: '3' })
  expect(screen.getByText('Cited sites', { selector: 'p' }).nextElementSibling!.textContent).toBe('rentals.example 5')
  // Every result the server returned is listed, and the number beside the heading is the length of that list, not the run's own count.
  expect(screen.getByRole('heading', { name: FIND_COPY.resultsTitle }).nextElementSibling!.textContent).toBe('3')
  const table = within(screen.getByRole('table'))
  expect(table.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Question', 'Result', 'Cited sites', 'Tracking review'])
  expect(table.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))).toEqual([
    ['Lofts near transit', 'Cited queries', 'demo.example', 'Review for tracking'],
    ['Cheapest storage units', 'Skip', '-', ''],
    ['Storage near the harbor', 'No result', '-', ''],
  ])
  // What a review does is the help beside the heading, with no Step card and no paragraph.
  expect(screen.getByRole('button', { name: FIND_COPY.resultsHelp })).toBeTruthy()
  // Nothing on the page is a sentence: every run of text is a label of four words or fewer.
  expect(shownText().filter(text => text.split(/\s+/).length > 4)).toEqual([])
  expect(shownText().join('\n')).not.toMatch(/Step \d|Generate and check|Describe your customer|scope|\u2014/)

  // A run still at work has no result to review, so its Results card has no help for one.
  fireEvent.click(screen.getByRole('button', { name: /^testing-/ }))
  expect((await screen.findByText(FIND_COPY.noResults)).textContent).toBe('No results yet')
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Queries', 'Recent runs', 'Run testing-', 'Results'])
  expect(screen.queryByRole('button', { name: FIND_COPY.resultsHelp })).toBeNull()

  // A run starts only when pressed, with the number of questions asked for. Its toast is in the page's words.
  expect(state.posts).toEqual([])
  fireEvent.change(customer, { target: { value: 'Renters moving for work' } })
  fireEvent.click(screen.getByRole('button', { name: FIND_COPY.runAction }))
  await waitFor(() => expect(state.posts).toEqual([{ path: '/api/v1/projects/demo/discover/run', body: { icpDescription: 'Renters moving for work', maxProbes: 100 } }]))
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Find ideas started', 'Run session- · Testing']]))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toContainEqual(['Recent runs refreshed', '2 runs']))
  state.failSessions = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  // A refresh that fails takes the place of the one that worked, and the runs already listed stay.
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Find ideas started', 'Run session- · Testing'], ['Could not refresh', FIND_COPY.runsError]]))
  expect(recentRuns()).toHaveLength(2)
})

test('Find ideas with no runs says so, and a failed read offers Retry', async () => {
  const state = installApi({ failSessions: true })
  renderPage({ researchMode: 'find' })
  // Until the read lands the list is a skeleton, not an empty list.
  expect(screen.getByRole('status', { name: FIND_COPY.runsLoading })).toBeTruthy()
  expect(screen.queryByText(FIND_COPY.noRuns)).toBeNull()
  const failed = await screen.findByRole('button', { name: `${FIND_COPY.loadError}. ${FIND_COPY.runsError}` })
  expect(failed.textContent).toBe('Could not load')
  // A list that did not load is not an empty one, and its one action is Retry. No second card says anything about a run.
  expect(screen.queryByText(FIND_COPY.noRuns)).toBeNull()
  expect(screen.queryByText(FIND_COPY.noRun)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  state.failSessions = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry recent runs' }))
  expect((await screen.findByText(FIND_COPY.noRuns)).textContent).toBe('No runs yet')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status', { name: FIND_COPY.runsLoading })).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  // With no run there is nothing to select and nothing to show results for: one empty state, not two.
  expect(screen.queryByText(FIND_COPY.noRun)).toBeNull()
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Queries', 'Recent runs'])
  expect(state.posts).toEqual([])
})

test('a Find ideas run whose results are loading says so, and one whose results did not load offers Retry', async () => {
  const state = installApi({ sessions: [session], failResults: true })
  let release = () => {}
  state.holdResults = new Promise<void>(resolve => { release = resolve })
  onTestFinished(() => release())
  renderPage({ researchMode: 'find' })
  // The run is finished and its results are on their way: a skeleton, never "No results yet".
  const loading = await screen.findByRole('status', { name: FIND_COPY.resultsLoading })
  expect(loading.textContent).toBe('')
  expect(screen.queryByText(FIND_COPY.noResults)).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()

  release()
  state.holdResults = null
  const failed = await screen.findByRole('button', { name: `${FIND_COPY.loadError}. ${FIND_COPY.resultsError}` })
  expect(failed.textContent).toBe('Could not load')
  expect(failed.closest('[role="alert"]')!.textContent).toBe('Could not loadRetry')
  expect(screen.queryByRole('status', { name: FIND_COPY.resultsLoading })).toBeNull()
  // The run's own numbers came with the list, so they stay.
  expect(screen.getByText('Questions tested').nextElementSibling!.textContent).toBe('9')
  state.failResults = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry results' }))
  await screen.findByText('Lofts near transit')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(state.posts).toEqual([])
})

test('rows ticked in two runs of one batch go in one review, each for its own market, and read Tracked once published', async () => {
  const state = installApi({ plan: true })
  // One of the queries the pattern makes is tracked already, for another market than the run it comes back in.
  state.tracked.push({ queryId: 'tracked-quiet', queryText: ' Quiet Apartments in  Harbor Point', focus: { kind: 'market', key: 'riverside' } })
  renderPage({ researchMode: 'pattern', publishGuard: { sweepActive: false }, nextSweepDate: 'Oct 21' })
  await ready()
  for (const market of ['Harbor Point', 'Northbridge']) fireEvent.click(await screen.findByRole('checkbox', { name: market }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'apartments with a dog park in {market}\nquiet apartments in {market}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run 4 answers' }))
  const subject = await results().findByRole('combobox', { name: 'Subject' }) as HTMLSelectElement
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Harbor Point', 'quiet apartments in Harbor Point']))

  // A Tracked column says what each query is tracked for. A tracked query, matched whatever its case and spacing, has no box.
  expect(results().getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', 'Query', 'Type', 'Status', 'Tracked', 'OpenAI'])
  expect(trackedColumn()).toEqual([['apartments with a dog park in Harbor Point', 'No'], ['quiet apartments in Harbor Point', 'Market · Riverside (1)']])
  expect(screen.queryByRole('checkbox', { name: 'Select quiet apartments in Harbor Point' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()

  fireEvent.click(box('Select apartments with a dog park in Harbor Point'))
  expect(bar().getByRole('status').textContent).toBe('1 selected')
  // The bar follows the whole page, so the table holds the way to it by keyboard.
  fireEvent.click(results().getByRole('link', { name: 'Selected actions' }))
  expect(document.activeElement).toBe(bar().getByRole('button', { name: 'Track 1' }))
  // Every row of the run that can be ticked is ticked, so the header box is too.
  expect(box('Select all rows').checked).toBe(true)

  // The second run of the batch: its rows are ticked together, and the first run's row stays ticked behind it.
  fireEvent.change(subject, { target: { value: 'batch-run-1' } })
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Northbridge', 'quiet apartments in Northbridge']))
  expect(box('Select all rows').checked).toBe(false)
  fireEvent.click(box('Select all rows'))
  expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 3', 'Clear'])
  fireEvent.change(subject, { target: { value: 'batch-run-0' } })
  await waitFor(() => expect(box('Select apartments with a dog park in Harbor Point').checked).toBe(true))

  const postsBefore = state.posts.length
  fireEvent.click(bar().getByRole('button', { name: 'Track 3' }))
  const sheet = await reviewTracking('Track 3 queries')
  const additions = [
    { input: { source: 'research', researchRunQueryId: 'batch-run-0-query-0' }, audience: { marketKeys: ['harbor-point'] } },
    { input: { source: 'research', researchRunQueryId: 'batch-run-1-query-0' }, audience: { marketKeys: ['northbridge'] } },
    { input: { source: 'research', researchRunQueryId: 'batch-run-1-query-1' }, audience: { marketKeys: ['northbridge'] } },
  ]
  expect(state.posts.slice(postsBefore)).toEqual([{ path: '/api/v1/projects/demo/query-tracking/preview', body: { expectedWorkspaceVersion: workspaceVersion, additions, removals: [] } }])
  // The review is the shared one: the host's next sweep date reaches it.
  expect(sheet.getByText('First answers Oct 21')).toBeTruthy()

  fireEvent.click(sheet.getByRole('button', { name: 'Publish 3 changes' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(state.posts.slice(postsBefore + 1)).toEqual([{ path: '/api/v1/projects/demo/query-tracking/commit', body: { expectedWorkspaceVersion: reviewedVersion, additions, removals: [], previewToken, reviewedAt } }])
  // The tracked queries are read again, so the rows say Tracked with no reload: no box, and no bar left.
  await waitFor(() => expect(trackedColumn().map(row => row[1])).toEqual(['Market · Harbor Point (1)', 'Market · Riverside (1)']))
  expect(screen.queryByRole('checkbox', { name: /^Select apartments/ })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
  // The bar that opened the sheet is gone, and this run has no box left to take the focus: the Results heading does.
  await waitFor(() => expect(document.activeElement).toBe(results().getByRole('heading')))
  // Tracking sent a review and a publish, and started nothing else.
  expect(state.posts.map(post => post.path)).toEqual(['/api/v1/projects/demo/research/batches', '/api/v1/projects/demo/query-tracking/preview', '/api/v1/projects/demo/query-tracking/commit'])
})

test('a run saved under a location tracks for it and its markets, and one saved under no Subject asks for one', async () => {
  const state = installApi({ plan: true, saved: [savedRun('lofts-run', { kind: 'property', key: 'lofts', label: 'Acme Homes Lofts', planRevision: 7 }, ['Is Acme Homes Lofts pet friendly?'])] })
  // In the tracked list and asked nowhere: it is tracked, with no Subject to name.
  state.tracked.push({ queryId: 'tracked-idle', queryText: 'Older saved query', focus: { kind: 'not-asked' } })
  renderPage()
  await ready()
  await waitFor(() => expect(trackedColumn()).toEqual([['Is Acme Homes Lofts pet friendly?', 'No']]))
  fireEvent.click(box('Select Is Acme Homes Lofts pet friendly?'))

  // The older run has no Subject. Its one query is tracked already, so it has nothing to tick.
  const history = screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).closest('details')!
  fireEvent.click(within(history).getAllByRole('button').at(-1)!)
  await waitFor(() => expect(trackedColumn()).toEqual([['Older saved query', 'Not asked']]))
  // Where the Tracked column has no room, the same words sit under the query.
  expect(results().getByText('Tracked · Not asked')).toBeTruthy()
  expect(box('Select all rows').disabled).toBe(true)
  expect(bar().getByRole('status').textContent).toBe('1 selected')

  fireEvent.click(bar().getByRole('button', { name: 'Track 1' }))
  const sheet = within(await screen.findByRole('dialog', { name: 'Track 1 query' }))
  // The run's own Subject, read-only: a location is tracked for itself and counts in the market that holds it.
  expect(sheet.queryByRole('radiogroup', { name: 'Subject' })).toBeNull()
  expect(sheet.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))).toEqual([['Is Acme Homes Lofts pet friendly?', 'Location · Acme Homes Lofts']])
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await sheet.findByRole('heading', { name: 'Review 1 change' })
  expect(state.posts).toEqual([{ path: '/api/v1/projects/demo/query-tracking/preview', body: {
    expectedWorkspaceVersion: workspaceVersion, removals: [],
    additions: [{ input: { source: 'research', researchRunQueryId: 'lofts-run-query-0' }, audience: { targetKeys: ['lofts'], marketKeys: ['harbor-point'] } }],
  } }])
})

test('Find ideas pages its results by 50 and tracks the ticked ones as Find ideas results, for the Subject chosen', async () => {
  const BUCKETS = ['cited', 'aspirational', 'wasted-surface', null] as const
  const many = Array.from({ length: 120 }, (_, index) => ({ ...probes[0]!, id: `probe-${index + 1}`, query: `Idea ${index + 1}`, bucket: BUCKETS[index % 4]! }))
  const state = installApi({ plan: true, sessions: [session], probes: many })
  state.tracked.push({ queryId: 'tracked-idea', queryText: 'idea 2', focus: { kind: 'property', key: 'lofts' } })
  renderPage({ researchMode: 'find', trackedMode: 'advanced' })
  const table = within(await screen.findByRole('table'))
  const rows = () => table.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))
  // The tracked queries are read now that a run lists results. Until they land no row can be ticked.
  await waitFor(() => expect(rows()[0]).toEqual(['', 'Idea 1', 'Cited queries', 'demo.example', 'No']))
  expect(state.paths).toContain('/api/v1/projects/demo/query-tracking')
  expect(table.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', 'Question', 'Result', 'Cited sites', 'Tracked'])

  // Every result is listed, 50 to a page, and the number beside the heading is the length of the server's list.
  expect(rows()).toHaveLength(50)
  expect(screen.getByRole('heading', { name: FIND_COPY.resultsTitle }).nextElementSibling!.textContent).toBe('120')
  expect(screen.getByText(/of 120 results$/).textContent).toBe('1 to 50 of 120 results')
  expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  // A tracked result names its Subject and has no box. Neither has one to skip, nor one with no result. No row offers the Add query form.
  expect(rows().slice(1, 4)).toEqual([
    ['', 'Idea 2', 'Worth tracking', 'demo.example', 'Location · Acme Homes Lofts'],
    ['', 'Idea 3', 'Skip', 'demo.example', 'No'],
    ['', 'Idea 4', 'No result', 'demo.example', 'No'],
  ])
  for (const name of ['Select Idea 2', 'Select Idea 3', 'Select Idea 4']) expect(screen.queryByRole('checkbox', { name })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()
  expect(screen.getByRole('button', { name: FIND_COPY.trackHelp })).toBeTruthy()

  fireEvent.click(box('Select Idea 1'))
  fireEvent.click(box('Select Idea 5'))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(rows().map(cells => cells[1])).toEqual(Array.from({ length: 50 }, (_, index) => `Idea ${index + 51}`))
  expect(screen.getByText(/of 120 results$/).textContent).toBe('51 to 100 of 120 results')
  // The ticks belong to the run, so another page keeps them. Its own rows start unticked.
  expect(bar().getByRole('status').textContent).toBe('2 selected')
  expect(box('Select this page').checked).toBe(false)
  fireEvent.click(box('Select Idea 53'))
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
  expect(box('Select Idea 5').checked).toBe(true)
  expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 3', 'Clear'])

  // A Find ideas result has no Subject of its own: the sheet asks, and Review waits.
  fireEvent.click(bar().getByRole('button', { name: 'Track 3' }))
  const sheet = within(await screen.findByRole('dialog', { name: 'Track 3 queries' }))
  expect(sheet.getByRole<HTMLButtonElement>('button', { name: 'Review' }).disabled).toBe(true)
  fireEvent.click(sheet.getByText('Choose a market').closest('summary')!)
  fireEvent.click(sheet.getByRole('button', { name: 'Select Old Mill' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await sheet.findByRole('heading', { name: 'Review 3 changes' })
  const additions = ['probe-1', 'probe-5', 'probe-53'].map(discoveryProbeId => ({ input: { source: 'discovery', discoveryProbeId }, audience: { marketKeys: ['old-mill'] } }))
  expect(state.posts).toEqual([{ path: '/api/v1/projects/demo/query-tracking/preview', body: { expectedWorkspaceVersion: workspaceVersion, additions, removals: [] } }])

  fireEvent.click(sheet.getByRole('button', { name: 'Publish 3 changes' }))
  await waitFor(() => expect(rows()[0]).toEqual(['', 'Idea 1', 'Cited queries', 'demo.example', 'Market · Old Mill (1)']))
  expect(screen.queryByRole('checkbox', { name: 'Select Idea 1' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
  // A review and a publish. No run was started, here or on Write.
  expect(state.posts.map(post => post.path)).toEqual(['/api/v1/projects/demo/query-tracking/preview', '/api/v1/projects/demo/query-tracking/commit'])
})

test('Find ideas says when the tracked queries did not load, and ticks nothing until a Retry reads them', async () => {
  const state = installApi({ plan: true, sessions: [session] })
  state.failWorkspace = true
  renderPage({ researchMode: 'find', trackedMode: 'advanced' })
  const failed = await screen.findByRole('button', { name: `${FIND_COPY.loadError}. ${RESEARCH_COPY.trackedError}` })
  expect(failed.closest('[role="alert"]')!.textContent).toBe('Could not loadRetry')
  // The results still list. With nothing to say what is tracked, no row has a box that can be ticked, and none goes to the Add query form.
  expect(screen.getByRole('cell', { name: 'Lofts near transit' })).toBeTruthy()
  expect(box('Select Lofts near transit').disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()

  state.failWorkspace = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry tracked queries' }))
  await waitFor(() => expect(box('Select Lofts near transit').disabled).toBe(false))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(state.posts).toEqual([])
})

test('a results table whose tracked queries did not load says so, marks no row a No, and ticks nothing until a Retry', async () => {
  const state = installApi({ plan: true })
  state.failWorkspace = true
  renderPage({ trackedMode: 'advanced' })
  await screen.findByText('Older saved answer')
  const failed = await results().findByRole('button', { name: `${RESEARCH_COPY.loadError}. ${RESEARCH_COPY.trackedError}` })
  expect(failed.closest('[role="alert"]')!.textContent).toBe('Could not loadRetry')
  // Not a No: nothing says whether the query is tracked.
  expect(trackedColumn()).toEqual([['Older saved query', 'Not checked']])
  expect(box('Select Older saved query').disabled).toBe(true)
  expect(box('Select all rows').disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()

  state.failWorkspace = false
  fireEvent.click(results().getByRole('button', { name: 'Retry tracked queries' }))
  await waitFor(() => expect(trackedColumn()).toEqual([['Older saved query', 'No']]))
  expect(box('Select Older saved query').disabled).toBe(false)
  expect(results().queryByRole('alert')).toBeNull()
  expect(state.posts).toEqual([])
})
