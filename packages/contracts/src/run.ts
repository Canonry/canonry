import { z } from 'zod'
import { providerNameSchema } from './provider.js'

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof runStatusSchema>
export const RunStatuses = runStatusSchema.enum

export const runKindSchema = z.enum([
  'answer-visibility',
  'site-audit',
  'gsc-sync',
  'inspect-sitemap',
  'ga-sync',
  'bing-inspect',
  'bing-inspect-sitemap',
  'backlink-extract',
])
export type RunKind = z.infer<typeof runKindSchema>
export const RunKinds = runKindSchema.enum

export const runTriggerSchema = z.enum(['manual', 'scheduled', 'config-apply'])
export type RunTrigger = z.infer<typeof runTriggerSchema>
export const RunTriggers = runTriggerSchema.enum

export const citationStateSchema = z.enum(['cited', 'not-cited'])
export type CitationState = z.infer<typeof citationStateSchema>
export const CitationStates = citationStateSchema.enum

export const visibilityStateSchema = z.enum(['visible', 'not-visible'])
export type VisibilityState = z.infer<typeof visibilityStateSchema>
export const VisibilityStates = visibilityStateSchema.enum

export const computedTransitionSchema = z.enum(['new', 'cited', 'lost', 'emerging', 'not-cited'])
export type ComputedTransition = z.infer<typeof computedTransitionSchema>
export const ComputedTransitions = computedTransitionSchema.enum

export const runTriggerRequestSchema = z.object({
  kind: z.literal(RunKinds['answer-visibility']).optional(),
  trigger: z.literal(RunTriggers.manual).optional(),
  providers: z.array(providerNameSchema).optional(),
  location: z.string().min(1).optional(),
  allLocations: z.boolean().optional(),
  noLocation: z.boolean().optional(),
}).refine(
  (data) => Number(Boolean(data.location)) + Number(Boolean(data.allLocations)) + Number(Boolean(data.noLocation)) <= 1,
  { message: 'Only one of "location", "allLocations", or "noLocation" may be provided' },
)

export type RunTriggerRequest = z.infer<typeof runTriggerRequestSchema>

export const runDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: runKindSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema.default('manual'),
  location: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
})

export type RunDto = z.infer<typeof runDtoSchema>

export const groundingSourceSchema = z.object({
  uri: z.string(),
  title: z.string(),
})

export type GroundingSource = z.infer<typeof groundingSourceSchema>

export const querySnapshotDtoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  keywordId: z.string(),
  keyword: z.string().optional(),
  provider: providerNameSchema,
  citationState: citationStateSchema,
  answerMentioned: z.boolean().optional(),
  visibilityState: visibilityStateSchema.optional(),
  transition: computedTransitionSchema.optional(),
  answerText: z.string().nullable().optional(),
  citedDomains: z.array(z.string()).default([]),
  competitorOverlap: z.array(z.string()).default([]),
  recommendedCompetitors: z.array(z.string()).default([]),
  matchedTerms: z.array(z.string()).default([]),
  groundingSources: z.array(groundingSourceSchema).default([]),
  searchQueries: z.array(z.string()).default([]),
  model: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  createdAt: z.string(),
})

export type QuerySnapshotDto = z.infer<typeof querySnapshotDtoSchema>

export const snapshotListResponseSchema = z.object({
  snapshots: z.array(querySnapshotDtoSchema),
  total: z.number().int().nonnegative(),
})

export type SnapshotListResponse = z.infer<typeof snapshotListResponseSchema>

export const snapshotDiffRowSchema = z.object({
  keywordId: z.string().nullable(),
  keyword: z.string().nullable(),
  run1State: citationStateSchema.nullable(),
  run2State: citationStateSchema.nullable(),
  run1AnswerMentioned: z.boolean().nullable(),
  run2AnswerMentioned: z.boolean().nullable(),
  run1VisibilityState: visibilityStateSchema.nullable(),
  run2VisibilityState: visibilityStateSchema.nullable(),
  changed: z.boolean(),
  visibilityChanged: z.boolean(),
})

export type SnapshotDiffRow = z.infer<typeof snapshotDiffRowSchema>

export const snapshotDiffResponseSchema = z.object({
  run1: z.string(),
  run2: z.string(),
  diff: z.array(snapshotDiffRowSchema),
})

export type SnapshotDiffResponse = z.infer<typeof snapshotDiffResponseSchema>

export const runDetailDtoSchema = runDtoSchema.extend({
  snapshots: z.array(querySnapshotDtoSchema).optional(),
})

export type RunDetailDto = z.infer<typeof runDetailDtoSchema>

export const latestProjectRunDtoSchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  run: runDetailDtoSchema.nullable(),
})

export type LatestProjectRunDto = z.infer<typeof latestProjectRunDtoSchema>

export const auditLogEntrySchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().optional(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable().optional(),
  diff: z.unknown().optional(),
  createdAt: z.string(),
})

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>
