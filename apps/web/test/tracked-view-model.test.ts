import { describe, expect, it } from 'vitest'
import { PROVIDER_NAMES, type QueryTrackingTrackedRow, type QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'

import {
  coverageByQuery,
  DEFAULT_TRACKED_SORT,
  engineSignal,
  engineSortKey,
  marksNote,
  marksSubject,
  nextTrackedSort,
  NOT_ASKED,
  rankByQuery,
  resultClasses,
  resultSortOrder,
  rowSignal,
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
import { providerDisplayName } from '../src/lib/visibility-trend-helpers.js'

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

  it.each([
    { name: 'the day it was written', capturedAt: '2026-09-04T12:00:00.000Z', addedAt: '2026-09-04T12:00:00.000Z' },
    { name: 'the first day a query could have been added', capturedAt: '2020-01-01T00:00:00.000Z', addedAt: '2020-01-01T00:00:00.000Z' },
    // Setup writes the epoch where it has no time to record: "Added Jan 1, 1970" is no fact about the query.
    { name: 'the epoch setup writes as a placeholder', capturedAt: '1970-01-01T00:00:00.000Z', addedAt: null },
    { name: 'a time before any query was tracked', capturedAt: '2019-12-31T23:59:59.999Z', addedAt: null },
    { name: 'a time that is no date', capturedAt: 'not recorded', addedAt: null },
    { name: 'an empty time', capturedAt: '', addedAt: null },
  ])('reads when a hand-written query was added from $name', ({ capturedAt, addedAt }) => {
    expect(only(row('query', { provenance: { source: 'manual', sourceId: null, capturedAt } })).addedAt).toBe(addedAt)
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

  it('carries a measured row\'s own date, and none for a row never measured', () => {
    expect(statusLabel('measured', 'Oct 21', 'Oct 7')).toBe('Measured Oct 7')
    expect(statusLabel('measured', undefined, 'Oct 7')).toBe('Measured Oct 7')
    expect(statusLabel('measured')).toBe('Measured')
    // A last sweep is not the date of a row that waits, or of one that is not asked.
    expect(statusLabel('first-answers', 'Oct 21', 'Oct 7')).toBe('First answers Oct 21')
    expect(statusLabel('first-answers', undefined, 'Oct 7')).toBe('First answers')
    expect(statusLabel('not-asked', 'Oct 21', 'Oct 7')).toBe('Not asked')
  })
})

describe('coverageByQuery', () => {
  const results: TrackedResults = {
    rows: [
      { queryId: 'query-1', queryClass: 'branded', engines: [{ provider: 'openai', mentioned: true, cited: null, expectedAnswers: 4, answers: 3, mentionedAnswers: 2, citedAnswers: 0, uncheckedSourceAnswers: 3 }] },
      { queryId: 'query-1', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: false, cited: false, answers: 3, mentionedAnswers: 0, citedAnswers: 0 }] },
      { queryId: 'query-2', queryClass: 'non-brand', engines: [{ provider: 'gemini', mentioned: false, cited: true }] },
    ],
  }

  it('keys each signal by query and type, and never reads one type for the other', () => {
    const coverage = coverageByQuery(results)
    // Cited stays not checked beside a mention: neither signal is read from the other.
    // Every count is carried as sent, the answers asked for among them: the bubble says why a signal is not checked from those.
    expect(engineSignal(coverage, 'query-1', 'branded', 'openai')).toStrictEqual({ mentioned: true, cited: null, expectedAnswers: 4, answers: 3, mentionedAnswers: 2, citedAnswers: 0, uncheckedSourceAnswers: 3 })
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

describe('rowSignal', () => {
  const on = (...providers: string[]) => ({ providers, models: {}, location: null })
  const linked = (targetKey: string, ...contexts: ReturnType<typeof on>[]): Assignment => ({ ...assignment(targetKey), contexts })
  const [two, three, simple, waiting, notAsked] = toTrackedRows(workspace([
    // Asked on two of the three engines shown, from two search locations between them.
    row('two', { focus: { kind: 'custom' }, queryClasses: ['non-brand'], assignments: [linked('harbor-point', on('openai')), linked('riverside', on('openai'), on('gemini'))] }),
    row('three', { focus: { kind: 'market', key: 'uptown' }, queryClasses: ['non-brand'], assignments: [linked('harbor-point', on('claude', 'gemini', 'openai'))] }),
    // A simple site's row has no location link: it is asked on the project's engines.
    row('simple', { focus: { kind: 'company' }, queryClasses: ['non-brand'], assignments: [] }),
    row('waiting', { focus: { kind: 'custom' }, queryClasses: ['non-brand'], state: 'awaiting-sweep', lastMeasuredAt: null, assignments: [linked('harbor-point', on('openai'))] }),
    row('not-asked', { focus: { kind: 'not-asked' }, queryClasses: [], state: 'awaiting-sweep', assignments: [] }),
  ]), []) as [ReturnType<typeof only>, ReturnType<typeof only>, ReturnType<typeof only>, ReturnType<typeof only>, ReturnType<typeof only>]
  const coverage = coverageByQuery({
    rows: [
      { queryId: 'two', queryClass: 'non-brand', engines: [{ provider: 'openai', mentioned: true, cited: false }] },
      // From before its engines changed: the sweep still holds a Claude result for a row no longer asked on Claude.
      { queryId: 'waiting', queryClass: 'non-brand', engines: [{ provider: 'claude', mentioned: false, cited: false }] },
      // A result under a query that is not asked now is not its result.
      { queryId: 'not-asked', queryClass: 'unknown', engines: [{ provider: 'openai', mentioned: true, cited: true }] },
    ],
  })

  it('gives no cell on an engine the row is not asked on, and Not checked on one it is', () => {
    expect(rowSignal(two!, coverage, 'non-brand', 'openai')).toMatchObject({ mentioned: true, cited: false })
    // Asked on Gemini at one of its two locations, with no result yet: a sweep gap.
    expect(rowSignal(two!, coverage, 'non-brand', 'gemini')).toBeNull()
    expect(rowSignal(two!, coverage, 'non-brand', 'claude')).toBe(NOT_ASKED)
    expect(['claude', 'gemini', 'openai'].map(provider => rowSignal(three!, coverage, 'non-brand', provider))).toEqual([null, null, null])
  })

  it('does not borrow an engine assignment from the other query type', () => {
    const mixed = only(row('mixed', { queryClasses: ['branded', 'non-brand'], assignments: [
      { ...linked('harbor-point', on('openai')), queryClass: 'branded' },
      linked('riverside', on('gemini')),
    ] }))
    expect(rowSignal(mixed, coverage, 'non-brand', 'openai')).toBe(NOT_ASKED)
    expect(rowSignal(mixed, coverage, 'branded', 'gemini')).toBe(NOT_ASKED)
    expect(rowSignal(mixed, coverage, 'non-brand', 'gemini')).toBeNull()
    expect(rowSignal(mixed, coverage, 'branded', 'openai')).toBeNull()
  })

  it('preserves both types at one location when their engine contexts differ', () => {
    const mixed = only(row('mixed-contexts', { queryClasses: ['branded', 'non-brand'], assignments: [{
      ...linked('harbor-point', on('openai'), on('gemini')),
      classifiedContexts: [
        { ...on('openai'), queryClass: 'branded', marketKeys: [] },
        { ...on('gemini'), queryClass: 'non-brand', marketKeys: [] },
      ],
    }] }))
    expect(rowSignal(mixed, coverage, 'branded', 'openai')).toBeNull()
    expect(rowSignal(mixed, coverage, 'non-brand', 'gemini')).toBeNull()
    expect(rowSignal(mixed, coverage, 'branded', 'gemini')).toBe(NOT_ASKED)
    expect(rowSignal(mixed, coverage, 'non-brand', 'openai')).toBe(NOT_ASKED)
  })

  it('reads a row with no location link of its own as asked on every engine shown', () => {
    expect(['claude', 'openai'].map(provider => rowSignal(simple!, coverage, 'non-brand', provider))).toEqual([null, null])
  })

  it('still shows a result the sweep holds on an engine the row is no longer asked on', () => {
    expect(rowSignal(waiting!, coverage, 'non-brand', 'claude')).toMatchObject({ mentioned: false, cited: false })
    expect(rowSignal(waiting!, coverage, 'non-brand', 'gemini')).toBe(NOT_ASKED)
  })

  it('gives a query that is not asked no cell on any engine, loaded or not', () => {
    expect(['claude', 'openai'].map(provider => rowSignal(notAsked!, coverage, 'unknown', provider))).toEqual([NOT_ASKED, NOT_ASKED])
    expect(rowSignal(notAsked!, undefined, 'unknown', 'openai')).toBe(NOT_ASKED)
  })

  it('is still loading on an engine the row is asked on, and has nothing to wait for on one it is not', () => {
    expect(rowSignal(two!, undefined, 'non-brand', 'openai')).toBeUndefined()
    expect(rowSignal(two!, undefined, 'non-brand', 'claude')).toBe(NOT_ASKED)
  })
})

describe('marksSubject', () => {
  const labels = new Map(workspace([]).targets.map(target => [target.stableKey, target.label]))
  const market = only(row('market', { focus: { kind: 'market', key: 'uptown' }, assignments: [assignment('harbor-point'), assignment('northbridge'), assignment('riverside')] }))
  const handPicked = only(row('picked', { focus: { kind: 'custom' }, assignments: twelve }))

  it('names the one location a row is asked for', () => {
    const location = only(row('location', { focus: { kind: 'property', key: 'northbridge' }, assignments: [assignment('northbridge', 'branded')] }))
    expect(marksSubject(location, location.tracked.assignments, labels)).toBe('Acme Homes Northbridge')
    // A location the workspace no longer names keeps its key.
    expect(marksSubject(location, [assignment('gone')], labels)).toBe('gone')
  })

  it('says any of the locations a market row is asked for, with the market', () => {
    expect(marksSubject(market, market.tracked.assignments, labels)).toBe('Any of 3 locations in Uptown')
  })

  it('counts the links given, not the market: a Place that leaves one location names it', () => {
    // The market holds three locations and the row is asked for all three. Under a location Place, or a group holding one of them, one link is left.
    expect(market.subject).toMatchObject({ kind: 'market', locationCount: 3 })
    expect(marksSubject(market, market.tracked.assignments.filter(link => link.targetKey === 'riverside'), labels)).toBe('Acme Homes Riverside')
    expect(marksSubject(market, market.tracked.assignments.slice(0, 2), labels)).toBe('Any of 2 locations in Uptown')
  })

  it('counts a location once however many links name it', () => {
    expect(marksSubject(market, [assignment('riverside', 'branded'), assignment('riverside', 'non-brand')], labels)).toBe('Acme Homes Riverside')
  })

  it('says any of the locations a hand-picked row is asked for, with no place to name', () => {
    expect(marksSubject(handPicked, handPicked.tracked.assignments, labels)).toBe('Any of 12 locations')
  })

  it('names, for each type of a row asked both ways, the locations asked under that type', () => {
    const mixed = only(row('mixed', { focus: { kind: 'custom' }, queryClasses: ['branded', 'non-brand'], assignments: [assignment('harbor-point', 'branded'), assignment('northbridge', 'non-brand'), assignment('riverside', 'non-brand')] }))
    const links = mixed.tracked.assignments
    // Branded and non-brand results are never combined: the Branded pair is Harbor Point's alone.
    expect(marksSubject(mixed, links, labels, 'branded')).toBe('Acme Homes Harbor Point')
    expect(marksSubject(mixed, links, labels, 'non-brand')).toBe('Any of 2 locations')
    // With no type asked for, every location the row is asked for.
    expect(marksSubject(mixed, links, labels)).toBe('Any of 3 locations')
  })

  it('falls back to the row\'s links where none carries the type asked for', () => {
    // A link names one type. A row with no type set joins its results under "unknown", which no link carries.
    const untyped = only(row('untyped', { focus: { kind: 'custom' }, queryClasses: [], assignments: [assignment('harbor-point', null), assignment('riverside', null)] }))
    expect(marksSubject(untyped, untyped.tracked.assignments, labels, 'unknown')).toBe('Any of 2 locations')
    // One location asked both ways from two search locations is sent as one link, of one type.
    const both = only(row('both', { focus: { kind: 'property', key: 'riverside' }, queryClasses: ['branded', 'non-brand'], assignments: [assignment('riverside', 'branded')] }))
    expect(marksSubject(both, both.tracked.assignments, labels, 'non-brand')).toBe('Acme Homes Riverside')
  })

  it('names no one for a row with no location link', () => {
    const company = only(row('company', { focus: { kind: 'company' }, assignments: [] }))
    expect(marksSubject(company, [], labels)).toBeUndefined()
    expect(marksSubject(market, [], labels)).toBeUndefined()
  })
})

describe('marksNote', () => {
  it('says each query is marked for its own locations where the list is not one location\'s', () => {
    expect(marksNote({ rootLabel: 'All of Acme Homes' })).toEqual({
      label: "Each query's own locations",
      detail: 'M and C are for the locations a query is asked for: one location for a location query, any location in the market for a market query. Another of your locations in the answer does not light them.',
    })
  })

  it('names the one location a list is narrowed to, and how the same query reads under the whole project', () => {
    const detail = 'M and C here are for Harbor Point alone. Under All of Acme Homes a market query is lit when any location in its market is mentioned or cited.'
    expect(marksNote({ location: 'Harbor Point', rootLabel: 'All of Acme Homes' })).toEqual({ label: 'Harbor Point only', detail })
    // On the location's own page the heading already names it.
    expect(marksNote({ location: 'Harbor Point', label: 'This location only', rootLabel: 'All of Acme Homes' })).toEqual({ label: 'This location only', detail })
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

  it('orders by Subject kind, then place, then query text', () => {
    const expected = ['market-d', 'market-u1', 'market-u2', 'location-a', 'location-b', 'hand-picked', 'company', 'none']
    expect(ids(sortTrackedRows(rows, { key: 'subject', direction: 'asc' }))).toEqual(expected)
    // Reversed, the place order flips and the query text under one place still ascends.
    expect(ids(sortTrackedRows(rows, { key: 'subject', direction: 'desc' }))).toEqual(['none', 'company', 'hand-picked', 'location-b', 'location-a', 'market-u1', 'market-u2', 'market-d'])
  })

  it('opens winning first, in the order of the sorted read, with the rows it has no place for after it in Subject order', () => {
    expect(DEFAULT_TRACKED_SORT).toEqual({ key: 'result', direction: 'desc' })
    expect(resultSortOrder(DEFAULT_TRACKED_SORT)).toBe('winning')
    expect(resultSortOrder({ key: 'result', direction: 'asc' })).toBe('losing')
    expect(resultSortOrder({ key: 'query', direction: 'asc' })).toBeUndefined()
    // The server ranked Northbridge's query first, then one of Uptown's; a row it ranked under another type has no place.
    const rank = rankByQuery({ rows: [
      { queryId: 'location-b', queryClass: 'non-brand', engines: [] },
      { queryId: 'market-u1', queryClass: 'non-brand', engines: [] },
      { queryId: 'market-d', queryClass: 'branded', engines: [] },
    ] })
    const expected = ['location-b', 'market-u1', 'market-d', 'market-u2', 'location-a', 'hand-picked', 'company', 'none']
    expect(ids(sortTrackedRows(rows, DEFAULT_TRACKED_SORT, undefined, rank))).toEqual(expected)
    // Losing first is a read sorted the other way, so the order is the server's again and never reversed here.
    expect(ids(sortTrackedRows(rows, { key: 'result', direction: 'asc' }, undefined, rank))).toEqual(expected)
    // Before the sorted read arrives no row has a place, so the Subject order holds.
    expect(ids(sortTrackedRows(rows, DEFAULT_TRACKED_SORT))).toEqual(['market-d', 'market-u1', 'market-u2', 'location-a', 'location-b', 'hand-picked', 'company', 'none'])
    // A new sort by Result starts winning first; a second press turns it.
    expect(nextTrackedSort({ key: 'query', direction: 'asc' }, 'result')).toEqual({ key: 'result', direction: 'desc' })
    expect(nextTrackedSort({ key: 'result', direction: 'desc' }, 'result')).toEqual({ key: 'result', direction: 'asc' })
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

  it('orders Status by status and then by last sweep, newest first, and the other way round when reversed', () => {
    const dated = toTrackedRows(workspace([
      row('older', { lastMeasuredAt: '2026-09-23T12:00:00.000Z' }),
      row('not-asked', { focus: { kind: 'not-asked' }, assignments: [], state: 'awaiting-sweep', lastMeasuredAt: null }),
      // Measured once and waiting again. Its sweep is the newest of all, and it stays with the rows that wait.
      row('waiting', { state: 'awaiting-sweep', lastMeasuredAt: '2026-10-08T12:00:00.000Z' }),
      row('never', { lastMeasuredAt: null }),
      row('newer', { lastMeasuredAt: '2026-10-07T12:00:00.000Z' }),
    ]), [])
    expect(ids(sortTrackedRows(dated, { key: 'status', direction: 'asc' }))).toEqual(['newer', 'older', 'never', 'waiting', 'not-asked'])
    // Never measured is last in its status both ways.
    expect(ids(sortTrackedRows(dated, { key: 'status', direction: 'desc' }))).toEqual(['not-asked', 'waiting', 'older', 'newer', 'never'])
    // Last measured alone ignores the status.
    expect(ids(sortTrackedRows(dated, { key: 'lastMeasured', direction: 'desc' }))).toEqual(['waiting', 'newer', 'older', 'never', 'not-asked'])
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

  it('leaves Last measured and Source to the row detail in the 1152px content column', () => {
    expect(visibleTrackedColumns(1152, 3)).toEqual(without('source', 'lastMeasured'))
  })

  it('shows both only in a frame that keeps Query at 420px beside them', () => {
    // Checkboxes, Subject at 250px, three engines and the rest take 934px.
    expect(visibleTrackedColumns(1400, 3)).toEqual([...TRACKED_COLUMNS])
    expect(visibleTrackedColumns(1354, 3)).toEqual([...TRACKED_COLUMNS])
    expect(visibleTrackedColumns(1353, 3)).toEqual(without('source'))
  })

  it('folds Source first, then Last measured', () => {
    expect(visibleTrackedColumns(1256, 3)).toEqual(without('source'))
    expect(visibleTrackedColumns(1255, 3)).toEqual(without('source', 'lastMeasured'))
  })

  it('needs 62px more for a fourth engine', () => {
    expect(visibleTrackedColumns(1415, 4)).toEqual(without('source'))
    expect(visibleTrackedColumns(1416, 4)).toEqual([...TRACKED_COLUMNS])
  })

  it('folds Last measured away too at 900px', () => {
    expect(visibleTrackedColumns(900, 3)).toEqual(without('source', 'lastMeasured'))
  })
})

describe('trackedLayout', () => {
  const engines = [62, 62, 62]
  const full = { selectable: true }
  /** Query's width: what the frame leaves beside the columns shown. */
  const queryWidth = (frame: number, engineWidths: readonly number[], options: { selectable?: boolean } = full) => {
    const layout = trackedLayout(frame, engineWidths, options)
    const fixed = (options.selectable ? 32 : 0) + layout.subjectWidth + 80 + engineWidths.reduce((sum, width) => sum + width, 0) + 148 + 32
    return frame - fixed - (layout.columns.includes('lastMeasured') ? 108 : 0) - (layout.columns.includes('source') ? 98 : 0)
  }

  it('shows every wanted column, unstacked, where no width is measured', () => {
    expect(trackedLayout(undefined, engines, full)).toEqual({ columns: TRACKED_COLUMNS, stacked: false, subjectWidth: 250 })
  })

  it('gives Query 424px and Subject 250px in the 1152px content column with three engines', () => {
    expect(trackedLayout(1152, engines, full)).toEqual({ columns: ['query', 'subject', 'type', 'engines', 'status', 'menu'], stacked: false, subjectWidth: 250 })
    expect(queryWidth(1152, engines)).toBe(424)
  })

  it('keeps Subject at 250px beside the wide-only columns, which fold before it narrows', () => {
    expect(trackedLayout(1400, engines, full)).toEqual({ columns: TRACKED_COLUMNS, stacked: false, subjectWidth: 250 })
    expect(queryWidth(1400, engines)).toBe(466)
    // 1px short of both: Source folds and Subject keeps its width.
    expect(trackedLayout(1353, engines, full).subjectWidth).toBe(250)
    expect(queryWidth(1353, engines)).toBe(517)
  })

  it('narrows Subject to keep Query at 420px, down to 182px', () => {
    // Three engines: Query is at its 420px in a frame of 1148px, and 4px short of it at 1144.
    expect(trackedLayout(1148, engines, full).subjectWidth).toBe(250)
    expect(trackedLayout(1144, engines, full).subjectWidth).toBe(246)
    expect(queryWidth(1144, engines)).toBe(420)
    // A fourth engine in the content column takes 62px: Subject gives 58 of them and Query holds.
    const four = [62, 62, 62, 62]
    expect(trackedLayout(1152, four, full)).toEqual({ columns: ['query', 'subject', 'type', 'engines', 'status', 'menu'], stacked: false, subjectWidth: 192 })
    expect(queryWidth(1152, four)).toBe(420)
    // Engine columns of 258px in all are the most Query keeps its floor beside there: Subject is at its own.
    const widest = [62, 62, 62, 72]
    expect(trackedLayout(1152, widest, full)).toEqual({ columns: ['query', 'subject', 'type', 'engines', 'status', 'menu'], stacked: false, subjectWidth: 182 })
    expect(queryWidth(1152, widest)).toBe(420)
    // Perplexity's column is 88px. As the fourth it takes Subject to its floor and 16px from Query, and the rows stay a table.
    const withPerplexity = [62, 62, 62, trackedEngineColumnWidth('Perplexity')]
    expect(trackedLayout(1152, withPerplexity, full)).toEqual({ columns: ['query', 'subject', 'type', 'engines', 'status', 'menu'], stacked: false, subjectWidth: 182 })
    expect(queryWidth(1152, withPerplexity)).toBe(404)
    // As one of three it costs Subject 22px and Query nothing.
    expect(trackedLayout(1152, [62, 62, 88], full).subjectWidth).toBe(228)
    expect(queryWidth(1152, [62, 62, 88])).toBe(420)
    // Past Subject's floor Query narrows.
    expect(trackedLayout(1100, four, full).subjectWidth).toBe(182)
    expect(queryWidth(1100, four)).toBe(378)
    // A viewer has no checkbox column, so Subject keeps 32px more.
    expect(trackedLayout(1152, four).subjectWidth).toBe(224)
  })

  it('stacks each row under a 40rem frame, and wider when Query would be too narrow to read', () => {
    expect(trackedLayout(639, [62], { columns: ['query', 'engines'] }).stacked).toBe(true)
    expect(trackedLayout(640, [62], { columns: ['query', 'engines'] }).stacked).toBe(false)
    // Three engines with checkboxes: the columns that never fold take 660px with Subject at its 182px floor, and Query needs 224px beside them.
    expect(trackedLayout(884, engines, full)).toMatchObject({ stacked: false, subjectWidth: 182 })
    expect(trackedLayout(883, engines, full).stacked).toBe(true)
    // With no Subject column there is no room to take from one: Type, three engines, Status and the menu take 446px.
    const noSubject = { columns: ['query', 'type', 'engines', 'status', 'menu'] as const }
    expect(trackedLayout(670, engines, noSubject).stacked).toBe(false)
    expect(trackedLayout(669, engines, noSubject).stacked).toBe(true)
  })

  it('leaves Source and Last measured to the row detail when stacked', () => {
    expect(trackedLayout(390, engines, full).columns).toEqual(['query', 'subject', 'type', 'engines', 'status', 'menu'])
  })

  it('gives the checkbox column width back to Query for a viewer', () => {
    expect(trackedLayout(1340, engines, full).columns).not.toContain('source')
    expect(trackedLayout(1340, engines).columns).toContain('source')
  })

  it('only folds columns the caller wanted', () => {
    const columns = ['query', 'type', 'engines', 'lastMeasured', 'menu'] as const
    // Type, three engines, Last measured and the menu take 406px.
    expect(trackedLayout(826, engines, { columns })).toEqual({ columns, stacked: false, subjectWidth: 250 })
    expect(trackedLayout(825, engines, { columns }).columns).toEqual(['query', 'type', 'engines', 'menu'])
  })

  it('widens an engine column for a longer name, and counts it', () => {
    expect(trackedEngineColumnWidth('OpenAI')).toBe(62)
    expect(trackedEngineColumnWidth('Perplexity')).toBe(88)
    expect(trackedLayout(1360, [62, 62, 62], full).columns).toContain('source')
    expect(trackedLayout(1360, [62, 62, 88], full).columns).not.toContain('source')
  })

  describe('an engine column', () => {
    /** Each engine's name in its header, 13px medium, as Chrome measures it, in px. A new engine needs its own before this passes. */
    const NAME_WIDTH: Record<string, number> = { Gemini: 42, OpenAI: 46, Claude: 43, Perplexity: 61, Muse: 34, Local: 34, 'Cdp:chatgpt': 76 }
    const columns = PROVIDER_NAMES.map(provider => {
      const name = providerDisplayName(provider)
      return { name, text: NAME_WIDTH[name]!, width: trackedEngineColumnWidth(name) }
    })
    /** What a centred name leaves on each side of it, the cell's 4px of padding included. */
    const side = (column: (typeof columns)[number]) => (column.width - column.text) / 2
    /** The sort mark is 12px wide and starts 1px after the name. */
    const MARK = 13

    it('is measured for every engine there is', () => {
      expect(columns.map(column => column.name).sort()).toEqual(Object.keys(NAME_WIDTH).sort())
      expect(Object.fromEntries(columns.map(column => [column.name, column.width]))).toEqual({ Gemini: 62, OpenAI: 62, Claude: 62, Perplexity: 88, Muse: 62, Local: 62, 'Cdp:chatgpt': 95 })
    })

    it.each(columns)('holds $name inside its padding', ({ text, width }) => {
      expect(width - 8).toBeGreaterThanOrEqual(text)
    })

    it.each(columns)('keeps the sort mark after $name off the next header\'s name, whichever engine or column that is', column => {
      // The mark runs past the cell by what the name's side leaves it short. The next engine's name starts its own side in,
      // and at least 4px, a cell's padding, stay between the two.
      for (const next of columns.filter(other => other !== column)) expect(side(column) + side(next) - MARK, next.name).toBeGreaterThanOrEqual(4)
      // After the last engine comes Last measured or Status, whose name starts 10px in.
      expect(side(column) + 10 - MARK).toBeGreaterThanOrEqual(4)
    })
  })
})
