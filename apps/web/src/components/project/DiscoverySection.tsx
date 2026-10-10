import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { MeasurementQueryTemplate, QueryTrackingMode, ResearchRunScope } from '@ainyc/canonry-contracts'

import { getViewerResearchConfig, heyClient } from '../../api.js'
import {
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
} from '@ainyc/canonry-api-client/react-query'
import { useQueryTrackingPublish } from '../../queries/use-query-tracking-publish.js'
import { StatusNote } from '../shared/StatusNote.js'
import { Button } from '../ui/button.js'
import { QueryResearchWorkspace } from './queries/QueryResearchWorkspace.js'
import { SimpleTrackedQueries } from './queries/SimpleTrackedQueries.js'
import { AdvancedTrackedPage } from './queries/advanced/AdvancedTrackedPage.js'
import { TrackedSummaryGridSkeleton } from './queries/advanced/TrackedSummaryGrid.js'
import { TrackedTableSkeleton } from './queries/advanced/TrackedTable.js'
import { DEFAULT_TRACKED_FILTERS } from './queries/advanced/tracked-filters.js'
import type { TrackedFilters } from './queries/advanced/tracked-types.js'
import { useTrackingComposer, type TrackedQueriesPageProps } from './queries/use-tracking-composer.js'
import { canUseResearchWorkspace, effectiveQueryWorkspace, type QueryWorkspace } from '../../lib/project-scope.js'
import { useAccount } from '../../contexts/account-context.js'

export { AddLocationQueryButton } from './queries/AddQueriesEntry.js'
export { DiscoverySection } from './queries/FindQueriesSection.js'

export type { QueryWorkspace }
export type ResearchWorkspaceMode = 'write' | 'pattern' | 'find'
export type SavedTrackingSource =
  | { source: 'research'; researchRunQueryId: string }
  | { source: 'discovery'; discoveryProbeId: string }
export type PendingTrackingSource = SavedTrackingSource & { trackingSelection?: NonNullable<QueriesSectionProps['selection']> }

/**
 * The project page owns the URL. This section owns only the interaction state
 * that is too transient to bookmark (composer text, a pending review, and a
 * table filter). Keeping this boundary explicit prevents a query edit from
 * accidentally reusing the global run drawer's `runId` parameter.
 */
export interface QueriesSectionProps {
  projectName: string
  queryWorkspace?: QueryWorkspace
  onQueryWorkspaceChange?: (workspace: QueryWorkspace) => void
  /** Left out when the URL names none: the research page picks where that lands. */
  researchMode?: ResearchWorkspaceMode
  onResearchModeChange?: (mode: ResearchWorkspaceMode) => void
  selection?: {
    measurementScope: 'project' | 'group' | 'market' | 'property'
    measurementScopeKey?: string
    queryClass: 'all' | 'branded' | 'non-brand' | 'unknown'
    measurementRunId?: string
  }
  onSelectionChange?: (patch: Record<string, unknown>) => void
  trackingQueryId?: string
  onTrackingQueryIdChange?: (queryId: string | undefined) => void
  /** Read-only state that pauses Confirm; the server does not refuse these commits yet. */
  publishGuard?: TrackingPublishGuard
  /** The Tracked filters as the URL holds them. Left out, the section keeps them itself. */
  trackedFilters?: TrackedFilters
  onTrackedFiltersChange?: (patch: Partial<TrackedFilters>) => void
  /** When tracking last changed, for results that come from an older sweep. */
  trackingChangedAt?: string
  /** The next scheduled sweep as shown ("Oct 21"). Left out when no date should be named. */
  nextSweepDate?: string
  /** What the place picker calls the whole project ("All of Acme"), so the page's own way back to it reads the same. */
  rootLabel?: string
  /** The project's mode where the host already knows it, so the loading state has the page's shape. Left out until then. */
  trackedMode?: QueryTrackingMode
}

/** What the Tracked page gets from this host beside the composer's props. */
export type TrackedPageHostProps = Pick<QueriesSectionProps, 'trackingChangedAt' | 'nextSweepDate' | 'rootLabel'> & {
  trackedFilters: TrackedFilters
  onTrackedFiltersChange: (patch: Partial<TrackedFilters>) => void
  /** Where the page portals its actions: the right of the Tracked | Research row, or the line under it in a narrow frame. Null until the row has mounted. */
  actionsSlot: HTMLElement | null
}

export type TrackingPublishGuard = {
  /** A queued run is pinned to the current tracking, so a publish now would not be measured by it. */
  sweepActive: boolean
}

export function QueriesSection({
  projectName,
  queryWorkspace: controlledWorkspace,
  onQueryWorkspaceChange,
  researchMode: controlledResearchMode,
  onResearchModeChange,
  selection = { measurementScope: 'project', queryClass: 'all' },
  onSelectionChange,
  trackingQueryId,
  onTrackingQueryIdChange,
  publishGuard,
  trackedFilters: controlledTrackedFilters,
  onTrackedFiltersChange,
  trackingChangedAt,
  nextSweepDate,
  rootLabel,
  trackedMode,
}: QueriesSectionProps) {
  const { account } = useAccount()
  const [uncontrolledWorkspace, setUncontrolledWorkspace] = useState<QueryWorkspace>('tracked')
  const [uncontrolledResearchMode, setUncontrolledResearchMode] = useState<ResearchWorkspaceMode>()
  const [uncontrolledTrackedFilters, setUncontrolledTrackedFilters] = useState(DEFAULT_TRACKED_FILTERS)
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  const [pendingTrackingSource, setPendingTrackingSource] = useState<PendingTrackingSource | null>(null)
  const viewerResearchConfig = account?.role === 'viewer' ? getViewerResearchConfig() : null
  const showResearchWorkspace = canUseResearchWorkspace(account?.role, viewerResearchConfig)
  const requestedWorkspace = controlledWorkspace ?? uncontrolledWorkspace
  const queryWorkspace = effectiveQueryWorkspace(requestedWorkspace, showResearchWorkspace)
  const researchMode = controlledResearchMode ?? uncontrolledResearchMode
  const trackedFilters = controlledTrackedFilters ?? uncontrolledTrackedFilters

  // Once the host names a mode, a choice kept here is spent: back on a URL with none, the default shows again.
  useEffect(() => {
    if (controlledResearchMode !== undefined) setUncontrolledResearchMode(undefined)
  }, [controlledResearchMode])

  const selectWorkspace = (workspace: QueryWorkspace) => {
    if (controlledWorkspace === undefined) setUncontrolledWorkspace(workspace)
    onQueryWorkspaceChange?.(workspace)
  }
  const selectResearchMode = (mode: ResearchWorkspaceMode) => {
    if (controlledResearchMode === undefined) setUncontrolledResearchMode(mode)
    onResearchModeChange?.(mode)
  }
  const changeTrackedFilters = (patch: Partial<TrackedFilters>) => {
    if (controlledTrackedFilters === undefined) setUncontrolledTrackedFilters(previous => ({ ...previous, ...patch }))
    onTrackedFiltersChange?.(patch)
  }
  const reviewSavedSource = (source: SavedTrackingSource, scope?: ResearchRunScope | null) => {
    // Only a research run's own market or property preselects a destination.
    // A Find result starts at project scope and leaves the Tracked filter alone.
    const trackingSelection = {
      ...selection,
      measurementScope: scope?.kind ?? 'project' as const,
      measurementScopeKey: scope?.key,
    }
    setPendingTrackingSource({ ...source, trackingSelection })
    if (scope !== undefined) onSelectionChange?.({ measurementScope: trackingSelection.measurementScope, measurementScopeKey: trackingSelection.measurementScopeKey })
    selectWorkspace('tracked')
  }

  return (
    <section aria-labelledby="queries-heading">
      <h2 id="queries-heading" className="sr-only">Queries</h2>
      {/* The tab row keeps one height with or without actions, so the tabs never move. In a row too narrow for both, the actions take the first line under the rule. */}
      <div className="@container">
        <div className="grid @xl:grid-cols-[1fr_auto]">
          <div className="flex min-h-12 items-end border-b border-default" role="tablist" aria-label="Query workspace">
            <WorkspaceTab active={queryWorkspace === 'tracked'} label="Tracked" onClick={() => selectWorkspace('tracked')} />
            {showResearchWorkspace ? <WorkspaceTab active={queryWorkspace === 'research'} label="Research" onClick={() => selectWorkspace('research')} /> : null}
          </div>
          <div ref={setActionsSlot} className="flex flex-wrap items-center justify-end gap-2 pt-3 empty:hidden @xl:border-b @xl:border-default @xl:pt-0 @xl:pl-3" />
        </div>
      </div>
      <div className="mt-4">
        {queryWorkspace === 'tracked' ? (
          <TrackedQueriesSection
            projectName={projectName}
            selection={selection}
            onSelectionChange={onSelectionChange}
            trackingQueryId={trackingQueryId}
            onTrackingQueryIdChange={onTrackingQueryIdChange}
            pendingTrackingSource={pendingTrackingSource}
            onPendingTrackingSourceHandled={() => setPendingTrackingSource(null)}
            publishGuard={publishGuard}
            trackedFilters={trackedFilters}
            onTrackedFiltersChange={changeTrackedFilters}
            trackingChangedAt={trackingChangedAt}
            nextSweepDate={nextSweepDate}
            rootLabel={rootLabel}
            trackedMode={trackedMode}
            actionsSlot={actionsSlot}
          />
        ) : (
          <QueryResearchWorkspace
            projectName={projectName}
            selection={selection}
            mode={researchMode}
            onModeChange={selectResearchMode}
            onReviewSavedSource={reviewSavedSource}
            onSelectionChange={onSelectionChange}
            viewerResearchConfig={viewerResearchConfig}
          />
        )}
      </div>
    </section>
  )
}

export function WorkspaceTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500 focus-visible:ring-inset ${active ? 'border-mono-400 text-heading' : 'border-transparent text-muted hover:border-strong hover:text-strong'}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TrackedQueriesSection({
  projectName,
  selection = { measurementScope: 'project', queryClass: 'all' },
  onSelectionChange,
  trackingQueryId,
  onTrackingQueryIdChange,
  pendingTrackingSource,
  onPendingTrackingSourceHandled,
  publishGuard,
  trackedMode,
  ...host
}: Pick<QueriesSectionProps, 'projectName' | 'selection' | 'onSelectionChange' | 'trackingQueryId' | 'onTrackingQueryIdChange' | 'publishGuard' | 'trackedMode'> & TrackedPageHostProps & {
  pendingTrackingSource: PendingTrackingSource | null
  onPendingTrackingSourceHandled: () => void
}) {
  const publish = useQueryTrackingPublish(projectName, { onCommitted: () => onTrackingQueryIdChange?.(undefined) })
  const workspaceQuery = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } }),
  })
  const templatesQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementQueryTemplatesOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 60_000,
  })

  if (workspaceQuery.isLoading) {
    // An advanced page opens on its number strip and toolbar, so their room is held and the rows land where they were drawn.
    return (
      <div className="query-tracking-workspace">
        {trackedMode === 'advanced' ? <>
          <TrackedSummaryGridSkeleton />
          <div aria-hidden="true" className="py-3">
            <div className="skeleton-text h-8 w-full max-md:h-11" />
            <div className="mt-2 flex h-5 items-center"><div className="skeleton-text w-24" /></div>
          </div>
        </> : null}
        <TrackedTableSkeleton />
      </div>
    )
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return (
      <div role="alert" className="py-4">
        <StatusNote
          icon={AlertTriangle}
          tone="negative"
          label="Could not load"
          action={<Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" aria-label="Retry tracked queries" onClick={() => void workspaceQuery.refetch()}>Retry</Button>}
        />
      </div>
    )
  }

  return (
    <TrackedQueriesGate
      {...host}
      projectName={projectName}
      workspace={workspaceQuery.data}
      selection={selection}
      onSelectionChange={onSelectionChange}
      trackingQueryId={trackingQueryId}
      onTrackingQueryIdChange={onTrackingQueryIdChange}
      pendingTrackingSource={pendingTrackingSource}
      onPendingTrackingSourceHandled={onPendingTrackingSourceHandled}
      publishGuard={publishGuard}
      templates={templatesQuery.data?.templates ?? NO_TEMPLATES}
      preview={publish.preview}
      publishError={publish.error}
      isPreviewing={publish.isPreviewing}
      isCommitting={publish.isCommitting}
      onPreview={(mutation) => publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspaceQuery.data.workspaceVersion })}
      onCommit={publish.commit}
    />
  )
}

/** One list while the saved patterns load, so a page can key its rows on it. */
const NO_TEMPLATES: readonly MeasurementQueryTemplate[] = []

/** The mode gate: each mode has its own page. One composer sits above both, so a mode change keeps the open form, its draft and the search. */
function TrackedQueriesGate(props: TrackedQueriesPageProps & TrackedPageHostProps) {
  const composer = useTrackingComposer(props)
  const TrackedPage = props.workspace.mode === 'advanced' ? AdvancedTrackedPage : SimpleTrackedQueries
  return <TrackedPage {...props} composer={composer} />
}
