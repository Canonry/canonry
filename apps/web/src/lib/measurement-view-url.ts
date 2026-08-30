/**
 * The advanced-measurement view state as URL search params.
 *
 * Scale is why this is in the URL at all. With a handful of properties an
 * operator can re-pick a market after every reload; with hundreds of markets
 * that re-pick IS the interaction, and a scope held only in component state
 * cannot be linked, bookmarked, reloaded, or reported in a bug.
 *
 * Defaults are written as ABSENT rather than as `scope=all&class=non-brand`,
 * so the common case leaves a clean URL and only a deliberate choice shows up.
 */

export type MeasurementQueryClass = 'all' | 'non-brand' | 'branded'

export interface MeasurementViewState {
  scope: 'all' | 'group'
  groupKey?: string
  queryClass: MeasurementQueryClass
}

/** A Property has one query class at a time; pooled coverage belongs to its Group. */
export type MeasurementPropertyQueryClass = Exclude<MeasurementQueryClass, 'all'>

export interface MeasurementPropertyViewState {
  queryClass: MeasurementPropertyQueryClass
}

/**
 * Non-brand is the actionable default. Branded and non-brand answer different
 * questions, so the first view must not pool them into one headline rate. All
 * queries remains an explicit option for operators who need that combined scope.
 */
export const DEFAULT_MEASUREMENT_VIEW: MeasurementViewState = { scope: 'all', queryClass: 'non-brand' }

const QUERY_CLASSES: readonly MeasurementQueryClass[] = ['all', 'non-brand', 'branded']
const PROPERTY_QUERY_CLASSES: readonly MeasurementPropertyQueryClass[] = ['non-brand', 'branded']

function isQueryClass(value: unknown): value is MeasurementQueryClass {
  return typeof value === 'string' && (QUERY_CLASSES as readonly string[]).includes(value)
}

function isPropertyQueryClass(value: unknown): value is MeasurementPropertyQueryClass {
  return typeof value === 'string' && (PROPERTY_QUERY_CLASSES as readonly string[]).includes(value)
}

/**
 * Read view state out of the URL. Anything unrecognised degrades to the
 * default rather than throwing: these values arrive from a bookmark a person
 * saved months ago, or from a link someone edited by hand, and a malformed one
 * must not be able to break the page.
 */
export function parseMeasurementViewSearch(search: { scope?: string; class?: string }): MeasurementViewState {
  const queryClass = isQueryClass(search.class) ? search.class : DEFAULT_MEASUREMENT_VIEW.queryClass
  const raw = search.scope
  if (typeof raw !== 'string' || raw === 'all' || raw.length === 0) {
    return { scope: 'all', queryClass }
  }
  const groupKey = raw.startsWith('group:') ? raw.slice('group:'.length) : ''
  // `group:` with nothing after it names no group, so it is not a group scope.
  if (!groupKey) return { scope: 'all', queryClass }
  return { scope: 'group', groupKey, queryClass }
}

/**
 * Property pages intentionally do not support `all`: a Property is read in the
 * branded or non-brand lane, never as a pooled result. The default is written
 * explicitly so a copied Property URL always says which lane it shows.
 */
export function parseMeasurementPropertyViewSearch(search: { class?: string }): MeasurementPropertyViewState {
  return { queryClass: isPropertyQueryClass(search.class) ? search.class : 'non-brand' }
}

/**
 * Whether a change of plan identity (`"<project>:<revision>"`) should discard
 * the view the URL is carrying.
 *
 * A scope names a group inside one project's plan revision, so carrying it
 * across a different plan points it at nothing and the reset is right. Two
 * cases are NOT changes, and both were live bugs:
 *
 * - **No previous identity.** On first mount the URL's scope is exactly what
 *   the reader asked for. Resetting discards every shared or bookmarked link
 *   the instant it opens.
 * - **Identity not yet known.** The plan is fetched, so the revision reads as
 *   unknown for the first render or two and then appears. That appearance is
 *   the answer arriving, not the plan changing.
 */
export function shouldResetMeasurementView(previous: string | null, next: string | null): boolean {
  if (next === null || previous === null) return false
  return previous !== next
}

/**
 * Write view state back to the URL, omitting every default. Returns the two
 * keys only, for spreading over the rest of the existing search params.
 */
export function measurementViewSearch(view: MeasurementViewState): { scope?: string; class?: string } {
  return {
    scope: view.scope === 'group' && view.groupKey ? `group:${view.groupKey}` : undefined,
    class: view.queryClass === DEFAULT_MEASUREMENT_VIEW.queryClass ? undefined : view.queryClass,
  }
}

/** Property URLs always carry their class, including the non-brand default. */
export function measurementPropertyViewSearch(view: MeasurementPropertyViewState): { class: MeasurementPropertyQueryClass } {
  return { class: view.queryClass }
}
