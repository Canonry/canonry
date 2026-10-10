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
type Market = QueryTrackingWorkspaceResponse['markets'][number]
type Pairing = TrackedRowVm['tracked']['assignments'][number]

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

/** A place holds a pairing when the pairing is asked for it. */
function holds(place: TrackedPlace, pairing: Pairing): boolean {
  if (place.kind === 'location') return pairing.targetKey === place.key
  if (place.kind === 'group') return pairing.groupKeys.includes(place.key)
  // A market holds one pairing per search location, and the row lists a location's markets together.
  // Asked from more than one, it may be in the market for only some of them.
  return pairing.contexts.length === 1 && pairing.marketKeys.length === 1 && pairing.marketKeys[0] === place.key
}

/**
 * True when some row is asked outside the place, so a change narrowed to the
 * place and the same change everywhere differ. False when every pairing of
 * every row sits in the place and nowhere else: both are then one request.
 */
export function reachesBeyond(rows: readonly TrackedRowVm[], place: TrackedPlace): boolean {
  return rows.some(row => row.tracked.assignments.some(pairing => !holds(place, pairing)))
}

/** Which markets hold each location and which locations each market holds. Read once per workspace, because every row's guards ask. */
const MEMBERSHIP = new WeakMap<QueryTrackingWorkspaceResponse, { holders: Map<string, Market[]>; members: Map<string, Set<string>> }>()

function membership(workspace: QueryTrackingWorkspaceResponse) {
  let index = MEMBERSHIP.get(workspace)
  if (!index) {
    index = { holders: new Map(), members: new Map() }
    for (const market of workspace.markets) {
      const locations = new Set(market.usageEdges.map(edge => edge.targetKey))
      index.members.set(market.stableKey, locations)
      for (const location of locations) index.holders.set(location, [...(index.holders.get(location) ?? []), market])
    }
    MEMBERSHIP.set(workspace, index)
  }
  return index
}

/** The markets a location's queries count in: those holding a usage edge for it. */
export function marketsHolding(workspace: QueryTrackingWorkspaceResponse, locationKey: string): Market[] {
  return membership(workspace).holders.get(locationKey) ?? []
}

/**
 * True for a market of one location that sits in no other market. A query
 * there has the same pairings whether it is the market's or the location's,
 * so the server reads its Subject from its type alone: Branded is the
 * location, anything else the market.
 */
export function typeSetsSubject(target: TrackedSubjectTarget, workspace: QueryTrackingWorkspaceResponse): boolean {
  const { holders, members } = membership(workspace)
  const home = target.kind === 'location' ? holders.get(target.key) ?? [] : null
  if (home && home.length !== 1) return false
  const locations = members.get(home ? home[0]!.stableKey : target.key)
  if (locations?.size !== 1) return false
  const [location] = locations
  return holders.get(location!)?.length === 1
}

/** True for a market or location row whose type alone decides which of the two it is. */
export function rowTypeSetsSubject(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse): boolean {
  const { subject } = row
  return (subject.kind === 'market' || subject.kind === 'location') && typeSetsSubject(subject, workspace)
}

/** False where a Subject change could change nothing: the type decides there, and a row that is not asked has no Subject. */
export function canChangeSubject(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse): boolean {
  const { subject } = row
  if (subject.kind === 'hand-picked') return true
  if (subject.kind !== 'market' && subject.kind !== 'location') return false
  return !typeSetsSubject(subject, workspace)
}

/** The type a market or a location query is set to. */
const OWN_TYPE = { market: 'non-brand', location: 'branded' } as const

/**
 * The types a row can be set to. A market query is set to Non-brand and a
 * location query to Branded, so a type never moves a query into the other
 * population by accident. A hand-picked query takes either. So does one row
 * where the type sets the Subject, because there the type is the only way to
 * move it; among several rows (`bulk`) it takes only its own, so a bulk change
 * moves no query to the other Subject. A query that is not asked has no
 * pairing to give a type, and the server refuses one, so it takes none.
 */
export function allowedTypes(row: TrackedRowVm, workspace: QueryTrackingWorkspaceResponse, bulk = false): TrackedTypeChoice[] {
  const { subject } = row
  if (subject.kind === 'none') return []
  if (subject.kind === 'hand-picked' || subject.kind === 'company' || (!bulk && typeSetsSubject(subject, workspace))) return ['auto', 'branded', 'non-brand']
  return ['auto', OWN_TYPE[subject.kind]]
}

/** A type change skips the rows that cannot take the chosen type. More than one row is a bulk change. */
export function typeChangeRows(rows: readonly TrackedRowVm[], type: TrackedTypeChoice, workspace: QueryTrackingWorkspaceResponse) {
  const changed: TrackedRowVm[] = []
  const skipped: TrackedRowVm[] = []
  for (const row of rows) (allowedTypes(row, workspace, rows.length > 1).includes(type) ? changed : skipped).push(row)
  return { changed, skipped }
}

/**
 * The one type an operator set on every pairing of the row, or null when the
 * server chose any of them. The row carries one type and one source per
 * location, read from that location's first search location, so a location
 * asked from several reads as operator-set when only the first one is.
 */
export function operatorType(row: TrackedRowVm): QueryClass | null {
  const { assignments } = row.tracked
  const type = assignments.at(0)?.queryClass
  if (!type) return null
  // `assignments` holds one type per location; `queryClasses` is every type the query is asked under.
  if (row.queryClasses.some(queryClass => queryClass !== type)) return null
  return assignments.every(assignment => assignment.classificationSource === 'operator' && assignment.queryClass === type) ? type : null
}

/**
 * False when the row plainly has the type already, so sending it would change
 * nothing. Automatic changes a type an operator set and one with no recorded
 * source: the server classifies both again. Where a location is asked from
 * more than one search location the row cannot tell (see `operatorType`), so
 * the answer is yes and the server's review says whether anything changes.
 */
export function typeWouldChange(row: TrackedRowVm, type: TrackedTypeChoice): boolean {
  const { assignments } = row.tracked
  if (assignments.some(pairing => pairing.contexts.length > 1)) return true
  if (type === 'auto') return assignments.some(pairing => pairing.classificationSource !== 'server')
  return operatorType(row) !== type
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
