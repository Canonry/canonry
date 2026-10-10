import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResearchBatchCreate, ResearchRunDetailDto } from '@ainyc/canonry-contracts'
import { ResearchQueriesSection, RESEARCH_COPY } from '../src/components/project/ResearchQueriesSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => { cleanup(); resetToasts() })

const atlanta = { label: 'Atlanta GA', city: 'Atlanta', region: 'GA', country: 'US' }
const boston = { label: 'Boston MA', city: 'Boston', region: 'MA', country: 'US' }
type SectionProps = Omit<Partial<React.ComponentProps<typeof ResearchQueriesSection>>, 'projectName'>
const advanced: SectionProps = {
  planRevision: 7,
  scopeOptions: [
    { id: 'atlanta', label: 'Atlanta', kind: 'market', targetCount: 2 },
    { id: 'boston', label: 'Boston', kind: 'market', targetCount: 1 },
    { id: 'maple', label: 'Maple House', kind: 'property', targetCount: 1 },
    { id: 'portfolio', label: 'Portfolio group', kind: 'group', targetCount: 3 },
  ],
}

function setup(sectionProps: SectionProps = {}, access: 'admin' | 'viewer' | 'read-only' | 'research-key' = 'admin') {
  const state = { posts: [] as ResearchBatchCreate[], puts: [] as Record<string, unknown>[], fail: false, failSave: false, settingsReads: 0, runs: [] as ResearchRunDetailDto[], pendingResponse: null as Promise<void> | null, canRun: access !== 'read-only', historyError: false }
  const project = {
    id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
    country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: { openai: 'project-model' },
    locations: [atlanta, boston], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const catalog = [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'project-model', knownModels: [{ id: 'other-model', displayName: 'Other model' }], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }]
  const restore = mockFetch(async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/batches' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as ResearchBatchCreate
      state.posts.push(body)
      if (state.pendingResponse) await state.pendingResponse
      if (state.fail) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Response lost' } }, 503)
      state.runs = body.runs.map((run, index) => ({
        id: `run-${index}`, projectId: project.id, status: 'completed', provider: run.provider, requestedModel: run.model, resolvedModel: run.model,
        location: run.location, scope: run.scope ? { kind: run.scope.kind, key: run.scope.key, label: run.scope.key, planRevision: run.scope.expectedPlanRevision! } : null,
        template: null, totalQueries: run.queries.length, completedQueries: run.queries.length, failedQueries: 0, error: null,
        initiatedBy: null, startedAt: null, finishedAt: null, createdAt: '2026-09-09T12:00:00.000Z', queries: [],
      }))
      return jsonResponse({ runs: state.runs }, 202)
    }
    if (path === '/api/v1/projects/demo/research/runs') return state.historyError
      ? jsonResponse({ error: { code: 'UNAVAILABLE', message: 'History unavailable' } }, 503)
      : jsonResponse({ runs: state.runs, providers: catalog, access: { canRun: state.canRun, dailyRunLimit: access === 'admin' || !state.canRun ? null : 10 } })
    if (path.startsWith('/api/v1/projects/demo/research/runs/')) return jsonResponse(state.runs.find(run => path.endsWith(`/${run.id}`)))
    if (path.startsWith('/api/v1/projects/demo/measurement-query-templates/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      state.puts.push(body)
      if (state.failSave) return jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Save unavailable' } }, 503)
      return jsonResponse({ id: path.split('/').at(-1), ...body, projectId: project.id, createdAt: 'v1', updatedAt: 'v1' }, 201)
    }
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/settings') {
      state.settingsReads += 1
      return jsonResponse({ providers: [{ name: 'openai', displayName: 'OpenAI', configured: true }], providerCatalog: catalog })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const ui = (props: SectionProps) => <QueryClientProvider client={queryClient}>
    <AccountProvider account={access === 'viewer' ? { name: 'Viewer', role: 'viewer' } : null} apiKey={access === 'read-only' ? { id: 'read', scopes: ['read'], projectId: null, readOnly: true } : access === 'research-key' ? { id: 'research', scopes: ['read', 'research.run'], projectId: project.id, readOnly: false } : null}>
      <ResearchQueriesSection projectName="demo" {...(access === 'viewer' ? { viewerResearchConfig: { viewerDailyRunLimit: 10 } } : {})} {...props} />
    </AccountProvider>
  </QueryClientProvider>
  const view = render(ui(sectionProps))
  return { state, project, queryClient, rerender: (props: SectionProps) => view.rerender(ui(props)) }
}

/** The Run button says how many answers it will ask for, and only "Run" while there is none. */
const RUN = /^Run(?: \d+ answers?)?$/
const runButton = () => screen.getByRole('button', { name: RUN }) as HTMLButtonElement
/** An account that cannot run research has no Run button, only the reason in its place. */
const expectViewOnly = () => {
  expect(screen.queryByRole('button', { name: RUN })).toBeNull()
  expect(screen.getByRole('button', { name: `${RESEARCH_COPY.viewOnly}. ${RESEARCH_COPY.viewOnlyDetail}` }).textContent).toBe('View only')
}
/** What a pattern repeats for, by the batch mode it sends as. */
const FOR_EACH = { markets: 'Market', properties: 'Location', locations: 'Search location' } as const
const forEach = () => within(screen.getByRole('radiogroup', { name: 'For each' }))
/** The four batch modes, reached as a reader reaches them: Write, or Pattern and what it repeats for. */
const setMode = (value: 'once' | keyof typeof FOR_EACH) => {
  fireEvent.click(screen.getByRole('radio', { name: value === 'once' ? 'Write' : 'Pattern' }))
  if (value !== 'once') fireEvent.click(forEach().getByRole('radio', { name: FOR_EACH[value] }))
}
const choices = (group: HTMLElement) => within(group).getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked')])
const typePattern = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Pattern' }), { target: { value } })
const choose = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }))
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
const results = () => within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
/** The select over the results of a batch that saved more than one run: one choice per run, with its status. */
const batchRuns = () => [...(results().getByRole('combobox') as HTMLSelectElement).options].map(option => option.text)
const ready = () => screen.findByRole('option', { name: 'OpenAI' })
/** A check that holds back a preview or a run: its short label is what shows, its sentence is the tooltip and the rest of its name. */
const note = (label: string, detail: RegExp) => {
  const item = screen.getByRole('button', { name: new RegExp(`^${label}\\. ${detail.source}`) })
  expect(item.textContent).toBe(label)
  return item
}
/** Everything a reader can meet, one piece per line: each run of text, each control's name and tooltip, and each placeholder. `textContent` joins neighbours with nothing between them, which hides a whole-word match from `\b`. */
const shownCopy = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const text: Array<string | null> = []
  while (walker.nextNode()) text.push(walker.currentNode.textContent)
  return [...text, ...[...document.querySelectorAll('[aria-label], [placeholder]')].flatMap(item => [item.getAttribute('aria-label'), item.getAttribute('placeholder')])].join('\n')
}
// `{property}` is the pattern's own name for a location, so it is the one place the word stays.
const OLD_WORDS = /whole site|destination|\bclass\b|classification|(?<!\{)\bpropert(?:y|ies)\b|template|\bscoped?\b|\bcontext\b|unclassified|\bunknown\b|\bdiscovery\b|answer engine|\u2014/i

test('Write is plain queries with no pattern controls or initial errors', async () => {
  const { state } = setup(advanced)
  await ready()
  // Alone, the section starts from Write or Pattern. Find ideas is the page's to offer.
  expect(choices(screen.getByRole('radiogroup', { name: 'Start from' }))).toEqual([['Write', 'true'], ['Pattern', 'false']])
  expect(screen.queryByRole('radiogroup', { name: 'For each' })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Pattern' })).toBeNull()
  expect(screen.queryByRole('button', { name: /name$/ })).toBeNull()
  expect(screen.queryByText(/Saved patterns/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(state.posts).toHaveLength(0)
})

test('direct queries preserve exact text, deduplicate, and submit only once', async () => {
  const { state } = setup({ ...advanced, scopeError: true })
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: '  Exact query  \nEXACT QUERY\n\nSecond query\n' } })
  // Three lines, one of them a repeat: two answers.
  expect(runButton().textContent).toBe('Run 2 answers')
  fireEvent.click(runButton())
  fireEvent.click(screen.getByRole('button', { name: /^(Starting…|Run 2 answers)$/ }))
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]).toEqual({ idempotencyKey: expect.any(String), runs: [{ queries: ['  Exact query  ', 'Second query'], provider: 'openai', model: 'project-model', location: null }] })
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe(''))
  expect(runButton().disabled).toBe(true)
  expect(runButton().textContent).toBe('Run')
  // One run has nothing to choose between: its results show with no select over them.
  await waitFor(() => expect(Object.fromEntries([...document.querySelectorAll('[role="region"] dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]))).toMatchObject({ Run: 'run-0', Subject: 'Not set' }))
  expect(results().queryByRole('combobox')).toBeNull()
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Research saved', '1 run · Past research']]))
})

test('explicit markets resolve independently and preserve edited query text and location', async () => {
  const { state } = setup(advanced)
  await ready()
  setMode('markets'); choose('Atlanta'); choose('Boston')
  expect(screen.queryByRole('checkbox', { name: 'Portfolio group' })).toBeNull()
  typePattern('Best apartments in {market}')
  expect(runButton().disabled).toBe(true)
  preview()
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('Best apartments in Atlanta')
  expect(screen.getByRole('button', { name: RESEARCH_COPY.previewHelp })).toBeTruthy()
  // Each row says what it is for: its number, the place and the place's kind.
  expect([...document.querySelectorAll('ol > li > div:first-child')].map(cell => [...cell.children].map(part => part.textContent))).toEqual([['Query 1', 'Atlanta', 'Market'], ['Query 2', 'Boston', 'Market']])
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 2 for Boston' }), { target: { value: '  Boston apartments near transit  ' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Search location for query 2' }), { target: { value: boston.label } })
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toEqual([
    { queries: ['Best apartments in Atlanta'], provider: 'openai', model: 'project-model', location: null, scope: { kind: 'market', key: 'atlanta', expectedPlanRevision: 7 } },
    { queries: ['  Boston apartments near transit  '], provider: 'openai', model: 'project-model', location: boston, scope: { kind: 'market', key: 'boston', expectedPlanRevision: 7 } },
  ])
  // One choice per saved run: its Subject, then its search location when it has one, then its status. The fixture labels a Subject with its key.
  await waitFor(() => expect(batchRuns()).toEqual(['atlanta · Completed', `boston · ${boston.label} · Completed`]))
  expect(results().getByRole('combobox', { name: 'Subject' })).toHaveProperty('value', 'run-0')
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Research saved', '2 runs · Past research']]))
})

test('Simple portfolio repeats across configured locations without a measurement plan', async () => {
  const { state } = setup()
  await ready()
  // A simple project has no markets or locations to save under or repeat across.
  expect(screen.queryByRole('combobox', { name: 'Subject' })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Pattern' }))
  expect(choices(screen.getByRole('radiogroup', { name: 'For each' }))).toEqual([['Search location', 'true']])
  choose(atlanta.label); choose(boston.label)
  typePattern('Apartments in {location}'); preview(); fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toEqual([atlanta, boston].map(location => ({ queries: [`Apartments in ${location.label}`], provider: 'openai', model: 'project-model', location })))
  // No run of this batch has a Subject, so the select over its results is named for what its runs differ in.
  await waitFor(() => expect(batchRuns()).toEqual([`${atlanta.label} · Completed`, `${boston.label} · Completed`]))
  expect(results().getByRole('combobox', { name: 'Search location' })).toBeTruthy()
})

test('property patterns resolve only the selected property', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('properties'); choose('Maple House')
  typePattern('What amenities does {property} offer?'); preview()
  // A property is a Location on screen, never the wire word.
  expect([...document.querySelector('ol > li > div:first-child')!.children].map(part => part.textContent)).toEqual(['Query 1', 'Maple House', 'Location'])
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs[0]).toMatchObject({ queries: ['What amenities does Maple House offer?'], location: null, scope: { kind: 'property', key: 'maple', expectedPlanRevision: 7 } })
})

test.each(['simple', 'advanced'] as const)('a research-only key can review and run %s destinations without broader writes', async portfolio => {
  const { state } = setup(portfolio === 'advanced' ? advanced : {}, 'research-key')
  await ready()
  setMode(portfolio === 'advanced' ? 'markets' : 'locations')
  choose(portfolio === 'advanced' ? 'Atlanta' : atlanta.label)
  choose(portfolio === 'advanced' ? 'Boston' : boston.label)
  typePattern(portfolio === 'advanced' ? 'Apartments in {market}' : 'Apartments in {location}')
  expect(screen.queryByRole('button', { name: 'Save as a pattern' })).toBeNull()
  preview()
  expect(runButton().disabled).toBe(false)
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toHaveLength(2)
  expect(state.posts[0]?.runs[0]).toMatchObject(portfolio === 'advanced'
    ? { queries: ['Apartments in Atlanta'], scope: { kind: 'market', key: 'atlanta', expectedPlanRevision: 7 }, location: null }
    : { queries: [`Apartments in ${atlanta.label}`], location: atlanta })
  expect(state.settingsReads).toBe(0)
  expect(state.puts).toHaveLength(0)
})

test.each(['revoked', 'history-error'] as const)('a reviewed batch stops when research access becomes %s', async failure => {
  const { state, queryClient } = setup(advanced, 'research-key')
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}'); preview()
  expect(runButton().disabled).toBe(false)
  if (failure === 'revoked') state.canRun = false
  else state.historyError = true
  await queryClient.invalidateQueries()
  // Revoked access leaves no Run button; a failed read keeps it, switched off, beside the Retry for past research.
  if (failure === 'revoked') await waitFor(expectViewOnly)
  else {
    await waitFor(() => expect(runButton().disabled).toBe(true))
    fireEvent.click(runButton())
    expect(screen.queryByRole('button', { name: new RegExp(`^${RESEARCH_COPY.viewOnly}`) })).toBeNull()
  }
  expect(state.posts).toHaveLength(0)
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('Apartments in Atlanta')
})

test('a removed selected market cannot silently become whole-site research', async () => {
  const { state } = setup({ ...advanced, selectedScope: { kind: 'market', key: 'retired', label: 'Retired', planRevision: 7, expectedPlanRevision: 7 } })
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'My question' } })
  expect(screen.getByRole('option', { name: 'Subject unavailable' })).toBeTruthy()
  note('Subject unavailable', /The Subject is no longer in the published plan\./)
  expect(runButton().disabled).toBe(true)
  expect(state.posts).toHaveLength(0)
  fireEvent.change(screen.getByRole('combobox', { name: 'Subject' }), { target: { value: 'project' } })
  expect((screen.getByRole('option', { name: 'Not set' }) as HTMLOptionElement).selected).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(runButton().disabled).toBe(false)
})

test('a saved pattern version change blocks execution and preserves the reviewed text', async () => {
  const saved = { id: 'market-pattern', version: 'v1', label: 'Apartments', pattern: 'Apartments in {market}', variables: ['market'] }
  const view = setup({ ...advanced, templates: [saved] })
  await ready(); setMode('markets'); choose('Atlanta')
  fireEvent.click(screen.getByText('Saved patterns')); fireEvent.click(screen.getByRole('button', { name: 'Apartments' })); preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'Reviewed query' } })
  view.rerender({ ...advanced, templates: [{ ...saved, version: 'v2', pattern: 'Updated {market}' }] })
  expect(runButton().disabled).toBe(true)
  expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-label')).toBe('Pattern changed. This saved pattern changed. Pick its current version from Saved patterns.')
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('Reviewed query')
})

test('plan and model changes invalidate previews without discarding edited rows', async () => {
  const view = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}'); preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'My reviewed wording' } })
  expect(screen.queryByRole('alert')).toBeNull()
  view.rerender({ ...advanced, planRevision: 8 })
  expect(runButton().disabled).toBe(true)
  expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-label')).toBe(`${RESEARCH_COPY.planChanged}. ${RESEARCH_COPY.planChangedDetail}`)
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('My reviewed wording')
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.refreshPreview }))
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'other-model' } })
  expect(runButton().disabled).toBe(true)
  // The plan is the same one: only the setup moved, and the note says so.
  expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-label')).toBe(`${RESEARCH_COPY.setupChanged}. ${RESEARCH_COPY.setupChangedDetail}`)
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.refreshPreview })); fireEvent.click(runButton())
  await waitFor(() => expect(view.state.posts).toHaveLength(1))
  expect(view.state.posts[0]?.runs[0]).toMatchObject({ model: 'other-model', scope: { expectedPlanRevision: 8 } })
})

test('an uncertain request reuses the same idempotency key on unchanged retry', async () => {
  const { state } = setup()
  state.fail = true
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'Apartments near transit' } })
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect((await screen.findByRole('button', { name: `${RESEARCH_COPY.notConfirmed}. The request could not be confirmed. ${RESEARCH_COPY.notConfirmedDetail}` })).textContent).toBe('Not confirmed')
  // The toast is a short title over the server's own message, with no sentence of ours added.
  expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Could not start research', 'Response lost']])
  await waitFor(() => expect(runButton().disabled).toBe(false))
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(2))
  expect(state.posts[1]).toEqual(state.posts[0])
})

test('locks the editor while starting a run so a late response cannot discard new edits', async () => {
  const { state } = setup()
  let release!: () => void
  state.pendingResponse = new Promise(resolve => { release = resolve })
  await ready()
  const editor = screen.getByRole('textbox', { name: 'Queries' })
  fireEvent.change(editor, { target: { value: 'Reviewed question' } }); fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(editor.matches(':disabled')).toBe(true)
  expect(screen.getAllByRole('radio').map(radio => radio.matches(':disabled'))).toEqual([true, true])
  release()
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe(''))
  expect(screen.getByRole('textbox', { name: 'Queries' }).matches(':disabled')).toBe(false)
})

test.each(['Apartments in {unknown}', 'Apartments in {market', 'Apartments in {{market}}'])('blocks unsupported or malformed variables: %s', async pattern => {
  const { state } = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern(pattern); preview()
  note('Name not recognized', /Use the name button to insert a name\. Remove unrecognized or incomplete braces\./)
  expect(screen.queryByRole('textbox', { name: 'Query 1 for Atlanta' })).toBeNull()
  expect(runButton().disabled).toBe(true)
  expect(state.posts).toHaveLength(0)
})

test('blank or duplicate preview rows and expanded query limits block execution', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}\nTransit in {market}'); preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: ' ' } })
  note('Incomplete query', /Every row needs a query of 1 to 4,000 characters with no unfilled names\./)
  expect(runButton().disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'Transit in Atlanta' } })
  note('Duplicate queries', /Remove repeated queries within one run\./)
  expect(runButton().disabled).toBe(true)
  choose('Boston'); typePattern(Array.from({ length: 26 }, (_, index) => `Question ${index} in {market}`).join('\n'))
  note('Over 50 queries', /52 queries selected\. One batch takes at most 50\./)
  expect(screen.getByText('52 of 50 queries · 2 runs')).toBeTruthy()
  expect(state.posts).toHaveLength(0)
})

test('saving a pattern does not run queries; reuse records provenance and edited text', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}')
  fireEvent.click(screen.getByText('Saved patterns'))
  fireEvent.click(screen.getByRole('button', { name: 'Save as a pattern' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern name' }), { target: { value: 'Apartment search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save pattern' }))
  await waitFor(() => expect(state.puts).toHaveLength(1))
  await screen.findByText('Using: Apartment search')
  expect(state.puts[0]).toEqual({ name: 'Apartment search', pattern: 'Apartments in {market}', variables: ['market'] })
  expect(state.posts).toHaveLength(0)
  preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'Atlanta apartments near transit' } })
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs[0]).toMatchObject({ queries: ['Atlanta apartments near transit'], template: { templateId: expect.any(String), templateVersion: 'v1' } })
})

test('a granted viewer can repeat queries without accessing settings or saving patterns', async () => {
  const { state } = setup({}, 'viewer')
  await ready(); setMode('locations'); choose(atlanta.label); typePattern('Apartments in {location}'); preview()
  expect(state.settingsReads).toBe(0)
  expect(screen.queryByRole('button', { name: 'Save as a pattern' })).toBeNull()
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
})

test('read-only keys can preview but cannot run research or save patterns', async () => {
  const { state } = setup({}, 'read-only')
  await ready(); setMode('locations'); choose(atlanta.label); typePattern('Apartments in {location}'); preview()
  expect(screen.getByRole('textbox', { name: `Query 1 for ${atlanta.label}` })).toBeTruthy()
  expectViewOnly()
  expect(screen.queryByRole('button', { name: 'Save as a pattern' })).toBeNull()
  expect(state.posts).toHaveLength(0)
})

test.each([null, boston])('freezes a saved pattern location before editing the execution location to %j', async location => {
  const saved = { id: 'location-pattern', version: 'v1', label: 'Location fixture', pattern: 'Apartments in {location}', variables: ['location'] }
  const { state } = setup({ templates: [saved] })
  await ready(); setMode('locations'); choose(atlanta.label)
  fireEvent.click(screen.getByRole('button', { name: saved.label })); preview()
  const row = document.querySelector('ol > li')!
  expect(row.querySelector('textarea')!.value).toBe('Apartments in ' + atlanta.label)
  fireEvent.change(row.querySelector('select')!, { target: { value: location?.label ?? '__none__' } })
  expect(runButton().disabled).toBe(false)
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs[0]).toMatchObject({ queries: ['Apartments in ' + atlanta.label], location, template: { templateId: saved.id, templateVersion: saved.version, bindingLocation: atlanta } })
})

test('a pattern repeats for each Market, Location or Search location, with no older wording left', async () => {
  const { state } = setup(advanced)
  await ready()
  const subject = screen.getByRole('combobox', { name: 'Subject' }) as HTMLSelectElement
  expect([...subject.options].map(option => option.text)).toEqual(['Not set', 'Atlanta (market)', 'Boston (market)', 'Maple House (location)'])
  expect([...(screen.getByRole('combobox', { name: 'Search location' }) as HTMLSelectElement).options].map(option => option.text)).toEqual(['No search location', atlanta.label, boston.label])
  expect(screen.getByRole('button', { name: RESEARCH_COPY.introHelp })).toBeTruthy()
  expect(screen.getByRole('button', { name: RESEARCH_COPY.subjectHelp })).toBeTruthy()
  expect(screen.getByRole('button', { name: RESEARCH_COPY.queriesHelp })).toBeTruthy()
  expect(shownCopy()).not.toMatch(OLD_WORDS)

  const modes: Array<[mode: keyof typeof FOR_EACH, heading: string, name: string, token: string, insert: string]> = [
    ['markets', 'Markets', 'Atlanta', '{market}', 'Market name'],
    ['properties', 'Locations', 'Maple House', '{property}', 'Location name'],
    ['locations', 'Search locations', atlanta.label, '{location}', 'Search location name'],
  ]
  for (const [value, heading, name, token, insert] of modes) {
    setMode(value)
    // Pattern opens on the first kind of place the project has, and the choice made stays the checked one.
    expect(choices(screen.getByRole('radiogroup', { name: 'For each' }))).toEqual((['markets', 'properties', 'locations'] as const).map(kind => [FOR_EACH[kind], String(kind === value)]))
    const places = screen.getByRole('group', { name: heading })
    const noun = heading.toLowerCase().replace(/s$/, '')
    expect(within(places).getByRole('button', { name: `Select each ${noun} yourself. Each one gets its own saved run.` })).toBeTruthy()
    // A market or a location has a search location beside it, so those two lists have column headers. A search location is its own.
    expect([...(places.querySelector('div[aria-hidden="true"]')?.children ?? [])].map(header => header.textContent)).toEqual(value === 'locations' ? [] : [heading.replace(/s$/, ''), 'Search location'])
    expect(screen.getByRole('button', { name: `One pattern per line. Put ${token} where each name belongs, then preview the queries before running.` })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search' }).getAttribute('placeholder')).toBe('Search')
    // The name button still writes the pattern's own name for the place. The pattern is kept across run modes, so it is cleared first.
    typePattern('')
    fireEvent.click(screen.getByRole('button', { name: insert }))
    expect((screen.getByRole('textbox', { name: 'Pattern' }) as HTMLTextAreaElement).value).toBe(token)
    note(`Pick a ${noun}`, new RegExp(`Select at least one ${noun}\\.`))
    choose(name)
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(screen.getByText('1 of 50 queries · 1 run')).toBeTruthy()
    fireEvent.click(screen.getByText('Saved patterns'))
    expect(screen.getByText(RESEARCH_COPY.noSavedPatterns)).toBeTruthy()
    expect(screen.getByRole('button', { name: RESEARCH_COPY.savedPatternsHelp })).toBeTruthy()
    // A preview made in one run mode is kept in the next, where the same button regenerates it.
    fireEvent.click(screen.getByRole('button', { name: value === 'markets' ? 'Preview queries' : RESEARCH_COPY.refreshPreview }))
    expect(screen.getByText('1 query · 1 run')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: `Query 1 for ${name}` }) as HTMLTextAreaElement).value).toBe(name)
    // The button carries the count; the line beside it names the engine and the model.
    expect(runButton().parentElement!.textContent).toBe('Run 1 answerOpenAI · project-model')
    expect(shownCopy()).not.toMatch(OLD_WORDS)
  }
  // A market or a location takes its search location in the row; a search location is its own.
  setMode('markets'); choose('Atlanta')
  // The select is named for its row. Its own label is the short one, shown where the select stacks under the row.
  expect(screen.getByRole('combobox', { name: 'Search location for Atlanta' }).closest('label')!.querySelector('span')!.textContent).toBe('Search location')
  expect(screen.getByRole('button', { name: RESEARCH_COPY.selectedHelp })).toBeTruthy()
  setMode('locations'); choose(atlanta.label)
  expect(screen.queryByRole('combobox', { name: `Search location for ${atlanta.label}` })).toBeNull()
  expect(screen.queryByRole('button', { name: RESEARCH_COPY.selectedHelp })).toBeNull()
  expect(state.posts).toHaveLength(0)
})

test('{location} in a location pattern is flagged as the search location and binds what it always did', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('properties'); choose('Maple House')
  typePattern('What amenities does {property} offer?')
  expect(screen.queryByRole('button', { name: new RegExp(`^${RESEARCH_COPY.usesSearchLocation}`) })).toBeNull()

  typePattern('What does {property} offer near {location}?')
  expect(screen.getByRole('button', { name: `${RESEARCH_COPY.usesSearchLocation}. ${RESEARCH_COPY.usesSearchLocationDetail}` }).textContent).toBe('Uses search location')
  // No search location is set beside the location yet, so {location} has nothing to bind.
  note('Pick a search location', /\{location\} is the search location\. Set one beside each selected location, or remove \{location\}\./)
  preview()
  expect(screen.queryByRole('textbox', { name: 'Query 1 for Maple House' })).toBeNull()
  expect(runButton().disabled).toBe(true)

  fireEvent.change(screen.getByRole('combobox', { name: 'Search location for Maple House' }), { target: { value: boston.label } })
  expect(screen.queryByRole('alert')).toBeNull()
  // The caveat is a reminder, not a block: it stays while the pattern holds {location}.
  expect(screen.getByRole('button', { name: new RegExp(`^${RESEARCH_COPY.usesSearchLocation}`) })).toBeTruthy()
  preview()
  expect((screen.getByRole('textbox', { name: 'Query 1 for Maple House' }) as HTMLTextAreaElement).value).toBe(`What does Maple House offer near ${boston.label}?`)
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toEqual([{ queries: [`What does Maple House offer near ${boston.label}?`], provider: 'openai', model: 'project-model', location: boston, scope: { kind: 'property', key: 'maple', expectedPlanRevision: 7 } }])

  // The caveat is for locations only: a market is not a location, so nothing there can be mistaken for one.
  setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market} near {location}')
  expect(screen.queryByRole('button', { name: new RegExp(`^${RESEARCH_COPY.usesSearchLocation}`) })).toBeNull()
  // A name that belongs to another run mode has no value here.
  typePattern('Apartments at {property}')
  note('Name has no value', /A name in this pattern has no value for a market\. Use the name button to insert one that does\./)
})

test('a batch over the run limit, places still loading and a failed places read each show one short label', async () => {
  const many = Array.from({ length: 21 }, (_, index) => ({ id: `home-${index}`, label: `Harbor Home ${index}`, kind: 'property' as const, targetCount: 1 }))
  const onRetryScope = vi.fn()
  const view = setup({ planRevision: 7, scopeOptions: many })
  await ready(); setMode('properties')
  // One query for all 21 boxes: a query by name works out every control's name again on each call.
  const boxes = within(screen.getByRole('group', { name: 'Locations' })).getAllByRole('checkbox')
  expect(boxes).toHaveLength(21)
  for (const box of boxes) fireEvent.click(box)
  typePattern('Is {property} pet friendly?')
  note('Over 20 runs', /21 locations selected\. One batch takes at most 20 runs\./)
  expect(screen.getByText('21 selected')).toBeTruthy()
  expect(screen.getByText('21 of 50 queries · 21 runs')).toBeTruthy()
  preview()
  expect(screen.queryByRole('textbox', { name: /^Query 1 for/ })).toBeNull()

  fireEvent.click(boxes[20]!)
  expect(screen.queryByRole('alert')).toBeNull()
  view.rerender({ planRevision: 7, scopeOptions: many, scopePending: true })
  note('Places not loaded', /Markets and locations are loading or did not load\./)
  expect(runButton().disabled).toBe(true)

  view.rerender({ planRevision: 7, scopeOptions: many, scopeError: true, onRetryScope })
  const failed = screen.getByRole('button', { name: /^Could not load\. Markets and locations did not load\./ })
  expect(failed.textContent).toBe('Could not load')
  const retry = screen.getByRole('button', { name: 'Retry markets and locations' })
  expect(retry.textContent).toBe('Retry')
  fireEvent.click(retry)
  expect(onRetryScope).toHaveBeenCalledTimes(1)
  expect(shownCopy()).not.toMatch(OLD_WORDS)
  expect(view.state.posts).toHaveLength(0)
})

test('a market or a search location that goes away is named once, each under its own label', async () => {
  const view = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); choose('Boston')
  fireEvent.change(screen.getByRole('combobox', { name: 'Search location for Boston' }), { target: { value: boston.label } })
  typePattern('Apartments in {market}'); preview()
  expect(screen.queryByRole('alert')).toBeNull()

  // The plan no longer holds a selected market. Two checks see it, and the reader gets one note.
  view.rerender({ ...advanced, scopeOptions: advanced.scopeOptions!.filter(option => option.id !== 'atlanta') })
  note('Selection unavailable', /A selected market, location or search location is no longer available\. Update the selection\./)
  expect(runButton().disabled).toBe(true)
  view.rerender(advanced)
  expect(screen.queryByRole('alert')).toBeNull()

  // The project no longer has the search location set beside Boston: the selection and the previewed row each say so in their own words.
  view.project.locations = [atlanta]
  await view.queryClient.invalidateQueries()
  await waitFor(() => note('Search location changed', /A search location in this preview changed\. Regenerate the preview\./))
  note('Selection unavailable', /A selected market, location or search location is no longer available\./)
  expect(runButton().disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: 'Query 2 for Boston' }) as HTMLTextAreaElement).value).toBe('Apartments in Boston')
  expect(view.state.posts).toHaveLength(0)
})

test('an empty pattern, a query that is too long and a pattern that cannot be saved each show one short label', async () => {
  const { state } = setup(advanced)
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'a'.repeat(4001) } })
  note('Query too long', /Keep each query under 4,001 characters\./)
  expect(runButton().disabled).toBe(true)

  setMode('markets'); choose('Atlanta')
  expect(screen.queryByRole('alert')).toBeNull()
  preview()
  note('Write a pattern', /Enter at least one pattern\./)
  expect(screen.queryByRole('textbox', { name: /^Query 1 for/ })).toBeNull()

  typePattern('Apartments in {market')
  fireEvent.click(screen.getByText('Saved patterns'))
  fireEvent.click(screen.getByRole('button', { name: 'Save as a pattern' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Pattern name' }), { target: { value: 'Apartment search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save pattern' }))
  note('Invalid pattern', /Enter a name and a pattern of 1 to 4,000 characters with no incomplete braces\./)
  expect(state.puts).toHaveLength(0)

  state.failSave = true
  typePattern('Apartments in {market}')
  fireEvent.click(screen.getByRole('button', { name: 'Save pattern' }))
  const failed = await screen.findByRole('button', { name: 'Could not save. The pattern was not saved. Your text is kept. Save again to retry.' })
  expect(failed.textContent).toBe('Could not save')
  expect(state.puts).toHaveLength(1)
  expect((screen.getByRole('textbox', { name: 'Pattern' }) as HTMLTextAreaElement).value).toBe('Apartments in {market}')
  expect(getToasts()).toEqual([])

  state.failSave = false
  fireEvent.click(screen.getByRole('button', { name: 'Save pattern' }))
  await screen.findByText('Using: Apartment search')
  expect(getToasts().map(toast => [toast.title, toast.detail])).toEqual([['Pattern saved', 'In Saved patterns']])
  expect(shownCopy()).not.toMatch(OLD_WORDS)
  expect(state.posts).toHaveLength(0)
})
