import type { QueryClass } from '@canonry/canonry-contracts'

import type { EngineSignal, TrackedFilters, TrackedRowVm } from './tracked-types.js'

/** One choice of a Tracked filter: the value the URL carries and the words the toolbar shows. */
export interface TrackedFilterOption<T extends string> { value: T; label: string }

/** The engine's choices are the page's engines, so it has no fixed list here. */
type FixedFilter = Exclude<keyof TrackedFilters, 'engine'>
type FilterOptions = { readonly [K in FixedFilter]: readonly TrackedFilterOption<TrackedFilters[K]>[] }

/** Every choice of every filter, in toolbar order. The first of each is its default. */
export const TRACKED_FILTER_OPTIONS: FilterOptions = {
  subject: [
    { value: 'any', label: 'Any' },
    { value: 'market', label: 'Market' },
    { value: 'location', label: 'Location' },
    { value: 'company', label: 'Company' },
    { value: 'hand-picked', label: 'Hand-picked' },
    { value: 'none', label: 'None' },
  ],
  type: [
    { value: 'all', label: 'All' },
    { value: 'non-brand', label: 'Non-brand' },
    { value: 'branded', label: 'Branded' },
    { value: 'mixed', label: 'Mixed' },
    { value: 'not-set', label: 'Not set' },
  ],
  status: [
    { value: 'asked', label: 'Asked' },
    { value: 'measured', label: 'Measured' },
    { value: 'first-answers', label: 'First answers' },
    { value: 'not-asked', label: 'Not asked' },
    { value: 'all', label: 'All' },
  ],
  source: [
    { value: 'any', label: 'Any' },
    { value: 'pattern', label: 'Pattern' },
    { value: 'manual', label: 'Manual' },
    { value: 'research', label: 'Research' },
    { value: 'setup', label: 'Setup' },
    { value: 'older-list', label: 'Older list' },
  ],
  result: [
    { value: 'any', label: 'Any' },
    { value: 'mentioned', label: 'Mentioned' },
    { value: 'partly-mentioned', label: 'Partly mentioned' },
    { value: 'not-mentioned', label: 'Not mentioned' },
    { value: 'cited', label: 'Cited' },
    { value: 'partly-cited', label: 'Partly cited' },
    { value: 'not-cited', label: 'Not cited' },
    { value: 'not-checked', label: 'Not checked' },
    { value: 'other-location', label: 'Other location' },
  ],
  change: [
    { value: 'any', label: 'Any' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
  ],
  signal: [
    { value: 'mentioned', label: 'Mentioned' },
    { value: 'cited', label: 'Cited' },
  ],
  group: [
    { value: 'auto', label: 'Auto' },
    { value: 'market', label: 'Market' },
    { value: 'group', label: 'Group' },
    { value: 'none', label: 'None' },
  ],
}

/** The Result choices of one signal: a list follows the switch. Not checked is both signals'; Other location is the mention's. */
export function resultOptionsFor(signal: TrackedFilters['signal']): readonly TrackedFilterOption<TrackedFilters['result']>[] {
  return TRACKED_FILTER_OPTIONS.result.filter(option => option.value === 'any' || option.value === 'not-checked'
    || (signal === 'mentioned' ? option.value.endsWith('mentioned') || option.value === 'other-location' : option.value.endsWith('cited')))
}

/** A Result chosen under one signal, read under the other: Mentioned is Cited, Not mentioned is Not cited. Other location has no citation reading. */
export function resultForSignal(result: TrackedFilters['result'], signal: TrackedFilters['signal']): TrackedFilters['result'] {
  if (result === 'any' || result === 'not-checked') return result
  if (result === 'other-location') return signal === 'mentioned' ? result : 'any'
  return (signal === 'mentioned' ? result.replace('cited', 'mentioned') : result.replace('mentioned', 'cited')) as TrackedFilters['result']
}

/** The URL key of each filter. */
export const TRACKED_FILTER_KEYS = {
  subject: 'trackedSubject',
  type: 'trackedType',
  status: 'trackedStatus',
  source: 'trackedSource',
  result: 'trackedResult',
  engine: 'trackedEngine',
  change: 'trackedChange',
  signal: 'trackedSignal',
  group: 'trackedGroup',
} as const satisfies Record<keyof TrackedFilters, string>

const FILTERS = Object.keys(TRACKED_FILTER_KEYS) as (keyof TrackedFilters)[]
/** The switch and the grouping: toolbar state that narrows nothing. */
const VIEW_KEYS: readonly (keyof TrackedFilters)[] = ['signal', 'group']
/** An engine id as the URL carries one. */
const ENGINE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** A clean URL: queries that are asked, of every Subject, Type and Source, whatever their result, by mention, markets first. */
export const DEFAULT_TRACKED_FILTERS: TrackedFilters = {
  subject: 'any', type: 'all', status: 'asked', source: 'any', result: 'any', engine: 'any', change: 'any', signal: 'mentioned', group: 'auto',
}

/** The filters cleared, the switch and the grouping kept. */
export function clearedTrackedFilters(filters: Pick<TrackedFilters, 'signal' | 'group'>, patch: Partial<TrackedFilters> = {}): TrackedFilters {
  return { ...DEFAULT_TRACKED_FILTERS, signal: filters.signal, group: filters.group, ...patch }
}

/** Reads the filters from the URL search. A missing key, or a value no choice carries, reads as that filter's default. */
export function parseTrackedFilters(search: Record<string, unknown>): TrackedFilters {
  const filters: Record<string, string> = { ...DEFAULT_TRACKED_FILTERS }
  for (const filter of FILTERS) {
    const value = search[TRACKED_FILTER_KEYS[filter]]
    const valid = filter === 'engine'
      ? typeof value === 'string' && ENGINE_ID.test(value)
      : TRACKED_FILTER_OPTIONS[filter].some(option => option.value === value)
    if (valid) filters[filter] = value as string
  }
  return filters as unknown as TrackedFilters
}

/** The URL patch for the filters given. A default clears its key, so a clean view has a clean URL. */
export function trackedFiltersPatch(filters: Partial<TrackedFilters>): Partial<Record<typeof TRACKED_FILTER_KEYS[keyof TrackedFilters], string | undefined>> {
  const patch: Partial<Record<typeof TRACKED_FILTER_KEYS[keyof TrackedFilters], string | undefined>> = {}
  for (const filter of FILTERS) {
    const value = filters[filter]
    if (value !== undefined) patch[TRACKED_FILTER_KEYS[filter]] = value === DEFAULT_TRACKED_FILTERS[filter] ? undefined : value
  }
  return patch
}

/** How many filters are off their default. An engine with no Result or Change to read on it narrows nothing. */
export function activeFilterCount(filters: TrackedFilters): number {
  return FILTERS.filter(filter => !VIEW_KEYS.includes(filter) && filters[filter] !== DEFAULT_TRACKED_FILTERS[filter]
    && (filter !== 'engine' || filters.result !== 'any' || filters.change !== 'any')).length
}

/**
 * One engine cell of a row: the type its chips were asked under, the engine,
 * and what they show. `null` is a cell with no result and `undefined` one
 * still loading.
 */
export interface TrackedResultCell { queryClass: QueryClass; provider: string; signal: EngineSignal | null | undefined }

/**
 * Whether a row's chips show the result asked for. A cell still loading
 * matches nothing yet. A cell is not checked when either chip is. A row with
 * no cell is asked on no engine, so it shows no result at all.
 */
function matchesResult(result: Exclude<TrackedFilters['result'], 'any'>, signals: readonly (EngineSignal | null | undefined)[]): boolean {
  if (result === 'not-checked') return signals.some(signal => signal === null || (signal !== undefined && (signal.mentioned === null || signal.cited === null)))
  if (result === 'other-location') return signals.some(signal => (signal?.otherLocationMentionedAnswers ?? 0) > 0 || (signal?.otherLocationCitedAnswers ?? 0) > 0)
  const field = result.endsWith('mentioned') ? 'mentioned' : 'cited'
  const yes = signals.some(signal => signal?.[field] === true)
  const no = signals.some(signal => signal?.[field] === false)
  if (result.startsWith('not-')) return no && !yes
  if (result.startsWith('partly-')) return yes && no
  return yes
}

/**
 * Whether the filters list a row. They only list: nothing is counted or
 * summed here. A mixed row is asked both ways, so Non-brand, Branded and Mixed
 * all list it. `cells` are the row's engine cells, one per engine and type.
 * Under Non-brand or Branded only the cells of that type decide Result, so a
 * mixed row's Branded chips never list it among Non-brand results.
 */
export function matchesTrackedFilters(row: TrackedRowVm, filters: TrackedFilters, cells: readonly TrackedResultCell[]): boolean {
  if (filters.subject !== 'any' && row.subject.kind !== filters.subject) return false
  if (filters.type !== 'all' && row.type !== filters.type && !(row.type === 'mixed' && (filters.type === 'branded' || filters.type === 'non-brand'))) return false
  if (filters.status === 'asked' ? row.status === 'not-asked' : filters.status !== 'all' && row.status !== filters.status) return false
  if (filters.source !== 'any' && row.source.kind !== filters.source) return false
  const { result, change } = filters
  if (result === 'any' && change === 'any') return true
  const ofType = (filters.type === 'branded' || filters.type === 'non-brand' ? cells.filter(cell => cell.queryClass === filters.type) : cells)
    .filter(cell => filters.engine === 'any' || cell.provider === filters.engine)
  // A change is one engine's, of the switch's signal: a row lists when one of its engines won or lost it.
  const changeField = filters.signal === 'cited' ? 'citationChange' : 'mentionChange'
  return [...new Set(ofType.map(cell => cell.queryClass))].some(queryClass => {
    const signals = ofType.filter(cell => cell.queryClass === queryClass).map(cell => cell.signal)
    return (result === 'any' || matchesResult(result, signals)) && (change === 'any' || signals.some(signal => signal?.[changeField] === change))
  })
}
