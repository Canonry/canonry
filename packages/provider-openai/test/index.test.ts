import assert from 'node:assert/strict'
import test from 'node:test'

import { validateConfig, normalizeResult, buildPrompt } from '../src/index.js'
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
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'openai')
  assert.equal(result.message, 'config valid')
  assert.equal(result.model, 'gpt-4o')
})

test('validateConfig rejects empty API key', () => {
  const result = validateConfig({ ...validConfig, apiKey: '' })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'missing api key')
})

test('validateConfig uses custom model when specified', () => {
  const result = validateConfig({ ...validConfig, model: 'gpt-4o-mini' })
  assert.equal(result.model, 'gpt-4o-mini')
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
            { type: 'output_text', text: 'Answer engine optimization is ' },
            { type: 'output_text', text: 'the practice of optimizing for AI answers.' },
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

  assert.equal(result.provider, 'openai')
  assert.equal(
    result.answerText,
    'Answer engine optimization is the practice of optimizing for AI answers.',
  )
  assert.deepEqual(result.citedDomains, ['example.com', 'blog.ainyc.ai'])
  assert.equal(result.groundingSources.length, 2)
  assert.deepEqual(result.searchQueries, ['answer engine optimization'])
})

test('normalizeResult strips www. from domains', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: { output: [] },
    groundingSources: [
      { uri: 'https://www.example.com/page', title: 'Example' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  assert.deepEqual(result.citedDomains, ['example.com'])
})

test('normalizeResult deduplicates domains', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: { output: [] },
    groundingSources: [
      { uri: 'https://example.com/page1', title: 'Page 1' },
      { uri: 'https://example.com/page2', title: 'Page 2' },
      { uri: 'https://other.com/page', title: 'Other' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  assert.deepEqual(result.citedDomains, ['example.com', 'other.com'])
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
  assert.equal(result.answerText, '')
  assert.deepEqual(result.citedDomains, [])
  assert.deepEqual(result.groundingSources, [])
})

test('normalizeResult handles invalid grounding URIs', () => {
  const raw: OpenAIRawResult = {
    provider: 'openai',
    model: 'gpt-4o',
    rawResponse: { output: [] },
    groundingSources: [
      { uri: 'not-a-url', title: 'Bad' },
      { uri: 'https://valid.com/page', title: 'Good' },
    ],
    searchQueries: [],
  }

  const result = normalizeResult(raw)
  assert.deepEqual(result.citedDomains, ['valid.com'])
})

test('buildPrompt returns the keyword verbatim', () => {
  assert.equal(buildPrompt('best crm software'), 'best crm software')
  assert.equal(buildPrompt(''), '')
})
