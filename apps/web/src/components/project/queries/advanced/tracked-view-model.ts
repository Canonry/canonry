import type {
  MeasurementQueryTemplate,
  QueryClass,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import type { EngineSignal, TrackedRowVm, TrackedSource, TrackedStatus, TrackedSubject, TrackedType } from './tracked-types.js'

/**
 * The Tracked table's view model: workspace rows in the page's words, the
 * results joined to them, their order and the columns that fit. Pure. Every
 * count is a server field or the length of a list the server returned;
 * sorting loaded rows is the only arithmetic.
 */

type Places = Pick<QueryTrackingWorkspaceResponse, 'targets' | 'markets'>
type Market = QueryTrackingWorkspaceResponse['markets'][number]

/** Names and query text sort as a person reads them: case aside, numbers by value. */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

function subjectOf(row: QueryTrackingTrackedRow, targetLabels: ReadonlyMap<string, string>, markets: ReadonlyMap<string, Market>): TrackedSubject {
  const locationCount = new Set(row.assignments.map(assignment => assignment.targetKey)).size
  // A server that predates `focus` says nothing about the Subject: a row with locations is listed by them.
  if (!row.focus) return locationCount === 0 ? { kind: 'none' } : { kind: 'hand-picked', locationCount }
  switch (row.focus.kind) {
    case 'market': {
      const market = markets.get(row.focus.key)
      return {
        kind: 'market',
        key: row.focus.key,
        label: market?.label ?? row.focus.key,
        // The server's member list. An older server sends only the edges, whose distinct locations that list is.
        locationCount: market?.targetKeys?.length ?? new Set(market?.usageEdges.map(edge => edge.targetKey)).size,
      }
    }
    case 'property': return { kind: 'location', key: row.focus.key, label: targetLabels.get(row.focus.key) ?? row.focus.key }
    case 'company': return { kind: 'company' }
    case 'custom': return { kind: 'hand-picked', locationCount }
    case 'not-asked': return { kind: 'none' }
  }
}

/** A tracked row's Subject in the page's words. The review reads the post-change rows through this. */
export function trackedSubject(row: QueryTrackingTrackedRow, places: Places): TrackedSubject {
  return subjectOf(row, new Map(places.targets.map(target => [target.stableKey, target.label])), new Map(places.markets.map(market => [market.stableKey, market])))
}

/** The types a row is asked under: the server's list, or on an older server the types its locations carry. */
function classesOf(row: QueryTrackingTrackedRow): QueryClass[] {
  if (row.queryClasses) return [...row.queryClasses]
  const classes = new Set<QueryClass>()
  for (const assignment of row.assignments) if (assignment.queryClass) classes.add(assignment.queryClass)
  return [...classes].sort()
}

function sourceOf(row: QueryTrackingTrackedRow, templateNames: ReadonlyMap<string, string>): TrackedSource {
  const provenance = row.provenance
  if (!provenance) return { kind: 'older-list' }
  switch (provenance.source) {
    // The name is the saved pattern's, so a deleted one has none; the text is the row's own frozen copy.
    case 'template': return {
      kind: 'pattern',
      name: provenance.template ? templateNames.get(provenance.template.templateId) ?? null : null,
      pattern: provenance.template?.template ?? null,
    }
    case 'manual': return { kind: 'manual' }
    case 'research':
    case 'discovery': return { kind: 'research' }
    case 'query-set': return { kind: 'setup' }
  }
}

/** Workspace rows as the Tracked table shows them, in the server's order. */
export function toTrackedRows(workspace: QueryTrackingWorkspaceResponse, templates: readonly Pick<MeasurementQueryTemplate, 'id' | 'name'>[]): TrackedRowVm[] {
  const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
  const markets = new Map(workspace.markets.map(market => [market.stableKey, market]))
  const templateNames = new Map(templates.map(template => [template.id, template.name]))
  return workspace.tracked.map(row => {
    const subject = subjectOf(row, targetLabels, markets)
    const queryClasses = classesOf(row)
    const type: TrackedType = queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed'
    const status: TrackedStatus = row.state === 'tracked' ? 'measured' : subject.kind === 'none' ? 'not-asked' : 'first-answers'
    return {
      queryId: row.queryId,
      queryText: row.queryText,
      subject,
      type,
      queryClasses,
      status,
      source: sourceOf(row, templateNames),
      lastMeasuredAt: row.lastMeasuredAt,
      addedAt: row.provenance?.capturedAt ?? null,
      tracked: row,
    }
  })
}

const SUBJECT_KIND_LABEL: Record<TrackedSubject['kind'], string> = {
  market: 'Market',
  location: 'Location',
  company: 'Company',
  'hand-picked': 'Hand-picked',
  none: 'None',
}
const TYPE_LABEL: Record<TrackedType, string> = { branded: 'Branded', 'non-brand': 'Non-brand', mixed: 'Mixed', 'not-set': 'Not set' }
const SOURCE_LABEL: Record<TrackedSource['kind'], string> = { pattern: 'Pattern', manual: 'Manual', research: 'Research', setup: 'Setup', 'older-list': 'Older list' }

export const subjectKindLabel = (kind: TrackedSubject['kind']): string => SUBJECT_KIND_LABEL[kind]
export const locationCountLabel = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'location' : 'locations'}`

/** "Market · Uptown (3)", "Location · Harbor Point", "Company", "Hand-picked · 12 locations", "None". */
export function subjectLabel(subject: TrackedSubject): string {
  switch (subject.kind) {
    case 'market': return `${SUBJECT_KIND_LABEL.market} · ${subject.label} (${subject.locationCount.toLocaleString('en-US')})`
    case 'location': return `${SUBJECT_KIND_LABEL.location} · ${subject.label}`
    case 'hand-picked': return `${SUBJECT_KIND_LABEL['hand-picked']} · ${locationCountLabel(subject.locationCount)}`
    case 'company':
    case 'none': return SUBJECT_KIND_LABEL[subject.kind]
  }
}

export const typeLabel = (type: TrackedType): string => TYPE_LABEL[type]

/** "Pattern: Best", or "Pattern" when the saved pattern is gone. */
export function sourceLabel(source: TrackedSource): string {
  return source.kind === 'pattern' && source.name ? `Pattern: ${source.name}` : SOURCE_LABEL[source.kind]
}

/** `nextSweepDate` is the date as shown ("Oct 21"). Without one, a waiting row names no date. */
export function statusLabel(status: TrackedStatus, nextSweepDate?: string): string {
  switch (status) {
    case 'measured': return 'Measured'
    case 'first-answers': return nextSweepDate ? `First answers ${nextSweepDate}` : 'First answers'
    case 'not-asked': return 'Not asked'
  }
}

/**
 * The results read as far as the table needs it: one row per query and type,
 * each with its engines. Typed by shape, so the table compiles before that
 * read is on the wire.
 */
export interface TrackedResults {
  rows: readonly {
    queryId: string
    /** Branded, non-brand, or `unknown` for a query asked with no type set. */
    queryClass: string
    engines: readonly ({ provider: string } & EngineSignal)[]
  }[]
}

/** A row asked with no type set joins the results under this type. */
const UNSET_RESULT_CLASS = 'unknown'

/** Engine signals by query and type, then by engine. Branded and non-brand results never share an entry. */
export type TrackedCoverage = ReadonlyMap<string, ReadonlyMap<string, EngineSignal>>

const coverageKey = (queryId: string, queryClass: string) => `${queryClass}:${queryId}`

/** Undefined while the results load, so each chip draws its skeleton. */
export function coverageByQuery(results: TrackedResults | null | undefined): TrackedCoverage | undefined {
  if (!results) return undefined
  const coverage = new Map<string, Map<string, EngineSignal>>()
  for (const row of results.rows) {
    const engines = new Map<string, EngineSignal>()
    for (const { provider, mentioned, cited, answers, mentionedAnswers, citedAnswers, uncheckedSourceAnswers } of row.engines) {
      engines.set(provider, { mentioned, cited, answers, mentionedAnswers, citedAnswers, uncheckedSourceAnswers })
    }
    coverage.set(coverageKey(row.queryId, row.queryClass), engines)
  }
  return coverage
}

/** The types a row's results are joined on: its own, or the unset one. A mixed row has two. */
export function resultClasses(row: Pick<TrackedRowVm, 'queryClasses'>): readonly string[] {
  return row.queryClasses.length > 0 ? row.queryClasses : [UNSET_RESULT_CLASS]
}

/**
 * One engine's signal for one query and type: undefined while results load,
 * null when the sweep holds no result for that pairing (not checked). A result
 * under the row's other type is never borrowed.
 */
export function engineSignal(coverage: TrackedCoverage | undefined, queryId: string, queryClass: string, provider: string): EngineSignal | null | undefined {
  if (!coverage) return undefined
  return coverage.get(coverageKey(queryId, queryClass))?.get(provider) ?? null
}

export type TrackedSortKey = 'query' | 'subject' | 'lastMeasured' | 'status' | `engine:${string}`
export interface TrackedSort { key: TrackedSortKey; direction: 'asc' | 'desc' }

/** Subject kind (Market, Location, Hand-picked, Company, None), then place, then query text. */
export const DEFAULT_TRACKED_SORT: TrackedSort = { key: 'subject', direction: 'asc' }

export const engineSortKey = (provider: string): TrackedSortKey => `engine:${provider}`

/** A second click on the sorted column flips it; a new column starts ascending. */
export function nextTrackedSort(current: TrackedSort | undefined, key: TrackedSortKey): TrackedSort {
  return { key, direction: current?.key === key && current.direction === 'asc' ? 'desc' : 'asc' }
}

const SUBJECT_ORDER: Record<TrackedSubject['kind'], number> = { market: 0, location: 1, 'hand-picked': 2, company: 3, none: 4 }
const STATUS_ORDER: Record<TrackedStatus, number> = { measured: 0, 'first-answers': 1, 'not-asked': 2 }

const placeOf = (subject: TrackedSubject) => subject.kind === 'market' || subject.kind === 'location' ? subject.label : ''
const bySubject = (left: TrackedRowVm, right: TrackedRowVm) =>
  SUBJECT_ORDER[left.subject.kind] - SUBJECT_ORDER[right.subject.kind] || collator.compare(placeOf(left.subject), placeOf(right.subject))

/**
 * A row's state on one engine, for sorting only: no when any of its types
 * has a no, so a row with something to fix sorts with the rows to fix. Null is
 * not checked, or still loading.
 */
function sortState(row: TrackedRowVm, coverage: TrackedCoverage | undefined, provider: string, signal: 'mentioned' | 'cited'): boolean | null {
  let state: boolean | null = null
  for (const queryClass of resultClasses(row)) {
    const value = engineSignal(coverage, row.queryId, queryClass, provider)?.[signal] ?? null
    if (value === false) return false
    if (value === true) state = true
  }
  return state
}

/** Not checked sorts last whichever way the column runs, as a row never measured does. */
function byState(left: boolean | null, right: boolean | null, sign: 1 | -1): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return (Number(left) - Number(right)) * sign
}

/**
 * Rows in the order a header asks for. An engine column puts not mentioned
 * first, then not cited. Ties fall back to the default order, so a sort is
 * stable across pages.
 */
export function sortTrackedRows(rows: readonly TrackedRowVm[], sort: TrackedSort = DEFAULT_TRACKED_SORT, coverage?: TrackedCoverage): TrackedRowVm[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const { key } = sort
  const primary = (left: TrackedRowVm, right: TrackedRowVm): number => {
    if (key === 'query') return collator.compare(left.queryText, right.queryText) * sign
    if (key === 'subject') return bySubject(left, right) * sign
    if (key === 'status') return (STATUS_ORDER[left.status] - STATUS_ORDER[right.status]) * sign
    if (key === 'lastMeasured') {
      if (left.lastMeasuredAt === right.lastMeasuredAt) return 0
      if (left.lastMeasuredAt === null) return 1
      if (right.lastMeasuredAt === null) return -1
      return (left.lastMeasuredAt < right.lastMeasuredAt ? -1 : 1) * sign
    }
    const provider = key.slice('engine:'.length)
    return byState(sortState(left, coverage, provider, 'mentioned'), sortState(right, coverage, provider, 'mentioned'), sign)
      || byState(sortState(left, coverage, provider, 'cited'), sortState(right, coverage, provider, 'cited'), sign)
  }
  return [...rows].sort((left, right) =>
    primary(left, right) || bySubject(left, right) || collator.compare(left.queryText, right.queryText) || (left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0))
}

/** The table's columns, in order. The checkbox column is not one: it shows when the caller takes a selection. */
export const TRACKED_COLUMNS = ['query', 'subject', 'type', 'engines', 'lastMeasured', 'status', 'source', 'menu'] as const
export type TrackedColumn = (typeof TRACKED_COLUMNS)[number]

/** Column widths in px. Query takes what is left, and at the 1152px content column with three engines that is its floor. */
export const TRACKED_COLUMN_WIDTH = { select: 32, subject: 180, type: 80, engine: 62, lastMeasured: 108, status: 146, source: 100, menu: 32 } as const
/** Under this, Query gives up Source and then Last measured. Both stay in the row detail. */
const TRACKED_QUERY_FLOOR = 288
/** Under this with both folded away, or in a frame under 40rem, each row stacks. */
const TRACKED_QUERY_STACK_FLOOR = 224
/** 40rem, the width the stylesheet's phone rules for a stacked row also turn on. */
const TRACKED_STACK_WIDTH = 640

/** An engine column is as wide as its header needs: two chips, or a longer name and the gap to the next one. */
export function trackedEngineColumnWidth(label: string): number {
  return Math.max(TRACKED_COLUMN_WIDTH.engine, Math.ceil(label.length * 7.2) + 16)
}

export interface TrackedLayout {
  columns: readonly TrackedColumn[]
  /** Each row is a block under no header: the query and its menu, then Subject, Type, the engines by name and Status. */
  stacked: boolean
}

/**
 * What fits in a frame `containerWidth` wide. Without a width (no
 * `ResizeObserver`) every wanted column shows. `engineWidths` is one width per
 * engine column.
 */
export function trackedLayout(
  containerWidth: number | undefined,
  engineWidths: readonly number[],
  { columns = TRACKED_COLUMNS, selectable = false }: { columns?: readonly TrackedColumn[]; selectable?: boolean } = {},
): TrackedLayout {
  if (containerWidth === undefined) return { columns, stacked: false }
  const fixedWidth = (shown: readonly TrackedColumn[]) => shown.reduce((width, column) => {
    if (column === 'query') return width
    if (column === 'engines') return width + engineWidths.reduce((sum, engine) => sum + engine, 0)
    return width + TRACKED_COLUMN_WIDTH[column]
  }, selectable ? TRACKED_COLUMN_WIDTH.select : 0)
  const queryWidth = (shown: readonly TrackedColumn[]) => containerWidth - fixedWidth(shown)
  let shown = columns
  for (const optional of ['source', 'lastMeasured'] as const) {
    if (queryWidth(shown) >= TRACKED_QUERY_FLOOR) break
    shown = shown.filter(column => column !== optional)
  }
  if (containerWidth >= TRACKED_STACK_WIDTH && queryWidth(shown) >= TRACKED_QUERY_STACK_FLOOR) return { columns: shown, stacked: false }
  // A stacked row has no place for the two optional columns; the row detail holds them.
  return { columns: columns.filter(column => column !== 'source' && column !== 'lastMeasured'), stacked: true }
}

/**
 * The columns of the full table (checkboxes on) that fit `containerWidth` with
 * `engineCount` engine columns of the default width: Source goes first, then
 * Last measured.
 */
export function visibleTrackedColumns(containerWidth: number, engineCount: number): TrackedColumn[] {
  return [...trackedLayout(containerWidth, Array.from({ length: engineCount }, () => TRACKED_COLUMN_WIDTH.engine), { selectable: true }).columns]
}
