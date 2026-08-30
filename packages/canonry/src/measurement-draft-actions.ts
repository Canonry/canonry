import {
  measurementDraftApplyAssignmentsRequestSchema,
  measurementDraftApplyGroupMembershipRequestSchema,
  measurementDraftApplyPairedAssignmentsRequestSchema,
  measurementDraftApplySitemapSelectionRequestSchema,
  measurementDraftClassifyAssignmentsRequestSchema,
  measurementDraftClearAssignmentsRequestSchema,
  measurementDraftCreateRequestSchema,
  measurementDraftExcludeTargetRequestSchema,
  measurementDraftImportSitemapRequestSchema,
  measurementDraftMergeTargetsRequestSchema,
  measurementDraftPublishRequestSchema,
  measurementDraftPreviewAssignmentsRequestSchema,
  measurementDraftPreviewGroupMembershipRequestSchema,
  measurementDraftRebindTargetRequestSchema,
  measurementDraftRemoveAssignmentRequestSchema,
  measurementDraftRemoveCompetitorRequestSchema,
  measurementDraftRemoveGroupRequestSchema,
  measurementDraftReplaceAssignmentsRequestSchema,
  measurementDraftReplaceQueryRequestSchema,
  measurementDraftRenameTargetRequestSchema,
  measurementDraftUpsertCompetitorRequestSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementDraftUpsertTargetRequestSchema,
} from '@ainyc/canonry-contracts'
import { z } from 'zod'
import type { ApiClient } from './client.js'

const idempotencyKeySchema = z.string().trim().min(1).describe(
  'A fresh request key. Reuse it only when retrying the identical request.',
)
const draftEtagSchema = z.string().trim().min(1).optional().describe(
  'Current draft ETag from canonry_measurement_draft_get. The API requires it for draft edits, publish, and discard; omit it only to receive the API’s actionable 428 response.',
)

function mutationOperationSchema<TAction extends string, TRequest extends z.ZodTypeAny>(action: TAction, request: TRequest) {
  return z.object({
    action: z.literal(action),
    request,
    etag: draftEtagSchema,
    idempotencyKey: idempotencyKeySchema,
  }).strict().describe(`Operation for ${action}.`)
}

/** Typed operation envelope shared by the CLI and MCP adapter. */
export const measurementDraftOperationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    request: measurementDraftCreateRequestSchema,
    idempotencyKey: idempotencyKeySchema,
  }).strict().describe('Operation for create.'),
  mutationOperationSchema('import-sitemap', measurementDraftImportSitemapRequestSchema),
  mutationOperationSchema('apply-sitemap-selection', measurementDraftApplySitemapSelectionRequestSchema),
  mutationOperationSchema('upsert-target', measurementDraftUpsertTargetRequestSchema),
  mutationOperationSchema('rename-target', measurementDraftRenameTargetRequestSchema),
  mutationOperationSchema('merge-targets', measurementDraftMergeTargetsRequestSchema),
  mutationOperationSchema('exclude-target', measurementDraftExcludeTargetRequestSchema),
  mutationOperationSchema('rebind-target', measurementDraftRebindTargetRequestSchema),
  mutationOperationSchema('apply-assignments', measurementDraftApplyAssignmentsRequestSchema),
  z.object({
    action: z.literal('preview-assignments'),
    request: measurementDraftPreviewAssignmentsRequestSchema,
  }).strict().describe('Read-semantic assignment impact preview.'),
  mutationOperationSchema('replace-assignments', measurementDraftReplaceAssignmentsRequestSchema),
  mutationOperationSchema('replace-query', measurementDraftReplaceQueryRequestSchema),
  mutationOperationSchema('apply-paired-assignments', measurementDraftApplyPairedAssignmentsRequestSchema),
  mutationOperationSchema('remove-assignment', measurementDraftRemoveAssignmentRequestSchema),
  mutationOperationSchema('clear-assignments', measurementDraftClearAssignmentsRequestSchema),
  mutationOperationSchema('classify-assignments', measurementDraftClassifyAssignmentsRequestSchema),
  mutationOperationSchema('upsert-group', measurementDraftUpsertGroupRequestSchema),
  mutationOperationSchema('remove-group', measurementDraftRemoveGroupRequestSchema),
  z.object({
    action: z.literal('preview-group-membership'),
    request: measurementDraftPreviewGroupMembershipRequestSchema,
  }).strict().describe('Read-semantic CSV group-membership preview.'),
  mutationOperationSchema('apply-group-membership', measurementDraftApplyGroupMembershipRequestSchema),
  mutationOperationSchema('upsert-competitor', measurementDraftUpsertCompetitorRequestSchema),
  mutationOperationSchema('remove-competitor', measurementDraftRemoveCompetitorRequestSchema),
  z.object({ action: z.literal('compile-preview') }).strict().describe('Operation for compile-preview.'),
  z.object({ action: z.literal('diff-preview') }).strict().describe('Operation for diff-preview.'),
  mutationOperationSchema('publish', measurementDraftPublishRequestSchema),
  z.object({
    action: z.literal('discard'),
    etag: draftEtagSchema,
    idempotencyKey: idempotencyKeySchema,
  }).strict().describe('Operation for discard.'),
])

export type MeasurementDraftOperation = z.infer<typeof measurementDraftOperationSchema>

export function runMeasurementDraftAction(
  client: ApiClient,
  project: string,
  actionInput: MeasurementDraftOperation,
): Promise<unknown> {
  switch (actionInput.action) {
    case 'create':
      return client.createMeasurementPlanDraft(project, actionInput.request, actionInput.idempotencyKey)
    case 'import-sitemap':
      return client.importMeasurementDraftSitemap(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'apply-sitemap-selection':
      return client.applyMeasurementDraftSitemapSelection(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'upsert-target':
      return client.upsertMeasurementDraftTarget(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'rename-target':
      return client.renameMeasurementDraftTarget(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'merge-targets':
      return client.mergeMeasurementDraftTargets(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'exclude-target':
      return client.excludeMeasurementDraftTarget(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'rebind-target':
      return client.rebindMeasurementDraftTarget(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'apply-assignments':
      return client.applyMeasurementDraftAssignments(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'preview-assignments':
      return client.previewMeasurementDraftAssignments(project, actionInput.request)
    case 'replace-assignments':
      return client.replaceMeasurementDraftAssignments(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'replace-query':
      return client.replaceMeasurementDraftQuery(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'apply-paired-assignments':
      return client.applyPairedMeasurementDraftAssignments(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'remove-assignment':
      return client.removeMeasurementDraftAssignment(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'clear-assignments':
      return client.clearMeasurementDraftAssignments(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'classify-assignments':
      return client.classifyMeasurementDraftAssignments(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'upsert-group':
      return client.upsertMeasurementDraftGroup(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'remove-group':
      return client.removeMeasurementDraftGroup(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'preview-group-membership':
      return client.previewMeasurementDraftGroupMembership(project, actionInput.request)
    case 'apply-group-membership':
      return client.applyMeasurementDraftGroupMembership(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'upsert-competitor':
      return client.upsertMeasurementDraftCompetitor(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'remove-competitor':
      return client.removeMeasurementDraftCompetitor(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'compile-preview':
      return client.compileMeasurementDraftPreview(project)
    case 'diff-preview':
      return client.diffMeasurementDraftPreview(project)
    case 'publish':
      return client.publishMeasurementDraft(project, actionInput.request, actionInput.idempotencyKey, actionInput.etag)
    case 'discard':
      return client.discardMeasurementDraft(project, actionInput.idempotencyKey, actionInput.etag)
  }
}
