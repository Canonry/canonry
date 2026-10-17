import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { queryTrackingResultsResponseSchema, queryTrackingWorkspaceResponseSchema } from '@canonry/canonry-contracts'
import type { QueryClass, QueryTrackingTrackedRow, UiTelemetryEvent } from '@canonry/canonry-contracts'

import { DEFAULT_TRACKED_FILTERS } from '../src/components/project/queries/advanced/tracked-filters.js'
import { formatObservedInstantMonthDay, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { VisibilityScopePicker } from '../src/components/project/VisibilityScopePicker.js'
import { VISIBILITY_TOOLBAR_COPY } from '../src/components/project/VisibilityTrendSection.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { configureUiTelemetry, resetUiTelemetryForTests } from '../src/lib/ui-telemetry.js'
import { compileAppStyles, compiledDeclarations, parseCompiledCss } from './compiled-app-css.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { addButton, chooseRowAction, expectNoSentence, noteButton, openRowSheet, preview, renderViewerWorkspace, renderWorkspace } from './support/query-tracking-fixtures.js'

// The assembled Tracked page of an Advanced project, through the Queries section: one workspace read, one
// results read, and the strip, saved views, toolbar, table, bulk bar and sheets over them.

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
const MEASURED_AT = '2026-10-07T12:10:00.000Z'
const pairing = (targetKey: string, marketKeys: string[], queryClass: QueryClass | null, groupKeys: string[] = []): Assignment =>
  ({ targetKey, groupKeys, marketKeys, queryClass, classificationSource: 'server', contexts: [context] }) as Assignment
function tracked(queryId: string, queryText: string, focus: QueryTrackingTrackedRow['focus'], assignments: Assignment[], overrides: Record<string, unknown> = {}) {
  return {
    queryId, queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
    state: 'tracked', lastMeasuredAt: MEASURED_AT,
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
/** What each engine cell of a row says to a screen reader, in column order: its pairs by name, or the words of a cell that draws none. */
const engineCells = (queryText: string) => [...rowOf(queryText).querySelectorAll<HTMLElement>(':scope > td.tracked-cell-engine')].map(cell => {
  const pairs = within(cell).queryAllByRole('button').map(pair => pair.getAttribute('aria-label'))
  return pairs.length > 0 ? pairs.join(' | ') : cell.textContent
})
/** What one pair's bubble says, which is its description. */
const marks = (queryText: string, pair: string) => within(rowOf(queryText)).getByRole('button', { name: pair }).getAttribute('aria-description')
const OWN_LOCATIONS = 'M and C are for the locations a query is asked for: one location for a location query, any location in the market for a market query. Another of your locations in the answer does not light them.'
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
/** A table frame of this width, as a browser measures and reports it. jsdom lays nothing out and has no observer. */
function frameWidth(width: number) {
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return { width: this.classList.contains('tracked-table-frame') ? width : 0 } as DOMRect })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  onTestFinished(() => {
    rect.mockRestore()
    vi.unstubAllGlobals()
  })
}
/** Text as a browser measures it: 7px a character on the table's ruler, beside a Query column of this width. Call it after `frameWidth`. */
function queryColumn(width: number) {
  const frame = vi.mocked(Element.prototype.getBoundingClientRect).getMockImplementation()!
  vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
    if (this.parentElement?.classList.contains('tracked-ruler')) return { width: this.textContent!.length * 7 } as DOMRect
    return this.classList.contains('tracked-query') ? { width } as DOMRect : frame.call(this)
  })
}
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
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  expect(within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('combobox').map(filter => filter.getAttribute('aria-label'))).toEqual(['Subject', 'Type', 'Status', 'Source', 'Result'])
  // The legend of the chips, beside the count: each entry is a chip and its word, and a No names its own signal.
  expect(within(region()).getAllByRole('listitem').map(entry => entry.textContent)).toEqual(['M Mentioned', 'C Cited', 'M Not mentioned', 'C Not cited', 'MNot checked'])
  // Before it, whose mention or citation lights a mark: a short label, with the sentence behind it.
  const note = noteButton("Each query's own locations", OWN_LOCATIONS, region())
  expect(note.compareDocumentPosition(within(region()).getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // The clean view lists what is asked, by Subject: markets, then locations, then hand-picked.
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, UPTOWN_PETS, HARBOR, PIER_NEW, PICKED])
  expect(within(rowOf(UPTOWN_BEST)).getByText('Pattern: Best')).toBeTruthy()
  // Status carries the row's own last sweep.
  expect(within(rowOf(UPTOWN_BEST)).getByText(`Measured ${day(MEASURED_AT)}`)).toBeTruthy()
  expect(rowOf(UPTOWN_BEST).textContent).toContain('Market · Uptown (3)')
  expect(rowOf(HARBOR).textContent).toContain('Location · Harbor Point')

  expect(requests.filter(request => request.startsWith('GET /query-tracking'))).toEqual(['GET /query-tracking', 'GET /query-tracking/results'])
  expect(requests.filter(request => !request.startsWith('GET '))).toEqual([])
  // None of the old page's words.
  expect(document.body.textContent).not.toMatch(/Scope|Class|Whole site|Assigned relationships|Awaiting sweep|Not in current plan|Legacy|Template|Unclassified|propert|question|—/)
  expectNoSentence(region())
})

test('in the 1152px content column the table keeps Query wide: Status carries the date, and Last measured and Source wait in the row detail', async () => {
  frameWidth(1152)
  installApi()
  renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))
  const header = (name: string) => within(table()).getAllByRole('columnheader').find(cell => cell.textContent === name)!

  expect(within(table()).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['', 'Query', 'Subject', 'Type', 'OpenAI', 'Gemini', 'Perplexity', 'Status', 'Actions'])
  // Perplexity's header needs 88px, so Subject gives Query 22 of its 250 and Query keeps 420.
  expect([...table().querySelectorAll('col')].map(column => column.style.width)).toEqual(['32px', '', '228px', '80px', '62px', '62px', '88px', '148px', '32px'])
  expect(within(rowOf(UPTOWN_BEST)).getByText(`Measured ${day(MEASURED_AT)}`)).toBeTruthy()
  expect(within(rowOf(PIER_NEW)).getByText('First answers Oct 21')).toBeTruthy()
  // No filter went with the columns.
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  expect(within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('combobox').map(filter => filter.getAttribute('aria-label'))).toEqual(['Subject', 'Type', 'Status', 'Source', 'Result'])

  // Status sorts by status: the row that waits for its first answers goes after every measured one.
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, UPTOWN_PETS, HARBOR, PIER_NEW, PICKED])
  fireEvent.click(within(table()).getByRole('button', { name: 'Status' }))
  expect([header('Subject'), header('Status')].map(cell => cell.getAttribute('aria-sort'))).toEqual(['none', 'ascending'])
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, UPTOWN_PETS, HARBOR, PICKED, PIER_NEW])

  // The row detail holds both columns that are not drawn.
  fireEvent.click(within(table()).getByRole('button', { name: UPTOWN_BEST }))
  const facts = [...rowOf(UPTOWN_BEST).nextElementSibling!.querySelectorAll('dl > div')].map(fact => [...fact.children].map(part => part.textContent))
  expect(facts.slice(-2)).toEqual([['Source', 'Pattern: Bestbest apartments {market}'], ['Last measured', day(MEASURED_AT)]])
})

test('prints the server\'s numbers in the strip, for the project and for a place, never a count of its rows', async () => {
  installApi()
  const { rerender } = renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(UPTOWN_BEST)
  // Eight rows are loaded, six of them asked. Every cell is the server's own field.
  expect(strip()).toEqual({ 'Queries asked': '41', 'Non-brand': '27', Branded: '12' })
  expect(screen.queryByRole('button', { name: '7 not asked' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(within(region()).getByRole('button', { name: '7 not asked' })).toBeTruthy()
  const details = screen.getByRole('button', { name: 'Details' }).getAttribute('aria-controls')!
  expect(within(document.getElementById(details)!).getByText('300')).toBeTruthy()
  expect(screen.queryByText('Left under limit')).toBeNull()
  expect(await within(region()).findByText(`Last sweep ${day(SWEPT_AT)}`)).toBeTruthy()
  expect(within(region()).getByText('Next Oct 21')).toBeTruthy()
  // The default header does not repeat a row count; its 41 asked comes from the server, while six rows are loaded.
  expect(within(region()).queryAllByRole('status')).toEqual([])
  expect(listed()).toHaveLength(6)

  rerender({ selection: { measurementScope: 'market', measurementScopeKey: 'uptown', queryClass: 'all' } })
  expect(strip()).toEqual({ 'Market queries': '7', 'Location queries': '9', Locations: '3', 'Answers per sweep': '96' })
  rerender({ selection: { measurementScope: 'property', measurementScopeKey: 'harbor', queryClass: 'all' } })
  expect(strip()).toEqual({ 'Location queries': '4', 'Market queries': '11', 'Hand-picked queries': '2', Markets: '2', 'Answers per sweep': '51' })
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

  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Subject' }), { target: { value: 'location' } })
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, subject: 'location' })
  // The URL owns the filters: nothing changes until the host passes them back.
  expect(listed()).toHaveLength(6)
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'location' } })
  expect(listed()).toEqual([HARBOR, PIER_NEW])
  expect(count()).toBe('2 of 6 queries')

  // No engine cites the non-brand type of this query; split outcomes have their own filter.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'not-cited' } })
  expect(listed()).toEqual([PICKED])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'partly-cited' } })
  expect(listed()).toEqual([DOWNTOWN, UPTOWN_BEST, PICKED])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  expect(listed()).toEqual([OLD_TOWN, CAMPUS])

  // The search reads the query and its place, and is the page's own: no URL key, no word to the host.
  rerender({ trackedFilters: DEFAULT_TRACKED_FILTERS })
  onTrackedFiltersChange.mockClear()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'harbor' } })
  expect(listed()).toEqual([HARBOR])
  expect(count()).toBe('1 of 6 queries')
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
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
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
  // It is asked on OpenAI and Gemini. Perplexity is an engine only the old sweep asked, so no pair is drawn for it there.
  expect(engineCells(HARBOR)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Not asked'])
  // The same words as AI Visibility: a short label, with the sentence behind it.
  noteButton(label, VISIBILITY_TOOLBAR_COPY.trackingChangedDetail(day(SWEPT_AT), 'Oct 21'), region())
  expect(screen.queryByText('Results unavailable')).toBeNull()
})

test('a location added after the last sweep reads Not checked and First answers, a query asked both ways has a pair per type, and nothing reads as an error', async () => {
  installApi()
  renderWorkspace({ nextSweepDate: 'Oct 21' })
  await screen.findByText(PIER_NEW)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))
  expect(engineCells(PIER_NEW)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked', 'Not asked'])
  // Why it is not checked is in the bubble, after whose result it would be.
  expect(marks(PIER_NEW, 'OpenAI: Not checked')).toBe('Pier House. Not in the last sweep.')
  expect(within(rowOf(PIER_NEW)).getByText('First answers Oct 21')).toBeTruthy()
  expect(within(rowOf(PIER_NEW)).getByText('Never')).toBeTruthy()
  // Branded and non-brand results are never combined: each type keeps its own pair, and Cited is never read from Mentioned.
  expect(chips(PICKED)).toEqual([
    'OpenAI, Branded: Mentioned, Cited', 'OpenAI, Non-brand: Mentioned, Citation not checked',
    'Gemini, Branded: Mentioned, Not cited', 'Gemini, Non-brand: Not mentioned, Not cited',
  ])
  // Neither type of it is asked on Perplexity.
  expect(engineCells(PICKED)[2]).toBe('Not asked')
  expect(screen.queryByText('Results unavailable')).toBeNull()
  expect(screen.queryByText(/^Tracking changed/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('says whose mention a mark is, in the note before the legend and in each bubble, and both follow the Place', async () => {
  // As the server reads a place: under Harbor Point the same market query is checked for that one location, which the answers did not mention.
  const forHarbor = [
    resultRow('q-uptown-best', UPTOWN_BEST, 'non-brand', [{ ...engine('gemini', false, false), expectedAnswers: 1, answers: 1 }, { ...engine('openai', false, false), expectedAnswers: 1, answers: 1 }]),
    resultRow('q-harbor', HARBOR, 'branded', [engine('gemini', true, true), engine('openai', true, true)]),
  ]
  installApi({ results: search => jsonResponse(sweep(search.get('scope') === 'property' ? { scope: { kind: 'property', key: 'harbor' }, rows: forHarbor } : search.get('scope') === 'group' ? { scope: { kind: 'group', key: 'north' } } : {})) })
  const { rerender } = renderWorkspace({ rootLabel: 'All of Acme Homes', trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(chips(UPTOWN_BEST)).toHaveLength(3))
  noteButton("Each query's own locations", OWN_LOCATIONS, region())
  // A market query is lit when any location it is asked for is mentioned: the three of Uptown, as the row's own links count them.
  expect(marks(UPTOWN_BEST, 'OpenAI: Mentioned, Not cited')).toBe('Any of 3 locations in Uptown. Mentioned in 2 of 3 answers. Cited in 0 of 3.')
  expect(marks(HARBOR, 'OpenAI: Mentioned, Cited')).toBe('Harbor Point. Mentioned in 2 of 3 answers. Cited in 1 of 3.')
  // A query asked both ways: each type's pair is for the location asked under that type.
  expect(marks(PICKED, 'OpenAI, Branded: Mentioned, Cited')).toBe('Branded. Harbor Point. Mentioned in 2 of 3 answers. Cited in 1 of 3.')
  expect(marks(PICKED, 'Gemini, Non-brand: Not mentioned, Not cited')).toBe('Non-brand. Pier House. Mentioned in 0 of 3 answers. Cited in 0 of 3.')
  // The name of a pair stays the engine and its two states under every Place.
  expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Not mentioned, Not cited', 'Perplexity: Mentioned, Cited'])

  // The group holds two of Uptown's three locations: the same row is marked for those two.
  rerender({ selection: { measurementScope: 'group', measurementScopeKey: 'north', queryClass: 'all' } })
  await waitFor(() => expect(marks(UPTOWN_BEST, 'OpenAI: Mentioned, Not cited')).toBe('Any of 2 locations in Uptown. Mentioned in 2 of 3 answers. Cited in 0 of 3.'))
  noteButton("Each query's own locations", OWN_LOCATIONS, region())

  // One location: the note names it, and the market row's marks are that location's alone. The Subject still reads the market.
  rerender({ selection: { measurementScope: 'property', measurementScopeKey: 'harbor', queryClass: 'all' } })
  await waitFor(() => expect(marks(UPTOWN_BEST, 'OpenAI: Not mentioned, Not cited')).toBe('Harbor Point. Mentioned in 0 of 1 answer. Cited in 0 of 1.'))
  noteButton('Harbor Point only', 'M and C here are for Harbor Point alone. Under All of Acme Homes a market query is lit when any location in its market is mentioned or cited.', region())
  expect(screen.queryByText("Each query's own locations")).toBeNull()
  expect(rowOf(UPTOWN_BEST).textContent).toContain('Market · Uptown (3)')
  expectNoSentence(region())
})

test('Result Not checked lists the rows with a sweep gap, never a query that is not asked or an engine a row is not asked on', async () => {
  installApi()
  const { rerender } = renderWorkspace({ trackedFilters: { ...ALL_STATUS, result: 'not-checked' }, onTrackedFiltersChange: () => {} })
  await screen.findByText(PIER_NEW)
  // Pier House reviews waits for its first sweep, and one answer for the hand-picked query had its sources partly saved.
  // Downtown and Harbor Point have their OpenAI and Gemini results and are not asked on Perplexity, which is no gap.
  await waitFor(() => expect(listed()).toEqual([PIER_NEW, PICKED]))
  expect(count()).toBe('2 of 8 queries')
  // The two queries that are asked nowhere are under Status, not under a Result.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked', result: 'not-checked' } })
  expect(listed()).toEqual([])
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  expect(listed()).toEqual([OLD_TOWN, CAMPUS])
  // Each is drawn with no pair: its Status says why.
  expect(engineCells(OLD_TOWN)).toEqual(['Not asked', 'Not asked', 'Not asked'])
  expect(within(rowOf(OLD_TOWN)).queryByRole('button', { name: /^(OpenAI|Gemini|Perplexity)[,:]/ })).toBeNull()
})

test('the Add query form opens on the engines the plan is asked with, though the project now lists fewer, and sends them', async () => {
  // The plan was published on three engines. The project's own setting now lists two of them.
  const three = { providers: ['claude', 'gemini', 'openai'], models: {}, location: null }
  const two = { providers: ['gemini', 'openai'], models: {}, location: null }
  const plan = () => {
    const data = portfolio({ defaultContexts: [two] })
    return { ...data, tracked: data.tracked.map(row => ({ ...row, assignments: row.assignments.map(link => ({ ...link, contexts: [three] })) })) }
  }
  const previews: unknown[] = []
  installApi({ workspace: plan, write: (path, body) => { previews.push([path, body]); return jsonResponse(preview({ workspaceVersion: `qtw_${'a'.repeat(64)}` })) } })
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  fireEvent.click(addButton())
  fireEvent.click(within(await screen.findByRole('region', { name: 'Add queries' })).getByRole('button', { name: 'More ways to add' }))
  await screen.findByRole('heading', { name: 'Add query' })
  const choice = screen.getByRole('combobox', { name: 'Search location and engines' }) as HTMLSelectElement
  // The plan's own first and chosen, each engine by its display name. The project's two stay a choice.
  expect([...choice.options].map(option => option.text)).toEqual(['Choose a search location and engines', 'No search location · Claude, Gemini, OpenAI', 'No search location · Gemini, OpenAI'])
  expect(choice.selectedOptions[0]!.text).toBe('No search location · Claude, Gemini, OpenAI')
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'apartments with a gym' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pier House, Location' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(previews).toHaveLength(1))
  expect(previews[0]).toEqual(['/query-tracking/preview', {
    expectedWorkspaceVersion: `qtw_${'a'.repeat(64)}`,
    additions: [{ input: { source: 'manual', text: 'apartments with a gym' }, audience: { targetKeys: ['pier'] }, contexts: [three] }],
    removals: [],
  }])
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
  expect(within(linked.nextElementSibling as HTMLElement).getByRole('table', { name: 'Counts for' })).toBeTruthy()
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
  installApi({ workspace: () => portfolio({ tracked: [], views: VIEWS }) })
  const first = renderWorkspace()
  await screen.findByText('No queries yet')
  // Empty tracking still has places to inspect and fill: Views must remain reachable without a search toolbar.
  fireEvent.click(viewButton('Location gaps'))
  expect(first.onSelectionChange).toHaveBeenLastCalledWith({ trackedView: 'no-location-queries' })
  first.rerender({ trackedView: 'no-location-queries' })
  expect(await screen.findByRole('table', { name: 'Location gaps' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add location query for River Point' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back to queries' }))
  expect(first.onSelectionChange).toHaveBeenLastCalledWith({ trackedView: undefined })
  first.rerender({ trackedView: undefined })
  const none = (await screen.findByText('No queries yet')).closest('td')!
  expect(screen.queryByRole('searchbox', { name: 'Search queries' })).toBeNull()
  // Nothing to tick, so no box is drawn.
  expect(screen.queryAllByRole('checkbox')).toEqual([])
  const add = within(none).getByRole('button', { name: 'Add queries' })
  const primary = within(screen.getByRole('tablist', { name: 'Query workspace' }).nextElementSibling as HTMLElement).getByRole('button', { name: 'Add queries' })
  expect(primary.className.split(' ')).toContain('bg-accent')
  expect(add.className.split(' ')).not.toContain('bg-accent')
  fireEvent.click(add)
  expect(await screen.findByRole('region', { name: 'Add queries' })).toBeTruthy()
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
  expect(count()).toBe('0 of 6 queries')
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
  expect(first.onSelectionChange).toHaveBeenCalledTimes(2)
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
  const { rerender } = renderWorkspace({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'partly-mentioned' }, onTrackedFiltersChange: () => {} })
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
  expect(count()).toBe('3 of 6 queries')

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
  await waitFor(() => expect(engineCells(PICKED)).toEqual(['OpenAI: Mentioned, Cited', 'Gemini: Mentioned, Not cited', 'Not asked']))
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
  // On each of the two engines it is asked on. Perplexity is the old sweep's alone.
  await waitFor(() => expect(chips(PICKED)).toHaveLength(4))
  expect(typeOf(PICKED)).toBe('MixedBrandedNon-brand')
})

test('a place keeps only its own engine assignments even when the query has the same type elsewhere', async () => {
  const on = (targetKey: string, provider: string) => ({
    ...pairing(targetKey, [], 'non-brand'),
    contexts: [{ ...context, providers: [provider], models: {} }],
  })
  const workspace = portfolio({ tracked: [tracked('q-picked', PICKED, { kind: 'custom' }, [on('harbor', 'openai'), on('pier', 'gemini')])] })
  installApi({
    workspace: () => workspace,
    results: search => jsonResponse(sweep({
      scope: search.get('scope') === 'property' ? { kind: 'property', key: 'harbor' } : { kind: 'project', key: null },
      engines: ['openai', 'gemini'],
      rows: [resultRow('q-picked', PICKED, 'non-brand', [engine('openai', true, false)])],
    })),
  })
  const { rerender } = renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'harbor', queryClass: 'all' }, trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText(PICKED)
  await waitFor(() => expect(engineCells(PICKED)).toEqual(['OpenAI: Mentioned, Not cited', 'Not asked']))

  // Gemini belongs only to Pier House, so Harbor Point has no missing answer to filter for.
  rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, result: 'not-checked' } })
  expect(listed()).toEqual([])
  // At project scope Gemini really was asked; its absent result is a sweep gap.
  rerender({ selection: PROJECT, trackedFilters: DEFAULT_TRACKED_FILTERS })
  await waitFor(() => expect(engineCells(PICKED)).toEqual(['OpenAI: Mentioned, Not cited', 'Gemini: Not checked']))
})

test('a location keeps both query types and only the engine contexts each type uses', async () => {
  const branded = { ...context, providers: ['openai'], models: {}, queryClass: 'branded' as const, marketKeys: ['uptown'] }
  const nonBrand = { ...context, providers: ['gemini'], models: {}, queryClass: 'non-brand' as const, marketKeys: ['downtown'] }
  installApi({
    workspace: () => portfolio({ tracked: [tracked('q-picked', PICKED, { kind: 'custom' }, [{
      ...pairing('harbor', ['uptown', 'downtown'], 'non-brand'),
      contexts: [{ ...context, providers: ['openai'], models: {} }, { ...context, providers: ['gemini'], models: {} }],
      classifiedContexts: [branded, nonBrand],
    }], { queryClasses: ['branded', 'non-brand'] })] }),
    results: () => jsonResponse(sweep({ engines: ['openai', 'gemini'], rows: [] })),
  })
  const { rerender } = renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'harbor', queryClass: 'all' }, trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: () => {} })
  await screen.findByText(PICKED)
  await waitFor(() => expect(chips(PICKED)).toEqual(['OpenAI, Branded: Not checked', 'Gemini, Non-brand: Not checked']))
  expect(within(rowOf(PICKED)).queryByRole('button', { name: 'OpenAI, Non-brand: Not checked' })).toBeNull()
  expect(within(rowOf(PICKED)).queryByRole('button', { name: 'Gemini, Branded: Not checked' })).toBeNull()

  // The same location belongs to two markets, each with its own context and type.
  rerender({ selection: UPTOWN_PLACE })
  await waitFor(() => expect(chips(PICKED)).toEqual(['OpenAI: Not checked']))
  expect(engineCells(PICKED)).toEqual(['OpenAI: Not checked', 'Not asked'])
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
  // These Market and Location rows already have their fixed type, so only Stop applies to both.
  expect(bar.getAllByRole('button').map(button => button.textContent)).toEqual(['Stop tracking', 'Select all 4', 'Clear'])
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

  // A hand-picked row can change type, so the first action has a different position from Clear.
  select(PICKED)
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

test('each page of rows takes its own height: one line where its text fits and two where a query does not, after a page turn, a search and a sort', async () => {
  frameWidth(1152)
  // The sixty short queries are 133px. The long one is 511px, past one line of the 424px column, and sorts after them.
  queryColumn(424)
  const LONG = 'apartments with in unit washer dryer Northbridge Heights, Lakeshore metro'
  installApi({ workspace: () => portfolio({ tracked: [...longPortfolio().tracked, tracked('q-long', LONG, { kind: 'market', key: 'uptown' }, uptown())] }), results: () => jsonResponse(sweep({ rows: [] })) })
  renderWorkspace()
  await screen.findByText('apartments query 01')
  const lines = () => table().getAttribute('data-lines')
  expect([listed().length, listed().includes(LONG), lines()]).toEqual([50, false, '1'])

  // The second page holds the long query, so every row there takes two lines.
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  expect([listed().length, listed().at(-1), lines()]).toEqual([11, LONG, '2'])
  fireEvent.click(screen.getByRole('button', { name: /Previous/ }))
  expect(lines()).toBe('1')

  // A search that lists it, and one that does not.
  fireEvent.change(searchBox(), { target: { value: 'washer' } })
  expect([listed(), lines()]).toEqual([[LONG], '2'])
  fireEvent.change(searchBox(), { target: { value: 'query 0' } })
  expect([listed().length, lines()]).toEqual([15, '1'])
  fireEvent.change(searchBox(), { target: { value: '' } })
  expect(lines()).toBe('1')

  // A sort that brings it to the first page.
  fireEvent.click(within(table()).getByRole('button', { name: 'Query' }))
  expect([listed()[0], lines()]).toEqual(['apartments query 01', '1'])
  fireEvent.click(within(table()).getByRole('button', { name: 'Query' }))
  expect([listed()[0], lines()]).toEqual([LONG, '2'])
})

test('ticked rows stay ticked from page to page, the whole list is offered only when one change can take it, and a longer selection is told the limit', async () => {
  // Hand-picked rows can change type as well as stop, so the limit must disable both available actions.
  const handPickedPortfolio = () => portfolio({ tracked: longPortfolio().tracked.map(row => tracked(
    row.queryId, row.queryText, { kind: 'custom' }, [pairing('harbor', ['uptown', 'downtown'], 'branded', ['north']), pairing('pier', [], 'non-brand')],
  )) })
  installApi({ workspace: handPickedPortfolio, results: () => jsonResponse(sweep({ rows: [] })) })
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

  // Track opens the Add queries page with the texts, one query per line.
  fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Track' }))
  const sheet = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect((sheet.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(`${OLD_TOWN}\n${CAMPUS}`)
  expect(sheet.getByText('2 queries · 957 left')).toBeTruthy()
})

test('a row menu opens the action sheet for one row, tracks a row that is not asked, and copies a link that marks the row', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  stubClipboard(writeText)
  installApi()
  const props = renderWorkspace({ trackedFilters: ALL_STATUS, onTrackedFiltersChange: () => {} })
  await screen.findByText(OLD_TOWN)

  const sheet = await openRowSheet(HARBOR, 'Change Subject')
  expect(sheet.getByText(HARBOR)).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  await chooseRowAction(OLD_TOWN, 'Track')
  const add = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect((add.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe(OLD_TOWN)
  fireEvent.click(add.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Add queries' })).toBeNull())
  // The Add button opens the sheet empty: the tracked text was for that one opening.
  fireEvent.click(addButton())
  const plain = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect((plain.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe('')
  fireEvent.click(plain.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Add queries' })).toBeNull())

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
  const links = within(rowOf(UPTOWN_BEST).nextElementSibling as HTMLElement).getByRole('table', { name: 'Counts for' })
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

  // The Add page unmounts the list: its slash shortcut no longer intercepts form input.
  fireEvent.click(addButton())
  const queries = within(await screen.findByRole('region', { name: 'Add queries' })).getByLabelText('Queries')
  expect(slash(queries)).toBe(true)
  expect(slash(within(await screen.findByRole('region', { name: 'Add queries' })).getByRole('button', { name: 'Cancel' }))).toBe(true)
  expect(document.activeElement).not.toBe(search)
})

// ── Export CSV ──

/** Stands in for the browser's file save: jsdom has no object URLs and follows no download link. Gives each saved file's name and text. */
function captureDownloads() {
  const files: { name: string; text: Promise<string> }[] = []
  let saved: Blob | undefined
  const { createObjectURL, revokeObjectURL } = URL
  URL.createObjectURL = (blob: Blob) => { saved = blob; return 'blob:tracked-queries' }
  URL.revokeObjectURL = () => {}
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = saved!
    files.push({ name: this.download, text: new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob) }) })
  })
  onTestFinished(() => {
    click.mockRestore()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })
  return files
}
const exportButton = () => screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement
const csvLines = async (file: { text: Promise<string> }) => (await file.text).trimEnd().split('\r\n')

test.each([['a writer', false], ['a viewer', true]] as const)('Export CSV saves the list as it is searched and sorted, over every page, for %s, and telemetry hears no query text', async (_who, viewer) => {
  // Sixty queries, one of them measured: mentioned by one engine with its sources partly saved, and not by another.
  const measured = resultRow('q-0', 'apartments query 01', 'non-brand', [engine('gemini', false, false), engine('openai', true, null)])
  const requests = installApi({ workspace: longPortfolio, results: () => jsonResponse(sweep({ rows: [measured] })) })
  const sent: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async (event) => { sent.push(event); return { accepted: true } } })
  onTestFinished(() => resetUiTelemetryForTests())
  const files = captureDownloads()
  if (viewer) renderViewerWorkspace()
  else renderWorkspace()
  await screen.findByText('apartments query 01')
  // The file holds the chips' own states, so it waits for the results.
  await waitFor(() => expect(exportButton().disabled).toBe(false))
  // Beside the tabs, before the page's one primary action.
  const slot = screen.getByRole('tablist', { name: 'Query workspace' }).nextElementSibling as HTMLElement
  expect(within(slot).getAllByRole('button').map(button => button.textContent)).toEqual(viewer ? ['Export CSV'] : ['Export CSV', 'Add queries'])

  fireEvent.click(exportButton())
  expect(files.map(file => file.name)).toEqual(['canonry-tracked-queries-demo-2026-10-10.csv'])
  const all = await csvLines(files[0]!)
  // Every listed query, though the page shows fifty of them.
  expect(listed()).toHaveLength(50)
  expect(all).toHaveLength(61)
  expect(all[0]).toBe('query,query_class,subject,place,marks_for,status,last_measured,source,openai_mentioned,openai_cited,gemini_mentioned,gemini_cited,perplexity_mentioned,perplexity_cited')
  // Each line says whose results it holds. Cited is never read from Mentioned, and an engine with no result is not checked, not a no.
  // No query here is asked on Perplexity, which only the old sweep asked: its two cells are empty, not a sweep gap.
  expect(all[1]).toBe(`apartments query 01,Non-brand,Market,Uptown,Any of 3 locations in Uptown,Measured,${MEASURED_AT},Manual,yes,not checked,no,no,,`)
  expect(all[60]).toBe(`apartments query 60,Non-brand,Market,Uptown,Any of 3 locations in Uptown,Measured,${MEASURED_AT},Manual,${Array(4).fill('not checked').join(',')},,`)

  // The search and the order of the list are the file's.
  fireEvent.change(searchBox(), { target: { value: 'query 0' } })
  fireEvent.click(within(table()).getByRole('button', { name: 'Query' }))
  fireEvent.click(within(table()).getByRole('button', { name: 'Query' }))
  fireEvent.click(exportButton())
  const searched = await csvLines(files[1]!)
  // Fifteen queries hold both words, last first.
  expect(searched.slice(1).map(line => line.split(',')[0]!.slice('apartments query '.length))).toEqual(['60', '50', '40', '30', '20', '10', '09', '08', '07', '06', '05', '04', '03', '02', '01'])
  // A file of a narrowed list says so in its name, so it is not taken for the whole list.
  expect(files[1]!.name).toBe('canonry-tracked-queries-demo-filtered-2026-10-10.csv')

  // One action per file, with its format and nothing of what the file holds.
  expect(sent.flatMap(event => event.event === 'ui.action' && event.action === 'export.download' ? [event.format] : [])).toEqual(['csv', 'csv'])
  expect(JSON.stringify(sent)).not.toMatch(/apartments|query 0|Uptown/i)
  // The file is built from what the page has read: nothing was requested for it.
  expect(requests).toEqual(['GET /query-tracking', 'GET /measurement-query-templates', 'GET /query-tracking/results'])
})

test('Export CSV is off while the results are read and after they fail, and is not offered with no query to save', async () => {
  const waiting: Array<(response: Response) => void> = []
  installApi({ results: () => new Promise<Response>(resolve => waiting.push(resolve)) })
  renderViewerWorkspace()
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(waiting).toHaveLength(1))
  expect(exportButton().disabled).toBe(true)
  // A file of a failed read would say "not checked" for every engine, and nothing in it would say why.
  waiting.shift()!(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500))
  const retry = await screen.findByRole('button', { name: 'Retry results' })
  expect(exportButton().disabled).toBe(true)
  fireEvent.click(retry)
  await waitFor(() => expect(waiting).toHaveLength(1))
  waiting.shift()!(jsonResponse(sweep()))
  await waitFor(() => expect(exportButton().disabled).toBe(false))
  cleanup()

  installApi({ workspace: () => portfolio({ tracked: [] }) })
  renderViewerWorkspace()
  await screen.findByText('No queries yet')
  expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  // With nothing in it, the slot beside the tabs holds no room.
  expect(screen.getByRole('tablist', { name: 'Query workspace' }).nextElementSibling!.childElementCount).toBe(0)
})

test('a file of one place carries the place\'s key in its name, and an embed is offered no file', async () => {
  installApi({ results: search => jsonResponse(sweep({ scope: { kind: search.get('scope') ?? 'project', key: search.get('scopeKey') } })) })
  const files = captureDownloads()
  renderViewerWorkspace({ selection: UPTOWN_PLACE })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(exportButton().disabled).toBe(false))
  fireEvent.click(exportButton())
  expect(files.map(file => file.name)).toEqual(['canonry-tracked-queries-demo-uptown-2026-10-10.csv'])
  // The market's own four queries: the rows the page lists there.
  expect(await csvLines(files[0]!)).toHaveLength(5)
  cleanup()

  window.__CANONRY_CONFIG__ = { embed: { enabled: true } } as typeof window.__CANONRY_CONFIG__
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  // The results are read, which is when a file would be offered.
  await screen.findAllByRole('button', { name: /^Perplexity[,:]/ })
  expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
})

// ── Saved views ──

/**
 * The views as the reads list them. Each count is the server's own and differs from the length of its list,
 * so a number worked out from the keys would show. The summary's are 7 not asked and 3 hand-picked.
 */
const VIEWS = {
  noPropertyQueries: { count: 5, targetKeys: ['summit', 'river'] },
  thinMarkets: { count: 9, floor: 4, marketKeys: ['downtown', 'lakeview'] },
  patternGaps: { count: 2, patterns: [{ templateId: 'template-best', name: 'Best', pattern: 'best apartments {market}', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] }] },
}
const WEAK = { rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 4, marketKeys: ['downtown'] }
const withViews = () => portfolio({ views: VIEWS })
/** The same project before its first sweep: no query has a result yet. */
const neverSwept = () => portfolio({ views: VIEWS, tracked: withViews().tracked.map(row => ({ ...row, state: 'awaiting-sweep', lastMeasuredAt: null })) })
const noSweep = () => jsonResponse(sweep({ run: null, engines: [], rows: [], pendingRows: 6 }))
/** A results read the test answers when it chooses: each call waits in `waiting` for its response. */
function heldResults() {
  const waiting: Array<(response: Response) => void> = []
  return { waiting, results: () => new Promise<Response>(resolve => waiting.push(resolve)) }
}
const weakSweep = () => jsonResponse(sweep({ weakMarkets: WEAK }))
function openViews() {
  const trigger = screen.getByRole('button', { name: /^Views(?: ·|$)/ })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  return screen.getByRole('group', { name: 'Views' })
}
const viewButtons = () => within(openViews()).getAllByRole('button')
/** Each view by its name: the view, the type its number is of where it has one, and the number. */
const viewNames = () => viewButtons().map(button => button.getAttribute('aria-label'))
const viewButton = (label: string) => viewButtons().find(button => button.getAttribute('aria-label')!.startsWith(label))!
const pressedViews = () => viewButtons().filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.getAttribute('aria-label'))
/** The rows of a view's list, each as its cells' text. */
const placeRows = (name: string) => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1).map(row => [...(row as HTMLTableRowElement).cells].map(cell => cell.textContent))
const lastPatch = (props: { onSelectionChange?: unknown }) => vi.mocked(props.onSelectionChange as (patch: Record<string, unknown>) => void).mock.calls.at(-1)![0]

test('Views opens beside the search and prints each read\'s own count, for the whole project only', async () => {
  installApi({ workspace: withViews, results: search => search.get('scope') ? jsonResponse(sweep({ scope: { kind: search.get('scope'), key: search.get('scopeKey') } })) : weakSweep() })
  const { rerender } = renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  // 5, 9 and 2 are the workspace's counts over lists of 2, 2 and 1; 4 is the results' over a list of 1; 7 and 3 are the summary's.
  await waitFor(() => expect(viewNames()).toEqual([
    'Location gaps, 5', 'Thin markets, 9', 'Pattern gaps, 2', 'Weakest markets, non-brand queries, 4', 'Not asked, 7', 'Hand-picked, 3',
  ]))
  expect(pressedViews()).toEqual([])
  const order = [region().querySelector('dl')!, searchBox(), screen.getByRole('button', { name: 'Views' }), table()]
  for (const [index, element] of order.slice(1).entries()) expect(order[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expectNoSentence(region())

  // A place has its own strip and its own list, and the server lists the views for no place: a view in the URL waits for the whole project.
  rerender({ selection: UPTOWN_PLACE, trackedView: 'thin-markets' })
  expect(screen.queryByRole('group', { name: 'Views' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to queries' })).toBeNull()
  expect(listed()).toEqual([UPTOWN_BEST, UPTOWN_PETS, HARBOR, PICKED])
})

test('a workspace read with no views draws no Views row', async () => {
  installApi()
  renderWorkspace({ trackedView: 'thin-markets' })
  await screen.findByText(UPTOWN_BEST)
  expect(screen.queryByRole('group', { name: 'Views' })).toBeNull()
  expect(listed()).toHaveLength(6)
})

test('before a first sweep there is no Weakest markets view and no room is held for one, and a URL that names it or no view at all lists the queries', async () => {
  const held = heldResults()
  installApi({ workspace: neverSwept, results: held.results })
  const { rerender } = renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(held.waiting).toHaveLength(1))
  // No query has a result, so no sweep is expected: the row is drawn as it will stay, with nothing to press that the results would take away.
  const five = ['Location gaps, 5', 'Thin markets, 9', 'Pattern gaps, 2', 'Not asked, 7', 'Hand-picked, 3']
  expect(viewNames()).toEqual(five)
  held.waiting.shift()!(noSweep())
  await waitFor(() => expect(chips(UPTOWN_BEST)).toEqual(['OpenAI: Not checked', 'Gemini: Not checked']))
  expect(viewNames()).toEqual(five)

  rerender({ trackedView: 'weak-markets' })
  expect(listed()).toHaveLength(6)
  expect(viewNames()).toEqual(five)
  expect(pressedViews()).toEqual([])
  expect(screen.queryByRole('button', { name: 'Back to queries' })).toBeNull()

  rerender({ trackedView: 'not-a-view' })
  expect(listed()).toHaveLength(6)
  expect(screen.queryByRole('button', { name: 'Back to queries' })).toBeNull()
})

test('after a sweep Weakest markets holds its place while the results load and after they fail, so the row does not move', async () => {
  const held = heldResults()
  installApi({ workspace: withViews, results: held.results })
  renderWorkspace()
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(held.waiting).toHaveLength(1))
  // The workspace's rows have results, so a sweep is known: the button is there with no number yet.
  const waiting = ['Location gaps, 5', 'Thin markets, 9', 'Pattern gaps, 2', 'Weakest markets, non-brand queries', 'Not asked, 7', 'Hand-picked, 3']
  expect(viewNames()).toEqual(waiting)
  held.waiting.shift()!(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500))
  await screen.findByRole('button', { name: 'Retry results' })
  expect(viewNames()).toEqual(waiting)
  expect(viewButton('Weakest markets').querySelector('.skeleton-text')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Retry results' }))
  await waitFor(() => expect(held.waiting).toHaveLength(1))
  held.waiting.shift()!(weakSweep())
  await waitFor(() => expect(viewNames()[3]).toBe('Weakest markets, non-brand queries, 4'))
})

test('Not asked and Hand-picked set a filter of the query list on a clean search, and a second press takes only that filter off', async () => {
  installApi({ workspace: withViews })
  const onTrackedFiltersChange = vi.fn()
  const props = renderWorkspace({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' }, onTrackedFiltersChange })
  await screen.findByText(HARBOR)
  fireEvent.change(searchBox(), { target: { value: 'harbor' } })

  // The count is of every query that is not asked, so the other filters and the search are cleared for it.
  fireEvent.click(viewButton('Not asked'))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
  expect(searchBox().value).toBe('')
  props.rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' } })
  expect(listed()).toEqual([OLD_TOWN, CAMPUS])
  expect(pressedViews()).toEqual(['Not asked, 7'])
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('not-asked')
  // A second press puts Status back.
  fireEvent.click(viewButton('Not asked'))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith(DEFAULT_TRACKED_FILTERS)

  fireEvent.click(viewButton('Hand-picked'))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, subject: 'hand-picked' })
  props.rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'hand-picked' } })
  expect(listed()).toEqual([PICKED])
  expect(pressedViews()).toEqual(['Hand-picked, 3'])

  // What was narrowed after the press is the reader's: the second press takes Subject off and leaves the Type filter and the search.
  props.rerender({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, subject: 'hand-picked', type: 'mixed' } })
  fireEvent.change(searchBox(), { target: { value: 'pool' } })
  expect(pressedViews()).toEqual(['Hand-picked, 3'])
  fireEvent.click(viewButton('Hand-picked'))
  expect(onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, type: 'mixed' })
  expect(searchBox().value).toBe('pool')
  // They are filters of this list: no view is written to the URL.
  expect(props.onSelectionChange).not.toHaveBeenCalled()
})

test('a view lists its places in place of the queries, with its name and the way back, and Back returns the table and the focus', async () => {
  installApi({ workspace: withViews, results: weakSweep })
  const props = renderWorkspace({ trackedFilters: DEFAULT_TRACKED_FILTERS, onTrackedFiltersChange: vi.fn() })
  await screen.findByText(UPTOWN_BEST)
  await waitFor(() => expect(viewButtons()).toHaveLength(6))
  select(UPTOWN_BEST)
  expect(bulkBar()).not.toBeNull()

  fireEvent.click(viewButton('Thin markets'))
  expect(lastPatch(props)).toEqual({ trackedView: 'thin-markets' })
  // The URL owns the view: nothing changes until the host passes it back.
  expect(table()).toBeTruthy()

  props.rerender({ trackedView: 'thin-markets' })
  expect(screen.queryByRole('table', { name: 'Queries' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull()
  expect(screen.queryByRole('searchbox', { name: 'Search queries' })).toBeNull()
  // The file holds queries and the bar acts on ticked ones: neither is offered over a list of markets.
  expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  expect(bulkBar()).toBeNull()
  expect(addButton().textContent).toBe('Add queries')
  noteButton('View: Thin markets', 'Markets with fewer than 4 market queries.', region())
  expect(pressedViews()).toEqual(['Thin markets, 9'])
  // The two markets the server listed, the thinnest first, with each market's own numbers. The count over them is the read's, as on the button.
  expect(placeRows('Thin markets')).toEqual([['Lakeview', 'None', '0', '0', 'No locations'], ['Downtown, Lakeshore', 'None', '1', '3', 'Add market query']])
  expect(within(region()).getAllByRole('status').map(status => status.textContent)).toContain('9 markets')
  // The strip above keeps the project's numbers.
  expect(strip()['Queries asked']).toBe('41')
  // "/" reaches the search of the list that is up.
  fireEvent.keyDown(document.body, { key: '/' })
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search markets' }))

  // Another view replaces this one, and a filter view closes it for the queries it lists.
  fireEvent.click(viewButton('Weakest markets'))
  expect(lastPatch(props)).toEqual({ trackedView: 'weak-markets' })
  fireEvent.click(viewButton('Not asked'))
  expect(lastPatch(props)).toEqual({ trackedView: undefined })
  expect(props.onTrackedFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' })
  // A second press of the open view closes it too.
  fireEvent.click(viewButton('Thin markets'))
  expect(lastPatch(props)).toEqual({ trackedView: undefined })
  // The strip's own link lists queries, so it closes the view as well, and sets its filter on a clean list.
  vi.mocked(props.onSelectionChange).mockClear()
  vi.mocked(props.onTrackedFiltersChange!).mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  fireEvent.click(screen.getByRole('button', { name: '7 not asked' }))
  expect(vi.mocked(props.onSelectionChange).mock.calls).toEqual([[{ trackedView: undefined }]])
  expect(vi.mocked(props.onTrackedFiltersChange!).mock.calls).toEqual([[{ ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' }]])

  // Each view starts with a clean search of its own.
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search markets' }), { target: { value: 'lake' } })
  props.rerender({ trackedView: 'weak-markets' })
  expect((screen.getByRole('searchbox', { name: 'Search markets' }) as HTMLInputElement).value).toBe('')
  props.rerender({ trackedView: 'thin-markets' })

  const calls = vi.mocked(props.onSelectionChange).mock.calls.length
  const back = screen.getByRole('button', { name: 'Back to queries' })
  back.focus()
  fireEvent.click(back)
  expect(vi.mocked(props.onSelectionChange).mock.calls.slice(calls)).toEqual([[{ trackedView: undefined }]])
  props.rerender({ trackedView: undefined })
  expect(listed()).toHaveLength(6)
  expect(pressedViews()).toEqual([])
  // Back went with its list, so the search of the queries holds the focus.
  expect(document.activeElement).toBe(searchBox())
  // No query stayed ticked behind the view.
  expect(bulkBar()).toBeNull()
  expect(exportButton()).toBeTruthy()
})

test('Add from a view\'s row opens the Add queries page on that market or location, and a market with no location offers none', async () => {
  const previews: unknown[] = []
  installApi({ workspace: withViews, write: (path, body) => { previews.push([path, body]); return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'not reviewed here' } }, 400) } })
  const { rerender } = renderWorkspace({ trackedView: 'thin-markets' })

  fireEvent.click(await screen.findByRole('button', { name: 'Add market query for Downtown, Lakeshore' }))
  let sheet = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect(sheet.getByRole('radio', { name: 'Market' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.getByText('Downtown · Market')).toBeTruthy()
  fireEvent.change(sheet.getByLabelText('Queries'), { target: { value: 'lofts downtown' } })
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(previews).toHaveLength(1))
  // The market's own addition, as the sheet sends it from the Add button on that market.
  expect(previews[0]).toEqual(['/query-tracking/preview', {
    expectedWorkspaceVersion: `qtw_${'a'.repeat(64)}`,
    additions: [{ input: { source: 'manual', text: 'lofts downtown' }, audience: { marketKeys: ['downtown'] } }],
    removals: [],
  }])
  fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  // Returning from Review keeps the draft: closing it needs an explicit discard.
  expect((sheet.getByLabelText('Queries') as HTMLTextAreaElement).value).toBe('lofts downtown')
  expect(await screen.findByRole('region', { name: 'Add queries' })).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Add queries' })).toBeNull())

  // The server would refuse a query for a market with no location, so the row says why in place of the button.
  const emptied = within(screen.getByRole('table', { name: 'Thin markets' })).getByText('Lakeview').closest('tr')!
  noteButton('No locations', 'A market with no location takes no query.', emptied)
  expect(within(emptied).queryByRole('button', { name: /^Add / })).toBeNull()

  // "More ways to add" hands the sheet's place on: the Add query form opens with that market ticked, not on the page's place.
  fireEvent.click(screen.getByRole('button', { name: 'Add market query for Downtown, Lakeshore' }))
  fireEvent.click(within(await screen.findByRole('region', { name: 'Add queries' })).getByRole('button', { name: 'More ways to add' }))
  await screen.findByRole('heading', { name: 'Add query' })
  expect((screen.getByRole('checkbox', { name: 'Downtown, Lakeshore, Market' }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getAllByRole('checkbox').filter(box => (box as HTMLInputElement).checked)).toHaveLength(1)
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Add queries' })).toBeNull())

  rerender({ trackedView: 'no-location-queries' })
  expect(placeRows('Location gaps')).toEqual([['River Point', 'North', '', 'Add location query'], ['Summit Lofts', 'None', '', 'Add location query']])
  fireEvent.click(screen.getByRole('button', { name: 'Add location query for River Point' }))
  sheet = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect(sheet.getByRole('radio', { name: 'Location' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.getByText('river · Location')).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Add queries' })).toBeNull())

  // The page's own Add button opens the sheet on no place: the row's place was for that one opening.
  fireEvent.click(addButton())
  sheet = within(await screen.findByRole('region', { name: 'Add queries' }))
  expect(sheet.getByRole('radio', { name: 'Market' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.queryByText(/ · (Market|Location)$/)).toBeNull()
})

/** The filters as the URL holds them, each under its own key. A key that is cleared is in the patch, with no value. */
const CLEAN_FILTER_KEYS = { trackedSubject: undefined, trackedType: undefined, trackedStatus: undefined, trackedSource: undefined, trackedResult: undefined }

test.each((['writer', 'viewer'] as const).flatMap(role => [
  ['a location', role, 'no-location-queries', undefined, 'River Point', { measurementScope: 'property', measurementScopeKey: 'river' }],
  ['a market', role, 'thin-markets', undefined, 'Downtown, Lakeshore', { measurementScope: 'market', measurementScopeKey: 'downtown' }],
  ['a market behind a pattern\'s count', role, 'pattern-gaps', 'Show 1 market missing Best: Downtown, Lakeshore', 'Downtown, Lakeshore', { measurementScope: 'market', measurementScopeKey: 'downtown' }],
] as const))('the name of %s opens its queries for a %s: the Place, the view closed and the filters clean, in one patch', async (_kind, role, trackedView, count, name, place) => {
  installApi({ workspace: withViews })
  const onSelectionChange = vi.fn()
  const onTrackedFiltersChange = vi.fn()
  // Filters set before the view opened are still in the URL behind it.
  const props = { trackedView, onSelectionChange, trackedFilters: { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' as const, subject: 'hand-picked' as const }, onTrackedFiltersChange }
  if (role === 'viewer') renderViewerWorkspace(props)
  else renderWorkspace(props)
  if (count) fireEvent.click(await screen.findByRole('button', { name: count }))
  const control = await screen.findByRole('button', { name: `Open ${name}` })
  expect(control.textContent).toBe(name)

  fireEvent.click(control)
  // The Place picker's own two keys, the view's key and each filter's, cleared: every key is in the one patch.
  expect(onSelectionChange.mock.calls).toStrictEqual([[{ ...place, trackedView: undefined, ...CLEAN_FILTER_KEYS }]])
  // Nothing else goes to the host, so the browser's Back is one step to the view's list.
  expect(onTrackedFiltersChange).not.toHaveBeenCalled()
})

test('a place opened from a view lists its queries on a clean search, and the Place control takes the focus the name dropped', async () => {
  installApi({ workspace: withViews })
  // The Place control as the project page draws it, above the section.
  const options = portfolio().scopeOptions
  const header = render(<VisibilityScopePicker labelVisibility="sr-only" options={options} selected={options[0]} onSelect={() => {}} />)
  const placeControl = header.container.querySelector('summary')!
  const props = renderWorkspace({ trackedFilters: { ...DEFAULT_TRACKED_FILTERS, type: 'branded' }, onTrackedFiltersChange: vi.fn() })
  await screen.findByText(HARBOR)
  fireEvent.change(searchBox(), { target: { value: 'harbor point' } })
  expect(listed()).toEqual([HARBOR])

  props.rerender({ trackedView: 'thin-markets' })
  const market = screen.getByRole('button', { name: 'Open Downtown, Lakeshore' })
  market.focus()
  fireEvent.click(market)
  // The URL owns the place and the view: nothing moves until the host passes them back.
  expect(screen.getByRole('table', { name: 'Thin markets' })).toBeTruthy()
  expect(document.activeElement).toBe(market)

  props.rerender({ selection: { measurementScope: 'market', measurementScopeKey: 'downtown', queryClass: 'all' }, trackedView: undefined, trackedFilters: DEFAULT_TRACKED_FILTERS })
  expect(screen.queryByRole('table', { name: 'Thin markets' })).toBeNull()
  // Every query asked in the market, of either type: the search typed before the view opened is gone with the filters.
  expect(searchBox().value).toBe('')
  expect(listed()).toEqual([DOWNTOWN, HARBOR])
  expect(strip()['Market queries']).toBe('3')
  // The name went with its list. The Place control holds the focus, as it does after a place is chosen from it.
  expect(document.activeElement).toBe(placeControl)

  // On a page with no Place control, the search of the place's queries takes it.
  header.unmount()
  props.rerender({ selection: PROJECT, trackedView: 'no-location-queries', trackedFilters: DEFAULT_TRACKED_FILTERS })
  const location = screen.getByRole('button', { name: 'Open River Point' })
  location.focus()
  fireEvent.click(location)
  props.rerender({ selection: { measurementScope: 'property', measurementScopeKey: 'river', queryClass: 'all' }, trackedView: undefined, trackedFilters: DEFAULT_TRACKED_FILTERS })
  expect(listed()).toEqual([UPTOWN_BEST, UPTOWN_PETS])
  expect(document.activeElement).toBe(searchBox())
})

test('a viewer opens a view and reads its list, with no action to take', async () => {
  installApi({ workspace: withViews })
  renderViewerWorkspace({ trackedView: 'thin-markets' })
  expect(await screen.findByRole('table', { name: 'Thin markets' })).toBeTruthy()
  expect(placeRows('Thin markets')).toEqual([['Lakeview', 'None', '0', '0'], ['Downtown, Lakeshore', 'None', '1', '3']])
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
  expect(within(region()).getAllByRole('button').filter(button => (button as HTMLButtonElement).disabled)).toEqual([])
  expect(screen.getByRole('button', { name: 'Back to queries' })).toBeTruthy()
})

test('Weakest markets waits for the results, a failed read offers Retry, and the list is the markets the results name', async () => {
  const held = heldResults()
  const requests = installApi({ workspace: withViews, results: held.results })
  renderWorkspace({ trackedView: 'weak-markets' })
  // The results are still being read: rows stand in for the markets, never "No weak markets", and the view's button is on with no number yet.
  expect(await screen.findByRole('status', { name: 'Loading markets' })).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('No weak markets')).toBeNull()
  expect(viewNames()).toEqual(['Location gaps, 5', 'Thin markets, 9', 'Pattern gaps, 2', 'Weakest markets, non-brand queries', 'Not asked, 7', 'Hand-picked, 3'])
  expect(pressedViews()).toEqual(['Weakest markets, non-brand queries'])

  held.waiting.shift()!(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500))
  const failed = await screen.findByRole('alert')
  expect(failed.textContent).toBe('Could not loadRetry')
  expect(screen.queryByRole('table')).toBeNull()
  // The open view keeps its button, pressed, where it was.
  expect(viewButtons()).toHaveLength(6)
  expect(pressedViews()).toEqual(['Weakest markets, non-brand queries'])

  fireEvent.click(within(failed).getByRole('button', { name: 'Retry results' }))
  await waitFor(() => expect(held.waiting).toHaveLength(1))
  held.waiting.shift()!(weakSweep())
  expect(await screen.findByRole('table', { name: 'Weakest markets' })).toBeTruthy()
  expect(requests.filter(request => request.includes('/results'))).toHaveLength(2)
  // The one market the results name here. The count over it is the results' own, 4, as on the button, with the type of the mentions it counts.
  expect(placeRows('Weakest markets')).toEqual([['Downtown, Lakeshore', 'None', '1', '3', 'Add market query']])
  expect(within(region()).getAllByRole('status').map(status => status.textContent)).toContain('4 markets · no non-brand mention')
  expect(pressedViews()).toEqual(['Weakest markets, non-brand queries, 4'])
})

test('a view of the workspace lists its places when the results did not load', async () => {
  installApi({ workspace: withViews, results: () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'unavailable' } }, 500) })
  renderWorkspace({ trackedView: 'thin-markets' })
  expect(await screen.findByRole('table', { name: 'Thin markets' })).toBeTruthy()
  await waitFor(() => expect(viewNames()[3]).toBe('Weakest markets, non-brand queries'))
  // Thin markets is the workspace's own: only Weakest markets waits on the results.
  expect(placeRows('Thin markets')).toHaveLength(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('Could not load')).toBeNull()
})

test('a link to a row wins over a view in the same URL, choosing a view drops the link, and a copied link names no view', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  stubClipboard(writeText)
  installApi({ workspace: withViews })
  window.history.replaceState({}, '', '?trackedView=thin-markets&trackingQueryId=q-uptown-best')
  onTestFinished(() => window.history.replaceState({}, '', window.location.pathname))
  const props = renderWorkspace({ trackedView: 'thin-markets', trackingQueryId: 'q-uptown-best' })
  // The table opens on the row, as a link always has: no list of markets is drawn over it.
  const linked = (await screen.findByRole('button', { name: `Actions for ${UPTOWN_BEST}` })).closest('tr')!
  expect(linked.hasAttribute('data-highlighted')).toBe(true)
  expect(screen.queryByRole('table', { name: 'Thin markets' })).toBeNull()
  expect(pressedViews()).toEqual([])
  // The view leaves the URL, so it is not waiting behind the row. Its entry is replaced: Back must not land on the address with both and be sent on again.
  expect(vi.mocked(props.onSelectionChange).mock.calls).toEqual([[{ trackedView: undefined }, { replace: true }]])
  props.rerender({ trackedView: undefined, trackingQueryId: 'q-uptown-best' })
  expect(vi.mocked(props.onSelectionChange)).toHaveBeenCalledTimes(1)

  // The link is to the row alone.
  await chooseRowAction(UPTOWN_BEST, 'Copy link')
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  const copied = new URL(writeText.mock.calls[0]![0] as string)
  expect([...copied.searchParams.keys()]).toEqual(['trackingQueryId'])
  expect(copied.searchParams.get('trackingQueryId')).toBe('q-uptown-best')

  // A view opens over the list, so the link goes with the same patch.
  fireEvent.click(viewButton('Thin markets'))
  expect(lastPatch(props)).toEqual({ trackedView: 'thin-markets', trackingQueryId: undefined })
  expect('trackingQueryId' in lastPatch(props)).toBe(true)
  props.rerender({ trackedView: 'thin-markets', trackingQueryId: undefined })
  expect(screen.getByRole('table', { name: 'Thin markets' })).toBeTruthy()

  // A link to a query that is gone holds no view back.
  props.rerender({ trackedView: 'thin-markets', trackingQueryId: 'q-removed' })
  expect(screen.getByRole('table', { name: 'Thin markets' })).toBeTruthy()
  expect(vi.mocked(props.onSelectionChange)).toHaveBeenCalledTimes(2)
})
