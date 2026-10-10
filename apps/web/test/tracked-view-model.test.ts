import { describe, expect, it } from 'vitest'
import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import {
  coverageByQuery,
  DEFAULT_TRACKED_SORT,
  engineSignal,
  engineSortKey,
  nextTrackedSort,
  resultClasses,
  sortTrackedRows,
  sourceDetailLabel,
  sourceLabel,
  statusLabel,
  subjectLabel,
  toTrackedRows,
  TRACKED_COLUMNS,
  trackedEngineColumnWidth,
  trackedLayout,
  trackedSubject,
  typeLabel,
  visibleTrackedColumns,
  type TrackedResults,
} from '../src/components/project/queries/advanced/tracked-view-model.js'

type Row = QueryTrackingTrackedRow
type Assignment = Row['assignments'][number]
type Focus = NonNullable<Row['focus']>
type Provenance = NonNullable<Row['provenance']>

const context = { providers: ['openai'], models: { openai: 'model-a' }, location: null }
const assignment = (targetKey: string, queryClass: Assignment['queryClass'] = 'non-brand'): Assignment =>
  ({ targetKey, groupKeys: [], marketKeys: [], queryClass, classificationSource: 'server', contexts: [context] })
const provenance = (source: Provenance['source'], template?: Provenance['template']): Provenance =>
  ({ source, sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z', ...(template ? { template } : {}) })

function row(queryId: string, overrides: Partial<Row> = {}): Row {
  return {
    queryId,
    queryText: queryId,
    normalizedText: queryId,
    provenance: provenance('manual'),
    state: 'tracked',
    lastMeasuredAt: '2026-10-07T12:00:00.000Z',
    assignments: [assignment('harbor-point')],
    ...overrides,
  }
}

const edge = (targetKey: string, queryId = 'query') => ({ executionNodeKey: `node-${targetKey}-${queryId}`, targetKey, queryId })

function workspace(tracked: Row[], overrides: Partial<QueryTrackingWorkspaceResponse> = {}): QueryTrackingWorkspaceResponse {
  return {
    mode: 'advanced',
    workspaceVersion: `qtw_${'a'.repeat(64)}`,
    active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
    defaultContexts: [context],
    targets: [
      { stableKey: 'harbor-point', label: 'Acme Homes Harbor Point' },
      { stableKey: 'northbridge', label: 'Acme Homes Northbridge' },
      { stableKey: 'riverside', label: 'Acme Homes Riverside' },
    ],
    groups: [],
    markets: [
      // The server's member list holds three locations; the edges name two. The count shown is the list's length.
      { stableKey: 'uptown', label: 'Uptown', usageEdges: [edge('harbor-point'), edge('northbridge')], targetKeys: ['harbor-point', 'northbridge', 'riverside'] },
      { stableKey: 'downtown', label: 'Downtown', usageEdges: [edge('riverside')], targetKeys: ['riverside'] },
      // An older server sends only the edges: two for one location, one for another.
      { stableKey: 'old-server', label: 'Old Mill', usageEdges: [edge('harbor-point', 'a'), edge('harbor-point', 'b'), edge('northbridge', 'a')] },
    ],
    tracked,
    savedSources: { research: [], discovery: [] },
    ...overrides,
  }
}

const only = (tracked: Row, templates: { id: string; name: string }[] = []) => toTrackedRows(workspace([tracked]), templates)[0]!
const twelve = Array.from({ length: 12 }, (_, index) => assignment(`location-${index}`, 'branded'))

describe('toTrackedRows', () => {
  it.each<{ name: string; focus: Focus | undefined; assignments: Assignment[]; subject: unknown; label: string }>([
    { name: 'a market, counted by the server member list', focus: { kind: 'market', key: 'uptown' }, assignments: [assignment('harbor-point')], subject: { kind: 'market', key: 'uptown', label: 'Uptown', locationCount: 3 }, label: 'Market · Uptown (3)' },
    { name: 'a one-location market', focus: { kind: 'market', key: 'downtown' }, assignments: [assignment('riverside')], subject: { kind: 'market', key: 'downtown', label: 'Downtown', locationCount: 1 }, label: 'Market · Downtown (1)' },
    { name: 'a market on a server that sends no member list', focus: { kind: 'market', key: 'old-server' }, assignments: [assignment('harbor-point')], subject: { kind: 'market', key: 'old-server', label: 'Old Mill', locationCount: 2 }, label: 'Market · Old Mill (2)' },
    { name: 'a property as a location', focus: { kind: 'property', key: 'northbridge' }, assignments: [assignment('northbridge', 'branded')], subject: { kind: 'location', key: 'northbridge', label: 'Acme Homes Northbridge' }, label: 'Location · Acme Homes Northbridge' },
    { name: 'the company', focus: { kind: 'company' }, assignments: [], subject: { kind: 'company' }, label: 'Company' },
    { name: 'custom as hand-picked, with its locations counted', focus: { kind: 'custom' }, assignments: twelve, subject: { kind: 'hand-picked', locationCount: 12 }, label: 'Hand-picked · 12 locations' },
    { name: 'one hand-picked location', focus: { kind: 'custom' }, assignments: [assignment('riverside')], subject: { kind: 'hand-picked', locationCount: 1 }, label: 'Hand-picked · 1 location' },
    { name: 'not asked as none', focus: { kind: 'not-asked' }, assignments: [], subject: { kind: 'none' }, label: 'None' },
    { name: 'a missing focus without locations as none', focus: undefined, assignments: [], subject: { kind: 'none' }, label: 'None' },
    { name: 'a missing focus with locations as hand-picked', focus: undefined, assignments: [assignment('harbor-point'), assignment('riverside')], subject: { kind: 'hand-picked', locationCount: 2 }, label: 'Hand-picked · 2 locations' },
  ])('reads $name', ({ focus, assignments, subject, label }) => {
    const tracked = row('query', { focus, assignments })
    const vm = only(tracked)
    expect(vm.subject).toEqual(subject)
    expect(subjectLabel(vm.subject)).toBe(label)
    // The review reads the same Subject from a post-change row.
    expect(trackedSubject(tracked, workspace([]))).toEqual(subject)
  })

  it('keeps the key of a market or location the workspace no longer lists', () => {
    expect(only(row('query', { focus: { kind: 'market', key: 'retired' } })).subject).toEqual({ kind: 'market', key: 'retired', label: 'retired', locationCount: 0 })
    expect(only(row('query', { focus: { kind: 'property', key: 'gone' } })).subject).toEqual({ kind: 'location', key: 'gone', label: 'gone' })
  })

  it.each<{ name: string; queryClasses: Row['queryClasses']; assignments: Assignment[]; type: string; label: string }>([
    { name: 'one server type', queryClasses: ['non-brand'], assignments: [assignment('a', 'branded')], type: 'non-brand', label: 'Non-brand' },
    { name: 'both server types as mixed', queryClasses: ['branded', 'non-brand'], assignments: [assignment('a', 'branded')], type: 'mixed', label: 'Mixed' },
    { name: 'no server type as not set', queryClasses: [], assignments: [assignment('a', 'branded')], type: 'not-set', label: 'Not set' },
    { name: 'the one type its locations carry, on an older server', queryClasses: undefined, assignments: [assignment('a', 'branded'), assignment('b', null)], type: 'branded', label: 'Branded' },
    { name: 'both types its locations carry, on an older server', queryClasses: undefined, assignments: [assignment('a', 'non-brand'), assignment('b', 'branded')], type: 'mixed', label: 'Mixed' },
    { name: 'locations with no type, on an older server', queryClasses: undefined, assignments: [assignment('a', null)], type: 'not-set', label: 'Not set' },
  ])('reads the Type from $name', ({ queryClasses, assignments, type, label }) => {
    const vm = only(row('query', { queryClasses, assignments }))
    expect(vm.type).toBe(type)
    expect(typeLabel(vm.type)).toBe(label)
  })

  it('lists the types results join on: its own, or the unset one', () => {
    expect(resultClasses(only(row('query', { queryClasses: ['branded', 'non-brand'] })))).toEqual(['branded', 'non-brand'])
    expect(resultClasses(only(row('query', { queryClasses: [] })))).toEqual(['unknown'])
  })

  it.each<{ name: string; state: Row['state']; focus: Focus; status: string }>([
    { name: 'a measured row', state: 'tracked', focus: { kind: 'market', key: 'uptown' }, status: 'measured' },
    { name: 'an asked row with no answers yet', state: 'awaiting-sweep', focus: { kind: 'property', key: 'northbridge' }, status: 'first-answers' },
    { name: 'a row in no location plan', state: 'awaiting-sweep', focus: { kind: 'not-asked' }, status: 'not-asked' },
  ])('gives $name its status', ({ state, focus, status }) => {
    expect(only(row('query', { state, focus, assignments: focus.kind === 'not-asked' ? [] : [assignment('northbridge')] })).status).toBe(status)
  })

  const frozen = { templateId: 'template-best', templateVersion: '1', template: 'best apartments in {market}', bindings: { market: 'Uptown' }, output: 'best apartments in Uptown' }
  // Every recorded source carries the same timestamp. Only a hand-written row's is the moment the query was added.
  it.each<{ name: string; provenance: Row['provenance']; source: unknown; label: string; detail?: string; addedAt?: string }>([
    { name: 'a saved pattern', provenance: provenance('template', frozen), source: { kind: 'pattern', name: 'Best', pattern: 'best apartments in {market}' }, label: 'Pattern: Best' },
    { name: 'a deleted pattern, which keeps its own text', provenance: provenance('template', { ...frozen, templateId: 'template-deleted' }), source: { kind: 'pattern', name: null, pattern: 'best apartments in {market}' }, label: 'Pattern' },
    { name: 'a pattern row with no saved record', provenance: provenance('template'), source: { kind: 'pattern', name: null, pattern: null }, label: 'Pattern' },
    { name: 'a hand-written query', provenance: provenance('manual'), source: { kind: 'manual' }, label: 'Manual', addedAt: '2026-09-04T12:00:00.000Z' },
    { name: 'saved research', provenance: provenance('research'), source: { kind: 'research' }, label: 'Research' },
    { name: 'a found idea, which the row detail tells from saved research', provenance: provenance('discovery'), source: { kind: 'research' }, label: 'Research', detail: 'Research · Find queries' },
    { name: 'a query set from setup', provenance: provenance('query-set'), source: { kind: 'setup' }, label: 'Setup' },
    { name: 'no recorded source', provenance: null, source: { kind: 'older-list' }, label: 'Older list' },
  ])('reads the Source of $name', ({ provenance: recorded, source, label, detail = label, addedAt = null }) => {
    const vm = only(row('query', { provenance: recorded }), [{ id: 'template-best', name: 'Best' }])
    expect(vm.source).toEqual(source)
    expect(sourceLabel(vm.source)).toBe(label)
    expect(sourceDetailLabel(vm)).toBe(detail)
    expect(vm.addedAt).toBe(addedAt)
  })

  it('carries the query, its last sweep and the workspace row behind it', () => {
    const tracked = row('query-1', { queryText: 'best apartments in Uptown', lastMeasuredAt: null, state: 'awaiting-sweep' })
    expect(only(tracked)).toMatchObject({ queryId: 'query-1', queryText: 'best apartments in Uptown', lastMeasuredAt: null, tracked })
  })
})

describe('statusLabel', () => {
  it('names the next sweep only for a row waiting on its first answers', () => {
    expect(statusLabel('measured', 'Oct 21')).toBe('Measured')
    expect(statusLabel('first-answers', 'Oct 21')).toBe('First answers Oct 21')
    expect(statusLabel('first-answers')).toBe('First answers')
    expect(statusLabel('not-asked', 'Oct 21')).toBe('Not asked')
  })
})

describe('coverageByQuery', () => {
  const results: TrackedResults = {
    rows: [
      { queryId: 'query-1', queryClass: 'branded', engines: [{ provider: 'openai', mentioned: true, cited: null, answers: 3, mentionedAnswers: 2, citedAnswers: 0, uncheckedSourceAnswers: 3 }] },
      { queryId: 'query-1', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: false, cited: false, answers: 3, mentionedAnswers: 0, citedAnswers: 0 }] },
      { queryId: 'query-2', queryClass: 'non-brand', engines: [{ provider: 'gemini', mentioned: false, cited: true }] },
    ],
  }

  it('keys each signal by query and type, and never reads one type for the other', () => {
    const coverage = coverageByQuery(results)
    // Cited stays not checked beside a mention: neither signal is read from the other.
    expect(engineSignal(coverage, 'query-1', 'branded', 'openai')).toEqual({ mentioned: true, cited: null, answers: 3, mentionedAnswers: 2, citedAnswers: 0, uncheckedSourceAnswers: 3 })
    expect(engineSignal(coverage, 'query-1', 'non-brand', 'openai')).toMatchObject({ mentioned: false, cited: false })
    // query-2 has a non-brand result only: its branded pairing is not checked.
    expect(engineSignal(coverage, 'query-2', 'non-brand', 'gemini')).toMatchObject({ mentioned: false, cited: true })
    expect(engineSignal(coverage, 'query-2', 'branded', 'gemini')).toBeNull()
  })

  it('reads a missing engine or query as not checked, and missing results as still loading', () => {
    const coverage = coverageByQuery(results)
    expect(engineSignal(coverage, 'query-2', 'non-brand', 'openai')).toBeNull()
    expect(engineSignal(coverage, 'query-3', 'non-brand', 'openai')).toBeNull()
    expect(coverageByQuery(undefined)).toBeUndefined()
    expect(coverageByQuery(null)).toBeUndefined()
    expect(engineSignal(undefined, 'query-1', 'branded', 'openai')).toBeUndefined()
  })
})

describe('sortTrackedRows', () => {
  const rows = toTrackedRows(workspace([
    row('none', { queryText: 'zeta', focus: { kind: 'not-asked' }, assignments: [], state: 'awaiting-sweep', lastMeasuredAt: null }),
    row('company', { queryText: 'acme homes', focus: { kind: 'company' }, assignments: [], lastMeasuredAt: '2026-10-01T12:00:00.000Z' }),
    row('hand-picked', { queryText: 'beta', focus: { kind: 'custom' }, state: 'awaiting-sweep', lastMeasuredAt: null }),
    row('location-b', { queryText: 'alpha', focus: { kind: 'property', key: 'northbridge' }, lastMeasuredAt: '2026-10-05T12:00:00.000Z' }),
    row('location-a', { queryText: 'omega', focus: { kind: 'property', key: 'harbor-point' }, lastMeasuredAt: '2026-10-03T12:00:00.000Z' }),
    row('market-u2', { queryText: 'Pet friendly 10', focus: { kind: 'market', key: 'uptown' } }),
    row('market-u1', { queryText: 'pet friendly 9', focus: { kind: 'market', key: 'uptown' } }),
    row('market-d', { queryText: 'pool', focus: { kind: 'market', key: 'downtown' }, lastMeasuredAt: '2026-10-06T12:00:00.000Z' }),
  ]), [])
  const ids = (sorted: readonly { queryId: string }[]) => sorted.map(item => item.queryId)

  it('orders by Subject kind, then place, then query text by default', () => {
    const expected = ['market-d', 'market-u1', 'market-u2', 'location-a', 'location-b', 'hand-picked', 'company', 'none']
    expect(DEFAULT_TRACKED_SORT).toEqual({ key: 'subject', direction: 'asc' })
    expect(ids(sortTrackedRows(rows))).toEqual(expected)
    expect(ids(sortTrackedRows(rows, DEFAULT_TRACKED_SORT))).toEqual(expected)
    // Reversed, the place order flips and the query text under one place still ascends.
    expect(ids(sortTrackedRows(rows, { key: 'subject', direction: 'desc' }))).toEqual(['none', 'company', 'hand-picked', 'location-b', 'location-a', 'market-u1', 'market-u2', 'market-d'])
  })

  it('orders query text as read, case aside and numbers by value', () => {
    expect(ids(sortTrackedRows(rows, { key: 'query', direction: 'asc' }))).toEqual(['company', 'location-b', 'hand-picked', 'location-a', 'market-u1', 'market-u2', 'market-d', 'none'])
    expect(ids(sortTrackedRows(rows, { key: 'query', direction: 'desc' }))[0]).toBe('none')
  })

  it('orders by status and by last sweep, with never measured last both ways', () => {
    expect(ids(sortTrackedRows(rows, { key: 'status', direction: 'asc' })).slice(-2)).toEqual(['hand-picked', 'none'])
    expect(ids(sortTrackedRows(rows, { key: 'status', direction: 'desc' })).slice(0, 2)).toEqual(['none', 'hand-picked'])
    expect(ids(sortTrackedRows(rows, { key: 'lastMeasured', direction: 'asc' }))).toEqual(['company', 'location-a', 'location-b', 'market-d', 'market-u1', 'market-u2', 'hand-picked', 'none'])
    expect(ids(sortTrackedRows(rows, { key: 'lastMeasured', direction: 'desc' }))).toEqual(['market-u1', 'market-u2', 'market-d', 'location-b', 'location-a', 'company', 'hand-picked', 'none'])
  })

  it('puts not mentioned first on an engine column, then not cited, and not checked last both ways', () => {
    const engine = (mentioned: boolean | null, cited: boolean | null) => [{ provider: 'openai', mentioned, cited }]
    const coverage = coverageByQuery({
      rows: [
        { queryId: 'market-d', queryClass: 'non-brand', engines: engine(true, true) },
        { queryId: 'market-u1', queryClass: 'non-brand', engines: engine(true, false) },
        { queryId: 'market-u2', queryClass: 'non-brand', engines: engine(false, false) },
        { queryId: 'location-a', queryClass: 'non-brand', engines: engine(false, true) },
        // A result under a type the row is not asked under is not this row's.
        { queryId: 'location-b', queryClass: 'branded', engines: engine(false, false) },
      ],
    })
    const sort = { key: engineSortKey('openai'), direction: 'asc' } as const
    expect(sort.key).toBe('engine:openai')
    expect(ids(sortTrackedRows(rows, sort, coverage))).toEqual(['market-u2', 'location-a', 'market-u1', 'market-d', 'location-b', 'hand-picked', 'company', 'none'])
    expect(ids(sortTrackedRows(rows, { ...sort, direction: 'desc' }, coverage))).toEqual(['market-d', 'market-u1', 'location-a', 'market-u2', 'location-b', 'hand-picked', 'company', 'none'])
  })

  it('sorts a row asked both ways with the rows to fix when either type is not mentioned', () => {
    const mixed = toTrackedRows(workspace([
      row('mixed', { queryClasses: ['branded', 'non-brand'], focus: { kind: 'custom' } }),
      row('plain', { queryClasses: ['non-brand'], focus: { kind: 'custom' } }),
    ]), [])
    const coverage = coverageByQuery({
      rows: [
        { queryId: 'mixed', queryClass: 'branded', engines: [{ provider: 'openai', mentioned: true, cited: true }] },
        { queryId: 'mixed', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: false, cited: false }] },
        { queryId: 'plain', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: true, cited: true }] },
      ],
    })
    expect(ids(sortTrackedRows(mixed, { key: 'engine:openai', direction: 'asc' }, coverage))).toEqual(['mixed', 'plain'])
  })

  it('leaves the given rows as they were', () => {
    const before = ids(rows)
    sortTrackedRows(rows, { key: 'query', direction: 'desc' })
    expect(ids(rows)).toEqual(before)
  })
})

describe('nextTrackedSort', () => {
  it('starts a new column ascending and flips the sorted one', () => {
    expect(nextTrackedSort(DEFAULT_TRACKED_SORT, 'query')).toEqual({ key: 'query', direction: 'asc' })
    expect(nextTrackedSort({ key: 'query', direction: 'asc' }, 'query')).toEqual({ key: 'query', direction: 'desc' })
    expect(nextTrackedSort({ key: 'query', direction: 'desc' }, 'query')).toEqual({ key: 'query', direction: 'asc' })
    expect(nextTrackedSort(undefined, 'status')).toEqual({ key: 'status', direction: 'asc' })
  })
})

describe('visibleTrackedColumns', () => {
  const without = (...hidden: string[]) => TRACKED_COLUMNS.filter(column => !hidden.includes(column))

  it('shows every column in the 1152px content column with three engines', () => {
    expect(visibleTrackedColumns(1152, 3)).toEqual([...TRACKED_COLUMNS])
    // Query is 288px there and may lose 16px, to a scrollbar or to padding around the table, before Source folds away.
    expect(visibleTrackedColumns(1136, 3)).toEqual([...TRACKED_COLUMNS])
    expect(visibleTrackedColumns(1135, 3)).toEqual(without('source'))
  })

  it('folds Source away for a fourth engine', () => {
    expect(visibleTrackedColumns(1152, 4)).toEqual(without('source'))
  })

  it('folds Last measured away too at 900px', () => {
    expect(visibleTrackedColumns(900, 3)).toEqual(without('source', 'lastMeasured'))
  })
})

describe('trackedLayout', () => {
  const engines = [62, 62, 62]
  const full = { selectable: true }

  it('shows every wanted column, unstacked, where no width is measured', () => {
    expect(trackedLayout(undefined, engines, full)).toEqual({ columns: TRACKED_COLUMNS, stacked: false })
  })

  it('stacks each row under a 40rem frame, and wider when Query would be too narrow to read', () => {
    expect(trackedLayout(639, [62], { columns: ['query', 'engines'] }).stacked).toBe(true)
    expect(trackedLayout(640, [62], { columns: ['query', 'engines'] }).stacked).toBe(false)
    // Three engines with checkboxes: the columns that never fold take 658px, and Query needs 224px beside them.
    expect(trackedLayout(882, engines, full).stacked).toBe(false)
    expect(trackedLayout(881, engines, full).stacked).toBe(true)
  })

  it('leaves Source and Last measured to the row detail when stacked', () => {
    expect(trackedLayout(390, engines, full).columns).toEqual(['query', 'subject', 'type', 'engines', 'status', 'menu'])
  })

  it('gives the checkbox column width back to Query for a viewer', () => {
    expect(trackedLayout(1130, engines, full).columns).not.toContain('source')
    expect(trackedLayout(1130, engines).columns).toContain('source')
  })

  it('only folds columns the caller wanted', () => {
    const columns = ['query', 'type', 'engines', 'lastMeasured', 'menu'] as const
    expect(trackedLayout(800, engines, { columns })).toEqual({ columns, stacked: false })
  })

  it('widens an engine column for a longer name, and counts it', () => {
    expect(trackedEngineColumnWidth('OpenAI')).toBe(62)
    expect(trackedEngineColumnWidth('Perplexity')).toBe(88)
    expect(trackedLayout(1152, [62, 62, 88], full).columns).not.toContain('source')
  })
})
