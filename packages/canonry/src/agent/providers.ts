import { getEnvApiKey, getModel, type KnownProvider, type Model } from '@mariozechner/pi-ai'

/**
 * Registry of LLM providers the built-in Aero agent can drive.
 *
 * Adding a new provider = adding one entry here. Everything downstream —
 * the `SupportedAgentProvider` union, `detectAgentProvider` priority
 * ordering, CLI `--provider` validation, API-key resolution, model
 * defaulting — is derived from this table.
 *
 * Intentionally does NOT re-list sweep providers that Aero can't use (e.g.
 * `cdp:chatgpt`, `local`). Those live in the provider-registry for the
 * sweep side of canonry. The two sets can overlap (anthropic, openai,
 * google) but are distinct concepts — sweep adapters hit the LLM for
 * citation discovery, agent providers drive the Aero conversation loop.
 */
export interface AgentProviderEntry {
  /** pi-ai provider id — what `getModel(provider, id)` and `getEnvApiKey(provider)` accept. */
  piAiProvider: KnownProvider
  /** User-facing label shown in CLI help and (eventually) dashboard pickers. */
  label: string
  /**
   * Canonry config key — `config.providers[canonryConfigKey].apiKey`.
   * Sometimes differs from pi-ai's id because canonry's sweep side uses
   * different naming (e.g. sweep calls Claude 'claude' while pi-ai calls
   * it 'anthropic'). Reusing the sweep config key means users don't
   * configure two API keys for the same provider.
   */
  canonryConfigKey: string
  /** Default model when the caller doesn't specify one. Validated against pi-ai's catalog at module load. */
  defaultModel: string
  /** Lower = higher priority in auto-detect. Used when no `--provider` is passed. */
  autoDetectPriority: number
}

export const AGENT_PROVIDERS = {
  anthropic: {
    piAiProvider: 'anthropic',
    label: 'Anthropic (Claude)',
    canonryConfigKey: 'claude',
    defaultModel: 'claude-opus-4-7',
    autoDetectPriority: 0,
  },
  openai: {
    piAiProvider: 'openai',
    label: 'OpenAI',
    canonryConfigKey: 'openai',
    defaultModel: 'gpt-5.1',
    autoDetectPriority: 1,
  },
  google: {
    piAiProvider: 'google',
    label: 'Google (Gemini)',
    canonryConfigKey: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    autoDetectPriority: 2,
  },
  zai: {
    piAiProvider: 'zai',
    label: 'Z.ai (GLM)',
    canonryConfigKey: 'zai',
    defaultModel: 'glm-5.1',
    autoDetectPriority: 3,
  },
} as const satisfies Record<string, AgentProviderEntry>

/** Derived from the registry — the registry IS the source of truth. */
export type SupportedAgentProvider = keyof typeof AGENT_PROVIDERS

/** Enum constant — use `AgentProviders.anthropic` instead of the literal `'anthropic'`. */
export const AgentProviders = Object.freeze(
  Object.fromEntries(Object.keys(AGENT_PROVIDERS).map((k) => [k, k])),
) as { readonly [K in SupportedAgentProvider]: K }

/** Providers sorted by auto-detect priority (lowest number first). */
export function agentProvidersByPriority(): readonly SupportedAgentProvider[] {
  return (Object.keys(AGENT_PROVIDERS) as SupportedAgentProvider[])
    .slice()
    .sort((a, b) => AGENT_PROVIDERS[a].autoDetectPriority - AGENT_PROVIDERS[b].autoDetectPriority)
}

/** All providers, insertion order. */
export function listAgentProviders(): readonly SupportedAgentProvider[] {
  return Object.keys(AGENT_PROVIDERS) as SupportedAgentProvider[]
}

export function getAgentProvider(name: SupportedAgentProvider): AgentProviderEntry {
  return AGENT_PROVIDERS[name]
}

/** Runtime guard for user-provided strings (e.g. `--provider zai`). */
export function coerceAgentProvider(value: string | undefined): SupportedAgentProvider | undefined {
  if (!value) return undefined
  return (listAgentProviders() as readonly string[]).includes(value)
    ? (value as SupportedAgentProvider)
    : undefined
}

/** Find the registry entry for a pi-ai provider id (used by the apiKey resolver). */
export function findByPiAiProvider(piAiProvider: string): AgentProviderEntry | undefined {
  return Object.values(AGENT_PROVIDERS).find((e) => e.piAiProvider === piAiProvider)
}

/**
 * Resolve a pi-ai Model for the given agent provider + optional model id.
 * Throws if the model isn't in pi-ai's catalog (surfaces registry drift
 * between canonry and pi-ai versions at the earliest possible point).
 */
export function resolveModelForProvider(
  provider: SupportedAgentProvider,
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
 * var fallback. Accepts either a `SupportedAgentProvider` (our enum key)
 * or a raw pi-ai provider string (what pi's `getApiKey` callback receives).
 * Returns undefined when no key is available from either source.
 */
export function resolveApiKeyFor(
  providerOrPiAi: SupportedAgentProvider | string,
  config: { providers?: Record<string, { apiKey?: string } | undefined> },
): string | undefined {
  const entry =
    (AGENT_PROVIDERS as Record<string, AgentProviderEntry | undefined>)[providerOrPiAi] ??
    findByPiAiProvider(providerOrPiAi)
  if (!entry) return undefined
  const fromConfig = config.providers?.[entry.canonryConfigKey]?.apiKey
  if (fromConfig) return fromConfig
  return getEnvApiKey(entry.piAiProvider)
}
