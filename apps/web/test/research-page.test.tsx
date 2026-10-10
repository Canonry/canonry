import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResearchBatchCreate, ResearchRunDetailDto } from '@ainyc/canonry-contracts'

import { QueriesSection, type QueriesSectionProps } from '../src/components/project/DiscoverySection.js'
import { RESEARCH_COPY, ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { FIND_COPY } from '../src/components/project/queries/FindQueriesSection.js'
import { resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

// Research as one page under Tracked | Research: where it opens, what "Start from" offers, the places a pattern repeats for, the select over a batch's results, and Find ideas.

afterEach(() => { cleanup(); resetToasts() })

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

type Options = { engine?: boolean; scopeOptions?: boolean; sessions?: unknown[]; failSessions?: boolean }

function installApi(options: Options = {}) {
  const state = { paths: [] as string[], posts: [] as Array<{ path: string; body: unknown }>, runs: [] as ResearchRunDetailDto[], failSessions: options.failSessions ?? false }
  const catalog = [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'model-a', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }]
  const restore = mockFetch((url, init) => {
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
    if (method !== 'GET') throw new Error(`Unexpected ${method}: ${path}`)
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [...state.runs, older].map(({ queries: _queries, ...run }) => run), nextCursor: null })
    if (path.startsWith('/api/v1/projects/demo/research/runs/')) return jsonResponse([...state.runs, older].find(run => path.endsWith(`/${run.id}`)))
    if (path === '/api/v1/projects/demo/query-tracking') return jsonResponse({
      mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, active: { revision: 7, compiledChecksum: 'c'.repeat(64) }, defaultContexts: [],
      targets: [{ stableKey: 'plan-target', label: 'Plan target' }], groups: [], markets: [{ stableKey: 'plan-market', label: 'Plan market', usageEdges: [] }],
      ...(options.scopeOptions === false ? {} : { scopeOptions }), tracked: [], savedSources: { research: [], discovery: [] },
    })
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    if (path === '/api/v1/projects/demo/discover/sessions') return state.failSessions ? jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503) : jsonResponse(options.sessions ?? [])
    if (path === `/api/v1/projects/demo/discover/sessions/${session.id}`) return jsonResponse({ ...session, probes: [
      { id: 'probe-cited', sessionId: session.id, projectId: session.projectId, query: 'Lofts near transit', bucket: 'cited', citationState: 'cited', citedDomains: ['demo.example'], answerMentioned: true, createdAt: session.createdAt },
      { id: 'probe-skip', sessionId: session.id, projectId: session.projectId, query: 'Cheapest storage units', bucket: 'wasted-surface', citationState: 'not-cited', citedDomains: [], answerMentioned: false, createdAt: session.createdAt },
    ] })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', displayName: 'Acme Homes', canonicalDomain: 'https://www.demo.example/', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {}, locations: [downtown], defaultLocation: null,
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
const results = () => within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
const resultQueries = () => results().getAllByRole('row').slice(1).map(row => within(row).getAllByRole('button')[0]!.textContent)
const ready = () => screen.findByRole('option', { name: 'OpenAI' })

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
  renderPage({ researchMode: 'find' })
  expect(choices('Start from')).toEqual([['Write', 'false'], ['Pattern', 'false'], ['Find ideas', 'true']])
  await screen.findByText(FIND_COPY.noRuns)
  expect(state.paths).toEqual(['/api/v1/projects/demo/discover/sessions'])
})

test('a server that sends no list of places offers a pattern across search locations only', async () => {
  installApi({ scopeOptions: false })
  renderPage({ researchMode: 'pattern' })
  await ready()
  await screen.findByRole('checkbox', { name: downtown.label })
  expect(choices('For each')).toEqual([['Search location', 'true']])
  expect(screen.queryByRole('checkbox', { name: 'Plan market' })).toBeNull()
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
  // The select names the Subject, so the run's own facts do not repeat it.
  const facts = () => [...document.querySelectorAll('[role="region"] dl > div')].map(item => item.querySelector('dt')!.textContent)
  expect(facts()).toEqual(['Run', 'Engine', 'Model', 'Search location'])
  expect(screen.queryByText('Saved runs')).toBeNull()

  fireEvent.change(subject, { target: { value: 'batch-run-3' } })
  await waitFor(() => expect(resultQueries()).toEqual(['apartments with a dog park in Riverside', 'quiet apartments in Riverside']))
  expect(results().getByText('Answer to apartments with a dog park in Riverside')).toBeTruthy()
  // The run's status beside the heading is that run's own.
  fireEvent.change(subject, { target: { value: 'batch-run-1' } })
  await waitFor(() => expect(results().getByRole('heading').parentElement!.textContent).toBe('ResultsPartial'))

  // A run from before the batch is not one of its choices: picked from Past research, it shows with no select over it.
  fireEvent.click(within(screen.getByRole('heading', { name: RESEARCH_COPY.historyTitle }).closest('details')!).getAllByRole('button').at(-1)!)
  await waitFor(() => expect(resultQueries()).toEqual(['Older saved query']))
  expect(results().queryByRole('combobox')).toBeNull()
  expect(facts()).toEqual(['Run', 'Engine', 'Model', 'Search location', 'Subject'])
  // The form cleared and stayed on Pattern, for the same kind of place.
  expect(choices('For each')).toEqual([['Market', 'true'], ['Location', 'false'], ['Search location', 'false']])
  expect(screen.getByRole('button', { name: RUN }).textContent).toBe('Run')
})

test('a run clears the form and keeps what the pattern repeats for', async () => {
  const state = installApi()
  renderPage({ researchMode: 'pattern' })
  await ready()
  fireEvent.click(await within(screen.getByRole('radiogroup', { name: 'For each' })).findByRole('radio', { name: 'Location' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme Homes Lofts' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value: 'Is {property} pet friendly?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run 1 answer' }))
  await waitFor(() => expect(state.posts).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Pattern' }) as HTMLTextAreaElement).value).toBe(''))
  expect(choices('For each')).toEqual([['Market', 'false'], ['Location', 'true'], ['Search location', 'false']])
  expect((screen.getByRole('checkbox', { name: 'Acme Homes Lofts' }) as HTMLInputElement).checked).toBe(false)
})

test('places that load after a first tick do not move the pattern to another kind of place', async () => {
  installApi()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const places = scopeOptions as NonNullable<React.ComponentProps<typeof ResearchQueriesSection>['scopeOptions']>
  const section = (loaded: boolean) => <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" start="pattern" planRevision={7} scopeOptions={loaded ? places : []} scopePending={!loaded} /></QueryClientProvider>
  const view = render(section(false))
  await ready()
  // Until the plan's places load there are search locations only. Untouched, the pattern moves to the first kind once they do.
  expect(choices('For each')).toEqual([['Search location', 'true']])
  view.rerender(section(true))
  expect(choices('For each')).toEqual([['Market', 'true'], ['Location', 'false'], ['Search location', 'false']])

  cleanup()
  const again = render(section(false))
  fireEvent.click(await screen.findByRole('checkbox', { name: downtown.label }))
  again.rerender(section(true))
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
  expect(state.posts).toEqual([])
})

/** The text a reader can meet, one run of text per line. */
function shownText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const text: string[] = []
  while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) text.push(walker.currentNode.textContent.trim())
  return text
}

test('Find ideas is short labels with the sentences behind them, and a finished run lists its cited sites and results', async () => {
  const state = installApi({ sessions: [session] })
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

  // The run's numbers are the server's own fields, each under its label.
  const tiles = Object.fromEntries([...document.querySelectorAll('.grid.sm\\:grid-cols-4 > div')].map(tile => [tile.children[0]!.textContent, tile.children[1]!.textContent]))
  expect(tiles).toEqual({ 'Questions tested': '9', 'Cited queries': '2', 'Worth tracking': '4', Skip: '3' })
  expect(screen.getByText('Cited sites', { selector: 'p' }).nextElementSibling!.textContent).toBe('rentals.example 5')
  const table = within(screen.getByRole('table'))
  expect(table.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Question', 'Result', 'Cited sites', 'Tracking review'])
  expect(table.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))).toEqual([
    ['Lofts near transit', 'Cited queries', 'demo.example', 'Review for tracking'],
    ['Cheapest storage units', 'Skip', '-', ''],
  ])
  // What a review does is the help beside the heading, with no Step card and no paragraph.
  expect(screen.getByRole('button', { name: FIND_COPY.resultsHelp })).toBeTruthy()
  // Nothing on the page is a sentence: every run of text is a label of four words or fewer.
  expect(shownText().filter(text => text.split(/\s+/).length > 4)).toEqual([])
  expect(shownText().join('\n')).not.toMatch(/Step \d|Generate and check|Describe your customer|scope|\u2014/)

  // Find ideas starts a run only when pressed, with the number of questions asked for.
  expect(state.posts).toEqual([])
  fireEvent.change(customer, { target: { value: 'Renters moving for work' } })
  fireEvent.click(screen.getByRole('button', { name: FIND_COPY.runAction }))
  await waitFor(() => expect(state.posts).toEqual([{ path: '/api/v1/projects/demo/discover/run', body: { icpDescription: 'Renters moving for work', maxProbes: 100 } }]))
})

test('Find ideas with no runs says so, and a failed read offers Retry', async () => {
  const state = installApi({ failSessions: true })
  renderPage({ researchMode: 'find' })
  const failed = await screen.findByRole('button', { name: `${FIND_COPY.loadError}. ${FIND_COPY.runsError}` })
  expect(failed.textContent).toBe('Could not load')
  // A list that did not load is not an empty one, and its one action is Retry.
  expect(screen.queryByText(FIND_COPY.noRuns)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  state.failSessions = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry recent runs' }))
  expect((await screen.findByText(FIND_COPY.noRuns)).textContent).toBe('No runs yet')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  // With no run there is nothing to show results for.
  expect(screen.getByText(FIND_COPY.noRun)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: FIND_COPY.resultsTitle })).toBeNull()
  expect(state.posts).toEqual([])
})
