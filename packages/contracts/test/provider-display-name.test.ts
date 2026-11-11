import { describe, expect, it } from 'vitest'
import { defaultProviderDisplayName, providerConnectionName } from '../src/provider.js'

describe('defaultProviderDisplayName', () => {
  it.each([
    ['openai', 'OpenAI'],
    ['openrouter', 'OpenRouter'],
    ['claude', 'Claude'],
    ['local', 'Local'],
    // Stored keys are lowercase; a key typed with stray case or spaces still reads the same.
    [' Gemini ', 'Gemini'],
    // A provider without a built-in name reads as its key with a capital first letter.
    ['acme', 'Acme'],
  ])('names %j as %j', (key, name) => {
    expect(defaultProviderDisplayName(key)).toBe(name)
  })

  it('names the account behind a routed model by its connection', () => {
    expect(defaultProviderDisplayName(providerConnectionName('openrouter:vendor/model-a'))).toBe('OpenRouter')
  })
})
