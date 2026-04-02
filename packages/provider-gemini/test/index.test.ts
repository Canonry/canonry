import { test, expect } from 'vitest'

import { validateConfig, normalizeResult } from '../src/index.js'
import type { GeminiRawResult } from '../src/index.js'

const validConfig = {
  apiKey: 'gemini-key',
  quotaPolicy: {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  },
}

test('validateConfig accepts a non-empty API key', () => {
  const result = validateConfig(validConfig)
  expect(result.ok).toBe(true)
  expect(result.provider).toBe('gemini')
  expect(result.message).toBe('config valid')
  expect(result.model).toBe('gemini-3-flash')
})

test('validateConfig rejects empty API key', () => {
  const result = validateConfig({ ...validConfig, apiKey: '' })
  expect(result.ok).toBe(false)
  expect(result.message).toBe('missing api key')
})

test('validateConfig uses custom model when specified', () => {
  const result = validateConfig({ ...validConfig, model: 'gemini-1.5-pro' })
  expect(result.model).toBe('gemini-1.5-pro')
})

test('validateConfig rejects Vertex AI config with empty project ID', () => {
  const result = validateConfig({
    apiKey: '',
    quotaPolicy: validConfig.quotaPolicy,
    vertexProject: '',
  })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/missing Vertex AI project ID/i)
})

test('validateConfig accepts Vertex AI config without API key', () => {
  const result = validateConfig({
    apiKey: '',
    quotaPolicy: validConfig.quotaPolicy,
    vertexProject: 'my-gcp-project',
    vertexRegion: 'us-central1',
  })
  expect(result.ok).toBe(true)
  expect(result.message).toBe('config valid (Vertex AI)')
  expect(result.model).toBe('gemini-3-flash')
})

test('validateConfig accepts Vertex AI config with custom model', () => {
  const result = validateConfig({
    apiKey: '',
    quotaPolicy: validConfig.quotaPolicy,
    vertexProject: 'my-gcp-project',
    model: 'gemini-2.5-flash',
  })
  expect(result.ok).toBe(true)
  expect(result.model).toBe('gemini-2.5-flash')
})

test('validateConfig falls back to default model for invalid model on Vertex AI', () => {
  const result = validateConfig({
    apiKey: '',
    quotaPolicy: validConfig.quotaPolicy,
    vertexProject: 'my-gcp-project',
    model: 'invalid-model',
  })
  expect(result.ok).toBe(true)
  expect(result.model).toBe('gemini-3-flash')
})

test('normalizeResult extracts answer text from candidates', () => {
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Answer engine optimization is ' },
              { text: 'the practice of optimizing for AI answers.' },
            ],
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

  expect(result.provider).toBe('gemini')
  expect(result.answerText).toBe(
    'Answer engine optimization is the practice of optimizing for AI answers.',
  )
  expect(result.citedDomains).toEqual(['example.com', 'blog.ainyc.ai'])
  expect(result.groundingSources.length).toBe(2)
  expect(result.searchQueries).toEqual(['answer engine optimization'])
})

test('normalizeResult strips www. from domains', () => {
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: { candidates: [] },
    groundingSources: [
      { uri: 'https://www.example.com/page', title: 'Example' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.citedDomains).toEqual(['example.com'])
})

test('normalizeResult deduplicates domains', () => {
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: { candidates: [] },
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
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
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
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: { candidates: [] },
    groundingSources: [
      { uri: 'not-a-url', title: 'Bad' },
      { uri: 'https://valid.com/page', title: 'Good' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  expect(result.citedDomains).toEqual(['valid.com'])
})
