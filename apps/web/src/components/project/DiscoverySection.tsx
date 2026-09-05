import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  DiscoveryBucket,
  DiscoverySessionDto,
  QueryTrackingCommitRequest,
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingPreviewResponse,
  QueryTrackingTrackedRow,
  QueryTrackingWorkspaceResponse,
  MeasurementQueryTemplate,
} from '@ainyc/canonry-contracts'

import {
  triggerDiscoveryRun,
  heyClient,
  isEmbed,
} from '../../api.js'
import {
  getApiV1ProjectsByNameDiscoverSessionsByIdOptions,
  getApiV1ProjectsByNameDiscoverSessionsOptions,
  getApiV1ProjectsByNameMeasurementQueryTemplatesOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
  getApiV1ProjectsByNameQueryTrackingQueryKey,
  getApiV1RunsQueryKey,
  postApiV1ProjectsByNameQueryTrackingCommitMutation,
  postApiV1ProjectsByNameQueryTrackingPreviewMutation,
} from '@ainyc/canonry-api-client/react-query'
import { addToast } from '../../lib/toast-store.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { Button } from '../ui/button.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { ResearchQueriesSection } from './ResearchQueriesSection.js'
import { DataTablePagination, DataTableSearch, useClientTable } from '../shared/DataTableControls.js'

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])

export type QueryWorkspace = 'tracked' | 'research'
export type ResearchWorkspaceMode = 'find' | 'test'
type PendingTrackingSource =
  | { source: 'research'; researchRunQueryId: string }
  | { source: 'discovery'; discoveryProbeId: string }

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
}: QueriesSectionProps) {
  const [uncontrolledWorkspace, setUncontrolledWorkspace] = useState<QueryWorkspace>('tracked')
  const [uncontrolledResearchMode, setUncontrolledResearchMode] = useState<ResearchWorkspaceMode>('find')
  const [pendingTrackingSource, setPendingTrackingSource] = useState<PendingTrackingSource | null>(null)
  const queryWorkspace = controlledWorkspace ?? uncontrolledWorkspace
  const researchMode = controlledResearchMode ?? uncontrolledResearchMode

  const selectWorkspace = (workspace: QueryWorkspace) => {
    if (controlledWorkspace === undefined) setUncontrolledWorkspace(workspace)
    onQueryWorkspaceChange?.(workspace)
  }
  const selectResearchMode = (mode: ResearchWorkspaceMode) => {
    if (controlledResearchMode === undefined) setUncontrolledResearchMode(mode)
    onResearchModeChange?.(mode)
  }
  const reviewSavedSource = (source: PendingTrackingSource) => {
    setPendingTrackingSource(source)
    selectWorkspace('tracked')
  }

  return (
    <section className="page-section-divider" aria-labelledby="queries-heading">
      <div className="section-head">
        <h2 id="queries-heading">Queries</h2>
      </div>
      <div className="mt-3 flex border-b border-default" role="tablist" aria-label="Query workspace">
        <WorkspaceTab active={queryWorkspace === 'tracked'} label="Tracked" onClick={() => selectWorkspace('tracked')} />
        <WorkspaceTab active={queryWorkspace === 'research'} label="Research" onClick={() => selectWorkspace('research')} />
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
          />
        ) : (
          <QueryResearchWorkspace
            projectName={projectName}
            mode={researchMode}
            onModeChange={selectResearchMode}
            onReviewSavedSource={reviewSavedSource}
          />
        )}
      </div>
    </section>
  )
}

function WorkspaceTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
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

function QueryResearchWorkspace({
  projectName,
  mode,
  onModeChange,
  onReviewSavedSource,
}: {
  projectName: string
  mode: ResearchWorkspaceMode
  onModeChange: (mode: ResearchWorkspaceMode) => void
  onReviewSavedSource: (source: PendingTrackingSource) => void
}) {
  return (
    <div>
      <div className="flex border-b border-default" role="tablist" aria-label="Research workspace">
        <WorkspaceTab active={mode === 'find'} label="Find queries" onClick={() => onModeChange('find')} />
        <WorkspaceTab active={mode === 'test'} label="Test queries" onClick={() => onModeChange('test')} />
      </div>
      <div className="mt-4">
        {mode === 'find' ? (
          <FindQueriesSection
            projectName={projectName}
            onReviewDiscoveryProbe={(discoveryProbeId) => onReviewSavedSource({ source: 'discovery', discoveryProbeId })}
          />
        ) : (
          <ResearchQueriesSection
            projectName={projectName}
            onReviewForTracking={({ researchRunQueryId }) => onReviewSavedSource({ source: 'research', researchRunQueryId })}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The generated SDK transport is attached in `TrackedQueriesSection`. Keeping
 * the presentation below transport-free makes the review boundary explicit:
 * the browser builds a requested mutation, but the server resolves duplicates,
 * class, exact diff, and next-sweep workload.
 */
function TrackedQueriesWorkspace({
  workspace,
  selection,
  onSelectionChange,
  trackingQueryId,
  onTrackingQueryIdChange,
  pendingTrackingSource,
  onPendingTrackingSourceHandled,
  templates,
  preview,
  isPreviewing,
  isCommitting,
  onPreview,
  onCommit,
}: {
  workspace: QueryTrackingWorkspaceResponse
  selection: NonNullable<QueriesSectionProps['selection']>
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
  trackingQueryId?: string
  onTrackingQueryIdChange?: QueriesSectionProps['onTrackingQueryIdChange']
  pendingTrackingSource: PendingTrackingSource | null
  onPendingTrackingSourceHandled: () => void
  templates: readonly MeasurementQueryTemplate[]
  preview: QueryTrackingPreviewResponse | null
  isPreviewing: boolean
  isCommitting: boolean
  onPreview: (mutation: QueryTrackingMutation) => void
  onCommit: (request: QueryTrackingCommitRequest) => void
}) {
  const [action, setAction] = useState<TrackingAction | null>(null)
  const [draft, setDraft] = useState<TrackingDraft>(() => defaultTrackingDraft(selection))
  const [reviewedMutation, setReviewedMutation] = useState<QueryTrackingMutation | null>(null)
  const editorHeadingRef = useRef<HTMLHeadingElement>(null)
  const rowsInScope = useMemo(() => filterTrackedRows(workspace.tracked, selection), [selection, workspace.tracked])
  const table = useClientTable({
    rows: rowsInScope,
    getSearchText: (row) => `${row.queryText} ${row.provenance?.source ?? 'legacy'} ${row.assignments.map(assignment => assignment.queryClass ?? 'unknown').join(' ')}`,
  })

  useEffect(() => {
    if (!trackingQueryId) return
    const row = workspace.tracked.find(candidate => candidate.queryId === trackingQueryId)
    if (!row) return
    setAction({ kind: 'edit', row })
    setDraft(draftForRow(row, selection))
    setReviewedMutation(null)
  }, [selection, trackingQueryId, workspace.tracked])

  useEffect(() => {
    if (!pendingTrackingSource) return
    const next = defaultTrackingDraft(selection)
    setAction({ kind: 'add' })
    setDraft(pendingTrackingSource.source === 'research'
      ? { ...next, source: 'research', researchRunQueryId: pendingTrackingSource.researchRunQueryId }
      : { ...next, source: 'discovery', discoveryProbeId: pendingTrackingSource.discoveryProbeId })
    setReviewedMutation(null)
    onPendingTrackingSourceHandled()
  }, [onPendingTrackingSourceHandled, pendingTrackingSource, selection])

  useEffect(() => {
    if (!action || action.kind === 'remove') return
    const heading = editorHeadingRef.current
    if (!heading) return
    heading.scrollIntoView?.({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [action])

  function openAdd(source: TrackingDraft['source'] = 'manual') {
    setAction({ kind: 'add' })
    setDraft({ ...defaultTrackingDraft(selection), source })
    setReviewedMutation(null)
  }

  function openEdit(row: QueryTrackingTrackedRow) {
    setAction({ kind: 'edit', row })
    setDraft(draftForRow(row, selection))
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(row.queryId)
  }

  function openRemoval(row: QueryTrackingTrackedRow) {
    setAction({ kind: 'remove', row })
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(row.queryId)
  }

  function closeAction() {
    setAction(null)
    setReviewedMutation(null)
    onTrackingQueryIdChange?.(undefined)
  }

  const mutation = action ? mutationForAction(action, draft, workspace.mode) : null
  const needsExplicitContext = action !== null
    && action.kind !== 'remove'
    && workspace.mode === 'advanced'
    && !hasMarketOnlyAudience(draft)
  const canReview = mutation !== null && (!needsExplicitContext || draft.contexts.length > 0) && !isPreviewing

  return (
    <div className="space-y-4">
      <section aria-label="Tracked queries">
        <div className="flex flex-wrap items-end gap-3">
          <TrackingScopePicker workspace={workspace} selection={selection} onSelectionChange={onSelectionChange} />
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

        {!workspace.active ? <p className="mt-3 text-sm text-caution">No published measurement yet.</p> : null}

        {table.rows.length === 0 ? (
          <p className="mt-5 text-sm text-muted">
            {table.hasQuery ? 'No tracked queries match that search.' : 'No tracked queries in this scope yet.'}
          </p>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="evidence-table min-w-[760px] table-fixed">
              <colgroup><col className="w-[42%]" /><col className="w-[22%]" /><col className="w-[10%]" /><col className="w-[9%]" /><col className="w-[10%]" /><col className="w-[7%]" /></colgroup>
              <thead>
                <tr><th>Query</th><th>Scope</th><th>Class</th><th>Source</th><th>Measurement</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {table.rows.map(row => (
                  <tr key={row.queryId}>
                    <td className="break-words font-medium text-heading">{row.queryText}</td>
                    <td className="text-secondary">{assignmentScopeLabel(row, workspace)}</td>
                    <td><AssignmentClassBadge row={row} /></td>
                    <td className="text-secondary">{provenanceLabel(row)}</td>
                    <td><MeasurementStateBadge row={row} /></td>
                    <td className="whitespace-nowrap text-right">
                      {!isEmbed() && <div className="flex justify-end gap-2">
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
          onConfirm={() => {
            onCommit({
              ...reviewedMutation,
              expectedWorkspaceVersion: preview.workspaceVersion,
              previewToken: preview.previewToken,
              reviewedAt: preview.reviewedAt,
            })
          }}
        />
      )}
    </div>
  )
}

type TrackingAction =
  | { kind: 'add' }
  | { kind: 'edit'; row: QueryTrackingTrackedRow }
  | { kind: 'remove'; row: QueryTrackingTrackedRow }

type TrackingDraft = {
  source: 'manual' | 'template' | 'research' | 'discovery'
  text: string
  templateId: string
  templateVersion: string
  template: string
  researchRunQueryId: string
  discoveryProbeId: string
  targetKeys: string[]
  groupKeys: string[]
  marketKeys: string[]
  contexts: QueryTrackingContextInput[]
  queryClass: 'auto' | 'branded' | 'non-brand'
}

function defaultTrackingDraft(selection: NonNullable<QueriesSectionProps['selection']>): TrackingDraft {
  return {
    source: 'manual', text: '', templateId: '', templateVersion: '', template: '', researchRunQueryId: '', discoveryProbeId: '',
    targetKeys: selection.measurementScope === 'property' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    groupKeys: selection.measurementScope === 'group' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    marketKeys: selection.measurementScope === 'market' && selection.measurementScopeKey ? [selection.measurementScopeKey] : [],
    contexts: [],
    queryClass: 'auto',
  }
}

function draftForRow(
  row: QueryTrackingTrackedRow,
  selection: NonNullable<QueriesSectionProps['selection']>,
): TrackingDraft {
  const assignment = row.assignments.length === 0 ? undefined : row.assignments[0]
  return {
    ...defaultTrackingDraft(selection),
    source: row.provenance?.source === 'template' ? 'template' : row.provenance?.source === 'research' ? 'research' : row.provenance?.source === 'discovery' ? 'discovery' : 'manual',
    text: row.queryText,
    templateId: row.provenance?.template?.templateId ?? '',
    templateVersion: row.provenance?.template?.templateVersion ?? '',
    template: row.provenance?.template?.template ?? '',
    researchRunQueryId: row.provenance?.source === 'research' ? row.provenance.sourceId ?? '' : '',
    discoveryProbeId: row.provenance?.source === 'discovery' ? row.provenance.sourceId ?? '' : '',
    targetKeys: assignment ? [assignment.targetKey] : [],
    groupKeys: assignment?.groupKeys ?? [],
    marketKeys: assignment?.marketKeys ?? [],
    contexts: uniqueContextInputs(row.assignments.flatMap(candidate => candidate.contexts).map(contextInput)),
    queryClass: assignment?.classificationSource === 'operator' && assignment.queryClass ? assignment.queryClass : 'auto',
  }
}

function mutationForAction(
  action: TrackingAction,
  draft: TrackingDraft,
  mode: QueryTrackingWorkspaceResponse['mode'],
): QueryTrackingMutation | null {
  if (action.kind === 'remove') return { additions: [], removals: [{ queryId: action.row.queryId }] }
  const input = sourceInputForDraft(draft)
  if (!input) return null
  const audience = audienceForDraft(draft)
  return {
    additions: [{
      input,
      ...(audience ? { audience } : {}),
      ...(mode === 'advanced' && !hasMarketOnlyAudience(draft) && draft.contexts.length > 0 ? { contexts: draft.contexts } : {}),
      ...(mode === 'advanced' && draft.queryClass !== 'auto' ? { queryClass: draft.queryClass } : {}),
    }],
    removals: action.kind === 'edit' ? [{ queryId: action.row.queryId }] : [],
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

function audienceForDraft(draft: TrackingDraft): QueryTrackingMutation['additions'][number]['audience'] | undefined {
  const audience = {
    ...(draft.targetKeys.length > 0 ? { targetKeys: draft.targetKeys } : {}),
    ...(draft.groupKeys.length > 0 ? { groupKeys: draft.groupKeys } : {}),
    ...(draft.marketKeys.length > 0 ? { marketKeys: draft.marketKeys } : {}),
  }
  return Object.keys(audience).length > 0 ? audience : undefined
}

function hasMarketOnlyAudience(draft: TrackingDraft): boolean {
  return draft.marketKeys.length > 0 && draft.targetKeys.length === 0 && draft.groupKeys.length === 0
}

function filterTrackedRows(
  rows: readonly QueryTrackingTrackedRow[],
  selection: NonNullable<QueriesSectionProps['selection']>,
): QueryTrackingTrackedRow[] {
  if (selection.measurementScope === 'project' || !selection.measurementScopeKey) return [...rows]
  return rows.filter(row => row.assignments.some(assignment => {
    if (selection.measurementScope === 'property') return assignment.targetKey === selection.measurementScopeKey
    if (selection.measurementScope === 'group') return assignment.groupKeys.includes(selection.measurementScopeKey!)
    return assignment.marketKeys.includes(selection.measurementScopeKey!)
  }))
}

function scopeValue(selection: NonNullable<QueriesSectionProps['selection']>): string {
  return selection.measurementScopeKey && selection.measurementScope !== 'project'
    ? `${selection.measurementScope}:${selection.measurementScopeKey}`
    : 'project'
}

function parseScopeValue(value: string): Record<string, unknown> {
  if (value === 'project') return { measurementScope: 'project', measurementScopeKey: undefined }
  const [measurementScope, measurementScopeKey] = value.split(':', 2)
  return { measurementScope, measurementScopeKey }
}

function TrackingScopePicker({
  workspace,
  selection,
  onSelectionChange,
}: {
  workspace: QueryTrackingWorkspaceResponse
  selection: NonNullable<QueriesSectionProps['selection']>
  onSelectionChange?: QueriesSectionProps['onSelectionChange']
}) {
  const [search, setSearch] = useState('')
  const options = useMemo(() => [
    { value: 'project', label: 'Whole site', detail: 'Project' },
    ...workspace.groups.map(group => ({ value: `group:${group.stableKey}`, label: group.label, detail: 'Group' })),
    ...workspace.markets.map(market => ({ value: `market:${market.stableKey}`, label: market.label, detail: 'Market' })),
    ...workspace.targets.map(target => ({ value: `property:${target.stableKey}`, label: target.label, detail: 'Property' })),
  ], [workspace.groups, workspace.markets, workspace.targets])
  const selectedValue = scopeValue(selection)
  const selected = options.find(option => option.value === selectedValue) ?? options[0]!
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visible = normalizedSearch
    ? options.filter(option => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(normalizedSearch))
    : options

  return (
    <div className="min-w-64 flex-1">
      <span id="tracking-scope-label" className="mb-1 block text-xs font-medium text-secondary">Measurement scope</span>
      <details onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.currentTarget.open = false
        event.currentTarget.querySelector('summary')?.focus()
      }}>
        <summary aria-labelledby="tracking-scope-label" className="flex min-h-11 cursor-pointer items-center rounded-md border border-default bg-surface px-3 text-sm text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">
          {selected.label}
        </summary>
        <div className="mt-2 border border-default bg-surface p-3">
          <label>
            <span className="sr-only">Search scopes</span>
            <input
              type="search"
              aria-label="Search scopes"
              className="h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              placeholder="Search groups, markets, properties"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          <div className="mt-2 max-h-72 overflow-y-auto">
            {visible.length === 0 ? <p className="py-3 text-sm text-secondary">No matching scopes.</p> : visible.map(option => (
              <button
                key={option.value}
                type="button"
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded px-2 text-left text-sm text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500"
                aria-label={`${option.label}, ${option.detail}`}
                aria-current={option.value === selectedValue ? 'true' : undefined}
                onClick={event => {
                  const details = event.currentTarget.closest('details')
                  if (details) details.open = false
                  onSelectionChange?.(parseScopeValue(option.value))
                }}
              >
                <span>{option.label}</span><span className="text-secondary">{option.detail}</span>
              </button>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
}

function provenanceLabel(row: QueryTrackingTrackedRow): string {
  switch (row.provenance?.source) {
    case 'manual': return 'Manual'
    case 'template': return 'Template'
    case 'research': return 'Saved research'
    case 'discovery': return 'Discovery'
    default: return 'Legacy'
  }
}

function assignmentScopeLabel(row: QueryTrackingTrackedRow, workspace: QueryTrackingWorkspaceResponse): string {
  const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
  const groupLabels = new Map(workspace.groups.map(group => [group.stableKey, group.label]))
  const marketLabels = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
  const targetKeys = new Set<string>()
  const groupKeys = new Set<string>()
  const marketKeys = new Set<string>()
  for (const assignment of row.assignments) {
    targetKeys.add(assignment.targetKey)
    assignment.groupKeys.forEach(key => groupKeys.add(key))
    assignment.marketKeys.forEach(key => marketKeys.add(key))
  }
  if (targetKeys.size === 0) return 'Whole site'
  const parts = [
    targetKeys.size === 1 ? targetLabels.get([...targetKeys][0]!) ?? [...targetKeys][0]! : `${targetKeys.size} properties`,
    groupKeys.size === 1 ? groupLabels.get([...groupKeys][0]!) ?? [...groupKeys][0]! : groupKeys.size > 1 ? `${groupKeys.size} groups` : null,
    marketKeys.size === 1 ? marketLabels.get([...marketKeys][0]!) ?? [...marketKeys][0]! : marketKeys.size > 1 ? `${marketKeys.size} markets` : null,
  ].filter((value): value is string => value !== null)
  return parts.join(' · ')
}

function AssignmentClassBadge({ row }: { row: QueryTrackingTrackedRow }) {
  const classes = [...new Set(row.assignments.map(assignment => assignment.queryClass ?? 'unknown'))]
  const value = classes.join(', ')
  return <ToneBadge tone={classes.includes('unknown') ? 'caution' : 'neutral'}>{value || 'Unknown'}</ToneBadge>
}

function MeasurementStateBadge({ row }: { row: QueryTrackingTrackedRow }) {
  return row.state === 'tracked'
    ? <ToneBadge tone="positive">Measured</ToneBadge>
    : <ToneBadge tone="caution">Awaiting sweep</ToneBadge>
}

function TrackingComposer({
  workspace,
  templates,
  action,
  draft,
  onDraftChange,
  onClose,
  canReview,
  isPreviewing,
  editorHeadingRef,
  onReview,
}: {
  workspace: QueryTrackingWorkspaceResponse
  templates: readonly MeasurementQueryTemplate[]
  action: TrackingAction
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
  onClose: () => void
  canReview: boolean
  isPreviewing: boolean
  editorHeadingRef: RefObject<HTMLHeadingElement | null>
  onReview: () => void
}) {
  if (action.kind === 'remove') {
    return (
      <Card className="surface-card">
        <div className="section-head">
          <div>
            <h3>Remove query</h3>
            <p className="mt-1 text-sm leading-6 text-secondary">Remove “{action.row.queryText}” from future tracking?</p>
            <p className="mt-1 text-xs leading-5 text-muted">Earlier results stay unchanged.</p>
          </div>
        </div>
        <ComposerActions canReview={canReview} isPreviewing={isPreviewing} onCancel={onClose} onReview={onReview} />
      </Card>
    )
  }

  const sourceLabel = action.kind === 'edit' ? 'Edit query' : 'Add query'
  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline gap-4">
        <h3 ref={editorHeadingRef} tabIndex={-1}>{sourceLabel}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <label className="block" htmlFor="tracking-query-source">
            <span className="text-xs font-medium text-secondary">Query source</span>
            <select
              id="tracking-query-source"
              className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              value={draft.source}
              onChange={(event) => onDraftChange({
                ...draft,
                source: event.target.value as TrackingDraft['source'],
                text: event.target.value === 'manual' ? draft.text : '',
              })}
            >
              <option value="manual">Manual text</option>
              <option value="template" disabled={templates.length === 0}>Saved template{templates.length === 0 ? ' (none available)' : ''}</option>
              <option value="research" disabled={workspace.savedSources.research.length === 0}>Saved research{workspace.savedSources.research.length === 0 ? ' (none available)' : ''}</option>
              <option value="discovery" disabled={workspace.savedSources.discovery.length === 0}>Discovery result{workspace.savedSources.discovery.length === 0 ? ' (none available)' : ''}</option>
            </select>
          </label>

          {draft.source === 'manual' ? (
            <label className="block" htmlFor="tracking-query-text">
              <span className="text-xs font-medium text-secondary">Query text</span>
              <textarea
                id="tracking-query-text"
                className="mt-1 min-h-28 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                placeholder="e.g. How do teams compare AEO platforms?"
                value={draft.text}
                onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
              />
            </label>
          ) : null}

          {draft.source === 'template' ? (
            <TemplateSourceField templates={templates} draft={draft} onDraftChange={onDraftChange} />
          ) : null}

          {draft.source === 'research' ? (
            <SavedSourceField
              id="tracking-research-source"
              label="Saved research query"
              value={draft.researchRunQueryId}
              options={workspace.savedSources.research.map(candidate => ({ id: candidate.researchRunQueryId, label: candidate.queryText, detail: candidate.researchRunId }))}
              onChange={(researchRunQueryId) => onDraftChange({ ...draft, researchRunQueryId })}
            />
          ) : null}

          {draft.source === 'discovery' ? (
            <SavedSourceField
              id="tracking-discovery-source"
              label="Discovery query"
              value={draft.discoveryProbeId}
              options={workspace.savedSources.discovery.map(candidate => ({ id: candidate.discoveryProbeId, label: candidate.queryText, detail: candidate.discoverySessionId }))}
              onChange={(discoveryProbeId) => onDraftChange({ ...draft, discoveryProbeId })}
            />
          ) : null}

          {workspace.mode === 'advanced' ? (
            <div className="block">
              <label className="text-xs font-medium text-secondary" htmlFor="tracking-query-class">Classification</label>
              <select
                id="tracking-query-class"
                className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                value={draft.queryClass}
                onChange={(event) => onDraftChange({ ...draft, queryClass: event.target.value as TrackingDraft['queryClass'] })}
              >
                <option value="auto">Automatic</option>
                <option value="branded">Branded</option>
                <option value="non-brand">Non-brand</option>
              </select>
            </div>
          ) : (
            <div className="rounded-md border border-default bg-surface-subtle px-3 py-2">
              <p className="text-xs font-medium text-secondary">Classification</p>
              <p className="mt-1 text-sm text-strong">Automatic</p>
            </div>
          )}
          {workspace.mode === 'advanced' && !hasMarketOnlyAudience(draft) ? (
            <TrackingContextSelector workspace={workspace} draft={draft} onDraftChange={onDraftChange} />
          ) : null}
        </div>

        <AssignmentSelector workspace={workspace} draft={draft} onDraftChange={onDraftChange} />
      </div>

      {draft.source === 'research' && (
        <p className="mt-4 rounded-md border border-default bg-surface-subtle px-3 py-2 text-sm text-secondary">
          Only the saved query is added.
        </p>
      )}
      <ComposerActions canReview={canReview} isPreviewing={isPreviewing} onCancel={onClose} onReview={onReview} />
    </Card>
  )
}

function TemplateSourceField({
  templates,
  draft,
  onDraftChange,
}: {
  templates: readonly MeasurementQueryTemplate[]
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  return (
    <label className="block" htmlFor="tracking-template-source">
      <span className="text-xs font-medium text-secondary">Saved template</span>
      <select
        id="tracking-template-source"
        className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={draft.templateId}
        onChange={(event) => {
          const template = templates.find(candidate => candidate.id === event.target.value)
          onDraftChange({
            ...draft,
            templateId: template?.id ?? '',
            templateVersion: template?.updatedAt ?? '',
            template: template?.pattern ?? '',
          })
        }}
      >
        <option value="">Choose a template</option>
        {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
      </select>
      {draft.template ? <span className="mt-1 block text-xs leading-5 text-muted">{draft.template}</span> : null}
    </label>
  )
}

function SavedSourceField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly { id: string; label: string; detail: string }[]
  onChange: (value: string) => void
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="text-xs font-medium text-secondary">{label}</span>
      <select
        id={id}
        className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a saved query</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label} · {option.detail}</option>)}
      </select>
    </label>
  )
}

function contextInput(context: QueryTrackingWorkspaceResponse['defaultContexts'][number]): QueryTrackingContextInput {
  return {
    providers: [...context.providers],
    models: { ...context.models },
    location: context.location?.label ?? null,
  }
}

function contextKey(context: QueryTrackingContextInput): string {
  return JSON.stringify({
    providers: [...context.providers].sort(),
    models: Object.fromEntries(Object.entries(context.models).sort(([left], [right]) => left.localeCompare(right))),
    location: context.location,
  })
}

function uniqueContextInputs(contexts: readonly QueryTrackingContextInput[]): QueryTrackingContextInput[] {
  return [...new Map(contexts.map(context => [contextKey(context), context])).values()]
}

function contextLabel(context: QueryTrackingContextInput): string {
  const engines = context.providers.map(provider => {
    const model = context.models[provider]
    return model ? `${provider} (${model})` : provider
  }).join(', ')
  return `${context.location ?? 'No location'} · ${engines}`
}

function TrackingContextSelector({
  workspace,
  draft,
  onDraftChange,
}: {
  workspace: QueryTrackingWorkspaceResponse
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  const options = useMemo(
    () => uniqueContextInputs([...workspace.defaultContexts.map(contextInput), ...draft.contexts]),
    [draft.contexts, workspace.defaultContexts],
  )
  const selected = draft.contexts.length === 1 ? contextKey(draft.contexts[0]!) : draft.contexts.length > 1 ? '__existing__' : ''

  return (
    <label className="block" htmlFor="tracking-query-context">
      <span className="text-xs font-medium text-secondary">Location and engines</span>
      <select
        id="tracking-query-context"
        aria-label="Location and engines"
        className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={selected}
        onChange={event => {
          const selectedContext = options.find(context => contextKey(context) === event.target.value)
          const next = event.target.value === '__existing__'
            ? draft.contexts
            : selectedContext ? [selectedContext] : []
          onDraftChange({ ...draft, contexts: next })
        }}
      >
        <option value="">Choose a location and engines</option>
        {draft.contexts.length > 1 ? <option value="__existing__">Keep {draft.contexts.length} existing contexts</option> : null}
        {options.map(context => <option key={contextKey(context)} value={contextKey(context)}>{contextLabel(context)}</option>)}
      </select>
      <span className="mt-1 block text-xs leading-5 text-secondary">
        {options.length === 0 ? 'No configured measurement context is available.' : 'Choose where this query will be measured.'}
      </span>
    </label>
  )
}

function AssignmentSelector({
  workspace,
  draft,
  onDraftChange,
}: {
  workspace: QueryTrackingWorkspaceResponse
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  const [filter, setFilter] = useState('')
  const options = useMemo(() => [
    ...workspace.targets.map(target => ({ kind: 'target' as const, key: target.stableKey, label: target.label, detail: 'Property' })),
    ...workspace.groups.map(group => ({ kind: 'group' as const, key: group.stableKey, label: group.label, detail: 'Group' })),
    ...workspace.markets.map(market => ({ kind: 'market' as const, key: market.stableKey, label: market.label, detail: 'Market' })),
  ], [workspace.groups, workspace.markets, workspace.targets])
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visible = normalizedFilter ? options.filter(option => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(normalizedFilter)) : options
  const hasAudience = draft.targetKeys.length + draft.groupKeys.length + draft.marketKeys.length > 0

  function toggle(kind: 'target' | 'group' | 'market', key: string, checked: boolean) {
    const field = kind === 'target' ? 'targetKeys' : kind === 'group' ? 'groupKeys' : 'marketKeys'
    const values = draft[field]
    onDraftChange({ ...draft, [field]: checked ? [...values, key] : values.filter(value => value !== key) })
  }

  function isChecked(kind: 'target' | 'group' | 'market', key: string): boolean {
    return (kind === 'target' ? draft.targetKeys : kind === 'group' ? draft.groupKeys : draft.marketKeys).includes(key)
  }

  return (
    <fieldset className="rounded-md border border-default bg-surface-subtle p-3">
      <legend className="px-1 text-xs font-medium text-secondary">Apply to</legend>
      <p className="text-sm leading-6 text-muted">Choose whole site, or select the Properties, Groups, and Markets this query should measure.</p>
      <label className="mt-3 flex min-h-9 items-center gap-2 rounded px-1 text-sm text-strong">
        <input
          type="checkbox"
          checked={!hasAudience}
          onChange={(event) => {
            if (event.target.checked) onDraftChange({ ...draft, targetKeys: [], groupKeys: [], marketKeys: [] })
          }}
        />
        Whole site
      </label>
      <DataTableSearch value={filter} onChange={setFilter} label="Filter assignments" placeholder="Search Properties, Groups, Markets" className="mt-3" />
      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
        {visible.length === 0 ? <p className="px-1 py-2 text-sm text-muted">No assignment matches that search.</p> : visible.map(option => (
          <label key={`${option.kind}:${option.key}`} className="flex min-h-9 items-center gap-2 rounded px-1 py-1 text-sm text-strong hover:bg-surface-hover">
            <input
              type="checkbox"
              aria-label={`${option.label}, ${option.detail}`}
              checked={isChecked(option.kind, option.key)}
              onChange={(event) => toggle(option.kind, option.key, event.target.checked)}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="text-xs text-muted">{option.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ComposerActions({
  canReview,
  isPreviewing,
  onCancel,
  onReview,
}: {
  canReview: boolean
  isPreviewing: boolean
  onCancel: () => void
  onReview: () => void
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
      <WriteButton type="button" size="sm" disabled={!canReview} onClick={onReview}>
        {isPreviewing ? 'Reviewing…' : 'Review changes'}
      </WriteButton>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      <p className="text-xs leading-5 text-muted">Publishing does not run a sweep.</p>
    </div>
  )
}

function TrackingPreview({
  preview,
  workspace,
  isCommitting,
  onConfirm,
}: {
  preview: QueryTrackingPreviewResponse
  workspace: QueryTrackingWorkspaceResponse
  isCommitting: boolean
  onConfirm: () => void
}) {
  const hasChanges = !preview.diff.noOp
  const changed = [
    { label: 'Added', rows: preview.diff.added },
    { label: 'Removed', rows: preview.diff.removed },
    { label: 'Reused', rows: preview.diff.reused },
  ].filter(group => group.rows.length > 0)
  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline gap-4">
        <div>
          <h3>{hasChanges ? 'Confirm tracked query changes' : 'No tracking changes'}</h3>
          {!hasChanges ? <p className="mt-1 text-sm leading-6 text-muted">This request leaves tracking unchanged.</p> : null}
        </div>
        <ToneBadge tone={hasChanges ? 'caution' : 'neutral'}>{hasChanges ? 'Ready to confirm' : 'No-op'}</ToneBadge>
      </div>
      {changed.length > 0 ? <div className="mt-4 space-y-4">
        {changed.map(group => <PreviewChangeList key={group.label} label={group.label} rows={group.rows} workspace={workspace} tracked={preview.tracked} />)}
      </div> : null}
      {preview.diff.unchanged.length > 0 ? <details className="mt-4 border-t border-default pt-2 text-sm text-secondary">
        <summary className="min-h-11 cursor-pointer py-3">{preview.diff.unchanged.length} unchanged {preview.diff.unchanged.length === 1 ? 'query' : 'queries'}</summary>
        <PreviewChangeList label="Unchanged" rows={preview.diff.unchanged} workspace={workspace} tracked={preview.tracked} />
      </details> : null}
      <div className="mt-4 rounded-md border border-default bg-surface-subtle px-3 py-3">
        <p className="text-sm leading-6 text-strong">
          Next sweep: {preview.workload.nextSweepProviderCalls} provider requests (+{preview.workload.addedProviderCalls}, −{preview.workload.removedProviderCalls}).
        </p>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
        <WriteButton type="button" size="sm" disabled={!hasChanges || isCommitting} onClick={onConfirm}>
          {isCommitting ? 'Confirming…' : 'Confirm changes'}
        </WriteButton>
      </div>
    </Card>
  )
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
      <p className="text-xs font-medium text-secondary">{rows.length} {label.toLocaleLowerCase()}{rows.length === 1 ? '' : 's'}</p>
      <ul className="mt-2 divide-y divide-default">
        {rows.map(row => <li key={`${label}:${row.queryId}`} className="py-2 text-sm">
          <p className="font-medium text-strong">{row.queryText}</p>
          <p className="mt-1 text-secondary">{previewRowDetail(row, tracked, workspace)}</p>
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

function TrackedQueriesSection({
  projectName,
  selection = { measurementScope: 'project', queryClass: 'all' },
  onSelectionChange,
  trackingQueryId,
  onTrackingQueryIdChange,
  pendingTrackingSource,
  onPendingTrackingSourceHandled,
}: Pick<QueriesSectionProps, 'projectName' | 'selection' | 'onSelectionChange' | 'trackingQueryId' | 'onTrackingQueryIdChange'> & {
  pendingTrackingSource: PendingTrackingSource | null
  onPendingTrackingSourceHandled: () => void
}) {
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<QueryTrackingPreviewResponse | null>(null)
  const workspaceQuery = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } }),
  })
  const templatesQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementQueryTemplatesOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 60_000,
  })
  const previewMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingPreviewMutation(),
    onSuccess: (result) => setPreview(result),
    onError: (error) => {
      setPreview(null)
      addToast({
        title: 'Could not review tracking changes',
        detail: error instanceof Error ? error.message : 'Update the draft and review it again.',
        tone: 'negative',
      })
    },
  })
  const commitMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingCommitMutation(),
    onSuccess: async (result) => {
      setPreview(null)
      onTrackingQueryIdChange?.(undefined)
      await queryClient.invalidateQueries({
        queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }),
      })
      addToast({
        title: result.committed ? 'Tracked queries updated' : 'No tracked-query change',
        detail: result.active ? `Measurement revision ${result.active.revision}.` : 'No measurement revision is published yet.',
        tone: result.committed ? 'positive' : 'neutral',
        dedupeKey: `query-tracking:commit:${projectName}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      setPreview(null)
      addToast({
        title: 'Could not confirm tracking changes',
        detail: error instanceof Error ? error.message : 'The review may be stale. Review the changes again.',
        tone: 'negative',
      })
    },
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
    <TrackedQueriesWorkspace
      workspace={workspaceQuery.data}
      selection={selection}
      onSelectionChange={onSelectionChange}
      trackingQueryId={trackingQueryId}
      onTrackingQueryIdChange={onTrackingQueryIdChange}
      pendingTrackingSource={pendingTrackingSource}
      onPendingTrackingSourceHandled={onPendingTrackingSourceHandled}
      templates={templatesQuery.data?.templates ?? []}
      preview={preview}
      isPreviewing={previewMutation.isPending}
      isCommitting={commitMutation.isPending}
      onPreview={(mutation) => previewMutation.mutate({
        client: heyClient,
        path: { name: projectName },
        body: { ...mutation, expectedWorkspaceVersion: workspaceQuery.data.workspaceVersion },
      })}
      onCommit={(request) => commitMutation.mutate({
        client: heyClient,
        path: { name: projectName },
        body: request,
      })}
    />
  )
}

export function DiscoverySection({ projectName }: { projectName: string }) {
  const [workflow, setWorkflow] = useState<'find' | 'research'>('find')

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Query discovery</p>
          <h2>Discover or research queries</h2>
        </div>
      </div>
      <div className="inline-flex rounded-md border border-default bg-surface p-1" role="tablist" aria-label="Query discovery workflow">
        <button
          type="button"
          role="tab"
          aria-selected={workflow === 'find'}
          className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${workflow === 'find' ? 'bg-bg-elevated text-heading shadow-sm' : 'text-muted hover:text-strong'}`}
          onClick={() => setWorkflow('find')}
        >
          Find queries
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workflow === 'research'}
          className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${workflow === 'research' ? 'bg-bg-elevated text-heading shadow-sm' : 'text-muted hover:text-strong'}`}
          onClick={() => setWorkflow('research')}
        >
          Research queries
        </button>
      </div>
      <div className="mt-4">
        {workflow === 'find' ? <FindQueriesSection projectName={projectName} /> : <ResearchQueriesSection projectName={projectName} />}
      </div>
    </section>
  )
}

function FindQueriesSection({
  projectName,
  onReviewDiscoveryProbe,
}: {
  projectName: string
  onReviewDiscoveryProbe?: (discoveryProbeId: string) => void
}) {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [icpDescription, setIcpDescription] = useState('')
  const [maxProbes, setMaxProbes] = useState('100')

  const sessionsQuery = useQuery({
    ...getApiV1ProjectsByNameDiscoverSessionsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: '10' },
    }),
    refetchInterval: (query) => {
      const sessions = query.state.data
      return sessions?.some(session => ACTIVE_DISCOVERY_STATUSES.has(session.status)) ? 3000 : false
    },
  })

  const sessions = sessionsQuery.data ?? []

  useEffect(() => {
    if (!selectedSessionId && sessions[0]) {
      setSelectedSessionId(sessions[0].id)
    }
  }, [selectedSessionId, sessions])

  const selectedSession = sessions.find(session => session.id === selectedSessionId) ?? null

  const detailQuery = useQuery({
    ...getApiV1ProjectsByNameDiscoverSessionsByIdOptions({
      client: heyClient,
      path: { name: projectName, id: selectedSessionId ?? '' },
    }),
    enabled: Boolean(selectedSessionId),
    refetchInterval: selectedSession && ACTIVE_DISCOVERY_STATUSES.has(selectedSession.status) ? 3000 : false,
  })

  const detail = detailQuery.data ?? null

  const startMutation = useMutation({
    mutationFn: () => {
      const body: { icpDescription?: string; maxProbes?: number } = {}
      const trimmedIcp = icpDescription.trim()
      if (trimmedIcp) body.icpDescription = trimmedIcp
      const parsedMax = Number.parseInt(maxProbes, 10)
      if (Number.isFinite(parsedMax) && parsedMax > 0) body.maxProbes = parsedMax
      return triggerDiscoveryRun(projectName, body)
    },
    onSuccess: async (result) => {
      setSelectedSessionId(result.sessionId)
      setIcpDescription('')
      await refreshDiscovery(queryClient, projectName, result.sessionId)
      addToast({
        title: 'Discovery started',
        detail: `Run ${shortId(result.sessionId)} is testing questions your customers might ask.`,
        tone: 'neutral',
        dedupeKey: `discovery:start:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Discovery failed to start',
        detail: error instanceof Error ? error.message : 'Could not start discovery.',
        tone: 'negative',
      })
    },
  })

  const activeSession = detail ?? selectedSession
  const probeRows = useMemo(() => (detail?.probes ?? []).slice(0, 30), [detail?.probes])

  async function handleRefreshSessions() {
    try {
      const result = await sessionsQuery.refetch()
      if (result.error) throw result.error
      const count = result.data?.length ?? 0
      addToast({
        title: 'Discovery sessions refreshed',
        detail: `${count} recent session${count === 1 ? '' : 's'} loaded.`,
        tone: 'positive',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      addToast({
        title: 'Discovery refresh failed',
        detail: error instanceof Error ? error.message : 'Could not reload discovery sessions.',
        tone: 'negative',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    }
  }

  return (
    <>
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Step 1</p>
          <h2>Generate and check questions</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
            {isEmbed()
              ? 'Generate customer questions and check whether your site is already visible.'
              : 'Generate customer questions, check current visibility, then choose what to track.'}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessionsQuery.isFetching}
          onClick={() => void handleRefreshSessions()}
        >
          <RefreshCw className={`size-3.5 ${sessionsQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Step 1</p>
                <h3>Describe your customer</h3>
              </div>
              <ToneBadge tone="neutral">Runs on Gemini</ToneBadge>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm text-secondary">Who is your ideal customer?</span>
                <textarea
                  className="mt-1 min-h-24 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="e.g. Small e-commerce stores that want AI-powered customer support. Leave blank to use the customer profile saved on this project."
                  value={icpDescription}
                  onChange={(event) => setIcpDescription(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-sm text-secondary">How many questions to test</span>
                <input
                  className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  inputMode="numeric"
                  value={maxProbes}
                  onChange={(event) => setMaxProbes(event.target.value)}
                />
                <span className="mt-1 block text-sm text-secondary">
                  More questions means broader coverage but a longer run. 100 is a good default.
                </span>
              </label>
              {!isEmbed() && (
                <WriteButton
                  type="button"
                  size="sm"
                  disabled={startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                >
                  <Play size={14} />
                  {startMutation.isPending ? 'Starting…' : 'Find queries'}
                </WriteButton>
              )}
            </div>
          </Card>

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">History</p>
                <h3>Recent runs</h3>
              </div>
              {sessionsQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {sessions.length === 0 ? (
              <p className="text-sm text-secondary">No discovery runs yet. Describe your customer above to start your first one.</p>
            ) : (
              <div className="space-y-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      selectedSessionId === session.id
                        ? 'border-mono-600 bg-bg-elevated/70'
                        : 'border-default bg-bg/40 hover:border-strong hover:bg-bg-elevated/40'
                    }`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-heading">{shortId(session.id)}</span>
                      <ToneBadge tone={toneForSession(session.status)}>{session.status}</ToneBadge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-secondary">
                      <span>Cited queries {session.citedCount ?? 0}</span>
                      <span>Worth tracking {session.aspirationalCount ?? 0}</span>
                      <span>Skip {session.wastedCount ?? 0}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Run detail</p>
                <h3>{activeSession ? shortId(activeSession.id) : 'No run selected'}</h3>
              </div>
              {activeSession && <ToneBadge tone={toneForSession(activeSession.status)}>{activeSession.status}</ToneBadge>}
            </div>

            {!activeSession ? (
              <p className="text-sm text-secondary">Start a run above, or pick one from Recent runs to see its progress.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <DiscoveryMetric label="Questions tested" value={activeSession.probeCount ?? 0} />
                  <DiscoveryMetric label="Cited queries" value={activeSession.citedCount ?? 0} tone="positive" />
                  <DiscoveryMetric label="Worth tracking" value={activeSession.aspirationalCount ?? 0} tone="caution" />
                  <DiscoveryMetric label="Skip" value={activeSession.wastedCount ?? 0} tone="negative" />
                </div>

                {activeSession.error && (
                  <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">
                    {activeSession.error}
                  </div>
                )}

                {activeSession.warning && (
                  <div className="rounded-md border border-caution-800/40 bg-caution-950/20 px-3 py-2 text-sm text-caution">
                    {activeSession.warning}
                  </div>
                )}

                {activeSession.icpDescription && (
                  <div className="rounded-md border border-default bg-surface px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted">Customer profile</p>
                    <p className="mt-1 text-sm text-neutral">{activeSession.icpDescription}</p>
                  </div>
                )}

                {activeSession.competitorMap.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-secondary">Sites that keep getting cited</p>
                    <div className="flex flex-wrap gap-2">
                      {activeSession.competitorMap.slice(0, 8).map(entry => (
                        <span key={entry.domain} className="rounded-md border border-default bg-bg px-2 py-1 text-xs text-neutral">
                          {entry.domain} <span className="text-muted">{entry.hits}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>

          {activeSession?.status === 'completed' && (
            <Card className="surface-card">
              <div className="section-head">
                <div>
                  <p className="eyebrow eyebrow-soft">Step 2</p>
                  <h3>Review a discovery question for tracking</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
                    Choose a Cited query or Worth tracking result below. Tracking opens with the saved discovery source, where you choose its scope and review the exact next-sweep change.
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted">Discovery remains research. This review does not add competitors or start a sweep.</p>
            </Card>
          )}

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">All results</p>
                <h3>Every question we tested</h3>
              </div>
              {detailQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {probeRows.length === 0 ? (
              <p className="text-sm text-muted">Results show up here once the run starts testing questions.</p>
            ) : (
              <div className="evidence-table-wrap">
                <table className="evidence-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Result</th>
                      <th>Sites cited</th>
                      <th><span className="sr-only">Tracking review</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {probeRows.map(probe => (
                      <tr key={probe.id}>
                        <td className="font-medium text-heading">{probe.query}</td>
                        <td>
                          <ToneBadge tone={toneForBucket(probe.bucket)}>{bucketLabel(probe.bucket)}</ToneBadge>
                        </td>
                        <td className="text-secondary">
                          {probe.citedDomains.length > 0 ? probe.citedDomains.slice(0, 3).join(', ') : '-'}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!isEmbed() && onReviewDiscoveryProbe && (probe.bucket === 'cited' || probe.bucket === 'aspirational') && (
                            <WriteButton type="button" variant="ghost" size="sm" onClick={() => onReviewDiscoveryProbe(probe.id)}>
                              Review for tracking
                            </WriteButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

function DiscoveryMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'positive' | 'caution' | 'negative' | 'neutral'
}) {
  const valueClass =
    tone === 'positive' ? 'text-positive' : tone === 'caution' ? 'text-caution' : tone === 'negative' ? 'text-negative' : 'text-heading'
  return (
    <div className="rounded-md border border-default bg-surface px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

function toneForSession(status: DiscoverySessionDto['status']) {
  if (status === 'completed') return 'positive'
  if (status === 'failed') return 'negative'
  if (ACTIVE_DISCOVERY_STATUSES.has(status)) return 'caution'
  return 'neutral'
}

function toneForBucket(bucket: DiscoveryBucket | null) {
  if (bucket === 'cited') return 'positive'
  if (bucket === 'aspirational') return 'caution'
  if (bucket === 'wasted-surface') return 'negative'
  return 'neutral'
}

const BUCKET_LABELS: Record<DiscoveryBucket, string> = {
  cited: 'Cited queries',
  aspirational: 'Worth tracking',
  'wasted-surface': 'Skip',
}

function bucketLabel(bucket: DiscoveryBucket | null): string {
  return bucket ? BUCKET_LABELS[bucket] : 'Not classified'
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

async function refreshDiscovery(
  queryClient: QueryClientLike,
  _projectName: string,
  _sessionId: string,
) {
  // Generated `<op>QueryKey` helpers produce flat keys with no shared
  // hierarchical prefix, so match every discovery op by name pattern —
  // catches the list, detail, promote-preview, and any future discovery
  // variant. Runs list uses the exact key to avoid invalidating
  // run-detail caches unnecessarily.
  await Promise.all([
    invalidateProjectQueryDomain(queryClient, 'discovery'),
    queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>
