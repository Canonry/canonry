import type {
  DraftMutationResponse,
  MeasurementDraftAuthoring,
  MeasurementDraftCompilePreviewResponse,
  MeasurementDraftDiffPreviewResponse,
  MeasurementDraftResponse,
  MeasurementDraftApplyGroupMembershipResponse,
  MeasurementDraftGroupMembershipRow,
  MeasurementDraftGroupMembershipRowStatus,
  MeasurementDraftPreviewGroupMembershipResponse,
  MeasurementDraftReplaceQueryRequest,
  MeasurementDraftReplaceQueryResponse,
  MeasurementPlanV2PublishResponse,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementPlanDraft,
  getApiV1ProjectsByNameMeasurementSetup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyAssignments,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyGroupMembership,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyPairedAssignments,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplySitemapSelection,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsCompilePreview,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsCreate,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsDiffPreview,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsDiscard,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsExcludeTarget,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsImportSitemap,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsPreviewAssignments,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsPreviewGroupMembership,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsPublish,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveAssignment,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveCompetitor,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveGroup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsReplaceAssignments,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsReplaceQuery,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertCompetitor,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertGroup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertTarget,
} from '@ainyc/canonry-api-client'

import { ApiError, heyClient, invokeWeb } from '../../../api.js'

export interface SitemapImportInput {
  sitemapUrl: string
  rule: {
    primary: { host: string; pathTemplate: string }
    aliases?: Array<{ host: string; pathTemplate: string }>
    excludedSlugPatterns?: Array<{ kind: 'exact' | 'prefix' | 'suffix' | 'contains'; value: string }>
  }
  exclusions?: string[]
}

export interface SitemapSelectionInput {
  discoveryIdentity: string
  action: 'create' | 'rebind' | 'ignore'
  targetKey?: string
  label?: string
}

/**
 * The browser names an audience in customer terms. The API resolves groups at
 * the draft boundary, so the browser never expands a market into a long list
 * of Property identifiers just to make an assignment.
 */
export interface MeasurementAudienceAssignmentInput {
  targetKeys?: string[]
  groupKeys?: string[]
  queryIds: string[]
}

export interface MeasurementAudienceAssignmentPreview {
  /** The exact draft version that the subsequent apply must use. */
  draftEtag: string
  groups: Array<{
    groupKey: string
    label: string
    memberCount: number
  }>
  resolvedTargetKeys: string[]
  overlapCount: number
  assignments: {
    requested: number
    added: number
    alreadyPresent: number
  }
  execution: {
    addedNodes: number
    addedProviderCalls: number
    fullRunNodes: number
    fullRunProviderCalls: number
  }
}

export type GroupMembershipMatchStatus = MeasurementDraftGroupMembershipRowStatus
export type GroupMembershipPreviewRow = MeasurementDraftGroupMembershipRow
export type GroupMembershipPreview = MeasurementDraftPreviewGroupMembershipResponse

export interface GroupMembershipApplyInput {
  csv: string
  sourceChecksum: string
  previewChecksum: string
  acceptedRows: number[]
}

export type GroupMembershipApplyResponse = MeasurementDraftApplyGroupMembershipResponse

export interface AdvancedMeasurementService {
  loadSetup(projectName: string): Promise<MeasurementSetupResponse>
  loadDraft(projectName: string): Promise<MeasurementDraftResponse>
  createDraft(projectName: string, expectedActiveRevision: number | null): Promise<DraftMutationResponse>
  importSitemap(projectName: string, etag: string, input: SitemapImportInput): Promise<DraftMutationResponse>
  applySitemapSelection(
    projectName: string,
    etag: string,
    selections: SitemapSelectionInput[],
    selectedTargetKeys: string[],
  ): Promise<DraftMutationResponse>
  previewAssignments(projectName: string, input: MeasurementAudienceAssignmentInput): Promise<MeasurementAudienceAssignmentPreview>
  applyAssignments(projectName: string, etag: string, input: MeasurementAudienceAssignmentInput): Promise<DraftMutationResponse>
  replaceAssignments(projectName: string, etag: string, input: MeasurementAudienceAssignmentInput): Promise<DraftMutationResponse>
  /** Reuse `idempotencyKey` for an unchanged retry after an uncertain response. */
  replaceQuery(
    projectName: string,
    etag: string,
    input: MeasurementDraftReplaceQueryRequest,
    idempotencyKey?: string,
  ): Promise<MeasurementDraftReplaceQueryResponse>
  applyPairedAssignments(projectName: string, etag: string, pairs: { targetKey: string; queryId: string }[]): Promise<DraftMutationResponse>
  removeAssignment(projectName: string, etag: string, targetKeys: string[], queryId: string): Promise<DraftMutationResponse>
  excludeTarget(projectName: string, etag: string, targetKey: string): Promise<DraftMutationResponse>
  upsertTarget(projectName: string, etag: string, target: MeasurementDraftAuthoring['targets'][number]): Promise<DraftMutationResponse>
  upsertGroup(projectName: string, etag: string, group: {
    stableKey: string
    label: string
    targetKeys: string[]
    competitors?: MeasurementDraftAuthoring['groups'][number]['competitors']
  }): Promise<DraftMutationResponse>
  removeGroup(projectName: string, etag: string, groupKey: string): Promise<DraftMutationResponse>
  upsertCompetitor(projectName: string, etag: string, input: {
    groupKey: string
    competitor: MeasurementDraftAuthoring['groups'][number]['competitors'][number]
  }): Promise<DraftMutationResponse>
  removeCompetitor(projectName: string, etag: string, groupKey: string, competitorKey: string): Promise<DraftMutationResponse>
  previewGroupMembership(projectName: string, input: { csv: string }): Promise<GroupMembershipPreview>
  applyGroupMembership(projectName: string, etag: string, input: GroupMembershipApplyInput): Promise<GroupMembershipApplyResponse>
  compilePreview(projectName: string): Promise<MeasurementDraftCompilePreviewResponse>
  diffPreview(projectName: string): Promise<MeasurementDraftDiffPreviewResponse>
  publish(projectName: string, etag: string, input: {
    expectedActiveRevision: number | null
    expectedCompiledChecksum: string
  }): Promise<MeasurementPlanV2PublishResponse>
  discard(projectName: string, etag: string): Promise<{ discarded: boolean }>
}

export function createMeasurementDraftIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function mutationHeaders(etag: string, idempotencyKey?: string) {
  return {
    'If-Match': etag,
    'Idempotency-Key': idempotencyKey ?? createMeasurementDraftIdempotencyKey(),
  }
}

export function isDraftConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 409 || error.statusCode === 412)
}

export function setupErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return fallback
  const message = error instanceof Error ? error.message.trim() : ''
  return message || fallback
}

/** Exposes only validation messages the API explicitly marks as operator-safe. */
export function assignmentPreviewErrorMessage(error: unknown): string {
  const fallback = 'Could not calculate assignment impact.'
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return fallback
  const message = error.message.trim()
  return error.details?.displayToOperator === true && message ? message : fallback
}

export const advancedMeasurementService: AdvancedMeasurementService = {
  loadSetup: projectName => invokeWeb(() => getApiV1ProjectsByNameMeasurementSetup({
    client: heyClient,
    path: { name: projectName },
  })),
  loadDraft: projectName => invokeWeb(() => getApiV1ProjectsByNameMeasurementPlanDraft({
    client: heyClient,
    path: { name: projectName },
  })),
  createDraft: (projectName, expectedActiveRevision) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsCreate({
    client: heyClient,
    path: { name: projectName },
    headers: { 'Idempotency-Key': createMeasurementDraftIdempotencyKey() },
    body: { expectedActiveRevision },
  })),
  importSitemap: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsImportSitemap({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  applySitemapSelection: (projectName, etag, selections, selectedTargetKeys) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplySitemapSelection({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { selections, selectedTargetKeys },
  })),
  previewAssignments: (projectName, input) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsPreviewAssignments({
    client: heyClient,
    path: { name: projectName },
    body: input,
  })),
  applyAssignments: (projectName, etag, input) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyAssignments({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: input,
  })),
  replaceAssignments: (projectName, etag, input) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsReplaceAssignments({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: input,
  })),
  replaceQuery: (projectName, etag, body, idempotencyKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsReplaceQuery({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag, idempotencyKey),
    body,
  })),
  applyPairedAssignments: (projectName, etag, pairs) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyPairedAssignments({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { pairs },
  })),
  removeAssignment: (projectName, etag, targetKeys, queryId) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveAssignment({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { targetKeys, queryId },
  })),
  excludeTarget: (projectName, etag, targetKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsExcludeTarget({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { targetKey, cleanup: 'assignments-and-group-memberships' },
  })),
  upsertTarget: (projectName, etag, target) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertTarget({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { target },
  })),
  upsertGroup: (projectName, etag, group) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertGroup({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { group },
  })),
  removeGroup: (projectName, etag, groupKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveGroup({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { groupKey },
  })),
  upsertCompetitor: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertCompetitor({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  removeCompetitor: (projectName, etag, groupKey, competitorKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveCompetitor({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { groupKey, competitorKey },
  })),
  previewGroupMembership: (projectName, input) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsPreviewGroupMembership({
    client: heyClient,
    path: { name: projectName },
    body: input,
  })),
  applyGroupMembership: (projectName, etag, input) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyGroupMembership({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: input,
  })),
  compilePreview: projectName => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsCompilePreview({
    client: heyClient,
    path: { name: projectName },
  })),
  diffPreview: projectName => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsDiffPreview({
    client: heyClient,
    path: { name: projectName },
  })),
  publish: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsPublish({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  discard: (projectName, etag) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsDiscard({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
  })),
}
