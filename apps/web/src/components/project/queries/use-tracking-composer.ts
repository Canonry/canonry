import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MeasurementQueryTemplate,
  QueryTrackingCommitRequest,
  QueryTrackingMutation,
  QueryTrackingPreviewResponse,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { unavailableTrackingScope } from '../../../lib/project-scope.js'
import { useClientTable } from '../../shared/DataTableControls.js'
import type { PendingTrackingSource, QueriesSectionProps, TrackingPublishGuard } from '../DiscoverySection.js'
import type { TrackingReviewState } from '../TrackingReview.js'
import { filterTrackedRows } from './tracked-rows.js'
import {
  audienceForSelection,
  defaultTrackingDraft,
  draftForRow,
  hasMarketOnlyAudience,
  mutationForAction,
  scopeValue,
  selectionScopeLabel,
  type TrackingAction,
  type TrackingDraft,
} from './tracking-draft.js'

/**
 * The generated SDK transport is attached in `TrackedQueriesSection`. Keeping
 * the two tracked pages transport-free makes the review boundary explicit:
 * the browser builds a requested mutation, but the server resolves duplicates,
 * class, exact diff, and next-sweep workload. `AddQueriesSheet` is the one
 * exception: it publishes through its own instance of the same hook, so the
 * advanced page passes it `projectName`.
 */
export type TrackedQueriesPageProps = {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  selection: NonNullable<QueriesSectionProps['selection']>
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
  trackingQueryId?: string
  onTrackingQueryIdChange?: QueriesSectionProps['onTrackingQueryIdChange']
  pendingTrackingSource: PendingTrackingSource | null
  onPendingTrackingSourceHandled: () => void
  templates: readonly MeasurementQueryTemplate[]
  preview: QueryTrackingPreviewResponse | null
  /** The server's last refusal of a review or a publish, until the next request. */
  publishError: TrackingReviewState['error']
  isPreviewing: boolean
  isCommitting: boolean
  onPreview: (mutation: QueryTrackingMutation) => void
  onCommit: (request: QueryTrackingCommitRequest) => void
  publishGuard?: TrackingPublishGuard
}

/**
 * The tracked list and the Add, Edit and Remove query forms behind it: which
 * form is open, its draft, the change under review and the rows in view. The
 * simple and the advanced page draw different markup over the same state.
 */
export function useTrackingComposer({
  workspace,
  selection,
  trackingQueryId,
  onTrackingQueryIdChange,
  pendingTrackingSource,
  onPendingTrackingSourceHandled,
  preview,
  isPreviewing,
  onCommit,
  publishGuard,
}: TrackedQueriesPageProps) {
  const [action, setAction] = useState<TrackingAction | null>(null)
  const [draft, setDraft] = useState<TrackingDraft>(() => defaultTrackingDraft(selection))
  const [reviewedMutation, setReviewedMutation] = useState<QueryTrackingMutation | null>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const editorHeadingRef = useRef<HTMLHeadingElement>(null)
  const handledRouteAction = useRef<string | null>(null)
  const unavailableScope = unavailableTrackingScope(workspace, selection)
  const rowsInScope = useMemo(() => filterTrackedRows(workspace.tracked, selection, workspace.mode), [selection, workspace.mode, workspace.tracked])
  const table = useClientTable({
    rows: rowsInScope,
    getSearchText: (row) => `${row.queryText} ${row.provenance?.source ?? 'legacy'} ${row.assignments.map(assignment => assignment.queryClass ?? 'unknown').join(' ')}`,
  })

  useEffect(() => {
    if (unavailableScope) return
    if (!trackingQueryId) {
      handledRouteAction.current = null
      return
    }
    const routeAction = `${trackingQueryId}:${scopeValue(selection)}`
    if (handledRouteAction.current === routeAction) return
    const row = workspace.tracked.find(candidate => candidate.queryId === trackingQueryId)
    if (!row) return
    handledRouteAction.current = routeAction
    setAction({ kind: 'edit', row, audience: workspace.mode === 'advanced' ? audienceForSelection(selection) : undefined, scopeLabel: selectionScopeLabel(selection, workspace) })
    setDraft(draftForRow(row, selection))
    setReviewedMutation(null)
  }, [selection, trackingQueryId, unavailableScope, workspace])

  useEffect(() => {
    if (unavailableScope) return
    if (!pendingTrackingSource) return
    const next = defaultTrackingDraft(pendingTrackingSource.trackingSelection ?? selection)
    setAction({ kind: 'add' })
    setDraft(pendingTrackingSource.source === 'research'
      ? { ...next, source: 'research', researchRunQueryId: pendingTrackingSource.researchRunQueryId }
      : { ...next, source: 'discovery', discoveryProbeId: pendingTrackingSource.discoveryProbeId })
    setReviewedMutation(null)
    onPendingTrackingSourceHandled()
  }, [onPendingTrackingSourceHandled, pendingTrackingSource, selection, unavailableScope])

  useEffect(() => {
    if (!unavailableScope) return
    setAction(null)
    setReviewedMutation(null)
    setAddSheetOpen(false)
    if (trackingQueryId !== undefined) onTrackingQueryIdChange?.(undefined)
  }, [onTrackingQueryIdChange, trackingQueryId, unavailableScope])

  useEffect(() => {
    if (!action || action.kind === 'remove') return
    const heading = editorHeadingRef.current
    if (!heading) return
    heading.scrollIntoView?.({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [action])

  function openAdd(source: TrackingDraft['source'] = 'manual', text = '') {
    setAction({ kind: 'add' })
    setDraft({ ...defaultTrackingDraft(selection), source, text })
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(undefined)
  }

  function openEdit(row: QueryTrackingTrackedRow) {
    handledRouteAction.current = `${row.queryId}:${scopeValue(selection)}`
    setAction({ kind: 'edit', row, audience: workspace.mode === 'advanced' ? audienceForSelection(selection) : undefined, scopeLabel: selectionScopeLabel(selection, workspace) })
    setDraft(draftForRow(row, selection))
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(row.queryId)
  }

  function openRemoval(row: QueryTrackingTrackedRow) {
    handledRouteAction.current = `${row.queryId}:${scopeValue(selection)}`
    setAction({ kind: 'remove', row, audience: workspace.mode === 'advanced' ? audienceForSelection(selection) : undefined, scopeLabel: selectionScopeLabel(selection, workspace) })
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(row.queryId)
  }

  function closeAction() {
    setAction(null)
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(undefined)
  }

  // Advanced projects add through the sheet; it hands off to the Add query form for the rest.
  function openAddSheet() {
    closeAction()
    setAddSheetOpen(true)
  }

  const mutation = action ? mutationForAction(action, draft, workspace) : null
  const needsExplicitContext = action !== null
    && action.kind === 'add'
    && workspace.mode === 'advanced'
    && !hasMarketOnlyAudience(draft)
  const canReview = mutation !== null && (!needsExplicitContext || draft.contexts.length > 0) && !isPreviewing
  const sweepActive = publishGuard?.sweepActive ?? false

  function commitReviewed(reviewed: QueryTrackingMutation) {
    if (!preview) return
    onCommit({
      ...reviewed,
      expectedWorkspaceVersion: preview.workspaceVersion,
      previewToken: preview.previewToken,
      reviewedAt: preview.reviewedAt,
    })
  }

  return {
    action,
    draft,
    setDraft,
    reviewedMutation,
    setReviewedMutation,
    addSheetOpen,
    setAddSheetOpen,
    editorHeadingRef,
    unavailableScope,
    table,
    openAdd,
    openEdit,
    openRemoval,
    closeAction,
    openAddSheet,
    mutation,
    canReview,
    sweepActive,
    commitReviewed,
  }
}
