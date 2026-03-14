import { z } from 'zod'
import { providerNameSchema } from './provider.js'

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed'])
export type RunStatus = z.infer<typeof runStatusSchema>

export const runKindSchema = z.enum(['answer-visibility', 'site-audit', 'gsc-sync'])
export type RunKind = z.infer<typeof runKindSchema>

export const runTriggerSchema = z.enum(['manual', 'scheduled', 'config-apply'])
export type RunTrigger = z.infer<typeof runTriggerSchema>

export const citationStateSchema = z.enum(['cited', 'not-cited'])
export type CitationState = z.infer<typeof citationStateSchema>

export const computedTransitionSchema = z.enum(['new', 'cited', 'lost', 'emerging', 'not-cited'])
export type ComputedTransition = z.infer<typeof computedTransitionSchema>

export const runDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: runKindSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema.default('manual'),
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
  transition: computedTransitionSchema.optional(),
  answerText: z.string().nullable().optional(),
  citedDomains: z.array(z.string()).default([]),
  competitorOverlap: z.array(z.string()).default([]),
  groundingSources: z.array(groundingSourceSchema).default([]),
  searchQueries: z.array(z.string()).default([]),
  model: z.string().nullable().optional(),
  createdAt: z.string(),
})

export type QuerySnapshotDto = z.infer<typeof querySnapshotDtoSchema>

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
