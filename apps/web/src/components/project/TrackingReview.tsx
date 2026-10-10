import { useEffect, useRef } from 'react'
import type {
  QueryTrackingPreviewResponse,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { WriteButton } from '../shared/AccessControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'

type ChangeRow = QueryTrackingPreviewResponse['diff']['added'][number]
type Assignment = QueryTrackingTrackedRow['assignments'][number]
type Change = 'Added' | 'Reused' | 'Removed' | 'Unchanged'
/** The distinct search location and engines among some stored contexts, in the caller's words for them. */
type ContextLabels = (contexts: Assignment['contexts']) => string[]

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

const CHANGE_TONE = { Added: 'positive', Reused: 'neutral', Removed: 'caution', Unchanged: 'neutral' } as const
const count = (value: number) => value.toLocaleString('en-US')

/** The rows a publish changes. A no-op lists the queries it matched, and changes none of them. */
function changeCount({ diff }: QueryTrackingPreviewResponse): number {
  return diff.noOp ? 0 : diff.added.length + diff.removed.length + diff.reused.length
}

function typeLabel(queryClass: Assignment['queryClass']): string {
  return queryClass === 'branded' ? 'Branded' : queryClass === 'non-brand' ? 'Non-brand' : 'Unknown'
}

/**
 * The review of a tracked-query change on an advanced project, before it is
 * published. Every number and row is the server's: `diff`, `workload` and the
 * post-change `tracked`. Simple projects keep `TrackingPreview`.
 */
export function TrackingReview({ workspace, contextLabels, showActions = true, ...review }: TrackingReviewState & {
  workspace: QueryTrackingWorkspaceResponse
  sweepActive: boolean
  contextLabels: ContextLabels
  /** False when the caller draws `TrackingReviewActions` itself, outside the scrolling list. */
  showActions?: boolean
}) {
  const { preview, error } = review
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const heading = headingRef.current
    if (!heading) return
    if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [preview])
  const actions = showActions ? <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
    <TrackingReviewActions {...review} />
  </div> : null

  if (!preview) {
    return (
      <>
        {error ? <p role="alert" className="text-sm leading-5 text-negative"><span className="font-medium">{error.title}.</span> {error.detail}</p> : null}
        {actions}
      </>
    )
  }

  const { diff, workload } = preview
  const changed = changeCount(preview)
  const tracked = new Map(preview.tracked.map(row => [row.queryId, row]))
  // A scoped removal lists a query that stays tracked elsewhere; only rows gone
  // from the post-change `tracked` leave the count.
  const leaving = diff.removed.filter(row => !tracked.has(row.queryId)).length
  const queriesBefore = tracked.size - diff.added.length + leaving
  const rows = (change: Change, list: readonly ChangeRow[]) => list.map(row => ({ change, row }))
  const changes = [...rows('Added', diff.added), ...rows('Reused', diff.reused), ...rows('Removed', diff.removed)]
  const kinds = [[diff.added, 'added'], [diff.reused, 'reused'], [diff.removed, 'removed']] as const
  const table = { tracked, workspace, contextLabels }
  return (
    <>
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-strong">
        {diff.noOp ? 'No tracking changes' : changed > 0 ? `Review ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Review tracking changes'}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <ReviewNumber label="Queries" value={`${count(queriesBefore)} → ${count(tracked.size)}`} />
        <ReviewNumber label="Answers per sweep" value={`${count(workload.existingProviderCalls)} → ${count(workload.nextSweepProviderCalls)}`} />
        {/* One provider call is one answer; added and removed answers stay separate. */}
        <ReviewNumber label="Answers added" value={`+${count(workload.addedProviderCalls)}`} />
        <ReviewNumber label="Answers removed" value={`−${count(workload.removedProviderCalls)}`} />
      </dl>
      {/* A publish writes a new revision with no continuity link, so location and competitor reads blank while AI Visibility falls back. */}
      <p className="mt-3 text-sm leading-6 text-secondary">{diff.noOp
        ? 'This request leaves tracking unchanged.'
        : 'After you publish, AI Visibility keeps showing the last sweep until the next sweep. Location pages and competitor results show no numbers until then. Past answers are kept.'}</p>
      {diff.noOp ? null : <p className="text-sm leading-6 text-secondary">Publishing does not run a sweep.</p>}
      {changes.length > 0 ? <>
        <p className="mt-4 text-[13px] font-medium leading-5 text-secondary">{kinds.filter(([list]) => list.length > 0).map(([list, kind]) => `${count(list.length)} ${kind}`).join(' · ')}</p>
        <ReviewTable label="Changes" rows={changes} {...table} />
      </> : null}
      {diff.unchanged.length > 0 ? <details className="mt-4 border-t border-default pt-2 text-sm text-secondary">
        <summary className="min-h-11 cursor-pointer py-3">{count(diff.unchanged.length)} unchanged {diff.unchanged.length === 1 ? 'query' : 'queries'}</summary>
        <ReviewTable label="Unchanged queries" rows={rows('Unchanged', diff.unchanged)} {...table} />
      </details> : null}
      {actions}
    </>
  )
}

/** Publish (Review again after a refusal), Back and the sweep pause: under the review, or pinned in the Add queries sheet's footer. */
export function TrackingReviewActions({ preview, isCommitting, sweepActive, onPublish, onReviewAgain, onBack }: TrackingReviewState & { sweepActive: boolean }) {
  const hasChanges = preview !== null && !preview.diff.noOp
  const changed = preview ? changeCount(preview) : 0
  return (
    <>
      {preview ? (
        <WriteButton type="button" size="sm" disabled={!hasChanges || isCommitting || sweepActive} onClick={onPublish}>
          {isCommitting ? 'Publishing…' : changed > 0 ? `Publish ${count(changed)} ${changed === 1 ? 'change' : 'changes'}` : 'Publish changes'}
        </WriteButton>
      ) : (
        <WriteButton type="button" size="sm" onClick={onReviewAgain}>Review again</WriteButton>
      )}
      {/* A publish in flight ends the review when it lands, so the draft stays out of reach until then. */}
      {onBack ? <Button type="button" variant="ghost" size="sm" disabled={isCommitting} onClick={onBack}>Back</Button> : null}
      {/* Last in its row, so Back stays beside Publish. */}
      {hasChanges && sweepActive ? <p role="status" className="order-last text-sm leading-5 text-caution">A sweep is queued or running. Publish after it finishes.</p> : null}
    </>
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

function ReviewTable({ label, rows, tracked, workspace, contextLabels }: {
  label: string
  rows: readonly { change: Change; row: ChangeRow }[]
  tracked: ReadonlyMap<string, QueryTrackingTrackedRow>
  workspace: QueryTrackingWorkspaceResponse
  contextLabels: ContextLabels
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table aria-label={label} className="evidence-table min-w-[640px] table-auto">
        <thead>
          <tr><th>Change</th><th>Query</th><th>Type</th><th>Locations</th><th>Search location and engines</th></tr>
        </thead>
        <tbody>
          {rows.map(({ change, row }) => {
            // `tracked` is the post-change state: for a removed query it holds what survives, so that row names no type or search location.
            const resolved = change === 'Removed' ? undefined : tracked.get(row.queryId)
            const assignments = resolved?.assignments ?? []
            const searchLocations = contextLabels(assignments.flatMap(assignment => assignment.contexts))
            return (
              <tr key={`${change}:${row.queryId}`}>
                <td className="whitespace-nowrap"><ToneBadge tone={CHANGE_TONE[change]}>{change}</ToneBadge></td>
                <td className="min-w-44 break-words">
                  <span className="font-medium text-heading">{row.queryText}</span>
                  {resolved && (change === 'Added' || change === 'Reused') ? <Classifications row={resolved} workspace={workspace} contextLabels={contextLabels} /> : null}
                </td>
                <td className="whitespace-nowrap text-secondary">{[...new Set(assignments.map(assignment => typeLabel(assignment.queryClass)))].join(', ')}</td>
                {/* The server's assignment count: one per location and search location the query is asked for. A removal counts what it takes away. */}
                <td className="whitespace-nowrap tabular-nums text-secondary">{change === 'Removed' ? '−' : ''}{count(row.assignmentCount)}</td>
                <td className="min-w-44 text-secondary">{searchLocations.length > 1 ? `${count(searchLocations.length)} combinations` : searchLocations[0]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Classifications({ row, workspace, contextLabels }: { row: QueryTrackingTrackedRow; workspace: QueryTrackingWorkspaceResponse; contextLabels: ContextLabels }) {
  if (!row.assignments.length) return null
  const locations = new Set(row.assignments.map(assignment => assignment.targetKey)).size
  const named = (prefix: string, scopes: readonly { stableKey: string; label: string }[], keys: readonly string[]) =>
    keys.length > 0 ? `${prefix}: ${keys.map(key => scopes.find(scope => scope.stableKey === key)?.label ?? key).join(', ')}` : null
  return (
    <details className="text-secondary">
      <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Classifications · {count(locations)} {locations === 1 ? 'location' : 'locations'}</summary>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {row.assignments.map((assignment, index) => <li key={`${assignment.targetKey}:${index}`}>{[
          workspace.targets.find(target => target.stableKey === assignment.targetKey)?.label ?? assignment.targetKey,
          typeLabel(assignment.queryClass),
          named('Groups', workspace.groups, assignment.groupKeys),
          named('Markets', workspace.markets, assignment.marketKeys),
          contextLabels(assignment.contexts).join('; '),
        ].filter(Boolean).join(' · ')}</li>)}
      </ul>
    </details>
  )
}
