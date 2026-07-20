import { test, expect } from 'vitest'

import { validateConfig, normalizeResult, reparseStoredResult, extractServedModel } from '../src/index.js'
import type { ClaudeRawResult } from '../src/index.js'

const validConfig = {
  apiKey: 'claude-key',
  quotaPolicy: {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  },
}

test('validateConfig accepts a non-empty API key', () => {
  const result = validateConfig(validConfig)
  expect(result.ok).toBe(true)
  expect(result.provider).toBe('claude')
  expect(result.message).toBe('config valid')
  expect(result.model).toBe('claude-sonnet-4-6')
})

test('validateConfig rejects empty API key', () => {
  const result = validateConfig({ ...validConfig, apiKey: '' })
  expect(result.ok).toBe(false)
  expect(result.message).toBe('missing api key')
})

test('validateConfig uses custom model when specified', () => {
  const result = validateConfig({ ...validConfig, model: 'claude-haiku-4-5-20251001' })
  expect(result.model).toBe('claude-haiku-4-5-20251001')
})

test('validateConfig falls back to default model for non-claude model name', () => {
  const result = validateConfig({ ...validConfig, model: 'gpt-5.4' })
  expect(result.ok).toBe(true)
  expect(result.model).toBe('claude-sonnet-4-6')
  expect(result.message).toMatch(/invalid model/)
})

test('normalizeResult extracts answer text from content blocks', () => {
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    rawResponse: {
      content: [
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'answer engine optimization' },
        },
        {
          type: 'text',
          text: 'Answer engine optimization is ',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://www.example.com/page',
              title: 'Example Page',
            },
          ],
        },
        {
          type: 'text',
          text: 'the practice of optimizing for AI answers.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://blog.ainyc.ai/aeo-guide',
              title: 'AEO Guide',
            },
          ],
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

  expect(result.provider).toBe('claude')
  expect(result.answerText).toBe(
    'Answer engine optimization is the practice of optimizing for AI answers.',
  )
  expect(result.citedDomains).toEqual(['example.com', 'blog.ainyc.ai'])
  expect(result.groundingSources.length).toBe(2)
  expect(result.searchQueries).toEqual(['answer engine optimization'])
})

test('normalizeResult strips www. from domains', () => {
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    rawResponse: {
      content: [
        {
          type: 'text',
          text: 'Example',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://www.example.com/page',
              title: 'Example',
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
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    rawResponse: {
      content: [
        {
          type: 'text',
          text: 'Pages',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/page1',
              title: 'Page 1',
            },
            {
              type: 'web_search_result_location',
              url: 'https://example.com/page2',
              title: 'Page 2',
            },
            {
              type: 'web_search_result_location',
              url: 'https://other.com/page',
              title: 'Other',
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
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
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
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    rawResponse: {
      content: [
        {
          type: 'text',
          text: 'Links',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'not-a-url',
              title: 'Bad',
            },
            {
              type: 'web_search_result_location',
              url: 'https://valid.com/page',
              title: 'Good',
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

test('reparseStoredResult uses final text citations instead of raw search results', () => {
  const result = reparseStoredResult({
    content: [
      {
        type: 'server_tool_use',
        name: 'web_search',
        input: { query: 'canonry reviews' },
      },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://competitor.com/review', title: 'Competitor review' },
        ],
      },
      {
        type: 'text',
        text: 'Canonry recommends using its own audit workflow.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://canonry.ai/blog/audit',
            title: 'Canonry audit guide',
          },
        ],
      },
    ],
  })

  expect(result.groundingSources).toEqual([
    { uri: 'https://canonry.ai/blog/audit', title: 'Canonry audit guide' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual(['canonry reviews'])
})

test('reparseStoredResult surfaces Claude web search tool errors', () => {
  const result = reparseStoredResult({
    content: [
      {
        type: 'web_search_tool_result',
        content: {
          type: 'web_search_tool_result_error',
          error_code: 'too_many_requests',
        },
      },
      {
        type: 'text',
        text: '',
        citations: null,
      },
    ],
  })

  expect(result.providerError).toContain('too_many_requests')
})

test('reparseStoredResult ignores raw search results when final text has no citations', () => {
  const result = reparseStoredResult({
    content: [
      {
        type: 'server_tool_use',
        name: 'web_search',
        input: { query: 'canonry reviews' },
      },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://competitor.com/review', title: 'Competitor review' },
        ],
      },
      {
        type: 'text',
        text: 'I found reviews but no cited source in the final answer.',
        citations: [],
      },
    ],
  })

  expect(result.groundingSources).toEqual([])
  expect(result.citedDomains).toEqual([])
  expect(result.searchQueries).toEqual(['canonry reviews'])
})

test('normalizeResult prefers reparsed citations over stale extracted fields when content is present', () => {
  const raw: ClaudeRawResult = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    rawResponse: {
      content: [
        {
          type: 'server_tool_use',
          name: 'web_search',
          input: { query: 'canonry reviews' },
        },
        {
          type: 'text',
          text: 'Canonry publishes audit workflows.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://canonry.ai/blog/audit',
              title: 'Canonry audit guide',
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
    { uri: 'https://canonry.ai/blog/audit', title: 'Canonry audit guide' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual(['canonry reviews'])
})

// --- servedModel capture ---
//
// Trimmed from a real Anthropic Messages API capture taken 2026-07-20
// (scratchpad claude-raw-claude-sonnet-5.json).
const claudeSonnet5Response: Record<string, unknown> = {
  model: 'claude-sonnet-5',
  id: 'msg_011CdCTuzJohRLz3CQVgc6BY',
  type: 'message',
  role: 'assistant',
  stop_reason: 'end_turn',
  content: [
    {
      type: 'server_tool_use',
      id: 'srvtoolu_011USZRBBfog9hQyQC8iDSrY',
      name: 'web_search',
      input: { query: 'best boutique hotels in Venice Beach Los Angeles' },
    },
  ],
}

test('extractServedModel captures the model Claude reported serving', () => {
  expect(extractServedModel(claudeSonnet5Response)).toBe('claude-sonnet-5')
})

// Synthetic model string on the captured envelope: the capture itself showed no
// divergence, so this pins extraction behaviour rather than claiming an observed case.
test('extractServedModel keeps a dated snapshot verbatim', () => {
  const configuredModel = 'claude-sonnet-4-6'
  const servedModel = extractServedModel({
    ...claudeSonnet5Response,
    model: 'claude-sonnet-4-6-20260214',
  })
  expect(servedModel).toBe('claude-sonnet-4-6-20260214')
  expect(servedModel).not.toBe(configuredModel)
})

test('extractServedModel returns undefined when the response carries no model field', () => {
  const { model: _model, ...withoutModel } = claudeSonnet5Response
  const servedModel = extractServedModel(withoutModel)
  expect(servedModel).toBeUndefined()
  expect(servedModel).not.toBe('')
  expect(servedModel).not.toBe('claude-sonnet-4-6')
})

test('extractServedModel returns undefined for a whitespace-only model field', () => {
  expect(extractServedModel({ ...claudeSonnet5Response, model: '  ' })).toBeUndefined()
})
