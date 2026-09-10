import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { type ResearchScopeOption, type ResearchTemplateOption } from '../src/components/project/ResearchQueriesSection.js'
import { RESEARCH_COPY, ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { DiscoverySection, QueriesSection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

function installApiMock(posts?: string[], bodies?: Array<Record<string, unknown>>) {
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname

    if (init?.method === 'POST' && posts) {
      posts.push(path)
      bodies?.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Test provider unavailable' } }, 503)
    }

    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo/query-tracking') return jsonResponse({ mode: 'simple', workspaceVersion: 'qtw_demo', active: null, targets: [], groups: [], markets: [], tracked: [], savedSources: { research: [], discovery: [] }, defaultContexts: [] })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: null,
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }],
        providerCatalog: [{
          name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini',
          knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', tier: 'fast' }],
          modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.',
        }],
        google: { configured: false }, bing: { configured: false },
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
}

test.each([false, true])('managedSweeps=%s preserves client Discovery and Research run access', async (managedSweeps) => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps } }
  const posts: string[] = []
  installApiMock(posts)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(
    <AccountProvider account={null} apiKey={{ id: 'client-key', scopes: ['*'], projectId: 'project_demo', readOnly: false }}>
      <QueryClientProvider client={queryClient}><DiscoverySection projectName="demo" /></QueryClientProvider>
    </AccountProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: /Find queries/ }))
  await waitFor(() => expect(posts).toContain('/api/v1/projects/demo/discover/run'))

  fireEvent.click(screen.getByRole('tab', { name: 'Research queries' }))
  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder), { target: { value: 'How do I measure AI citations?' } })
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(posts).toContain('/api/v1/projects/demo/research/runs'))
})

const marketTemplate: ResearchTemplateOption = {
  id: 'configured-market', version: '1', label: 'Local services',
  pattern: 'Find services in {market}', variables: ['market'],
}
const marketScope: ResearchScopeOption = { kind: 'market', key: 'downtown', label: 'Downtown', planRevision: 7, expectedPlanRevision: 7 }

function setupTemplateResearch(templates: ResearchTemplateOption[] = [marketTemplate], initialScope: ResearchScopeOption | null = marketScope) {
  const bodies: Array<Record<string, unknown>> = []
  installApiMock([], bodies)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const section = (scope: ResearchScopeOption | null) => (
    <AccountProvider account={null} apiKey={{ id: 'client-key', scopes: ['*'], projectId: 'project_demo', readOnly: false }}>
      <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" templates={templates} selectedScope={scope} /></QueryClientProvider>
    </AccountProvider>
  )
  const rendered = render(section(initialScope))
  const selectTemplate = (template: ResearchTemplateOption) => fireEvent.change(screen.getByLabelText(RESEARCH_COPY.templateLabel), { target: { value: `${template.id}:${template.version}` } })
  return { bodies, selectTemplate, changeScope: (scope: ResearchScopeOption | null) => rendered.rerender(section(scope)) }
}

test.each(['market', 'property'] as const)('offers applicable query patterns and starts with direct entry for a %s', (kind) => {
  const template = { ...marketTemplate, pattern: `Find services at {${kind}}`, variables: [kind] }
  setupTemplateResearch([template], { ...marketScope, kind })
  const selector = screen.getByLabelText(RESEARCH_COPY.templateLabel) as HTMLSelectElement
  expect(selector.value).toBe('custom')
  expect(Array.from(selector.options, option => option.text)).toEqual([RESEARCH_COPY.customQuery, template.label])
  expect((screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement).value).toBe('')
})

test('shows direct query entry when no saved query pattern applies', () => {
  setupTemplateResearch([marketTemplate], null)

  expect(screen.queryByLabelText(RESEARCH_COPY.templateLabel)).toBeNull()
  expect(screen.getByText(RESEARCH_COPY.queryGuidance)).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Research queries' }).getAttribute('aria-describedby'))
    .toBe('research-query-guidance research-query-count')
})

test('expands a configured template and submits distinct questions with the first exact text preserved', async () => {
  const { bodies, selectTemplate } = setupTemplateResearch()
  selectTemplate(marketTemplate)
  const editor = screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement
  expect(editor.value).toBe('Find services in Downtown')
  const exactQuestion = '  Which local services are open today?  '
  const secondQuestion = 'How do I book a visit?'
  fireEvent.change(editor, { target: { value: [exactQuestion, exactQuestion.trim().toUpperCase(), '', secondQuestion].join('\n') } })
  expect(screen.getByText(`${2}${RESEARCH_COPY.queryCountLimit}`)).toBeTruthy()
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toMatchObject({
    queries: [exactQuestion, secondQuestion], location: null,
    scope: { kind: marketScope.kind, key: marketScope.key, expectedPlanRevision: marketScope.expectedPlanRevision },
    template: { templateId: marketTemplate.id, templateVersion: marketTemplate.version },
  })
})

test('expands only declared variables, including on template refresh and destination changes', () => {
  const template = { ...marketTemplate, pattern: 'Compare {market} with {submarket}' }
  const { selectTemplate, changeScope } = setupTemplateResearch([template])
  selectTemplate(template)
  const editor = screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement
  expect(editor.value).toBe('Compare Downtown with {submarket}')
  changeScope({ ...marketScope, key: 'uptown', label: 'Uptown' })
  expect(editor.value).toBe('Compare Uptown with {submarket}')
  changeScope({ ...marketScope, key: 'uptown', label: 'Midtown', planRevision: 8, expectedPlanRevision: 8 })
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.refreshTemplate }))
  expect(editor.value).toBe('Compare Midtown with {submarket}')
})

test('blocks a stale template expansion and preserves edits until an explicit refresh', async () => {
  const { selectTemplate, changeScope, bodies } = setupTemplateResearch()
  selectTemplate(marketTemplate)
  const editor = screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement
  const editedQuestion = 'My edited local-services query'
  fireEvent.change(editor, { target: { value: editedQuestion } })
  changeScope({ ...marketScope, label: 'Uptown', planRevision: 8, expectedPlanRevision: 8 })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(editor.value).toBe(editedQuestion)
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: RESEARCH_COPY.refreshTemplate }))
  expect(editor.value).toBe('Find services in Uptown')
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toMatchObject({ queries: [editor.value], scope: { expectedPlanRevision: 8 } })
})

test('clears a variable-free template on Whole site and keeps the edited query runnable', async () => {
  const template = { ...marketTemplate, pattern: 'Find local services', variables: [] }
  const { selectTemplate, changeScope, bodies } = setupTemplateResearch([template])
  selectTemplate(template)
  const editor = screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement
  const editedQuestion = '  Find services open on weekends  '
  fireEvent.change(editor, { target: { value: editedQuestion } })
  changeScope(null)
  expect(screen.queryByLabelText(RESEARCH_COPY.templateLabel)).toBeNull()
  expect(editor.value).toBe(editedQuestion)
  expect(screen.queryByRole('alert')).toBeNull()
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]?.queries).toEqual([editedQuestion])
  expect(bodies[0]).not.toHaveProperty('scope')
  expect(bodies[0]).not.toHaveProperty('template')
})

test('keeps a group selection browse-only and never injects it into an exact research question', async () => {
  const state = setupGroupResearch()
  const textArea = await screen.findByPlaceholderText(RESEARCH_COPY.queryPlaceholder) as HTMLTextAreaElement
  expect(textArea.value).toBe('')
  fireEvent.change(textArea, { target: { value: 'A freeform question' } })
  expect((await screen.findByRole('alert')).textContent).toContain(RESEARCH_COPY.scopeError)
  expect((screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement).disabled).toBe(true)
  expect(state.posts).toEqual([])
})

function setupGroupResearch() {
  const posts: string[] = []
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (init?.method === 'POST') posts.push(path)
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo') return jsonResponse({ id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null })
    if (path === '/api/v1/settings') return jsonResponse({ providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }], providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' }] })
    throw new Error(`Unexpected request: ${path}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={null} apiKey={{ id: 'client-key', scopes: ['*'], projectId: 'project_demo', readOnly: false }}><QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" scopeOptions={[{ id: 'regional', label: 'Regional comparison', kind: 'group', targetCount: 1 }]} selectedScope={null} scopeError /></QueryClientProvider></AccountProvider>)
  return { posts }
}

test('keeps a whole-site freeform question runnable when hierarchy loading fails', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/query-tracking') return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Hierarchy unavailable' } }, 500)
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Templates unavailable' } }, 500)
    if (path === '/api/v1/projects/demo/research/runs') {
      if (method === 'POST') {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Test provider unavailable' } }, 503)
      }
      return jsonResponse({ runs: [] })
    }
    if (path === '/api/v1/projects/demo') return jsonResponse({ id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null })
    if (path === '/api/v1/settings') return jsonResponse({ providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'gpt-5-mini' }], providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use an OpenAI model ID.' }] })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={null} apiKey={{ id: 'client-key', scopes: ['*'], projectId: 'project_demo', readOnly: false }}><QueryClientProvider client={queryClient}><QueriesSection projectName="demo" queryWorkspace="research" researchMode="test" selection={{ measurementScope: 'project', queryClass: 'all' }} /></QueryClientProvider></AccountProvider>)

  await screen.findByRole('option', { name: 'OpenAI' })
  const exactQuestion = '  Freeform research without hierarchy  '
  fireEvent.change(screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder), { target: { value: exactQuestion } })
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toMatchObject({ queries: [exactQuestion], location: null })
  expect(bodies[0]).not.toHaveProperty('scope')
  expect(bodies[0]).not.toHaveProperty('template')
})

test('switches to research, preserves final query lines, gates exact model choice, and states that research is not tracked', async () => {
  installApiMock()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <DiscoverySection projectName="demo" />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Discover or research queries')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Research queries' }))

  const model = await screen.findByLabelText(/Exact model/)
  expect((model as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(RESEARCH_COPY.savedNote)).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder), { target: { value: 'Best AEO platform\nbest aeo platform\nHow do I measure AI citations?\n' } })
  expect(screen.getByText(`${2}${RESEARCH_COPY.queryCountLimit}`)).toBeTruthy()

  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByLabelText('Answer engine'), { target: { value: 'openai' } })
  expect((screen.getByLabelText(/Exact model/) as HTMLInputElement).disabled).toBe(false)
})

test('resets the selected query when switching research history batches', async () => {
  const run = (id: string, model: string) => ({
    id, projectId: 'project_demo', status: 'completed', provider: 'openai', requestedModel: model, resolvedModel: model,
    location: null, totalQueries: 2, completedQueries: 2, failedQueries: 0, error: null,
    startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:01:00.000Z', createdAt: id === 'run-a' ? '2026-07-23T10:00:00.000Z' : '2026-07-22T10:00:00.000Z',
  })
  const query = (id: string, text: string) => ({
    id, position: 0, query: text, status: 'completed', requestedModel: null, resolvedModel: 'gpt-5-a', servedModel: 'gpt-5-a',
    answerText: `${text} answer`, groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: ['Rival'], citedCompetitorDomains: ['rival.example'], answerMentioned: false,
    citationState: 'not-cited', error: null, startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:00:01.000Z', createdAt: '2026-07-23T10:00:00.000Z',
  })
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/discover/sessions') return jsonResponse([])
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run('run-a', 'gpt-5-a'), run('run-b', 'gpt-5-b')] })
    if (path === '/api/v1/projects/demo/research/runs/run-a') return jsonResponse({ ...run('run-a', 'gpt-5-a'), queries: [query('query-a-first', 'First run first query'), query('query-shared', 'First run selected query')] })
    // Reusing the selected id makes this assert the state reset itself, rather than merely relying on the display fallback.
    if (path === '/api/v1/projects/demo/research/runs/run-b') return jsonResponse({ ...run('run-b', 'gpt-5-b'), queries: [query('query-b-first', 'Second run first query'), query('query-shared', 'Second run stale query')] })
    if (path === '/api/v1/projects/demo') {
      return jsonResponse({
        id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
        country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
        locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      })
    }
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: false }, bing: { configured: false } })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(<QueryClientProvider client={queryClient}><DiscoverySection projectName="demo" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('tab', { name: 'Research queries' }))

  await screen.findByText('First run first query answer')
  expect(screen.getByText('Named in answer')).toBeTruthy()
  expect(screen.getByText('Rival')).toBeTruthy()
  expect(screen.getByText('Cited competitor domains')).toBeTruthy()
  expect(screen.getByText('rival.example')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'First run selected query' }))
  expect(await screen.findByText('First run selected query answer')).toBeTruthy()

  const secondRunButton = screen.getAllByRole('button').find(button => button.closest('tr')?.textContent?.includes('gpt-5-b'))
  expect(secondRunButton).toBeTruthy()
  fireEvent.click(secondRunButton!)

  expect(await screen.findByText('Second run first query answer')).toBeTruthy()
})

function renderSavedResearch(answerText: string) {
  const run = {
    id: 'saved-run', projectId: 'project_demo', status: 'completed', provider: 'openai',
    requestedModel: 'saved-model', resolvedModel: 'saved-model',
    scope: { kind: 'market', key: 'downtown', label: 'Downtown', planRevision: 7 }, location: null,
    totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null,
    startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:01:00.000Z', createdAt: '2026-07-23T10:00:00.000Z',
  }
  const restoreFetch = mockFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/saved-run') return jsonResponse({ ...run, queries: [{
      id: 'saved-query', position: 0, query: 'Demo building reviews', status: 'completed',
      requestedModel: 'saved-model', resolvedModel: 'saved-model', servedModel: 'served-model', answerText,
      groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
      answerMentioned: true, citationState: 'not-cited', error: null,
      startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
    }] })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
      locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({
      providers: [{ name: 'openai', displayName: 'OpenAI', configured: true, defaultModel: 'current-model' }],
      providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true,
        defaultModel: 'current-model', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)
}

test('saved results retain their saved scope independently from the current form', async () => {
  renderSavedResearch('Demo is also the name of a fishing line company.')
  await screen.findByText('Demo is also the name of a fishing line company.')
  const results = within(screen.getByRole('region', { name: 'Research results' }))
  expect(results.getByRole('columnheader', { name: 'Brand-name match' })).toBeTruthy()
  expect(results.getByRole('columnheader', { name: 'Project domain cited' })).toBeTruthy()
  expect(results.getByText(RESEARCH_COPY.methodologySummary)).toBeTruthy()
  expect(results.getByText(RESEARCH_COPY.methodology)).toBeTruthy()
  expect(results.getByText('Matched')).toBeTruthy()
  expect(results.getByText('Not cited')).toBeTruthy()
  expect(results.getByText('openai')).toBeTruthy()
  expect(results.getByText('saved-model')).toBeTruthy()
  expect(results.getByText('Downtown')).toBeTruthy()
  expect(results.getByText('No location')).toBeTruthy()
  expect(results.queryByText('current-model')).toBeNull()
})

test('saved answers render readable Markdown with safe links and no active HTML or remote images', async () => {
  renderSavedResearch('[Source](https://example.com/source)\n\n[Unsafe](javascript:alert%281%29)\n\n<img src="https://invalid.example/pixel" onerror="alert(1)">\n\n![Remote image](https://invalid.example/image.png)\n\n- First choice\n- Second choice')
  const source = await screen.findByRole('link', { name: 'Source' })
  expect(source.getAttribute('href')).toBe('https://example.com/source')
  expect(source.getAttribute('target')).toBe('_blank')
  expect(source.getAttribute('rel')).toBe('noopener noreferrer')
  const results = within(screen.getByRole('region', { name: 'Research results' }))
  expect(results.getByText('Unsafe')).toBeTruthy()
  expect(results.queryByRole('link', { name: 'Unsafe' })).toBeNull()
  expect(results.queryByRole('img')).toBeNull()
  expect(results.getAllByRole('listitem')).toHaveLength(2)
  expect(results.queryByText('[Source](https://example.com/source)')).toBeNull()
})


test('viewer research follows the visibility model, offers discovered alternatives, and resets on engine change', async () => {
  const bodies: Array<Record<string, unknown>> = []
  let availableModels = [{ id: 'gpt-next', displayName: 'New GPT' }]
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Test failure' } }, 500)
      }
      return jsonResponse({ runs: [], providers: [
        { name: 'openai', displayName: 'OpenAI', modelConfigurable: true, defaultModel: 'chat-latest', knownModels: availableModels },
        { name: 'claude', displayName: 'Claude', modelConfigurable: true, defaultModel: 'claude-sonnet-new', knownModels: [] },
      ] })
    }
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', providers: ['openai', 'claude'], providerModels: {}, locations: [], defaultLocation: null,
    })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={{ name: 'analyst', role: 'viewer' }}>
    <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" viewerResearchConfig={{ allowViewers: true, viewerDailyRunLimit: 20 }} /></QueryClientProvider>
  </AccountProvider>)
  await screen.findByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · chat-latest` })
  const model = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement
  expect(model.value).toBe('')
  fireEvent.change(screen.getByRole('textbox', { name: 'Research queries' }), { target: { value: 'best apartments' } })
  const submit = async () => {
    const button = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
  }
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toMatchObject({ provider: 'openai', model: 'chat-latest' })
  fireEvent.change(model, { target: { value: 'gpt-next' } })
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]).toMatchObject({ provider: 'openai', model: 'gpt-next' })
  availableModels = []
  await queryClient.refetchQueries()
  expect(model.value).toBe('gpt-next')
  expect(await screen.findByRole('option', { name: 'gpt-next' })).toBeTruthy()
  expect(model.value).toBe('gpt-next')
  fireEvent.change(screen.getByRole('combobox', { name: 'Answer engine' }), { target: { value: 'claude' } })
  expect(model.value).toBe('')
  expect(screen.getByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · claude-sonnet-new` })).toBeTruthy()
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(3))
  expect(bodies[2]).toMatchObject({ provider: 'claude', model: 'claude-sonnet-new' })
})
