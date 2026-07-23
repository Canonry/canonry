import { z } from 'zod'
import { locationContextSchema } from './provider.js'
import { citationStateSchema } from './run.js'
import { groundingSourceSchema } from './run.js'

export const researchRunStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed'])
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>
export const ResearchRunStatuses = researchRunStatusSchema.enum

export const researchQueryStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])
export type ResearchQueryStatus = z.infer<typeof researchQueryStatusSchema>
export const ResearchQueryStatuses = researchQueryStatusSchema.enum

export const researchRunCreateSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(4000)).min(1).max(50),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  location: locationContextSchema.nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.model && !value.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'provider is required when model is supplied' })
})
export type ResearchRunCreate = z.infer<typeof researchRunCreateSchema>

export const researchRunSummarySchema = z.object({
  id: z.string(), projectId: z.string(), status: researchRunStatusSchema,
  provider: z.string(), requestedModel: z.string().nullable(), resolvedModel: z.string(),
  location: locationContextSchema.nullable(), totalQueries: z.number().int(),
  completedQueries: z.number().int(), failedQueries: z.number().int(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), createdAt: z.string(),
})
export type ResearchRunSummaryDto = z.infer<typeof researchRunSummarySchema>

export const researchRunQuerySchema = z.object({
  id: z.string(), position: z.number().int(), query: z.string(), status: researchQueryStatusSchema,
  requestedModel: z.string().nullable(), resolvedModel: z.string(), servedModel: z.string().nullable(),
  answerText: z.string().nullable(), groundingSources: z.array(groundingSourceSchema), citedDomains: z.array(z.string()), searchQueries: z.array(z.string()),
  answerMentioned: z.boolean().nullable(), citationState: citationStateSchema.nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), createdAt: z.string(),
})
export type ResearchRunQueryDto = z.infer<typeof researchRunQuerySchema>

export const researchRunDetailSchema = researchRunSummarySchema.extend({ queries: z.array(researchRunQuerySchema) })
export type ResearchRunDetailDto = z.infer<typeof researchRunDetailSchema>
export const researchRunListSchema = z.object({ runs: z.array(researchRunSummarySchema) })
export type ResearchRunListDto = z.infer<typeof researchRunListSchema>
