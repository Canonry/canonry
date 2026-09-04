import { z } from 'zod'
import { isAgentProviderId, type AgentProviderId } from './providers.js'

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

/**
 * A configured OpenAI-compatible route can drive Aero and other text-only
 * work. Native provider IDs remain a closed enum; route IDs stay dynamic so
 * a configured gateway does not require a contracts release for each model.
 */
export type AeroProviderId = AgentProviderId | `route:${string}`

const configuredRouteProviderIdSchema = z.string().regex(
  /^route:\w[\w.:-]*$/,
  'Must be a configured route ID (route:<id>)',
)

export const aeroProviderIdSchema = z.union([
  agentProviderIdSchema,
  configuredRouteProviderIdSchema,
])

export function isAeroProviderId(value: string): value is AeroProviderId {
  return isAgentProviderId(value) || configuredRouteProviderIdSchema.safeParse(value).success
}

export const agentProviderOptionDtoSchema = z.object({
  /** Stable identifier — what clients pass back as `provider` on the prompt endpoint. */
  id: aeroProviderIdSchema,
  /** Human-readable label for UI pickers, e.g. "Anthropic (Claude)". */
  label: z.string(),
  /** Default model if the caller doesn't pick one. */
  defaultModel: z.string(),
  /** Whether the native credential or configured route connection is usable. */
  configured: z.boolean(),
  /**
   * Where a credential resolved from, if any. `null` also covers an
   * intentionally credential-free configured connection (for example local
   * LiteLLM). Surfaced so the UI can nudge native providers toward their
   * preferred source of truth.
   */
  keySource: z.enum(['config', 'env']).nullable(),
})
export type AgentProviderOption = Omit<z.infer<typeof agentProviderOptionDtoSchema>, 'id'> & {
  id: AeroProviderId
}

export const agentProvidersResponseDtoSchema = z.object({
  /**
   * Every provider Aero knows about. `configured === false` entries are
   * included so the UI can render them disabled with an onboarding hint.
   */
  providers: z.array(agentProviderOptionDtoSchema).default([]),
  /**
   * Provider Aero auto-picks when no explicit override is passed. Null if
   * nothing is configured (install never exchanged a key).
   */
  defaultProvider: aeroProviderIdSchema.nullable(),
})
export type AgentProvidersResponse = Omit<z.infer<typeof agentProvidersResponseDtoSchema>, 'providers' | 'defaultProvider'> & {
  providers: AgentProviderOption[]
  defaultProvider: AeroProviderId | null
}

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
