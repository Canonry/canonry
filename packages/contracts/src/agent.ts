import { z } from 'zod'
import type { AgentProviderId } from './providers.js'

/**
 * Identifier of one of Aero's supported LLM providers. Canonical IDs live
 * in `providers.ts` — `AgentProviderIds` is the runtime enum, this is the
 * derived union. The agent-side mapping to pi-ai vendor names (e.g.
 * `claude` → `anthropic`) lives in `packages/canonry/src/agent/providers.ts`.
 */
export type { AgentProviderId } from './providers.js'

export interface AgentProviderOption {
  /** Stable identifier — what clients pass back as `provider` on the prompt endpoint. */
  id: AgentProviderId
  /** Human-readable label for UI pickers, e.g. "Anthropic (Claude)". */
  label: string
  /** Default model if the caller doesn't pick one. */
  defaultModel: string
  /** Whether a usable API key was found (config.yaml or provider env var). */
  configured: boolean
  /**
   * Where the key resolved from, if any. `null` when `configured === false`.
   * Surfaced so the UI can nudge users toward their preferred source of truth.
   */
  keySource: 'config' | 'env' | null
}

export interface AgentProvidersResponse {
  /**
   * Every provider Aero knows about. `configured === false` entries are
   * included so the UI can render them disabled with an onboarding hint.
   */
  providers: AgentProviderOption[]
  /**
   * Provider Aero auto-picks when no explicit override is passed. Null if
   * nothing is configured (install never exchanged a key).
   */
  defaultProvider: AgentProviderId | null
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
