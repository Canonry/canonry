import { z } from 'zod'
import { measurementV2StableKeySchema } from './measurement-plan-v2.js'
import { expandQueryTemplate, queryTrackingTemplateProvenanceSchema } from './query-tracking.js'
import { queryClassSchema } from './query-class.js'
import { locationContextSchema } from './provider.js'
import { citationStateSchema } from './run.js'
import { groundingSourceSchema } from './run.js'
import { userRoleSchema } from './users.js'
import { normalizeQueryText } from './query-normalize.js'
import { validationError } from './errors.js'

export const researchRunStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed'])
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>
export const ResearchRunStatuses = researchRunStatusSchema.enum

export const researchQueryStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])
export type ResearchQueryStatus = z.infer<typeof researchQueryStatusSchema>
export const ResearchQueryStatuses = researchQueryStatusSchema.enum

export const DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT = 20

/** A named, published Advanced Measurement slice selected for an ad-hoc batch. */
export const researchScopeSelectionSchema = z.object({
  kind: z.enum(['market', 'property']),
  key: measurementV2StableKeySchema,
  /** Guards a reviewed scope preview from silently using a newer plan revision. */
  expectedPlanRevision: z.number().int().positive().optional(),
}).strict()
export type ResearchScopeSelection = z.infer<typeof researchScopeSelectionSchema>

/** Immutable scope context captured when the batch was queued. */
export const researchRunScopeSchema = z.object({
  kind: z.enum(['market', 'property']),
  key: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  planRevision: z.number().int().positive(),
}).strict()
export type ResearchRunScope = z.infer<typeof researchRunScopeSchema>

export const researchQueryTextSchema = z.string().min(1).max(4000).refine(value => value.trim().length > 0, 'Research queries cannot be blank.')

/** Compare query identities without changing the first submitted question's text. */
export function deduplicateResearchQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>()
  return queries.filter(query => {
    const key = normalizeQueryText(query)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function researchTemplateBindings(scope: Pick<ResearchRunScope, 'kind' | 'label'> | null | undefined): Record<string, string> {
  if (!scope) return {}
  return scope.kind === 'market'
    ? { market: scope.label, submarket: scope.label }
    : { property: scope.label, propertyBrand: scope.label }
}

/** Editor previews and saved provenance use the same declared variables in the same order. */
export function expandResearchTemplate(
  template: { pattern: string; variables: readonly string[] },
  scope: Pick<ResearchRunScope, 'kind' | 'label'>,
): { bindings: Record<string, string>; output: string } {
  const available = researchTemplateBindings(scope)
  const unavailable = template.variables.filter(variable => available[variable] === undefined)
  if (unavailable.length) throw validationError('The selected research template requires unavailable bindings: ' + unavailable.join(', '))
  const bindings = Object.fromEntries(template.variables.map(variable => [variable, available[variable]!]))
  return { bindings, output: expandQueryTemplate(template.pattern, bindings) }
}

export const researchTemplateSelectionSchema = z.object({
  templateId: z.string().trim().min(1).max(256),
  templateVersion: z.string().trim().min(1).max(256),
}).strict()
export type ResearchTemplateSelection = z.infer<typeof researchTemplateSelectionSchema>

export const researchRunCreateSchema = z.object({
  queries: z.array(researchQueryTextSchema).min(1).max(50),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  location: locationContextSchema.nullable().optional(),
  scope: researchScopeSelectionSchema.optional(),
  template: researchTemplateSelectionSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.model && !value.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'provider is required when model is supplied' })
})
export type ResearchRunCreate = z.infer<typeof researchRunCreateSchema>

export const researchRunPrincipalSchema = z.object({
  kind: z.enum(['api-key', 'user']),
  id: z.string(),
  name: z.string(),
  role: userRoleSchema.nullable(),
})
export type ResearchRunPrincipal = z.infer<typeof researchRunPrincipalSchema>

export const researchRunSummarySchema = z.object({
  id: z.string(), projectId: z.string(), status: researchRunStatusSchema,
  provider: z.string(), requestedModel: z.string().nullable(), resolvedModel: z.string(),
  location: locationContextSchema.nullable(), scope: researchRunScopeSchema.nullable().optional(), template: queryTrackingTemplateProvenanceSchema.nullable().optional(), totalQueries: z.number().int(),
  completedQueries: z.number().int(), failedQueries: z.number().int(), error: z.string().nullable(),
  initiatedBy: researchRunPrincipalSchema.nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), createdAt: z.string(),
})
export type ResearchRunSummaryDto = z.infer<typeof researchRunSummarySchema>

export const researchRunQuerySchema = z.object({
  id: z.string(), position: z.number().int(), query: z.string(), queryClass: queryClassSchema.nullable().optional(), status: researchQueryStatusSchema,
  requestedModel: z.string().nullable(), resolvedModel: z.string(), servedModel: z.string().nullable(),
  answerText: z.string().nullable(), groundingSources: z.array(groundingSourceSchema), citedDomains: z.array(z.string()), searchQueries: z.array(z.string()),
  namedCompetitors: z.array(z.string()).default([]), citedCompetitorDomains: z.array(z.string()).default([]),
  answerMentioned: z.boolean().nullable(), citationState: citationStateSchema.nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), createdAt: z.string(),
})
export type ResearchRunQueryDto = z.infer<typeof researchRunQuerySchema>

export const researchRunDetailSchema = researchRunSummarySchema.extend({ queries: z.array(researchRunQuerySchema) })
export type ResearchRunDetailDto = z.infer<typeof researchRunDetailSchema>
/** Safe model choices for research; excludes credentials and instance settings. */
export const researchProviderOptionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  modelConfigurable: z.boolean(),
  defaultModel: z.string(),
  knownModels: z.array(z.object({ id: z.string(), displayName: z.string() })),
})
export type ResearchProviderOption = z.infer<typeof researchProviderOptionSchema>

export const researchRunListSchema = z.object({
  runs: z.array(researchRunSummarySchema),
  providers: z.array(researchProviderOptionSchema).optional(),
})
export type ResearchRunListDto = z.infer<typeof researchRunListSchema>
