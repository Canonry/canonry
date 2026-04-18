import { describe, it, expect } from 'vitest'
import { getModel } from '@mariozechner/pi-ai'
import {
  AGENT_PROVIDERS,
  AgentProviders,
  agentProvidersByPriority,
  buildAgentProvidersResponse,
  coerceAgentProvider,
  findByPiAiProvider,
  getAgentProvider,
  listAgentProviders,
  resolveApiKeyFor,
  resolveApiKeySource,
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

  it('every registered default model resolves against pi-ai at runtime', () => {
    expect(() => validateAgentProviderRegistry()).not.toThrow()
    for (const provider of listAgentProviders()) {
      const entry = getAgentProvider(provider)
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
