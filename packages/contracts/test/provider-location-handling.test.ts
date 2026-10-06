import { describe, expect, it } from 'vitest'
import { getProviderLocationHandling, isSearchLocationIgnored } from '../src/provider.js'
import { RetrievalStatuses } from '../src/retrieval.js'

describe('getProviderLocationHandling', () => {
  it('reports prompt-injection providers (Gemini, Local)', () => {
    expect(getProviderLocationHandling('gemini').treatment).toBe('prompt')
    expect(getProviderLocationHandling('local').treatment).toBe('prompt')
    expect(getProviderLocationHandling('gemini').supportsLocationContext).toBe(true)
    expect(getProviderLocationHandling('local').supportsLocationContext).toBe(true)
  })

  it('reports request-param providers (OpenAI, Claude, Perplexity, Muse)', () => {
    expect(getProviderLocationHandling('openai').treatment).toBe('request-param')
    expect(getProviderLocationHandling('claude').treatment).toBe('request-param')
    expect(getProviderLocationHandling('perplexity').treatment).toBe('request-param')
    for (const provider of ['openai', 'claude', 'perplexity']) {
      expect(getProviderLocationHandling(provider).supportsLocationContext).toBe(true)
    }
    expect(getProviderLocationHandling('muse')).toEqual({
      treatment: 'request-param',
      supportsLocationContext: true,
      description: 'Location sent as a structured `user_location` field on Muse’s web_search tool.',
    })
  })

  it('reports CDP browser as browser-geo (configured location does not reach the model)', () => {
    expect(getProviderLocationHandling('cdp:chatgpt').treatment).toBe('browser-geo')
    expect(getProviderLocationHandling('cdp:chatgpt').supportsLocationContext).toBe(false)
  })

  it('falls back to ignored for unknown providers so the report does not over-promise', () => {
    const handling = getProviderLocationHandling('not-a-real-provider')
    expect(handling.treatment).toBe('ignored')
    expect(handling.supportsLocationContext).toBe(false)
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
  it.each(['muse', 'openai', 'claude', 'perplexity'])('ignores %s search location only when search did not run', (provider) => {
    expect(isSearchLocationIgnored(provider, RetrievalStatuses['not-used'])).toBe(true)
    for (const status of [RetrievalStatuses.used, RetrievalStatuses.unknown, RetrievalStatuses['not-applicable']]) {
      expect(isSearchLocationIgnored(provider, status)).toBe(false)
    }
  })

  it.each(['gemini', 'local', 'cdp:chatgpt', 'custom'])('preserves %s location treatment without search', (provider) => {
    expect(isSearchLocationIgnored(provider, RetrievalStatuses['not-used'])).toBe(false)
  })
})
