import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QueryTrackingWorkspaceResponse, ResearchRunScope } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import type { ViewerResearchConfig } from '../../../api.js'
import { useAccount } from '../../../contexts/account-context.js'
// The host imports this file too. Take only types and function declarations from it: those need no load order.
import type { QueriesSectionProps, ResearchWorkspaceMode, SavedTrackingSource } from '../DiscoverySection.js'
import { ResearchQueriesSection, ResearchStartControl, type ResearchTemplateOption } from '../ResearchQueriesSection.js'
import { FindQueriesSection } from './FindQueriesSection.js'

const NO_SCOPE_OPTIONS: NonNullable<QueryTrackingWorkspaceResponse['scopeOptions']> = []

/**
 * Research is one page under the Tracked | Research row, with no tab row of
 * its own. "Start from" picks the form: Write, Pattern, or Find ideas, which
 * only an account that can write gets. The choice is the host's `researchMode`,
 * so a link or a reload opens the same form; with none named the page opens on
 * Write, which reads saved runs and starts nothing.
 */
export function QueryResearchWorkspace({
  projectName,
  selection,
  mode,
  onModeChange,
  onReviewSavedSource,
  viewerResearchConfig,
}: {
  projectName: string
  selection: NonNullable<QueriesSectionProps['selection']>
  mode?: ResearchWorkspaceMode
  onModeChange: (mode: ResearchWorkspaceMode) => void
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
  onReviewSavedSource: (source: SavedTrackingSource, scope?: ResearchRunScope | null) => void
  viewerResearchConfig: ViewerResearchConfig | null
}) {
  const { canWrite } = useAccount()
  const start: ResearchWorkspaceMode = mode === 'find' && canWrite ? 'find' : mode === 'pattern' ? 'pattern' : 'write'
  // Find ideas is another form with its own copy of "Start from". A choice made on one lands focus on the other's, so arrow keys keep working across the swap.
  const page = useRef<HTMLDivElement>(null)
  const chosen = useRef(false)
  const changeStart = (next: ResearchWorkspaceMode) => { chosen.current = true; onModeChange(next) }
  useEffect(() => {
    if (!chosen.current) return
    chosen.current = false
    page.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
  }, [start])
  // Find ideas reads neither the plan nor the saved patterns.
  const researchWorkspaceEnabled = start !== 'find'
  const workspaceQuery = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } }),
    enabled: researchWorkspaceEnabled,
    staleTime: 60_000,
  })
  const researchTemplatesQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementQueryTemplatesOptions({ client: heyClient, path: { name: projectName } }),
    enabled: researchWorkspaceEnabled,
    staleTime: 60_000,
  })
  // The server's own list of places. One that predates it offers research with no Subject and across search locations.
  const researchScopeOptions = workspaceQuery.data?.scopeOptions ?? NO_SCOPE_OPTIONS
  const researchTemplates = useMemo<ResearchTemplateOption[]>(() => (researchTemplatesQuery.data?.templates ?? []).map(template => ({
    id: template.id,
    version: template.updatedAt,
    label: template.name,
    pattern: template.pattern,
    variables: template.variables,
  })), [researchTemplatesQuery.data])
  const researchProps = {
    projectName,
    scopeOptions: researchScopeOptions,
    planRevision: workspaceQuery.data?.active?.revision ?? null,
    selectedScope: (() => {
      const option = researchScopeOptions.find(item => item.kind === selection.measurementScope && item.id === selection.measurementScopeKey)
      const revision = workspaceQuery.data?.active?.revision
      return option && revision && (option.kind === 'market' || option.kind === 'property')
        ? { kind: option.kind, key: option.id, label: option.label, planRevision: revision, expectedPlanRevision: revision }
        : (selection.measurementScope === 'market' || selection.measurementScope === 'property') && selection.measurementScopeKey
          ? { kind: selection.measurementScope, key: selection.measurementScopeKey, label: selection.measurementScopeKey, planRevision: revision ?? 0, expectedPlanRevision: revision ?? 0 }
        : null
    })(),
    scopePending: workspaceQuery.isPending || workspaceQuery.isFetching,
    scopeError: workspaceQuery.isError,
    onRetryScope: () => { void workspaceQuery.refetch() },
    templates: researchTemplates,
  }
  return (
    <div ref={page}>
      {start === 'find' ? (
        <FindQueriesSection
          projectName={projectName}
          startControl={<ResearchStartControl value="find" onChange={changeStart} findIdeas />}
          onReviewDiscoveryProbe={(discoveryProbeId) => onReviewSavedSource({ source: 'discovery', discoveryProbeId })}
        />
      ) : (
        <ResearchQueriesSection
          {...researchProps}
          start={start}
          onStartChange={changeStart}
          findIdeas={canWrite}
          viewerResearchConfig={viewerResearchConfig}
          onReviewForTracking={canWrite ? ({ researchRunQueryId, scope }) => onReviewSavedSource({ source: 'research', researchRunQueryId }, scope ?? null) : undefined}
        />
      )}
    </div>
  )
}
