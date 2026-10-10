import { useEffect, useRef } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { QueryTrackingPreviewResponse, QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { isEmbed } from '../../../api.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { DataTablePagination, DataTableSearch } from '../../shared/DataTableControls.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'
import { Card } from '../../ui/card.js'
import { AssignmentScopeDisclosure, MeasurementStateBadge } from './TrackedCells.js'
import { TrackingComposer } from './TrackingComposer.js'
import { assignmentScopeLabel, provenanceLabel } from './tracked-rows.js'
import { contextInput, contextLabel, uniqueContextInputs } from './tracking-contexts.js'
import type { TrackedQueriesPageProps, TrackingComposerState } from './use-tracking-composer.js'

/** Tracked queries on a simple project: the list, the Add query form and its review. */
export function SimpleTrackedQueries(props: TrackedQueriesPageProps & { composer: TrackingComposerState }) {
  const { workspace, selection, onSelectionChange, templates, preview, isPreviewing, isCommitting, onPreview } = props
  const {
    action, draft, setDraft, reviewedMutation, setReviewedMutation, editorHeadingRef, unavailableScope, table,
    openAdd, openEdit, openRemoval, closeAction, mutation, canReview, sweepActive, commitReviewed,
  } = props.composer

  if (unavailableScope) {
    return <div className="query-tracking-workspace space-y-4"><section aria-label="Tracked queries" className="py-4 text-sm text-secondary">
      <p>This saved {selection.measurementScope} filter is unavailable in the current measurement.</p>
      <Button type="button" variant="outline" className="mt-3" onClick={() => onSelectionChange?.({ measurementScope: 'project', measurementScopeKey: undefined })}>Show whole site</Button>
    </section></div>
  }

  return (
    <div className="query-tracking-workspace space-y-4">
      <section aria-label="Tracked queries">
        <div className="flex flex-wrap items-end gap-3">
          <DataTableSearch
            value={table.query}
            onChange={table.setQuery}
            label="Filter tracked queries"
            placeholder="Search tracked queries"
            className="min-w-64 flex-[2]"
          />
          {!isEmbed() && (
            <WriteButton type="button" size="sm" onClick={() => openAdd()}>
              <Plus aria-hidden="true" size={14} />
              Add query
            </WriteButton>
          )}
        </div>
        <p className="mt-2 text-xs leading-5 text-secondary">
          {table.totalRows.toLocaleString('en-US')} saved query {table.totalRows === 1 ? 'record' : 'records'} in this view. Each record can have more than one property, group, or market assignment.
        </p>
        {selection.measurementScope === 'group' ? <p className="mt-1 text-xs leading-5 text-secondary">Queries belong to properties, so a shared query can also cover other groups.</p> : null}

        {!workspace.active ? <p className="mt-3 text-sm text-caution">No published measurement yet.</p> : null}

        {table.rows.length === 0 ? (
          <p className="mt-5 text-sm text-muted">
            {table.hasQuery ? 'No tracked queries match that search.' : 'No tracked queries in this scope yet.'}
          </p>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="evidence-table measurement-responsive-table min-w-[760px] table-auto">
              <thead>
                <tr><th>Query</th><th>Scope</th><th>Source</th><th>Measurement</th><th className="measurement-table-actions"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {table.rows.map(row => (
                  <tr key={row.queryId}>
                    <td className="tracking-query-cell break-words font-medium text-heading">{row.queryText}</td>
                    <td className="tracking-scope-cell text-secondary"><AssignmentScopeDisclosure row={row} workspace={workspace} selection={selection} /></td>
                    <td className="whitespace-nowrap text-secondary">{provenanceLabel(row)}</td>
                    <td className="whitespace-nowrap"><MeasurementStateBadge row={row} /></td>
                    <td className="measurement-table-actions whitespace-nowrap text-right">
                      {!isEmbed() && <div className="tracking-row-actions flex min-w-max justify-end gap-2">
                        <WriteButton type="button" variant="ghost" size="sm" aria-label={`Edit ${row.queryText}`} onClick={() => openEdit(row)}>
                          <Pencil aria-hidden="true" size={13} /> Edit
                        </WriteButton>
                        <WriteButton type="button" variant="ghost" size="sm" aria-label={`Remove ${row.queryText}`} onClick={() => openRemoval(row)}>
                          <Trash2 aria-hidden="true" size={13} /> Remove
                        </WriteButton>
                      </div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DataTablePagination
          page={table.page}
          pageSize={table.pageSize}
          visibleRows={table.rows.length}
          totalRows={table.totalRows}
          itemLabel="queries"
          onPageChange={table.setPage}
        />
      </section>

      {action && !isEmbed() && (
        <TrackingComposer
          workspace={workspace}
          templates={templates}
          action={action}
          draft={draft}
          onDraftChange={(next) => { setDraft(next); setReviewedMutation(null) }}
          onClose={closeAction}
          canReview={canReview}
          isPreviewing={isPreviewing}
          editorHeadingRef={editorHeadingRef}
          onReview={() => {
            if (!mutation) return
            setReviewedMutation(mutation)
            onPreview(mutation)
          }}
        />
      )}

      {preview && reviewedMutation && action && (
        <TrackingPreview
          preview={preview}
          workspace={workspace}
          isCommitting={isCommitting}
          sweepActive={sweepActive}
          onConfirm={() => commitReviewed(reviewedMutation)}
        />
      )}
    </div>
  )
}

/** The review on a simple project. An advanced project draws `TrackingReview`. */
function TrackingPreview({
  preview,
  workspace,
  isCommitting,
  sweepActive,
  onConfirm,
}: {
  preview: QueryTrackingPreviewResponse
  workspace: QueryTrackingWorkspaceResponse
  isCommitting: boolean
  sweepActive: boolean
  onConfirm: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const heading = headingRef.current
    if (!heading) return
    if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [preview])
  const hasChanges = !preview.diff.noOp
  const subcopy = !hasChanges
    ? 'This request leaves tracking unchanged.'
    : 'Changes apply to future sweeps. Earlier results stay unchanged.'
  const changed = [
    { label: 'Added', rows: preview.diff.added },
    { label: 'Removed', rows: preview.diff.removed },
    { label: 'Reused', rows: preview.diff.reused },
  ].filter(group => group.rows.length > 0)
  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline gap-4">
        <div>
          <h3 ref={headingRef} tabIndex={-1}>{hasChanges ? 'Confirm tracked query changes' : 'No tracking changes'}</h3>
          <p className="mt-1 text-sm font-medium text-strong">{previewWorkloadLine(preview)}</p>
          <p className="mt-1 text-sm leading-6 text-secondary">{subcopy}</p>
        </div>
        <ToneBadge tone={hasChanges ? 'caution' : 'neutral'} className="sm:shrink-0 sm:whitespace-nowrap">{hasChanges ? 'Ready to confirm' : 'No-op'}</ToneBadge>
      </div>
      {changed.length > 0 ? <div className="mt-4 space-y-4">
        {changed.map(group => <PreviewChangeList key={group.label} label={group.label} rows={group.rows} workspace={workspace} tracked={preview.tracked} />)}
      </div> : null}
      {preview.diff.unchanged.length > 0 ? <details className="mt-4 border-t border-default pt-2 text-sm text-secondary">
        <summary className="min-h-11 cursor-pointer py-3">{preview.diff.unchanged.length} unchanged {preview.diff.unchanged.length === 1 ? 'query' : 'queries'}</summary>
        <PreviewChangeList label="Unchanged" rows={preview.diff.unchanged} workspace={workspace} tracked={preview.tracked} />
      </details> : null}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
        <WriteButton type="button" size="sm" disabled={!hasChanges || isCommitting || sweepActive} onClick={onConfirm}>
          {isCommitting ? 'Confirming…' : 'Confirm changes'}
        </WriteButton>
        {hasChanges && sweepActive ? <p role="status" className="text-sm leading-5 text-caution">A sweep is queued or running. Publish after it finishes.</p> : null}
      </div>
    </Card>
  )
}

/** One provider call is one answer; added and removed answers stay separate. */
function previewWorkloadLine(preview: QueryTrackingPreviewResponse): string {
  const { added } = preview.diff
  // A scoped removal lists a query that stays tracked elsewhere; only rows gone
  // from the post-change `tracked` leave tracking. Answers still count the rest.
  const stillTracked = new Set(preview.tracked.map(row => row.queryId))
  const removed = preview.diff.removed.filter(row => !stillTracked.has(row.queryId))
  const { addedProviderCalls, removedProviderCalls, nextSweepProviderCalls } = preview.workload
  const count = (value: number) => value.toLocaleString('en-US')
  return [
    added.length > 0 ? `+${count(added.length)} ${added.length === 1 ? 'query' : 'queries'}` : null,
    removed.length > 0 ? `−${count(removed.length)} ${removed.length === 1 ? 'query' : 'queries'}` : null,
    `+${count(addedProviderCalls)} / −${count(removedProviderCalls)} answers per sweep`,
    `next sweep asks ${count(nextSweepProviderCalls)}`,
  ].filter((part): part is string => part !== null).join(' · ')
}

function PreviewChangeList({
  label,
  rows,
  workspace,
  tracked,
}: {
  label: string
  rows: QueryTrackingPreviewResponse['diff']['added']
  workspace: QueryTrackingWorkspaceResponse
  tracked: readonly QueryTrackingTrackedRow[]
}) {
  return (
    <section aria-label={`${label} queries`}>
      <p className="text-xs font-medium text-secondary">{rows.length} {label.toLocaleLowerCase()}</p>
      <ul className="mt-2 divide-y divide-default">
        {rows.map(row => <li key={`${label}:${row.queryId}`} className="py-2 text-sm">
          <p className="font-medium text-strong">{row.queryText}</p>
          <p className="mt-1 text-secondary">{label === 'Removed'
            // `tracked` is the post-change state, so its scopes describe what survives.
            ? `${row.assignmentCount} ${row.assignmentCount === 1 ? 'assignment' : 'assignments'} removed`
            : previewRowDetail(row, tracked, workspace)}</p>
        </li>)}
      </ul>
    </section>
  )
}

function previewRowDetail(
  row: QueryTrackingPreviewResponse['diff']['added'][number],
  tracked: readonly QueryTrackingTrackedRow[],
  workspace: QueryTrackingWorkspaceResponse,
): string {
  const resolved = tracked.find(candidate => candidate.queryId === row.queryId)
  if (!resolved) return `${row.assignmentCount} ${row.assignmentCount === 1 ? 'assignment' : 'assignments'}`
  const contexts = uniqueContextInputs(resolved.assignments.flatMap(assignment => assignment.contexts).map(contextInput))
  const context = contexts.length === 1
    ? contextLabel(contexts[0]!)
    : contexts.length > 1 ? `${contexts.length} contexts` : null
  return [assignmentScopeLabel(resolved, workspace), context].filter((value): value is string => value !== null).join(' · ')
}
