import type {
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import type { QueriesSectionProps } from '../DiscoverySection.js'

export type TrackingAction =
  | { kind: 'add' }
  | { kind: 'edit'; row: QueryTrackingTrackedRow; audience?: QueryTrackingMutation['removals'][number]['audience']; scopeLabel: string }
  | { kind: 'remove'; row: QueryTrackingTrackedRow; audience?: QueryTrackingMutation['removals'][number]['audience']; scopeLabel: string }

export type TrackingDraft = {
  source: 'manual' | 'template' | 'research' | 'discovery'
  text: string
  templateId: string
  templateVersion: string
  template: string
  researchRunQueryId: string
  discoveryProbeId: string
  wholeSite: boolean
  targetKeys: string[]
  groupKeys: string[]
  marketKeys: string[]
  contexts: QueryTrackingContextInput[]
  queryClass: 'keep' | 'auto' | 'branded' | 'non-brand'
}

export function defaultTrackingDraft(selection: NonNullable<QueriesSectionProps['selection']>): TrackingDraft {
  return {
    source: 'manual', text: '', templateId: '', templateVersion: '', template: '', researchRunQueryId: '', discoveryProbeId: '',
    wholeSite: false,
    targetKeys: selection.measurementScope === 'property' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    groupKeys: selection.measurementScope === 'group' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    marketKeys: selection.measurementScope === 'market' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    contexts: [],
    queryClass: 'auto',
  }
}

export function draftForRow(
  row: QueryTrackingTrackedRow,
  selection: NonNullable<QueriesSectionProps['selection']>,
): TrackingDraft {
  return {
    ...defaultTrackingDraft(selection),
    text: row.queryText,
    queryClass: 'keep',
  }
}

export function mutationForAction(
  action: TrackingAction,
  draft: TrackingDraft,
  workspace: QueryTrackingWorkspaceResponse,
): QueryTrackingMutation | null {
  const advanced = workspace.mode === 'advanced'
  if (action.kind === 'remove') return { additions: [], removals: [{ queryId: action.row.queryId, ...(action.audience ? { audience: action.audience } : {}) }] }
  if (action.kind === 'edit') {
    if (!draft.text.trim()) return null
    return {
      additions: [],
      removals: [],
      edits: [{
        queryId: action.row.queryId,
        text: draft.text.trim(),
        ...(action.audience ? { audience: action.audience } : {}),
        ...(advanced && draft.queryClass !== 'keep' ? { queryClass: draft.queryClass === 'auto' ? null : draft.queryClass } : {}),
      }],
    }
  }
  const input = sourceInputForDraft(draft)
  if (!input || needsTemplateMarket(draft) || (advanced && !draft.wholeSite && draft.targetKeys.length + draft.groupKeys.length + draft.marketKeys.length === 0)) return null
  // Simple projects take no audience. Advanced ones always name it, because
  // the server reads an omitted addition audience as every location.
  const audience = advanced ? audienceForDraft(draft, workspace) : undefined
  return {
    additions: [{
      input,
      ...(audience ? { audience } : {}),
      ...(advanced && !hasMarketOnlyAudience(draft) && draft.contexts.length > 0 ? { contexts: draft.contexts } : {}),
      ...(advanced && draft.queryClass !== 'auto' && draft.queryClass !== 'keep' ? { queryClass: draft.queryClass } : {}),
    }],
    removals: [],
  }
}

function sourceInputForDraft(draft: TrackingDraft): QueryTrackingMutation['additions'][number]['input'] | null {
  if (draft.source === 'manual') return draft.text.trim() ? { source: 'manual', text: draft.text.trim() } : null
  if (draft.source === 'template') return draft.templateId && draft.templateVersion && draft.template
    ? { source: 'template', templateId: draft.templateId, templateVersion: draft.templateVersion, template: draft.template }
    : null
  if (draft.source === 'research') return draft.researchRunQueryId ? { source: 'research', researchRunQueryId: draft.researchRunQueryId } : null
  return draft.discoveryProbeId ? { source: 'discovery', discoveryProbeId: draft.discoveryProbeId } : null
}

function audienceForDraft(draft: TrackingDraft, workspace: QueryTrackingWorkspaceResponse): QueryTrackingMutation['additions'][number]['audience'] | undefined {
  if (draft.wholeSite) return { targetKeys: workspace.targets.map(target => target.stableKey) }
  const audience = {
    ...(draft.targetKeys.length > 0 ? { targetKeys: draft.targetKeys } : {}),
    ...(draft.groupKeys.length > 0 ? { groupKeys: draft.groupKeys } : {}),
    ...(draft.marketKeys.length > 0 ? { marketKeys: draft.marketKeys } : {}),
  }
  return Object.keys(audience).length > 0 ? audience : undefined
}

export function hasMarketOnlyAudience(draft: TrackingDraft): boolean {
  return draft.marketKeys.length > 0 && draft.targetKeys.length === 0 && draft.groupKeys.length === 0
}

export function needsTemplateMarket(draft: TrackingDraft): boolean {
  return draft.source === 'template' && draft.template.includes('{market}') && (draft.wholeSite || draft.marketKeys.length === 0)
}

export function audienceForSelection(selection: NonNullable<QueriesSectionProps['selection']>): QueryTrackingMutation['removals'][number]['audience'] {
  if (!selection.measurementScopeKey) return undefined
  if (selection.measurementScope === 'property') return { targetKeys: [selection.measurementScopeKey] }
  if (selection.measurementScope === 'group') return { groupKeys: [selection.measurementScopeKey] }
  if (selection.measurementScope === 'market') return { marketKeys: [selection.measurementScopeKey] }
  return undefined
}

export function selectionScopeLabel(selection: NonNullable<QueriesSectionProps['selection']>, workspace: QueryTrackingWorkspaceResponse): string {
  const collection = selection.measurementScope === 'property' ? workspace.targets : selection.measurementScope === 'group' ? workspace.groups : selection.measurementScope === 'market' ? workspace.markets : []
  const label = collection.find(scope => scope.stableKey === selection.measurementScopeKey)?.label
  if (!label) return 'Whole site'
  return selection.measurementScope === 'group' ? `${label} · Group` : selection.measurementScope === 'market' ? `${label} · Market` : label
}

export function scopeValue(selection: NonNullable<QueriesSectionProps['selection']>): string {
  return selection.measurementScopeKey && selection.measurementScope !== 'project'
    ? `${selection.measurementScope}:${selection.measurementScopeKey}`
    : 'project'
}
