import { describe, it, expect } from 'vitest'
import { getModel } from '@mariozechner/pi-ai'
import {
  AGENT_PROVIDERS,
  AgentProviders,
  agentProvidersByPriority,
  coerceAgentProvider,
  findByPiAiProvider,
  getAgentProvider,
  listAgentProviders,
  resolveApiKeyFor,
  resolveModelForProvider,
  validateAgentProviderRegistry,
  type SupportedAgentProvider,
} from '../src/agent/providers.js'

describe('agent provider registry', () => {
  it('exposes at least the expected baseline providers', () => {
    for (const p of ['anthropic', 'openai', 'google', 'zai'] as const) {
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

  it('registry rows each carry every required field', () => {
    for (const provider of listAgentProviders()) {
      const e = getAgentProvider(provider)
      expect(e.piAiProvider).toBeTruthy()
      expect(e.label).toBeTruthy()
      expect(e.canonryConfigKey).toBeTruthy()
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
    const entry = getAgentProvider(provider)
    const key = resolveApiKeyFor(provider, {
      providers: { [entry.canonryConfigKey]: { apiKey: 'from-config' } },
    })
    expect(key).toBe('from-config')
  })

  it('accepts the pi-ai provider string directly (resolver-callback path)', () => {
    const provider = listAgentProviders()[0] as SupportedAgentProvider
    const entry = getAgentProvider(provider)
    const key = resolveApiKeyFor(entry.piAiProvider, {
      providers: { [entry.canonryConfigKey]: { apiKey: 'from-config' } },
    })
    expect(key).toBe('from-config')
  })

  it('returns undefined for an unknown provider string', () => {
    expect(resolveApiKeyFor('unknown', {})).toBeUndefined()
  })
})
