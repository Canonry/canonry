import { describe, expect, it } from 'vitest'
import { isOpenRouterRoute, isProviderAvailable, isSweepProvider, openRouterRouteModel, openRouterRouteName, providerConnectionName } from '../src/provider.js'

describe('OpenRouter measurement route identity', () => {
  it('keeps different models and direct transports separate while sharing connection authority', () => {
    const gemini = openRouterRouteName('google/gemini-2.5-flash')
    const claude = openRouterRouteName('anthropic/claude-sonnet-4.6')
    expect(gemini).toBe('openrouter:google/gemini-2.5-flash')
    expect(claude).toBe('openrouter:anthropic/claude-sonnet-4.6')
    expect(openRouterRouteModel(gemini)).toBe('google/gemini-2.5-flash')
    expect([providerConnectionName(gemini), providerConnectionName(claude), providerConnectionName('gemini')]).toEqual(['openrouter', 'openrouter', 'gemini'])
    expect(isProviderAvailable(gemini, ['openrouter'])).toBe(true)
    expect(isProviderAvailable(gemini, ['gemini'])).toBe(false)
    expect(isSweepProvider('openrouter')).toBe(false)
    expect(isSweepProvider(gemini)).toBe(true)
  })

  it.each(['', 'openrouter', 'openrouter:google', 'openrouter:openrouter/auto', 'openrouter:openrouter/free', 'openrouter:openrouter/bodybuilder', 'openrouter:typesafe/jev-1.13', 'openrouter:google/model?api_key=x', 'openrouter:google/model#x'])('rejects an unpinned or malformed sweep route %s', route => {
    expect(isOpenRouterRoute(route)).toBe(false)
    expect(openRouterRouteModel(route)).toBeUndefined()
  })

  it('preserves variant suffixes as part of the model requested', () => {
    expect(openRouterRouteModel(openRouterRouteName('arcee-ai/trinity-large-preview:free'))).toBe('arcee-ai/trinity-large-preview:free')
    expect(() => openRouterRouteName('openrouter/auto')).toThrow('fixed vendor/model')
  })
})
