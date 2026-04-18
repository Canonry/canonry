import { getEnvApiKey, getModel, type KnownProvider, type Model } from '@mariozechner/pi-ai'
import {
  AGENT_PROVIDER_IDS,
  AgentProviderIds,
  isAgentProviderId,
  type AgentProviderId,
  type AgentProviderOption,
  type AgentProvidersResponse,
} from '@ainyc/canonry-contracts'

/**
 * Registry of LLM providers the built-in Aero agent can drive.
 *
 * The canonical `AgentProviderId` union lives in
 * `@ainyc/canonry-contracts` (`providers.ts`) so both sweep and agent
 * surfaces reference the same vocabulary. This file adds the agent-side
 * metadata: pi-ai vendor mapping, default model, priority, label.
 *
 * Intentionally does NOT list sweep-only providers (`perplexity`, `local`,
 * `cdp:chatgpt`) — they can't drive an agent loop. `zai` is agent-only
 * with no sweep adapter.
 */
export interface AgentProviderEntry {
  /** pi-ai vendor id — what `getModel(provider, id)` and `getEnvApiKey(provider)` accept. */
  piAiProvider: KnownProvider
  /** User-facing label shown in CLI help and dashboard pickers. */
  label: string
  /** Default model when the caller doesn't specify one. Validated against pi-ai's catalog at module load. */
  defaultModel: string
  /** Lower = higher priority in auto-detect. Used when no `--provider` is passed. */
  autoDetectPriority: number
}

export const AGENT_PROVIDERS = {
  [AgentProviderIds.claude]: {
    piAiProvider: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-4-7',
    autoDetectPriority: 0,
  },
  [AgentProviderIds.openai]: {
    piAiProvider: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.1',
    autoDetectPriority: 1,
  },
  [AgentProviderIds.gemini]: {
    piAiProvider: 'google',
    label: 'Google (Gemini)',
    defaultModel: 'gemini-2.5-flash',
    autoDetectPriority: 2,
  },
  [AgentProviderIds.zai]: {
    piAiProvider: 'zai',
    label: 'Z.ai (GLM)',
    defaultModel: 'glm-5.1',
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
 * Throws if the model isn't in pi-ai's catalog (surfaces registry drift
 * between canonry and pi-ai versions at the earliest possible point).
 */
export function resolveModelForProvider(
  provider: AgentProviderId,
  modelId?: string,
): Model<never> {
  const entry = AGENT_PROVIDERS[provider]
  const id = modelId ?? entry.defaultModel
  const model = getModel(entry.piAiProvider as never, id as never) as Model<never> | undefined
  if (!model) {
    throw new Error(
      `Model '${id}' not found for pi-ai provider '${entry.piAiProvider}'. ` +
        `Verify AGENT_PROVIDERS[${provider}].defaultModel against the installed @mariozechner/pi-ai catalog.`,
    )
  }
  return model
}

/** Module-load sanity check — every registered default must resolve in pi-ai. */
export function validateAgentProviderRegistry(): void {
  for (const provider of listAgentProviders()) {
    resolveModelForProvider(provider)
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
