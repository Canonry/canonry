import {
  getEnvApiKey,
  getModel,
  type KnownProvider,
  type Model,
  type OpenAICompletionsCompat,
} from '@mariozechner/pi-ai'
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
 * `cdp:chatgpt`) — they can't drive an agent loop. `zai` and `deepinfra`
 * are agent-only with no sweep adapter; `deepinfra` is an OpenAI-compatible
 * host outside pi-ai's catalog (see `OpenAiCompatibleHost`).
 *
 * Model selection is two-dimensional: `(provider, capability) → modelId`.
 * Provider is configured by the user (API key + default); capability is
 * declared by the calling feature (Aero uses `agent`, the explain-this
 * feature uses `analyze`, the semantic-coverage check uses `classify`).
 * `PROVIDER_MODELS` is the single source of truth; `AgentProviderEntry`
 * exposes `defaultModel` as a shortcut to the `agent`-tier model for
 * backward-compatible callers (DTO + CLI display).
 */
/**
 * Per-model metadata used to build a `Model<'openai-completions'>` object
 * for a custom OpenAI-compatible host that isn't in pi-ai's catalog. Costs
 * are USD per 1M tokens (same unit pi-ai's `calculateCost` consumes).
 * `contextWindow` / `maxTokens` are descriptive capability metadata — Aero's
 * compaction fires on a fixed token budget (`COMPACTION_TOKEN_THRESHOLD`) and
 * pi-agent-core's loop never reads `model.contextWindow`, so the value here
 * does not gate compaction; keep it accurate for documentation + cost display.
 */
export interface OpenAiCompatibleModelMeta {
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/**
 * Config for an OpenAI-compatible host (e.g. DeepInfra) that pi-ai can reach
 * through its `openai-completions` API but does not ship in its model
 * catalog. When an `AgentProviderEntry` carries this block, model resolution
 * constructs a custom `Model<'openai-completions'>` pointed at `baseUrl`
 * instead of looking the id up via `getModel`, and API-key resolution reads
 * `apiKeyEnvVar` (pi-ai's `getEnvApiKey` doesn't know this host).
 */
export interface OpenAiCompatibleHost {
  /** OpenAI-compatible completions base URL, e.g. `https://api.deepinfra.com/v1/openai`. */
  baseUrl: string
  /**
   * Optional env var that overrides `baseUrl` at model-construction time. Lets
   * a proxied deployment (e.g. a LiteLLM gateway that injects the upstream key
   * out-of-container) repoint the host without a rebuild. Unset / empty env →
   * the `baseUrl` constant is used, so the default self-hosted path is unchanged.
   */
  baseUrlEnvVar?: string
  /** Env var carrying the API key — pi-ai's `getEnvApiKey` has no entry for this host. */
  apiKeyEnvVar: string
  /**
   * pi-ai compat overrides for the host's quirks. pi-ai auto-detects compat
   * from the base URL for hosts it knows; an unknown host like DeepInfra
   * falls back to the strict OpenAI profile, so we set the open-model
   * profile explicitly. See `detectCompat` in pi-ai's openai-completions.
   */
  compat?: OpenAICompletionsCompat
  /** Per-slug metadata for `org/Model` ids we ship as tiers; falls back to `defaultModelMeta`. */
  knownModels: Record<string, OpenAiCompatibleModelMeta>
  /** Metadata for user-supplied `--model` slugs not present in `knownModels`. */
  defaultModelMeta: OpenAiCompatibleModelMeta
}

export interface AgentProviderEntry {
  /**
   * The `model.provider` string the agent loop passes to `getApiKey`. For
   * pi-ai catalog providers this is the pi-ai vendor id (e.g. `anthropic`)
   * that `getModel(provider, id)` / `getEnvApiKey(provider)` accept. For a
   * custom OpenAI-compatible host (see `openaiCompatible`) it's the canonical
   * `AgentProviderId` (e.g. `deepinfra`) — not a pi-ai catalog provider —
   * which `resolveAgentId` maps back to the config/env key lookup.
   */
  piAiProvider: KnownProvider | string
  /** User-facing label shown in CLI help and dashboard pickers. */
  label: string
  /**
   * Default model when the caller doesn't specify one and didn't pass a
   * capability. Equals `PROVIDER_MODELS[id].agent` — the `agent`-tier
   * model is the historical default since Aero was the only consumer.
   * Validated against pi-ai's catalog at module load (catalog providers
   * only; custom hosts validate that the model object builds).
   */
  defaultModel: string
  /** Lower = higher priority in auto-detect. Used when no `--provider` is passed. */
  autoDetectPriority: number
  /**
   * Present only for OpenAI-compatible hosts outside pi-ai's catalog. Drives
   * custom model construction + env-var key resolution. Absent for pi-ai
   * catalog providers (claude / openai / gemini / zai).
   */
  openaiCompatible?: OpenAiCompatibleHost
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
 *   - DeepInfra: GLM-5.2 (Western-hosted, Sonnet-class open weights) on all
 *     three tiers. At ~$0.95/$3.00 per 1M it undercuts the Claude analyze
 *     (Sonnet) and classify (Haiku) tiers it replaces, so the cheaper tiers
 *     take no quality hit. These are DeepInfra `org/Model` slugs, not pi-ai
 *     catalog ids — model resolution builds a custom openai-completions model
 *     (see `buildOpenAiCompatibleModel`). Serving is quantized (FP8/FP4);
 *     validate quality before production use.
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
  [AgentProviderIds.deepinfra]: {
    // DeepInfra `org/Model` slugs. GLM-5.2 (Sonnet-class) on all three tiers —
    // it undercuts the Claude tiers it replaces, so the cheaper tiers take no
    // quality hit. Resolved into a custom openai-completions model, not pi-ai's
    // catalog.
    [LlmCapabilities.agent]: 'zai-org/GLM-5.2',
    [LlmCapabilities.analyze]: 'zai-org/GLM-5.2',
    [LlmCapabilities.classify]: 'zai-org/GLM-5.2',
  },
} as const satisfies Record<AgentProviderId, Record<LlmCapability, string>>

// Explicitly typed as the widened entry record (not `as const satisfies`) so
// `AGENT_PROVIDERS[id].openaiCompatible` is visible on every member — the
// const-narrowed union would only expose it on the one entry that sets it.
export const AGENT_PROVIDERS: Record<AgentProviderId, AgentProviderEntry> = {
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
  [AgentProviderIds.deepinfra]: {
    // `piAiProvider` is the canonical id here (not a pi-ai vendor) — it's the
    // `model.provider` string the agent loop hands to `getApiKey`, which
    // `resolveAgentId` maps straight back to the deepinfra config/env key.
    piAiProvider: AgentProviderIds.deepinfra,
    label: 'DeepInfra (GLM / DeepSeek)',
    defaultModel: PROVIDER_MODELS[AgentProviderIds.deepinfra][LlmCapabilities.agent],
    autoDetectPriority: 4,
    openaiCompatible: {
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      baseUrlEnvVar: 'DEEPINFRA_BASE_URL',
      apiKeyEnvVar: 'DEEPINFRA_TOKEN',
      // DeepInfra serves open-weight models (GLM, DeepSeek) behind an
      // OpenAI-compatible vLLM endpoint. pi-ai's `detectCompat` has no rule
      // for api.deepinfra.com, so it would apply the strict OpenAI profile;
      // we set the same open-model profile pi-ai uses for deepseek.com /
      // cerebras / z.ai. `developer` role and `reasoning_effort` are
      // OpenAI-platform-isms these models reject, `store` is response
      // persistence DeepInfra doesn't implement, and DeepInfra documents
      // `max_tokens` (not `max_completion_tokens`) on its OpenAI route.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
      },
      // Best-effort metadata. Costs are USD/1M tokens (DeepInfra published
      // rates: GLM-5.2 ~$0.95 in / $0.18 cached / $3.00 out; DeepSeek-V4-Flash
      // ~$0.10 in / $0.20 out). contextWindow is DeepInfra's 1M (fp4) serving
      // window for both models; it's descriptive (see OpenAiCompatibleModelMeta),
      // so it documents the real window rather than gating compaction.
      knownModels: {
        'zai-org/GLM-5.2': {
          contextWindow: 1_048_576,
          maxTokens: 98304,
          reasoning: true,
          cost: { input: 0.95, output: 3.0, cacheRead: 0.18, cacheWrite: 0 },
        },
        'deepseek-ai/DeepSeek-V4-Flash': {
          contextWindow: 1_048_576,
          maxTokens: 32768,
          reasoning: false,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        },
      },
      // Fallback for arbitrary `--model` slugs we don't ship as tiers. cost is
      // 0, so an unknown slug isn't cost-tracked by pi-ai's `calculateCost`;
      // contextWindow stays conservative since we can't know the slug's window.
      defaultModelMeta: {
        contextWindow: 131072,
        maxTokens: 32768,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  },
}

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
 * For a pi-ai catalog provider, throws if the model isn't in pi-ai's
 * catalog. For a custom OpenAI-compatible host (`entry.openaiCompatible`,
 * e.g. DeepInfra) the model is constructed directly — any slug is accepted
 * and forwarded to the host, which validates it at request time.
 */
export function resolveModelForCapability(
  provider: AgentProviderId,
  capability: LlmCapability,
  modelIdOverride?: string,
): Model<never> {
  const entry = AGENT_PROVIDERS[provider]
  const id = modelIdOverride ?? PROVIDER_MODELS[provider][capability]
  // Custom OpenAI-compatible host (e.g. DeepInfra): the slug isn't in pi-ai's
  // catalog, so construct the model object directly against the host base URL.
  if (entry.openaiCompatible) {
    // The single-shot cheap tiers (analyze/classify) don't need the model's
    // reasoning trace; suppress it so they don't burn thinking tokens. The
    // agent tier keeps the host's default thinking for its multi-step loop.
    const suppressThinking = capability !== LlmCapabilities.agent
    return buildOpenAiCompatibleModel(entry, id, suppressThinking) as Model<never>
  }
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
 * Build a `Model<'openai-completions'>` for a custom OpenAI-compatible host.
 * pi-ai's `streamSimple` dispatches on `model.api`, hits `model.baseUrl`, and
 * passes `model.provider` to the agent loop's `getApiKey` callback — so the
 * canonical id in `entry.piAiProvider` lands back in our key resolver.
 */
export function buildOpenAiCompatibleModel(
  entry: AgentProviderEntry,
  id: string,
  suppressThinking = false,
): Model<'openai-completions'> {
  const host = entry.openaiCompatible
  if (!host) {
    throw new Error(`buildOpenAiCompatibleModel called for non-custom provider '${entry.piAiProvider}'`)
  }
  const meta = host.knownModels[id] ?? host.defaultModelMeta
  // A proxied deployment can repoint the host via `baseUrlEnvVar` (e.g. a
  // LiteLLM gateway); an unset/empty env var falls back to the configured
  // constant, so the default self-hosted path is byte-for-byte unchanged.
  const baseUrl = (host.baseUrlEnvVar ? process.env[host.baseUrlEnvVar] : undefined) || host.baseUrl
  // When the caller wants thinking off (the cheap single-shot tiers), pin GLM's
  // chat-template thinking switch. With `thinkingFormat: 'qwen-chat-template'`
  // and no request-time reasoning effort (the explain/classify callers pass
  // none), pi-ai emits `chat_template_kwargs: { enable_thinking: false }` on
  // DeepInfra's vLLM route. That branch requires `reasoning: true`, which the
  // GLM tier sets — so the trace is suppressed at the request, not the model.
  const compat: OpenAICompletionsCompat | undefined = suppressThinking
    ? { ...host.compat, thinkingFormat: 'qwen-chat-template' }
    : host.compat
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: entry.piAiProvider,
    baseUrl,
    reasoning: meta.reasoning,
    input: ['text'],
    cost: meta.cost,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    ...(compat ? { compat } : {}),
  }
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
  // Custom hosts (DeepInfra) aren't in pi-ai's env-var map — read their
  // documented env var directly. Catalog providers fall back to pi-ai.
  const fromEnv = entry.openaiCompatible
    ? process.env[entry.openaiCompatible.apiKeyEnvVar]
    : getEnvApiKey(entry.piAiProvider)
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return undefined
}

/**
 * The environment variable an operator sets to supply this provider's key,
 * shown in onboarding hints. Custom hosts carry their own var (DeepInfra →
 * `DEEPINFRA_TOKEN`); catalog providers derive it from the pi-ai vendor id
 * (`anthropic` → `ANTHROPIC_API_KEY`), matching pi-ai's `getEnvApiKey` map.
 */
export function agentProviderApiKeyEnvVar(id: AgentProviderId): string {
  const entry = AGENT_PROVIDERS[id]
  return entry.openaiCompatible
    ? entry.openaiCompatible.apiKeyEnvVar
    : `${entry.piAiProvider.toUpperCase()}_API_KEY`
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
