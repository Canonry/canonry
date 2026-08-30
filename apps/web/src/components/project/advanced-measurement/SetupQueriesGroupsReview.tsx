import { useEffect, useState } from 'react'
import { normalizeQueryText } from '@ainyc/canonry-contracts'

import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

export type AdvancedMeasurementAccess = 'editor' | 'viewer'

export type AdvancedMeasurementAvailability =
  | { status: 'available' }
  | { status: 'unavailable'; message: string }

export interface AdvancedMeasurementProperty {
  id: string
  label: string
  urlCount?: number
}

export type AdvancedMeasurementQuerySource =
  | 'saved-project-queries'
  | 'query-sets'
  | 'generated-drafts-from-templates'
  | 'unavailable-tracked-query'

export type AdvancedMeasurementQueryState = 'available' | 'missing'

export interface AdvancedMeasurementQuery {
  id: string
  text?: string
  source?: AdvancedMeasurementQuerySource
  state?: AdvancedMeasurementQueryState
  sourceDetail?: string
  /** Retained while callers migrate. This is intentionally not shown in the setup UI. */
  assignmentClass?: 'branded' | 'non-brand'
  propertyIds?: readonly string[]
}

export interface AdvancedMeasurementApplySelection {
  queryIds: readonly string[]
  propertyIds: readonly string[]
  groupIds?: readonly string[]
}

/** A group is an assignment shortcut. Published assignments still name Properties. */
export type AdvancedMeasurementAudience =
  | { kind: 'all' }
  | { kind: 'groups'; groupIds: readonly string[] }
  | { kind: 'specific'; propertyIds: readonly string[] }

export interface AdvancedMeasurementAssignmentImpact {
  assignmentCount: number
  addedAssignments: number
  alreadyPresentAssignments: number
  resolvedPropertyCount: number
  overlapCount: number
  addedProviderCalls: number
  fullRunProviderCalls: number
}

export interface AdvancedMeasurementReplaceAssignmentsSelection {
  queryId: string
  propertyIds: readonly string[]
}

export interface AdvancedMeasurementQueryTextEditor {
  originalValue: string
  value: string
  assignedPropertyLabels: readonly string[]
  isSaving?: boolean
  isDisabled?: boolean
  onValueChange: (value: string) => void
  onSave: () => void | Promise<void>
}

export interface AdvancedMeasurementQueriesStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  properties: readonly AdvancedMeasurementProperty[]
  queries: readonly AdvancedMeasurementQuery[]
  selectedQueryIds: readonly string[]
  isApplying?: boolean
  isBusy?: boolean
  canContinue?: boolean
  onSelectedQueryIdsChange: (queryIds: readonly string[]) => void
  onApplySelectedQueries: (selection: AdvancedMeasurementApplySelection) => void | Promise<void>
  onClearQueryAssignments?: (queryId: string) => void | Promise<void>
  /** Compatibility fallback for callers that have not split clearing from removal yet. */
  onRemoveQuery: (queryId: string) => void | Promise<void>
  /**
   * Adds new tracked queries to the project from inside setup. Without this the
   * step can only consume queries that already exist, which sends a first-time
   * operator out of the wizard to create them and back again.
   */
  onCreateQueries?: (texts: readonly string[]) => void | Promise<unknown>
  /** Writes one query per Property and assigns each to the Property it names. */
  onCreateAndPairQuestions?: (pairs: readonly { propertyId: string; text: string }[]) => void | Promise<void>
  isCreatingQueries?: boolean
  createQueriesError?: string | null
  /** Opens the project's normal query-management surface for anything setup does not cover. */
  onManageProjectQueries?: () => void
  groups: readonly AdvancedMeasurementGroup[]
  audience: AdvancedMeasurementAudience
  onAudienceChange: (audience: AdvancedMeasurementAudience) => void
  assignmentImpact?: AdvancedMeasurementAssignmentImpact | null
  isPreviewingAssignmentImpact?: boolean
  assignmentImpactError?: string | null
  onRetryAssignmentImpact?: () => void
  assignmentNotice?: string | null
  /** Edits the selected saved query through the draft-scoped replacement action. */
  queryEditor?: AdvancedMeasurementQueryTextEditor
  onEditQuery?: (queryId: string) => void
  onReplaceAssignments?: (selection: AdvancedMeasurementReplaceAssignmentsSelection) => void | Promise<void>
  isReplacingAssignments?: boolean
  onBack?: () => void
  onContinue: () => void
}

export interface AdvancedMeasurementGroup {
  id: string
  name: string
  propertyIds: readonly string[]
  competitors: readonly string[]
}

export interface AdvancedMeasurementGroupDraft {
  name: string
  propertyIds: readonly string[]
  competitorDomains: string
}

export type AdvancedMeasurementGroupMembershipStatus =
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'invalid'
  | 'duplicate'
  | 'proposed'
  | 'excluded'

export interface AdvancedMeasurementGroupMembershipRow {
  dataRow: number
  property: string
  group: string
  url?: string | null
  status: AdvancedMeasurementGroupMembershipStatus
  reason?: string
  duplicateOfRow?: number
  candidateTargetKeys?: readonly string[]
  candidateGroupKeys?: readonly string[]
  groupKeyConflict?: {
    proposedGroupKey: string
    evidence: readonly { source: string; stableKey: string }[]
  }
}

export interface AdvancedMeasurementGroupMembershipPreview {
  draftEtag: string
  sourceChecksum: string
  previewChecksum: string
  rows: readonly AdvancedMeasurementGroupMembershipRow[]
  groupChanges: readonly {
    groupKey: string
    label: string
    action: 'create' | 'extend'
    targetKeys: readonly string[]
    addedTargetKeys: readonly string[]
    unchangedTargetKeys: readonly string[]
  }[]
  counts: {
    dataRows: number
    matchedRows: number
    needsAttention: number
    groupsReady: number
  }
}

export interface AdvancedMeasurementGroupImport {
  csv: string
  preview: AdvancedMeasurementGroupMembershipPreview | null
  isReviewing?: boolean
  isApplying?: boolean
  error?: string | null
  notice?: string | null
  onCsvChange: (csv: string) => void
  onReview: () => void | Promise<void>
  onApply: (acceptedRows: readonly number[]) => void | Promise<void>
}

export interface AdvancedMeasurementGroupsStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  properties: readonly AdvancedMeasurementProperty[]
  groups: readonly AdvancedMeasurementGroup[]
  groupDraft: AdvancedMeasurementGroupDraft
  isSaving?: boolean
  onGroupDraftChange: (draft: AdvancedMeasurementGroupDraft) => void
  onSaveGroup: (draft: AdvancedMeasurementGroupDraft) => void | Promise<void>
  onEditGroup?: (group: AdvancedMeasurementGroup) => void
  onRemoveGroup?: (groupId: string) => void | Promise<void>
  onClearGroupDraft?: () => void
  membershipImport?: AdvancedMeasurementGroupImport
  /** Compatibility-only. The UI has a single continuation action. */
  onSkipGroups?: () => void
  onBack?: () => void
  onContinue: () => void
}

export interface AdvancedMeasurementReviewCounts {
  properties: number
  queries: number
  groups: number
  assignments?: number
  providerCalls?: number
}

export interface AdvancedMeasurementFlaggedException {
  id: string
  title: string
  detail?: string
  tone?: 'caution' | 'negative' | 'neutral'
}

export interface AdvancedMeasurementSitemapReviewItem {
  url: string
  reason: string
}

export interface AdvancedMeasurementCoverageReviewItem {
  property: string
  savedUrls: readonly string[]
  currentSitemapUrls: readonly string[]
}

export interface AdvancedMeasurementReviewedChanges {
  title: string
  items: readonly string[]
}

export interface AdvancedMeasurementReviewStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  counts: AdvancedMeasurementReviewCounts
  flaggedExceptions: readonly AdvancedMeasurementFlaggedException[]
  sitemapReview?: {
    exceptionCount: number
    coverageReviewCount: number
    coverageResolution: 'keep-existing' | 'replace-with-imported'
    items?: readonly AdvancedMeasurementSitemapReviewItem[]
    coverageItems?: readonly AdvancedMeasurementCoverageReviewItem[]
    onCoverageResolutionChange: (resolution: 'keep-existing' | 'replace-with-imported') => void
    onResolve: () => void | Promise<void>
  }
  onBack?: () => void
  onReviewChanges?: () => void | Promise<void>
  isReviewing?: boolean
  canReviewChanges?: boolean
  reviewedChanges?: AdvancedMeasurementReviewedChanges | null
  reviewChangesError?: string | null
  canPublish: boolean
  isPublishing?: boolean
  onPublish: () => void | Promise<void>
}

const INITIAL_REVIEW_ITEM_LIMIT = 20
const REVIEW_ITEM_PAGE_SIZE = 50

const PROPERTY_CHECKLIST_PAGE_SIZE = 50
const QUERY_LIST_PAGE_SIZE = 50

function isViewer(access: AdvancedMeasurementAccess | undefined): boolean {
  return access === 'viewer'
}

function isUnavailable(availability: AdvancedMeasurementAvailability | undefined): availability is Extract<AdvancedMeasurementAvailability, { status: 'unavailable' }> {
  return availability?.status === 'unavailable'
}

function changeSelection(values: readonly string[], value: string, checked: boolean): string[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value]
  return values.filter(item => item !== value)
}

function propertyNames(ids: readonly string[], properties: readonly AdvancedMeasurementProperty[]): string {
  const labels = new Map(properties.map(property => [property.id, property.label]))
  const names = ids.map(id => labels.get(id)).filter((name): name is string => Boolean(name))
  if (names.length === 0) return 'Not applied'
  return names.length > 3 ? `${names.length} Properties` : names.join(', ')
}

function selectedAudiencePropertyIds(
  audience: AdvancedMeasurementAudience,
  properties: readonly AdvancedMeasurementProperty[],
  groups: readonly AdvancedMeasurementGroup[],
): string[] {
  if (audience.kind === 'all') return properties.map(property => property.id)
  if (audience.kind === 'specific') return properties
    .filter(property => audience.propertyIds.includes(property.id))
    .map(property => property.id)

  const selectedGroups = new Set(audience.groupIds)
  const selectedProperties = new Set(groups
    .filter(group => selectedGroups.has(group.id))
    .flatMap(group => group.propertyIds))
  return properties.filter(property => selectedProperties.has(property.id)).map(property => property.id)
}

function audienceLabel(
  audience: AdvancedMeasurementAudience,
  groups: readonly AdvancedMeasurementGroup[],
  propertyCount: number,
): string {
  if (audience.kind === 'all') return `all ${propertyCount} ${propertyCount === 1 ? 'Property' : 'Properties'}`
  if (audience.kind === 'specific') return propertyCount === 1 ? '1 Property' : `${propertyCount} Properties`
  const labels = audience.groupIds
    .map(id => groups.find(group => group.id === id)?.name)
    .filter((label): label is string => Boolean(label))
  return labels.length === 0 ? 'selected groups' : labels.join(' + ')
}

function audienceOptionLabel(group: AdvancedMeasurementGroup, properties: readonly AdvancedMeasurementProperty[]): string {
  const known = new Set(properties.map(property => property.id))
  const count = group.propertyIds.filter(id => known.has(id)).length
  return `${group.name} · ${count === 1 ? '1 Property' : `${count} Properties`}`
}

function membershipTone(status: AdvancedMeasurementGroupMembershipStatus): 'positive' | 'caution' | 'negative' | 'neutral' {
  if (status === 'matched') return 'positive'
  if (status === 'duplicate') return 'neutral'
  if (status === 'ambiguous' || status === 'proposed' || status === 'excluded') return 'caution'
  return 'negative'
}

function membershipLabel(status: AdvancedMeasurementGroupMembershipStatus): string {
  if (status === 'matched') return 'Matched'
  if (status === 'duplicate') return 'Duplicate'
  if (status === 'ambiguous') return 'Ambiguous'
  if (status === 'proposed') return 'Property needs review'
  if (status === 'excluded') return 'Property excluded'
  if (status === 'invalid') return 'Invalid row'
  return 'Not matched'
}

function membershipMessage(row: AdvancedMeasurementGroupMembershipRow): string | null {
  if (row.status === 'duplicate' && row.duplicateOfRow) return `Duplicates row ${row.duplicateOfRow}.`
  if (row.status === 'matched') return null
  if (row.reason === 'group-label-ambiguous') return `More than one group matches “${row.group}”. Rename duplicate groups, then preview again.`
  if (row.status === 'ambiguous') return 'More than one Property matches this row. Add an exact URL to choose one.'
  if (row.status === 'unmatched') return 'No included Property matches this row.'
  if (row.reason === 'group-key-conflict') return `The group name “${row.group}” conflicts with an existing setup identity. Rename the group, then preview again.`
  if (row.status === 'invalid') return 'Check the Property, group, and optional URL fields.'
  if (row.status === 'proposed') return 'Review this proposed Property before importing it.'
  if (row.status === 'excluded') return 'Include this Property before importing it.'
  return row.reason ?? null
}

function isMissingQuery(query: AdvancedMeasurementQuery): boolean {
  return query.state === 'missing' || query.source === 'unavailable-tracked-query' || !query.source
}

function queryLabel(query: AdvancedMeasurementQuery): string {
  return isMissingQuery(query) ? 'Unavailable tracked query' : query.text?.trim() || 'Unavailable tracked query'
}

function PropertyChecklist({
  properties,
  selectedPropertyIds,
  onSelectedPropertyIdsChange,
  legend,
  showBulkActions = true,
}: {
  properties: readonly AdvancedMeasurementProperty[]
  selectedPropertyIds: readonly string[]
  onSelectedPropertyIdsChange: (propertyIds: readonly string[]) => void
  legend: string
  showBulkActions?: boolean
}) {
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredProperties = normalizedSearch
    ? properties.filter(property => property.label.toLocaleLowerCase().includes(normalizedSearch))
    : properties
  const visibleProperties = showAll ? filteredProperties : filteredProperties.slice(0, PROPERTY_CHECKLIST_PAGE_SIZE)
  const hasHiddenProperties = visibleProperties.length < filteredProperties.length

  function selectAllShown(): void {
    const selected = new Set([...selectedPropertyIds, ...visibleProperties.map(property => property.id)])
    onSelectedPropertyIdsChange(properties.filter(property => selected.has(property.id)).map(property => property.id))
  }

  return (
    <fieldset>
      <legend className="text-sm font-medium text-heading">{legend}</legend>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <label className="block min-w-48 flex-1">
          <span className="text-sm font-medium text-heading">Search Properties</span>
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
            className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400"
          />
        </label>
        {showBulkActions ? <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={visibleProperties.length === 0} onClick={selectAllShown}>Select all shown</Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={selectedPropertyIds.length === 0} onClick={() => onSelectedPropertyIdsChange([])}>Clear selection</Button>
        </div> : null}
      </div>

      {filteredProperties.length === 0 ? <p className="mt-3 text-sm text-secondary">No Properties match this search.</p> : (
        <>
          <p className="mt-3 text-sm text-secondary">Showing {visibleProperties.length} of {filteredProperties.length} Properties</p>
          <div className="mt-2 max-h-96 divide-y divide-default overflow-y-auto border-y border-default">
            {visibleProperties.map(property => {
              const selected = selectedPropertyIds.includes(property.id)
              return (
                <label key={property.id} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 py-2 text-sm text-primary">
                  <span className="flex items-center gap-3">
                    <input
                      aria-label={`Select ${property.label}`}
                      checked={selected}
                      type="checkbox"
                      onChange={event => onSelectedPropertyIdsChange(changeSelection(selectedPropertyIds, property.id, event.currentTarget.checked))}
                    />
                    <span>{property.label}</span>
                  </span>
                  {property.urlCount === undefined ? null : <span className="tabular-nums text-secondary">{property.urlCount} URLs</span>}
                </label>
              )
            })}
          </div>
          {hasHiddenProperties ? <Button type="button" size="sm" variant="outline" className="mt-3 min-h-11" onClick={() => setShowAll(true)}>Show all Properties</Button> : null}
        </>
      )}
    </fieldset>
  )
}

function ViewerNotice() {
  return <div className="flex items-center gap-2 text-sm text-secondary"><ToneBadge tone="neutral">Viewer access</ToneBadge><span>You can inspect this setup.</span></div>
}

function UnavailableState({ message }: { message: string }) {
  return (
    <div role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-4 text-sm text-caution">
      <div className="flex items-center gap-2"><ToneBadge tone="caution">Unavailable</ToneBadge><h4 className="font-medium">Measurement setup unavailable</h4></div>
      <p className="mt-2 max-w-2xl text-secondary">{message}</p>
    </div>
  )
}

function GroupMembershipImportPanel({ value }: { value: AdvancedMeasurementGroupImport }) {
  const [rowPage, setRowPage] = useState(0)
  const [attentionPage, setAttentionPage] = useState(0)
  const [acknowledgedPreview, setAcknowledgedPreview] = useState<string | null>(null)
  const preview = value.preview
  const attentionCount = preview?.counts.needsAttention ?? 0
  const matchedRows = preview?.rows.filter(row => row.status === 'matched') ?? []
  const previewRows = preview?.rows ?? []
  const attentionRows = previewRows.filter(row => row.status !== 'matched')
  const rowPageCount = Math.max(1, Math.ceil(previewRows.length / REVIEW_ITEM_PAGE_SIZE))
  const shownRowPage = Math.min(rowPage, rowPageCount - 1)
  const shownRows = previewRows.slice(shownRowPage * REVIEW_ITEM_PAGE_SIZE, (shownRowPage + 1) * REVIEW_ITEM_PAGE_SIZE)
  const attentionPageCount = Math.max(1, Math.ceil(attentionRows.length / REVIEW_ITEM_PAGE_SIZE))
  const shownAttentionPage = Math.min(attentionPage, attentionPageCount - 1)
  const shownAttentionRows = attentionRows.slice(shownAttentionPage * REVIEW_ITEM_PAGE_SIZE, (shownAttentionPage + 1) * REVIEW_ITEM_PAGE_SIZE)
  const canReview = value.csv.trim().length > 0 && !value.isReviewing && !value.isApplying
  const canApply = matchedRows.length > 0 && !value.isApplying
  const skippedRowsAcknowledged = preview !== null && acknowledgedPreview === preview.previewChecksum
  const reviewedAllAttentionRows = attentionRows.length > 0 && shownAttentionPage === attentionPageCount - 1

  useEffect(() => {
    setRowPage(0)
    setAttentionPage(0)
    setAcknowledgedPreview(null)
  }, [preview?.previewChecksum])

  async function readCsvFile(file: File | undefined): Promise<void> {
    if (!file) return
    try {
      value.onCsvChange(await file.text())
    } catch {
      // File.text() is the only browser read here. The controlled textarea keeps
      // the prior input intact if the browser refuses the read.
    }
  }

  return (
    <section aria-labelledby="advanced-measurement-group-import-title" className="border-y border-default py-4">
      <div className="max-w-2xl">
        <h4 id="advanced-measurement-group-import-title" className="text-sm font-medium text-heading">Import groups from CSV</h4>
        <p className="mt-1 text-sm text-secondary">Import market membership once instead of selecting the same Properties for every group.</p>
      </div>
      <div className="mt-3 space-y-3">
        <label className="block max-w-xl">
          <span className="text-sm font-medium text-heading">CSV file</span>
          <input
            aria-label="Group membership CSV file"
            type="file"
            accept=".csv,text/csv"
            disabled={value.isReviewing || value.isApplying}
            onChange={event => { void readCsvFile(event.currentTarget.files?.[0]) }}
            className="mt-1 block min-h-11 w-full text-sm text-secondary file:mr-3 file:min-h-11 file:rounded-md file:border file:border-default file:bg-surface file:px-3 file:text-sm file:font-medium file:text-primary"
          />
        </label>
        <label className="block max-w-xl">
          <span className="text-sm font-medium text-heading">Or paste CSV</span>
          <textarea
            aria-label="Group membership CSV"
            rows={5}
            value={value.csv}
            disabled={value.isReviewing || value.isApplying}
            onChange={event => value.onCsvChange(event.currentTarget.value)}
            placeholder={'property,group,url\nHarbor House,Dallas,https://example.com/harbor-house'}
            className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={!canReview} onClick={() => { void value.onReview() }}>
            {value.isReviewing ? 'Reviewing CSV…' : 'Review CSV'}
          </Button>
          <span className="text-sm text-secondary">Use columns named property and group. URL is optional.</span>
        </div>
        {value.error ? <p role="alert" className="text-sm text-negative">{value.error}</p> : null}
        {value.notice ? <p role="status" className="text-sm text-secondary">{value.notice}</p> : null}
      </div>

      {preview ? (
        <div className="mt-4 border-t border-default pt-4" aria-live="polite">
          <h5 className="text-sm font-medium text-heading">Review group membership</h5>
          <p className="mt-1 text-sm text-secondary">
            {preview.counts.matchedRows} matched · {preview.counts.groupsReady} group{preview.counts.groupsReady === 1 ? '' : 's'} ready
            {attentionCount > 0 ? ` · ${attentionCount} need${attentionCount === 1 ? 's' : ''} attention` : ''}
          </p>
          {preview.groupChanges.length > 0 ? (
            <div className="mt-3 overflow-x-auto border-y border-default">
              <table className="evidence-table min-w-[620px]">
                <caption className="sr-only">Groups and memberships ready to apply</caption>
                <thead><tr><th>Group</th><th>Change</th><th>Properties</th><th>New memberships</th></tr></thead>
                <tbody>
                  {preview.groupChanges.map(change => (
                    <tr key={change.groupKey}>
                      <td className="font-medium text-heading">{change.label}</td>
                      <td className="text-secondary">{change.action === 'create' ? 'Create group' : 'Add to existing group'}</td>
                      <td className="tabular-nums text-secondary">{change.targetKeys.length}</td>
                      <td className="tabular-nums text-secondary">{change.addedTargetKeys.length}{change.unchangedTargetKeys.length > 0 ? ` · ${change.unchangedTargetKeys.length} already members` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {preview.rows.length > 0 ? (
            <details className="mt-3 border-y border-default py-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Review CSV rows ({preview.counts.dataRows})</summary>
              <div className="mt-3 overflow-x-auto border-y border-default">
                <table className="evidence-table min-w-[620px]">
                  <caption className="sr-only">CSV group membership review</caption>
                  <thead><tr><th>Row</th><th>Property</th><th>Group</th><th>Status</th></tr></thead>
                  <tbody>
                    {shownRows.map(row => (
                      <tr key={row.dataRow}>
                        <td className="tabular-nums text-secondary">{row.dataRow}</td>
                        <td className="text-heading">{row.property}</td>
                        <td className="text-secondary">{row.group}</td>
                        <td>
                          <ToneBadge tone={membershipTone(row.status)}>{membershipLabel(row.status)}</ToneBadge>
                          {membershipMessage(row) ? <p className="mt-1 text-sm text-secondary">{membershipMessage(row)}</p> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-secondary">
                <span>Page {shownRowPage + 1} of {rowPageCount} · {preview.rows.length} rows</span>
                <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={shownRowPage === 0} onClick={() => setRowPage(page => Math.max(0, page - 1))}>Previous 50 rows</Button>
                <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={shownRowPage === rowPageCount - 1} onClick={() => setRowPage(page => Math.min(rowPageCount - 1, page + 1))}>Next 50 rows</Button>
              </div>
            </details>
          ) : null}
          {attentionCount > 0 ? (
            <details className="mt-3 border-y border-caution-800/30 py-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Fix {attentionCount} row{attentionCount === 1 ? '' : 's'} before applying</summary>
              <p className="mt-2 text-sm text-secondary">Correct these rows, or explicitly continue with only the reviewed matches. Rows needing attention are not added.</p>
              <div className="mt-3 overflow-x-auto border-y border-default">
                <table className="evidence-table min-w-[620px]">
                  <caption className="sr-only">CSV rows that need attention</caption>
                  <thead><tr><th>Row</th><th>Property</th><th>Group</th><th>Issue</th></tr></thead>
                  <tbody>
                    {shownAttentionRows.map(row => (
                      <tr key={row.dataRow}>
                        <td className="tabular-nums text-secondary">{row.dataRow}</td>
                        <td className="text-heading">{row.property}</td>
                        <td className="text-secondary">{row.group}</td>
                        <td><ToneBadge tone={membershipTone(row.status)}>{membershipLabel(row.status)}</ToneBadge>{membershipMessage(row) ? <p className="mt-1 text-sm text-secondary">{membershipMessage(row)}</p> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-secondary">
                <span>Exception page {shownAttentionPage + 1} of {attentionPageCount}</span>
                <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={shownAttentionPage === 0} onClick={() => setAttentionPage(page => Math.max(0, page - 1))}>Previous 50 exceptions</Button>
                <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={shownAttentionPage === attentionPageCount - 1} onClick={() => setAttentionPage(page => Math.min(attentionPageCount - 1, page + 1))}>Review next 50 exceptions</Button>
              </div>
              <label className="mt-3 flex min-h-11 max-w-xl items-center gap-3 text-sm text-heading">
                <input
                  type="checkbox"
                  checked={skippedRowsAcknowledged}
                  disabled={value.isApplying || !reviewedAllAttentionRows}
                  onChange={event => setAcknowledgedPreview(event.currentTarget.checked ? preview.previewChecksum : null)}
                  className="size-4 rounded border-default"
                />
                I reviewed the exceptions and understand that {attentionCount} row{attentionCount === 1 ? '' : 's'} will be skipped.
              </label>
              <Button type="button" size="sm" variant="outline" className="mt-3 min-h-11" disabled={!canApply || !skippedRowsAcknowledged} onClick={() => { void value.onApply(matchedRows.map(row => row.dataRow)) }}>
                {value.isApplying ? 'Applying groups…' : `Apply ${matchedRows.length} matched row${matchedRows.length === 1 ? '' : 's'}`}
              </Button>
            </details>
          ) : (
            <Button type="button" className="mt-3 min-h-11" disabled={!canApply} onClick={() => { void value.onApply(matchedRows.map(row => row.dataRow)) }}>
              {value.isApplying ? 'Creating groups…' : `Create ${preview.counts.groupsReady} group${preview.counts.groupsReady === 1 ? '' : 's'} with ${matchedRows.length} membership${matchedRows.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  )
}

const EM_DASH = '\u2014'

export function AdvancedMeasurementQueriesStep({
  access,
  availability,
  properties,
  queries,
  selectedQueryIds,
  isApplying = false,
  isBusy = false,
  canContinue = true,
  onSelectedQueryIdsChange,
  onApplySelectedQueries,
  onClearQueryAssignments,
  onRemoveQuery,
  onCreateQueries,
  onCreateAndPairQuestions,
  isCreatingQueries = false,
  createQueriesError = null,
  onManageProjectQueries,
  groups,
  audience,
  onAudienceChange,
  assignmentImpact = null,
  isPreviewingAssignmentImpact = false,
  assignmentImpactError = null,
  onRetryAssignmentImpact,
  assignmentNotice = null,
  queryEditor,
  onEditQuery,
  onReplaceAssignments,
  isReplacingAssignments = false,
  onBack,
  onContinue,
}: AdvancedMeasurementQueriesStepProps) {
  const [querySearch, setQuerySearch] = useState('')
  const [showAllQueries, setShowAllQueries] = useState(false)
  const [showUnappliedOnly, setShowUnappliedOnly] = useState(false)
  const [newQueriesText, setNewQueriesText] = useState('')
  const [patternText, setPatternText] = useState('')
  const [replacement, setReplacement] = useState<{ queryId: string; propertyIds: string[] } | null>(null)
  if (isUnavailable(availability)) {
    return <section aria-label="Queries"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const activeAudience = audience
  const updateAudience = onAudienceChange
  const resolvedAudiencePropertyIds = selectedAudiencePropertyIds(activeAudience, properties, groups)
  const selectedPropertyCount = resolvedAudiencePropertyIds.length
  const canApply = selectedPropertyCount > 0
    && selectedQueryIds.length > 0
    && !isApplying
    && !isBusy
    && !isPreviewingAssignmentImpact
    && assignmentImpact !== null
    && assignmentImpactError === null
  const clearAssignments = onClearQueryAssignments ?? onRemoveQuery
  const normalizedQuerySearch = querySearch.trim().toLocaleLowerCase()
  const filteredQueries = normalizedQuerySearch
    ? queries.filter(query => queryLabel(query).toLocaleLowerCase().includes(normalizedQuerySearch))
    : queries
  const unappliedQueries = filteredQueries.filter(query => (query.propertyIds?.length ?? 0) === 0)
  const listedQueries = showUnappliedOnly ? unappliedQueries : filteredQueries
  const visibleQueries = showAllQueries ? listedQueries : listedQueries.slice(0, QUERY_LIST_PAGE_SIZE)

  const selectableVisibleQueries = visibleQueries.filter(query => !isMissingQuery(query))
  const parsedNewQueries = [...new Set(
    newQueriesText.split('\n').map(line => line.trim()).filter(Boolean),
  )]
  // One pattern, one query per selected Property. This is the portfolio
  // shape: nobody types "apartments near Harbor Point" two hundred times, and
  // typing two hundred generic queries measures the portfolio rather than the
  // Properties in it.
  const patternPlaceholders = [...patternText.matchAll(/\{([a-z][\w-]*)\}/gi)].map(match => match[1]!)
  const patternTargets = properties.filter(property => resolvedAudiencePropertyIds.includes(property.id))
  // Each expansion stays tied to the Property it was written for, so it can be
  // assigned to that Property alone. Dropping the pairing here is what forced
  // the caller into a cross product.
  const patternPairs = patternPlaceholders.length === 0 || patternText.trim() === ''
    ? []
    : patternTargets.map(property => ({
      propertyId: property.id,
      text: patternPlaceholders.reduce(
        (text, name) => text.replaceAll(`{${name}}`, property.label),
        patternText.trim(),
      ),
    }))
  const patternExpansions = [...new Set(patternPairs.map(pair => pair.text))]

  function selectAllShownQueries(): void {
    const selected = new Set([...selectedQueryIds, ...selectableVisibleQueries.map(query => query.id)])
    onSelectedQueryIdsChange(queries.filter(query => selected.has(query.id)).map(query => query.id))
  }

  return (
    <section aria-labelledby="advanced-measurement-queries-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-queries-title">Queries</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Choose queries, then apply them to Properties.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {viewer || !queryEditor ? null : (
        <section aria-label="Edit query" className="border-y border-default py-4">
          <label className="block max-w-2xl">
            <span className="text-sm font-medium text-heading">Query text</span>
            <input
              aria-label="Query text"
              className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none focus:border-strong focus:ring-2 focus:ring-mono-400"
              disabled={isBusy || queryEditor.isSaving || queryEditor.isDisabled}
              value={queryEditor.value}
              onChange={event => queryEditor.onValueChange(event.currentTarget.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
              <p>{queryEditor.assignedPropertyLabels.length === 1
                ? '1 Property assigned'
                : `${queryEditor.assignedPropertyLabels.length} Properties assigned`}</p>
              {queryEditor.assignedPropertyLabels.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-link outline-none focus-visible:ring-2 focus-visible:ring-mono-400">View assigned Properties</summary>
                  <ul className="mt-2 space-y-1">
                    {queryEditor.assignedPropertyLabels.map(label => <li key={label}>{label}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={isBusy
                || queryEditor.isSaving
                || queryEditor.isDisabled
                || queryEditor.value.trim().length === 0
                || normalizeQueryText(queryEditor.value) === normalizeQueryText(queryEditor.originalValue)}
              onClick={() => { void Promise.resolve(queryEditor.onSave()) }}
            >
              {queryEditor.isSaving ? 'Saving…' : 'Save to draft'}
            </Button>
          </div>
        </section>
      )}

      {viewer ? null : (
        <fieldset className="border-y border-default py-4">
          <legend className="text-sm font-medium text-heading">Apply to</legend>
          <div className="mt-3 max-w-xl">
            <label className="block">
              <span className="sr-only">Apply to</span>
              <select
                aria-label="Apply to"
                value={activeAudience.kind === 'all'
                  ? 'all'
                  : activeAudience.kind === 'specific'
                    ? 'specific'
                    : `group:${activeAudience.groupIds[0] ?? ''}`}
                onChange={event => {
                  const value = event.currentTarget.value
                  if (value === 'all') updateAudience({ kind: 'all' })
                  else if (value === 'specific') {
                    updateAudience({ kind: 'specific', propertyIds: [] })
                  }
                  else if (value.startsWith('group:')) updateAudience({ kind: 'groups', groupIds: [value.slice('group:'.length)] })
                }}
                className="block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none focus:border-strong focus:ring-2 focus:ring-mono-400"
              >
                <option value="all">All Properties · {properties.length}</option>
                {groups.length > 0 ? (
                  <optgroup label="Groups">
                    {groups.map(group => {
                      const count = selectedAudiencePropertyIds({ kind: 'groups', groupIds: [group.id] }, properties, groups).length
                      return <option key={group.id} value={`group:${group.id}`} disabled={count === 0}>{audienceOptionLabel(group, properties)}</option>
                    })}
                  </optgroup>
                ) : null}
                <option value="specific">Specific Properties…</option>
              </select>
            </label>
          </div>

          {activeAudience.kind === 'groups' ? (
            <div className="mt-3 max-w-2xl space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {activeAudience.groupIds.map(groupId => {
                  const group = groups.find(candidate => candidate.id === groupId)
                  if (!group) return null
                  return (
                    <span key={group.id} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-default bg-surface px-2 text-sm text-primary">
                      {audienceOptionLabel(group, properties)}
                      <button
                        type="button"
                        aria-label={`Remove ${group.name}`}
                        className="-my-px -mr-2 ml-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded text-secondary outline-none hover:text-heading focus-visible:ring-2 focus-visible:ring-mono-400"
                        onClick={() => {
                          const groupIds = activeAudience.groupIds.filter(id => id !== group.id)
                          updateAudience(groupIds.length > 0 ? { kind: 'groups', groupIds } : { kind: 'all' })
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
              {groups.some(group => !activeAudience.groupIds.includes(group.id) && selectedAudiencePropertyIds({ kind: 'groups', groupIds: [group.id] }, properties, groups).length > 0) ? (
                <label className="block max-w-sm">
                  <span className="text-sm font-medium text-heading">Add another group</span>
                  <select
                    aria-label="Add another group"
                    value=""
                    onChange={event => {
                      if (!event.currentTarget.value) return
                      updateAudience({ kind: 'groups', groupIds: [...activeAudience.groupIds, event.currentTarget.value] })
                    }}
                    className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none focus:border-strong focus:ring-2 focus:ring-mono-400"
                  >
                    <option value="">Choose a group</option>
                    {groups.filter(group => !activeAudience.groupIds.includes(group.id)).map(group => {
                      const count = selectedAudiencePropertyIds({ kind: 'groups', groupIds: [group.id] }, properties, groups).length
                      return <option key={group.id} value={group.id} disabled={count === 0}>{audienceOptionLabel(group, properties)}</option>
                    })}
                  </select>
                </label>
              ) : null}
              {selectedPropertyCount === 0 ? <p role="alert" className="text-sm text-caution">This group has no included Properties. Add Properties to the group, then try again.</p> : null}
            </div>
          ) : null}

          {activeAudience.kind === 'specific' ? (
            <div className="mt-4">
              <PropertyChecklist
                legend="Specific Properties"
                properties={properties}
                selectedPropertyIds={activeAudience.propertyIds}
                showBulkActions={false}
                onSelectedPropertyIdsChange={propertyIds => {
                  updateAudience({ kind: 'specific', propertyIds })
                }}
              />
            </div>
          ) : null}
          <p className="mt-3 max-w-2xl text-sm text-secondary">Groups are shortcuts resolved when you assign. Changing membership later does not rewrite existing assignments, and a Property added later does not receive earlier group queries.</p>
        </fieldset>
      )}

      {viewer || !onCreateQueries ? null : (
        <details open={queries.length === 0} className="border-y border-default py-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Add queries</summary>
          <div className="pt-3">
            <h4 className="m-0 text-sm font-medium text-heading">
              {queries.length === 0 ? 'Add the queries you want to track' : 'Add more queries'}
            </h4>
            <p className="mt-1 mb-2 text-sm text-secondary">One per line. Add them to the project, then apply them to Properties.</p>
            <textarea
              aria-label="New queries, one per line"
              className="w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              rows={4}
              value={newQueriesText}
              onChange={event => setNewQueriesText(event.currentTarget.value)}
              placeholder={'best apartments in dallas\nluxury apartments atlanta\npet friendly apartments austin'}
            />
            {createQueriesError ? (
              <p role="alert" className="mt-2 text-sm text-negative">{createQueriesError}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={parsedNewQueries.length === 0 || isCreatingQueries || isBusy}
                onClick={() => {
                  void Promise.resolve(onCreateQueries(parsedNewQueries))
                    .then(() => setNewQueriesText(''), () => {})
                }}
              >
                {isCreatingQueries
                  ? 'Adding…'
                  : `Add ${parsedNewQueries.length || ''} ${parsedNewQueries.length === 1 ? 'query' : 'queries'}`.replace('  ', ' ')}
              </Button>
              {onManageProjectQueries ? (
                <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={isBusy} onClick={onManageProjectQueries}>
                  Manage project queries
                </Button>
              ) : null}
            </div>

            <div className="mt-4 border-t border-default pt-4">
              <h4 className="m-0 text-sm font-medium text-heading">Write one query for every Property</h4>
              <p className="mt-1 mb-2 text-sm text-secondary">
                Put <code className="rounded bg-bg-elevated px-1">{'{property}'}</code> where the
                Property name belongs. You get one query per selected Property.
              </p>
              <input
                aria-label="Query pattern"
                className="min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                value={patternText}
                onChange={event => setPatternText(event.target.value)}
                placeholder="apartments near {property}"
              />
              {patternText.trim() === '' ? null : patternPlaceholders.length === 0 ? (
                <p className="mt-2 text-sm text-caution">
                  Add {'{property}'} to the pattern, or use the box above for a single query.
                </p>
              ) : patternTargets.length === 0 ? (
                <p className="mt-2 text-sm text-caution">Select at least one Property to write queries for.</p>
              ) : (
                <div className="mt-2 rounded-md border border-base bg-bg-elevated p-3">
                  <p className="m-0 text-sm text-secondary">
                    {patternExpansions.length} {patternExpansions.length === 1 ? 'query' : 'queries'}, one per selected Property:
                  </p>
                  <ul className="mt-1 mb-0 list-none space-y-0.5 p-0">
                    {patternExpansions.slice(0, 3).map(text => (
                      <li key={text} className="text-sm text-strong">{text}</li>
                    ))}
                  </ul>
                  {patternExpansions.length > 3 ? (
                    <p className="mt-1 mb-0 text-sm text-secondary">
                      and {patternExpansions.length - 3} more
                    </p>
                  ) : null}
                </div>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 min-h-11"
                disabled={patternPairs.length === 0 || isCreatingQueries || isBusy || !onCreateAndPairQuestions}
                onClick={() => {
                  if (!onCreateAndPairQuestions) return
                  void Promise.resolve(onCreateAndPairQuestions(patternPairs))
                    .then(() => setPatternText(''), () => {})
                }}
              >
                {isCreatingQueries
                  ? 'Adding…'
                  : `Add ${patternPairs.length || ''} ${patternPairs.length === 1 ? 'query' : 'queries'}`.replace('  ', ' ')}
              </Button>
              {patternPairs.length > 0 ? (
                <p className="mt-2 mb-0 text-sm text-secondary">
                  Each query is measured on the one Property it names, so this adds{' '}
                  {patternPairs.length} assignment{patternPairs.length === 1 ? '' : 's'}.
                </p>
              ) : null}
            </div>
          </div>
        </details>
      )}

      {viewer ? null : (
        <div className="space-y-3 border-y border-default py-4">
          {/* With an empty query library these controls can only be disabled. */}
          {queries.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={selectableVisibleQueries.length === 0}
              onClick={selectAllShownQueries}
            >
              Select all shown queries
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={selectedQueryIds.length === 0}
              onClick={() => onSelectedQueryIdsChange([])}
            >
              Clear query selection
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              disabled={!canApply}
              onClick={() => {
                void onApplySelectedQueries({
                  queryIds: selectedQueryIds,
                  propertyIds: resolvedAudiencePropertyIds,
                  ...(activeAudience.kind === 'groups' ? { groupIds: activeAudience.groupIds } : {}),
                })
              }}
            >
              {isApplying
                ? 'Assigning queries…'
                : `Assign ${selectedQueryIds.length || ''} ${selectedQueryIds.length === 1 ? 'query' : 'queries'} to ${audienceLabel(activeAudience, groups, selectedPropertyCount)}`.replace('  ', ' ')}
            </Button>
            {/*
              Four states share this slot and each is a different height, and the
              impact sentence itself rewraps as the counts change. Without a
              reserved two lines, ticking a box moved the query table under
              the cursor.
            */}
            <div className="min-h-[2.75rem]">
            {isPreviewingAssignmentImpact ? <p role="status" className="text-sm text-secondary">Calculating assignment impact…</p> : null}
            {assignmentImpact ? (
              <p className="text-sm text-secondary">
                {selectedQueryIds.length} {selectedQueryIds.length === 1 ? 'query' : 'queries'} → {assignmentImpact.assignmentCount} Property assignment{assignmentImpact.assignmentCount === 1 ? '' : 's'}
                {' · '}{assignmentImpact.addedAssignments} new, {assignmentImpact.alreadyPresentAssignments} already assigned
                {' · '}{assignmentImpact.fullRunProviderCalls} provider request{assignmentImpact.fullRunProviderCalls === 1 ? '' : 's'} per full run
                {' · '}{assignmentImpact.addedProviderCalls} new
                {activeAudience.kind === 'groups' ? ` · ${assignmentImpact.resolvedPropertyCount} unique ${assignmentImpact.resolvedPropertyCount === 1 ? 'Property' : 'Properties'}${assignmentImpact.overlapCount > 0 ? `, ${assignmentImpact.overlapCount} in overlapping groups` : ''}` : ''}
                . Existing assignments stay in place.
              </p>
            ) : assignmentImpactError ? (
              <div className="flex flex-wrap items-center gap-3">
                <p role="alert" className="text-sm text-negative">{assignmentImpactError}</p>
                {onRetryAssignmentImpact ? <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={onRetryAssignmentImpact}>Retry impact</Button> : null}
                {onBack ? <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={onBack}>Back to Groups</Button> : null}
              </div>
            ) : (
              <p className="text-sm text-secondary">{selectedQueryIds.length} {selectedQueryIds.length === 1 ? 'query' : 'queries'} × {selectedPropertyCount} Properties = {selectedQueryIds.length * selectedPropertyCount} assignments</p>
            )}
            </div>
            {assignmentNotice ? <p role="status" className="text-sm text-secondary">{assignmentNotice}</p> : null}
          </div>
          )}
        </div>
      )}

      {queries.length > 0 ? (
        <div className="space-y-3">
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Search queries</span>
            <input
              type="search"
              value={querySearch}
              onChange={event => {
                setQuerySearch(event.currentTarget.value)
                setShowAllQueries(false)
              }}
              className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400"
              placeholder="Query text"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-sm text-secondary">
              Showing {visibleQueries.length} of {listedQueries.length} queries,{' '}
              {filteredQueries.length - unappliedQueries.length} of {filteredQueries.length} applied
            </p>
            {viewer || unappliedQueries.length === 0 ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11"
                onClick={() => { setShowUnappliedOnly(current => !current); setShowAllQueries(false) }}
              >
                {showUnappliedOnly ? 'Show all queries' : `Show the ${unappliedQueries.length} not applied`}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {visibleQueries.length > 0 ? (
        <div className="overflow-x-auto border-y border-default">
          <table className="evidence-table min-w-[620px]">
          <thead>
            <tr>
              {viewer ? null : <th><span className="sr-only">Select query</span></th>}
              <th>Query</th>
              <th>Properties</th>
              {viewer ? null : <th><span className="sr-only">Query actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {visibleQueries.map(query => {
              const missing = isMissingQuery(query)
              const label = queryLabel(query)
              const selected = selectedQueryIds.includes(query.id)
              const hasAssignments = (query.propertyIds?.length ?? 0) > 0
              return (
                <tr key={query.id}>
                  {viewer ? null : missing ? <td aria-hidden="true" /> : (
                    <td className="p-0">
                      <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                        <input
                          aria-label={`Select query ${label}`}
                          checked={selected}
                          type="checkbox"
                          onChange={event => onSelectedQueryIdsChange(changeSelection(selectedQueryIds, query.id, event.currentTarget.checked))}
                          className="size-6 accent-accent"
                        />
                      </label>
                    </td>
                  )}
                  <td>
                    <p className="font-medium text-heading">{label}</p>
                  </td>
                  <td className="text-secondary">{propertyNames(query.propertyIds ?? [], properties)}</td>
                  {viewer ? null : (
                    <td className="text-right">
                      {hasAssignments ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          {!missing && onEditQuery ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="min-h-11"
                              disabled={isBusy}
                              onClick={() => onEditQuery(query.id)}
                              aria-label={`Edit query ${label}`}
                            >
                              Edit query
                            </Button>
                          ) : null}
                          {hasAssignments && onReplaceAssignments ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="min-h-11"
                              disabled={isBusy || isReplacingAssignments}
                              onClick={() => setReplacement({ queryId: query.id, propertyIds: [...(query.propertyIds ?? [])] })}
                              aria-label={`Replace query assignments for ${label}`}
                            >
                              Replace assignments
                            </Button>
                          ) : null}
                          {hasAssignments ? <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={isBusy} onClick={() => { void clearAssignments(query.id) }} aria-label={`Clear query assignments for ${label}`}>Clear assignments</Button> : null}
                        </div>
                      ) : null}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
          </table>
        </div>
      ) : queries.length > 0 ? <p className="text-sm text-secondary">No queries match this search.</p> : null}

      {viewer || !replacement ? null : (() => {
        const query = queries.find(candidate => candidate.id === replacement.queryId)
        const label = query ? queryLabel(query) : 'this query'
        const selected = replacement.propertyIds.filter(propertyId => properties.some(property => property.id === propertyId))
        return (
          <section aria-labelledby="advanced-measurement-replace-assignments-title" className="border-y border-default py-4">
            <h4 id="advanced-measurement-replace-assignments-title" className="text-sm font-medium text-heading">Replace assigned Properties</h4>
            <p className="mt-1 max-w-2xl text-sm text-secondary">This replaces every Property assigned to “{label}”.</p>
            <div className="mt-3">
              <PropertyChecklist
                legend="Properties for this query"
                properties={properties}
                selectedPropertyIds={selected}
                onSelectedPropertyIdsChange={propertyIds => setReplacement(current => current ? { ...current, propertyIds: [...propertyIds] } : current)}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={isReplacingAssignments || isBusy} onClick={() => setReplacement(null)}>Keep current assignments</Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={selected.length === 0 || isReplacingAssignments || isBusy || !onReplaceAssignments}
                onClick={() => {
                  if (!onReplaceAssignments) return
                  void Promise.resolve(onReplaceAssignments({ queryId: replacement.queryId, propertyIds: selected }))
                }}
              >
                {isReplacingAssignments ? 'Replacing assignments…' : `Replace with ${selected.length} ${selected.length === 1 ? 'Property' : 'Properties'}`}
              </Button>
            </div>
          </section>
        )
      })()}

      {visibleQueries.length < listedQueries.length ? (
        <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => setShowAllQueries(true)}>Show all queries</Button>
      ) : null}

      {viewer ? null : (
        <>
          {canContinue ? null : <p role="status" className="text-sm text-caution">Apply at least one query to a Property before continuing.</p>}
          <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
            {onBack ? <Button type="button" variant="outline" className="min-h-11" disabled={isBusy} onClick={onBack}>Back</Button> : null}
            <Button type="button" variant={canApply ? 'outline' : 'default'} className="min-h-11" disabled={!canContinue || isBusy} onClick={onContinue}>Continue</Button>
          </div>
        </>
      )}
    </section>
  )
}

export function AdvancedMeasurementGroupsStep({
  access,
  availability,
  properties,
  groups,
  groupDraft,
  isSaving = false,
  onGroupDraftChange,
  onSaveGroup,
  onEditGroup,
  onRemoveGroup,
  onClearGroupDraft,
  membershipImport,
  onBack,
  onContinue,
}: AdvancedMeasurementGroupsStepProps) {
  if (isUnavailable(availability)) {
    return <section aria-label="Groups"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const canSave = groupDraft.name.trim().length > 0 && groupDraft.propertyIds.length > 0 && !isSaving
  const selectedPropertyCount = properties.filter(property => groupDraft.propertyIds.includes(property.id)).length
  const hasUnsavedGroupDraft = groupDraft.name.trim().length > 0 || groupDraft.propertyIds.length > 0 || groupDraft.competitorDomains.trim().length > 0
  const showSavedGroupActions = !viewer && (onEditGroup !== undefined || onRemoveGroup !== undefined)

  function clearGroupForm(): void {
    if (onClearGroupDraft) {
      onClearGroupDraft()
      return
    }
    onGroupDraftChange({ name: '', propertyIds: [], competitorDomains: '' })
  }

  return (
    <section aria-labelledby="advanced-measurement-groups-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-groups-title">Groups</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Use groups to assign queries by market and compare competitors.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {viewer || !membershipImport ? null : <GroupMembershipImportPanel value={membershipImport} />}

      {viewer ? null : (
        <div className="space-y-4 border-y border-default py-4">
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Group name</span>
            <input
              aria-label="Group name"
              className="mt-1 min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              value={groupDraft.name}
              onChange={event => onGroupDraftChange({ ...groupDraft, name: event.currentTarget.value })}
              placeholder="Waterfront venues"
            />
          </label>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">{selectedPropertyCount} of {properties.length} Properties selected</summary>
            <div className="pt-3">
              <PropertyChecklist
                legend="Properties in this group"
                properties={properties}
                selectedPropertyIds={groupDraft.propertyIds}
                onSelectedPropertyIdsChange={propertyIds => onGroupDraftChange({ ...groupDraft, propertyIds })}
              />
            </div>
          </details>
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Competitor domains</span>
            <input
              aria-label="Competitor domains"
              className="mt-1 min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              value={groupDraft.competitorDomains}
              onChange={event => onGroupDraftChange({ ...groupDraft, competitorDomains: event.currentTarget.value })}
              placeholder="one.example, two.example"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={!canSave} onClick={() => { void onSaveGroup(groupDraft) }}>
              {isSaving ? 'Saving group…' : 'Save group'}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={!hasUnsavedGroupDraft} onClick={clearGroupForm}>Clear form</Button>
            <p className="text-sm text-secondary">Competitor domains are used only in this group&apos;s competitor report. Membership changes affect future assignments only.</p>
          </div>
          {hasUnsavedGroupDraft ? <p role="status" className="text-sm text-caution">Save this group or clear the form before continuing.</p> : null}
        </div>
      )}

      <div className="overflow-x-auto border-y border-default">
        <table className="evidence-table min-w-[620px]">
          <thead><tr><th>Group</th><th>Properties</th><th>Competitors</th>{showSavedGroupActions ? <th>Actions</th> : null}</tr></thead>
          <tbody>
            {groups.map(group => (
              <tr key={group.id}>
                <td className="font-medium text-heading">{group.name}</td>
                <td className="text-secondary">{propertyNames(group.propertyIds, properties)}</td>
                <td className="text-secondary">{group.competitors.length > 0 ? group.competitors.join(', ') : 'None'}</td>
                {showSavedGroupActions ? (
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      {onEditGroup ? <Button type="button" size="sm" variant="ghost" className="min-h-11" aria-label={`Edit ${group.name}`} onClick={() => onEditGroup(group)}>Edit</Button> : null}
                      {onRemoveGroup ? <Button type="button" size="sm" variant="ghost" className="min-h-11" aria-label={`Remove ${group.name}`} onClick={() => { void onRemoveGroup(group.id) }}>Remove</Button> : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groups.length === 0 ? <p className="text-sm text-secondary">No groups have been added.</p> : null}

      {viewer ? null : (
        <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
          {onBack ? <Button type="button" variant="outline" className="min-h-11" onClick={onBack}>Back</Button> : null}
          <Button type="button" className="min-h-11" disabled={hasUnsavedGroupDraft} onClick={onContinue}>{groups.length === 0 && !hasUnsavedGroupDraft ? 'Continue without groups' : 'Continue'}</Button>
        </div>
      )}
    </section>
  )
}

export function AdvancedMeasurementReviewStep({
  access,
  availability,
  counts,
  flaggedExceptions,
  sitemapReview,
  onBack,
  onReviewChanges,
  isReviewing = false,
  canReviewChanges = true,
  reviewedChanges,
  reviewChangesError,
  canPublish,
  isPublishing = false,
  onPublish,
}: AdvancedMeasurementReviewStepProps) {
  const [sitemapItemLimit, setSitemapItemLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  const [coverageItemLimit, setCoverageItemLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  const [flaggedExceptionLimit, setFlaggedExceptionLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  if (isUnavailable(availability)) {
    return <section aria-label="Review and publish"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const sitemapItems = sitemapReview?.items ?? []
  const coverageItems = sitemapReview?.coverageItems ?? []
  const shownSitemapItems = sitemapItems.slice(0, sitemapItemLimit)
  const shownCoverageItems = coverageItems.slice(0, coverageItemLimit)
  const shownFlaggedExceptions = flaggedExceptions.slice(0, flaggedExceptionLimit)
  const requiresChangeReview = onReviewChanges !== undefined
  const hasReviewedChanges = reviewedChanges !== null && reviewedChanges !== undefined

  return (
    <section aria-labelledby="advanced-measurement-review-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-review-title">Review &amp; publish</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Confirm the setup details before publishing.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {sitemapReview ? (
        <section aria-labelledby="advanced-measurement-sitemap-review-title" className="border-y border-caution-800/40 bg-caution-950/20 py-4">
          <div className="max-w-2xl space-y-3">
            <div>
              <h4 id="advanced-measurement-sitemap-review-title" className="text-sm font-medium text-heading">Sitemap changes need review</h4>
              {sitemapReview.exceptionCount > 0 ? <p className="mt-1 text-sm text-secondary">{sitemapReview.exceptionCount} sitemap {sitemapReview.exceptionCount === 1 ? 'entry needs' : 'entries need'} review.</p> : null}
              {sitemapReview.coverageReviewCount > 0 ? <p className="mt-1 text-sm text-secondary">{sitemapReview.coverageReviewCount} {sitemapReview.coverageReviewCount === 1 ? 'Property has' : 'Properties have'} URL coverage changes.</p> : null}
            </div>
            {sitemapReview.exceptionCount > 0 ? (
              <details className="border-y border-caution-800/30 py-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">URLs not added to Properties ({sitemapReview.exceptionCount})</summary>
                {sitemapItems.length > 0 ? (
                  <ul className="mt-3 space-y-3 text-sm">
                    {shownSitemapItems.map(item => (
                      <li key={`${item.url}-${item.reason}`}>
                        <p className="font-medium text-primary">{item.url}</p>
                        <p className="mt-1 text-secondary">{item.reason}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-2 text-sm text-secondary">Review the affected sitemap URLs before confirming.</p>}
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-secondary">
                  <span>Showing {shownSitemapItems.length} of {sitemapItems.length}</span>
                  {shownSitemapItems.length < sitemapItems.length ? (
                    <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setSitemapItemLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 URLs</Button>
                  ) : null}
                </div>
              </details>
            ) : null}
            {viewer ? <p className="text-sm text-secondary">An editor must finish this review before publishing.</p> : (
              <>
                {sitemapReview.coverageReviewCount > 0 ? (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium text-heading">For changed Property URLs</legend>
                    <p className="text-sm text-secondary">This choice applies to all {sitemapReview.coverageReviewCount} changed {sitemapReview.coverageReviewCount === 1 ? 'Property' : 'Properties'}.</p>
                    <details className="border-y border-caution-800/30 py-3">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Review Property URL changes ({sitemapReview.coverageReviewCount})</summary>
                      {shownCoverageItems.length > 0 ? (
                        <div className="mt-3 space-y-4">
                          {shownCoverageItems.map(item => (
                            <section key={item.property} aria-label={`${item.property} URL changes`}>
                              <h5 className="text-sm font-medium text-primary">{item.property}</h5>
                              <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
                                <div><p className="font-medium text-secondary">Saved URLs</p><ul className="mt-1 space-y-1">{item.savedUrls.map(url => <li key={url} className="break-all text-secondary">{url}</li>)}</ul></div>
                                <div><p className="font-medium text-secondary">Current sitemap URLs</p>{item.currentSitemapUrls.length > 0 ? <ul className="mt-1 space-y-1">{item.currentSitemapUrls.map(url => <li key={url} className="break-all text-secondary">{url}</li>)}</ul> : <p className="mt-1 text-secondary">No matching URL was found.</p>}</div>
                              </div>
                            </section>
                          ))}
                          <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
                            <span>Showing {shownCoverageItems.length} of {coverageItems.length}</span>
                            {shownCoverageItems.length < coverageItems.length ? (
                              <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setCoverageItemLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 URL changes</Button>
                            ) : null}
                          </div>
                        </div>
                      ) : <p className="mt-2 text-sm text-secondary">Review the affected Properties before confirming.</p>}
                    </details>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-primary">
                      <input
                        type="radio"
                        name="advanced-measurement-coverage-resolution"
                        checked={sitemapReview.coverageResolution === 'keep-existing'}
                        onChange={() => sitemapReview.onCoverageResolutionChange('keep-existing')}
                      />
                      Keep existing Property URLs
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-primary">
                      <input
                        type="radio"
                        name="advanced-measurement-coverage-resolution"
                        checked={sitemapReview.coverageResolution === 'replace-with-imported'}
                        onChange={() => sitemapReview.onCoverageResolutionChange('replace-with-imported')}
                      />
                      Use current sitemap URLs
                    </label>
                  </fieldset>
                ) : null}
                <Button type="button" className="min-h-11" onClick={() => { void sitemapReview.onResolve() }}>Confirm sitemap changes</Button>
              </>
            )}
          </div>
        </section>
      ) : null}

      <div className="overflow-x-auto border-y border-default">
        <table className="evidence-table min-w-[720px]">
          <thead><tr><th>Properties</th><th>Queries</th><th>Groups</th><th>Assignments</th><th>Provider requests / run</th></tr></thead>
          <tbody><tr>
            <td className="tabular-nums text-heading">{counts.properties}</td>
            <td className="tabular-nums text-heading">{counts.queries}</td>
            <td className="tabular-nums text-heading">{counts.groups}</td>
            <td className="tabular-nums text-heading">{counts.assignments ?? '—'}</td>
            <td className="tabular-nums text-heading">{counts.providerCalls ?? EM_DASH}</td>
          </tr></tbody>
        </table>
      </div>
      {counts.providerCalls === undefined ? (
        <p className="supporting-copy">
          Review changes to see how many provider requests one run will make.
        </p>
      ) : null}
      {counts.assignments !== undefined && counts.assignments > counts.queries ? (
        // Aiming one query at a market writes one assignment per Property in
        // it, so this number outruns the query count and looks wrong without
        // the reason beside it.
        <p className="supporting-copy">
          {counts.queries} {counts.queries === 1 ? 'query' : 'queries'} aimed at markets and Properties
          {' '}produce {counts.assignments} assignment{counts.assignments === 1 ? '' : 's'}:
          {' '}a query aimed at a market is measured on every Property in it.
        </p>
      ) : null}

      {reviewedChanges ? (
        <section aria-labelledby="advanced-measurement-reviewed-changes-title" className="border-y border-default py-4" aria-live="polite">
          <h4 id="advanced-measurement-reviewed-changes-title" className="text-sm font-medium text-heading">{reviewedChanges.title}</h4>
          {reviewedChanges.items.length > 0 ? (
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-secondary">
              {reviewedChanges.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="advanced-measurement-flagged-exceptions-title" className="space-y-3">
        <h4 id="advanced-measurement-flagged-exceptions-title" className="text-sm font-medium text-heading">Flagged exceptions</h4>
        {flaggedExceptions.length === 0 ? <p className="text-sm text-secondary">No flagged exceptions.</p> : (
          <div className="space-y-3">
            <div className="divide-y divide-default border-y border-default">
              {shownFlaggedExceptions.map(exception => (
                <div key={exception.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div><p className="font-medium text-heading">{exception.title}</p>{exception.detail ? <p className="mt-1 text-sm text-secondary">{exception.detail}</p> : null}</div>
                  <ToneBadge tone={exception.tone ?? 'caution'}>Needs attention</ToneBadge>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
              <span>Showing {shownFlaggedExceptions.length} of {flaggedExceptions.length}</span>
              {shownFlaggedExceptions.length < flaggedExceptions.length ? (
                <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setFlaggedExceptionLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 exceptions</Button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {viewer ? null : (
        <>
          {requiresChangeReview && reviewChangesError ? <p role="alert" className="text-sm text-negative">{reviewChangesError}</p> : null}
          <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
            {onBack ? <Button type="button" variant="outline" className="min-h-11" onClick={onBack}>Back</Button> : null}
            {onReviewChanges !== undefined && !hasReviewedChanges ? (
              <Button type="button" className="min-h-11" disabled={isReviewing || !canReviewChanges} onClick={() => { void onReviewChanges() }}>{isReviewing ? 'Reviewing changes…' : 'Review changes'}</Button>
            ) : (
              <Button type="button" className="min-h-11" disabled={!canPublish || isPublishing} onClick={() => { void onPublish() }}>{isPublishing ? 'Publishing setup…' : 'Publish setup'}</Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
