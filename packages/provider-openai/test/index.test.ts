import { test, expect } from 'vitest'

import { validateConfig, normalizeResult, buildPrompt, reparseStoredResult } from '../src/index.js'
import type { OpenAIRawResult } from '../src/index.js'

const validConfig = {
  apiKey: 'openai-key',
  quotaPolicy: {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  },
}

test('validateConfig accepts a non-empty API key', () => {
  const result = validateConfig(validConfig)
  expect(result.ok).toBe(true)
  expect(result.provider).toBe('openai')
  expect(result.message).toBe('config valid')
  expect(result.model).toBe('gpt-5.4')
})

test('validateConfig rejects empty API key', () => {
  const result = validateConfig({ ...validConfig, apiKey: '' })
  expect(result.ok).toBe(false)
  expect(result.message).toBe('missing api key')
})

test('validateConfig uses custom model when specified', () => {
  const result = validateConfig({ ...validConfig, model: 'gpt-4o-mini' })
  expect(result.model).toBe('gpt-4o-mini')
})

test('normalizeResult extracts answer text from output', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Answer engine optimization is ',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://www.example.com/page',
                  title: 'Example Page',
                },
              ],
            },
            {
              type: 'output_text',
              text: 'the practice of optimizing for AI answers.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://blog.ainyc.ai/aeo-guide',
                  title: 'AEO Guide',
                },
              ],
            },
          ],
        },
        {
          type: 'web_search_call',
          action: {
            type: 'search',
            query: 'answer engine optimization',
          },
        },
      ],
    },
    groundingSources: [
      { uri: 'https://www.example.com/page', title: 'Example Page' },
      { uri: 'https://blog.ainyc.ai/aeo-guide', title: 'AEO Guide' },
    ],
    searchQueries: ['answer engine optimization'],
  }

  const result = normalizeResult(raw)

  expect(result.provider).toBe('openai')
  expect(result.answerText).toBe(
    'Answer engine optimization is the practice of optimizing for AI answers.',
  )
  expect(result.citedDomains).toEqual(['example.com', 'blog.ainyc.ai'])
  expect(result.groundingSources.length).toBe(2)
  expect(result.searchQueries).toEqual(['answer engine optimization'])
})

test('normalizeResult strips www. from domains', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Example',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://www.example.com/page',
                  title: 'Example',
                },
              ],
            },
          ],
        },
      ],
    },
    groundingSources: [
      { uri: 'https://www.example.com/page', title: 'Example' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.citedDomains).toEqual(['example.com'])
})

test('normalizeResult deduplicates domains', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Pages',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com/page1',
                  title: 'Page 1',
                },
                {
                  type: 'url_citation',
                  url: 'https://example.com/page2',
                  title: 'Page 2',
                },
                {
                  type: 'url_citation',
                  url: 'https://other.com/page',
                  title: 'Other',
                },
              ],
            },
          ],
        },
      ],
    },
    groundingSources: [
      { uri: 'https://example.com/page1', title: 'Page 1' },
      { uri: 'https://example.com/page2', title: 'Page 2' },
      { uri: 'https://other.com/page', title: 'Other' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.citedDomains).toEqual(['example.com', 'other.com'])
})

test('normalizeResult handles empty response gracefully', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: {},
    groundingSources: [],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.answerText).toBe('')
  expect(result.citedDomains).toEqual([])
  expect(result.groundingSources).toEqual([])
})

test('normalizeResult handles invalid grounding URIs', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Links',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'not-a-url',
                  title: 'Bad',
                },
                {
                  type: 'url_citation',
                  url: 'https://valid.com/page',
                  title: 'Good',
                },
              ],
            },
          ],
        },
      ],
    },
    groundingSources: [
      { uri: 'not-a-url', title: 'Bad' },
      { uri: 'https://valid.com/page', title: 'Good' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.citedDomains).toEqual(['valid.com'])
})

test('buildPrompt returns the keyword verbatim', () => {
  expect(buildPrompt('best crm software')).toBe('best crm software')
  expect(buildPrompt('')).toBe('')
})

test('reparseStoredResult extracts search queries from web_search_call actions', () => {
  const result = reparseStoredResult({
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          query: 'best crm software',
          queries: ['best crm software', 'crm comparison'],
        },
      },
    ],
  })

  expect(result.searchQueries).toEqual(['best crm software', 'crm comparison'])
})

test('reparseStoredResult uses final url citations instead of web_search_call sources', () => {
  const result = reparseStoredResult({
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          queries: ['canonry pricing'],
          sources: [
            { type: 'url', url: 'https://retrieved-only.example.com/post' },
            { type: 'url', url: 'https://canonry.ai/pricing' },
          ],
        },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Canonry publishes pricing guidance.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://canonry.ai/pricing',
                title: 'Canonry pricing',
              },
            ],
          },
        ],
      },
    ],
  })

  expect(result.groundingSources).toEqual([
    { uri: 'https://canonry.ai/pricing', title: 'Canonry pricing' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual(['canonry pricing'])
})

test('normalizeResult prefers reparsed citations over stale extracted fields when response content is present', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-5.4',
    rawResponse: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Canonry publishes pricing guidance.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://canonry.ai/pricing',
                  title: 'Canonry pricing',
                },
              ],
            },
          ],
        },
      ],
    },
    groundingSources: [
      { uri: 'https://retrieved-only.example.com/post', title: 'Retrieved only' },
    ],
    searchQueries: ['stale query'],
  }

  const result = normalizeResult(raw)
  expect(result.groundingSources).toEqual([
    { uri: 'https://canonry.ai/pricing', title: 'Canonry pricing' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual([])
})
