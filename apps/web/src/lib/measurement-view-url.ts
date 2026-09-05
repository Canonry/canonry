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

/**
 * All queries, not non-brand. Branded and non-brand answer different questions
 * and are never pooled into one rate, but an operator arriving at the page has
 * not yet said which one he is asking — and defaulting to non-brand silently
 * hid half the basket behind a control he had no reason to touch.
 */
export const DEFAULT_MEASUREMENT_VIEW: MeasurementViewState = { scope: 'all', queryClass: 'all' }

const QUERY_CLASSES: readonly MeasurementQueryClass[] = ['all', 'non-brand', 'branded']

function isQueryClass(value: unknown): value is MeasurementQueryClass {
  return typeof value === 'string' && (QUERY_CLASSES as readonly string[]).includes(value)
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

/** One URL selection for measured results and query administration. */
export interface VisibilitySelectionState {
  measurementScope: 'project' | 'group' | 'market' | 'property'
  measurementScopeKey?: string
  queryClass: MeasurementQueryClass | 'unknown'
  provider?: string
  model?: string
  location?: string
  from?: string
  to?: string
  revision?: number
  measurementRunId?: string
  queryKey?: string
}

export function parseVisibilitySelection(search: Record<string, unknown>): VisibilitySelectionState {
  const string = (key: string): string | undefined => typeof search[key] === 'string' && search[key] !== '' ? search[key] : undefined
  const legacy = parseMeasurementViewSearch({ scope: string('scope'), class: string('class') })
  const scope = string('measurementScope') ?? (legacy.scope === 'group' ? 'group' : 'project')
  const key = string('measurementScopeKey') ?? (string('measurementScope') ? undefined : legacy.groupKey)
  const queryClass = string('queryClass') ?? string('class')
  const result: VisibilitySelectionState = {
    measurementScope: key && (scope === 'group' || scope === 'market' || scope === 'property') ? scope : 'project',
    queryClass: queryClass === 'all' || queryClass === 'branded' || queryClass === 'unknown' ? queryClass : 'non-brand',
  }
  if (result.measurementScope !== 'project') result.measurementScopeKey = key
  for (const [urlKey, field] of [
    ['measurementProvider', 'provider'], ['measurementModel', 'model'], ['measurementLocation', 'location'],
    ['measurementFrom', 'from'], ['measurementTo', 'to'], ['measurementRunId', 'measurementRunId'], ['measurementQueryKey', 'queryKey'],
  ] as const) {
    const value = string(urlKey)
    if (value !== undefined) result[field] = value
  }
  const revision = Number(search.measurementRevision)
  if (Number.isSafeInteger(revision) && revision > 0) result.revision = revision
  return result
}

export function patchVisibilitySelection(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...previous, ...patch }
  // Legacy scope tokens must not reappear when the user returns to the project.
  if ('measurementScope' in patch) {
    next.scope = undefined
    next.measurementQueryKey = undefined
    if (patch.measurementScope === 'project') next.measurementScopeKey = undefined
  }
  if ('queryClass' in patch) next.class = undefined
  return next
}
