import { describe, it, expect } from 'vitest'
import { validateConfig, normalizeResult, reparseStoredResult } from '../src/normalize.js'
import type { PerplexityRawResult } from '../src/types.js'

describe('validateConfig', () => {
  it('returns ok for valid config', () => {
    const result = validateConfig({
      apiKey: 'pplx-test-key',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('perplexity')
    expect(result.model).toBe('fast')
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
      model: 'perplexity/sonar',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.model).toBe('perplexity/sonar')
  })

  it('reports the preset a retired Sonar model now runs as', () => {
    const result = validateConfig({
      apiKey: 'pplx-test-key',
      model: 'sonar-pro',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.model).toBe('low')
  })

  it('falls back to the default for a blank model', () => {
    const result = validateConfig({
      apiKey: 'pplx-test-key',
      model: '  ',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.model).toBe('fast')
  })
})

describe('normalizeResult (Sonar history)', () => {
  it("extracts answer text and cited domains from raw result", () => {
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

    const empty = { provider: 'perplexity', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown' } satisfies import('../src/types.js').PerplexityNormalizedResult
    const base: PerplexityRawResult = { provider: 'perplexity', model: 'sonar', rawResponse: {}, groundingSources: [], searchQueries: [] }
    const rows: Array<{ name: string; raw: PerplexityRawResult; expected: import('../src/types.js').PerplexityNormalizedResult }> = [
      { name: 'original complete Sonar normalization', raw, expected: { provider: 'perplexity', answerText: 'Perplexity is an AI search engine.', citedDomains: ['perplexity.ai', 'example.com'], groundingSources: [{ uri: 'https://perplexity.ai', title: '' }, { uri: 'https://www.example.com/article', title: '' }], searchQueries: [], retrievalStatus: 'unknown' } },
      { name: 'original direct string citations', raw: { ...base, rawResponse: { citations: ['https://example.com/page1', 'https://foo.bar.com/article', 'https://www.test.org'] } }, expected: { ...empty, groundingSources: [{ uri: 'https://example.com/page1', title: '' }, { uri: 'https://foo.bar.com/article', title: '' }, { uri: 'https://www.test.org', title: '' }], citedDomains: ['example.com', 'foo.bar.com', 'test.org'] } },
      { name: 'original absent citations', raw: base, expected: empty },
      { name: 'original null citations', raw: { ...base, rawResponse: { citations: null } }, expected: empty },
      { name: 'original mixed non-string citations', raw: { ...base, rawResponse: { citations: ['https://example.com', 123, null, 'https://other.com'] } }, expected: { ...empty, groundingSources: [{ uri: 'https://example.com', title: '' }, { uri: 'https://other.com', title: '' }], citedDomains: ['example.com', 'other.com'] } },
      { name: 'original nested stored Sonar citations', raw: { ...base, rawResponse: { model: 'sonar', groundingSources: [{ uri: 'https://example.com', title: '' }], searchQueries: ['AEO agency NYC'], apiResponse: { id: 'abc123', model: 'sonar', choices: [{ message: { content: 'answer text' } }], citations: ['https://example.com/page1', 'https://ainyc.ai/services'] } } }, expected: { ...empty, answerText: 'answer text', groundingSources: [{ uri: 'https://example.com/page1', title: '' }, { uri: 'https://ainyc.ai/services', title: '' }], citedDomains: ['example.com', 'ainyc.ai'] } },
      { name: 'original direct citations take precedence', raw: { ...base, rawResponse: { citations: ['https://direct.com'], apiResponse: { citations: ['https://nested.com'] } } }, expected: { ...empty, groundingSources: [{ uri: 'https://direct.com', title: '' }], citedDomains: ['direct.com'] } },
      { name: 'original nested response without citations', raw: { ...base, rawResponse: { model: 'sonar', groundingSources: [], apiResponse: { id: 'abc', choices: [] } } }, expected: empty },
      { name: 'original fallback duplicate source hosts', raw: { ...base, groundingSources: [{ uri: 'https://example.com/page1', title: '' }, { uri: 'https://www.example.com/page2', title: '' }, { uri: 'https://other.com/path', title: '' }] }, expected: { ...empty, groundingSources: [{ uri: 'https://example.com/page1', title: '' }, { uri: 'https://www.example.com/page2', title: '' }, { uri: 'https://other.com/path', title: '' }], citedDomains: ['example.com', 'other.com'] } },
      { name: 'original fallback www host', raw: { ...base, groundingSources: [{ uri: 'https://www.mysite.com', title: '' }] }, expected: { ...empty, groundingSources: [{ uri: 'https://www.mysite.com', title: '' }], citedDomains: ['mysite.com'] } },
      { name: 'original fallback invalid URI', raw: { ...base, groundingSources: [{ uri: 'not-a-url', title: '' }, { uri: 'https://valid.com', title: '' }] }, expected: { ...empty, groundingSources: [{ uri: 'not-a-url', title: '' }, { uri: 'https://valid.com', title: '' }], citedDomains: ['valid.com'] } },
      { name: 'original empty sources', raw: { ...base, groundingSources: [] }, expected: empty },
    ]
    for (const row of rows) expect(normalizeResult(row.raw), row.name).toEqual(row.expected)
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

  it('prefers reparsed provider fields over stale extracted fields when response content is present', () => {
    const raw: PerplexityRawResult = {
      provider: 'perplexity',
      rawResponse: {
        choices: [{
          message: { content: 'Perplexity can return web-grounded answers.' },
        }],
        search_results: [
          { url: 'https://www.perplexity.ai/docs', title: 'Perplexity Docs' },
        ],
        citations: ['https://www.perplexity.ai/docs'],
      },
      model: 'sonar',
      groundingSources: [
        { uri: 'https://retrieved-only.example.com/post', title: 'Retrieved only' },
      ],
      searchQueries: ['fabricated query'],
    }

    const result = normalizeResult(raw)
    expect(result.groundingSources).toEqual([
      { uri: 'https://www.perplexity.ai/docs', title: 'Perplexity Docs' },
    ])
    expect(result.citedDomains).toEqual(['perplexity.ai'])
    expect(result.searchQueries).toEqual([])
  })
})

describe('reparseStoredResult (Sonar history)', () => {
  it('reparseStoredResult does not invent search queries and prefers search result titles', () => {
    const result = reparseStoredResult({
      choices: [{
        message: { content: 'Perplexity can return web-grounded answers.' },
      }],
      search_results: [
        { url: 'https://www.perplexity.ai/docs', title: 'Perplexity Docs' },
      ],
      citations: ['https://www.perplexity.ai/docs'],
    })

    expect(result.searchQueries).toEqual([])
    expect(result.groundingSources).toEqual([
      { uri: 'https://www.perplexity.ai/docs', title: 'Perplexity Docs' },
    ])
    // Sonar's retrieval marker never discriminated, so stored rows stay unknown.
    expect(result.retrievalStatus).toBe('unknown')
  })

  it('reparseStoredResult falls back to citations when search_results are absent', () => {
    const result = reparseStoredResult({
      choices: [{
        message: { content: 'Perplexity can still return citation URLs.' },
      }],
      citations: ['https://www.perplexity.ai/docs'],
    })

    expect(result.searchQueries).toEqual([])
    expect(result.groundingSources).toEqual([
      { uri: 'https://www.perplexity.ai/docs', title: '' },
    ])
    expect(result.citedDomains).toEqual(['perplexity.ai'])
  })

  it('reparseStoredResult reads nested apiResponse.search_results from stored snapshot envelopes', () => {
    const result = reparseStoredResult({
      model: 'sonar',
      groundingSources: [],
      searchQueries: [],
      apiResponse: {
        choices: [{
          message: { content: 'Stored snapshot response.' },
        }],
        search_results: [
          { url: 'https://docs.perplexity.ai/guides', title: 'Perplexity Guides' },
        ],
      },
    })

    expect(result.answerText).toBe('Stored snapshot response.')
    expect(result.groundingSources).toEqual([
      { uri: 'https://docs.perplexity.ai/guides', title: 'Perplexity Guides' },
    ])
  })
})
