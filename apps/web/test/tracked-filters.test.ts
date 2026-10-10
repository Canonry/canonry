import { describe, expect, test } from 'vitest'

import {
  activeFilterCount,
  DEFAULT_TRACKED_FILTERS,
  matchesTrackedFilters,
  parseTrackedFilters,
  trackedFiltersPatch,
} from '../src/components/project/queries/advanced/tracked-filters.js'
import type { EngineSignal, TrackedFilters, TrackedRowVm, TrackedSource, TrackedSubject } from '../src/components/project/queries/advanced/tracked-types.js'

const NARROWED: TrackedFilters = { subject: 'hand-picked', type: 'not-set', status: 'first-answers', source: 'older-list', result: 'not-cited' }

function row(id: string, subject: TrackedSubject, type: TrackedRowVm['type'], status: TrackedRowVm['status'], source: TrackedSource['kind']): TrackedRowVm {
  return {
    queryId: id,
    queryText: id,
    subject,
    type,
    queryClasses: type === 'mixed' ? ['branded', 'non-brand'] : type === 'not-set' ? [] : [type],
    status,
    source: source === 'pattern' ? { kind: 'pattern', name: null, pattern: null } : { kind: source },
    lastMeasuredAt: null,
    addedAt: null,
    tracked: { queryId: id, queryText: id, normalizedText: id, provenance: null, state: 'tracked', lastMeasuredAt: null, assignments: [] },
  }
}

// One row for every Subject, Type, Status and Source there is.
const ROWS = [
  row('market', { kind: 'market', key: 'm1', label: 'Harbor District', locationCount: 3 }, 'non-brand', 'measured', 'pattern'),
  row('location', { kind: 'location', key: 't1', label: 'Acme Homes Harbor Point' }, 'branded', 'first-answers', 'manual'),
  row('company', { kind: 'company' }, 'branded', 'measured', 'setup'),
  row('hand-picked', { kind: 'hand-picked', locationCount: 12 }, 'mixed', 'measured', 'research'),
  row('none', { kind: 'none' }, 'not-set', 'not-asked', 'older-list'),
]
const listed = (filters: Partial<TrackedFilters>) => ROWS
  .filter(candidate => matchesTrackedFilters(candidate, { ...DEFAULT_TRACKED_FILTERS, status: 'all', ...filters }, []))
  .map(candidate => candidate.queryId)

describe('tracked filters in the URL', () => {
  test('a clean URL reads as the defaults: asked queries of every Subject, Type and Source', () => {
    expect(parseTrackedFilters({})).toEqual({ subject: 'any', type: 'all', status: 'asked', source: 'any', result: 'any' })
    expect(parseTrackedFilters({ queryClass: 'branded', trackingQueryId: 'q1' })).toEqual(DEFAULT_TRACKED_FILTERS)
  })

  test('every filter round-trips through its own key', () => {
    const patch = trackedFiltersPatch(NARROWED)
    expect(patch).toEqual({ trackedSubject: 'hand-picked', trackedType: 'not-set', trackedStatus: 'first-answers', trackedSource: 'older-list', trackedResult: 'not-cited' })
    expect(parseTrackedFilters(patch)).toEqual(NARROWED)
    expect(parseTrackedFilters(trackedFiltersPatch(DEFAULT_TRACKED_FILTERS))).toEqual(DEFAULT_TRACKED_FILTERS)
  })

  test('a default clears its key, and a patch touches only the filters it was given', () => {
    expect(trackedFiltersPatch({ ...NARROWED, status: 'asked', result: 'any' })).toEqual({
      trackedSubject: 'hand-picked', trackedType: 'not-set', trackedStatus: undefined, trackedSource: 'older-list', trackedResult: undefined,
    })
    expect(trackedFiltersPatch({ status: 'not-asked' })).toEqual({ trackedStatus: 'not-asked' })
    // The key is present and undefined, so spreading the patch over the URL removes a set filter.
    expect(Object.keys(trackedFiltersPatch({ subject: 'any' }))).toEqual(['trackedSubject'])
  })

  test('a value no choice carries falls back to that filter\'s default and leaves the others alone', () => {
    expect(parseTrackedFilters({ trackedSubject: 'property', trackedType: 'unknown', trackedStatus: 'not-asked', trackedSource: 'template', trackedResult: 'not-mentioned' }))
      .toEqual({ subject: 'any', type: 'all', status: 'not-asked', source: 'any', result: 'not-mentioned' })
    expect(parseTrackedFilters({ trackedSubject: ['market'], trackedType: 7, trackedStatus: null, trackedSource: '', trackedResult: true })).toEqual(DEFAULT_TRACKED_FILTERS)
    // A Subject value is not a Source value: each key takes only its own choices.
    expect(parseTrackedFilters({ trackedSource: 'market', trackedSubject: 'manual' })).toEqual(DEFAULT_TRACKED_FILTERS)
  })

  test('counts the filters that are off their default', () => {
    expect(activeFilterCount(DEFAULT_TRACKED_FILTERS)).toBe(0)
    expect(activeFilterCount({ ...DEFAULT_TRACKED_FILTERS, status: 'all' })).toBe(1)
    expect(activeFilterCount({ ...DEFAULT_TRACKED_FILTERS, subject: 'market', result: 'not-checked' })).toBe(2)
    expect(activeFilterCount(NARROWED)).toBe(5)
  })
})

describe('which rows the filters list', () => {
  test.each<[TrackedFilters['subject'], string[]]>([
    ['any', ['market', 'location', 'company', 'hand-picked', 'none']],
    ['market', ['market']],
    ['location', ['location']],
    ['company', ['company']],
    ['hand-picked', ['hand-picked']],
    ['none', ['none']],
  ])('Subject %s', (subject, expected) => {
    expect(listed({ subject })).toEqual(expected)
  })

  test.each<[TrackedFilters['type'], string[]]>([
    ['all', ['market', 'location', 'company', 'hand-picked', 'none']],
    // The hand-picked row is mixed: asked as Branded for some locations and Non-brand for others.
    ['non-brand', ['market', 'hand-picked']],
    ['branded', ['location', 'company', 'hand-picked']],
    ['mixed', ['hand-picked']],
    ['not-set', ['none']],
  ])('Type %s', (type, expected) => {
    expect(listed({ type })).toEqual(expected)
  })

  test.each<[TrackedFilters['status'], string[]]>([
    ['asked', ['market', 'location', 'company', 'hand-picked']],
    ['measured', ['market', 'company', 'hand-picked']],
    ['first-answers', ['location']],
    ['not-asked', ['none']],
    ['all', ['market', 'location', 'company', 'hand-picked', 'none']],
  ])('Status %s', (status, expected) => {
    expect(listed({ status })).toEqual(expected)
  })

  test.each<[TrackedFilters['source'], string[]]>([
    ['any', ['market', 'location', 'company', 'hand-picked', 'none']],
    ['pattern', ['market']],
    ['manual', ['location']],
    ['research', ['hand-picked']],
    ['setup', ['company']],
    ['older-list', ['none']],
  ])('Source %s', (source, expected) => {
    expect(listed({ source })).toEqual(expected)
  })

  test('the default Status hides a row that is not asked, whatever else matches', () => {
    const notAsked = ROWS[4]!
    expect(matchesTrackedFilters(notAsked, DEFAULT_TRACKED_FILTERS, [])).toBe(false)
    expect(matchesTrackedFilters(notAsked, { ...DEFAULT_TRACKED_FILTERS, subject: 'none', type: 'not-set', source: 'older-list' }, [])).toBe(false)
    expect(matchesTrackedFilters(notAsked, { ...DEFAULT_TRACKED_FILTERS, status: 'not-asked' }, [])).toBe(true)
  })

  test('filters narrow together', () => {
    expect(listed({ type: 'branded', status: 'measured' })).toEqual(['company', 'hand-picked'])
    expect(listed({ type: 'branded', status: 'measured', source: 'research' })).toEqual(['hand-picked'])
    expect(listed({ subject: 'market', type: 'branded' })).toEqual([])
  })
})

describe('Result', () => {
  const measured = ROWS[0]!
  const signal = (mentioned: boolean | null, cited: boolean | null): EngineSignal => ({ mentioned, cited })
  const lists = (result: TrackedFilters['result'], signals: readonly (EngineSignal | null | undefined)[]) => matchesTrackedFilters(measured, { ...DEFAULT_TRACKED_FILTERS, result }, signals)
  const BOTH = signal(true, true)

  test('Any lists a row whatever its chips show', () => {
    for (const signals of [[], [BOTH], [null], [undefined], [signal(false, false)]]) expect(lists('any', signals)).toBe(true)
  })

  test('Not mentioned lists a row when any engine cell is not mentioned', () => {
    expect(lists('not-mentioned', [BOTH, signal(false, true)])).toBe(true)
    expect(lists('not-mentioned', [BOTH, BOTH])).toBe(false)
    // Cited is its own signal: a No there is not a No here, and neither is a mention that was not checked.
    expect(lists('not-mentioned', [signal(true, false), signal(null, false), null])).toBe(false)
  })

  test('Not cited lists a row when any engine cell is not cited', () => {
    expect(lists('not-cited', [BOTH, signal(true, false)])).toBe(true)
    expect(lists('not-cited', [BOTH, BOTH])).toBe(false)
    expect(lists('not-cited', [signal(false, true), signal(false, null), null])).toBe(false)
  })

  test('Not checked lists a row with a cell that has no result, or with either chip not checked', () => {
    expect(lists('not-checked', [BOTH, null])).toBe(true)
    expect(lists('not-checked', [BOTH, signal(true, null)])).toBe(true)
    expect(lists('not-checked', [BOTH, signal(null, false)])).toBe(true)
    expect(lists('not-checked', [BOTH, signal(false, false)])).toBe(false)
    // A row with no engine cell at all was never checked.
    expect(lists('not-checked', [])).toBe(true)
  })

  test('a cell that is still loading matches no result yet', () => {
    for (const result of ['not-mentioned', 'not-cited', 'not-checked'] as const) expect(lists(result, [undefined, undefined])).toBe(false)
  })
})
