import { describe, expect, it } from 'vitest'
import {
  assertEngineRouteCanMeasure,
  buildEngineRoutePublicDto,
  buildImplicitNativeEngineRoute,
  canonicalEngineRoutePolicyJson,
  deriveEngineRouteId,
  ENGINE_CONNECTION_PRESET_DEFAULTS,
  engineConnectionConfigSchema,
  engineRouteConfigSchema,
  engineRouteUpsertInputSchema,
  engineRouteReadiness,
  nextEngineRouteRevision,
  normalizeEngineConnection,
  upsertEngineConnection,
} from '../src/engine-routes.js'

describe('engine route contracts', () => {
  it('normalizes a gateway preset and never exposes its secret', () => {
    const connection = normalizeEngineConnection({
      id: 'openrouter-main',
      label: 'OpenRouter',
      preset: 'openrouter',
      apiKey: 'secret-never-returned',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 30, maxRequestsPerDay: 500 },
    })

    expect(connection.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(connection.protocol).toBe('openai-compatible')
    expect(buildEngineRoutePublicDto(connection)).toMatchObject({
      id: 'openrouter-main',
      secretConfigured: true,
      preset: 'openrouter',
    })
    expect(JSON.stringify(buildEngineRoutePublicDto(connection))).not.toContain('secret-never-returned')
    expect(JSON.stringify(buildEngineRoutePublicDto(connection))).not.toContain('apiKey')
  })

  it('requires an explicit endpoint for custom OpenAI-compatible connections', () => {
    expect(engineConnectionConfigSchema.safeParse({
      id: 'custom', label: 'Custom', preset: 'custom-openai-compatible', quota: {
        maxConcurrency: 1, maxRequestsPerMinute: 1, maxRequestsPerDay: 1,
      },
    }).success).toBe(false)
  })

  it('keeps OpenRouter, LiteLLM, and Vercel presets portable protocol defaults', () => {
    for (const [preset, expected] of Object.entries(ENGINE_CONNECTION_PRESET_DEFAULTS)) {
      const connection = normalizeEngineConnection({
        id: `${preset}-main`, label: preset, preset: preset as keyof typeof ENGINE_CONNECTION_PRESET_DEFAULTS,
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
      })
      expect(connection).toMatchObject({ protocol: expected.protocol, baseUrl: expected.baseUrl })
    }
    expect(ENGINE_CONNECTION_PRESET_DEFAULTS.litellm.baseUrl).toBe('http://localhost:4000')
  })

  it('preserves an existing connection secret when a redacted settings update omits apiKey', () => {
    const existing = normalizeEngineConnection({
      id: 'openrouter-main', label: 'OpenRouter', preset: 'openrouter', apiKey: 'keep-this-secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 30, maxRequestsPerDay: 500 },
    })

    const updated = upsertEngineConnection(existing, {
      id: existing.id, label: 'OpenRouter production', preset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/',
      quota: existing.quota,
    })

    expect(updated.apiKey).toBe('keep-this-secret')
    expect(buildEngineRoutePublicDto(updated)).toMatchObject({ secretConfigured: true })
  })

  it('requires a replacement secret before a redacted update can repoint an existing gateway', () => {
    const existing = normalizeEngineConnection({
      id: 'openrouter-main', label: 'OpenRouter', preset: 'openrouter', apiKey: 'keep-this-secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 30, maxRequestsPerDay: 500 },
    })

    expect(() => upsertEngineConnection(existing, {
      id: existing.id, label: 'Replacement gateway', preset: 'custom-openai-compatible',
      baseUrl: 'https://gateway.example/v1', quota: existing.quota,
    })).toThrow(/explicit apiKey/i)

    expect(upsertEngineConnection(existing, {
      id: existing.id, label: 'Replacement gateway', preset: 'custom-openai-compatible',
      baseUrl: 'https://gateway.example/v1', apiKey: 'replacement-secret', quota: existing.quota,
    })).toMatchObject({ baseUrl: 'https://gateway.example/v1', apiKey: 'replacement-secret' })
  })

  it('uses a durable configured route id and increments only a measurement-relevant revision', () => {
    const existing = engineRouteConfigSchema.parse({
      id: 'route-openrouter-main',
      label: 'General analysis',
      connectionId: 'openrouter-main',
      modelId: 'openai/gpt-5.4',
      revision: 2,
      capabilities: { kind: 'text-only' },
    })

    expect(nextEngineRouteRevision(existing, { ...existing, label: 'Analysis' })).toBe(2)
    expect(nextEngineRouteRevision(existing, { ...existing, modelId: 'openai/gpt-5.5' })).toBe(3)
    expect(nextEngineRouteRevision(existing, {
      ...existing,
      capabilities: { kind: 'verified-measurement', fallback: 'disabled', retrieval: true, citations: true, location: true, servedModel: true },
    })).toBe(3)
  })

  it('derives a stable namespaced route id from connection and model identity', () => {
    expect(deriveEngineRouteId('gateway-one', 'openai/gpt-5.4')).toBe(deriveEngineRouteId('gateway-one', 'openai/gpt-5.4'))
    expect(deriveEngineRouteId('gateway-one', 'openai/gpt-5.4')).not.toBe(deriveEngineRouteId('gateway-one', 'openai/gpt-5.5'))
    expect(deriveEngineRouteId('gateway-one', 'openai/gpt-5.4')).toMatch(/^route:/)
  })

  it('does not accept route identity, revision, or evidence claims from a settings writer', () => {
    expect(engineRouteUpsertInputSchema.parse({
      label: 'Analysis', connectionId: 'openrouter-main', modelId: 'openai/gpt-5.4',
    })).toEqual({ label: 'Analysis', connectionId: 'openrouter-main', modelId: 'openai/gpt-5.4' })
    expect(engineRouteUpsertInputSchema.safeParse({
      id: 'route-client-picked', label: 'Analysis', connectionId: 'openrouter-main', modelId: 'openai/gpt-5.4', revision: 99,
    }).success).toBe(false)
  })

  it('keeps generic routes text-only and fails closed for answer-visibility measurement', () => {
    const route = engineRouteConfigSchema.parse({
      id: 'route-openrouter-main',
      label: 'General analysis',
      connectionId: 'openrouter-main',
      modelId: 'openai/gpt-5.4',
      revision: 1,
      capabilities: { kind: 'text-only' },
    })

    expect(engineRouteReadiness(route)).toEqual({ state: 'text-ready', measurementReady: false })
    expect(() => assertEngineRouteCanMeasure(route)).toThrow(/does not prove retrieval, citation, location, and served-model evidence/i)
  })

  it('preserves native providers as implicit stable routes', () => {
    const native = buildImplicitNativeEngineRoute({
      provider: 'openai', displayName: 'OpenAI', defaultModel: 'gpt-5.4',
      capabilities: { kind: 'verified-measurement', fallback: 'disabled', retrieval: true, citations: true, location: true, servedModel: true },
    })

    expect(native).toMatchObject({
      id: 'native:openai',
      connectionId: 'native:openai',
      source: 'implicit-native',
      revision: 1,
    })
    expect(engineRouteReadiness(native)).toEqual({ state: 'measurement-ready', measurementReady: true })
  })

  it('keeps route policy separate from the requested model', () => {
    const route = engineRouteConfigSchema.parse({
      id: 'route:openrouter-main',
      label: 'Analysis',
      connectionId: 'openrouter-main',
      modelId: 'openai/gpt-5.4',
      revision: 4,
      source: 'configured',
      capabilities: { kind: 'text-only' },
    })

    const base = canonicalEngineRoutePolicyJson(route, {
      id: 'openrouter-main', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
    })
    expect(canonicalEngineRoutePolicyJson({ ...route, label: 'Internal analysis' }, {
      id: 'openrouter-main', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
    })).toBe(base)
    // Requested model is canonicalized in execution identity itself. Keeping
    // it out of the policy fingerprint means a project override cannot claim
    // the route default was the model it actually asked for.
    expect(canonicalEngineRoutePolicyJson({ ...route, modelId: 'openai/gpt-5.5' }, {
      id: 'openrouter-main', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
    })).toBe(base)
    expect(canonicalEngineRoutePolicyJson(route, {
      id: 'openrouter-main', protocol: 'openai-compatible', baseUrl: 'https://gateway.example/v1',
    })).not.toBe(base)
  })

  it('makes a native execution endpoint part of policy without serializing URL credentials', () => {
    const native = buildImplicitNativeEngineRoute({
      provider: 'openai', displayName: 'OpenAI', defaultModel: 'gpt-5.4',
      capabilities: { kind: 'verified-measurement', fallback: 'disabled', retrieval: true, citations: true, location: true, servedModel: true },
    })
    const before = canonicalEngineRoutePolicyJson(
      native,
      undefined,
      'https://operator:route-secret@gateway-one.example/v1?api_key=query-secret#fragment',
    )
    const sameEndpointDifferentCredential = canonicalEngineRoutePolicyJson(
      native,
      undefined,
      'https://another-user:replacement-secret@gateway-one.example/v1?api_key=another-query-secret',
    )
    const after = canonicalEngineRoutePolicyJson(native, undefined, 'https://gateway-two.example/v1')

    expect(sameEndpointDifferentCredential).toBe(before)
    expect(after).not.toBe(before)
    expect(before).not.toContain('route-secret')
    expect(before).not.toContain('query-secret')
    expect(canonicalEngineRoutePolicyJson({ ...native, label: 'OpenAI production' }, undefined, 'https://gateway-one.example/v1')).toBe(before)
  })
})
