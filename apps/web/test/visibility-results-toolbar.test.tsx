import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { parseVisibilitySelection, patchVisibilitySelection } from '../src/lib/measurement-view-url.js'
import { VISIBILITY_TOOLBAR_COPY, VisibilityOverview, VisibilityResultsToolbar } from '../src/components/project/VisibilityTrendSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

const TOOLBAR = '.visibility-results-toolbar'
const RATE = { numerator: 3, denominator: 4, rate: 0.75 }
// Midday-UTC instants read as the same calendar date in every zone from UTC-11 to UTC+11.
const TREND_RUNS = [
  { runId: 'run-1', createdAt: '2026-09-06T12:00:00.000Z' },
  { runId: 'run-2', createdAt: '2026-09-13T12:00:00.000Z' },
]
const COMPLETED_AT = '2026-09-13T12:30:00.000Z'

interface ToolbarReportOptions {
  mode?: 'simple' | 'advanced'
  queryClass?: 'all' | 'non-brand' | 'branded' | 'unknown'
  measurement?: 'measured' | 'partial' | 'not-measured'
  availability?: 'available' | 'unsupported'
  scope?: 'project' | 'property'
  trendRuns?: readonly string[]
}

/** Parsed, so every fixture is a response the server could send. */
function toolbarReport({ mode = 'advanced', queryClass = 'non-brand', measurement = 'measured', availability = 'available', scope = 'project', trendRuns = ['run-1', 'run-2'] }: ToolbarReportOptions = {}): VisibilityReportResponse {
  const provenance = mode === 'advanced' ? { kind: 'frozen-advanced', definitionRevision: 2 } : { kind: 'frozen-simple', definitionRevision: null }
  const revision = mode === 'advanced' ? 2 : null
  const measured = measurement !== 'not-measured'
  const scopeOptions = [
    { id: 'project', label: 'Whole site', kind: 'project', targetCount: 2 },
    { id: 'harbor-house', label: 'Harbor House', kind: 'property', targetCount: 1 },
  ]
  return visibilityReportResponseSchema.parse({
    selection: {
      mode, queryClass, scope: scopeOptions.find(option => option.kind === scope),
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision, run: { id: measured ? 'run-2' : null, explicit: false }, provenance,
      measurement: { state: measurement, activeRevision: revision, measuredRevision: measured ? revision : null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: measured ? COMPLETED_AT : null },
      availability: availability === 'available' ? { state: 'available' } : { state: 'unsupported', reason: 'advanced-v1' },
    },
    scopeOptions,
    filterOptions: {
      providers: ['gemini', 'openai'],
      models: [{ provider: 'gemini', model: 'gemini-2.5-flash' }, { provider: 'openai', model: 'gpt-5' }],
      locations: [{ kind: 'all' }, { kind: 'exact', value: 'Portland, ME' }, { kind: 'none' }],
    },
    populations: (queryClass === 'all' ? ['branded', 'non-brand', 'unknown'] : [queryClass]).map(populationClass => ({
      queryClass: populationClass,
      summary: { queryCount: 1, answerCount: 4, mentionCoverage: RATE, citationCoverage: RATE, propertyReach: { numerator: 1, denominator: 2, rate: 0.5 }, outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 1, notMeasured: 0, total: 2 } },
      trend: TREND_RUNS.filter(point => trendRuns.includes(point.runId)).map((point, index) => ({
        ...point, revision, provenance, queryCount: 1, answerCount: 4, mentionCoverage: RATE, citationCoverage: RATE,
        continuity: index === 0 ? { state: 'first', comparedRunId: null } : { state: 'comparable', comparedRunId: 'run-1' },
      })),
      queries: { items: [{ queryKey: 'query-harbor', queryId: 'q1', query: 'harbor hotels near the coast', provider: 'gemini', model: 'gemini-2.5-flash', location: null, targetKeys: ['harbor-house'], answerCount: 4, mentionCoverage: RATE, citationCoverage: RATE }], total: 1, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
      competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
      breakdown: { groups: [], properties: [] },
    })),
  })
}

/** Every filter the toolbar can show as a token, as URL search params. */
const FILTERED = {
  queryClass: 'non-brand',
  measurementProvider: 'gemini',
  measurementModel: 'gpt-5',
  measurementLocation: 'Portland, ME',
  measurementFrom: '2026-09-01T00:00:00.000Z',
  measurementTo: '2026-09-08T23:59:59.999Z',
  measurementRunId: 'run-1',
}

const filtersButton = () => screen.getByRole('button', { name: /^Filters/ })
const filterTokens = () => screen.queryAllByRole('button', { name: /^Remove filter / })
const tokenLabels = () => filterTokens().map(token => token.textContent)
/** The panel the Filters button controls, found even while hidden, when it has no accessible name. */
const visibilityFilters = () => document.getElementById(filtersButton().getAttribute('aria-controls') ?? '')!

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, release: () => resolve() }
}

function renderToolbar(search: Record<string, unknown>, report = toolbarReport(), extra: { onManageQueries?: () => void } = {}) {
  const onSelectionChange = vi.fn()
  const view = render(<VisibilityResultsToolbar report={report} selection={parseVisibilitySelection(search)} onSelectionChange={onSelectionChange} {...extra} />)
  return { ...view, onSelectionChange }
}

/** The page's composition with a URL held in state, exactly as ProjectPage patches it. */
function renderOverview(initialSearch: Record<string, unknown>, extra: { fallback?: ReactNode; showUnmeasuredFallback?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => client.clear())
  function Harness() {
    const [search, setSearch] = useState(initialSearch)
    return <VisibilityOverview projectName="demo" selection={parseVisibilitySelection(search)} onSelectionChange={patch => setSearch(previous => patchVisibilitySelection(previous, patch))} {...extra} />
  }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

describe('results toolbar copy', () => {
  it('pins every toolbar string', () => {
    expect(VISIBILITY_TOOLBAR_COPY.queryType).toBe('Query type')
    expect(VISIBILITY_TOOLBAR_COPY.filters(0)).toBe('Filters')
    expect(VISIBILITY_TOOLBAR_COPY.filters(2)).toBe('Filters · 2')
    expect(VISIBILITY_TOOLBAR_COPY.panel).toBe('Visibility filters')
    expect(VISIBILITY_TOOLBAR_COPY.clearFilters).toBe('Clear filters')
    expect(VISIBILITY_TOOLBAR_COPY.manageQueries).toBe('Manage queries')
    expect(VISIBILITY_TOOLBAR_COPY.removeFilter('Engine: gemini')).toBe('Remove filter Engine: gemini')
    expect(VISIBILITY_TOOLBAR_COPY.engine('gemini')).toBe('Engine: gemini')
    expect(VISIBILITY_TOOLBAR_COPY.model('gpt-5')).toBe('Model: gpt-5')
    expect(VISIBILITY_TOOLBAR_COPY.location('Portland, ME')).toBe('Requested search location: Portland, ME')
    expect(VISIBILITY_TOOLBAR_COPY.noLocation).toBe('No location requested')
    expect(VISIBILITY_TOOLBAR_COPY.dateRange('Sep 1', 'Sep 8, 2026')).toBe('Sep 1 to Sep 8, 2026 (UTC)')
    expect(VISIBILITY_TOOLBAR_COPY.dateFrom('Sep 1, 2026')).toBe('From Sep 1, 2026 (UTC)')
    expect(VISIBILITY_TOOLBAR_COPY.dateThrough('Sep 8, 2026')).toBe('Through Sep 8, 2026 (UTC)')
    expect(VISIBILITY_TOOLBAR_COPY.resultsFrom('Sep 6, 2026')).toBe('Results from: Sep 6, 2026')
    expect(VISIBILITY_TOOLBAR_COPY.resultsFromSelectedSweep).toBe('Results from: selected sweep')
  })
})

describe('results toolbar mount rule', () => {
  it('is absent before the first report arrives, then mounts above the results', async () => {
    const gate = deferred()
    onTestFinished(gate.release)
    onTestFinished(mockFetch(async () => { await gate.promise; return jsonResponse(toolbarReport()) }))
    const { container } = renderOverview({ queryClass: 'non-brand' })

    expect(screen.getByRole('status', { name: 'Loading AI visibility' })).toBeTruthy()
    expect(container.querySelector(TOOLBAR)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull()

    gate.release()
    const results = await screen.findByRole('region', { name: 'AI visibility results' })
    const toolbar = container.querySelector(TOOLBAR)
    expect(toolbar).not.toBeNull()
    expect(toolbar!.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('is absent when the report fails, leaving recovery to the workspace alert', async () => {
    onTestFinished(mockFetch(() => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Report unavailable.' } }, 500)))
    const { container } = renderOverview({ queryClass: 'non-brand', measurementProvider: 'gemini' })

    expect(await screen.findByRole('heading', { name: 'AI visibility unavailable' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(container.querySelector(TOOLBAR)).toBeNull()
    expect(filterTokens()).toHaveLength(0)
  })

  it.each([
    { label: 'an Advanced v1 plan', options: { availability: 'unsupported' }, showUnmeasuredFallback: false },
    { label: 'an unmeasured Simple project', options: { mode: 'simple', measurement: 'not-measured' }, showUnmeasuredFallback: true },
  ] as const)('is absent while the fallback renders for $label', async ({ options, showUnmeasuredFallback }) => {
    onTestFinished(mockFetch(() => jsonResponse(toolbarReport(options))))
    const { container } = renderOverview({ queryClass: 'non-brand' }, { fallback: <p>Existing overview</p>, showUnmeasuredFallback })

    expect(await screen.findByText('Existing overview')).toBeTruthy()
    expect(container.querySelector(TOOLBAR)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull()
  })

  it('stays mounted, with its panel open, while the keyed results reload after a filter change', async () => {
    const gate = deferred()
    onTestFinished(gate.release)
    onTestFinished(mockFetch(async url => {
      if (new URL(url).searchParams.get('provider') === 'gemini') await gate.promise
      return jsonResponse(toolbarReport())
    }))
    const { container } = renderOverview({ queryClass: 'non-brand' })
    await screen.findByRole('region', { name: 'AI visibility results' })
    const toolbar = container.querySelector(TOOLBAR)

    fireEvent.click(filtersButton())
    fireEvent.change(screen.getByRole('combobox', { name: 'Answer engine' }), { target: { value: 'gemini' } })

    expect(await screen.findByRole('status', { name: 'Loading AI visibility' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'AI visibility results' })).toBeNull()
    expect(container.querySelector(TOOLBAR)).toBe(toolbar)
    expect(visibilityFilters().hidden).toBe(false)

    gate.release()
    expect(await screen.findByRole('region', { name: 'AI visibility results' })).toBeTruthy()
    expect(container.querySelector(TOOLBAR)).toBe(toolbar)
  })
})

describe('URL-bound toolbar controls', () => {
  it('keeps a changed engine, its token and focus while the request is pending', async () => {
    const requests: URL[] = []
    const gate = deferred()
    onTestFinished(gate.release)
    // The server echo never names an engine, so only the URL can hold "gemini".
    onTestFinished(mockFetch(async url => {
      const request = new URL(url)
      requests.push(request)
      if (request.searchParams.get('provider') === 'gemini') await gate.promise
      return jsonResponse(toolbarReport())
    }))
    renderOverview({ queryClass: 'non-brand' })
    await screen.findByRole('region', { name: 'AI visibility results' })

    fireEvent.click(filtersButton())
    const engine = screen.getByRole('combobox', { name: 'Answer engine' }) as HTMLSelectElement
    act(() => engine.focus())
    fireEvent.change(engine, { target: { value: 'gemini' } })

    await waitFor(() => expect(requests.filter(request => request.searchParams.get('provider') === 'gemini')).toHaveLength(1))
    expect(screen.getByRole('status', { name: 'Loading AI visibility' })).toBeTruthy()
    expect(engine.isConnected).toBe(true)
    expect(engine.value).toBe('gemini')
    expect(document.activeElement).toBe(engine)
    expect(tokenLabels()).toEqual(['Engine: gemini'])
    expect(filtersButton().textContent).toBe('Filters · 1')

    gate.release()
    await screen.findByRole('region', { name: 'AI visibility results' })
    expect(engine.value).toBe('gemini')
    expect(tokenLabels()).toEqual(['Engine: gemini'])
  })

  it('labels one removable token for each non-default URL filter', () => {
    renderToolbar(FILTERED)
    const labels = ['Engine: gemini', 'Model: gpt-5', 'Requested search location: Portland, ME', 'Sep 1 to Sep 8, 2026 (UTC)', 'Results from: Sep 6, 2026']
    expect(tokenLabels()).toEqual(labels)
    expect(filterTokens().map(token => token.getAttribute('aria-label'))).toEqual(labels.map(label => `Remove filter ${label}`))
    for (const token of filterTokens()) expect(token.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(filtersButton().textContent).toBe('Filters · 5')
  })

  it.each([
    { filters: {}, labels: [] },
    { filters: { measurementLocation: 'none' }, labels: ['No location requested'] },
    { filters: { measurementFrom: '2026-09-01T00:00:00.000Z' }, labels: ['From Sep 1, 2026 (UTC)'] },
    { filters: { measurementTo: '2026-09-08T23:59:59.999Z' }, labels: ['Through Sep 8, 2026 (UTC)'] },
    { filters: { measurementFrom: '2025-12-28T00:00:00.000Z', measurementTo: '2026-01-04T23:59:59.999Z' }, labels: ['Dec 28, 2025 to Jan 4, 2026 (UTC)'] },
    { filters: { measurementRunId: 'run-9' }, labels: ['Results from: selected sweep'] },
  ])('labels $filters as $labels', ({ filters, labels }) => {
    renderToolbar({ queryClass: 'non-brand', ...filters })
    expect(tokenLabels()).toEqual(labels)
    expect(filtersButton().textContent).toBe(labels.length === 0 ? 'Filters' : `Filters · ${labels.length}`)
  })

  it('names a pinned sweep by its trend date once the displayed report includes it', () => {
    const selection = parseVisibilitySelection({ queryClass: 'non-brand', measurementRunId: 'run-1' })
    const { rerender } = render(<VisibilityResultsToolbar report={toolbarReport({ trendRuns: ['run-2'] })} selection={selection} onSelectionChange={() => {}} />)
    expect(tokenLabels()).toEqual(['Results from: selected sweep'])
    rerender(<VisibilityResultsToolbar report={toolbarReport({ trendRuns: ['run-1'] })} selection={selection} onSelectionChange={() => {}} />)
    expect(tokenLabels()).toEqual(['Results from: Sep 6, 2026'])
  })

  it.each([
    ['Engine: gemini', { measurementProvider: undefined }],
    ['Model: gpt-5', { measurementModel: undefined }],
    ['Requested search location: Portland, ME', { measurementLocation: undefined }],
    ['Sep 1 to Sep 8, 2026 (UTC)', { measurementFrom: undefined, measurementTo: undefined }],
    ['Results from: Sep 6, 2026', { measurementRunId: undefined }],
  ])('removing %s patches only its own keys and moves focus to Filters', (label, patch) => {
    const { onSelectionChange } = renderToolbar(FILTERED)
    const token = screen.getByRole('button', { name: `Remove filter ${label}` })
    act(() => token.focus())
    fireEvent.click(token)
    expect(onSelectionChange.mock.calls).toStrictEqual([[patch]])
    expect(document.activeElement).toBe(filtersButton())
  })

  it('Clear filters removes every filter but keeps scope, market, class, the queries workspace and the drawer run', () => {
    const initial = { ...FILTERED, measurementScope: 'group', measurementScopeKey: 'north', measurementMarketKey: 'coastal-maine', queryClass: 'branded', queryWorkspace: 'tracked', runId: 'drawer-run', tab: 'overview' }
    const patches: Array<Record<string, unknown>> = []
    let current: Record<string, unknown> = initial
    function Harness() {
      const [search, setSearch] = useState<Record<string, unknown>>(initial)
      return <VisibilityResultsToolbar report={toolbarReport()} selection={parseVisibilitySelection(search)} onSelectionChange={patch => {
        patches.push(patch)
        setSearch(previous => (current = patchVisibilitySelection(previous, patch)))
      }} />
    }
    render(<Harness />)
    fireEvent.click(filtersButton())
    const clear = screen.getByRole('button', { name: 'Clear filters' }) as HTMLButtonElement
    expect(clear.disabled).toBe(false)
    fireEvent.click(clear)

    expect(patches).toStrictEqual([{ measurementProvider: undefined, measurementModel: undefined, measurementLocation: undefined, measurementFrom: undefined, measurementTo: undefined, measurementRunId: undefined }])
    expect(patches.some(patch => 'runId' in patch)).toBe(false)
    expect(Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined))).toStrictEqual({
      measurementScope: 'group', measurementScopeKey: 'north', measurementMarketKey: 'coastal-maine', queryClass: 'branded', queryWorkspace: 'tracked', runId: 'drawer-run', tab: 'overview',
    })
    expect(tokenLabels()).toEqual([])
    expect(filtersButton().textContent).toBe('Filters')
    // Nothing is left to clear, so the control is disabled and focus returns to its disclosure.
    expect(clear.disabled).toBe(true)
    expect(document.activeElement).toBe(filtersButton())
  })

  it('starts closed even when the URL carries filters, and Filters toggles the inline panel', () => {
    renderToolbar(FILTERED)
    const button = filtersButton()
    const panel = visibilityFilters()
    expect(button.getAttribute('aria-controls')).not.toBe('')
    expect([panel.getAttribute('role'), panel.getAttribute('aria-label')]).toEqual(['group', 'Visibility filters'])
    expect([button.getAttribute('aria-expanded'), panel.hidden]).toEqual(['false', true])
    expect(screen.queryByRole('group', { name: 'Visibility filters' })).toBeNull()

    fireEvent.click(button)
    expect([button.getAttribute('aria-expanded'), panel.hidden]).toEqual(['true', false])
    expect(screen.getByRole('group', { name: 'Visibility filters' })).toBe(panel)
    const controls = [...panel.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select, input')]
    expect(controls.map(control => control.labels?.[0]?.textContent)).toEqual(['Answer engine', 'Requested search location', 'AI model', 'Start date (UTC)', 'End date (UTC)', 'Results from'])
    expect(within(panel).getAllByRole('button').map(control => control.getAttribute('aria-label') ?? control.textContent)).toEqual([
      'Filter by the AI model recorded with each answer. This does not change the model used by future sweeps.',
      'Choose a saved AI sweep to view its results. No new sweep starts.',
      'Clear filters',
    ])

    fireEvent.click(button)
    expect([button.getAttribute('aria-expanded'), panel.hidden]).toEqual(['false', true])
  })

  it('closes the panel on Escape and returns focus to Filters, after an open help tooltip takes the first Escape', () => {
    renderToolbar(FILTERED)
    fireEvent.click(filtersButton())
    const panel = visibilityFilters()
    const model = within(panel).getByRole('combobox', { name: 'AI model' })
    act(() => model.focus())
    fireEvent.keyDown(model, { key: 'Escape' })
    expect([filtersButton().getAttribute('aria-expanded'), panel.hidden]).toEqual(['false', true])
    expect(document.activeElement).toBe(filtersButton())

    fireEvent.click(filtersButton())
    const help = within(panel).getByRole('button', { name: 'Choose a saved AI sweep to view its results. No new sweep starts.' })
    act(() => help.focus())
    expect(help.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(help, { key: 'Escape' })
    expect([help.getAttribute('aria-expanded'), panel.hidden]).toEqual(['false', false])
    fireEvent.keyDown(help, { key: 'Escape' })
    expect([filtersButton().getAttribute('aria-expanded'), panel.hidden]).toEqual(['false', true])
    expect(document.activeElement).toBe(filtersButton())
  })

  it('sizes toolbar buttons and tokens at 44px with 14px text, never 12px text or pills', () => {
    renderToolbar(FILTERED, toolbarReport(), { onManageQueries: () => {} })
    fireEvent.click(filtersButton())
    const classes = (element: Element) => element.className.split(/\s+/)
    const buttons = [filtersButton(), ...filterTokens(), screen.getByRole('button', { name: 'Clear filters' }), screen.getByRole('button', { name: 'Manage queries' })]
    expect(buttons).toHaveLength(8)
    for (const button of buttons) {
      expect(classes(button)).toEqual(expect.arrayContaining(['min-h-11', 'text-sm']))
      expect(classes(button)).not.toContain('text-xs')
    }
    for (const token of filterTokens()) {
      // Default Button size, rectangular, and the token rule that caps its width.
      expect(classes(token)).toEqual(expect.arrayContaining(['visibility-filter-token', 'rounded-md', 'h-10', 'md:h-9', 'px-4']))
      expect(classes(token)).not.toContain('rounded-full')
      expect(classes(token)).not.toContain('h-9')
    }
    expect(classes(screen.getByRole('combobox', { name: 'Query type' }))).toEqual(expect.arrayContaining(['min-h-11', 'text-sm']))
  })

  it('lets both toolbar groups shrink so a phone-width row wraps instead of widening the page', () => {
    // A flex item starts at its natural width. With shrink-0, the Query type
    // group (label, select, run badge, date) stayed 382px wide inside a 343px
    // phone row and pushed the whole page sideways. Both groups must be allowed
    // to shrink so their own items wrap.
    renderToolbar(FILTERED, toolbarReport(), { onManageQueries: () => {} })
    const classes = (element: Element) => element.className.split(/\s+/)
    const toolbar = document.querySelector<HTMLElement>(TOOLBAR)!
    const groups = [...toolbar.children]
    expect(groups).toHaveLength(2)
    expect(within(groups[0] as HTMLElement).getByRole('combobox', { name: 'Query type' })).toBeTruthy()
    expect(within(groups[1] as HTMLElement).getByRole('button', { name: filtersButton().textContent! })).toBeTruthy()
    for (const group of groups) {
      expect(classes(group)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'min-w-0']))
      expect(classes(group)).not.toContain('shrink-0')
    }
  })

  it.each([
    ['measured', 'Complete'],
    ['partial', 'Partial'],
    ['not-measured', 'Not measured'],
  ] as const)('shows Query type from the URL and the %s run state from the displayed report', (measurement, badge) => {
    const { onSelectionChange } = renderToolbar({ queryClass: 'branded' }, toolbarReport({ measurement }))
    const toolbar = document.querySelector<HTMLElement>(TOOLBAR)!
    const queryType = within(toolbar).getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement
    expect(within(toolbar).getByText('Query type', { selector: 'span' })).toBeTruthy()
    expect([...queryType.options].map(option => [option.value, option.text])).toEqual([['non-brand', 'Non-brand'], ['branded', 'Branded'], ['unknown', 'Unclassified']])
    // The displayed report is non-brand; the URL still decides the control.
    expect(queryType.value).toBe('branded')
    expect(within(toolbar).getByText(badge)).toBeTruthy()
    if (measurement === 'not-measured') expect(toolbar.textContent).not.toContain('2026')
    else expect(within(toolbar).getByText('Sep 13, 2026')).toBeTruthy()
    expect(toolbar.textContent).not.toMatch(/\d{1,2}:\d{2}/)

    fireEvent.change(queryType, { target: { value: 'unknown' } })
    expect(onSelectionChange.mock.calls).toStrictEqual([[{ queryClass: 'unknown', measurementQueryKey: undefined }]])
  })

  it('shows the served population class while the URL still asks for all classes', () => {
    const report = toolbarReport({ queryClass: 'all' })
    for (const population of report.populations.filter(population => population.queryClass !== 'unknown')) {
      population.summary.queryCount = 0
      population.trend = population.trend.map(point => ({ ...point, queryCount: 0 }))
    }
    renderToolbar({}, report)
    expect((screen.getByRole('combobox', { name: 'Query type' }) as HTMLSelectElement).value).toBe('unknown')
  })

  it('keeps each URL value selectable when the displayed report does not list it', () => {
    renderToolbar({ queryClass: 'non-brand', measurementProvider: 'claude', measurementModel: 'claude-sonnet', measurementLocation: 'Bangor, ME', measurementRunId: 'run-9' })
    fireEvent.click(filtersButton())
    const control = (name: string) => {
      const select = screen.getByRole('combobox', { name }) as HTMLSelectElement
      return { value: select.value, options: [...select.options].map(option => [option.value, option.text]) }
    }
    expect(control('Answer engine')).toEqual({ value: 'claude', options: [['', 'All engines'], ['gemini', 'gemini'], ['openai', 'openai'], ['claude', 'claude']] })
    expect(control('Requested search location')).toEqual({ value: 'Bangor, ME', options: [['', 'All requested locations'], ['Portland, ME', 'Portland, ME'], ['none', 'No location requested'], ['Bangor, ME', 'Bangor, ME']] })
    // Model choices follow the URL engine, which the report has no models for.
    expect(control('AI model')).toEqual({ value: 'claude-sonnet', options: [['', 'All models'], ['claude-sonnet', 'claude-sonnet']] })
    expect(control('Results from')).toEqual({
      value: 'run-9',
      options: [['', 'Latest saved sweep'], ...[...TREND_RUNS].reverse().map(point => [point.runId, new Date(point.createdAt).toLocaleString()]), ['run-9', 'Selected sweep']],
    })
  })

  it('offers Manage queries and the Property details link only when the page provides them', () => {
    const manageQueries = vi.fn()
    const propertySelection = parseVisibilitySelection({ queryClass: 'non-brand', measurementScope: 'property', measurementScopeKey: 'harbor-house' })
    const { rerender } = render(<VisibilityResultsToolbar report={toolbarReport({ scope: 'property' })} selection={propertySelection} onSelectionChange={() => {}} onManageQueries={manageQueries}
      renderPropertyLink={({ id, label }) => <a href={`/properties/${id}`}>Property details for {label}</a>} />)
    const toolbar = document.querySelector<HTMLElement>(TOOLBAR)!
    expect(within(toolbar).getByRole('link', { name: 'Property details for Harbor House' }).getAttribute('href')).toBe('/properties/harbor-house')
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Manage queries' }))
    expect(manageQueries).toHaveBeenCalledOnce()

    // An embed passes neither; a whole-site scope never offers a Property link.
    rerender(<VisibilityResultsToolbar report={toolbarReport()} selection={parseVisibilitySelection({ queryClass: 'non-brand' })} onSelectionChange={() => {}}
      renderPropertyLink={({ label }) => <a href="/properties">Property details for {label}</a>} />)
    expect(within(toolbar).queryByRole('button', { name: 'Manage queries' })).toBeNull()
    expect(within(toolbar).queryByRole('link')).toBeNull()
  })

  it('binds Property details to the URL selection, not the displayed report', () => {
    const urlProperty = parseVisibilitySelection({ queryClass: 'non-brand', measurementScope: 'property', measurementScopeKey: 'pier-inn' })
    render(<VisibilityResultsToolbar
      report={toolbarReport({ scope: 'property' })}
      selection={urlProperty}
      onSelectionChange={() => {}}
      renderPropertyLink={({ id, label }) => <a href={`/properties/${id}`}>Property details for {label}</a>}
    />)
    const toolbar = document.querySelector<HTMLElement>(TOOLBAR)!
    expect(within(toolbar).getByRole('link', { name: 'Property details for pier-inn' }).getAttribute('href')).toBe('/properties/pier-inn')
    expect(within(toolbar).queryByRole('link', { name: 'Property details for Harbor House' })).toBeNull()
  })
})
