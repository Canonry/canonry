import { describe, it, expect } from 'vitest'
import { getModel } from '@mariozechner/pi-ai'
import { LLM_CAPABILITIES, LlmCapabilities } from '@ainyc/canonry-contracts'
import {
  AGENT_PROVIDERS,
  AgentProviders,
  PROVIDER_MODELS,
  agentProviderApiKeyEnvVar,
  agentProvidersByPriority,
  buildAgentProvidersResponse,
  coerceAgentProvider,
  findByPiAiProvider,
  getAgentProvider,
  listAgentProviders,
  resolveApiKeyFor,
  resolveApiKeySource,
  resolveModelForCapability,
  resolveModelForProvider,
  validateAgentProviderRegistry,
  type SupportedAgentProvider,
} from '../src/agent/providers.js'

describe('agent provider registry', () => {
  it('exposes at least the expected baseline providers', () => {
    for (const p of ['claude', 'openai', 'gemini', 'zai'] as const) {
      expect(AGENT_PROVIDERS).toHaveProperty(p)
    }
  })

  it('derives SupportedAgentProvider + AgentProviders enum from the registry', () => {
    const keys = listAgentProviders()
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      expect(AgentProviders[k]).toBe(k)
    }
  })

  it('every registered default model resolves at runtime', () => {
    expect(() => validateAgentProviderRegistry()).not.toThrow()
    for (const provider of listAgentProviders()) {
      const entry = getAgentProvider(provider)
      if (entry.openaiCompatible) {
        // Custom OpenAI-compatible host (e.g. DeepInfra) — not in pi-ai's
        // catalog. Resolve via the builder and assert it points at the host.
        const model = resolveModelForCapability(provider, LlmCapabilities.agent)
        expect((model as { id?: string }).id).toBe(entry.defaultModel)
        expect((model as { baseUrl?: string }).baseUrl).toBe(entry.openaiCompatible.baseUrl)
        continue
      }
      const model = getModel(entry.piAiProvider as never, entry.defaultModel as never)
      expect(model, `pi-ai missing ${entry.piAiProvider}/${entry.defaultModel}`).toBeDefined()
    }
  })


  it('uses a Gemini default model that does not require separate thinking-mode config', () => {
    expect(getAgentProvider('gemini').defaultModel).toBe('gemini-2.5-flash')
  })

  it('registry rows each carry every required field', () => {
    for (const provider of listAgentProviders()) {
      const e = getAgentProvider(provider)
      expect(e.piAiProvider).toBeTruthy()
      expect(e.label).toBeTruthy()
      expect(e.defaultModel).toBeTruthy()
      expect(typeof e.autoDetectPriority).toBe('number')
    }
  })

  it('autoDetectPriority values are unique (deterministic sort)', () => {
    const priorities = listAgentProviders().map((p) => getAgentProvider(p).autoDetectPriority)
    expect(new Set(priorities).size).toBe(priorities.length)
  })

  it('agentProvidersByPriority sorts ascending', () => {
    const sorted = agentProvidersByPriority()
    for (let i = 1; i < sorted.length; i++) {
      const prev = getAgentProvider(sorted[i - 1]).autoDetectPriority
      const curr = getAgentProvider(sorted[i]).autoDetectPriority
      expect(curr).toBeGreaterThan(prev)
    }
  })

  it('coerceAgentProvider accepts known values and rejects unknown', () => {
    for (const k of listAgentProviders()) {
      expect(coerceAgentProvider(k)).toBe(k)
    }
    expect(coerceAgentProvider('not-a-provider')).toBeUndefined()
    expect(coerceAgentProvider(undefined)).toBeUndefined()
  })

  it('findByPiAiProvider resolves every registered pi-ai id', () => {
    for (const provider of listAgentProviders()) {
      const entry = getAgentProvider(provider)
      expect(findByPiAiProvider(entry.piAiProvider)).toBe(entry)
    }
    expect(findByPiAiProvider('nope')).toBeUndefined()
  })

  it('resolveModelForProvider throws on a missing model id', () => {
    const anyProvider = listAgentProviders()[0] as SupportedAgentProvider
    expect(() => resolveModelForProvider(anyProvider, 'definitely-not-a-model-id')).toThrow()
  })
})

describe('resolveApiKeyFor', () => {
  it('prefers canonry config over env var', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const key = resolveApiKeyFor(provider, {
      providers: { [provider]: { apiKey: 'from-config' } },
    })
    expect(key).toBe('from-config')
  })

  it('accepts the pi-ai provider string directly (resolver-callback path)', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const entry = getAgentProvider(provider)
    const key = resolveApiKeyFor(entry.piAiProvider, {
      providers: { [provider]: { apiKey: 'from-config' } },
    })
    expect(key).toBe('from-config')
  })

  it('returns undefined for an unknown provider string', () => {
    expect(resolveApiKeyFor('unknown', {})).toBeUndefined()
  })
})

describe('resolveApiKeySource', () => {
  it('tags config-sourced keys with source="config"', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const res = resolveApiKeySource(provider, {
      providers: { [provider]: { apiKey: 'from-config' } },
    })
    expect(res).toEqual({ key: 'from-config', source: 'config' })
  })

  it('tags env-sourced keys with source="env" when config is empty', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const entry = getAgentProvider(provider)
    const envName = `${entry.piAiProvider.toUpperCase()}_API_KEY`
    const prior = process.env[envName]
    process.env[envName] = 'from-env'
    try {
      const res = resolveApiKeySource(provider, {})
      expect(res).toEqual({ key: 'from-env', source: 'env' })
    } finally {
      if (prior === undefined) delete process.env[envName]
      else process.env[envName] = prior
    }
  })
})

describe('buildAgentProvidersResponse', () => {
  it('lists every registered provider once', () => {
    const res = buildAgentProvidersResponse({})
    const ids = res.providers.map((p) => p.id).sort()
    const expected = [...listAgentProviders()].sort()
    expect(ids).toEqual(expected)
  })

  it('marks configured-via-config providers with keySource="config"', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const res = buildAgentProvidersResponse({
      providers: { [provider]: { apiKey: 'cfg' } },
    })
    const match = res.providers.find((p) => p.id === provider)
    expect(match?.configured).toBe(true)
    expect(match?.keySource).toBe('config')
  })

  it('marks providers with no key as configured=false / keySource=null', () => {
    // Wipe all relevant env vars so detection uses config only.
    const priors: Record<string, string | undefined> = {}
    for (const p of listAgentProviders()) {
      const envName = `${getAgentProvider(p).piAiProvider.toUpperCase()}_API_KEY`
      priors[envName] = process.env[envName]
      delete process.env[envName]
    }
    try {
      const res = buildAgentProvidersResponse({})
      for (const p of res.providers) {
        expect(p.configured).toBe(false)
        expect(p.keySource).toBeNull()
      }
      expect(res.defaultProvider).toBeNull()
    } finally {
      for (const [k, v] of Object.entries(priors)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('defaultProvider matches the highest-priority configured entry', () => {
    const sorted = agentProvidersByPriority()
    // Configure the #2 priority entry; #1 must remain unconfigured.
    const target = sorted[1] as SupportedAgentProvider
    const lower = sorted[0] as SupportedAgentProvider
    const lowerEnvName = `${getAgentProvider(lower).piAiProvider.toUpperCase()}_API_KEY`
    const priorEnv = process.env[lowerEnvName]
    delete process.env[lowerEnvName]
    try {
      const res = buildAgentProvidersResponse({
        providers: { [target]: { apiKey: 'cfg' } },
      })
      expect(res.defaultProvider).toBe(target)
    } finally {
      if (priorEnv === undefined) delete process.env[lowerEnvName]
      else process.env[lowerEnvName] = priorEnv
    }
  })
})

describe('PROVIDER_MODELS capability tiers', () => {
  // Single source of truth for "what model fills capability X on provider
  // Y." Adding a new capability to LlmCapabilities REQUIRES adding a row
  // for every provider — these tests are the guardrail that catches the
  // omission at CI time rather than the first request that uses it.

  it('every provider declares every capability tier', () => {
    for (const provider of listAgentProviders()) {
      for (const capability of LLM_CAPABILITIES) {
        const modelId = PROVIDER_MODELS[provider][capability]
        expect(modelId, `PROVIDER_MODELS[${provider}][${capability}] is missing`).toBeTruthy()
        expect(typeof modelId).toBe('string')
      }
    }
  })

  it('AGENT_PROVIDERS.defaultModel mirrors PROVIDER_MODELS[id].agent (single source of truth)', () => {
    for (const provider of listAgentProviders()) {
      expect(
        getAgentProvider(provider).defaultModel,
        `defaultModel drift on ${provider}`,
      ).toBe(PROVIDER_MODELS[provider][LlmCapabilities.agent])
    }
  })

  it('every (provider, capability) pair resolves to a model', () => {
    for (const provider of listAgentProviders()) {
      for (const capability of LLM_CAPABILITIES) {
        const entry = getAgentProvider(provider)
        const modelId = PROVIDER_MODELS[provider][capability]
        if (entry.openaiCompatible) {
          // Custom host: the builder constructs the model from the slug
          // (no pi-ai catalog entry to look up).
          const model = resolveModelForCapability(provider, capability)
          expect((model as { id?: string }).id).toBe(modelId)
          continue
        }
        const model = getModel(entry.piAiProvider as never, modelId as never)
        expect(
          model,
          `pi-ai catalog missing ${entry.piAiProvider}/${modelId} (capability=${capability})`,
        ).toBeDefined()
      }
    }
  })

  it('validateAgentProviderRegistry walks every capability and catches drift', () => {
    // The validator runs every (provider, capability) plus the
    // defaultModel-mirror check. Doesn't throw on the current registry.
    expect(() => validateAgentProviderRegistry()).not.toThrow()
  })
})

describe('resolveModelForCapability', () => {
  it('returns each capability\'s model per provider', () => {
    for (const provider of listAgentProviders()) {
      for (const capability of LLM_CAPABILITIES) {
        const model = resolveModelForCapability(provider, capability)
        const expectedId = PROVIDER_MODELS[provider][capability]
        // pi-ai's Model exposes `id` (string). The resolver MUST return
        // the model whose id matches the registry entry — anything else
        // means the lookup found the wrong model for some provider.
        expect(
          (model as { id?: string }).id,
          `wrong model returned for ${provider} / ${capability}`,
        ).toBe(expectedId)
      }
    }
  })

  it('honors caller-supplied model override (per-call escape hatch)', () => {
    // Pick a known cross-capability model that exists for at least one
    // provider — every Claude tier currently uses a real model id, so
    // claude-haiku-4-7 (classify tier) is a safe override target for the
    // claude provider even when the caller requests the `agent`
    // capability.
    const overrideId = PROVIDER_MODELS.claude[LlmCapabilities.classify]
    const model = resolveModelForCapability('claude', LlmCapabilities.agent, overrideId)
    expect((model as { id?: string }).id).toBe(overrideId)
  })

  it('throws on an unknown model id (catches typos)', () => {
    expect(() =>
      resolveModelForCapability('claude', LlmCapabilities.agent, 'definitely-not-a-model-id'),
    ).toThrow()
  })

  it('resolveModelForProvider is a thin wrapper that delegates to the agent capability', () => {
    // Behavior-preserving equivalence: existing callers of
    // resolveModelForProvider get the same model they always got.
    for (const provider of listAgentProviders()) {
      const viaProvider = resolveModelForProvider(provider)
      const viaCapability = resolveModelForCapability(provider, LlmCapabilities.agent)
      expect((viaProvider as { id?: string }).id).toBe((viaCapability as { id?: string }).id)
    }
  })

  it('resolveModelForProvider passes through a model-id override', () => {
    const overrideId = PROVIDER_MODELS.claude[LlmCapabilities.classify]
    const viaProvider = resolveModelForProvider('claude', overrideId)
    const viaCapability = resolveModelForCapability('claude', LlmCapabilities.agent, overrideId)
    expect((viaProvider as { id?: string }).id).toBe((viaCapability as { id?: string }).id)
  })
})

describe('resolveModelForCapability: gemini proxy base URL override', () => {
  const PRIOR = process.env.GEMINI_BASE_URL
  function withGeminiBaseUrl<T>(value: string | undefined, fn: () => T): T {
    if (value === undefined) delete process.env.GEMINI_BASE_URL
    else process.env.GEMINI_BASE_URL = value
    try {
      return fn()
    } finally {
      if (PRIOR === undefined) delete process.env.GEMINI_BASE_URL
      else process.env.GEMINI_BASE_URL = PRIOR
    }
  }
  const baseUrlOf = (m: unknown) => (m as { baseUrl?: string }).baseUrl
  const geminiAgentId = PROVIDER_MODELS.gemini[LlmCapabilities.agent]

  it('repoints the gemini agent model at GEMINI_BASE_URL and appends /v1beta', () => {
    withGeminiBaseUrl('http://172.17.0.1:4610/gemini', () => {
      const model = resolveModelForCapability('gemini', LlmCapabilities.agent)
      expect(baseUrlOf(model)).toBe('http://172.17.0.1:4610/gemini/v1beta')
    })
  })

  it('does not double-append /v1beta and trims a trailing slash', () => {
    withGeminiBaseUrl('http://host/gemini/v1beta/', () => {
      expect(baseUrlOf(resolveModelForCapability('gemini', LlmCapabilities.agent))).toBe('http://host/gemini/v1beta')
    })
  })

  it('never mutates the shared pi-ai registry Model (clones, not in place)', () => {
    const before = baseUrlOf(getModel('google' as never, geminiAgentId as never))
    withGeminiBaseUrl('http://172.17.0.1:4610/gemini', () => {
      resolveModelForCapability('gemini', LlmCapabilities.agent)
    })
    const after = baseUrlOf(getModel('google' as never, geminiAgentId as never))
    expect(after).toBe(before)
    expect(after ?? '').not.toContain('172.17.0.1')
  })

  it('leaves the default Google host untouched when GEMINI_BASE_URL is unset', () => {
    withGeminiBaseUrl(undefined, () => {
      const fromRegistry = baseUrlOf(getModel('google' as never, geminiAgentId as never))
      expect(baseUrlOf(resolveModelForCapability('gemini', LlmCapabilities.agent))).toBe(fromRegistry)
    })
  })

  it('does not redirect other native providers (openai) when only GEMINI_BASE_URL is set', () => {
    withGeminiBaseUrl('http://172.17.0.1:4610/gemini', () => {
      expect(baseUrlOf(resolveModelForCapability('openai', LlmCapabilities.agent)) ?? '').not.toContain('172.17.0.1')
    })
  })
})

describe('deepinfra (custom OpenAI-compatible host)', () => {
  // DeepInfra is agent-only, has no pi-ai catalog entry, and resolves models
  // by constructing a custom openai-completions object pointed at its base URL.
  type CompletionsModel = {
    id: string
    api: string
    provider: string
    baseUrl: string
    reasoning: boolean
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    compat?: { supportsDeveloperRole?: boolean; maxTokensField?: string; thinkingFormat?: string }
  }

  it('is registered, agent-only, and carries an openaiCompatible host config', () => {
    expect(listAgentProviders()).toContain('deepinfra')
    const entry = getAgentProvider('deepinfra')
    expect(entry.piAiProvider).toBe('deepinfra')
    expect(entry.openaiCompatible?.baseUrl).toBe('https://api.deepinfra.com/v1/openai')
    expect(entry.openaiCompatible?.apiKeyEnvVar).toBe('DEEPINFRA_TOKEN')
  })

  it('runs GLM-5.2 on all three tiers (agent, analyze, classify)', () => {
    expect(PROVIDER_MODELS.deepinfra[LlmCapabilities.agent]).toBe('zai-org/GLM-5.2')
    expect(PROVIDER_MODELS.deepinfra[LlmCapabilities.analyze]).toBe('zai-org/GLM-5.2')
    expect(PROVIDER_MODELS.deepinfra[LlmCapabilities.classify]).toBe('zai-org/GLM-5.2')
    // defaultModel mirrors the agent tier (covered generically elsewhere too).
    expect(getAgentProvider('deepinfra').defaultModel).toBe('zai-org/GLM-5.2')
  })

  it('builds an openai-completions model pointed at DeepInfra for every capability', () => {
    for (const capability of LLM_CAPABILITIES) {
      const model = resolveModelForCapability('deepinfra', capability) as unknown as CompletionsModel
      expect(model.api).toBe('openai-completions')
      // model.provider is what the agent loop hands back to getApiKey — must
      // be the canonical id so the deepinfra key resolver fires.
      expect(model.provider).toBe('deepinfra')
      expect(model.baseUrl).toBe('https://api.deepinfra.com/v1/openai')
      expect(model.id).toBe(PROVIDER_MODELS.deepinfra[capability])
    }
  })

  it('applies the open-model compat profile (no developer role, max_tokens field)', () => {
    const model = resolveModelForCapability('deepinfra', LlmCapabilities.agent) as unknown as CompletionsModel
    expect(model.compat?.supportsDeveloperRole).toBe(false)
    expect(model.compat?.maxTokensField).toBe('max_tokens')
  })

  it('suppresses thinking on the cheap tiers, not the agent tier', () => {
    // agent → host default thinking (no thinkingFormat pin).
    const agent = resolveModelForCapability('deepinfra', LlmCapabilities.agent) as unknown as CompletionsModel
    expect(agent.compat?.thinkingFormat).toBeUndefined()
    // analyze + classify → enable_thinking:false via GLM's chat-template switch,
    // merged onto (not replacing) the base open-model compat profile.
    for (const cap of [LlmCapabilities.analyze, LlmCapabilities.classify]) {
      const model = resolveModelForCapability('deepinfra', cap) as unknown as CompletionsModel
      expect(model.compat?.thinkingFormat).toBe('qwen-chat-template')
      expect(model.compat?.maxTokensField).toBe('max_tokens')
    }
  })

  it('applies per-slug known-model metadata and falls back for unknown slugs', () => {
    // GLM-5.2 is a known model → its published cost/reasoning metadata.
    const glm = resolveModelForCapability('deepinfra', LlmCapabilities.agent) as unknown as CompletionsModel
    expect(glm.reasoning).toBe(true)
    expect(glm.cost.input).toBe(0.95)
    expect(glm.cost.output).toBe(3.0)
    // An arbitrary user --model override falls back to defaultModelMeta (cost 0).
    const custom = resolveModelForCapability(
      'deepinfra',
      LlmCapabilities.agent,
      'meta-llama/Llama-4-Maverick',
    ) as unknown as CompletionsModel
    expect(custom.id).toBe('meta-llama/Llama-4-Maverick')
    expect(custom.cost.input).toBe(0)
  })

  it('resolves the key from DEEPINFRA_TOKEN env (not DEEPINFRA_API_KEY), config wins', () => {
    expect(agentProviderApiKeyEnvVar('deepinfra')).toBe('DEEPINFRA_TOKEN')
    // Catalog providers still derive their var from the pi-ai vendor id.
    expect(agentProviderApiKeyEnvVar('claude')).toBe('ANTHROPIC_API_KEY')

    const priorToken = process.env.DEEPINFRA_TOKEN
    const priorApiKey = process.env.DEEPINFRA_API_KEY
    process.env.DEEPINFRA_TOKEN = 'from-token'
    process.env.DEEPINFRA_API_KEY = 'wrong-var'
    try {
      // The wrong-named var is ignored; DEEPINFRA_TOKEN is read.
      expect(resolveApiKeySource('deepinfra', {})).toEqual({ key: 'from-token', source: 'env' })
      // Config still beats env.
      expect(
        resolveApiKeySource('deepinfra', { providers: { deepinfra: { apiKey: 'cfg' } } }),
      ).toEqual({ key: 'cfg', source: 'config' })
    } finally {
      if (priorToken === undefined) delete process.env.DEEPINFRA_TOKEN
      else process.env.DEEPINFRA_TOKEN = priorToken
      if (priorApiKey === undefined) delete process.env.DEEPINFRA_API_KEY
      else process.env.DEEPINFRA_API_KEY = priorApiKey
    }
  })

  it('surfaces deepinfra in the providers response, configured via DEEPINFRA_TOKEN', () => {
    const prior = process.env.DEEPINFRA_TOKEN
    process.env.DEEPINFRA_TOKEN = 'tok'
    try {
      const res = buildAgentProvidersResponse({})
      const di = res.providers.find((p) => p.id === 'deepinfra')
      expect(di).toBeDefined()
      expect(di?.label).toBe('DeepInfra (GLM / DeepSeek)')
      expect(di?.defaultModel).toBe('zai-org/GLM-5.2')
      expect(di?.configured).toBe(true)
      expect(di?.keySource).toBe('env')
    } finally {
      if (prior === undefined) delete process.env.DEEPINFRA_TOKEN
      else process.env.DEEPINFRA_TOKEN = prior
    }
  })

  it("reports DeepInfra's real 1M (fp4) context window for the shipped tiers", () => {
    // All three tiers run GLM-5.2, which serves at 1,048,576 (fp4) on DeepInfra.
    for (const capability of LLM_CAPABILITIES) {
      const model = resolveModelForCapability('deepinfra', capability) as unknown as { contextWindow: number }
      expect(model.contextWindow).toBe(1_048_576)
    }
    // An unknown user --model slug keeps the conservative fallback window.
    const custom = resolveModelForCapability(
      'deepinfra',
      LlmCapabilities.agent,
      'meta-llama/Llama-4-Maverick',
    ) as unknown as { contextWindow: number }
    expect(custom.contextWindow).toBe(131072)
  })

  it('repoints baseUrl via DEEPINFRA_BASE_URL when set, else uses the constant', () => {
    const DEFAULT = 'https://api.deepinfra.com/v1/openai'
    const baseUrlOf = () =>
      (resolveModelForCapability('deepinfra', LlmCapabilities.agent) as unknown as CompletionsModel).baseUrl
    const prior = process.env.DEEPINFRA_BASE_URL
    delete process.env.DEEPINFRA_BASE_URL
    try {
      expect(baseUrlOf()).toBe(DEFAULT) // unset → constant
      process.env.DEEPINFRA_BASE_URL = 'https://proxy.internal/v1/openai'
      expect(baseUrlOf()).toBe('https://proxy.internal/v1/openai') // set → proxy override
      process.env.DEEPINFRA_BASE_URL = ''
      expect(baseUrlOf()).toBe(DEFAULT) // empty string falls back to the constant
    } finally {
      if (prior === undefined) delete process.env.DEEPINFRA_BASE_URL
      else process.env.DEEPINFRA_BASE_URL = prior
    }
  })
})
