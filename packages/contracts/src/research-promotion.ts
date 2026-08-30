import { z } from 'zod'
import {
  measurementDraftCompileCheckSchema,
  measurementDraftDiffSchema,
  measurementDraftResolvedAudienceGroupSchema,
  measurementSetupModeSchema,
  measurementSetupStateSchema,
} from './measurement-draft.js'
import { measurementPlanV2Schema, measurementV2StableKeySchema } from './measurement-plan-v2.js'
import { queryClassSchema } from './query-class.js'
import { researchQueryStatusSchema } from './research.js'

const nonBlankStringSchema = z.string().refine(value => value.trim().length > 0, 'Must not be blank')

/** A SHA-256 guard over the source, request, current setup, and full projection. */
export const researchPromotionPreviewChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/)
export type ResearchPromotionPreviewChecksum = z.output<typeof researchPromotionPreviewChecksumSchema>

/**
 * Optional assignment intent for an active v2 plan. Empty selection is valid
 * for a simple project; the server refuses it only when an advanced audience
 * is required.
 */
export const researchPromotionSelectionSchema = z.object({
  queryClass: queryClassSchema.optional(),
  targetKeys: z.array(measurementV2StableKeySchema).optional(),
  groupKeys: z.array(measurementV2StableKeySchema).optional(),
}).strict()
export type ResearchPromotionSelection = z.output<typeof researchPromotionSelectionSchema>

export const researchPromotionPreviewRequestSchema = researchPromotionSelectionSchema
export type ResearchPromotionPreviewRequest = z.output<typeof researchPromotionPreviewRequestSchema>

/** Deliberately excludes answer text, citations, provider, model, and location. */
export const researchPromotionSourceQuerySchema = z.object({
  runId: z.string().trim().min(1),
  queryId: z.string().trim().min(1),
  query: nonBlankStringSchema,
  normalizedQuery: z.string().trim().min(1),
  status: researchQueryStatusSchema,
  completedAt: z.string().datetime().nullable(),
}).strict()
export type ResearchPromotionSourceQuery = z.output<typeof researchPromotionSourceQuerySchema>

/** `proposedId` is stable for one saved research result even when an existing row wins dedupe. */
export const researchPromotionTrackedQuerySchema = z.object({
  state: z.enum(['new', 'existing']),
  id: z.string().trim().min(1),
  proposedId: z.string().trim().min(1),
  query: nonBlankStringSchema,
  normalizedQuery: z.string().trim().min(1),
}).strict()
export type ResearchPromotionTrackedQuery = z.output<typeof researchPromotionTrackedQuerySchema>

export const researchPromotionSetupSchema = z.object({
  state: measurementSetupStateSchema,
  mode: measurementSetupModeSchema,
  activeRevision: z.number().int().positive().nullable(),
  activeCompiledChecksum: researchPromotionPreviewChecksumSchema.nullable(),
  draftEtag: z.string().trim().min(1).nullable(),
}).strict()
export type ResearchPromotionSetup = z.output<typeof researchPromotionSetupSchema>

export const researchPromotionRefusalReasonSchema = z.enum([
  'source-not-completed',
  'active-v1',
  'draft-only',
  'draft-exists',
  'audience-required',
  'audience-invalid',
  'candidate-invalid',
])
export type ResearchPromotionRefusalReason = z.output<typeof researchPromotionRefusalReasonSchema>

export const researchPromotionRefusalSchema = z.object({
  reason: researchPromotionRefusalReasonSchema,
  message: z.string().trim().min(1),
  checks: z.array(measurementDraftCompileCheckSchema).optional(),
}).strict()
export type ResearchPromotionRefusal = z.output<typeof researchPromotionRefusalSchema>

export const researchPromotionResolvedAudienceSchema = z.object({
  targetKeys: z.array(measurementV2StableKeySchema),
  groups: z.array(measurementDraftResolvedAudienceGroupSchema),
  overlapCount: z.number().int().nonnegative(),
}).strict()
export type ResearchPromotionResolvedAudience = z.output<typeof researchPromotionResolvedAudienceSchema>

export const researchPromotionAssignmentImpactSchema = z.object({
  requested: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  alreadyPresent: z.number().int().nonnegative(),
  classifications: z.array(z.object({
    targetKey: measurementV2StableKeySchema,
    queryId: z.string().trim().min(1),
    queryClass: queryClassSchema,
  }).strict()),
}).strict()
export type ResearchPromotionAssignmentImpact = z.output<typeof researchPromotionAssignmentImpactSchema>

export const researchPromotionExecutionImpactSchema = z.object({
  addedNodes: z.number().int().nonnegative(),
  addedProviderCalls: z.number().int().nonnegative(),
  fullRunNodes: z.number().int().nonnegative(),
  fullRunProviderCalls: z.number().int().nonnegative(),
}).strict()
export type ResearchPromotionExecutionImpact = z.output<typeof researchPromotionExecutionImpactSchema>

const researchPromotionPreviewBaseSchema = z.object({
  source: researchPromotionSourceQuerySchema,
  trackedQuery: researchPromotionTrackedQuerySchema,
  setup: researchPromotionSetupSchema,
  previewChecksum: researchPromotionPreviewChecksumSchema,
})

export const researchPromotionPreviewResponseSchema = z.discriminatedUnion('mode', [
  researchPromotionPreviewBaseSchema.extend({
    mode: z.literal('simple'),
  }).strict(),
  researchPromotionPreviewBaseSchema.extend({
    mode: z.literal('advanced'),
    selection: researchPromotionSelectionSchema,
    audience: researchPromotionResolvedAudienceSchema,
    assignments: researchPromotionAssignmentImpactSchema,
    execution: researchPromotionExecutionImpactSchema,
    candidate: z.object({
      compiledChecksum: researchPromotionPreviewChecksumSchema,
      checks: z.array(measurementDraftCompileCheckSchema),
      plan: measurementPlanV2Schema,
      diff: measurementDraftDiffSchema,
    }).strict(),
  }).strict(),
  researchPromotionPreviewBaseSchema.extend({
    mode: z.literal('refused'),
    refusal: researchPromotionRefusalSchema,
  }).strict(),
])
export type ResearchPromotionPreviewResponse = z.output<typeof researchPromotionPreviewResponseSchema>

/**
 * Reserved for the PR2 mutation route. Repeating the exact preview selection
 * lets the mutation recompute and verify the checksum instead of trusting a
 * detached token.
 */
export const researchPromotionCommitRequestSchema = z.object({
  previewChecksum: researchPromotionPreviewChecksumSchema,
  request: researchPromotionPreviewRequestSchema,
}).strict()
export type ResearchPromotionCommitRequest = z.output<typeof researchPromotionCommitRequestSchema>

export const researchPromotionCommitResultSchema = z.object({
  status: z.literal('tracked-awaiting-first-sweep'),
  mode: z.enum(['simple', 'advanced']),
  source: researchPromotionSourceQuerySchema,
  trackedQuery: researchPromotionTrackedQuerySchema,
  publishedRevision: z.number().int().positive().nullable(),
  compiledChecksum: researchPromotionPreviewChecksumSchema.nullable(),
}).strict()
export type ResearchPromotionCommitResult = z.output<typeof researchPromotionCommitResultSchema>
