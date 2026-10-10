import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { RESEARCH_COPY, ResearchQueriesSection } from '../src/components/project/ResearchQueriesSection.js'
import { DiscoverySection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

/** The Run button says how many answers it will ask for, and only "Run" while there is none. */
const RUN = /^Run(?: \d+ answers?)?$/

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

  fireEvent.click(screen.getByRole('button', { name: 'Find ideas' }))
  await waitFor(() => expect(posts).toContain('/api/v1/projects/demo/discover/run'))

  fireEvent.click(screen.getByRole('tab', { name: 'Research queries' }))
  await screen.findByRole('option', { name: 'OpenAI' })
  fireEvent.change(screen.getByPlaceholderText(RESEARCH_COPY.queryPlaceholder), { target: { value: 'How do I measure AI citations?' } })
  const run = screen.getByRole('button', { name: 'Run 1 answer' }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(posts).toContain('/api/v1/projects/demo/research/batches'))
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
  expect(screen.getByText('Competitors named')).toBeTruthy()
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

function renderSavedResearch(answerText: string, groundingSources: Array<{ uri: string; title?: string }> = [], extra: { run?: Record<string, unknown>; query?: Record<string, unknown>; onReviewForTracking?: (source: unknown) => void } = {}) {
  const run = {
    id: 'saved-run', projectId: 'project_demo', status: 'completed', provider: 'openai',
    requestedModel: 'saved-model', resolvedModel: 'saved-model',
    scope: { kind: 'market', key: 'downtown', label: 'Downtown', planRevision: 7 }, location: null,
    totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null,
    startedAt: '2026-07-23T10:00:00.000Z', finishedAt: '2026-07-23T10:01:00.000Z', createdAt: '2026-07-23T10:00:00.000Z',
    ...extra.run,
  }
  const restoreFetch = mockFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/saved-run') return jsonResponse({ ...run, queries: [{
      id: 'saved-query', position: 0, query: 'Demo building reviews', status: 'completed',
      requestedModel: 'saved-model', resolvedModel: 'saved-model', servedModel: 'served-model', answerText,
      groundingSources, citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
      answerMentioned: true, citationState: 'not-cited', error: null,
      startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
      ...extra.query,
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
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" onReviewForTracking={extra.onReviewForTracking} /></QueryClientProvider>)
}

/** The text a reader can meet, one run of text per line. `textContent` joins neighbours with nothing between them, which hides a whole-word match from `\b`. */
function shownText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const text: Array<string | null> = []
  while (walker.nextNode()) text.push(walker.currentNode.textContent)
  return text.join('\n')
}

test('saved results retain their saved scope independently from the current form', async () => {
  renderSavedResearch('Demo is also the name of a fishing line company.')
  await screen.findByText('Demo is also the name of a fishing line company.')
  const results = within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
  expect(results.getByRole('heading', { level: 3 }).textContent).toBe('Results')
  // One column for the engine that answered, holding both chips.
  expect(results.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Type', 'Status', 'OpenAI'])
  const row = within(results.getByRole('row', { name: /Demo building reviews/ }))
  // No type came with the query. Below sm the Type sits under the query, so the first cell holds it too.
  expect(row.getAllByRole('cell').slice(0, 3).map(cell => cell.textContent)).toEqual(['Demo building reviewsNot set', 'Not set', 'Completed'])
  // The fixture names the company and does not cite it: each chip prints its own field, under N and C.
  const pair = row.getByRole('button', { name: 'OpenAI: Named, Not cited' })
  expect(pair.textContent).toBe('NC')
  // The legend names what the two chips check: the project's name and its domain.
  expect(results.getAllByRole('listitem').slice(0, 4).map(item => item.textContent)).toEqual(['N Names demo', 'C Cites demo.example', 'NNo', 'NNot checked'])
  // What the two signals check is one short label; its sentence is the label's tooltip and part of its name.
  const checked = results.getByRole('button', { name: `${RESEARCH_COPY.methodologySummary}. ${RESEARCH_COPY.methodology}` })
  expect(checked.textContent).toBe('Company names only')
  expect(checked.getAttribute('aria-label')).toMatch(/Neither checks a location's own names\.$/)
  const facts = Object.fromEntries([...document.querySelectorAll('[role="region"] dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]))
  expect(facts).toEqual({ Run: 'saved-ru', Engine: 'OpenAI', Model: 'saved-model', 'Search location': 'No search location', Subject: 'Downtown' })
  // One saved run has no other to choose: no select over the results.
  expect(results.queryByRole('combobox')).toBeNull()
  expect(results.queryByText('current-model')).toBeNull()
  // A query's type is its Type, a run is saved under a Subject, and an engine searches from a Search location.
  expect(shownText()).not.toMatch(/Whole site|Destination|\bClass\b|Property|Template|scoped|Brand-name|Unclassified|\bUnknown\b|Answer engine/i)
})

test('a run from a saved pattern shows its pattern details, and each helper sentence is a tooltip beside its label', async () => {
  const onReviewForTracking = vi.fn()
  renderSavedResearch('Harbor Point has three apartment communities.', [], {
    run: { template: { templateId: 'tpl-best', templateVersion: 'v3', template: 'best apartments in {market}', bindings: { market: 'Harbor Point', location: 'Northbridge' }, output: 'best apartments in Harbor Point' } },
    query: { query: 'best apartments in Harbor Point this year', namedCompetitors: ['Northbridge Flats'], citedCompetitorDomains: ['www.rentals.example'] },
    onReviewForTracking,
  })
  await screen.findByText('Harbor Point has three apartment communities.')
  const results = within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))

  const details = results.getByText(RESEARCH_COPY.templateProvenance)
  expect(details.textContent).toBe('Pattern details')
  expect(details.tagName).toBe('SUMMARY')
  const facts = [...details.closest('details')!.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])
  // The saved pattern, the names it was filled with, and the text it resolved to before any edit.
  expect(facts).toEqual([['Saved pattern', 'best apartments in {market}'], ['Names used', '{market}: Harbor Point · {location}: Northbridge'], ['Resolved text', 'best apartments in Harbor Point']])
  expect(results.getByRole('button', { name: RESEARCH_COPY.resolvedTextHelp })).toBeTruthy()

  // The competitors an answer names sit under their own label, apart from the Named column, which is the project's company.
  expect(results.getByText('Competitors named').nextElementSibling!.textContent).toBe('Northbridge Flats')
  expect(results.getByText('Cited competitor domains').nextElementSibling!.textContent).toBe('rentals.example')
  expect(results.getByRole('button', { name: RESEARCH_COPY.citedCompetitorsHelp })).toBeTruthy()

  expect(results.getByRole('button', { name: RESEARCH_COPY.reviewHelp })).toBeTruthy()
  fireEvent.click(results.getByRole('button', { name: 'Review for tracking' }))
  expect(onReviewForTracking).toHaveBeenCalledWith({ researchRunQueryId: 'saved-query', scope: { kind: 'market', key: 'downtown', label: 'Downtown', planRevision: 7 } })
  expect(shownText()).not.toMatch(/Whole site|Destination|\bClass\b|Property|Template|scoped|Brand-name|Unclassified|\bUnknown\b|Answer engine/i)
})

test('a signal with no value is a dashed chip or a skeleton, and is never printed as a No', async () => {
  const run = {
    id: 'mixed-run', projectId: 'project_demo', status: 'running', provider: 'openai', requestedModel: 'model-a', resolvedModel: 'model-a',
    scope: null, location: null, totalQueries: 6, completedQueries: 3, failedQueries: 1, error: null,
    startedAt: '2026-07-23T10:00:00.000Z', finishedAt: null, createdAt: '2026-07-23T10:00:00.000Z',
  }
  const query = (id: string, status: string, queryClass: string | null, answerMentioned: boolean | null, citationState: string | null, error: string | null = null) => ({
    id, position: 0, query: `${id} query`, queryClass, status, requestedModel: 'model-a', resolvedModel: 'model-a', servedModel: null, answerText: null,
    groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [], answerMentioned, citationState, error,
    startedAt: null, finishedAt: null, createdAt: run.createdAt,
  })
  const restoreFetch = mockFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/mixed-run') return jsonResponse({ ...run, queries: [
      query('waiting', 'running', 'non-brand', null, null),
      query('later', 'queued', 'non-brand', null, null),
      query('failed', 'failed', 'branded', null, null, 'Engine refused the request'),
      query('half', 'completed', 'non-brand', false, null),
      query('named', 'completed', 'non-brand', true, null),
      query('done', 'completed', null, true, 'cited'),
    ] })
    if (path === '/api/v1/projects/demo') return jsonResponse({ id: 'project_demo', name: 'demo', providers: [], providerModels: {}, locations: [], defaultLocation: null })
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const results = within(await screen.findByRole('region', { name: RESEARCH_COPY.resultsTitle }))
  /** A row's Type and Status, then the name of its pair of chips, or null while the pair is still a skeleton. */
  const cells = async (name: RegExp) => {
    const row = within(await results.findByRole('row', { name }))
    return [...row.getAllByRole('cell').slice(1, 3).map(cell => cell.textContent), row.queryByRole('button', { name: /^OpenAI: / })?.getAttribute('aria-label') ?? null]
  }
  // Nothing has been read yet: the card is there and says it is loading.
  expect(results.getByRole('heading').textContent).toBe('Results')
  expect(results.getByRole('status', { name: RESEARCH_COPY.resultsLoading })).toBeTruthy()
  // A query still running or queued has no result to show yet: its chips are a skeleton, with nothing to read as a No.
  expect(await cells(/waiting query/)).toEqual(['Non-brand', 'Running', null])
  expect(results.queryByRole('status', { name: RESEARCH_COPY.resultsLoading })).toBeNull()
  // The run's own status sits beside the heading, in the same capitalized words as every other badge.
  expect(results.getByRole('heading').parentElement!.textContent).toBe('ResultsRunning')
  expect(await cells(/later query/)).toEqual(['Non-brand', 'Queued', null])
  expect(await cells(/failed query/)).toEqual(['Branded', 'Failed', 'OpenAI: Not checked'])
  // Named was checked and is a No; Cited was not checked, which is not a No.
  expect(await cells(/half query/)).toEqual(['Non-brand', 'Completed', 'OpenAI: Not named, Citation not checked'])
  // Named is a Yes and Cited was not checked: the second chip is never read from the first.
  expect(await cells(/named query/)).toEqual(['Non-brand', 'Completed', 'OpenAI: Named, Citation not checked'])
  expect(await cells(/done query/)).toEqual(['Not set', 'Completed', 'OpenAI: Named, Cited'])
  // A dashed chip shows no letter; a lit or a grey one shows N or C.
  const letters = (name: string) => [...results.getByRole('button', { name }).querySelectorAll(':scope > span')].map(chip => chip.querySelector('.invisible') ? '' : chip.textContent)
  expect(letters('OpenAI: Named, Citation not checked')).toEqual(['N', ''])
  expect(letters('OpenAI: Named, Cited')).toEqual(['N', 'C'])

  // The first query is still running and the next has not started: each answer is pending, not missing.
  expect(results.getByText(RESEARCH_COPY.answerPending)).toBeTruthy()
  fireEvent.click(results.getByRole('button', { name: 'later query' }))
  expect(results.getByText(RESEARCH_COPY.answerPending)).toBeTruthy()
  expect(results.queryByText(RESEARCH_COPY.noAnswer)).toBeNull()
  fireEvent.click(results.getByRole('button', { name: 'half query' }))
  expect(results.getByText(RESEARCH_COPY.noAnswer)).toBeTruthy()
  expect(results.queryByText(RESEARCH_COPY.answerPending)).toBeNull()
  fireEvent.click(results.getByRole('button', { name: 'failed query' }))
  expect(results.getByText('Engine refused the request')).toBeTruthy()
})

test('with no engine configured the form renders and Run stays off beside a No engine key note', async () => {
  const posts: string[] = []
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (init?.method === 'POST') { posts.push(path); return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Must not run' } }, 500) }
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo') return jsonResponse({ id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null })
    // A browser engine is configured, and research needs an API engine.
    if (path === '/api/v1/settings') return jsonResponse({
      providers: [{ name: 'cdp', displayName: 'Browser', configured: true }],
      providerCatalog: [{ name: 'cdp', displayName: 'Browser', mode: 'browser', modelConfigurable: false, defaultModel: 'browser', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const note = await screen.findByRole('button', { name: `${RESEARCH_COPY.noEngineKey}. ${RESEARCH_COPY.noEngineKeyDetail}` })
  expect(note.textContent).toBe('No engine key')
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'Which platform fits?' } })
  const run = screen.getByRole('button', { name: RUN }) as HTMLButtonElement
  expect(run.disabled).toBe(true)
  fireEvent.click(run)
  // Nothing beside Run names an engine or a model, because none is chosen. The reason Run is off sits in the same footer.
  expect(run.parentElement!.textContent).toBe('Run 1 answer')
  expect(run.parentElement!.parentElement!.contains(note)).toBe(true)
  // With no run saved there is no Results card: the Past research row says there is none.
  expect(screen.getByText(RESEARCH_COPY.emptyHistory)).toBeTruthy()
  expect(screen.queryByRole('region', { name: RESEARCH_COPY.resultsTitle })).toBeNull()
  expect(posts).toEqual([])
})

test('saved answers render readable Markdown with safe links and no active HTML or remote images', async () => {
  renderSavedResearch('[Source](https://example.com/source)\n\n[Unsafe](javascript:alert%281%29)\n\n<img src="https://invalid.example/pixel" onerror="alert(1)">\n\n![Remote image](https://invalid.example/image.png)\n\n- First choice\n- Second choice')
  const source = await screen.findByRole('link', { name: 'Source' })
  expect(source.getAttribute('href')).toBe('https://example.com/source')
  expect(source.getAttribute('target')).toBe('_blank')
  expect(source.getAttribute('rel')).toBe('noopener noreferrer')
  const results = within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
  expect(results.getByText('Unsafe')).toBeTruthy()
  expect(results.queryByRole('link', { name: 'Unsafe' })).toBeNull()
  expect(results.queryByRole('img')).toBeNull()
  // The answer's own list, apart from the legend's.
  expect(within(results.getByText('First choice').closest('ul')!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['First choice', 'Second choice'])
  expect(results.queryByText('[Source](https://example.com/source)')).toBeNull()
})

test('saved research sources show their titles and full URLs', async () => {
  const url = 'https://hotel.example/rooms/ocean-view?guests=2#availability'
  renderSavedResearch('Saved hotel recommendation.', [{ uri: url, title: 'Rooms and rates' }])
  await screen.findByText('Saved hotel recommendation.')
  const results = within(screen.getByRole('region', { name: RESEARCH_COPY.resultsTitle }))
  expect(results.getByText('Rooms and rates')).toBeTruthy()
  expect(results.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
})


test('failed engine and search location reads show one Could not load note, and Retry reads only what failed', async () => {
  const reads = { settings: 0, project: 0 }
  const fail = { settings: true, project: true }
  const unavailable = () => jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Temporary read failure' } }, 503)
  const restoreFetch = mockFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [] })
    if (path === '/api/v1/projects/demo') {
      reads.project += 1
      return fail.project ? unavailable() : jsonResponse({ id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null })
    }
    if (path === '/api/v1/settings') {
      reads.settings += 1
      return fail.settings ? unavailable() : jsonResponse({
        providers: [{ name: 'openai', displayName: 'OpenAI', configured: true }],
        providerCatalog: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-test', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Model ID' }],
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>)

  const both = await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. The engines and search locations did not load.` })
  expect(both.textContent).toBe('Could not load')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  // An engine list that did not load is not an empty one.
  expect(screen.queryByRole('button', { name: new RegExp(`^${RESEARCH_COPY.noEngineKey}`) })).toBeNull()
  expect(reads).toEqual({ settings: 1, project: 1 })

  fail.project = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry engines and search locations' }))
  await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. The engines did not load.` })
  expect(reads).toEqual({ settings: 2, project: 2 })

  fail.settings = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry engines' }))
  await screen.findByRole('option', { name: 'OpenAI' })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toEqual({ settings: 3, project: 2 })

  // A later project read fails on its own: the note names search locations, and Retry reads the project only.
  fail.project = true
  await queryClient.refetchQueries({ predicate: query => (query.queryKey[0] as { _id?: string })._id === 'getApiV1ProjectsByName' })
  const project = await screen.findByRole('button', { name: `${RESEARCH_COPY.loadError}. The search locations did not load.` })
  expect(project.textContent).toBe('Could not load')
  expect(reads).toEqual({ settings: 3, project: 3 })
  fail.project = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry search locations' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(reads).toEqual({ settings: 3, project: 4 })
})

test.each([true, false])('key research uses server capability (%s) and safe providers without general write access', async canRun => {
  const bodies: unknown[] = []
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs' || path === '/api/v1/projects/demo/research/batches') {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)))
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Test failure' } }, 500)
      }
      return jsonResponse({ runs: [], access: { canRun, dailyRunLimit: canRun ? 7 : null }, providers: [
        { name: 'openai', displayName: 'OpenAI', modelConfigurable: true, defaultModel: 'gpt-test', knownModels: [] },
      ] })
    }
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null,
    })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={null} apiKey={{ id: 'research-key', scopes: ['read', 'research.run'], projectId: 'project_demo', readOnly: false }}>
    <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>
  </AccountProvider>)
  // What this key may do is known once past research has loaded. Until then the form does not call it view only.
  expect(screen.getByRole('status', { name: 'Loading past research' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: new RegExp(`^${RESEARCH_COPY.viewOnly}`) })).toBeNull()
  await screen.findByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · gpt-test` })
  fireEvent.change(screen.getByRole('textbox', { name: /^Queries/ }), { target: { value: 'Which platform fits?' } })
  if (canRun) {
    const button = screen.getByRole('button', { name: RUN }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: /^7 runs per day\. Up to 7 research runs per project per day\./ }).textContent).toBe('7 runs per day')
    await waitFor(() => expect(bodies).toHaveLength(1))
  } else {
    // Without the capability there is no Run button to press, only the reason in its place.
    expect(screen.queryByRole('button', { name: RUN })).toBeNull()
    expect(screen.getByRole('button', { name: `${RESEARCH_COPY.viewOnly}. ${RESEARCH_COPY.viewOnlyDetail}` }).textContent).toBe('View only')
    expect(bodies).toHaveLength(0)
  }
  expect(screen.queryByRole('button', { name: /Review for tracking/ })).toBeNull()
})

test('a limited account with no engine is told to ask its team, and the Model list shows no half-filled choice', async () => {
  const restore = mockFetch((url, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [], access: { canRun: true, dailyRunLimit: 7 }, providers: [] })
    if (path === '/api/v1/projects/demo') return jsonResponse({ id: 'project_demo', name: 'demo', providers: ['openai'], providerModels: {}, locations: [], defaultLocation: null })
    throw new Error(`Unexpected request: ${url}`)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<AccountProvider account={null} apiKey={{ id: 'research-key', scopes: ['read', 'research.run'], projectId: 'project_demo', readOnly: false }}>
    <QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" /></QueryClientProvider>
  </AccountProvider>)

  // This account cannot open Settings, so the sentence does not send it there.
  const note = await screen.findByRole('button', { name: `${RESEARCH_COPY.noEngineKey}. ${RESEARCH_COPY.noEngineDetail}` })
  expect(note.textContent).toBe('No engine key')
  expect([...(screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).options].map(option => option.text)).toEqual(['Choose an engine'])
  expect((screen.getByRole('button', { name: RUN }) as HTMLButtonElement).disabled).toBe(true)
})

test('viewer research follows the visibility model, offers discovered alternatives, and resets on engine change', async () => {
  const bodies: Array<Record<string, unknown>> = []
  let availableModels = [{ id: 'gpt-next', displayName: 'New GPT' }]
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/research/runs' || path === '/api/v1/projects/demo/research/batches') {
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
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'best apartments' } })
  const submit = async () => {
    const button = screen.getByRole('button', { name: RUN }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
  }
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toMatchObject({ runs: [{ provider: 'openai', model: 'chat-latest' }] })
  fireEvent.change(model, { target: { value: 'gpt-next' } })
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]).toMatchObject({ runs: [{ provider: 'openai', model: 'gpt-next' }] })
  availableModels = []
  await queryClient.refetchQueries()
  expect(model.value).toBe('gpt-next')
  expect(await screen.findByRole('option', { name: 'gpt-next' })).toBeTruthy()
  expect(model.value).toBe('gpt-next')
  fireEvent.change(screen.getByRole('combobox', { name: 'Engine' }), { target: { value: 'claude' } })
  expect(model.value).toBe('')
  expect(screen.getByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · claude-sonnet-new` })).toBeTruthy()
  await submit()
  await waitFor(() => expect(bodies).toHaveLength(3))
  expect(bodies[2]).toMatchObject({ runs: [{ provider: 'claude', model: 'claude-sonnet-new' }] })
})

test('public demo reads saved research without settings or run controls', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const requests: string[] = []
  const run = {
    id: 'demo-run', projectId: 'project_demo', status: 'completed', provider: 'openai',
    requestedModel: 'gpt-5-mini', resolvedModel: 'gpt-5-mini', location: null,
    totalQueries: 1, completedQueries: 1, failedQueries: 0, error: null,
    startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:01:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
  }
  const restoreFetch = mockFetch((url) => {
    const path = new URL(url).pathname
    requests.push(path)
    if (path === '/api/v1/projects/demo/research/runs') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/demo-run') return jsonResponse({ ...run, queries: [{
      id: 'demo-query', position: 0, query: 'How can a retailer improve local visibility?', status: 'completed',
      requestedModel: 'gpt-5-mini', resolvedModel: 'gpt-5-mini', servedModel: 'gpt-5-mini', answerText: 'Saved research answer.',
      groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [],
      answerMentioned: true, citationState: 'cited', error: null,
      startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
    }] })
    if (path === '/api/v1/projects/demo') return jsonResponse({
      id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
      country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
      locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
    })
    if (path === '/api/v1/settings') return jsonResponse({ error: { code: 'FORBIDDEN' } }, 403)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())

  render(<QueryClientProvider client={queryClient}><ResearchQueriesSection projectName="demo" onReviewForTracking={() => {}} /></QueryClientProvider>)

  await screen.findByText('Saved research answer.')
  expect(requests).not.toContain('/api/v1/settings')
  expect(screen.getByRole('button', { name: `${RESEARCH_COPY.demo}. ${RESEARCH_COPY.demoDetail}` }).textContent).toBe('Saved results only')
  expect(screen.queryByRole('textbox', { name: 'Queries' })).toBeNull()
  // No form at all: nothing to start from and nothing to run.
  expect(screen.queryByRole('radiogroup', { name: 'Start from' })).toBeNull()
  expect(screen.queryByRole('button', { name: RUN })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()
})
