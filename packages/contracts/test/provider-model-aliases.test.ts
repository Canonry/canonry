import { describe, expect, it } from 'vitest'
import { PROVIDER_MODEL_ALIASES, resolveProviderModel } from '../src/models.js'

describe('resolveProviderModel', () => {
  it.each([
    ['sonar', 'fast'],
    ['sonar-pro', 'low'],
    ['sonar-reasoning', 'low'],
    ['sonar-reasoning-pro', 'low'],
    ['sonar-deep-research', 'medium'],
    ['fast-search', 'fast'],
    ['pro-search', 'low'],
    ['deep-research', 'medium'],
    ['advanced-deep-research', 'high'],
  ])('maps retired perplexity id %s to %s', (retired, replacement) => {
    expect(resolveProviderModel('perplexity', retired)).toBe(replacement)
  })

  it('leaves current perplexity presets and model slugs unchanged', () => {
    for (const model of ['fast', 'low', 'medium', 'high', 'xhigh', 'perplexity/sonar', 'openai/gpt-5.1']) {
      expect(resolveProviderModel('perplexity', model)).toBe(model)
    }
  })

  it('every alias target is itself current, so one lookup is enough', () => {
    for (const [provider, aliases] of Object.entries(PROVIDER_MODEL_ALIASES)) {
      for (const target of Object.values(aliases)) {
        expect(resolveProviderModel(provider, target)).toBe(target)
      }
    }
  })

  it('only applies an alias to the provider that retired it', () => {
    expect(resolveProviderModel('openai', 'sonar')).toBe('sonar')
    expect(resolveProviderModel('local', 'fast-search')).toBe('fast-search')
    expect(resolveProviderModel('not-a-provider', 'sonar')).toBe('sonar')
  })

  it('does not trim, fold case, or resolve inherited object keys', () => {
    expect(resolveProviderModel('perplexity', ' sonar ')).toBe(' sonar ')
    expect(resolveProviderModel('perplexity', 'Sonar')).toBe('Sonar')
    expect(resolveProviderModel('perplexity', 'toString')).toBe('toString')
    expect(resolveProviderModel('perplexity', '__proto__')).toBe('__proto__')
  })
})
