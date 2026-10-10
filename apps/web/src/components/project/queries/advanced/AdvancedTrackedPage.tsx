import { Pencil, Plus, Trash2 } from 'lucide-react'

import { isEmbed } from '../../../../api.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { DataTablePagination, DataTableSearch } from '../../../shared/DataTableControls.js'
import { Button } from '../../../ui/button.js'
import { Card } from '../../../ui/card.js'
import type { QueriesSectionProps } from '../../DiscoverySection.js'
import { TrackingReview } from '../../TrackingReview.js'
import { TrackingAddQueriesSheet } from '../AddQueriesEntry.js'
import { AssignmentClassBadge, AssignmentScopeDisclosure, MeasurementStateBadge } from '../TrackedCells.js'
import { TrackingComposer } from '../TrackingComposer.js'
import { provenanceLabel } from '../tracked-rows.js'
import { contextLabels } from '../tracking-contexts.js'
import { useTrackingComposer, type TrackedQueriesPageProps } from '../use-tracking-composer.js'

/** Tracked queries on an advanced project: the list, the Add queries sheet, the Add query form and the shared review. */
export function AdvancedTrackedPage(props: TrackedQueriesPageProps) {
  const { projectName, workspace, selection, onSelectionChange, templates, preview, publishError, isPreviewing, isCommitting, onPreview } = props
  const {
    action, draft, setDraft, reviewedMutation, setReviewedMutation, addSheetOpen, setAddSheetOpen, editorHeadingRef, unavailableScope, table,
    openAdd, openEdit, openRemoval, closeAction, openAddSheet, mutation, canReview, sweepActive, commitReviewed,
  } = useTrackingComposer(props)

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
          <TrackingQueryTypeFilter selection={selection} onSelectionChange={onSelectionChange} />
          <DataTableSearch
            value={table.query}
            onChange={table.setQuery}
            label="Filter tracked queries"
            placeholder="Search tracked queries"
            className="min-w-64 flex-[2]"
          />
          {!isEmbed() && (
            <WriteButton type="button" size="sm" onClick={() => openAddSheet()}>
              <Plus aria-hidden="true" size={14} />
              Add queries
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
                <tr><th>Query</th><th>Scope</th><th>Class</th><th>Source</th><th>Measurement</th><th className="measurement-table-actions"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {table.rows.map(row => (
                  <tr key={row.queryId}>
                    <td className="tracking-query-cell break-words font-medium text-heading">{row.queryText}</td>
                    <td className="tracking-scope-cell text-secondary"><AssignmentScopeDisclosure row={row} workspace={workspace} selection={selection} /></td>
                    <td className="whitespace-nowrap"><AssignmentClassBadge row={row} /></td>
                    <td className="whitespace-nowrap text-secondary">{provenanceLabel(row)}</td>
                    <td className="whitespace-nowrap"><MeasurementStateBadge row={row} outsidePlan={row.assignments.length === 0} /></td>
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

      {/* An advanced review stays up after a refusal, to show the server's message and offer another review. */}
      {reviewedMutation && action && (preview || publishError) && (
        <Card className="surface-card">
          <TrackingReview
            preview={preview}
            error={publishError}
            workspace={workspace}
            contextLabels={contextLabels}
            isCommitting={isCommitting}
            sweepActive={sweepActive}
            onPublish={() => commitReviewed(reviewedMutation)}
            onReviewAgain={() => onPreview(reviewedMutation)}
          />
        </Card>
      )}

      {addSheetOpen && (
        <TrackingAddQueriesSheet
          projectName={projectName}
          workspace={workspace}
          sweepActive={sweepActive}
          defaultMarketKey={selection.measurementScope === 'market' ? selection.measurementScopeKey : undefined}
          defaultLocationKey={selection.measurementScope === 'property' ? selection.measurementScopeKey : undefined}
          onOpenComposer={({ text }) => { setAddSheetOpen(false); openAdd('manual', text) }}
          onClose={() => setAddSheetOpen(false)}
        />
      )}
    </div>
  )
}

function TrackingQueryTypeFilter({
  selection,
  onSelectionChange,
}: {
  selection: NonNullable<QueriesSectionProps['selection']>
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
}) {
  return (
    <label className="min-w-40 flex-1">
      <span className="mb-1 block text-xs font-medium text-secondary">Query type</span>
      <select
        aria-label="Query type"
        className="h-11 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={selection.queryClass}
        onChange={event => onSelectionChange?.({ queryClass: event.target.value })}
      >
        <option value="all">All query types</option>
        <option value="non-brand">Non-brand</option>
        <option value="branded">Branded</option>
        <option value="unknown">Unclassified</option>
      </select>
    </label>
  )
}
