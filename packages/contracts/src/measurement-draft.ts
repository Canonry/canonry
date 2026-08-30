import { z } from 'zod'
import {
  MEASUREMENT_PAGE_MAX_LIMIT,
  measurementCursorPageSchema,
  measurementPlanV2Schema,
  measurementQueryClassSchema,
  measurementV2CompetitorSchema,
  measurementV2ExecutionContextSchema,
  measurementV2QueryProvenanceSchema,
  measurementV2StableKeySchema,
} from './measurement-plan-v2.js'
import { measurementDiscoveryRuleSchema } from './measurement-service.js'
import { providerNameSchema } from './provider.js'
import { queryDtoSchema } from './project.js'

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)
const measurementDraftQueryIdSchema = z.string().trim().min(1).max(256)
const measurementDraftRevisionSchema = z.number().int().positive()

/** Who acted, recorded on the draft and repeated in the audit trail. */
export const measurementActorReferenceSchema = z.object({
  kind: z.enum(['user', 'api-key', 'system']),
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict()
export type ActorReference = z.output<typeof measurementActorReferenceSchema>

/**
 * `proposed` is what discovery produces, `included` is what the operator
 * accepted, `excluded` is what they rejected. Only `included` Targets compile.
 */
export const measurementDraftTargetStatusSchema = z.enum(['proposed', 'included', 'excluded'])
export type MeasurementDraftTargetStatus = z.output<typeof measurementDraftTargetStatusSchema>

export const measurementDraftTargetSourceSchema = z.enum(['manual', 'sitemap'])
export type MeasurementDraftTargetSource = z.output<typeof measurementDraftTargetSourceSchema>

export const measurementDraftTargetSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  status: measurementDraftTargetStatusSchema,
  aliases: z.array(z.string().trim().min(1)),
  urlMatchers: z.array(z.string().trim().min(1)),
  source: measurementDraftTargetSourceSchema,
  discoveredUrl: z.string().trim().min(1).optional(),
  /** Structural identity from discovery. Rebinding keeps it, so history follows the Target. */
  discoveryIdentity: z.string().trim().min(1).optional(),
}).strict()
export type MeasurementDraftTarget = z.output<typeof measurementDraftTargetSchema>

/** Per-assignment escape hatch from the draft's default execution context. */
export const measurementDraftContextOverrideSchema = z.object({
  providers: z.array(providerNameSchema).optional(),
  models: z.record(providerNameSchema, z.string().trim().min(1)).optional(),
  locations: z.array(z.string().trim().min(1)).optional(),
}).strict()
export type MeasurementDraftContextOverride = z.output<typeof measurementDraftContextOverrideSchema>

/**
 * A draft class may be `unclassified`; publish validation rejects it. The class
 * belongs to the Target-owned assignment, so one question can be Branded for
 * one Target and Non-brand for another when the operator chooses that.
 */
export const measurementDraftQueryClassSchema = z.enum(['branded', 'non-brand', 'unclassified'])
export type MeasurementDraftQueryClass = z.output<typeof measurementDraftQueryClassSchema>

/** A proposal never overwrites an operator decision, so the source travels with the class. */
export const measurementClassificationSourceSchema = z.enum(['rule', 'operator'])
export type MeasurementClassificationSource = z.output<typeof measurementClassificationSourceSchema>

export const measurementDraftAssignmentSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  queryId: measurementDraftQueryIdSchema,
  contextOverride: measurementDraftContextOverrideSchema.optional(),
  /**
   * Exact frozen v2 execution contexts seeded from an active revision.
   * Unlike `contextOverride`, these are never expanded against the current
   * defaults: one list entry becomes one execution node exactly as frozen.
   */
  executionContexts: z.array(measurementV2ExecutionContextSchema).min(1).optional(),
  /** Frozen source facts for a query carried forward from an active v2 revision. */
  queryProvenance: measurementV2QueryProvenanceSchema.optional(),
  queryClass: measurementDraftQueryClassSchema,
  classificationSource: measurementClassificationSourceSchema,
}).strict().superRefine((value, context) => {
  if (value.contextOverride !== undefined && value.executionContexts !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['executionContexts'],
      message: 'An assignment uses either an exact frozen execution context or a mutable context override, not both.',
    })
  }
})
export type MeasurementDraftAssignment = z.output<typeof measurementDraftAssignmentSchema>

export const measurementDraftCompetitorSchema = measurementV2CompetitorSchema

/** Reporting membership and competitors only. Strictness is what rejects a query or execution field here. */
export const measurementDraftGroupSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  targetKeys: z.array(measurementV2StableKeySchema),
  competitors: z.array(measurementDraftCompetitorSchema),
}).strict()
export type MeasurementDraftGroup = z.output<typeof measurementDraftGroupSchema>

/** The discovery inputs a rerun must reproduce byte for byte to be called deterministic. */
export const measurementDraftDiscoverySchema = z.object({
  sitemapUrl: z.string().url(),
  rule: measurementDiscoveryRuleSchema,
  exclusions: z.array(z.string().trim().min(1)),
  inputChecksum: sha256HexSchema,
  reviewedAt: z.string().datetime().optional(),
}).strict()
export type MeasurementDraftDiscovery = z.output<typeof measurementDraftDiscoverySchema>

export const measurementDraftDefaultContextSchema = z.object({
  providers: z.array(providerNameSchema),
  models: z.record(providerNameSchema, z.string().trim().min(1)).optional(),
  locations: z.array(z.string().trim().min(1)),
}).strict()
export type MeasurementDraftDefaultContext = z.output<typeof measurementDraftDefaultContextSchema>

/**
 * Authoring intent only. Compiled nodes, usage edges, query snapshots and
 * derived counts are compiler output and never round-trip through a draft;
 * strictness is what keeps them out.
 */
export const measurementDraftAuthoringSchema = z.object({
  defaultContext: measurementDraftDefaultContextSchema,
  targets: z.array(measurementDraftTargetSchema),
  assignments: z.array(measurementDraftAssignmentSchema),
  groups: z.array(measurementDraftGroupSchema),
  discovery: measurementDraftDiscoverySchema.optional(),
}).strict()
export type MeasurementDraftAuthoring = z.output<typeof measurementDraftAuthoringSchema>

export const measurementPlanDraftSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  schemaVersion: z.literal(2),
  /** Null on a draft started from a planless project. */
  baseActiveVersionId: z.string().trim().min(1).nullable(),
  baseActiveRevision: measurementDraftRevisionSchema.nullable(),
  authoring: measurementDraftAuthoringSchema,
  createdBy: measurementActorReferenceSchema,
  updatedBy: measurementActorReferenceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export type MeasurementPlanDraft = z.output<typeof measurementPlanDraftSchema>

export const MEASUREMENT_DRAFT_ETAG_PREFIX = 'mpd_'

/**
 * Mutation ceilings are contract-level so every caller can explain the same
 * refusal before it sends a write. The compiler keeps the corresponding
 * published-document byte ceiling; these protect the mutable authoring row.
 */
export const MEASUREMENT_DRAFT_MAX_ASSIGNMENTS_PER_ACTION = 5_000
export const MEASUREMENT_DRAFT_MAX_GROUPS = 1_000
export const MEASUREMENT_DRAFT_MAX_ASSIGNMENTS = 20_000
export const MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES = 4 * 1024 * 1024

/**
 * Backed by the monotonic `etag_version` counter, never a content hash: the tag
 * must change after every mutation and must not repeat when content returns to
 * a previous value.
 */
export function measurementDraftEtag(etagVersion: number): string {
  return `"${MEASUREMENT_DRAFT_ETAG_PREFIX}${etagVersion}"`
}

/** Reads a counter back from `If-Match`, which arrives quoted. Weak tags are not accepted. */
export function parseMeasurementDraftEtagVersion(value: string): number | null {
  const match = /^"?mpd_(\d+)"?$/.exec(value.trim())
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? parsed : null
}

export const measurementDraftCountsSchema = z.object({
  targets: z.number().int().nonnegative(),
  includedTargets: z.number().int().nonnegative(),
  assignments: z.number().int().nonnegative(),
  /** What still blocks publish, surfaced on every mutation so nobody discovers it at publish time. */
  unclassifiedAssignments: z.number().int().nonnegative(),
  groups: z.number().int().nonnegative(),
  competitors: z.number().int().nonnegative(),
}).strict()
export type MeasurementDraftCounts = z.output<typeof measurementDraftCountsSchema>

export const measurementDraftWarningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  path: z.array(z.union([z.string(), z.number().int()])),
}).strict()
export type MeasurementDraftWarning = z.output<typeof measurementDraftWarningSchema>

/** Every typed draft action answers with this. `changed` is false when the action was a no-op. */
export const measurementDraftMutationResponseSchema = z.object({
  etag: z.string().trim().min(1),
  changed: z.boolean(),
  warnings: z.array(measurementDraftWarningSchema),
  counts: measurementDraftCountsSchema,
}).strict()
export type DraftMutationResponse = z.output<typeof measurementDraftMutationResponseSchema>

/**
 * Creates a new saved-query identity and swaps only its draft assignments.
 * It deliberately cannot rename or delete the source catalog query.
 */
export const measurementDraftReplaceQueryRequestSchema = z.object({
  queryId: measurementDraftQueryIdSchema,
  // Match the bounded research-query contract. A draft edit must not create
  // an unbounded catalog row that no normal query entry point accepts.
  queryText: z.string().trim().min(1).max(4000),
}).strict()
export type MeasurementDraftReplaceQueryRequest = z.output<typeof measurementDraftReplaceQueryRequestSchema>

export const measurementDraftReplaceQueryResponseSchema = measurementDraftMutationResponseSchema.extend({
  previousQueryId: measurementDraftQueryIdSchema,
  replacementQuery: queryDtoSchema,
}).strict()
export type MeasurementDraftReplaceQueryResponse = z.output<typeof measurementDraftReplaceQueryResponseSchema>

export const measurementDraftResponseSchema = z.object({
  draft: measurementPlanDraftSchema.nullable(),
  etag: z.string().trim().min(1).nullable(),
}).strict()
export type MeasurementDraftResponse = z.output<typeof measurementDraftResponseSchema>

export const measurementDraftTargetPageSchema = measurementCursorPageSchema(measurementDraftTargetSchema)
export const measurementDraftAssignmentPageSchema = measurementCursorPageSchema(measurementDraftAssignmentSchema)
export const measurementDraftGroupPageSchema = measurementCursorPageSchema(measurementDraftGroupSchema)

export const measurementDraftCollectionQuerySchema = z.object({
  search: z.string().optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(MEASUREMENT_PAGE_MAX_LIMIT).optional(),
}).strict()
export type MeasurementDraftCollectionQuery = z.output<typeof measurementDraftCollectionQuerySchema>

/** The caller states the active revision it observed, so a draft is never started against a moved pointer. */
export const measurementDraftCreateRequestSchema = z.object({
  expectedActiveRevision: measurementDraftRevisionSchema.nullable(),
}).strict()

export const measurementDraftImportSitemapRequestSchema = z.object({
  sitemapUrl: z.string().url(),
  rule: measurementDiscoveryRuleSchema,
  exclusions: z.array(z.string().trim().min(1)).optional(),
}).strict()

/** Discovery proposes; the operator selects. Ambiguity is never resolved automatically. */
export const measurementDraftSitemapSelectionSchema = z.object({
  discoveryIdentity: z.string().trim().min(1),
  action: z.enum(['create', 'rebind', 'ignore']),
  targetKey: measurementV2StableKeySchema.optional(),
  label: z.string().trim().min(1).optional(),
}).strict()

export const measurementDraftApplySitemapSelectionRequestSchema = z.object({
  selections: z.array(measurementDraftSitemapSelectionSchema),
  /** When present, this is the complete reviewed Property selection after proposals are resolved. */
  selectedTargetKeys: z.array(measurementV2StableKeySchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.selections.length === 0 && value.selectedTargetKeys === undefined) {
    context.addIssue({ code: 'custom', message: 'A proposal or reviewed Property selection is required.' })
  }
  if (value.selectedTargetKeys && new Set(value.selectedTargetKeys).size !== value.selectedTargetKeys.length) {
    context.addIssue({ code: 'custom', path: ['selectedTargetKeys'], message: 'Property keys must be unique.' })
  }
})

export const measurementDraftUpsertTargetRequestSchema = z.object({
  target: measurementDraftTargetSchema,
}).strict()

export const measurementDraftRenameTargetRequestSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
}).strict()

/** The survivor keeps its key, its assignments and its group membership. */
export const measurementDraftMergeTargetsRequestSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  mergedKeys: z.array(measurementV2StableKeySchema).min(1),
}).strict()

export const measurementDraftExcludeTargetRequestSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  /** Omission preserves the reversible legacy behavior. */
  cleanup: z.literal('assignments-and-group-memberships').optional(),
}).strict()

/** Rebinding preserves `targetKey`, assignments and group membership by construction. */
export const measurementDraftRebindTargetRequestSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  discoveryIdentity: z.string().trim().min(1),
  discoveredUrl: z.string().url(),
}).strict()

/**
 * An audience is resolved by the server at apply time. Groups are an
 * authoring shortcut, never an execution owner, so the resolved output is
 * always concrete Target keys.
 */
const measurementDraftAudienceFields = {
  targetKeys: z.array(measurementV2StableKeySchema).optional(),
  groupKeys: z.array(measurementV2StableKeySchema).optional(),
}

function requireMeasurementDraftAudience(
  value: { targetKeys?: string[]; groupKeys?: string[] },
  context: z.RefinementCtx,
) {
  if ((value.targetKeys?.length ?? 0) === 0 && (value.groupKeys?.length ?? 0) === 0) {
    context.addIssue({
      code: 'custom',
      message: 'At least one Target or group selector is required.',
    })
  }
}

export const measurementDraftAudienceSchema = z.object(measurementDraftAudienceFields)
  .strict()
  .superRefine(requireMeasurementDraftAudience)
export type MeasurementDraftAudience = z.output<typeof measurementDraftAudienceSchema>

/** Shared non-legacy assignment body used by preview, additive apply and replace. */
export const measurementDraftAssignmentAudienceRequestSchema = z.object({
  ...measurementDraftAudienceFields,
  queryIds: z.array(measurementDraftQueryIdSchema).min(1),
  contextOverride: measurementDraftContextOverrideSchema.optional(),
}).strict().superRefine(requireMeasurementDraftAudience)
export type MeasurementDraftAssignmentAudienceRequest = z.output<typeof measurementDraftAssignmentAudienceRequestSchema>

/** A caller may preserve the singular v2 contract or mutate a reviewed audience atomically. */
export const measurementDraftApplyAssignmentsRequestSchema = z.union([
  z.object({
    targetKey: measurementV2StableKeySchema,
    queryIds: z.array(measurementDraftQueryIdSchema).min(1),
    contextOverride: measurementDraftContextOverrideSchema.optional(),
  }).strict(),
  measurementDraftAssignmentAudienceRequestSchema,
])
export type MeasurementDraftApplyAssignmentsRequest = z.output<typeof measurementDraftApplyAssignmentsRequestSchema>

/** Replacement clears every prior audience for the named questions, then writes this exact audience. */
export const measurementDraftReplaceAssignmentsRequestSchema = measurementDraftAssignmentAudienceRequestSchema
export type MeasurementDraftReplaceAssignmentsRequest = z.output<typeof measurementDraftReplaceAssignmentsRequestSchema>

/** Preview is read-semantic but accepts the exact body that the bulk mutation would use. */
export const measurementDraftPreviewAssignmentsRequestSchema = measurementDraftAssignmentAudienceRequestSchema
export type MeasurementDraftPreviewAssignmentsRequest = z.output<typeof measurementDraftPreviewAssignmentsRequestSchema>

export const measurementDraftResolvedAudienceGroupSchema = z.object({
  groupKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  memberCount: z.number().int().positive(),
}).strict()
export type MeasurementDraftResolvedAudienceGroup = z.output<typeof measurementDraftResolvedAudienceGroupSchema>

/** Exact assignment and provider impact for a candidate audience mutation. */
export const measurementDraftPreviewAssignmentsResponseSchema = z.object({
  draftEtag: z.string().trim().min(1),
  groups: z.array(measurementDraftResolvedAudienceGroupSchema),
  resolvedTargetKeys: z.array(measurementV2StableKeySchema),
  overlapCount: z.number().int().nonnegative(),
  assignments: z.object({
    requested: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    alreadyPresent: z.number().int().nonnegative(),
  }).strict(),
  execution: z.object({
    addedNodes: z.number().int().nonnegative(),
    addedProviderCalls: z.number().int().nonnegative(),
    fullRunNodes: z.number().int().nonnegative(),
    fullRunProviderCalls: z.number().int().nonnegative(),
  }).strict(),
}).strict()
export type MeasurementDraftPreviewAssignmentsResponse = z.output<typeof measurementDraftPreviewAssignmentsResponseSchema>

/**
 * One question paired with the one Target it is about.
 *
 * `apply-assignments` is a cross product: every listed query lands on every
 * listed Target. That is right when one question has an audience of Targets
 * ("best apartments in dallas" -> the Dallas Targets), and wrong when each
 * question names its own Target. A pattern that writes one question per Target
 * has no way to say so through the cross product, so applying 213 generated
 * questions to the 213 Targets they were generated from produced 45,369
 * assignments instead of 213 — and since coverage is matched/assignments, every
 * Target's denominator became the whole portfolio.
 */
export const measurementDraftApplyPairedAssignmentsRequestSchema = z.object({
  pairs: z.array(z.object({
    targetKey: measurementV2StableKeySchema,
    queryId: measurementDraftQueryIdSchema,
  }).strict()).min(1),
  contextOverride: measurementDraftContextOverrideSchema.optional(),
}).strict()

/** Removing one query from one or many Targets never deletes the project query behind it. */
export const measurementDraftRemoveAssignmentRequestSchema = z.union([
  z.object({
    targetKey: measurementV2StableKeySchema,
    queryId: measurementDraftQueryIdSchema,
  }).strict(),
  z.object({
    targetKeys: z.array(measurementV2StableKeySchema).min(1),
    queryId: measurementDraftQueryIdSchema,
  }).strict(),
])

export const measurementDraftClearAssignmentsRequestSchema = z.object({
  targetKey: measurementV2StableKeySchema,
}).strict()

/** An explicit classification is always operator-sourced; the server records that, not the caller. */
export const measurementDraftClassifyAssignmentsRequestSchema = z.object({
  queryClass: measurementQueryClassSchema,
  assignments: z.array(z.object({
    targetKey: measurementV2StableKeySchema,
    queryId: measurementDraftQueryIdSchema,
  }).strict()).min(1),
}).strict()

export const measurementDraftUpsertGroupRequestSchema = z.object({
  group: z.object({
    stableKey: measurementV2StableKeySchema,
    label: z.string().trim().min(1),
    targetKeys: z.array(measurementV2StableKeySchema),
    /** Omission preserves existing competitors; presence replaces the complete list. */
    competitors: z.array(measurementDraftCompetitorSchema).optional(),
  }).strict(),
}).strict()

export const measurementDraftRemoveGroupRequestSchema = z.object({
  groupKey: measurementV2StableKeySchema,
}).strict()

export const measurementDraftUpsertCompetitorRequestSchema = z.object({
  groupKey: measurementV2StableKeySchema,
  competitor: measurementDraftCompetitorSchema,
}).strict()

export const measurementDraftRemoveCompetitorRequestSchema = z.object({
  groupKey: measurementV2StableKeySchema,
  competitorKey: measurementV2StableKeySchema,
}).strict()

/** Stable field paths plus a machine-readable rule id, so a browser can point at the field that failed. */
export const measurementDraftCompileCheckSchema = z.object({
  ruleId: z.string().trim().min(1),
  severity: z.enum(['fail', 'warn']),
  message: z.string().trim().min(1),
  path: z.array(z.union([z.string(), z.number().int()])),
}).strict()
export type MeasurementDraftCompileCheck = z.output<typeof measurementDraftCompileCheckSchema>

export const measurementDraftCompilePreviewResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    compiledChecksum: sha256HexSchema,
    checks: z.array(measurementDraftCompileCheckSchema),
    counts: measurementDraftCountsSchema,
    plan: measurementPlanV2Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    compiledChecksum: z.null(),
    checks: z.array(measurementDraftCompileCheckSchema).min(1),
  }).strict(),
])
export type MeasurementDraftCompilePreviewResponse = z.output<typeof measurementDraftCompilePreviewResponseSchema>

/**
 * Keys, not bodies. A thousand-Target diff has to stay bounded, and the caller
 * already has the rows through the paginated collections.
 */
const keyedDraftDiffSchema = z.object({
  added: z.array(z.string().trim().min(1)),
  removed: z.array(z.string().trim().min(1)),
  changed: z.array(z.string().trim().min(1)),
  unchanged: z.array(z.string().trim().min(1)),
}).strict()

export const measurementDraftDiffSchema = z.object({
  activeRevision: measurementDraftRevisionSchema.nullable(),
  targets: keyedDraftDiffSchema,
  groups: keyedDraftDiffSchema,
  assignments: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    reclassified: z.number().int().nonnegative(),
  }).strict(),
  execution: z.object({
    addedNodeKeys: z.array(z.string().trim().min(1)),
    removedNodeKeys: z.array(z.string().trim().min(1)),
  }).strict(),
}).strict()
export type MeasurementDraftDiff = z.output<typeof measurementDraftDiffSchema>

export const measurementDraftDiffPreviewResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    compiledChecksum: sha256HexSchema,
    checks: z.array(measurementDraftCompileCheckSchema),
    counts: measurementDraftCountsSchema,
    plan: measurementPlanV2Schema,
    diff: measurementDraftDiffSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    compiledChecksum: z.null(),
    checks: z.array(measurementDraftCompileCheckSchema).min(1),
    diff: z.null(),
  }).strict(),
])
export type MeasurementDraftDiffPreviewResponse = z.output<typeof measurementDraftDiffPreviewResponseSchema>

/**
 * Both guards are required. The revision proves the pointer has not moved; the
 * compiled checksum proves the content is the one that was reviewed.
 */
export const measurementDraftPublishRequestSchema = z.object({
  expectedActiveRevision: measurementDraftRevisionSchema.nullable(),
  expectedCompiledChecksum: sha256HexSchema,
}).strict()

/** `published` is false on the no-op path: identical content to the active revision returns it unchanged. */
export const measurementPlanV2PublishResponseSchema = z.object({
  published: z.boolean(),
  active: z.object({
    revision: measurementDraftRevisionSchema,
    checksum: sha256HexSchema,
    compiledChecksum: sha256HexSchema,
    createdAt: z.string().datetime(),
    plan: measurementPlanV2Schema,
  }).strict(),
}).strict()
export type MeasurementPlanV2PublishResponse = z.output<typeof measurementPlanV2PublishResponseSchema>

export const measurementDraftDiscardResponseSchema = z.object({
  discarded: z.boolean(),
}).strict()

/** Deactivation deletes the active-plan pointer row and nothing else. */
export const measurementPlanDeactivateRequestSchema = z.object({
  expectedActiveRevision: measurementDraftRevisionSchema,
}).strict()

export const measurementPlanDeactivateResponseSchema = z.object({
  deactivated: z.boolean(),
  previousRevision: measurementDraftRevisionSchema.nullable(),
}).strict()

export const measurementSetupStateSchema = z.enum([
  'republish_required',
  'setup_in_progress',
  'awaiting_first_run',
  'operational',
  'simple',
])
export type MeasurementSetupState = z.output<typeof measurementSetupStateSchema>

export const measurementSetupNextActionSchema = z.enum([
  'republish_setup',
  'continue_setup',
  'run_measurement',
  'view_measurement',
  'start_setup',
])
export type MeasurementSetupNextAction = z.output<typeof measurementSetupNextActionSchema>

export const measurementSetupModeSchema = z.enum(['simple', 'draft-only', 'active-v1', 'active-v2'])
export type MeasurementSetupMode = z.output<typeof measurementSetupModeSchema>

/**
 * Exactly one state, evaluated in a fixed precedence: a draft over an active v1
 * is `republish_required`, because republishing is the blocking action.
 */
export const measurementSetupResponseSchema = z.object({
  state: measurementSetupStateSchema,
  nextAction: measurementSetupNextActionSchema,
  mode: measurementSetupModeSchema,
  activeRevision: measurementDraftRevisionSchema.nullable(),
  activeSchemaVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
  draft: z.object({
    etag: z.string().trim().min(1),
    updatedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict()
export type MeasurementSetupResponse = z.output<typeof measurementSetupResponseSchema>

/** Query sets hold ordered references. Deleting a set never deletes its queries or a published snapshot. */
export const measurementQuerySetSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export type MeasurementQuerySet = z.output<typeof measurementQuerySetSchema>

export const measurementQuerySetItemSchema = z.object({
  queryId: measurementDraftQueryIdSchema,
  queryText: z.string().min(1),
  position: z.number().int().nonnegative(),
}).strict()

export const measurementQuerySetDetailSchema = measurementQuerySetSchema.extend({
  items: z.array(measurementQuerySetItemSchema),
}).strict()
export type MeasurementQuerySetDetail = z.output<typeof measurementQuerySetDetailSchema>

export const measurementQuerySetListResponseSchema = z.object({
  querySets: z.array(measurementQuerySetSchema),
}).strict()

export const measurementQuerySetUpsertRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  queryIds: z.array(measurementDraftQueryIdSchema),
}).strict()

/** Authoring asset. Applying one expands concrete project queries; published plans hold only snapshots. */
export const measurementQueryTemplateSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  pattern: z.string().trim().min(1),
  variables: z.array(z.string().trim().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export type MeasurementQueryTemplate = z.output<typeof measurementQueryTemplateSchema>

export const measurementQueryTemplateListResponseSchema = z.object({
  templates: z.array(measurementQueryTemplateSchema),
}).strict()

export const measurementQueryTemplateUpsertRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  pattern: z.string().trim().min(1),
  variables: z.array(z.string().trim().min(1)),
}).strict()

export const measurementQueryTemplateApplyRequestSchema = z.object({
  bindings: z.array(z.record(z.string().trim().min(1), z.string().trim().min(1))).min(1),
  querySetId: z.string().trim().min(1).optional(),
}).strict()

/** Expansion is additive: an expansion that already exists is reported, never duplicated. */
export const measurementQueryTemplateApplyResponseSchema = z.object({
  created: z.array(z.object({
    queryId: measurementDraftQueryIdSchema,
    queryText: z.string().min(1),
  }).strict()),
  existing: z.array(z.object({
    queryId: measurementDraftQueryIdSchema,
    queryText: z.string().min(1),
  }).strict()),
}).strict()
export type MeasurementQueryTemplateApplyResponse = z.output<typeof measurementQueryTemplateApplyResponseSchema>
