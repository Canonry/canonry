import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResearchBatchCreate, ResearchRunDetailDto } from '@ainyc/canonry-contracts'
import { ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

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
  const state = { posts: [] as ResearchBatchCreate[], puts: [] as Record<string, unknown>[], fail: false, settingsReads: 0, runs: [] as ResearchRunDetailDto[], pendingResponse: null as Promise<void> | null, canRun: access !== 'read-only', historyError: false }
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

const runButton = () => screen.getByRole('button', { name: 'Run queries' }) as HTMLButtonElement
const setMode = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Run mode' }), { target: { value } })
const typePattern = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Query pattern' }), { target: { value } })
const choose = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }))
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview queries' }))
const ready = () => screen.findByRole('option', { name: 'OpenAI' })

test('Run once is plain queries with no pattern controls or initial errors', async () => {
  const { state } = setup(advanced)
  await ready()
  expect(screen.getByRole('textbox', { name: 'Queries' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Query pattern' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Insert/ })).toBeNull()
  expect(screen.queryByText(/Saved patterns/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(state.posts).toHaveLength(0)
})

test('direct queries preserve exact text, deduplicate, and submit only once', async () => {
  const { state } = setup({ ...advanced, scopeError: true })
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: '  Exact query  \nEXACT QUERY\n\nSecond query\n' } })
  fireEvent.click(runButton())
  fireEvent.click(screen.getByRole('button', { name: /Starting|Run queries/ }))
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]).toEqual({ idempotencyKey: expect.any(String), runs: [{ queries: ['  Exact query  ', 'Second query'], provider: 'openai', model: 'project-model', location: null }] })
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe(''))
  expect(runButton().disabled).toBe(true)
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
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 2 for Boston' }), { target: { value: '  Boston apartments near transit  ' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Location for query 2' }), { target: { value: boston.label } })
  fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toEqual([
    { queries: ['Best apartments in Atlanta'], provider: 'openai', model: 'project-model', location: null, scope: { kind: 'market', key: 'atlanta', expectedPlanRevision: 7 } },
    { queries: ['  Boston apartments near transit  '], provider: 'openai', model: 'project-model', location: boston, scope: { kind: 'market', key: 'boston', expectedPlanRevision: 7 } },
  ])
})

test('Simple portfolio repeats across configured locations without a measurement plan', async () => {
  const { state } = setup()
  await ready(); setMode('locations'); choose(atlanta.label); choose(boston.label)
  typePattern('Apartments in {location}'); preview(); fireEvent.click(runButton())
  await waitFor(() => expect(state.posts).toHaveLength(1))
  expect(state.posts[0]?.runs).toEqual([atlanta, boston].map(location => ({ queries: [`Apartments in ${location.label}`], provider: 'openai', model: 'project-model', location })))
})

test('property patterns resolve only the selected property', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('properties'); choose('Maple House')
  typePattern('What amenities does {property} offer?'); preview(); fireEvent.click(runButton())
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
  await waitFor(() => expect(runButton().disabled).toBe(true))
  fireEvent.click(runButton())
  expect(state.posts).toHaveLength(0)
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('Apartments in Atlanta')
})

test('a removed selected market cannot silently become whole-site research', async () => {
  const { state } = setup({ ...advanced, selectedScope: { kind: 'market', key: 'retired', label: 'Retired', planRevision: 7, expectedPlanRevision: 7 } })
  await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'My question' } })
  expect(screen.getByRole('option', { name: 'Selected destination unavailable' })).toBeTruthy()
  expect(runButton().disabled).toBe(true)
  expect(state.posts).toHaveLength(0)
  fireEvent.change(screen.getByRole('combobox', { name: 'Save results under' }), { target: { value: 'project' } })
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
  expect(screen.getByRole('alert').textContent).toContain('This saved pattern changed')
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('Reviewed query')
})

test('plan and model changes invalidate previews without discarding edited rows', async () => {
  const view = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}'); preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'My reviewed wording' } })
  view.rerender({ ...advanced, planRevision: 8 })
  expect(runButton().disabled).toBe(true)
  expect((screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }) as HTMLTextAreaElement).value).toBe('My reviewed wording')
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate preview' }))
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'other-model' } })
  expect(runButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate preview' })); fireEvent.click(runButton())
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
  await screen.findByText(/The request could not be confirmed/)
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
  expect(screen.getByRole('combobox', { name: 'Run mode' }).matches(':disabled')).toBe(true)
  release()
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe(''))
  expect(screen.getByRole('textbox', { name: 'Queries' }).matches(':disabled')).toBe(false)
})

test.each(['Apartments in {unknown}', 'Apartments in {market', 'Apartments in {{market}}'])('blocks unsupported or malformed variables: %s', async pattern => {
  const { state } = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern(pattern); preview()
  expect(screen.getByRole('alert').textContent).toContain('unknown or incomplete braces')
  expect(screen.queryByRole('textbox', { name: 'Query 1 for Atlanta' })).toBeNull()
  expect(runButton().disabled).toBe(true)
  expect(state.posts).toHaveLength(0)
})

test('blank or duplicate preview rows and expanded query limits block execution', async () => {
  const { state } = setup(advanced)
  await ready(); setMode('markets'); choose('Atlanta'); typePattern('Apartments in {market}\nTransit in {market}'); preview()
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: ' ' } })
  expect(runButton().disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Query 1 for Atlanta' }), { target: { value: 'Transit in Atlanta' } })
  expect(screen.getByRole('alert').textContent).toContain('Remove duplicate queries')
  expect(runButton().disabled).toBe(true)
  choose('Boston'); typePattern(Array.from({ length: 26 }, (_, index) => `Question ${index} in {market}`).join('\n'))
  expect(screen.getByRole('alert').textContent).toContain('52 queries selected')
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
  expect(runButton().disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Save as a pattern' })).toBeNull()
  expect(state.posts).toHaveLength(0)
})
