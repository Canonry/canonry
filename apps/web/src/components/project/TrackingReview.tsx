import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, CalendarClock, ChevronRight, Clock, Pause } from 'lucide-react'
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
import { subjectLabel, trackedSubject, typeLabel as queryTypeLabel } from './queries/advanced/tracked-view-model.js'

type ChangeRow = QueryTrackingPreviewResponse['diff']['added'][number]
type Assignment = QueryTrackingTrackedRow['assignments'][number]
type Context = Assignment['contexts'][number]
type MarketChange = NonNullable<QueryTrackingPreviewResponse['marketChanges']>[number]
type Change = 'Added' | 'Reused' | 'Removed' | 'Unchanged'
/** The distinct search location and engines among some stored contexts, in the caller's words for them. */
type ContextLabels = (contexts: Assignment['contexts']) => string[]
/** One search location and its engines as a table shows it. `detail` is the caller's own label for it, model ids included. */
type SearchLocation = { label: string; detail: string }

/**
 * A tracking review as `useQueryTrackingPublish` holds it. A refused review or
 * publish leaves no `preview`; `error` then carries the server's message.
 */
export type TrackingReviewState = {
  preview: QueryTrackingPreviewResponse | null
  error: { title: string; detail: string } | null
  isCommitting: boolean
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

const CHANGE_TONE = { Added: 'positive', Reused: 'neutral', Removed: 'caution', Unchanged: 'neutral' } as const
const count = (value: number) => value.toLocaleString('en-US')
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

/** A few names, then a count of the rest. */
function someNames(names: readonly string[], shown = 5): string {
  return names.length > shown ? `${names.slice(0, shown).join(', ')} and ${count(names.length - shown)} more` : names.join(', ')
}

/**
 * The review of a tracked-query change on an advanced project, before it is
 * published. Every number and row is the server's: `diff`, `workload`, `limits`,
 * `marketChanges` and the post-change `tracked`. Simple projects keep `TrackingPreview`.
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
  return (
    <>
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-strong">
        {diff.noOp ? 'No tracking changes' : changed > 0 ? `Review ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Review tracking changes'}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <ReviewNumber label="Queries" value={`${count(queries.current)} → ${count(queries.next)}`} />
        <ReviewNumber label="Answers per sweep" value={`${count(workload.existingProviderCalls)} → ${count(workload.nextSweepProviderCalls)}`} />
        {/* One provider call is one answer; added and removed answers stay separate. */}
        <ReviewNumber label="Answers added" value={signed('+', workload.addedProviderCalls)} />
        <ReviewNumber label="Answers removed" value={signed('−', workload.removedProviderCalls)} />
      </dl>
      {/* A publish writes a new revision with no continuity link, so location and competitor reads blank while AI Visibility falls back. */}
      {diff.noOp ? null : <div className="mt-3">
        <StatusNote icon={Clock} tone="caution" label="New numbers next sweep" detail="After you publish, location pages and competitor results show no numbers until the next sweep. AI Visibility keeps showing the last sweep. Past answers are kept. Publishing does not run a sweep." />
      </div>}
      {shrunk.length > 0 ? <MarketChanges changes={shrunk} workspace={workspace} /> : null}
      {changes.length > 0 ? <>
        <p className="mt-4 text-[13px] font-medium leading-5 text-secondary">{kinds.filter(([list]) => list.length > 0).map(([list, kind]) => `${count(list.length)} ${kind}`).join(' · ')}</p>
        <ReviewTable label="Changes" rows={changes} {...table} />
      </> : null}
      {diff.unchanged.length > 0 ? <UnchangedQueries rows={rows('Unchanged', diff.unchanged)} {...table} /> : null}
      {actions}
    </>
  )
}

/**
 * Publish (Review again after a refusal), Back and the sweep pause: under the review, or pinned in the Add queries sheet's footer.
 * A publish that takes locations from a market waits for "Confirm market changes".
 */
export function TrackingReviewActions({ preview, isCommitting, sweepActive, nextSweepDate, onPublish, onReviewAgain, onBack }: TrackingReviewState & TrackingReviewSweeps) {
  const { canWrite } = useAccount()
  const hasChanges = preview !== null && !preview.diff.noOp
  const changed = preview ? changeCount(preview) : 0
  const guarded = hasChanges && shrunkMarkets(preview).length > 0
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
        <WriteButton type="button" size="sm" disabled={!hasChanges || isCommitting || sweepActive || (guarded && !confirmed)} onClick={onPublish}>
          {isCommitting ? 'Publishing…' : changed > 0 ? `Publish ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Publish changes'}
        </WriteButton>
      ) : (
        <WriteButton type="button" size="sm" onClick={onReviewAgain}>Review again</WriteButton>
      )}
      {/* A publish in flight ends the review when it lands, so the draft stays out of reach until then. */}
      {onBack ? <Button type="button" variant="ghost" size="sm" disabled={isCommitting} onClick={onBack}>Back</Button> : null}
      {/* Only a publish that asks something new has first answers to wait for. */}
      {hasChanges && !sweepActive && nextSweepDate && preview.workload.addedProviderCalls > 0 ? <StatusNote icon={CalendarClock} label={`First answers ${nextSweepDate}`} /> : null}
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

function ReviewNumber({ label, value }: { label: string; value: string }) {
  return (
    <div>
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

function ReviewTable({ label, rows, tracked, workspace, marketChanges, contextLabels }: ReviewTableProps & { label: string }) {
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
        return {
          key: `${change}:${row.queryId}`,
          change,
          row,
          assignments,
          subject: shown?.focus ? subjectLabel(trackedSubject(shown, change === 'Removed' ? workspace : placesAfter)) : null,
          type: shown ? rowTypeLabel(shown) : '',
          search,
          searchKey: search.map(searchLocation => searchLocation.detail).sort().join('\n'),
          locations: new Set(assignments.map(assignment => assignment.targetKey)).size,
        }
      }),
    }
  }, [rows, tracked, workspace, marketChanges, contextLabels])
  const showSubject = lines.some(line => line.subject !== null)
  // One value for every row that names one is said once, above the table. A column is for rows that differ.
  const named = lines.filter(line => line.search.length > 0)
  const sharedSearch = named.length > 0 && named.every(line => line.searchKey === named[0]!.searchKey) ? named[0]!.search : null
  const showSearch = named.length > 0 && sharedSearch === null
  // Six columns pass the width of a sheet, so beside a search location column the Type sits under its Subject.
  const stackType = showSubject && showSearch
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
              <th>Location links</th>
              {showSearch ? <th>Search location and engines</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map(({ key, change, row, assignments, subject, type, search, locations }) => {
              const open = listed.has(key)
              return (
                <Fragment key={key}>
                  <tr>
                    <td className="whitespace-nowrap"><ToneBadge tone={CHANGE_TONE[change]}>{change}</ToneBadge></td>
                    <td className="min-w-44 break-words">
                      <span className="font-medium text-heading">{row.queryText}</span>
                      {locations > 0 ? (
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
                      ) : null}
                    </td>
                    {showSubject ? (
                      <td className={`${stackType ? 'min-w-32' : 'min-w-40'} break-words text-secondary`}>
                        {stackType
                          ? <><span className="block">{subject ? <SubjectLabel label={subject} /> : null}</span><span className="block">{type}</span></>
                          : subject ? <SubjectLabel label={subject} /> : null}
                      </td>
                    ) : null}
                    {stackType ? null : <td className="whitespace-nowrap text-secondary">{type}</td>}
                    {/* The server's `assignmentCount`: one link per location and search location the query is asked for, so it can pass the number of locations. A removal counts what it takes away. */}
                    <td className="whitespace-nowrap tabular-nums text-secondary">{change === 'Removed' ? '−' : ''}{count(row.assignmentCount)}</td>
                    {showSearch ? <td className="min-w-36 text-secondary">{search.length > 0 ? <SearchLocations searchLocations={search} /> : null}</td> : null}
                  </tr>
                  {open ? (
                    <tr id={`${listId}-${key}`}>
                      <td colSpan={3 + Number(showSubject) + Number(!stackType) + Number(showSearch)} className="text-secondary">
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

/** A Subject as `subjectLabel` words it. A market's location count stays on the line of the word before it. */
function SubjectLabel({ label }: { label: string }) {
  const counted = /\S+ \(\d[\d,]*\)$/.exec(label)
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
    keys.length > 0 ? `${prefix}: ${keys.map(key => scopes.find(scope => scope.stableKey === key)?.label ?? key).join(', ')}` : null
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
