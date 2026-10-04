import { describe, it, expect } from 'vitest'
import { LLM_CAPABILITIES, LlmCapabilities, RETIRED_AGENT_PROVIDER_IDS } from '@ainyc/canonry-contracts'
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
import { aeroModels } from '../src/agent/pi-models.js'

describe('agent provider registry', () => {
  it('registers exactly claude, openai, gemini and zai', () => {
    expect([...listAgentProviders()].sort()).toEqual(['claude', 'gemini', 'openai', 'zai'])
    expect(Object.keys(AGENT_PROVIDERS).sort()).toEqual(['claude', 'gemini', 'openai', 'zai'])
  })

  it('auto-detects in the order claude, openai, gemini, zai', () => {
    expect(agentProvidersByPriority()).toEqual(['claude', 'openai', 'gemini', 'zai'])
  })

  it('every provider resolves from the pi-ai catalog under its own vendor id', () => {
    // There is no custom-host model builder: each resolved model is the
    // catalog entry, and its `provider` (what the agent loop hands back to
    // getApiKey) maps back to the registry entry's key resolver.
    for (const provider of listAgentProviders()) {
      const entry = getAgentProvider(provider)
      const model = resolveModelForCapability(provider, LlmCapabilities.agent) as { id?: string; provider?: string }
      expect(model.provider).toBe(entry.piAiProvider)
      expect(model.id).toBe(aeroModels.getModel(entry.piAiProvider, entry.defaultModel)?.id)
      expect(
        resolveApiKeyFor(model.provider!, { providers: { [provider]: { apiKey: `cfg-${provider}` } } }),
      ).toBe(`cfg-${provider}`)
    }
  })

  it('does not register or coerce a retired provider id', () => {
    for (const retired of RETIRED_AGENT_PROVIDER_IDS) {
      expect(listAgentProviders()).not.toContain(retired)
      expect(AGENT_PROVIDERS).not.toHaveProperty(retired)
      expect(coerceAgentProvider(retired)).toBeUndefined()
      expect(findByPiAiProvider(retired)).toBeUndefined()
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
      const model = aeroModels.getModel(entry.piAiProvider, entry.defaultModel)
      expect(model, `pi-ai missing ${entry.piAiProvider}/${entry.defaultModel}`).toBeDefined()
    }
  })


  it('uses a Gemini default model that does not require separate thinking-mode config', () => {
    expect(getAgentProvider('gemini').defaultModel).toBe('gemini-flash-latest')
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
    const envName = agentProviderApiKeyEnvVar(provider)
    const prior = process.env[envName]
    // Anthropic reads ANTHROPIC_OAUTH_TOKEN first; clear it so the plain var is the one found.
    const priorOauth = process.env.ANTHROPIC_OAUTH_TOKEN
    delete process.env.ANTHROPIC_OAUTH_TOKEN
    process.env[envName] = 'from-env'
    try {
      const res = resolveApiKeySource(provider, {})
      expect(res).toEqual({ key: 'from-env', source: 'env' })
    } finally {
      if (prior === undefined) delete process.env[envName]
      else process.env[envName] = prior
      if (priorOauth !== undefined) process.env.ANTHROPIC_OAUTH_TOKEN = priorOauth
    }
  })

  it('agentProviderApiKeyEnvVar maps each provider to its plain API key var', () => {
    const byProvider = Object.fromEntries(
      listAgentProviders().map((p) => [p, agentProviderApiKeyEnvVar(p)]),
    )
    expect(byProvider).toEqual({
      claude: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      zai: 'ZAI_API_KEY',
    })
  })

  it('config beats env for every provider', () => {
    const envNames = listAgentProviders().map(agentProviderApiKeyEnvVar)
    const priors = envNames.map((name) => [name, process.env[name]] as const)
    for (const name of envNames) process.env[name] = 'from-env'
    try {
      for (const provider of listAgentProviders()) {
        expect(
          resolveApiKeySource(provider, { providers: { [provider]: { apiKey: 'cfg' } } }),
          `config should win for ${provider}`,
        ).toEqual({ key: 'cfg', source: 'config' })
      }
    } finally {
      for (const [name, prior] of priors) {
        if (prior === undefined) delete process.env[name]
        else process.env[name] = prior
      }
    }
  })

  it('ignores a key stored under a retired provider id', () => {
    for (const retired of RETIRED_AGENT_PROVIDER_IDS) {
      expect(resolveApiKeySource(retired, { providers: { [retired]: { apiKey: 'cfg' } } })).toBeUndefined()
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
    // Wipe all relevant env vars so detection uses config only. Anthropic
    // also reads ANTHROPIC_OAUTH_TOKEN ahead of its plain API key var.
    const priors: Record<string, string | undefined> = {}
    for (const envName of [...listAgentProviders().map(agentProviderApiKeyEnvVar), 'ANTHROPIC_OAUTH_TOKEN']) {
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
    const lowerEnvNames = [agentProviderApiKeyEnvVar(lower)]
    if (getAgentProvider(lower).piAiProvider === 'anthropic') lowerEnvNames.push('ANTHROPIC_OAUTH_TOKEN')
    const priors = lowerEnvNames.map((name) => [name, process.env[name]] as const)
    for (const name of lowerEnvNames) delete process.env[name]
    try {
      const res = buildAgentProvidersResponse({
        providers: { [target]: { apiKey: 'cfg' } },
      })
      expect(res.defaultProvider).toBe(target)
    } finally {
      for (const [name, prior] of priors) {
        if (prior === undefined) delete process.env[name]
        else process.env[name] = prior
      }
    }
  })

  it('ignores a retired provider pin and falls back to the highest-priority configured entry', () => {
    // Clear every env key so only the config key below configures a provider.
    const envNames = [...listAgentProviders().map(agentProviderApiKeyEnvVar), 'ANTHROPIC_OAUTH_TOKEN']
    const priors = envNames.map((name) => [name, process.env[name]] as const)
    for (const name of envNames) delete process.env[name]
    try {
      for (const retired of RETIRED_AGENT_PROVIDER_IDS) {
        const res = buildAgentProvidersResponse({
          providers: { [retired]: { apiKey: 'stale' }, zai: { apiKey: 'cfg' } },
          agent: { provider: retired, model: 'stale-model' },
        })
        expect(res.providers.map((p) => p.id)).not.toContain(retired)
        expect(res.defaultProvider).toBe('zai')
        const zai = res.providers.find((p) => p.id === 'zai')
        // The stale pin's model never leaks onto the fallback provider.
        expect(zai?.defaultModel).toBe(getAgentProvider('zai').defaultModel)
        expect(zai?.keySource).toBe('config')
      }
    } finally {
      for (const [name, prior] of priors) {
        if (prior === undefined) delete process.env[name]
        else process.env[name] = prior
      }
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
        const model = aeroModels.getModel(entry.piAiProvider, modelId)
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
    const before = baseUrlOf(aeroModels.getModel('google', geminiAgentId))
    withGeminiBaseUrl('http://172.17.0.1:4610/gemini', () => {
      resolveModelForCapability('gemini', LlmCapabilities.agent)
    })
    const after = baseUrlOf(aeroModels.getModel('google', geminiAgentId))
    expect(after).toBe(before)
    expect(after ?? '').not.toContain('172.17.0.1')
  })

  it('leaves the default Google host untouched when GEMINI_BASE_URL is unset', () => {
    withGeminiBaseUrl(undefined, () => {
      const fromRegistry = baseUrlOf(aeroModels.getModel('google', geminiAgentId))
      expect(baseUrlOf(resolveModelForCapability('gemini', LlmCapabilities.agent))).toBe(fromRegistry)
    })
  })

  it('does not redirect other native providers (openai) when only GEMINI_BASE_URL is set', () => {
    withGeminiBaseUrl('http://172.17.0.1:4610/gemini', () => {
      expect(baseUrlOf(resolveModelForCapability('openai', LlmCapabilities.agent)) ?? '').not.toContain('172.17.0.1')
    })
  })
})
