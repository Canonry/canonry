import { describe, it, expect } from 'vitest'
import { extractCitations, extractCitedDomains, validateConfig, normalizeResult } from '../src/normalize.js'
import type { PerplexityRawResult, GroundingSource } from '../src/types.js'

describe('extractCitations', () => {
  it('extracts string citations from response', () => {
    const raw = {
      citations: [
        'https://example.com/page1',
        'https://foo.bar.com/article',
        'https://www.test.org',
      ],
    }
    expect(extractCitations(raw)).toEqual([
      'https://example.com/page1',
      'https://foo.bar.com/article',
      'https://www.test.org',
    ])
  })

  it('returns empty array when no citations', () => {
    expect(extractCitations({})).toEqual([])
    expect(extractCitations({ citations: null })).toEqual([])
  })

  it('filters out non-string values', () => {
    const raw = {
      citations: ['https://example.com', 123, null, 'https://other.com'],
    }
    expect(extractCitations(raw)).toEqual(['https://example.com', 'https://other.com'])
  })
})

describe('extractCitedDomains', () => {
  it('extracts unique domains from grounding sources', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://example.com/page1', title: '' },
      { uri: 'https://www.example.com/page2', title: '' },
      { uri: 'https://other.com/path', title: '' },
    ]
    const domains = extractCitedDomains(sources)
    expect(domains).toContain('example.com')
    expect(domains).toContain('other.com')
    expect(domains).toHaveLength(2) // deduped
  })

  it('strips www prefix', () => {
    const sources: GroundingSource[] = [
      { uri: 'https://www.mysite.com', title: '' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['mysite.com'])
  })

  it('handles invalid URIs gracefully', () => {
    const sources: GroundingSource[] = [
      { uri: 'not-a-url', title: '' },
      { uri: 'https://valid.com', title: '' },
    ]
    expect(extractCitedDomains(sources)).toEqual(['valid.com'])
  })

  it('returns empty array for empty sources', () => {
    expect(extractCitedDomains([])).toEqual([])
  })
})

describe('validateConfig', () => {
  it('returns ok for valid config', () => {
    const result = validateConfig({
      apiKey: 'pplx-test-key',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('perplexity')
    expect(result.model).toBe('sonar')
  })

  it('returns not ok for missing api key', () => {
    const result = validateConfig({
      apiKey: '',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('missing api key')
  })

  it('uses custom model when provided', () => {
    const result = validateConfig({
      apiKey: 'pplx-test-key',
      model: 'sonar-pro',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.model).toBe('sonar-pro')
  })
})

describe('normalizeResult', () => {
  it('extracts answer text and cited domains from raw result', () => {
    const raw: PerplexityRawResult = {
      provider: 'perplexity',
      rawResponse: {
        choices: [{
          message: { content: 'Perplexity is an AI search engine.' },
        }],
        citations: [
          'https://perplexity.ai',
          'https://www.example.com/article',
        ],
      },
      model: 'sonar',
      groundingSources: [
        { uri: 'https://perplexity.ai', title: '' },
        { uri: 'https://www.example.com/article', title: '' },
      ],
      searchQueries: ['what is perplexity'],
    }

    const result = normalizeResult(raw)
    expect(result.provider).toBe('perplexity')
    expect(result.answerText).toBe('Perplexity is an AI search engine.')
    expect(result.citedDomains).toContain('perplexity.ai')
    expect(result.citedDomains).toContain('example.com')
    expect(result.searchQueries).toEqual(['what is perplexity'])
  })

  it('handles empty response', () => {
    const raw: PerplexityRawResult = {
      provider: 'perplexity',
      rawResponse: { choices: [] },
      model: 'sonar',
      groundingSources: [],
      searchQueries: [],
    }

    const result = normalizeResult(raw)
    expect(result.answerText).toBe('')
    expect(result.citedDomains).toEqual([])
  })
})
