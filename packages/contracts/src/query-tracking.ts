import { z } from 'zod'
import {
  measurementV2ExecutionContextSchema,
  measurementV2StableKeySchema,
  measurementV2UsageEdgeSchema,
} from './measurement-plan-v2.js'
import { providerNameSchema } from './provider.js'
import { queryClassSchema } from './query-class.js'

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)
const queryTrackingIdSchema = z.string().trim().min(1).max(256)
const queryTrackingTextSchema = z.string().trim().min(1).max(4_000)
/** Server-minted timestamp for the exact preview the operator reviewed. */
export const queryTrackingReviewedAtSchema = z.string().datetime()

/** Snapshot of every mutable input the query workspace is allowed to publish against. */
export const queryTrackingWorkspaceVersionSchema = z.string().regex(/^qtw_[a-f0-9]{64}$/)
export type QueryTrackingWorkspaceVersion = z.output<typeof queryTrackingWorkspaceVersionSchema>

/** A review token binds a commit to the exact preview body and workspace version. */
export const queryTrackingPreviewTokenSchema = z.string().regex(/^qtp_[a-f0-9]{64}$/)
export type QueryTrackingPreviewToken = z.output<typeof queryTrackingPreviewTokenSchema>

export const queryTrackingModeSchema = z.enum(['simple', 'advanced'])
export type QueryTrackingMode = z.output<typeof queryTrackingModeSchema>

/**
 * The template record is frozen with the expanded question. `output` is not
 * re-expanded when an old revision is read, so a later template edit can never
 * rewrite historical measurement meaning.
 */
export const queryTrackingTemplateProvenanceSchema = z.object({
  templateId: queryTrackingIdSchema,
  templateVersion: z.string().trim().min(1).max(256),
  template: queryTrackingTextSchema,
  bindings: z.record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)),
  output: queryTrackingTextSchema,
}).strict()
export type QueryTrackingTemplateProvenance = z.output<typeof queryTrackingTemplateProvenanceSchema>

/** Frozen source metadata carried by a workspace row and a published v2 snapshot. */
export const queryTrackingProvenanceSchema = z.object({
  source: z.enum(['manual', 'query-set', 'template', 'research', 'discovery']),
  sourceId: queryTrackingIdSchema.nullable(),
  capturedAt: z.string().datetime(),
  template: queryTrackingTemplateProvenanceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source === 'template' && value.template === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: 'Template provenance is required for a template query.' })
  }
  if (value.source !== 'template' && value.template !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: 'Only a template query may carry template provenance.' })
  }
})
export type QueryTrackingProvenance = z.output<typeof queryTrackingProvenanceSchema>

/** Manual text is supplied directly; saved sources are resolved server-side and project-scoped. */
export const queryTrackingSourceInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('manual'),
    text: queryTrackingTextSchema,
  }).strict(),
  z.object({
    source: z.literal('template'),
    templateId: queryTrackingIdSchema,
    templateVersion: z.string().trim().min(1).max(256),
    template: queryTrackingTextSchema,
  }).strict(),
  z.object({
    source: z.literal('research'),
    researchRunQueryId: queryTrackingIdSchema,
  }).strict(),
  z.object({
    source: z.literal('discovery'),
    discoveryProbeId: queryTrackingIdSchema,
  }).strict(),
])
export type QueryTrackingSourceInput = z.output<typeof queryTrackingSourceInputSchema>

/**
 * Groups expand to their current Target membership. Markets are different:
 * their frozen scope membership is a set of exact usage-edge triples.
 */
export const queryTrackingAudienceSchema = z.object({
  targetKeys: z.array(measurementV2StableKeySchema).optional(),
  groupKeys: z.array(measurementV2StableKeySchema).optional(),
  marketKeys: z.array(measurementV2StableKeySchema).optional(),
}).strict()
export type QueryTrackingAudience = z.output<typeof queryTrackingAudienceSchema>

/** A caller names a configured location by label; the server stores the complete frozen context. */
export const queryTrackingContextInputSchema = z.object({
  providers: z.array(providerNameSchema).min(1),
  models: z.record(providerNameSchema, z.string().trim().min(1)),
  location: z.string().trim().min(1).nullable(),
}).strict()
export type QueryTrackingContextInput = z.output<typeof queryTrackingContextInputSchema>

export const queryTrackingAdditionSchema = z.object({
  input: queryTrackingSourceInputSchema,
  audience: queryTrackingAudienceSchema.optional(),
  /** New non-market portfolio assignments must select their full context explicitly. */
  contexts: z.array(queryTrackingContextInputSchema).min(1).optional(),
  /** Omission delegates to the shared server classifier; a supplied class is an operator decision. */
  queryClass: queryClassSchema.optional(),
}).strict()
export type QueryTrackingAddition = z.output<typeof queryTrackingAdditionSchema>

export const queryTrackingRemovalSchema = z.object({
  queryId: queryTrackingIdSchema.optional(),
  queryText: queryTrackingTextSchema.optional(),
  audience: queryTrackingAudienceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.queryId === undefined) === (value.queryText === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of queryId or queryText.' })
  }
})
export type QueryTrackingRemoval = z.output<typeof queryTrackingRemovalSchema>

export const queryTrackingMutationSchema = z.object({
  additions: z.array(queryTrackingAdditionSchema),
  removals: z.array(queryTrackingRemovalSchema),
}).strict()
export type QueryTrackingMutation = z.output<typeof queryTrackingMutationSchema>

export const queryTrackingPreviewRequestSchema = queryTrackingMutationSchema.extend({
  expectedWorkspaceVersion: queryTrackingWorkspaceVersionSchema,
}).strict()
export type QueryTrackingPreviewRequest = z.output<typeof queryTrackingPreviewRequestSchema>

export const queryTrackingCommitRequestSchema = queryTrackingPreviewRequestSchema.extend({
  previewToken: queryTrackingPreviewTokenSchema,
  /** Echo the server-minted preview timestamp; it is part of the review token. */
  reviewedAt: queryTrackingReviewedAtSchema,
}).strict()
export type QueryTrackingCommitRequest = z.output<typeof queryTrackingCommitRequestSchema>

export const queryTrackingTargetSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
}).strict()
export type QueryTrackingTarget = z.output<typeof queryTrackingTargetSchema>

export const queryTrackingGroupSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  targetKeys: z.array(measurementV2StableKeySchema),
}).strict()
export type QueryTrackingGroup = z.output<typeof queryTrackingGroupSchema>

export const queryTrackingMarketSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  usageEdges: z.array(measurementV2UsageEdgeSchema),
}).strict()
export type QueryTrackingMarket = z.output<typeof queryTrackingMarketSchema>

export const queryTrackingAssignmentSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  groupKeys: z.array(measurementV2StableKeySchema),
  marketKeys: z.array(measurementV2StableKeySchema),
  queryClass: queryClassSchema.nullable(),
  classificationSource: z.enum(['frozen', 'server', 'operator']),
  /** Complete provider/model/location contexts, never a label-only reconstruction. */
  contexts: z.array(measurementV2ExecutionContextSchema).min(1),
}).strict()
export type QueryTrackingAssignment = z.output<typeof queryTrackingAssignmentSchema>

export const queryTrackingTrackedRowSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  normalizedText: queryTrackingTextSchema,
  provenance: queryTrackingProvenanceSchema.nullable(),
  /** The server resolves measurement availability against the active frozen revision. */
  state: z.enum(['tracked', 'awaiting-sweep']),
  lastMeasuredAt: z.string().datetime().nullable(),
  assignments: z.array(queryTrackingAssignmentSchema),
}).strict()
export type QueryTrackingTrackedRow = z.output<typeof queryTrackingTrackedRowSchema>

export const queryTrackingResearchCandidateSchema = z.object({
  researchRunId: queryTrackingIdSchema,
  researchRunQueryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  createdAt: z.string().datetime(),
}).strict()
export type QueryTrackingResearchCandidate = z.output<typeof queryTrackingResearchCandidateSchema>

export const queryTrackingDiscoveryCandidateSchema = z.object({
  discoverySessionId: queryTrackingIdSchema,
  discoveryProbeId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  createdAt: z.string().datetime(),
}).strict()
export type QueryTrackingDiscoveryCandidate = z.output<typeof queryTrackingDiscoveryCandidateSchema>

export const queryTrackingWorkspaceResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  defaultContexts: z.array(measurementV2ExecutionContextSchema),
  targets: z.array(queryTrackingTargetSchema),
  groups: z.array(queryTrackingGroupSchema),
  markets: z.array(queryTrackingMarketSchema),
  tracked: z.array(queryTrackingTrackedRowSchema),
  savedSources: z.object({
    research: z.array(queryTrackingResearchCandidateSchema),
    discovery: z.array(queryTrackingDiscoveryCandidateSchema),
  }).strict(),
}).strict()
export type QueryTrackingWorkspaceResponse = z.output<typeof queryTrackingWorkspaceResponseSchema>

export const queryTrackingChangeRowSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  assignmentCount: z.number().int().nonnegative(),
}).strict()
export type QueryTrackingChangeRow = z.output<typeof queryTrackingChangeRowSchema>

export const queryTrackingDiffSchema = z.object({
  added: z.array(queryTrackingChangeRowSchema),
  removed: z.array(queryTrackingChangeRowSchema),
  reused: z.array(queryTrackingChangeRowSchema),
  unchanged: z.array(queryTrackingChangeRowSchema),
  noOp: z.boolean(),
}).strict()
export type QueryTrackingDiff = z.output<typeof queryTrackingDiffSchema>

/** Provider work is a deduplicated execution-node count, not an assignment count. */
export const queryTrackingWorkloadSchema = z.object({
  existingNodes: z.number().int().nonnegative(),
  existingProviderCalls: z.number().int().nonnegative(),
  nextSweepNodes: z.number().int().nonnegative(),
  nextSweepProviderCalls: z.number().int().nonnegative(),
  addedNodes: z.number().int().nonnegative(),
  addedProviderCalls: z.number().int().nonnegative(),
  removedNodes: z.number().int().nonnegative(),
  removedProviderCalls: z.number().int().nonnegative(),
}).strict()
export type QueryTrackingWorkload = z.output<typeof queryTrackingWorkloadSchema>

export const queryTrackingPreviewResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  previewToken: queryTrackingPreviewTokenSchema,
  /** Server time when this exact preview was constructed. Echo in commit. */
  reviewedAt: queryTrackingReviewedAtSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  tracked: z.array(queryTrackingTrackedRowSchema),
  diff: queryTrackingDiffSchema,
  workload: queryTrackingWorkloadSchema,
}).strict()
export type QueryTrackingPreviewResponse = z.output<typeof queryTrackingPreviewResponseSchema>

export const queryTrackingCommitResponseSchema = z.object({
  committed: z.boolean(),
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  reviewedAt: queryTrackingReviewedAtSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  diff: queryTrackingDiffSchema,
  workload: queryTrackingWorkloadSchema,
}).strict()
export type QueryTrackingCommitResponse = z.output<typeof queryTrackingCommitResponseSchema>
