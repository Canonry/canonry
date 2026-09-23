import { z } from 'zod'
import { visibilityReportRequestSchema, type VisibilityReportResponse } from './visibility-report.js'

/** A turn's displayed selection, never an authorization grant. */
export const agentViewContextSchema = z.object({
  view: z.enum(['project', 'visibility', 'property', 'queries', 'site-health']),
  unavailableReason: z.string().trim().min(1).max(512).optional(),
  selection: visibilityReportRequestSchema.optional(),
  page: z.object({
    runId: z.string().trim().min(1).max(256).optional(),
    nodeKey: z.string().trim().min(1).max(2048).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.page && value.view !== 'site-health') ctx.addIssue({ code: 'custom', message: 'Page context requires Site Health.' })
  if (value.selection && !['visibility', 'property', 'queries'].includes(value.view)) ctx.addIssue({ code: 'custom', message: 'Measurement selection requires a measurement view.' })
})
export type AgentViewContext = z.infer<typeof agentViewContextSchema>

export const agentTurnLimitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(1000).max(600_000).default(180_000),
}).strict()
export type AgentTurnLimits = z.infer<typeof agentTurnLimitsSchema>

/** Read-only evidence packing; all rates and changes come from the report API. */
export function agentVisibilityEvidence(report: VisibilityReportResponse, project: string, retrievedAt: string) {
  const selection = report.selection
  const search = new URLSearchParams({ queryClass: selection.queryClass, measurementScope: selection.scope.kind })
  if (selection.scope.kind !== 'project') search.set('measurementScopeKey', selection.scope.id)
  const fields = {
    measurementMarketKey: selection.market?.id,
    measurementProvider: selection.provider,
    measurementModel: selection.model,
    measurementLocation: selection.location.kind === 'exact' ? selection.location.value : selection.location.kind === 'none' ? 'none' : null,
    measurementFrom: selection.time.from,
    measurementTo: selection.time.to,
    measurementRunId: selection.run.id,
    measurementRevision: selection.revision?.toString(),
  }
  for (const [key, value] of Object.entries(fields)) if (value != null) search.set(key, value)
  return {
    source: {
      label: 'Open measured evidence',
      // Relative to the dashboard base, so reverse-proxy prefixes survive.
      path: `projects/${encodeURIComponent(project)}?${search}`,
      retrievedAt,
      measuredAt: selection.measurement.completedAt,
    },
    selection,
    populations: report.populations.map(population => {
      const { items: _items, ...page } = population.evidence
      return {
        queryClass: population.queryClass,
        summary: population.summary,
        comparison: population.comparison ?? null,
        evidence: page,
      }
    }),
    interpretation: 'These are observations, not proof of causation. Preserve independent query classes, unavailable values, comparison reasons, and evidence pagination. Retrieved time is not measurement time. Open query detail for answer text and sources. Paginated observations are never the coverage denominator.',
    // Keep all class summaries ahead of the independently trimmable rows.
    // A large first-class answer must never evict the other denominators.
    observations: report.populations.flatMap(population => population.evidence.items.map(
      ({ answerText: _answerText, sources: _sources, observedCompetitors: _competitors, ...row }) => ({ queryClass: population.queryClass, ...row }),
    )),
  }
}
export type AgentVisibilityEvidence = ReturnType<typeof agentVisibilityEvidence>

/**
 * Identifier of one of Aero's supported LLM providers. Canonical IDs live
 * in `providers.ts` — `AgentProviderIds` is the runtime enum, this is the
 * derived union. The agent-side mapping to pi-ai vendor names (e.g.
 * `claude` → `anthropic`) lives in `packages/canonry/src/agent/providers.ts`.
 */
export type { AgentProviderId } from './providers.js'

/**
 * Zod mirror of `AgentProviderId`. Kept inline here (rather than derived
 * from `AGENT_PROVIDER_IDS`) so `z.toJSONSchema` produces a literal enum
 * in the OpenAPI components — the SDK needs that to emit a string-union
 * type instead of a bare `string`.
 */
export const agentProviderIdSchema = z.enum(['claude', 'openai', 'gemini', 'zai', 'deepinfra'])

export const agentProviderOptionDtoSchema = z.object({
  /** Stable identifier — what clients pass back as `provider` on the prompt endpoint. */
  id: agentProviderIdSchema,
  /** Human-readable label for UI pickers, e.g. "Anthropic (Claude)". */
  label: z.string(),
  /** Default model if the caller doesn't pick one. */
  defaultModel: z.string(),
  /** Whether a usable API key was found (config.yaml or provider env var). */
  configured: z.boolean(),
  /**
   * Where the key resolved from, if any. `null` when `configured === false`.
   * Surfaced so the UI can nudge users toward their preferred source of truth.
   */
  keySource: z.enum(['config', 'env']).nullable(),
})
export type AgentProviderOption = z.infer<typeof agentProviderOptionDtoSchema>

export const agentProvidersResponseDtoSchema = z.object({
  /**
   * Every provider Aero knows about. `configured === false` entries are
   * included so the UI can render them disabled with an onboarding hint.
   */
  providers: z.array(agentProviderOptionDtoSchema).default([]),
  /**
   * Provider a new session uses when the caller names none: the
   * `agent.provider` pin when set (reported even without a key, as its
   * `configured: false` entry), else the first configured provider by
   * priority. An existing unpinned session keeps its stored provider. Null
   * when nothing is pinned and nothing is configured.
   */
  defaultProvider: agentProviderIdSchema.nullable(),
})
export type AgentProvidersResponse = z.infer<typeof agentProvidersResponseDtoSchema>

/**
 * Source tag for a durable Aero note. `aero` = agent-authored via the
 * `remember` tool; `user` = operator-authored via CLI/API; `compaction` =
 * LLM-summarized transcript slice.
 */
export const memorySourceSchema = z.enum(['aero', 'user', 'compaction'])
export type MemorySource = z.infer<typeof memorySourceSchema>
export const MemorySources = memorySourceSchema.enum

/**
 * Hard cap on the `value` column in `agent_memory`. Enforced at every
 * write boundary (tool, API, compaction) so the `<memory>` system-prompt
 * block stays bounded.
 */
export const AGENT_MEMORY_VALUE_MAX_BYTES = 2 * 1024

/**
 * Maximum length of a memory key. 128 bytes is enough for
 * `compaction:<uuid>:<iso-ts>` while staying short enough to keep hydrate
 * blocks readable.
 */
export const AGENT_MEMORY_KEY_MAX_LENGTH = 128

export interface AgentMemoryEntryDto {
  id: string
  key: string
  value: string
  source: MemorySource
  createdAt: string
  updatedAt: string
}

export interface AgentMemoryListResponse {
  entries: AgentMemoryEntryDto[]
}

export const agentMemoryUpsertRequestSchema = z.object({
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH),
  value: z.string().min(1),
})
export type AgentMemoryUpsertRequest = z.infer<typeof agentMemoryUpsertRequestSchema>

export const agentMemoryDeleteRequestSchema = z.object({
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH),
})
export type AgentMemoryDeleteRequest = z.infer<typeof agentMemoryDeleteRequestSchema>

export const agentPromptRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  conversationId: z.string().min(1).nullable().optional(),
  provider: agentProviderIdSchema.optional(),
  modelId: z.string().trim().min(1).optional(),
  scope: z.enum(['all', 'read-only']).optional(),
  profile: z.enum(['default', 'ads-operator']).optional(),
  context: agentViewContextSchema.optional(),
  limits: agentTurnLimitsSchema.optional(),
})
export type AgentPromptRequest = z.infer<typeof agentPromptRequestSchema>

// Message payloads are extensible pi-agent records; the envelope is stable.
export const agentConversationMessageSchema = z.looseObject({ role: z.string(), content: z.unknown().optional() })
export const agentConversationSummarySchema = z.object({
  id: z.string(), title: z.string(), active: z.boolean(),
  modelProvider: z.string(), modelId: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
})
export const agentConversationSchema = agentConversationSummarySchema.extend({
  messages: z.array(agentConversationMessageSchema), isStreaming: z.boolean(),
})
export const agentConversationListSchema = z.object({
  conversations: z.array(agentConversationSummarySchema),
  currentConversationId: z.string().nullable(), nextOffset: z.number().int().nullable(),
})
export const agentConversationCreateSchema = z.object({
  id: z.uuid(),
}).strict()
export const agentConversationDeleteSchema = z.object({ id: z.string(), status: z.literal('deleted') })
export type AgentConversationSummary = z.infer<typeof agentConversationSummarySchema>
export type AgentConversation = z.infer<typeof agentConversationSchema>
export type AgentConversationList = z.infer<typeof agentConversationListSchema>
export type AgentConversationDelete = z.infer<typeof agentConversationDeleteSchema>

/** A deterministic title: no provider call, and no proactive system prompt as a title. */
export function agentConversationTitle(messages: Array<{ role: string; content?: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const content = message.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.flatMap((block: unknown) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join(' ')
      : ''
    const title = text.replace(/\s+/g, ' ').trim()
    if (title && !title.startsWith('[system]')) return title.length > 80 ? title.slice(0, 79) + '…' : title
  }
  return 'New conversation'
}

export const agentConversationListQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
