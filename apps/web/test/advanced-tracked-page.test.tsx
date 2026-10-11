import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { queryTrackingResultsResponseSchema, queryTrackingWorkspaceResponseSchema } from '@ainyc/canonry-contracts'
import type { QueryClass, QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'

import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { formatObservedInstantMonthDay, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { VISIBILITY_TOOLBAR_COPY } from '../src/components/project/VisibilityTrendSection.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { compileAppStyles, compiledDeclarations, parseCompiledCss } from './compiled-app-css.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { addButton, chooseRowAction, expectNoSentence, noteButton, openRowSheet, preview, renderViewerWorkspace, renderWorkspace } from './support/query-tracking-fixtures.js'

// The assembled Tracked page of an Advanced project, through the Queries section: one workspace read, one
// results read, and the strip, toolbar, table, bulk bar and sheets over them.

// The strip dates a sweep against today's year, so today is fixed. Only the clock is faked: nothing here waits on a fake timer.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetToasts()
  delete window.__CANONRY_CONFIG__
})

type Assignment = QueryTrackingTrackedRow['assignments'][number]

const context = {
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-5', gemini: 'gemini-3' },
  location: { label: 'Lakeshore', city: 'Lakeshore', region: 'IL', country: 'US' },
}
const pairing = (targetKey: string, marketKeys: string[], queryClass: QueryClass | null, groupKeys: string[] = []): Assignment =>
  ({ targetKey, groupKeys, marketKeys, queryClass, classificationSource: 'server', contexts: [context] }) as Assignment
function tracked(queryId: string, queryText: string, focus: QueryTrackingTrackedRow['focus'], assignments: Assignment[], overrides: Record<string, unknown> = {}) {
  return {
    queryId, queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
    state: 'tracked', lastMeasuredAt: '2026-10-07T12:10:00.000Z',
    assignments, focus,
    queryClasses: [...new Set(assignments.map(assignment => assignment.queryClass).filter((value): value is QueryClass => value !== null))].sort(),
    ...overrides,
  }
}

const UPTOWN_BEST = 'best apartments uptown'
const UPTOWN_PETS = 'pet friendly apartments uptown'
const DOWNTOWN = 'best apartments downtown'
const HARBOR = 'Harbor Point reviews'
const PIER_NEW = 'Pier House reviews'
const PICKED = 'apartments with a pool'
const OLD_TOWN = 'apartments in the old town'
const CAMPUS = 'studio apartments near campus'
const uptown = () => ['harbor', 'river', 'summit'].map(key => pairing(key, ['uptown'], 'non-brand', key === 'summit' ? [] : ['north']))

/**
 * Four locations, two markets and one group, with eight queries: three for a market, two for a location
 * (one added since the last sweep), one hand-picked and asked both ways, and two asked nowhere.
 * No number of the strip can be worked out from these rows: the server's totals are a larger portfolio's.
 */
function portfolio(overrides: Record<string, unknown> = {}) {
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
    defaultContexts: [context],
    targets: [
      { stableKey: 'harbor', label: 'Harbor Point', marketKeys: ['uptown', 'downtown'], counts: { propertyQueries: 4, marketQueries: 11, customQueries: 2, answersPerSweep: 51 } },
      { stableKey: 'river', label: 'River Point' },
      { stableKey: 'summit', label: 'Summit Lofts' },
      { stableKey: 'pier', label: 'Pier House' },
    ],
    groups: [{ stableKey: 'north', label: 'North', targetKeys: ['harbor', 'river'], counts: { queries: 19, markets: 1, answersPerSweep: 114 } }],
    markets: [
      { stableKey: 'uptown', label: 'Uptown', usageEdges: [], targetKeys: ['harbor', 'river', 'summit'], counts: { marketQueries: 7, propertyQueries: 9, answersPerSweep: 96 } },
      { stableKey: 'downtown', label: 'Downtown, Lakeshore', usageEdges: [], targetKeys: ['harbor'], counts: { marketQueries: 3, propertyQueries: 4, answersPerSweep: 14 } },
      { stableKey: 'lakeview', label: 'Lakeview', usageEdges: [], targetKeys: [], counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
    ],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 4 },
      { id: 'north', label: 'North', kind: 'group', targetCount: 2 },
      { id: 'uptown', label: 'Uptown', kind: 'market', targetCount: 3 },
      { id: 'downtown', label: 'Downtown', kind: 'market', targetCount: 1 },
      ...['harbor', 'river', 'summit', 'pier'].map(id => ({ id, label: id, kind: 'property', targetCount: 1 })),
    ],
    tracked: [
      tracked('q-uptown-best', UPTOWN_BEST, { kind: 'market', key: 'uptown' }, uptown(), {
        provenance: { source: 'template', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z', template: { templateId: 'template-best', templateVersion: '1', template: 'best apartments {market}', bindings: { market: 'uptown' }, output: UPTOWN_BEST } },
      }),
      tracked('q-uptown-pets', UPTOWN_PETS, { kind: 'market', key: 'uptown' }, uptown()),
      tracked('q-downtown', DOWNTOWN, { kind: 'market', key: 'downtown' }, [pairing('harbor', ['downtown'], 'non-brand', ['north'])]),
      tracked('q-harbor', HARBOR, { kind: 'property', key: 'harbor' }, [pairing('harbor', ['uptown', 'downtown'], 'branded', ['north'])]),
      // Added after the last sweep, so it waits for its first answers.
      tracked('q-pier', PIER_NEW, { kind: 'property', key: 'pier' }, [pairing('pier', [], 'branded')], { state: 'awaiting-sweep', lastMeasuredAt: null }),
      tracked('q-picked', PICKED, { kind: 'custom' }, [pairing('harbor', ['uptown'], 'branded', ['north']), pairing('pier', [], 'non-brand')]),
      tracked('q-old', OLD_TOWN, { kind: 'not-asked' }, [], { state: 'awaiting-sweep', lastMeasuredAt: null, provenance: null }),
      tracked('q-campus', CAMPUS, { kind: 'not-asked' }, [], { state: 'awaiting-sweep', lastMeasuredAt: null }),
    ],
    savedSources: { research: [], discovery: [] },
    summary: {
      asked: 41, notAsked: 7,
      byClass: { branded: 12, nonBrand: 27, mixed: 1, unknown: 1 },
      byFocus: { market: 24, property: 14, company: 0, custom: 3 },
      assignments: { total: 133, branded: 20, nonBrand: 110, unknown: 3 },
      answersPerSweep: 300,
      structure: { targets: 4, markets: 3, groups: 1, topLevelGroups: 1, competitors: 0 },
    },
    limits: { queries: { current: 41, next: 41, max: 1000, left: { current: 957, next: 957 } } },
    ...overrides,
  })
}

const engine = (provider: string, mentioned: boolean | null, cited: boolean | null) =>
  ({ provider, expectedAnswers: 3, answers: 3, mentionedAnswers: mentioned ? 2 : 0, citedAnswers: cited ? 1 : 0, uncheckedSourceAnswers: 0, mentioned, cited })
const resultRow = (queryId: string, queryText: string, queryClass: string, engines: ReturnType<typeof engine>[]) => ({ queryId, queryText, queryClass, engines })
const RESULT_ROWS = [
  resultRow('q-uptown-best', UPTOWN_BEST, 'non-brand', [engine('gemini', false, false), engine('openai', true, false), engine('perplexity', true, true)]),
  resultRow('q-uptown-pets', UPTOWN_PETS, 'non-brand', [engine('gemini', true, true), engine('openai', true, true), engine('perplexity', true, true)]),
  resultRow('q-downtown', DOWNTOWN, 'non-brand', [engine('gemini', true, true), engine('openai', false, false)]),
  resultRow('q-harbor', HARBOR, 'branded', [engine('gemini', true, true), engine('openai', true, true)]),
  resultRow('q-picked', PICKED, 'branded', [engine('gemini', true, false), engine('openai', true, true)]),
  resultRow('q-picked', PICKED, 'non-brand', [engine('gemini', false, false), engine('openai', true, null)]),
]
const SWEPT_AT = '2026-10-07T12:20:00.000Z'
const CHANGED_AT = '2026-10-09T12:00:00.000Z'
/** A moment's day as the page prints it, in whatever timezone the test runs in: "Oct 7" in most. */
const day = (instant: string) => formatObservedInstantMonthDay(observedInstant(instant))
/** The sweep of Oct 7 asked a third engine the project no longer lists. It measured every row but the one added since. */
function sweep(overrides: Record<string, unknown> = {}) {
  return queryTrackingResultsResponseSchema.parse({
    mode: 'advanced',
    scope: { kind: 'project', key: null },
    run: { id: 'run-1', createdAt: '2026-10-07T12:00:00.000Z', completedAt: SWEPT_AT, status: 'completed', revision: 4, matchesCurrentTracking: true },
    engines: ['gemini', 'openai', 'perplexity'],
    rows: RESULT_ROWS,
    pendingRows: 1,
    ...overrides,
  })
}

/** Serves the page's reads and records every request as "METHOD /path?search" under the project. */
function installApi(options: { workspace?: () => unknown; results?: (search: URLSearchParams) => Response | Promise<Response>; write?: (path: string, body: unknown) => Response } = {}) {
  const requests: string[] = []
  onTestFinished(mockFetch((url, init) => {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    const path = parsed.pathname.replace('/api/v1/projects/demo', '')
    requests.push(`${method} ${path}${parsed.search}`)
    if (method === 'GET' && path === '/query-tracking') return jsonResponse((options.workspace ?? portfolio)())
    if (method === 'GET' && path === '/query-tracking/results') return options.results?.(parsed.searchParams) ?? jsonResponse(sweep())
    if (method === 'GET' && path === '/measurement-query-templates') return jsonResponse({ templates: [{ id: 'template-best', name: 'Best', template: 'best apartments {market}', variables: ['market'], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] })
    if (options.write) return options.write(path, init?.body ? JSON.parse(String(init.body)) : undefined)
    throw new Error(`Unexpected fetch: ${method} ${path}`)
  }))
  return requests
}

const region = () => screen.getByRole('region', { name: 'Tracked queries' })
/** The table of queries inside that region, which has a name of its own. */
const table = () => screen.getByRole('table', { name: 'Queries' })
const searchBox = () => screen.getByRole('searchbox', { name: 'Search queries' }) as HTMLInputElement
const pageBox = () => screen.getByRole('checkbox', { name: 'Select this page' })
/** The queries the table lists, in order. */
const listed = () => screen.queryAllByRole('button', { name: /^Actions for / }).map(button => button.getAttribute('aria-label')!.slice('Actions for '.length))
const rowOf = (queryText: string) => screen.getByRole('button', { name: `Actions for ${queryText}` }).closest('tr')!
/** One row's chips, as each engine's pair names them. */
const chips = (queryText: string) => within(rowOf(queryText)).getAllByRole('button', { name: /^(OpenAI|Gemini|Perplexity)[,:]/ }).map(pair => pair.getAttribute('aria-label'))
/** The strip's numbers, label to value as it reads. */
const strip = () => Object.fromEntries([...region().querySelector('dl')!.querySelectorAll('dt')].map(term => [term.firstChild!.textContent, term.nextElementSibling!.textContent]))
const count = () => within(region()).getAllByRole('status').find(status => /quer(?:y|ies)$/.test(status.textContent ?? ''))?.textContent
const select = (queryText: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Select ${queryText}` }))
const bulkBar = () => screen.queryByRole('region', { name: 'Selected queries' })
const ALL_STATUS = { ...DEFAULT_TRACKED_FILTERS, status: 'all' as const }
/** Sixty market rows for one market, so the list runs past one page. */
const longPortfolio = () => portfolio({ tracked: Array.from({ length: 60 }, (_, index) => tracked(`q-${index}`, `apartments query ${String(index + 1).padStart(2, '0')}`, { kind: 'market', key: 'uptown' }, uptown())) })
const UPTOWN_PLACE = { measurementScope: 'market' as const, measurementScopeKey: 'uptown', queryClass: 'all' as const }
const PROJECT = { measurementScope: 'project' as const, measurementScopeKey: undefined, queryClass: 'all' as const }
/** Stands in for the clipboard, which jsdom has none of. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
}

test('draws the Add button beside the tabs, then the number strip, the toolbar and the table, from one workspace read and one results read', async () => {
  const requests = installApi()
  renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))

  // In reading order: the tabs, the page's action in their row, then the strip, the search and the table.
  const tabs = screen.getByRole('tablist', { name: 'Query workspace' })
  const add = addButton()
  const stripList = region().querySelector('dl')!
  const order = [tabs, add, stripList, searchBox(), table()]
  for (const [index, element] of order.slice(1).entries()) expect(order[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(tabs.nextElementSibling!.contains(add)).toBe(true)
  expect(add.textContent).toBe('Add queries')
  // The region and the table inside it are told apart by name.
  expect(region().contains(table())).toBe(true)

  // One column per engine, by display name: the project's own, then one only the sweep asked.
  expect(within(table()).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Perplexity', 'Last measured', 'Status', 'Source', 'Actions'])
  expect(within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('combobox').map(filter => filter.getAttribute('aria-label'))).toEqual(['Subject', 'Type', 'Status', 'Source', 'Result'])
  // The legend of the chips, beside the count: each entry is a chip and its word.
  expect(within(region()).getAllByRole('listitem').map(entry => entry.textContent)).toEqual(['M Mentioned', 'C Cited', 'MNo', 'MNot checked'])
  // The clean view lists what is asked, by Subject: markets, then locations, then hand-picked.
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, UPTOWN_PETS, HARBOR, PIER_NEW, PICKED])
  expect(within(rowOf(UPTOWN_BEST)).getByText('Pattern: Best')).toBeTruthy()
  expect(rowOf(UPTOWN_BEST).textContent).toContain('Market · Uptown (3)')
  expect(rowOf(HARBOR).textContent).toContain('Location · Harbor Point')

  expect(requests.filter(request => request.startsWith('GET /query-tracking'))).toEqual(['GET /query-tracking', 'GET /query-tracking/results'])
  expect(requests.filter(request => !request.startsWith('GET '))).toEqual([])
  // None of the old page's words.
  expect(document.body.textContent).not.toMatch(/Scope|Class|Whole site|Assigned relationships|Awaiting sweep|Not in current plan|Legacy|Template|Unclassified|propert|question|—/)
  expectNoSentence(region())
})

test('prints the server\'s numbers in the strip, for the project and for a place, never a count of its rows', async () => {
  installApi()
  const { rerender } = renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  // Eight rows are loaded, six of them asked. Every cell is the server's own field.
  expect(strip()).toEqual({ 'Queries asked': '41', 'Non-brand': '27', Branded: '12', 'Answers per sweep': '300', 'Left under limit': '957 of 1,000' })
  expect(within(region()).getByRole('button', { name: '7 not asked' })).toBeTruthy()
  expect(await within(region()).findByText(`Last sweep ${day(SWEPT_AT)}`)).toBeTruthy()
  expect(within(region()).getByText('Next Oct 21')).toBeTruthy()
  // The count under the search is the length of the list shown.
  expect(count()).toBe('6 queries')

  rerender({ selection: { measurementScope: 'market', measurementScopeKey: 'uptown', queryClass: 'all' } })
  expect(strip()).toEqual({ 'Market queries': '7', 'Location queries': '9', Locations: '3', 'Answers per sweep': '96' })
  rerender({ selection: { measurementScope: 'property', measurementScopeKey: 'harbor', queryClass: 'all' } })
  expect(strip()).toEqual({ 'Location queries': '4', 'Market queries': '11', 'Hand-picked queries': '2', Markets: '2', 'Answers counted': '51' })
  rerender({ selection: { measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'all' } })
  expect(strip()).toEqual({ Queries: '19', Locations: '2', Markets: '1', 'Answers per sweep': '114' })
})

test('a market Place shows its strip, lists the queries asked for it and reads the results for that market', async () => {
  const requests = installApi({ results: search => jsonResponse(sweep({ scope: { kind: search.get('scope') ?? 'project', key: search.get('scopeKey') } })) })
  const { rerender } = renderWorkspace({ selection: { measurementScope: 'market', measurementScopeKey: 'uptown', queryClass: 'all' }, trackedFilters: ALL_STATUS, onTrackedFiltersChange: () => {} })
  await screen.findByText(UPTOWN_BEST)
  // The market's own queries, the location and hand-picked queries asked inside it, and nothing asked nowhere.
  expect(listed()).toEqual([UPTOWN_BEST, UPTOWN_PETS, HARBOR, PICKED])
  expect(count()).toBe('4 queries')
  expect(addButton().textContent).toBe('Add market query')
  expect(requests.filter(request => request.includes('/results'))).toEqual(['GET /query-tracking/results?scope=market&scopeKey=uptown'])

  rerender({ selection: { measurementScope: 'property', measurementScopeKey: 'pier', queryClass: 'all' } })
  expect(listed()).toEqual([PIER_NEW, PICKED])
  expect(addButton().textContent).toBe('Add location query')
  await waitFor(() => expect(requests.filter(request => request.includes('/results')).at(-1)).toBe('GET /query-tracking/results?scope=property&scopeKey=pier'))

  // A group is many places, and a market with no location left takes no query: both add as the whole project does.
  rerender({ selection: { measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'all' } })
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, UPTOWN_PETS, HARBOR, PICKED])
  expect(addButton().textContent).toBe('Add queries')
  rerender({ selection: { measurementScope: 'market', measurementScopeKey: 'lakeview', queryClass: 'all' } })
  expect(addButton().textContent).toBe('Add queries')
})

test('sends a filter change to the host, lists by the filters the host holds, and keeps the search to itself', async () => {
  installApi()
  const onTrackedFiltersChange = vi.fn()
  const { rerender, ...props } = renderWorkspace({ trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))

  fireEvent.change(screen.getByRole('combobox', { name: 'Subject' }), { target: { value: 'location' } })
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, subject: 'location' })
  // The URL owns the filters: nothing changes until the host passes them back.
  expect(listed()).toHaveLength(6)
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'location' } })
  expect(listed()).toEqual([HARBOR, PIER_NEW])
  expect(count()).toBe('2 of 8 queries')

  // Result lists a row when one of its chips is in that state: here a No on Cited.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'not-cited' } })
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, PICKED])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  expect(listed()).toEqual([OLD_TOWN, CAMPUS])

  // The search reads the query and its place, and is the page's own: no URL key, no word to the host.
  rerender({ trackedFilters: DEFAULT_TRACKED_FILTERS })
  onTrackedFiltersChange.mockClear()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'harbor' } })
  expect(listed()).toEqual([HARBOR])
  expect(count()).toBe('1 of 8 queries')
  // A market's name finds its queries, though no query text holds it.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'lakeshore' } })
  expect(listed()).toEqual([DOWNTOWN])
  expect(onTrackedFiltersChange).not.toHaveBeenCalled()
  expect(props.onSelectionChange).not.toHaveBeenCalled()
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()
})

test('"7 not asked" lists the queries asked nowhere, whatever was filtered before', async () => {
  installApi()
  const onTrackedFiltersChange = vi.fn()
  renderWorkspace({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'market' }, onTrackedFiltersChange })
  await screen.findByText(UPTOWN_BEST)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'uptown' } })
  fireEvent.click(screen.getByRole('button', { name: '7 not asked' }))
  // Status alone, on a clean search: a Subject filter would list none of them.
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
  expect((screen.getByRole('searchbox', { name: 'Search queries' }) as HTMLInputElement).value).toBe('')
})

test.each([
  // The day is the viewer's own, so the label is built as the page builds it: the test holds in every timezone.
  ['a writer whose host has the date', false, CHANGED_AT, `Tracking changed ${day(CHANGED_AT)}`],
  ['a viewer, whose host has none', true, undefined, 'Tracking changed'],
] as const)('after a move published with no new sweep, the moved row reads Not checked and the rest keep their chips, for %s', async (_who, viewer, trackingChangedAt, label) => {
  // Harbor Point reviews was moved after the sweep of Oct 7: the results hold no row for it until the next one.
  installApi({ results: () => jsonResponse(sweep({ run: { ...sweep().run!, revision: 3, matchesCurrentTracking: false }, rows: RESULT_ROWS.filter(row => row.queryId !== 'q-harbor'), pendingRows: 2 })) })
  const props = { trackingChangedAt, nextSweepDate: 'Oct 21' }
  if (viewer) renderViewerWorkspace(props)
  else renderWorkspace(props)
  await screen.findByText(HARBOR)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Not mentioned, Not cited', 'Perplexity: Mentioned, Cited']))
  expect(chips(HARBOR)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Perplexity: Not checked'])
  // The same words as AI Visibility: a short label, with the sentence behind it.
  noteButton(label, VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(day(SWEPT_AT), 'Oct 21'), region())
  expect(screen.queryByText('Results unavailable')).toBeNull()
})

test('a location added after the last sweep reads Not checked and First answers, a query asked both ways has a pair per type, and nothing reads as an error', async () => {
  installApi()
  renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(PIER_NEW)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))
  expect(chips(PIER_NEW)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Perplexity: Not checked'])
  expect(within(rowOf(PIER_NEW)).getByText('First answers Oct 21')).toBeTruthy()
  expect(within(rowOf(PIER_NEW)).getByText('Never')).toBeTruthy()
  // Branded and non-brand results are never combined: each type keeps its own pair, and Cited is never read from Mentioned.
  expect(chips(PICKED)).toEqual([
    'OpenAI, Branded: Mentioned, Cited', 'OpenAI, Non-brand: Mentioned, Citation not checked',
    'Gemini, Branded: Mentioned, Not cited', 'Gemini, Non-brand: Not mentioned, Not cited',
    'Perplexity, Branded: Not checked', 'Perplexity, Non-brand: Not checked',
  ])
  expect(screen.queryByText('Results unavailable')).toBeNull()
  expect(screen.queryByText(/^Tracking changed/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a failed results read keeps the table with Not checked chips, and Retry reads again', async () => {
  let fail = true
  const requests = installApi({ results: () => fail ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500) : jsonResponse(sweep()) })
  const { queryClient } = renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  const note = await screen.findByRole('button', { name: "Results unavailable. The last sweep's results did not load, so every chip reads Not checked." })
  expect(note.textContent).toBe('Results unavailable')
  // Said to a screen reader when it appears, as the chips going blank is not.
  expect(note.closest('[role="status"]')!.textContent).toBe('Results unavailableRetry')
  expect(listed()).toHaveLength(6)
  expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked'])
  // The strip keeps its numbers and claims no sweep date it could not read.
  expect(strip()['Queries asked']).toBe('41')
  expect(within(region()).queryByText(/^Last sweep/)).toBeNull()

  fail = false
  const retry = screen.getByRole('button', { name: 'Retry results' })
  expect(retry.textContent).toBe('Retry')
  fireEvent.click(retry)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Not mentioned, Not cited', 'Perplexity: Mentioned, Cited']))
  expect(screen.queryByText('Results unavailable')).toBeNull()
  expect(requests.filter(request => request.includes('/results'))).toHaveLength(2)

  // A later refresh that fails keeps the chips the page has already read.
  fail = true
  await act(() => queryClient.invalidateQueries())
  expect(requests.filter(request => request.includes('/results'))).toHaveLength(3)
  // The failure is in the cache, over the results it kept, and the page has been told of it.
  const read = queryClient.getQueryCache().getAll().find(query => JSON.stringify(query.queryKey).includes('QueryTrackingResults'))!
  await waitFor(() => expect(read.state.status).toBe('error'))
  expect(read.state.data).toBeDefined()
  await act(() => new Promise<void>(resolve => { setTimeout(resolve, 20) }))
  expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Not mentioned, Not cited', 'Perplexity: Mentioned, Cited'])
  expect(screen.queryByText('Results unavailable')).toBeNull()
})

test('with no sweep yet the strip says so, every chip reads Not checked and a running sweep takes the next date', async () => {
  installApi({ results: () => jsonResponse(sweep({ run: null, engines: [], rows: [], pendingRows: 6 })) })
  renderWorkspace({ publishGuard: { sweepActive: true } })
  await screen.findByText(UPTOWN_BEST)
  expect(await within(region()).findByText('Last sweep: none')).toBeTruthy()
  expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked'])
  // A sweep under way names no date: the strip says it is running and a waiting row reads plain First answers.
  noteButton('Sweep running', 'Answers are being collected now. Numbers update when the sweep finishes.', region())
  expect(within(region()).queryByText(/^Next /)).toBeNull()
  expect(within(rowOf(PIER_NEW)).getByText('First answers')).toBeTruthy()
  expect(screen.queryByText('Results unavailable')).toBeNull()
})

test.each([['a viewer', true], ['a writer', false]] as const)('a row link opens the table on that row\'s page, marked and open, with no form or sheet, for %s', async (_who, viewer) => {
  installApi({ workspace: longPortfolio, results: () => jsonResponse(sweep({ rows: [] })) })
  const props = { trackingQueryId: 'q-56', onTrackingQueryIdChange: vi.fn(), onTrackedFiltersChange: vi.fn() }
  if (viewer) renderViewerWorkspace(props)
  else renderWorkspace(props)
  // Fifty rows to a page: the 57th query is on the second.
  const linked = (await screen.findByRole('button', { name: 'Actions for apartments query 57' })).closest('tr')!
  expect(listed()).toHaveLength(10)
  expect(screen.getByText('51 to 60 of 60 queries')).toBeTruthy()
  expect(linked.hasAttribute('data-highlighted')).toBe(true)
  expect(within(linked).getByRole('button', { name: 'apartments query 57' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(linked.nextElementSibling as HTMLElement).getByRole('table', { name: 'Location links' })).toBeTruthy()
  // A link is a place in the list, never an action.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('heading', { name: /^(Edit|Remove|Add) query$/ })).toBeNull()
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()

  // After that the pages are the reader's.
  fireEvent.click(screen.getByRole('button', { name: /Previous/ }))
  expect(listed()).toHaveLength(50)
  expect(screen.getByText('1 to 50 of 60 queries')).toBeTruthy()
  // Another page size starts at the first page, link or no link.
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows' }), { target: { value: '25' } })
  expect(screen.getByText('1 to 25 of 60 queries')).toBeTruthy()
  expect(props.onTrackedFiltersChange).not.toHaveBeenCalled()
})

test('a link to a row the place and the filters leave out widens them once, and the row is then listed, marked and open', async () => {
  installApi()
  const onTrackedFiltersChange = vi.fn()
  // The linked query has stopped being asked since the link was copied: it is in no place, under a Status the clean view leaves out.
  const props = renderWorkspace({ trackingQueryId: 'q-old', selection: UPTOWN_PLACE, trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'market' }, onTrackedFiltersChange })
  await screen.findByText(UPTOWN_BEST)
  expect(onTrackedFiltersChange.mock.calls).toEqual([[ALL_STATUS]])
  expect(vi.mocked(props.onSelectionChange).mock.calls).toEqual([[{ measurementScope: 'project', measurementScopeKey: undefined }]])
  // It changes where the reader is, never what the link is.
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()

  props.rerender({ selection: PROJECT, trackedFilters: ALL_STATUS })
  const linked = rowOf(OLD_TOWN)
  expect(linked.hasAttribute('data-highlighted')).toBe(true)
  expect(within(linked).getByRole('button', { name: OLD_TOWN }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByRole('dialog')).toBeNull()

  // Once per link: after that the filters are the reader's, and hiding the row again is theirs to do.
  props.rerender({ selection: PROJECT, trackedFilters: DEFAULT_TRACKED_FILTERS })
  expect(listed()).not.toContain(OLD_TOWN)
  expect(onTrackedFiltersChange).toHaveBeenCalledTimes(1)
  expect(props.onSelectionChange).toHaveBeenCalledTimes(1)
})

test('a link to an asked row a filter hides clears the filters and the search, and keeps the place it is asked in', async () => {
  installApi()
  const onTrackedFiltersChange = vi.fn()
  const props = renderWorkspace({ selection: UPTOWN_PLACE, trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'market' }, onTrackedFiltersChange })
  await screen.findByText(UPTOWN_BEST)
  fireEvent.change(searchBox(), { target: { value: 'pets' } })
  expect(onTrackedFiltersChange).not.toHaveBeenCalled()
  // The link arrives on the open page, for a location query asked in this market.
  props.rerender({ trackingQueryId: 'q-harbor' })
  expect(onTrackedFiltersChange.mock.calls).toEqual([[DEFAULT_TRACKED_FILTERS]])
  expect(searchBox().value).toBe('')
  expect(props.onSelectionChange).not.toHaveBeenCalled()
  props.rerender({ trackingQueryId: 'q-harbor', trackedFilters: DEFAULT_TRACKED_FILTERS })
  expect(rowOf(HARBOR).hasAttribute('data-highlighted')).toBe(true)
  // A link to a query that is gone lists what was listed, and changes nothing.
  props.rerender({ trackingQueryId: 'q-removed', trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'market' } })
  expect(listed()).toEqual([UPTOWN_BEST, UPTOWN_PETS])
  expect(onTrackedFiltersChange).toHaveBeenCalledTimes(1)
})

test('pages fifty rows by default and offers 25, 50 and 100', async () => {
  installApi({ workspace: longPortfolio, results: () => jsonResponse(sweep({ rows: [] })) })
  renderWorkspace()
  await screen.findByText('apartments query 01')
  expect(listed()).toHaveLength(50)
  const rows = screen.getByRole('combobox', { name: 'Rows' }) as HTMLSelectElement
  expect([...rows.options].map(option => option.text)).toEqual(['25', '50', '100'])
  expect(rows.value).toBe('50')
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  expect(listed()[0]).toBe('apartments query 51')
  // Another page size starts at the first page.
  fireEvent.change(rows, { target: { value: '25' } })
  expect(listed()).toHaveLength(25)
  expect(listed()[0]).toBe('apartments query 01')
  expect(screen.getByText('1 to 25 of 60 queries')).toBeTruthy()
  // A search starts there too.
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  expect(listed()[0]).toBe('apartments query 26')
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'query 0' } })
  expect(listed().slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, index) => `apartments query 0${index + 1}`))
  expect(screen.getByText('1 to 15 of 15 queries')).toBeTruthy()
})

test('each empty state offers an action that changes what is listed, and the focus lands on the search when that action leaves the page', async () => {
  // No query at all: the action adds one. The Add button beside the tabs stays the page's one primary action.
  installApi({ workspace: () => portfolio({ tracked: [] }) })
  const first = renderWorkspace()
  const none = (await screen.findByText('No queries yet')).closest('td')!
  expect(screen.queryByRole('searchbox', { name: 'Search queries' })).toBeNull()
  // Nothing to tick, so no box is drawn.
  expect(screen.queryAllByRole('checkbox')).toEqual([])
  const add = within(none).getByRole('button', { name: 'Add queries' })
  const primary = within(screen.getByRole('tablist', { name: 'Query workspace' }).nextElementSibling as HTMLElement).getByRole('button', { name: 'Add queries' })
  expect(primary.className.split(' ')).toContain('bg-accent')
  expect(add.className.split(' ')).not.toContain('bg-accent')
  fireEvent.click(add)
  expect(screen.getByRole('dialog', { name: 'Add queries' })).toBeTruthy()
  cleanup()

  // A Place with none: the action shows the whole project.
  installApi()
  const second = renderWorkspace({ selection: { measurementScope: 'market', measurementScopeKey: 'lakeview', queryClass: 'all' }, rootLabel: 'All of Demo' })
  const here = (await screen.findByText('No queries here')).closest('td')!
  expect(within(here).getAllByRole('button')).toHaveLength(1)
  fireEvent.click(within(here).getByRole('button', { name: 'Show all of Demo' }))
  expect(second.onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'project', measurementScopeKey: undefined })
  // Its button goes with the place. The search is where the focus lands.
  second.rerender({ selection: PROJECT })
  expect(screen.queryByText('No queries here')).toBeNull()
  expect(document.activeElement).toBe(searchBox())
  cleanup()

  // A search that lists nothing: one action clears it, and another shows the rows the clean Status leaves out.
  installApi()
  const onTrackedFiltersChange = vi.fn()
  const third = renderWorkspace({ trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange })
  await screen.findByText(UPTOWN_BEST)
  fireEvent.change(searchBox(), { target: { value: 'old town' } })
  const match = screen.getByText('No queries match').closest('td')!
  expect(count()).toBe('0 of 8 queries')
  expect(screen.queryAllByRole('checkbox')).toEqual([])
  fireEvent.click(within(match).getByRole('button', { name: 'Show not asked' }))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
  expect(document.activeElement).toBe(searchBox())
  // "Clear all" clears the search with the filters, so it is not a second "Clear filters".
  third.rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'location' } })
  expect(within(region()).getAllByRole('button', { name: /^Clear (filters|all)$/ }).map(button => button.textContent)).toEqual(['Clear filters', 'Clear all'])
  searchBox().blur()
  fireEvent.click(within(match).getByRole('button', { name: 'Clear all' }))
  expect(searchBox().value).toBe('')
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith(DEFAULT_TRACKED_FILTERS)
  expect(document.activeElement).toBe(searchBox())
  third.rerender({ trackedFilters: DEFAULT_TRACKED_FILTERS })
  expect(listed()).toHaveLength(6)
  // With no hidden row to show, only Clear all is offered.
  fireEvent.change(searchBox(), { target: { value: 'no such query' } })
  expect(within(screen.getByText('No queries match').closest('td')!).getAllByRole('button').map(button => button.textContent)).toEqual(['Clear all'])
  expect(first.onSelectionChange).not.toHaveBeenCalled()
})

test('when every query is one the clean view leaves out, the list says none is asked and offers them, with nothing to clear', async () => {
  installApi({ workspace: () => portfolio({ tracked: portfolio().tracked.filter(row => row.assignments.length === 0) }) })
  const onTrackedFiltersChange = vi.fn()
  renderWorkspace({ trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange })
  const none = (await screen.findByText('None asked')).closest('td')!
  expect(screen.queryByText('No queries match')).toBeNull()
  expect(within(none).getAllByRole('button').map(button => button.textContent)).toEqual(['Show not asked'])
  expect(within(region()).queryByRole('button', { name: /^Clear (filters|all)$/ })).toBeNull()
  fireEvent.click(within(none).getByRole('button', { name: 'Show not asked' }))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
})

test('a viewer with no queries reads that there are none and is offered nothing', async () => {
  installApi({ workspace: () => portfolio({ tracked: [] }) })
  renderViewerWorkspace()
  const none = (await screen.findByText('No queries yet')).closest('td')!
  expect(within(none).queryAllByRole('button')).toEqual([])
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  expect(screen.queryAllByRole('checkbox')).toEqual([])
})

test('a Result filter waits for the results: skeleton rows and no count, never an empty list, and ticked rows are kept', async () => {
  // Each results read waits here until the test lets it go.
  const waiting: Array<() => void> = []
  installApi({ results: () => new Promise<Response>(resolve => waiting.push(() => resolve(jsonResponse(sweep())))) })
  const { rerender } = renderWorkspace({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'not-mentioned' }, onTrackedFiltersChange: () => {} })
  const pending = () => {
    expect(screen.getByRole('status', { name: 'Loading queries' })).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'Queries' })).toBeNull()
    expect(screen.queryByText('No queries match')).toBeNull()
    expect(within(region()).queryByRole('button', { name: /^Clear all|^Show not asked/ })).toBeNull()
    expect(count()).toBeUndefined()
  }
  // A link that carries the filter: the toolbar is up, and the list waits.
  await screen.findByRole('searchbox', { name: 'Search queries' })
  await waitFor(() => expect(waiting).toHaveLength(1))
  pending()
  waiting.shift()!()
  await waitFor(() => expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, PICKED]))
  expect(count()).toBe('3 of 8 queries')

  // Another place reads its own results, so the list waits again, and the ticked row is still ticked after it.
  select(UPTOWN_BEST)
  rerender({ selection: UPTOWN_PLACE })
  await waitFor(() => expect(waiting).toHaveLength(1))
  pending()
  waiting.shift()!()
  await waitFor(() => expect(listed()).toEqual([UPTOWN_BEST]))
  expect(within(bulkBar()!).getByText('1 selected')).toBeTruthy()
})

test('inside a place a query asked both ways reads the type it is asked under there, with one pair of chips per engine', async () => {
  // As the server folds the results for a place: one row per query and type with a location link inside it.
  const inUptown = RESULT_ROWS.filter(row => !(row.queryId === 'q-picked' && row.queryClass === 'non-brand'))
  installApi({ results: search => jsonResponse(sweep(search.get('scope') === 'market' ? { scope: { kind: 'market', key: 'uptown' }, rows: inUptown } : {})) })
  const { rerender } = renderWorkspace({ selection: UPTOWN_PLACE, trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText(PICKED)
  const typeOf = (queryText: string) => rowOf(queryText).cells[within(table()).getAllByRole('columnheader').findIndex(header => header.textContent === 'Type')]!.textContent
  // In Uptown the query is asked as Branded only: its Non-brand location is elsewhere.
  await waitFor(() => expect(chips(PICKED)).toEqual(['OpenAI: Mentioned, Cited', 'Gemini: Mentioned, Not cited', 'Perplexity: Not checked']))
  expect(typeOf(PICKED)).toBe('Branded')
  // The filters read the same types: no Non-brand pair to wait for here, and no Mixed row.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'non-brand' } })
  expect(listed()).toEqual([UPTOWN_BEST, UPTOWN_PETS])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'mixed' } })
  expect(listed()).toEqual([])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' } })
  expect(listed()).toEqual([HARBOR, PICKED])
  // A change is to the whole query, so its sheet still reads every type it is asked under.
  const sheet = await openRowSheet(PICKED, 'Change type')
  expect(sheet.getByText('Now').nextElementSibling!.textContent).toBe('Mixed')
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  // For the whole project it is asked both ways, a pair per type.
  rerender({ selection: PROJECT, trackedFilters: DEFAULT_TRACKED_FILTERS })
  await waitFor(() => expect(chips(PICKED)).toHaveLength(6))
  expect(typeOf(PICKED)).toBe('MixedBrandedNon-brand')
})

test('the bulk bar offers what every selected row can take, and its actions open the sheets with the rows and the Place', async () => {
  const previews: unknown[] = []
  installApi({ write: (path, body) => { previews.push([path, body]); return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'not reviewed here' } }, 400) } })
  renderWorkspace({ selection: { measurementScope: 'market', measurementScopeKey: 'uptown', queryClass: 'all' } })
  await screen.findByText(UPTOWN_BEST)
  expect(bulkBar()).toBeNull()

  select(UPTOWN_BEST)
  select(HARBOR)
  const bar = within(bulkBar()!)
  expect(bar.getByText('2 selected')).toBeTruthy()
  expect(bar.getAllByRole('button').map(button => button.textContent)).toEqual(['Change type', 'Stop tracking', 'Select all 4', 'Clear'])
  expect(rowOf(HARBOR).hasAttribute('data-selected')).toBe(true)

  // Stop tracking takes both rows and the Place: Harbor Point reviews is asked in Downtown too, so the sheet opens on "Only Uptown".
  fireEvent.click(bar.getByRole('button', { name: 'Stop tracking' }))
  const sheet = within(screen.getByRole('dialog', { name: 'Stop tracking' }))
  expect(sheet.getByText('2 queries')).toBeTruthy()
  expect(sheet.getByText(UPTOWN_BEST)).toBeTruthy()
  expect(sheet.getByText(HARBOR)).toBeTruthy()
  expect(sheet.getByRole('radio', { name: 'Only Uptown' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(previews).toHaveLength(1))
  expect(previews[0]).toEqual(['/query-tracking/preview', {
    expectedWorkspaceVersion: `qtw_${'a'.repeat(64)}`, additions: [],
    removals: [{ queryId: 'q-uptown-best', audience: { marketKeys: ['uptown'] } }, { queryId: 'q-harbor', audience: { marketKeys: ['uptown'] } }],
  }])
  fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  // The selection is still there. Escape clears it.
  expect(within(bulkBar()!).getByText('2 selected')).toBeTruthy()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(bulkBar()).toBeNull()
  expect(rowOf(HARBOR).hasAttribute('data-selected')).toBe(false)
})

test('"Selected actions" jumps from the list to the bar, and the focus comes back to the list when the bar goes', async () => {
  installApi()
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  expect(screen.queryByRole('link', { name: 'Selected actions' })).toBeNull()

  select(UPTOWN_BEST)
  // Before the table in the page, so one step back from its first control: the bar itself follows the last page of rows.
  const jump = screen.getByRole('link', { name: 'Selected actions' })
  const order = [searchBox(), jump, table(), bulkBar()!]
  for (const [index, element] of order.slice(1).entries()) expect(order[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(jump.getAttribute('href')).toBe(`#${bulkBar()!.id}`)
  fireEvent.click(jump)
  expect(document.activeElement).toBe(within(bulkBar()!).getByRole('button', { name: 'Change type' }))

  // Select all leaves the bar once every row is ticked, so the focus moves to Clear.
  fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Select all 6' }))
  expect(within(bulkBar()!).getByText('6 selected')).toBeTruthy()
  expect(within(bulkBar()!).queryByRole('button', { name: /^Select all/ })).toBeNull()
  expect(document.activeElement).toBe(within(bulkBar()!).getByRole('button', { name: 'Clear' }))

  // Clear takes the bar with it: the list's first control has the focus.
  fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Clear' }))
  expect(bulkBar()).toBeNull()
  expect(screen.queryByRole('link', { name: 'Selected actions' })).toBeNull()
  expect(document.activeElement).toBe(pageBox())

  // So does Escape pressed inside the bar.
  select(HARBOR)
  fireEvent.click(screen.getByRole('link', { name: 'Selected actions' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(bulkBar()).toBeNull()
  expect(document.activeElement).toBe(pageBox())
})

test('ticked rows stay ticked from page to page, the whole list is offered only when one change can take it, and a longer selection is told the limit', async () => {
  installApi({ workspace: longPortfolio, results: () => jsonResponse(sweep({ rows: [] })) })
  renderWorkspace()
  await screen.findByText('apartments query 01')
  select('apartments query 01')
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  expect(within(bulkBar()!).getByText('1 selected')).toBeTruthy()
  select('apartments query 51')
  expect(within(bulkBar()!).getByText('2 selected')).toBeTruthy()
  // Sixty rows are more than one change takes, so they are not offered whole.
  expect(within(bulkBar()!).queryByRole('button', { name: /^Select all/ })).toBeNull()

  // A search that lists fifteen is. The ticked row it does not list leaves the selection.
  fireEvent.change(searchBox(), { target: { value: 'query 0' } })
  expect(within(bulkBar()!).getByText('1 selected')).toBeTruthy()
  fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Select all 15' }))
  expect(within(bulkBar()!).getByText('15 selected')).toBeTruthy()
  expect(within(bulkBar()!).getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled)).toEqual([])

  // A page of a hundred rows holds all sixty: over the limit the actions are off and the bar says why.
  fireEvent.change(searchBox(), { target: { value: '' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows' }), { target: { value: '100' } })
  fireEvent.click(pageBox())
  expect(within(bulkBar()!).getByText('60 selected')).toBeTruthy()
  noteButton('Max 50 rows', 'One change takes at most 50 rows. Clear some to continue.', bulkBar()!)
  expect(within(bulkBar()!).getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled).map(button => button.textContent)).toEqual(['Change type', 'Stop tracking'])
})

test('a change published from the bar clears the selection, and the list takes the focus the bar held', async () => {
  const stopped = ['q-uptown-best', 'q-harbor']
  const writes: string[] = []
  installApi({ write: (path) => {
    writes.push(path)
    const after = portfolio().tracked.filter(row => !stopped.includes(row.queryId))
    const diff = { added: [], removed: [{ queryId: 'q-uptown-best', queryText: UPTOWN_BEST, assignmentCount: 3 }, { queryId: 'q-harbor', queryText: HARBOR, assignmentCount: 1 }], reused: [], unchanged: [], noOp: false }
    if (path === '/query-tracking/preview') return jsonResponse(preview({ tracked: after, diff }))
    return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, reviewedAt: '2026-10-10T12:00:00.000Z', active: { revision: 5, compiledChecksum: 'c'.repeat(64) }, diff, workload: preview().workload })
  } })
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  select(UPTOWN_BEST)
  select(HARBOR)
  const stop = within(bulkBar()!).getByRole('button', { name: 'Stop tracking' })
  stop.focus()
  fireEvent.click(stop)
  const sheet = within(screen.getByRole('dialog', { name: 'Stop tracking' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Publish 2 changes' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual(['/query-tracking/preview', '/query-tracking/commit'])
  // The bar went with its rows, so the sheet has nothing to hand the focus back to.
  expect(bulkBar()).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(pageBox()))
})

test('asked and not asked rows share no bulk action, rows that are not asked can be tracked, and a row the filters drop leaves the selection', async () => {
  installApi()
  const { rerender } = renderWorkspace({ trackedFilters: ALL_STATUS, onTrackedFiltersChange: () => {} })
  await screen.findByText(OLD_TOWN)
  select(UPTOWN_BEST)
  select(OLD_TOWN)
  select(CAMPUS)
  let bar = within(bulkBar()!)
  expect(bar.getByText('3 selected')).toBeTruthy()
  const mixed = noteButton('Mixed selection', 'Queries that are asked and queries that are not take different actions. Select one kind.', bulkBar()!)
  expect(bar.queryByRole('button', { name: /Stop tracking|Change type|Track|Remove query/ })).toBeNull()
  // Escape on the note's open help closes the help, and the selection stays.
  fireEvent.focus(mixed)
  fireEvent.keyDown(mixed, { key: 'Escape' })
  expect(within(bulkBar()!).getByText('3 selected')).toBeTruthy()

  // Under Not asked the asked row is out of sight, so it is out of the selection: no change reaches a row that is not listed.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  bar = within(bulkBar()!)
  expect(bar.getByText('2 selected')).toBeTruthy()
  expect(bar.getAllByRole('button').map(button => button.textContent)).toEqual(['Track', 'Remove query', 'Clear'])
  rerender({ trackedFilters: ALL_STATUS })
  expect(within(bulkBar()!).getByText('2 selected')).toBeTruthy()

  // Track opens the Add queries sheet with the texts, one query per line.
  fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Track' }))
  const sheet = within(screen.getByRole('dialog', { name: 'Add queries' }))
  expect((sheet.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(`${OLD_TOWN}\n${CAMPUS}`)
  expect(sheet.getByText('2 queries')).toBeTruthy()
})

test('a row menu opens the action sheet for one row, tracks a row that is not asked, and copies a link that marks the row', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  stubClipboard(writeText)
  installApi()
  const props = renderWorkspace({ trackedFilters: ALL_STATUS, onTrackedFiltersChange: () => {} })
  await screen.findByText(OLD_TOWN)

  const sheet = await openRowSheet(HARBOR, 'Move to another location')
  expect(sheet.getByText(HARBOR)).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await chooseRowAction(OLD_TOWN, 'Track')
  const add = within(screen.getByRole('dialog', { name: 'Add queries' }))
  expect((add.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(OLD_TOWN)
  fireEvent.click(add.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // The Add button opens the sheet empty: the tracked text was for that one opening.
  fireEvent.click(addButton())
  const plain = within(screen.getByRole('dialog', { name: 'Add queries' }))
  expect((plain.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe('')
  fireEvent.click(plain.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await chooseRowAction(UPTOWN_PETS, 'Copy link')
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.tone])).toEqual([['Link copied', 'positive']]))
  const copied = new URL(writeText.mock.calls[0]![0] as string)
  expect(copied.origin + copied.pathname).toBe(window.location.origin + window.location.pathname)
  expect(copied.searchParams.get('trackingQueryId')).toBe('q-uptown-pets')
  // Copying writes nothing to the URL: the link is for someone else.
  expect(props.onTrackingQueryIdChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a link that cannot be copied says so, and an id the URL would read as a number is quoted as the router writes it', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
  stubClipboard(writeText)
  installApi({ workspace: () => portfolio({ tracked: [tracked('123', UPTOWN_BEST, { kind: 'market', key: 'uptown' }, uptown())] }) })
  renderWorkspace()
  await chooseRowAction(UPTOWN_BEST, 'Copy link')
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.tone])).toEqual([['Could not copy', 'negative']]))
  await chooseRowAction(UPTOWN_BEST, 'Copy link')
  await waitFor(() => expect(getToasts().map(toast => [toast.title, toast.tone])).toEqual([['Link copied', 'positive']]))
  // Unquoted, the router would hand the page the number 123, which names no row.
  expect(new URL(writeText.mock.calls[1]![0] as string).searchParams.get('trackingQueryId')).toBe('"123"')
})

test('a viewer reads everything and is offered no change: no Add, no checkboxes, a menu with Copy link, and the row detail', async () => {
  installApi()
  renderViewerWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))
  expect(strip()['Queries asked']).toBe('41')
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  expect(screen.queryAllByRole('checkbox')).toEqual([])
  expect(within(table()).getAllByRole('columnheader')[0]!.textContent).toBe('Query')
  // No button is switched off: what a viewer cannot do is not drawn.
  expect(within(region()).getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled)).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: `Actions for ${UPTOWN_BEST}` }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy link'])
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })

  // The row detail lists where the query is asked: engines by display name, with the model ids behind the value.
  fireEvent.click(screen.getByRole('button', { name: UPTOWN_BEST }))
  const detail = rowOf(UPTOWN_BEST).nextElementSibling as HTMLElement
  expect(within(detail).getAllByRole('row').slice(1).map(row => row.cells[0]!.textContent)).toEqual(['Harbor Point', 'River Point', 'Summit Lofts'])
  const asked = within(detail).getByRole('button', { name: 'Lakeshore · OpenAI, Gemini. Lakeshore · openai (gpt-5), gemini (gemini-3)' })
  expect(asked.textContent).toBe('Lakeshore · OpenAI, Gemini')
  expect(within(detail).getByText('best apartments {market}')).toBeTruthy()
})

test('two search locations that read alike by engine name keep the Add query form\'s words in the row detail', async () => {
  // One engine on two models: by display name both are "Lakeshore · OpenAI", which would tell the two locations nothing apart.
  const on = (model: string) => ({ providers: ['openai'], models: { openai: model }, location: context.location })
  const asked = [{ ...pairing('harbor', ['uptown'], 'non-brand'), contexts: [on('gpt-5')] }, { ...pairing('river', ['uptown'], 'non-brand'), contexts: [on('gpt-5-mini')] }] as Assignment[]
  installApi({ workspace: () => portfolio({ defaultContexts: [on('gpt-5')], tracked: [tracked('q-two-models', UPTOWN_BEST, { kind: 'market', key: 'uptown' }, asked)] }) })
  renderWorkspace()
  fireEvent.click(await screen.findByRole('button', { name: UPTOWN_BEST }))
  const links = within(rowOf(UPTOWN_BEST).nextElementSibling as HTMLElement).getByRole('table', { name: 'Location links' })
  expect(within(links).getAllByRole('row').slice(1).map(row => [row.cells[0]!.textContent, row.cells[4]!.textContent])).toEqual([
    ['Harbor Point', 'Lakeshore · openai (gpt-5)'],
    ['River Point', 'Lakeshore · openai (gpt-5-mini)'],
  ])
  // Plain text: there is nothing more behind it to open.
  expect(within(links).queryAllByRole('button')).toEqual([])
})

test('a workspace that came without its numbers says so in the strip, and Retry reads the workspace again', async () => {
  let numbers = false
  const requests = installApi({ workspace: () => portfolio(numbers ? {} : { summary: undefined, limits: undefined }) })
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  noteButton('Numbers unavailable', 'These numbers did not load.', region())
  expect(region().querySelector('dl')).toBeNull()
  // The rows are the workspace's own, so the table is whole.
  expect(listed()).toHaveLength(6)

  numbers = true
  const reads = () => requests.filter(request => request === 'GET /query-tracking').length
  expect(reads()).toBe(1)
  fireEvent.click(within(region()).getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(strip()['Queries asked']).toBe('41'))
  expect(reads()).toBe(2)
  expect(screen.queryByText('Numbers unavailable')).toBeNull()
})

test('a closed row of the table is one line, cut short at its column, and the open row shows its query whole', async () => {
  const rules = parseCompiledCss(await compileAppStyles(['tracked-table']))
  for (const cell of ['.tracked-query', '.tracked-cell-source']) {
    const closed = compiledDeclarations(rules, `.tracked-table[data-layout='table'] .tracked-row:not([data-open]) ${cell} > span`)
    expect([closed['white-space'], closed.overflow, closed['text-overflow']], cell).toEqual(['nowrap', 'hidden', 'ellipsis'])
  }
  // The Subject's name gives way and its count does not.
  const name = compiledDeclarations(rules, '.tracked-subject-name')
  expect([name['white-space'], name.overflow, name['text-overflow'], name['min-width']]).toEqual(['nowrap', 'hidden', 'ellipsis', 'calc(var(--spacing) * 0)'])
  expect(compiledDeclarations(rules, '.tracked-subject > :not(.tracked-subject-name)').flex).toBe('none')
  expect(compiledDeclarations(rules, '.tracked-row[data-open] .tracked-query > span')['-webkit-line-clamp']).toBe('unset')
  // An empty state whose action wraps under its label stays centred.
  expect(compiledDeclarations(rules, '.tracked-empty > span')['justify-content']).toBe('center')
  // The way to the bar shows only under keyboard focus.
  expect(compiledDeclarations(rules, '.tracked-skip').position).toBe('absolute')
  expect(compiledDeclarations(rules, '.tracked-skip:focus-visible')['clip-path']).toBe('none')
})

test('/ moves to the search from anywhere but a field, and Escape in the toolbar leaves the selection alone', async () => {
  installApi()
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  const search = screen.getByRole('searchbox', { name: 'Search queries' }) as HTMLInputElement
  const slash = (target: Element) => fireEvent.keyDown(target, { key: '/' })

  select(UPTOWN_BEST)
  const box = screen.getByRole('checkbox', { name: `Select ${UPTOWN_BEST}` })
  box.focus()
  expect(slash(box)).toBe(false)
  expect(document.activeElement).toBe(search)
  // Typed into the search, a slash is a character.
  expect(slash(search)).toBe(true)
  // Escape there belongs to the toolbar, so the selection stays.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Filters' }), { key: 'Escape' })
  expect(within(bulkBar()!).getByText('1 selected')).toBeTruthy()

  // In a sheet the key is the sheet's: focus stays inside it.
  fireEvent.click(addButton())
  const queries = within(screen.getByRole('dialog', { name: 'Add queries' })).getByLabelText('Queries')
  expect(slash(queries)).toBe(true)
  expect(slash(within(screen.getByRole('dialog', { name: 'Add queries' })).getByRole('button', { name: 'Cancel' }))).toBe(true)
  expect(document.activeElement).not.toBe(search)
})
