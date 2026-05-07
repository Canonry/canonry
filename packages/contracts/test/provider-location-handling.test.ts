import { describe, expect, it } from 'vitest'
import { getProviderLocationHandling } from '../src/provider.js'

describe('getProviderLocationHandling', () => {
  it('reports prompt-injection providers (Gemini, Perplexity, Local)', () => {
    expect(getProviderLocationHandling('gemini').treatment).toBe('prompt')
    expect(getProviderLocationHandling('perplexity').treatment).toBe('prompt')
    expect(getProviderLocationHandling('local').treatment).toBe('prompt')
  })

  it('reports request-param providers (OpenAI, Claude)', () => {
    expect(getProviderLocationHandling('openai').treatment).toBe('request-param')
    expect(getProviderLocationHandling('claude').treatment).toBe('request-param')
  })

  it('reports CDP browser as browser-geo (configured location does not reach the model)', () => {
    expect(getProviderLocationHandling('cdp:chatgpt').treatment).toBe('browser-geo')
  })

  it('falls back to ignored for unknown providers so the report does not over-promise', () => {
    const handling = getProviderLocationHandling('not-a-real-provider')
    expect(handling.treatment).toBe('ignored')
    expect(handling.description.length).toBeGreaterThan(0)
  })

  it('every known provider returns a non-empty description', () => {
    for (const name of ['gemini', 'openai', 'claude', 'perplexity', 'local', 'cdp:chatgpt']) {
      const handling = getProviderLocationHandling(name)
      expect(handling.description.length).toBeGreaterThan(0)
    }
  })
})
