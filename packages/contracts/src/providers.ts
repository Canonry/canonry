/**
 * Canonical Canonry provider IDs.
 *
 * Every provider anywhere in the system — sweep adapters, Aero agent
 * backends, config keys, CLI flags, API responses — identifies itself by
 * one of these strings. Split by capability:
 *
 * - `SweepProviderIds`  — adapters that can run answer-visibility sweeps.
 *   Perplexity is an answer engine; `local` is an OpenAI-compatible local
 *   LLM; `cdp:chatgpt` is a browser-automation adapter.
 * - `AgentProviderIds`  — LLM backends that can drive the Aero conversation
 *   loop (tool-calling + streaming). Subset of ProviderIds plus `zai`
 *   (agent-only, no sweep adapter).
 *
 * Agent-side code maps these to pi-ai's vendor names (e.g. `claude` →
 * pi-ai's `anthropic`) inside `packages/canonry/src/agent/providers.ts`.
 * External consumers only see the canonical IDs here.
 */

export const ProviderIds = {
  claude: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  perplexity: 'perplexity',
  local: 'local',
  cdpChatgpt: 'cdp:chatgpt',
  zai: 'zai',
} as const

export type ProviderId = (typeof ProviderIds)[keyof typeof ProviderIds]

export const PROVIDER_IDS: readonly ProviderId[] = Object.values(ProviderIds)

/** Providers that can run answer-visibility sweeps. */
export const SweepProviderIds = {
  claude: ProviderIds.claude,
  openai: ProviderIds.openai,
  gemini: ProviderIds.gemini,
  perplexity: ProviderIds.perplexity,
  local: ProviderIds.local,
  cdpChatgpt: ProviderIds.cdpChatgpt,
} as const

export type SweepProviderId = (typeof SweepProviderIds)[keyof typeof SweepProviderIds]

export const SWEEP_PROVIDER_IDS: readonly SweepProviderId[] = Object.values(SweepProviderIds)

/**
 * Providers that can drive the built-in Aero agent loop. Perplexity / local /
 * cdp:chatgpt are excluded (answer engine, unreliable tool-calling, browser
 * scraper respectively). `zai` is agent-only.
 */
export const AgentProviderIds = {
  claude: ProviderIds.claude,
  openai: ProviderIds.openai,
  gemini: ProviderIds.gemini,
  zai: ProviderIds.zai,
} as const

export type AgentProviderId = (typeof AgentProviderIds)[keyof typeof AgentProviderIds]

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = Object.values(AgentProviderIds)

export function isAgentProviderId(value: string): value is AgentProviderId {
  return (AGENT_PROVIDER_IDS as readonly string[]).includes(value)
}

export function isSweepProviderId(value: string): value is SweepProviderId {
  return (SWEEP_PROVIDER_IDS as readonly string[]).includes(value)
}
