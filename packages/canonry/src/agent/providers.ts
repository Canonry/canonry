import { getEnvApiKey, getModel, type KnownProvider, type Model } from '@mariozechner/pi-ai'
import {
  AGENT_PROVIDER_IDS,
  AgentProviderIds,
  LLM_CAPABILITIES,
  LlmCapabilities,
  isAgentProviderId,
  type AgentProviderId,
  type AgentProviderOption,
  type AgentProvidersResponse,
  type LlmCapability,
} from '@ainyc/canonry-contracts'

/**
 * Registry of LLM providers the built-in Aero agent can drive.
 *
 * The canonical `AgentProviderId` union lives in
 * `@ainyc/canonry-contracts` (`providers.ts`) so both sweep and agent
 * surfaces reference the same vocabulary. This file adds the agent-side
 * metadata: pi-ai vendor mapping, per-capability models, priority, label.
 *
 * Intentionally does NOT list sweep-only providers (`perplexity`, `local`,
 * `cdp:chatgpt`) — they can't drive an agent loop. `zai` is agent-only
 * with no sweep adapter.
 *
 * Model selection is two-dimensional: `(provider, capability) → modelId`.
 * Provider is configured by the user (API key + default); capability is
 * declared by the calling feature (Aero uses `agent`, the explain-this
 * feature uses `analyze`, the semantic-coverage check uses `classify`).
 * `PROVIDER_MODELS` is the single source of truth; `AgentProviderEntry`
 * exposes `defaultModel` as a shortcut to the `agent`-tier model for
 * backward-compatible callers (DTO + CLI display).
 */
export interface AgentProviderEntry {
  /** pi-ai vendor id — what `getModel(provider, id)` and `getEnvApiKey(provider)` accept. */
  piAiProvider: KnownProvider
  /** User-facing label shown in CLI help and dashboard pickers. */
  label: string
  /**
   * Default model when the caller doesn't specify one and didn't pass a
   * capability. Equals `PROVIDER_MODELS[id].agent` — the `agent`-tier
   * model is the historical default since Aero was the only consumer.
   * Validated against pi-ai's catalog at module load.
   */
  defaultModel: string
  /** Lower = higher priority in auto-detect. Used when no `--provider` is passed. */
  autoDetectPriority: number
}

/**
 * Per-provider, per-capability model selection. This is the canonical
 * source of truth for "which model fills this capability tier for this
 * provider." Adding a new capability requires adding an entry for every
 * provider (enforced at module load + by tests). Bumping model versions
 * (e.g. opus-4-7 → opus-5-0) happens here — one place, no hunting.
 *
 * Cost tiers (rough order of magnitude):
 *   agent    — $$$  (premium quality for multi-step reasoning)
 *   analyze  — $$   (mid-tier for structured single-shot synthesis)
 *   classify — $    (cheapest for short yes/no or label-set outputs)
 *
 * Provider notes:
 *   - Gemini: 2.5-flash is already cheap + capable; no separate analyze /
 *     classify tier worth using until Gemini ships a dedicated micro
 *     model. All three tiers point at flash.
 *   - Zai: glm-5.1 is the agent tier; glm-5.1-flash is the cheap tier
 *     for analyze + classify.
 */
export const PROVIDER_MODELS = {
  [AgentProviderIds.claude]: {
    [LlmCapabilities.agent]: 'claude-opus-4-7',
    [LlmCapabilities.analyze]: 'claude-sonnet-4-6',
    [LlmCapabilities.classify]: 'claude-haiku-4-5',
  },
  [AgentProviderIds.openai]: {
    [LlmCapabilities.agent]: 'gpt-5.1',
    [LlmCapabilities.analyze]: 'gpt-5-mini',
    [LlmCapabilities.classify]: 'gpt-5-nano',
  },
  [AgentProviderIds.gemini]: {
    // Gemini's 2.5-flash is already cheap + capable; flash-lite is the
    // dedicated micro tier for classify. Analyze stays on flash because
    // flash-lite drops too much quality for structured synthesis.
    [LlmCapabilities.agent]: 'gemini-2.5-flash',
    [LlmCapabilities.analyze]: 'gemini-2.5-flash',
    [LlmCapabilities.classify]: 'gemini-2.5-flash-lite',
  },
  [AgentProviderIds.zai]: {
    // GLM lineage: 5.1 is the latest agent-class model; 5-turbo is the
    // cheaper tier good for structured tasks and classification.
    [LlmCapabilities.agent]: 'glm-5.1',
    [LlmCapabilities.analyze]: 'glm-5-turbo',
    [LlmCapabilities.classify]: 'glm-5-turbo',
  },
} as const satisfies Record<AgentProviderId, Record<LlmCapability, string>>

export const AGENT_PROVIDERS = {
  [AgentProviderIds.claude]: {
    piAiProvider: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: PROVIDER_MODELS[AgentProviderIds.claude][LlmCapabilities.agent],
    autoDetectPriority: 0,
  },
  [AgentProviderIds.openai]: {
    piAiProvider: 'openai',
    label: 'OpenAI',
    defaultModel: PROVIDER_MODELS[AgentProviderIds.openai][LlmCapabilities.agent],
    autoDetectPriority: 1,
  },
  [AgentProviderIds.gemini]: {
    piAiProvider: 'google',
    label: 'Google (Gemini)',
    defaultModel: PROVIDER_MODELS[AgentProviderIds.gemini][LlmCapabilities.agent],
    autoDetectPriority: 2,
  },
  [AgentProviderIds.zai]: {
    piAiProvider: 'zai',
    label: 'Z.ai (GLM)',
    defaultModel: PROVIDER_MODELS[AgentProviderIds.zai][LlmCapabilities.agent],
    autoDetectPriority: 3,
  },
} as const satisfies Record<AgentProviderId, AgentProviderEntry>

/**
 * Backwards-compatible alias for the canonical `AgentProviderId`. Existing
 * callers can continue to use `SupportedAgentProvider`; new code should
 * import `AgentProviderId` from `@ainyc/canonry-contracts`.
 */
export type SupportedAgentProvider = AgentProviderId

/** Enum constant — use `AgentProviders.claude` instead of the literal `'claude'`. */
export const AgentProviders = AgentProviderIds

/** Providers sorted by auto-detect priority (lowest number first). */
export function agentProvidersByPriority(): readonly AgentProviderId[] {
  return (Object.keys(AGENT_PROVIDERS) as AgentProviderId[])
    .slice()
    .sort((a, b) => AGENT_PROVIDERS[a].autoDetectPriority - AGENT_PROVIDERS[b].autoDetectPriority)
}

/** All providers, insertion order. */
export function listAgentProviders(): readonly AgentProviderId[] {
  return AGENT_PROVIDER_IDS
}

export function getAgentProvider(name: AgentProviderId): AgentProviderEntry {
  return AGENT_PROVIDERS[name]
}

/** Runtime guard for user-provided strings (e.g. `--provider zai`). */
export function coerceAgentProvider(value: string | undefined): AgentProviderId | undefined {
  if (!value) return undefined
  return isAgentProviderId(value) ? value : undefined
}

/** Find the registry entry for a pi-ai vendor id (used by the apiKey resolver). */
export function findByPiAiProvider(piAiProvider: string): AgentProviderEntry | undefined {
  return Object.values(AGENT_PROVIDERS).find((e) => e.piAiProvider === piAiProvider)
}

/**
 * Resolve a pi-ai Model for the given agent provider + optional model id.
 *
 * Equivalent to `resolveModelForCapability(provider, 'agent', modelId)`.
 * Kept as a thin wrapper because (a) most existing callers want the
 * agent-tier model and (b) the per-capability resolver is the right
 * primitive going forward, so new code should prefer that for clarity.
 *
 * Throws if the model isn't in pi-ai's catalog (surfaces registry drift
 * between canonry and pi-ai versions at the earliest possible point).
 */
export function resolveModelForProvider(
  provider: AgentProviderId,
  modelId?: string,
): Model<never> {
  return resolveModelForCapability(provider, LlmCapabilities.agent, modelId)
}

/**
 * Resolve a pi-ai Model for the given (provider, capability) pair, with
 * an optional caller-supplied model id that overrides the default.
 *
 * This is the primitive new code should call. The capability tier maps
 * to a model per provider via `PROVIDER_MODELS` — same provider
 * selection that Aero uses, but each feature picks an appropriately-
 * tiered model (premium for agent reasoning, cheap for classification,
 * mid-tier for synthesis) without hand-coding model names at every
 * call site.
 *
 * Throws if the model isn't in pi-ai's catalog.
 */
export function resolveModelForCapability(
  provider: AgentProviderId,
  capability: LlmCapability,
  modelIdOverride?: string,
): Model<never> {
  const entry = AGENT_PROVIDERS[provider]
  const id = modelIdOverride ?? PROVIDER_MODELS[provider][capability]
  const model = getModel(entry.piAiProvider as never, id as never) as Model<never> | undefined
  if (!model) {
    throw new Error(
      `Model '${id}' not found for pi-ai provider '${entry.piAiProvider}'. ` +
        `Verify PROVIDER_MODELS[${provider}][${capability}] against the installed @mariozechner/pi-ai catalog.`,
    )
  }
  return model
}

/**
 * Module-load sanity check — for every provider, every capability tier
 * MUST resolve to a real pi-ai model. This catches three categories of
 * drift at import time, well before any user request triggers them:
 *
 *   1. A capability is added to `LlmCapabilities` but the per-provider
 *      `PROVIDER_MODELS` mapping was forgotten for one of the providers.
 *   2. A model id is bumped in `PROVIDER_MODELS` but no longer exists in
 *      pi-ai's catalog (vendor renamed it, pi-ai version drifted, etc.).
 *   3. `AGENT_PROVIDERS[id].defaultModel` diverged from
 *      `PROVIDER_MODELS[id].agent` (would silently surface the wrong
 *      model in the CLI / dashboard provider picker).
 */
export function validateAgentProviderRegistry(): void {
  for (const provider of listAgentProviders()) {
    for (const capability of LLM_CAPABILITIES) {
      resolveModelForCapability(provider, capability)
    }
    const entry = AGENT_PROVIDERS[provider]
    const agentModel = PROVIDER_MODELS[provider][LlmCapabilities.agent]
    if (entry.defaultModel !== agentModel) {
      throw new Error(
        `AGENT_PROVIDERS[${provider}].defaultModel ('${entry.defaultModel}') ` +
          `does not match PROVIDER_MODELS[${provider}].agent ('${agentModel}'). ` +
          `The two must stay in sync — defaultModel is a backward-compat ` +
          `shortcut to the agent-tier model.`,
      )
    }
  }
}

/**
 * Resolve an API key for an entry — canonry config key first, pi-ai env
 * var fallback. Accepts either a canonical `AgentProviderId` or a raw pi-ai
 * vendor string (what pi's `getApiKey` callback receives). Returns undefined
 * when no key is available from either source.
 */
export function resolveApiKeyFor(
  providerOrPiAi: AgentProviderId | string,
  config: { providers?: Record<string, { apiKey?: string } | undefined> },
): string | undefined {
  return resolveApiKeySource(providerOrPiAi, config)?.key
}

/**
 * Same resolution as `resolveApiKeyFor` but also tells you whether the key
 * came from canonry config or a pi-ai env var. UI uses this to render an
 * onboarding hint that points to the right source of truth.
 */
export function resolveApiKeySource(
  providerOrPiAi: AgentProviderId | string,
  config: { providers?: Record<string, { apiKey?: string } | undefined> },
): { key: string; source: 'config' | 'env' } | undefined {
  const id = resolveAgentId(providerOrPiAi)
  if (!id) return undefined
  const entry = AGENT_PROVIDERS[id]
  const fromConfig = config.providers?.[id]?.apiKey
  if (fromConfig) return { key: fromConfig, source: 'config' }
  const fromEnv = getEnvApiKey(entry.piAiProvider)
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return undefined
}

/**
 * Accept either a canonical `AgentProviderId` (what CLI/API callers use) or
 * a raw pi-ai vendor string (what pi's `getApiKey` callback receives). Returns
 * the canonical id, or undefined if the input is unknown.
 */
function resolveAgentId(providerOrPiAi: string): AgentProviderId | undefined {
  if (isAgentProviderId(providerOrPiAi)) return providerOrPiAi
  for (const id of AGENT_PROVIDER_IDS) {
    if (AGENT_PROVIDERS[id].piAiProvider === providerOrPiAi) return id
  }
  return undefined
}

/**
 * Build the `AgentProvidersResponse` DTO the `/agent/providers` endpoint
 * serves. Lives alongside the registry so the provider list and the
 * key-source derivation stay in lockstep with `AGENT_PROVIDERS`.
 */
export function buildAgentProvidersResponse(config: {
  providers?: Record<string, { apiKey?: string } | undefined>
}): AgentProvidersResponse {
  const providers: AgentProviderOption[] = listAgentProviders().map((id) => {
    const entry = AGENT_PROVIDERS[id]
    const source = resolveApiKeySource(id, config)
    return {
      id,
      label: entry.label,
      defaultModel: entry.defaultModel,
      configured: source !== undefined,
      keySource: source?.source ?? null,
    }
  })
  const firstConfigured = agentProvidersByPriority().find((p) => resolveApiKeySource(p, config))
  return {
    providers,
    defaultProvider: firstConfigured ?? null,
  }
}
