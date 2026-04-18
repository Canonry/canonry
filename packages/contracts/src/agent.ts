/**
 * Identifier of one of Aero's supported LLM providers.
 * Mirrors `SupportedAgentProvider` in `packages/canonry/src/agent/providers.ts`
 * but lives here so web/CLI consumers don't pull in the canonry package.
 */
export type AgentProviderId = 'anthropic' | 'openai' | 'google' | 'zai'

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
