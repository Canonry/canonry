import { describe, expect, it } from 'vitest'
import { getProviderLocationHandling, isSearchLocationIgnored } from '../src/provider.js'
import { RetrievalStatuses } from '../src/retrieval.js'

describe('getProviderLocationHandling', () => {
  it('reports prompt-injection providers (Gemini, Perplexity, Local)', () => {
    expect(getProviderLocationHandling('gemini').treatment).toBe('prompt')
    expect(getProviderLocationHandling('perplexity').treatment).toBe('prompt')
    expect(getProviderLocationHandling('local').treatment).toBe('prompt')
  })

  it('reports request-param providers (OpenAI, Claude, Muse)', () => {
    expect(getProviderLocationHandling('openai').treatment).toBe('request-param')
    expect(getProviderLocationHandling('claude').treatment).toBe('request-param')
    expect(getProviderLocationHandling('muse')).toEqual({
      treatment: 'request-param',
      supportsLocationContext: true,
      description: 'Location sent as a structured `user_location` field on Muse’s web_search tool.',
    })
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
    for (const name of ['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local', 'cdp:chatgpt']) {
      const handling = getProviderLocationHandling(name)
      expect(handling.description.length).toBeGreaterThan(0)
    }
  })
})

describe('isSearchLocationIgnored', () => {
  it.each(['muse', 'openai', 'claude'])('ignores %s search location only when search did not run', (provider) => {
    expect(isSearchLocationIgnored(provider, RetrievalStatuses['not-used'])).toBe(true)
    for (const status of [RetrievalStatuses.used, RetrievalStatuses.unknown, RetrievalStatuses['not-applicable']]) {
      expect(isSearchLocationIgnored(provider, status)).toBe(false)
    }
  })

  it.each(['gemini', 'perplexity', 'local', 'cdp:chatgpt', 'custom'])('preserves %s location treatment without search', (provider) => {
    expect(isSearchLocationIgnored(provider, RetrievalStatuses['not-used'])).toBe(false)
  })
})
