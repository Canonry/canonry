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
 *   loop (tool-calling + streaming). Subset of ProviderIds plus `zai` and
 *   `deepinfra` (both agent-only, no sweep adapter).
 *
 * Agent-side code maps these to pi-ai's vendor names (e.g. `claude` →
 * pi-ai's `anthropic`) inside `packages/canonry/src/agent/providers.ts`.
 * `deepinfra` is an OpenAI-compatible host with no pi-ai catalog entry —
 * the agent registry constructs a custom `openai-completions` model pointed
 * at its base URL. External consumers only see the canonical IDs here.
 */

export const ProviderIds = {
  claude: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  perplexity: 'perplexity',
  local: 'local',
  cdpChatgpt: 'cdp:chatgpt',
  zai: 'zai',
  deepinfra: 'deepinfra',
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
 * scraper respectively). `zai` and `deepinfra` are agent-only — both serve
 * open-weight models (GLM, DeepSeek) but have no answer-visibility sweep
 * adapter (no live web-search grounding), so they stay out of SweepProviderIds.
 * `deepinfra` is a Western-hosted (US/EU) OpenAI-compatible endpoint.
 */
export const AgentProviderIds = {
  claude: ProviderIds.claude,
  openai: ProviderIds.openai,
  gemini: ProviderIds.gemini,
  zai: ProviderIds.zai,
  deepinfra: ProviderIds.deepinfra,
} as const

export type AgentProviderId = (typeof AgentProviderIds)[keyof typeof AgentProviderIds]

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = Object.values(AgentProviderIds)

export function isAgentProviderId(value: string): value is AgentProviderId {
  return (AGENT_PROVIDER_IDS as readonly string[]).includes(value)
}

export function isSweepProviderId(value: string): value is SweepProviderId {
  return (SWEEP_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Capability tier describing what an LLM call needs. Used by the
 * per-provider model selector so each feature picks an
 * appropriately-tiered model without hand-coding model names at every
 * call site.
 *
 * - `agent`    — multi-step tool use, long context, premium models
 *                (Aero's conversation loop). Default → opus-class /
 *                full-quality models per provider.
 * - `analyze`  — single-shot synthesis, structured input → ~1k tokens
 *                out (explain-this-recommendation, content brief
 *                generation). Default → mid-tier models (sonnet, mini,
 *                flash) — 5-10× cheaper than `agent` with comparable
 *                quality on structured tasks.
 * - `classify` — single-shot yes/no or short structured judgments
 *                (semantic page-coverage match, domain classification).
 *                Default → cheapest fast models (haiku, flash). 50-100×
 *                cheaper than `agent`.
 *
 * Capabilities are intentionally orthogonal to provider selection: a
 * caller declares its capability, the project's configured provider
 * decides which actual model fills that capability.
 *
 * Adding a new capability requires updating the per-provider mapping in
 * `packages/canonry/src/agent/providers.ts` → `PROVIDER_MODELS` and
 * the test `agent/providers.test.ts → "every provider declares every
 * capability"`.
 */
export const LlmCapabilities = {
  agent: 'agent',
  analyze: 'analyze',
  classify: 'classify',
} as const

export type LlmCapability = (typeof LlmCapabilities)[keyof typeof LlmCapabilities]

export const LLM_CAPABILITIES: readonly LlmCapability[] = Object.values(LlmCapabilities)

export function isLlmCapability(value: string): value is LlmCapability {
  return (LLM_CAPABILITIES as readonly string[]).includes(value)
}
