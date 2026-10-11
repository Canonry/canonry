import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, CalendarClock, Check, ChevronRight, Clock, Pause, X } from 'lucide-react'
import { normalizeIdentityText } from '@ainyc/canonry-contracts'
import type {
  QueryTrackingPreviewResponse,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { useAccount } from '../../contexts/account-context.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { WriteButton } from '../shared/AccessControls.js'
import { useTooltipBubble } from '../shared/InfoTooltip.js'
import { StatusNote } from '../shared/StatusNote.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import type { TrackedSubjectTarget } from './queries/advanced/tracked-actions.js'
import { locationCountLabel, subjectLabel, trackedSubject, typeLabel as queryTypeLabel } from './queries/advanced/tracked-view-model.js'

type ChangeRow = QueryTrackingPreviewResponse['diff']['added'][number]
type Assignment = QueryTrackingTrackedRow['assignments'][number]
type Context = Assignment['contexts'][number]
type MarketChange = NonNullable<QueryTrackingPreviewResponse['marketChanges']>[number]
type QueryChange = NonNullable<QueryTrackingPreviewResponse['changes']>[number]
type Change = 'Added' | 'Reused' | 'Removed' | 'Unchanged'
/** The distinct search location and engines among some stored contexts, in the caller's words for them. */
type ContextLabels = (contexts: Assignment['contexts']) => string[]
/** One search location and its engines as a table shows it. `detail` is the caller's own label for it, model ids included. */
type SearchLocation = { label: string; detail: string }

/**
 * What a caller asked one query to be tracked for: one market or one location, and the locations
 * that Subject holds in the workspace the change was drafted in. Built by `expectedSubject`.
 */
export type ExpectedSubject = TrackedSubjectTarget & { queryText: string; locationKeys: readonly string[] }

/** The Subject a caller asked for, for the review to check against where the server would put the query. */
export function expectedSubject(queryText: string, subject: TrackedSubjectTarget, workspace: QueryTrackingWorkspaceResponse): ExpectedSubject {
  if (subject.kind === 'location') return { ...subject, queryText, locationKeys: [subject.key] }
  const market = workspace.markets.find(candidate => candidate.stableKey === subject.key)
  // The server's member list. An older server sends only the edges, whose distinct locations that list is.
  return { ...subject, queryText, locationKeys: market?.targetKeys ?? [...new Set(market?.usageEdges.map(edge => edge.targetKey))] }
}

/**
 * A tracking review as `useQueryTrackingPublish` holds it. A refused review or
 * publish leaves no `preview`; `error` then carries the server's message.
 */
export type TrackingReviewState = {
  preview: QueryTrackingPreviewResponse | null
  error: { title: string; detail: string } | null
  isCommitting: boolean
  /**
   * The Subject each query was asked to be tracked for. With these, and a server that sends
   * `changes`, the review checks each one against the Subject and the locations the server
   * would give it, shows the server's room under its query limit, and keeps Publish off
   * while one differs.
   */
  expectedSubjects?: readonly ExpectedSubject[]
  onPublish: () => void
  /** Reviews the same change again, against the refreshed workspace. */
  onReviewAgain: () => void
  /** Returns to the draft, where the caller keeps one behind the review. */
  onBack?: () => void
}

/** What the page knows about sweeps, for the actions under a review. */
type TrackingReviewSweeps = {
  sweepActive: boolean
  /** The next scheduled sweep as shown, month and day ("Oct 21"). None while a sweep is active or nothing is scheduled. */
  nextSweepDate?: string | null
}

/** The sentence behind "Type sets Subject": on the action sheet's form, and on a review row the server words as the other Subject of the two. */
export const TYPE_SETS_SUBJECT = 'In a market with one location, the type decides the Subject. Branded reads as a location query and Non-brand as a market query.'

const CHANGE_TONE = { Added: 'positive', Reused: 'neutral', Removed: 'caution', Unchanged: 'neutral' } as const
const CHANGE_NAME = { added: 'Added', reused: 'Reused', removed: 'Removed' } as const
/** One row of a review table: a query can be listed under more than one change. */
const changeKey = (change: Change, queryId: string) => `${change}:${queryId}`
const count = (value: number) => value.toLocaleString('en-US')
const queryCount = (value: number) => `${count(value)} ${value === 1 ? 'query' : 'queries'}`
/** A change in answers per sweep; none reads as a plain zero. */
const signed = (sign: '+' | '−', value: number) => value === 0 ? '0' : `${sign}${count(value)}`

/**
 * The rows a publish changes. A no-op lists the queries it matched, and changes none of them.
 * The server lists a reused query without saying whether this change alters it, so each one counts.
 */
function changeCount({ diff }: QueryTrackingPreviewResponse): number {
  return diff.noOp ? 0 : diff.added.length + diff.removed.length + diff.reused.length
}

/** The type one location asks a query under. */
function typeLabel(queryClass: Assignment['queryClass']): string {
  return queryTypeLabel(queryClass ?? 'not-set')
}

/** A query's Type as the Tracked table words it: one type by its name, two as Mixed, none as Not set. Each location's own type is in the row's location list. */
function rowTypeLabel(row: QueryTrackingTrackedRow): string {
  const classes = row.queryClasses ?? [...new Set(row.assignments.flatMap(assignment => assignment.queryClass ?? []))]
  return queryTypeLabel(classes.length === 0 ? 'not-set' : classes.length === 1 ? classes[0]! : 'mixed')
}

/**
 * The markets a publish takes locations from. A market holds only the locations its queries are
 * asked for, so a removal can take one out of it. The server lists every market whose locations
 * change; one that only gains a location needs no confirmation.
 */
function shrunkMarkets(preview: QueryTrackingPreviewResponse | null): MarketChange[] {
  return preview?.marketChanges?.filter(change => change.removedTargetKeys.length > 0) ?? []
}

/**
 * One checked change: what was asked, and whether the server's Subject and locations for the query are that.
 * `byType` when both hold and the server words the Subject as the other of the two a one-location market has.
 */
type SubjectVerdict = { expected: ExpectedSubject; subject: boolean; byType: boolean; locations: boolean }
type SubjectCheck = {
  /** Each change's locations before and after, as the server lists them, by `changeKey`. */
  placements: ReadonlyMap<string, QueryChange>
  /** By `changeKey`. A change nobody stated a Subject for has none. */
  verdicts: ReadonlyMap<string, SubjectVerdict>
  /** Queries that would get another Subject than the one asked for. One the server lists no change for counts. */
  subjectMisses: number
  /** Queries that would be asked for other locations than the Subject asked for holds. */
  locationMisses: number
  /** Queries that would not land where they were asked to, each counted once. */
  mismatched: number
}

/**
 * How the server's Subject for a query compares with the one asked for. A market of one location reads as
 * the market's query or as the location's by type alone, so there the other of the two is the Subject asked
 * for as well (`by-type`), as long as the query is asked for that one location and no other.
 */
function landing(focus: QueryTrackingTrackedRow['focus'], expected: ExpectedSubject, locations: boolean): 'same' | 'by-type' | 'other' {
  if (focus?.kind !== 'market' && focus?.kind !== 'property') return 'other'
  if ((focus.kind === 'market') === (expected.kind === 'market')) return focus.key === expected.key ? 'same' : 'other'
  return expected.locationKeys.length === 1 && locations ? 'by-type' : 'other'
}

/**
 * Checks each change against the Subject its caller asked for. The server says where a query would
 * be asked (`changes[].after`) and what Subject that makes it (the post-change row's `focus`). A
 * market is asked for the locations it held when the change was drafted: a query that lands on more,
 * or on fewer, is caught. Null with nothing to check: no Subject was stated, the server predates
 * `changes`, or the review changes nothing.
 */
function subjectCheck(preview: QueryTrackingPreviewResponse | null, expectedSubjects: readonly ExpectedSubject[] | undefined): SubjectCheck | null {
  if (!preview?.changes || preview.diff.noOp || !expectedSubjects?.length) return null
  const asked = new Map(expectedSubjects.map(expected => [normalizeIdentityText(expected.queryText), expected]))
  const tracked = new Map(preview.tracked.map(row => [row.queryId, row]))
  const placements = new Map<string, QueryChange>()
  const verdicts = new Map<string, SubjectVerdict>()
  const found = new Set<ExpectedSubject>()
  for (const change of preview.changes) {
    const key = changeKey(CHANGE_NAME[change.change], change.queryId)
    placements.set(key, change)
    const expected = asked.get(normalizeIdentityText(change.queryText))
    if (!expected) continue
    found.add(expected)
    const holds = new Set(expected.locationKeys)
    const after = change.after.targetKeys
    const locations = after.length === holds.size && after.every(locationKey => holds.has(locationKey))
    const landed = landing(tracked.get(change.queryId)?.focus, expected, locations)
    verdicts.set(key, { expected, locations, subject: landed !== 'other', byType: landed === 'by-type' })
  }
  const checked = [...verdicts.values()]
  // A query asked for and listed under no change cannot be checked, so it counts against the publish.
  const missing = asked.size - found.size
  return {
    placements,
    verdicts,
    subjectMisses: missing + checked.filter(verdict => !verdict.subject).length,
    locationMisses: checked.filter(verdict => !verdict.locations).length,
    mismatched: missing + checked.filter(verdict => !verdict.subject || !verdict.locations).length,
  }
}

/**
 * Reads the distinct search location and engines among some of one table's contexts. Each reads by
 * engine display name. Two that read alike that way (one engine on two models) keep the caller's
 * full label wherever they are in the table: in one cell, in two rows, or on two locations of a row.
 */
function searchLocationReader(all: readonly Context[], contextLabels: ContextLabels): (contexts: readonly Context[]) => SearchLocation[] {
  const details = new Map<Context, string[]>()
  const names = new Map<string, string>()
  for (const context of all) {
    const own = contextLabels([context])
    details.set(context, own)
    for (const detail of own) {
      if (!names.has(detail)) names.set(detail, `${context.location?.label ?? 'No search location'} · ${context.providers.map(providerDisplayName).join(', ')}`)
    }
  }
  const uses = new Map<string, number>()
  for (const name of names.values()) uses.set(name, (uses.get(name) ?? 0) + 1)
  return contexts => [...new Set(contexts.flatMap(context => details.get(context) ?? []))].map(detail => {
    const name = names.get(detail)!
    return { label: uses.get(name) === 1 ? name : detail, detail }
  })
}

/** A few names, then a count of the rest. Names hold commas of their own, so a dot parts them. */
function someNames(names: readonly string[], shown = 5): string {
  return names.length > shown ? `${names.slice(0, shown).join(' · ')} and ${count(names.length - shown)} more` : names.join(' · ')
}

/**
 * The review of a tracked-query change on an advanced project, before it is
 * published. Every number and row is the server's: `diff`, `workload`, `limits`,
 * `changes`, `marketChanges` and the post-change `tracked`. Simple projects keep `TrackingPreview`.
 */
export function TrackingReview({ workspace, contextLabels, showActions = true, ...review }: TrackingReviewState & TrackingReviewSweeps & {
  workspace: QueryTrackingWorkspaceResponse
  contextLabels: ContextLabels
  /** False when the caller draws `TrackingReviewActions` itself, outside the scrolling list. */
  showActions?: boolean
}) {
  const { preview, error } = review
  const headingRef = useRef<HTMLHeadingElement>(null)
  const refusalRef = useRef<HTMLParagraphElement>(null)
  // A refusal takes focus as a new review does: the button that had it is gone with the review.
  useEffect(() => {
    const outcome = headingRef.current ?? refusalRef.current
    if (!outcome) return
    if (typeof outcome.scrollIntoView === 'function') outcome.scrollIntoView({ block: 'start' })
    outcome.focus({ preventScroll: true })
  }, [preview, error])
  const actions = showActions ? <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
    <TrackingReviewActions {...review} />
  </div> : null

  if (!preview) {
    return (
      <>
        {error ? <p ref={refusalRef} tabIndex={-1} role="alert" className="text-sm leading-5 text-negative"><span className="font-medium">{error.title}.</span> {error.detail}</p> : null}
        {actions}
      </>
    )
  }

  const { diff, workload } = preview
  const changed = changeCount(preview)
  const tracked = new Map(preview.tracked.map(row => [row.queryId, row]))
  // The server counts the queries the plan asks, now and after. An older server sends no `limits`,
  // and the tracked rows stand in: a scoped removal lists a query that stays tracked elsewhere,
  // so only rows gone from the post-change `tracked` leave the count.
  const leaving = diff.removed.filter(row => !tracked.has(row.queryId)).length
  const queries = preview.limits?.queries ?? { current: tracked.size - diff.added.length + leaving, next: tracked.size }
  const rows = (change: Change, list: readonly ChangeRow[]) => list.map(row => ({ change, row }))
  const changes = [...rows('Added', diff.added), ...rows('Reused', diff.reused), ...rows('Removed', diff.removed)]
  const kinds = [[diff.added, 'added'], [diff.reused, 'reused'], [diff.removed, 'removed']] as const
  const shrunk = shrunkMarkets(preview)
  const table = { tracked, workspace, marketChanges: preview.marketChanges, contextLabels }
  const check = subjectCheck(preview, review.expectedSubjects)
  // The server's room under its query limit, now and after. It comes with the check: a review that states no Subject keeps its four numbers.
  const left = check ? preview.limits?.queries.left : undefined
  return (
    <>
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-strong">
        {diff.noOp ? 'No tracking changes' : changed > 0 ? `Review ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Review tracking changes'}
        {/* The heading takes focus, so a screen reader hears the block with it. */}
        {check && check.mismatched > 0 ? <span className="sr-only">, publish blocked</span> : null}
      </h3>
      {/* Five numbers pass the width of a sheet in one row, so they sit three to a row: the query counts, then the answers. */}
      <dl className={`mt-3 grid grid-cols-2 gap-x-6 gap-y-3 ${left ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
        <ReviewNumber label="Queries" value={`${count(queries.current)} → ${count(queries.next)}`} />
        {left ? <ReviewNumber label="Left under limit" value={`${count(left.current)} → ${count(left.next)}`} /> : null}
        {/* Of five, the widest takes a row of its own on a phone, which keeps the two answer changes side by side. */}
        <ReviewNumber label="Answers per sweep" className={left ? 'max-sm:col-span-2' : undefined} value={`${count(workload.existingProviderCalls)} → ${count(workload.nextSweepProviderCalls)}`} />
        {/* One provider call is one answer; added and removed answers stay separate. */}
        <ReviewNumber label="Answers added" value={signed('+', workload.addedProviderCalls)} />
        <ReviewNumber label="Answers removed" value={signed('−', workload.removedProviderCalls)} />
      </dl>
      {/* A publish writes a new revision with no continuity link. AI Visibility and location pages keep the last sweep, marked Tracking changed, until the next one. */}
      {diff.noOp ? null : <div className="mt-3">
        <StatusNote icon={Clock} tone="caution" label="New numbers next sweep" detail="After you publish, AI Visibility and location pages keep showing the last sweep, marked Tracking changed, until the next sweep. Past answers are kept. Publishing does not run a sweep." />
      </div>}
      {shrunk.length > 0 ? <MarketChanges changes={shrunk} workspace={workspace} /> : null}
      {changes.length > 0 ? <>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1">
          <p className="text-[13px] font-medium leading-5 text-secondary">{kinds.filter(([list]) => list.length > 0).map(([list, kind]) => `${count(list.length)} ${kind}`).join(' · ')}</p>
          {/* The two stay side by side where the line is too narrow to hold them beside the counts. */}
          {check ? (
            <div className="flex flex-wrap gap-x-5">
              <ReviewCheck label="One Subject each" missed={check.subjectMisses} miss="Subject" detail="would get a different Subject than the one you chose" />
              <ReviewCheck label="Locations match" missed={check.locationMisses} miss="location" detail="would be asked for other locations than your Subject holds" />
            </div>
          ) : null}
        </div>
        <ReviewTable label="Changes" rows={changes} {...table} check={check} />
      </> : null}
      {diff.unchanged.length > 0 ? <UnchangedQueries rows={rows('Unchanged', diff.unchanged)} {...table} /> : null}
      {actions}
    </>
  )
}

/**
 * Publish (Review again after a refusal), Back and the sweep pause: under the review, or pinned in the Add queries sheet's footer.
 * A publish that takes locations from a market waits for "Confirm market changes". One that would put a query
 * on another Subject, or on other locations, than its caller asked for stays off: Back is the way on.
 */
export function TrackingReviewActions({ preview, isCommitting, expectedSubjects, sweepActive, nextSweepDate, onPublish, onReviewAgain, onBack }: TrackingReviewState & TrackingReviewSweeps) {
  const { canWrite } = useAccount()
  const hasChanges = preview !== null && !preview.diff.noOp
  const changed = preview ? changeCount(preview) : 0
  const mismatched = subjectCheck(preview, expectedSubjects)?.mismatched ?? 0
  const blocked = mismatched > 0
  // A blocked publish has nothing to confirm yet.
  const guarded = hasChanges && !blocked && shrunkMarkets(preview).length > 0
  // The tick belongs to one review. Another review has another token, so it starts unticked.
  const token = preview?.previewToken ?? null
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null)
  const confirmed = token !== null && confirmedToken === token
  return (
    <>
      {/* On its own line, above Publish. A viewer cannot publish, so there is nothing to confirm. */}
      {guarded && canWrite ? (
        <label className="flex min-h-11 basis-full items-center gap-2 text-sm text-strong">
          <input
            type="checkbox"
            className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
            checked={confirmed}
            disabled={isCommitting}
            onChange={event => setConfirmedToken(event.target.checked ? token : null)}
          />
          Confirm market changes
        </label>
      ) : null}
      {preview ? (
        <WriteButton type="button" size="sm" disabled={!hasChanges || isCommitting || sweepActive || blocked || (guarded && !confirmed)} onClick={onPublish}>
          {isCommitting ? 'Publishing…' : changed > 0 ? `Publish ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Publish changes'}
        </WriteButton>
      ) : (
        <WriteButton type="button" size="sm" onClick={onReviewAgain}>Review again</WriteButton>
      )}
      {/* A publish in flight ends the review when it lands, so the draft stays out of reach until then. */}
      {onBack ? <Button type="button" variant="ghost" size="sm" disabled={isCommitting} onClick={onBack}>Back</Button> : null}
      {/* Only a publish that asks something new has first answers to wait for. */}
      {hasChanges && !sweepActive && !blocked && nextSweepDate && preview.workload.addedProviderCalls > 0 ? <StatusNote icon={CalendarClock} label={`First answers ${nextSweepDate}`} /> : null}
      {blocked ? (
        <span role="status" className="order-last">
          <StatusNote
            icon={Ban}
            tone="negative"
            label="Publish blocked"
            detail={`${queryCount(mismatched)} would not be tracked for the Subject you chose.${onBack ? ` Go back and remove ${mismatched === 1 ? 'it, or change its' : 'them, or change their'} Subject from the Tracked list.` : ''}`}
          />
        </span>
      ) : null}
      {/* Last in its row, so Back stays beside Publish. */}
      {hasChanges && sweepActive ? <span role="status" className="order-last"><StatusNote icon={Pause} tone="caution" label="Sweep running" detail="A sweep is queued or running. Publish after it finishes." /></span> : null}
    </>
  )
}

/** Each market the publish takes locations from: how many it holds now and after, and what it loses. Every number is the length of a list the server sent. */
function MarketChanges({ changes, workspace }: { changes: readonly MarketChange[]; workspace: QueryTrackingWorkspaceResponse }) {
  return (
    // Three short facts read as one line: in a wide card the table stops short of the full width, and on a phone its cells close up so it fits.
    <div className="mt-4 max-w-3xl overflow-x-auto">
      <table aria-label="Market changes" className="evidence-table table-auto max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
        <thead>
          <tr><th>Market</th><th>Locations</th><th>Change</th></tr>
        </thead>
        <tbody>
          {changes.map(change => {
            const lost = change.removedTargetKeys.length
            const names = someNames(change.removedTargetKeys.map(key => workspace.targets.find(target => target.stableKey === key)?.label ?? key))
            return (
              <tr key={change.marketKey}>
                <td className="break-words font-medium text-heading">{workspace.markets.find(market => market.stableKey === change.marketKey)?.label ?? change.marketKey}</td>
                <td className="whitespace-nowrap font-mono tabular-nums text-secondary">{count(change.before.targetKeys.length)} → {count(change.after.targetKeys.length)}</td>
                <td>
                  {change.emptied
                    ? <StatusNote icon={Ban} tone="negative" label="Market emptied" detail={`Leaves this market: ${names}. A market with no locations takes no new queries.`} />
                    // The count stays on the line of its noun (a no-break space) where the column is narrow.
                    : <StatusNote icon={AlertTriangle} tone="caution" label={`Loses ${count(lost)}\u00a0${lost === 1 ? 'location' : 'locations'}`} detail={`Leaves this market: ${names}. After you publish, this market's queries are no longer asked for ${lost === 1 ? 'it' : 'them'}.`} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One check over every change with a stated Subject. While it holds it is its name. When it does not, it is
 * the count of queries that miss it (`missed`, "2 Subject mismatches"), with what that means behind it.
 */
function ReviewCheck({ label, missed, miss, detail }: { label: string; missed: number; miss: string; detail: string }) {
  return missed === 0
    ? <StatusNote icon={Check} tone="positive" label={label} />
    : <StatusNote icon={X} tone="negative" label={`${count(missed)} ${miss} ${missed === 1 ? 'mismatch' : 'mismatches'}`} detail={`${queryCount(missed)} ${detail}.`} />
}

function ReviewNumber({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-sm text-secondary">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-heading">{value}</dd>
    </div>
  )
}

type ReviewTableProps = {
  rows: readonly { change: Change; row: ChangeRow }[]
  tracked: ReadonlyMap<string, QueryTrackingTrackedRow>
  workspace: QueryTrackingWorkspaceResponse
  marketChanges: QueryTrackingPreviewResponse['marketChanges']
  contextLabels: ContextLabels
  /** With it, each row shows its locations before and after, and a row that misses its stated Subject, or takes the other one by its type, says so. Only the table of changes takes one. */
  check?: SubjectCheck | null
}

/**
 * The queries a publish leaves alone, behind a disclosure. Their table is drawn once the disclosure
 * is opened: it is every other tracked query, about a thousand rows on a large project, and most reviews never open it.
 */
function UnchangedQueries(table: ReviewTableProps) {
  const [opened, setOpened] = useState(false)
  return (
    <details className="mt-4 border-t border-default pt-2 text-sm text-secondary" onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
      <summary className="min-h-11 cursor-pointer py-3">{count(table.rows.length)} unchanged {table.rows.length === 1 ? 'query' : 'queries'}</summary>
      {opened ? <ReviewTable label="Unchanged queries" {...table} /> : null}
    </details>
  )
}

function ReviewTable({ label, rows, tracked, workspace, marketChanges, contextLabels, check }: ReviewTableProps & { label: string }) {
  const listId = useId()
  // The rows whose locations are listed. Each list is a row of its own under the query, the table's full width.
  const [listed, setListed] = useState<ReadonlySet<string>>(new Set<string>())
  const toggle = (key: string) => setListed(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const { lines, searchLocations } = useMemo(() => {
    const current = new Map(workspace.tracked.map(row => [row.queryId, row]))
    // A market the publish changes holds the locations the server says it will, not the ones it has now.
    const after = new Map(marketChanges?.map(change => [change.marketKey, change.after.targetKeys]))
    const placesAfter = { targets: workspace.targets, markets: workspace.markets.map(market => after.has(market.stableKey) ? { ...market, targetKeys: after.get(market.stableKey) } : market) }
    // `tracked` is the post-change state: for a removed query it holds what survives, so that row lists no location and names no search location.
    const resolved = rows.map(({ change, row }) => change === 'Removed' ? undefined : tracked.get(row.queryId))
    const searchLocations = searchLocationReader(resolved.flatMap(asked => asked?.assignments.flatMap(assignment => assignment.contexts) ?? []), contextLabels)
    return {
      searchLocations,
      lines: rows.map(({ change, row }, index) => {
        const assignments = resolved[index]?.assignments ?? []
        // A removed query shows the Subject and Type it has now. A server that predates `focus` sends no Subject.
        const shown = change === 'Removed' ? current.get(row.queryId) : resolved[index]
        const search = searchLocations(assignments.flatMap(assignment => assignment.contexts))
        const key = changeKey(change, row.queryId)
        const placement = check?.placements.get(key)
        const verdict = check?.verdicts.get(key)
        const chosen = verdict ? chosenLabel(verdict.expected, workspace) : ''
        return {
          key,
          change,
          row,
          assignments,
          subject: shown?.focus ? subjectLabel(trackedSubject(shown, change === 'Removed' ? workspace : placesAfter)) : null,
          type: shown ? rowTypeLabel(shown) : '',
          search,
          searchKey: search.map(searchLocation => searchLocation.detail).sort().join('\n'),
          locations: new Set(assignments.map(assignment => assignment.targetKey)).size,
          placement,
          missed: verdict !== undefined && !(verdict.subject && verdict.locations),
          // What was chosen, then what the server would do instead. A Subject that holds can still be worded as the other of a one-location market's two.
          note: !verdict || !placement ? null
            : !verdict.subject ? { label: 'Subject mismatch', detail: `You chose ${chosen}. After you publish, its Subject would be ${landedLabel(tracked.get(row.queryId), placesAfter)}.` }
              : !verdict.locations ? { label: 'Locations differ', detail: `You chose ${chosen}. After you publish, this query would be asked for ${locationCountLabel(placement.after.targetKeys.length)}.` }
                : verdict.byType ? { label: 'Type sets Subject', detail: `You chose ${chosen}. ${TYPE_SETS_SUBJECT}` }
                  : null,
        }
      }),
    }
  }, [rows, tracked, workspace, marketChanges, contextLabels, check])
  // A row that misses its Subject leads the table, so it is in view however long the list is.
  const ordered = lines.some(line => line.missed) ? [...lines.filter(line => line.missed), ...lines.filter(line => !line.missed)] : lines
  const showSubject = lines.some(line => line.subject !== null)
  const showLocations = lines.some(line => line.placement)
  // One value for every row that names one is said once, above the table. A column is for rows that differ.
  const named = lines.filter(line => line.search.length > 0)
  const sharedSearch = named.length > 0 && named.every(line => line.searchKey === named[0]!.searchKey) ? named[0]!.search : null
  const showSearch = named.length > 0 && sharedSearch === null
  // Six columns pass the width of a sheet, so beside a search location or a Locations column the Type sits under its Subject.
  const stackType = showSubject && (showSearch || showLocations)
  // With both, a sixth column is still one too many: a query's location links sit under its locations, with their unit.
  const stackLinks = showSearch && showLocations
  return (
    <>
      {sharedSearch ? (
        <dl className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] leading-5">
          <dt className="shrink-0 text-secondary">Search location and engines</dt>
          <dd className="min-w-0 text-strong"><SearchLocations searchLocations={sharedSearch} list /></dd>
        </dl>
      ) : null}
      <div className="mt-2 overflow-x-auto">
        <table aria-label={label} className="evidence-table min-w-[640px] table-auto">
          <thead>
            <tr>
              <th>Change</th>
              <th>Query</th>
              {showSubject ? <th>{stackType ? 'Subject and type' : 'Subject'}</th> : null}
              {stackType ? null : <th>Type</th>}
              {showLocations ? <th>Locations</th> : null}
              {stackLinks ? null : <th>Location links</th>}
              {showSearch ? <th>Search location and engines</th> : null}
            </tr>
          </thead>
          <tbody>
            {ordered.map(({ key, change, row, assignments, subject, type, search, locations, placement, missed, note }) => {
              const open = listed.has(key)
              // The server's `assignmentCount`: one link per location and search location the query is asked for, so it can pass the number of locations. A removal counts what it takes away.
              const links = `${change === 'Removed' ? '−' : ''}${count(row.assignmentCount)}`
              // The lengths of the server's two location lists for the query: where it is asked now, and after the publish.
              const moved = placement ? `${count(placement.before.targetKeys.length)} → ${count(placement.after.targetKeys.length)}` : null
              const flag = note ? <StatusNote icon={missed ? X : AlertTriangle} tone={missed ? 'negative' : 'caution'} label={note.label} detail={note.detail} /> : null
              const locationList = locations > 0 ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? `${listId}-${key}` : undefined}
                  className="flex min-h-11 items-center gap-1 text-left text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500"
                  onClick={() => toggle(key)}
                >
                  <ChevronRight size={14} aria-hidden="true" className={open ? 'rotate-90' : ''} />
                  {count(locations)} {locations === 1 ? 'location' : 'locations'}
                </button>
              ) : null
              return (
                <Fragment key={key}>
                  <tr className={missed ? 'bg-negative-soft hover:bg-negative-soft' : undefined}>
                    <td className="whitespace-nowrap"><ToneBadge tone={CHANGE_TONE[change]}>{change}</ToneBadge></td>
                    <td className="min-w-44 break-words">
                      <span className="font-medium text-heading">{row.queryText}</span>
                      {/* A row's note sits with its query, the column a phone keeps in view, and leaves the Subject and its Type together. */}
                      {flag ? <span className="flex flex-wrap items-center gap-x-4">{locationList}{flag}</span> : locationList}
                    </td>
                    {showSubject ? (
                      <td className={`${stackLinks ? 'min-w-42' : showSearch ? 'min-w-32' : showLocations ? 'min-w-44' : 'min-w-40'} break-words text-secondary`}>
                        {stackType
                          ? <><span className="block">{subject ? <SubjectLabel label={subject} /> : null}</span><span className="block">{type}</span></>
                          : subject ? <SubjectLabel label={subject} /> : null}
                      </td>
                    ) : null}
                    {stackType ? null : <td className="whitespace-nowrap text-secondary">{type}</td>}
                    {showLocations ? (
                      <td className="whitespace-nowrap tabular-nums text-secondary">
                        <span className="block">{moved}</span>
                        {stackLinks ? <span className="block">{links} {row.assignmentCount === 1 ? 'link' : 'links'}</span> : null}
                      </td>
                    ) : null}
                    {stackLinks ? null : <td className="whitespace-nowrap tabular-nums text-secondary">{links}</td>}
                    {showSearch ? <td className={`${stackLinks ? 'min-w-34' : 'min-w-36'} text-secondary`}>{search.length > 0 ? <SearchLocations searchLocations={search} /> : null}</td> : null}
                  </tr>
                  {open ? (
                    <tr id={`${listId}-${key}`}>
                      <td colSpan={2 + Number(showSubject) + Number(!stackType) + Number(showLocations) + Number(!stackLinks) + Number(showSearch)} className="text-secondary">
                        {/* One search location and engines for the whole table is on the line above it, so no location repeats it. */}
                        <RowLocations assignments={assignments} workspace={workspace} searchLocations={sharedSearch?.length === 1 ? null : searchLocations} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** The Subject a caller asked for, as a row of the table would word it, with the locations a market held when it was chosen. */
function chosenLabel(expected: ExpectedSubject, workspace: QueryTrackingWorkspaceResponse): string {
  const label = (places: readonly { stableKey: string; label: string }[]) => places.find(place => place.stableKey === expected.key)?.label ?? expected.key
  return expected.kind === 'market'
    ? subjectLabel({ kind: 'market', key: expected.key, label: label(workspace.markets), locationCount: expected.locationKeys.length })
    : subjectLabel({ kind: 'location', key: expected.key, label: label(workspace.targets) })
}

/** The Subject the server would give a query once the change is published. One it would no longer ask has none. */
function landedLabel(row: QueryTrackingTrackedRow | undefined, places: Parameters<typeof trackedSubject>[1]): string {
  return subjectLabel(row?.focus ? trackedSubject(row, places) : { kind: 'none' })
}

/** A Subject as `subjectLabel` words it. A market's location count stays on the line of the word before it, and a hand-picked query's on the line of its noun. */
function SubjectLabel({ label }: { label: string }) {
  const counted = /(?:\S+ \(\d[\d,]*\)|\d[\d,]* locations?)$/.exec(label)
  return counted ? <>{label.slice(0, counted.index)}<span className="whitespace-nowrap">{counted[0]}</span></> : label
}

/** Where a query is asked: one search location and its engines, or how many combinations. `list` names each one. */
function SearchLocations({ searchLocations, list = false }: { searchLocations: readonly SearchLocation[]; list?: boolean }) {
  return (
    <SearchLocationText
      label={list || searchLocations.length === 1 ? searchLocations.map(searchLocation => searchLocation.label).join('; ') : `${count(searchLocations.length)} combinations`}
      detail={searchLocations.map(searchLocation => searchLocation.detail).join('; ')}
    />
  )
}

/**
 * A search location and its engines in short, by engine display name. The caller's own words for it
 * (`detail`, model ids included) are behind the value itself: it is the help button, with a dotted
 * underline, read as "{label}. {detail}", and a 44px row where a finger is the pointer. A value that
 * already is the caller's label has nothing to open, so it is plain text.
 */
export function SearchLocationText({ label, detail }: { label: string; detail: string }) {
  return label === detail ? label : <SearchLocationButton label={label} detail={detail} />
}

function SearchLocationButton({ label, detail }: { label: string; detail: string }) {
  // Opens downward: the review's heading scrolls to the top, which leaves no room above the first lines.
  const bubble = useTooltipBubble(detail, { placement: 'bottom', align: 'start' })
  return <>
    <button
      type="button"
      className="max-w-full cursor-help rounded-sm text-left underline decoration-current/40 decoration-dotted underline-offset-4 transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11"
      aria-label={`${label}. ${detail}`}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      {label}
    </button>
    {bubble.bubble}
  </>
}

/** Each location a query is asked for, with its type, groups and markets, and with `searchLocations` where it is asked, in the table's words. */
function RowLocations({ assignments, workspace, searchLocations }: { assignments: readonly Assignment[]; workspace: QueryTrackingWorkspaceResponse; searchLocations: ((contexts: readonly Context[]) => SearchLocation[]) | null }) {
  const named = (prefix: string, scopes: readonly { stableKey: string; label: string }[], keys: readonly string[]) =>
    keys.length > 0 ? `${prefix}: ${keys.map(key => scopes.find(scope => scope.stableKey === key)?.label ?? key).join('; ')}` : null
  return (
    <ul className="max-h-60 space-y-2 overflow-y-auto break-words text-sm leading-5">
      {assignments.map((assignment, index) => <li key={`${assignment.targetKey}:${index}`}>{[
        workspace.targets.find(target => target.stableKey === assignment.targetKey)?.label ?? assignment.targetKey,
        typeLabel(assignment.queryClass),
        named('Groups', workspace.groups, assignment.groupKeys),
        named('Markets', workspace.markets, assignment.marketKeys),
        searchLocations ? searchLocations(assignment.contexts).map(searchLocation => searchLocation.label).join('; ') : null,
      ].filter(Boolean).join(' · ')}</li>)}
    </ul>
  )
}
