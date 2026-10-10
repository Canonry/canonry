import type {
  QueryClass,
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import type { TrackedRowAction, TrackedRowVm } from './tracked-types.js'

/**
 * What the Tracked row menu and bulk bar send. Each builder returns the exact
 * request the shared review previews and publishes, so these are what changes
 * the measurement. The guards say which actions a row can take.
 */

/** One publish holds at most this many rows, so a bulk change stays reviewable. */
export const TRACKED_BULK_MAX = 50

/** The place the page is filtered to. The wire calls a location a property. */
export type TrackedPlace = { kind: 'market' | 'group' | 'location'; key: string; label: string }

/** Automatic hands the type back to the server's classifier. */
export type TrackedTypeChoice = 'auto' | QueryClass

/** The one market or one location a query is about after a Subject change. */
export type TrackedSubjectTarget = { kind: 'market' | 'location'; key: string }

type Addition = QueryTrackingMutation['additions'][number]

export const TRACKED_ACTION_LABEL: Record<TrackedRowAction, string> = {
  'edit-wording': 'Edit wording',
  'change-subject': 'Change Subject',
  'move-location': 'Move to another location',
  'change-type': 'Change type',
  stop: 'Stop tracking',
  track: 'Track',
  remove: 'Remove query',
  'copy-link': 'Copy link',
}

/** Narrows a change to the pairings inside the place. Left out, the change covers every pairing of the query. */
function scoped(place?: TrackedPlace): Pick<QueryTrackingMutation['removals'][number], 'audience'> {
  if (!place) return {}
  if (place.kind === 'location') return { audience: { targetKeys: [place.key] } }
  if (place.kind === 'group') return { audience: { groupKeys: [place.key] } }
  return { audience: { marketKeys: [place.key] } }
}

/** The markets a location's queries count in: those holding a usage edge for it. */
export function marketsHolding(workspace: QueryTrackingWorkspaceResponse, locationKey: string) {
  return workspace.markets.filter(market => market.usageEdges.some(edge => edge.targetKey === locationKey))
}

/**
 * True for a market of one location that sits in no other market. A query
 * there has the same pairings whether it is the market's or the location's,
 * so the server reads its Subject from its type alone: Branded is the
 * location, anything else the market.
 */
export function typeSetsSubject(target: TrackedSubjectTarget, workspace: QueryTrackingWorkspaceResponse): boolean {
  const markets = target.kind === 'market'
    ? workspace.markets.filter(market => market.stableKey === target.key)
    : marketsHolding(workspace, target.key)
  if (markets.length !== 1) return false
  const locations = new Set(markets[0]!.usageEdges.map(edge => edge.targetKey))
  if (locations.size !== 1) return false
  const [location] = locations
  return marketsHolding(workspace, location!).length === 1
}

/** False where a Subject change could change nothing: the type decides there, and a row that is not asked has no Subject. */
export function canChangeSubject(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse): boolean {
  const { subject } = row
  if (subject.kind === 'hand-picked') return true
  if (subject.kind !== 'market' && subject.kind !== 'location') return false
  return !typeSetsSubject(subject, workspace)
}

/**
 * The types a row can be set to. A market query is Non-brand and a location
 * query Branded, so each is offered only its own, and a type never moves a
 * query into the other population by accident. A hand-picked query takes
 * either, and so does a query where the type sets the Subject.
 */
export function allowedTypes(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse): TrackedTypeChoice[] {
  const { subject } = row
  if (subject.kind === 'none') return ['auto']
  const either = subject.kind === 'hand-picked' || subject.kind === 'company' || typeSetsSubject(subject, workspace)
  return [
    'auto',
    ...(either || subject.kind === 'location' ? ['branded' as const] : []),
    ...(either || subject.kind === 'market' ? ['non-brand' as const] : []),
  ]
}

/** A bulk type change skips the rows that cannot take the chosen type. */
export function typeChangeRows(rows: readonly TrackedRowVm[], type: TrackedTypeChoice, workspace: QueryTrackingWorkspaceResponse) {
  const changed: TrackedRowVm[] = []
  const skipped: TrackedRowVm[] = []
  for (const row of rows) (allowedTypes(row, workspace).includes(type) ? changed : skipped).push(row)
  return { changed, skipped }
}

/** The one type an operator set on every pairing of the row, or null when the server chose any of them. */
export function operatorType(row: TrackedRowVm): QueryClass | null {
  const { assignments } = row.tracked
  const type = assignments.at(0)?.queryClass
  if (!type) return null
  // `assignments` holds one type per location; `queryClasses` is every type the query is asked under.
  if (row.queryClasses.some(queryClass => queryClass !== type)) return null
  return assignments.every(assignment => assignment.classificationSource === 'operator' && assignment.queryClass === type) ? type : null
}

/** A Subject change to the Subject the row already has changes nothing. */
export function sameSubject(row: TrackedRowVm, target: TrackedSubjectTarget): boolean {
  const { subject } = row
  return (subject.kind === 'market' || subject.kind === 'location') && subject.kind === target.kind && subject.key === target.key
}

/** The menu of one row, in order. A viewer can only copy the row's link. */
export function rowMenuActions(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse, canWrite: boolean): TrackedRowAction[] {
  if (!canWrite) return ['copy-link']
  if (row.subject.kind === 'none') return ['track', 'remove', 'copy-link']
  return [
    'edit-wording',
    ...(canChangeSubject(row, workspace) ? ['change-subject' as const] : []),
    ...(row.subject.kind === 'location' ? ['move-location' as const] : []),
    'change-type',
    'stop',
    'copy-link',
  ]
}

/** One removal per row. With a place, only the pairings inside it go. */
export function stopTracking(rows: readonly TrackedRowVm[], place?: TrackedPlace): QueryTrackingMutation {
  return { additions: [], removals: rows.map(row => ({ queryId: row.queryId, ...scoped(place) })) }
}

/** New wording is a new query to the server: a new id, a new trend line and a Manual source. */
export function editWording(row: TrackedRowVm, text: string, place?: TrackedPlace): QueryTrackingMutation {
  return { additions: [], removals: [], edits: [{ queryId: row.queryId, text: text.trim(), ...scoped(place) }] }
}

/** One edit per row. Automatic sends null, which asks the server to classify again. */
export function changeType(rows: readonly TrackedRowVm[], type: TrackedTypeChoice, place?: TrackedPlace): QueryTrackingMutation {
  const queryClass = type === 'auto' ? null : type
  return { additions: [], removals: [], edits: rows.map(row => ({ queryId: row.queryId, queryClass, ...scoped(place) })) }
}

/**
 * What an addition for the Subject names. A market names itself alone and
 * takes its own search locations and engines. A location names itself and
 * every market that holds it, so the query counts in those markets, as the
 * Add queries sheet does. A location in no market has none to take them from:
 * it names one `context`, and this is null until there is one.
 */
export function subjectPlacement(
  target: TrackedSubjectTarget,
  workspace: QueryTrackingWorkspaceResponse,
  context?: QueryTrackingContextInput,
): Pick<Addition, 'audience' | 'contexts'> | null {
  if (target.kind === 'market') return { audience: { marketKeys: [target.key] } }
  const marketKeys = marketsHolding(workspace, target.key).map(market => market.stableKey)
  if (marketKeys.length > 0) return { audience: { targetKeys: [target.key], marketKeys } }
  return context ? { audience: { targetKeys: [target.key] }, contexts: [context] } : null
}

/**
 * A Subject change is one removal of the whole query and one addition of its
 * own text for the new Subject, in one publish. The server matches the text,
 * so the query keeps its id and Source. A type an operator set is sent again;
 * any other is left out and the server classifies for the new Subject. Null
 * while the new Subject's placement is not complete.
 */
export function changeSubject(
  row: TrackedRowVm,
  target: TrackedSubjectTarget,
  workspace: QueryTrackingWorkspaceResponse,
  context?: QueryTrackingContextInput,
): QueryTrackingMutation | null {
  const placement = subjectPlacement(target, workspace, context)
  if (!placement) return null
  const queryClass = operatorType(row)
  return {
    additions: [{ input: { source: 'manual', text: row.queryText }, ...placement, ...(queryClass ? { queryClass } : {}) }],
    removals: [{ queryId: row.queryId }],
  }
}

/** A move is a Subject change to another location. */
export function moveLocation(
  row: TrackedRowVm,
  locationKey: string,
  workspace: QueryTrackingWorkspaceResponse,
  context?: QueryTrackingContextInput,
): QueryTrackingMutation | null {
  return changeSubject(row, { kind: 'location', key: locationKey }, workspace, context)
}
