import { describe, it, expect } from 'vitest'
import { extractCitedDomains, normalizeResult } from '../src/normalize.js'
import type { RawQueryResult, GroundingSource } from '@ainyc/canonry-contracts'

describe('extractCitedDomains', () => {
  it('extracts domains from valid URLs', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://www.example.com/page', title: 'Example' },
      { uri: 'https://blog.test.org/article', title: 'Test Blog' },
    ]
    const domains = extractCitedDomains(sources)
    expect(domains).toEqual(['example.com', 'blog.test.org'])
  })

  it('strips www prefix', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://www.mysite.com/', title: 'My Site' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['mysite.com'])
  })

  it('deduplicates domains', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://example.com/page1', title: 'Page 1' },
      { uri: 'https://www.example.com/page2', title: 'Page 2' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['example.com'])
  })

  it('skips ChatGPT and OpenAI internal domains', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://chatgpt.com/something', title: 'ChatGPT' },
      { uri: 'https://openai.com/blog', title: 'OpenAI' },
      { uri: 'https://example.com/real', title: 'Real Source' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['example.com'])
  })

  it('extracts domain from title as fallback for invalid URIs', () => {
    const sources: GroundingSource[] = [
      { uri: 'not-a-url', title: 'example.com - Some Page' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['example.com'])
  })

  it('returns empty array for no sources', () => {
    expect(extractCitedDomains([])).toEqual([])
  })
})

describe('normalizeResult', () => {
  it('extracts answer text from rawResponse', () => {
    const raw: RawQueryResult = {
      provider: 'cdp:chatgpt',
      rawResponse: { answerText: 'The best coffee in NYC is...' },
      model: 'chatgpt-web',
      groundingSources: [
        { uri: 'https://example.com/coffee', title: 'NYC Coffee Guide' },
      ],
      searchQueries: ['best coffee NYC'],
    }
    const result = normalizeResult(raw)
    expect(result.provider).toBe('cdp:chatgpt')
    expect(result.answerText).toBe('The best coffee in NYC is...')
    expect(result.citedDomains).toEqual(['example.com'])
    expect(result.groundingSources).toHaveLength(1)
    expect(result.searchQueries).toEqual(['best coffee NYC'])
  })

  it('handles missing answer text gracefully', () => {
    const raw: RawQueryResult = {
      provider: 'cdp:chatgpt',
      rawResponse: {},
      model: 'chatgpt-web',
      groundingSources: [],
      searchQueries: [],
    }
    const result = normalizeResult(raw)
    expect(result.answerText).toBe('')
    expect(result.citedDomains).toEqual([])
  })
})
