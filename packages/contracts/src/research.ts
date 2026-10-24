import { z } from 'zod'
import { answerEvidenceSchema } from './answer-evidence.js'
import { answerServiceProfileSummarySchema } from './answer-service.js'
import { providerKindSchema } from './provider-eligibility.js'
import { providerSelectionKindSchema } from './provider-routes.js'
import { measurementV2StableKeySchema } from './measurement-plan-v2.js'
import { expandQueryTemplate, queryTemplateBindings, queryTrackingTemplateProvenanceSchema } from './query-tracking.js'
import { queryClassSchema } from './query-class.js'
import { locationContextSchema, type LocationContext } from './provider.js'
import { citationStateSchema } from './run.js'
import { groundingSourceSchema, retrievedSourceSchema } from './run.js'
import { userRoleSchema } from './users.js'
import { normalizeQueryText } from './query-normalize.js'
import { validationError } from './errors.js'

/**
 * `waiting-upstream` is not terminal: every query that could finish here has
 * finished, and at least one waits on an upstream job (see the query status).
 */
export const researchRunStatusSchema = z.enum(['queued', 'running', 'waiting-upstream', 'completed', 'partial', 'failed'])
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>
export const ResearchRunStatuses = researchRunStatusSchema.enum

/** The run statuses after which nothing about the run changes again. */
export const TERMINAL_RESEARCH_RUN_STATUSES = [ResearchRunStatuses.completed, ResearchRunStatuses.partial, ResearchRunStatuses.failed] as const satisfies readonly ResearchRunStatus[]

/**
 * `waiting-upstream` is not terminal: the service accepted the query as an
 * upstream job that the adapter can follow (its id is `upstreamJobId`). It
 * counts as neither completed nor failed; a job executor resumes it from that
 * id and never submits it again.
 */
export const researchQueryStatusSchema = z.enum(['queued', 'running', 'waiting-upstream', 'completed', 'failed'])
export type ResearchQueryStatus = z.infer<typeof researchQueryStatusSchema>
export const ResearchQueryStatuses = researchQueryStatusSchema.enum

export const DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT = 20
/** Maximum saved destinations accepted by one multi-destination research request. */
export const MAX_RESEARCH_BATCH_RUNS = 20
/** Maximum concrete editor queries across all destinations in one request. */
export const MAX_RESEARCH_BATCH_QUERIES = 50

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

/** Every name of the kinds the scope and the search location provide (`QUERY_TEMPLATE_VARIABLE_NAMES`). */
export function researchTemplateBindings(
  scope: Pick<ResearchRunScope, 'kind' | 'label'> | null | undefined,
  location?: Pick<LocationContext, 'label'> | null,
): Record<string, string> {
  const scopeBindings: Record<string, string> = !scope
    ? {}
    : queryTemplateBindings(scope.kind === 'market' ? 'market' : 'locationName', scope.label)
  return location ? { ...scopeBindings, ...queryTemplateBindings('searchLocation', location.label) } : scopeBindings
}

/** Editor previews and saved provenance use the same declared variables in the same order. */
export function expandResearchTemplate(
  template: { pattern: string; variables: readonly string[] },
  scope: Pick<ResearchRunScope, 'kind' | 'label'> | null | undefined,
  location?: Pick<LocationContext, 'label'> | null,
): { bindings: Record<string, string>; output: string } {
  const declared = new Set(template.variables)
  const placeholders = [...template.pattern.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!)
  const undeclared = [...new Set(placeholders.filter(variable => !declared.has(variable)))]
  if (undeclared.length) throw validationError('The selected research template contains undeclared placeholders: ' + undeclared.join(', '))
  const available = researchTemplateBindings(scope, location)
  const unavailable = template.variables.filter(variable => available[variable] === undefined)
  if (unavailable.length) throw validationError('The selected research template requires unavailable bindings: ' + unavailable.join(', '))
  const bindings = Object.fromEntries(template.variables.map(variable => [variable, available[variable]!]))
  return { bindings, output: expandQueryTemplate(template.pattern, bindings) }
}

export const researchTemplateSelectionSchema = z.object({
  templateId: z.string().trim().min(1).max(256),
  templateVersion: z.string().trim().min(1).max(256),
  /** Original preview context used to expand names, independent of the final engine location. */
  bindingLocation: locationContextSchema.nullable().optional(),
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

const researchBatchScopeSelectionSchema = researchScopeSelectionSchema.extend({
  expectedPlanRevision: z.number().int().positive(),
}).strict()

const researchBatchRunCreateSchema = z.object({
  queries: z.array(researchQueryTextSchema).min(1).max(MAX_RESEARCH_BATCH_QUERIES),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).max(200),
  location: locationContextSchema.nullable(),
  scope: researchBatchScopeSelectionSchema.optional(),
  template: researchTemplateSelectionSchema.optional(),
}).strict()

/**
 * A bounded set of explicit research destinations. Each destination remains an
 * ordinary saved ResearchRun; the root idempotency key covers the whole set.
 */
export const researchBatchCreateSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  runs: z.array(researchBatchRunCreateSchema).min(1).max(MAX_RESEARCH_BATCH_RUNS),
}).strict().superRefine((value, ctx) => {
  const totalQueries = value.runs.reduce((total, run) => total + run.queries.length, 0)
  if (totalQueries > MAX_RESEARCH_BATCH_QUERIES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runs'], message: `A research batch may contain at most ${MAX_RESEARCH_BATCH_QUERIES} concrete queries across all destinations` })
  }
})
export type ResearchBatchCreate = z.infer<typeof researchBatchCreateSchema>

export const researchRunPrincipalSchema = z.object({
  kind: z.enum(['api-key', 'user']),
  id: z.string(),
  name: z.string(),
  role: userRoleSchema.nullable(),
  /** Consumes the shared limited-research budget. Legacy viewers count by role. */
  limited: z.boolean().optional(),
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
  /** Pages the engine's searches listed or opened; never cited evidence. Null when the engine does not report them. */
  retrievedSources: z.array(retrievedSourceSchema).nullable().default(null),
  namedCompetitors: z.array(z.string()).default([]), citedCompetitorDomains: z.array(z.string()).default([]),
  answerMentioned: z.boolean().nullable(), citationState: citationStateSchema.nullable(), error: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), createdAt: z.string(),
  /** Source relationships, completion, identity and usage basis. Null for engines that record none. */
  evidence: answerEvidenceSchema.nullable().optional(),
  /**
   * Whether `citationState` was measured. False when the answer's sources are
   * not tied to the answer (search results only), so citationState stays null.
   */
  citationMeasured: z.boolean().optional(),
  /** The upstream job a `waiting-upstream` query waits on. Absent or null otherwise. */
  upstreamJobId: z.string().nullable().optional(),
})
export type ResearchRunQueryDto = z.infer<typeof researchRunQuerySchema>

export const researchRunDetailSchema = researchRunSummarySchema.extend({ queries: z.array(researchRunQuerySchema) })
export type ResearchRunDetailDto = z.infer<typeof researchRunDetailSchema>
export const researchBatchSchema = z.object({ runs: z.array(researchRunDetailSchema) })
export type ResearchBatchDto = z.infer<typeof researchBatchSchema>
/** Safe model choices for research; excludes credentials and instance settings. */
export const researchProviderOptionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  modelConfigurable: z.boolean(),
  defaultModel: z.string(),
  knownModels: z.array(z.object({ id: z.string(), displayName: z.string() })),
  /** Absent means an answer engine. */
  kind: providerKindSchema.optional(),
  /** The connection whose key and quota this option uses. */
  connection: z.string().optional(),
  /** `profile` for an answer-service route, `model` for an OpenRouter route. */
  selectionKind: providerSelectionKindSchema.nullable().optional(),
  /** The pinned answer-service profile behind this option. */
  profiles: z.array(answerServiceProfileSummarySchema).optional(),
})
export type ResearchProviderOption = z.infer<typeof researchProviderOptionSchema>

export const researchRunListSchema = z.object({
  runs: z.array(researchRunSummarySchema),
  /** Opaque continuation after the last returned (createdAt, id); null ends history. */
  nextCursor: z.string().nullable().optional(),
  providers: z.array(researchProviderOptionSchema).optional(),
  /** Credential-specific admission policy, shared by UI, CLI and MCP consumers. */
  access: z.object({ canRun: z.boolean(), dailyRunLimit: z.number().int().positive().nullable() }).optional(),
})
export type ResearchRunListDto = z.infer<typeof researchRunListSchema>
