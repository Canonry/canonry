import type { QueryClass, QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'

/**
 * The shared types of the Tracked page: its view model, table, toolbar, row
 * menu and action sheet all read these, so each compiles on its own. Types
 * only. The wire keeps its own words; these are what the page shows: the
 * wire's `property` is a Location, `custom` is Hand-picked and `not-asked` is
 * a Subject of None.
 */

/** One engine's Mentioned and Cited for one query and type. Three states each; neither is read from the other. */
export type { EngineSignal } from '../../../shared/SignalCells.js'

/** What a tracked query is about. A market and a hand-picked row carry how many locations they are asked for. */
export type TrackedSubject =
  | { kind: 'market'; key: string; label: string; locationCount: number }
  | { kind: 'location'; key: string; label: string }
  | { kind: 'company' }
  | { kind: 'hand-picked'; locationCount: number }
  | { kind: 'none' }

/** Mixed is one query asked as Branded for some locations and as Non-brand for others. The two are never combined. */
export type TrackedType = QueryClass | 'mixed' | 'not-set'

/** Measured has answers. First answers waits for its first sweep. Not asked is in no location's plan. */
export type TrackedStatus = 'measured' | 'first-answers' | 'not-asked'

/** Where the query came from. A pattern whose saved record is gone keeps the kind and loses its name and text. */
export type TrackedSource =
  | { kind: 'pattern'; name: string | null; pattern: string | null }
  | { kind: 'manual' | 'research' | 'setup' | 'older-list' }

/** One row of the Tracked table. */
export interface TrackedRowVm {
  queryId: string
  queryText: string
  subject: TrackedSubject
  type: TrackedType
  /** The types the query is asked under. Results join on query and type, so a mixed row has two sets of chips. */
  queryClasses: readonly QueryClass[]
  status: TrackedStatus
  source: TrackedSource
  lastMeasuredAt: string | null
  /** When the query entered tracking; null when its source was not recorded. */
  addedAt: string | null
  /** The workspace row behind this one: its location links for the row detail, and what an action changes. */
  tracked: QueryTrackingTrackedRow
}

/** What the row menu and the bulk bar can do. Track and Remove are for a row that is not asked. */
export type TrackedRowAction =
  | 'edit-wording'
  | 'change-subject'
  | 'move-location'
  | 'change-type'
  | 'stop'
  | 'track'
  | 'remove'
  | 'copy-link'

/** The Tracked toolbar's filters. They list rows and never sum anything. `asked` is Measured and First answers together. */
export interface TrackedFilters {
  subject: 'any' | TrackedSubject['kind']
  type: 'all' | TrackedType
  status: 'asked' | TrackedStatus | 'all'
  source: 'any' | TrackedSource['kind']
  /** Matches a row when any of its engine chips is in that state. */
  result: 'any' | 'not-mentioned' | 'not-cited' | 'not-checked'
}
