import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ResearchRunScope, VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import type { ViewerResearchConfig } from '../../../api.js'
import { useAccount } from '../../../contexts/account-context.js'
// The host imports this file too. Take only types and function declarations from it: those need no load order.
import { WorkspaceTab } from '../DiscoverySection.js'
import type { QueriesSectionProps, ResearchWorkspaceMode, SavedTrackingSource } from '../DiscoverySection.js'
import { ResearchQueriesSection, type ResearchTemplateOption } from '../ResearchQueriesSection.js'
import { FindQueriesSection } from './FindQueriesSection.js'

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
  // The two tabs stand in for the modes: Write and Pattern open Test queries, Find and no mode open Find queries.
  const tab = mode === 'write' || mode === 'pattern' ? 'test' : 'find'
  const researchWorkspaceEnabled = !canWrite || tab === 'test'
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
  const researchScopeOptions = useMemo<VisibilityReportScopeOption[]>(() => {
    const workspace = workspaceQuery.data
    if (!workspace) return [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 0 }]
    const groupIdsByTarget = new Map(workspace.targets.map(target => [target.stableKey, [] as string[]]))
    for (const group of workspace.groups) for (const targetKey of group.targetKeys) groupIdsByTarget.get(targetKey)?.push(group.stableKey)
    const groupIdsByMarket = new Map(workspace.markets.map(market => [market.stableKey, new Set<string>()]))
    for (const market of workspace.markets) {
      for (const edge of market.usageEdges) for (const groupId of groupIdsByTarget.get(edge.targetKey) ?? []) groupIdsByMarket.get(market.stableKey)?.add(groupId)
    }
    return [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: workspace.targets.length },
      ...workspace.groups.map(group => ({ id: group.stableKey, label: group.label, kind: 'group' as const, targetCount: group.targetKeys.length, ...(group.parentGroupKey ? { parentGroupIds: [group.parentGroupKey] } : {}) })),
      ...workspace.markets.map(market => {
        const parentGroupIds = [...(groupIdsByMarket.get(market.stableKey) ?? [])]
        return { id: market.stableKey, label: market.label, kind: 'market' as const, targetCount: 0, ...(parentGroupIds.length ? { parentGroupIds } : {}) }
      }),
      ...workspace.targets.map(target => ({ id: target.stableKey, label: target.label, kind: 'property' as const, targetCount: 1, ...(groupIdsByTarget.get(target.stableKey)?.length ? { parentGroupIds: groupIdsByTarget.get(target.stableKey) } : {}) })),
    ]
  }, [workspaceQuery.data])
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
  if (!canWrite) {
    return (
      <ResearchQueriesSection
        {...researchProps}
        viewerResearchConfig={viewerResearchConfig}
      />
    )
  }
  return (
    <div>
      <div className="flex border-b border-default" role="tablist" aria-label="Research workspace">
        <WorkspaceTab active={tab === 'find'} label="Find queries" onClick={() => onModeChange('find')} />
        <WorkspaceTab active={tab === 'test'} label="Test queries" onClick={() => onModeChange('write')} />
      </div>
      <div className="mt-4">
        {tab === 'find' ? (
          <FindQueriesSection
            projectName={projectName}
            onReviewDiscoveryProbe={(discoveryProbeId) => onReviewSavedSource({ source: 'discovery', discoveryProbeId })}
          />
        ) : (
          <ResearchQueriesSection
            {...researchProps}
            onReviewForTracking={({ researchRunQueryId, scope }) => onReviewSavedSource({ source: 'research', researchRunQueryId }, scope ?? null)}
          />
        )}
      </div>
    </div>
  )
}
