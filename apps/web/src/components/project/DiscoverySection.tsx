import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ResearchRunScope } from '@ainyc/canonry-contracts'

import { getViewerResearchConfig, heyClient } from '../../api.js'
import {
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
} from '@ainyc/canonry-api-client/react-query'
import { useQueryTrackingPublish } from '../../queries/use-query-tracking-publish.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { QueryResearchWorkspace } from './queries/QueryResearchWorkspace.js'
import { SimpleTrackedQueries } from './queries/SimpleTrackedQueries.js'
import { AdvancedTrackedPage } from './queries/advanced/AdvancedTrackedPage.js'
import { useTrackingComposer, type TrackedQueriesPageProps } from './queries/use-tracking-composer.js'
import { canUseResearchWorkspace, effectiveQueryWorkspace, type QueryWorkspace } from '../../lib/project-scope.js'
import { useAccount } from '../../contexts/account-context.js'

export { AddLocationQueryButton } from './queries/AddQueriesEntry.js'
export { DiscoverySection } from './queries/FindQueriesSection.js'

export type { QueryWorkspace }
export type ResearchWorkspaceMode = 'find' | 'test'
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
}: QueriesSectionProps) {
  const { account } = useAccount()
  const [uncontrolledWorkspace, setUncontrolledWorkspace] = useState<QueryWorkspace>('tracked')
  const [uncontrolledResearchMode, setUncontrolledResearchMode] = useState<ResearchWorkspaceMode>('find')
  const [pendingTrackingSource, setPendingTrackingSource] = useState<PendingTrackingSource | null>(null)
  const viewerResearchConfig = account?.role === 'viewer' ? getViewerResearchConfig() : null
  const showResearchWorkspace = canUseResearchWorkspace(account?.role, viewerResearchConfig)
  const requestedWorkspace = controlledWorkspace ?? uncontrolledWorkspace
  const queryWorkspace = effectiveQueryWorkspace(requestedWorkspace, showResearchWorkspace)
  const researchMode = controlledResearchMode ?? uncontrolledResearchMode

  const selectWorkspace = (workspace: QueryWorkspace) => {
    if (controlledWorkspace === undefined) setUncontrolledWorkspace(workspace)
    onQueryWorkspaceChange?.(workspace)
  }
  const selectResearchMode = (mode: ResearchWorkspaceMode) => {
    if (controlledResearchMode === undefined) setUncontrolledResearchMode(mode)
    onResearchModeChange?.(mode)
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
    <section className="page-section-divider" aria-labelledby="queries-heading">
      <div className="section-head">
        <h2 id="queries-heading">Queries</h2>
      </div>
      <div className="mt-3 flex border-b border-default" role="tablist" aria-label="Query workspace">
        <WorkspaceTab active={queryWorkspace === 'tracked'} label="Tracked" onClick={() => selectWorkspace('tracked')} />
        {showResearchWorkspace ? <WorkspaceTab active={queryWorkspace === 'research'} label="Research" onClick={() => selectWorkspace('research')} /> : null}
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
}: Pick<QueriesSectionProps, 'projectName' | 'selection' | 'onSelectionChange' | 'trackingQueryId' | 'onTrackingQueryIdChange' | 'publishGuard'> & {
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
    return <Card className="surface-card"><p className="text-sm text-muted">Loading tracked queries…</p></Card>
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return (
      <Card className="surface-card">
        <p className="text-sm text-negative">Could not load tracked queries.</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void workspaceQuery.refetch()}>
          Try again
        </Button>
      </Card>
    )
  }

  return (
    <TrackedQueriesGate
      projectName={projectName}
      workspace={workspaceQuery.data}
      selection={selection}
      onSelectionChange={onSelectionChange}
      trackingQueryId={trackingQueryId}
      onTrackingQueryIdChange={onTrackingQueryIdChange}
      pendingTrackingSource={pendingTrackingSource}
      onPendingTrackingSourceHandled={onPendingTrackingSourceHandled}
      publishGuard={publishGuard}
      templates={templatesQuery.data?.templates ?? []}
      preview={publish.preview}
      publishError={publish.error}
      isPreviewing={publish.isPreviewing}
      isCommitting={publish.isCommitting}
      onPreview={(mutation) => publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspaceQuery.data.workspaceVersion })}
      onCommit={publish.commit}
    />
  )
}

/** The mode gate: each mode has its own page. One composer sits above both, so a mode change keeps the open form, its draft and the search. */
function TrackedQueriesGate(props: TrackedQueriesPageProps) {
  const composer = useTrackingComposer(props)
  const TrackedPage = props.workspace.mode === 'advanced' ? AdvancedTrackedPage : SimpleTrackedQueries
  return <TrackedPage {...props} composer={composer} />
}
