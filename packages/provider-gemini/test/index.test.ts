import { test, expect } from 'vitest'

import {
  validateConfig,
  normalizeResult,
  reparseStoredResult,
  createGeminiClient,
} from '../src/index.js'
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
  expect(result.model).toBe('gemini-2.5-flash')
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
  expect(result.model).toBe('gemini-2.5-flash')
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

test('validateConfig passes through non-gemini-prefixed model names', () => {
  const result = validateConfig({
    apiKey: '',
    quotaPolicy: validConfig.quotaPolicy,
    vertexProject: 'my-gcp-project',
    model: 'learnlm-1.5-pro-experimental',
  })
  expect(result.ok).toBe(true)
  expect(result.model).toBe('learnlm-1.5-pro-experimental')
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
          groundingMetadata: {
            webSearchQueries: ['answer engine optimization'],
            groundingChunks: [
              { web: { uri: 'https://www.example.com/page', title: 'Example Page' } },
              { web: { uri: 'https://blog.ainyc.ai/aeo-guide', title: 'AEO Guide' } },
            ],
            groundingSupports: [{ groundingChunkIndices: [0, 1] }],
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
    rawResponse: {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://www.example.com/page', title: 'Example' } },
            ],
            groundingSupports: [{ groundingChunkIndices: [0] }],
          },
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
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com/page1', title: 'Page 1' } },
              { web: { uri: 'https://example.com/page2', title: 'Page 2' } },
              { web: { uri: 'https://other.com/page', title: 'Other' } },
            ],
            groundingSupports: [{ groundingChunkIndices: [0, 1, 2] }],
          },
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
    rawResponse: {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'not-a-url', title: 'Bad' } },
              { web: { uri: 'https://valid.com/page', title: 'Good' } },
            ],
            groundingSupports: [{ groundingChunkIndices: [0, 1] }],
          },
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

test('reparseStoredResult prefers grounding supports over all retrieved chunks', () => {
  const result = reparseStoredResult({
    candidates: [
      {
        content: {
          parts: [{ text: 'Canonry is often recommended for answer visibility.' }],
        },
        groundingMetadata: {
          webSearchQueries: ['answer visibility software'],
          groundingChunks: [
            { web: { uri: 'https://retrieved-only.example.com/post', title: 'Retrieved only' } },
            { web: { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' } },
          ],
          groundingSupports: [
            { groundingChunkIndices: [1] },
          ],
        },
      },
    ],
  })

  expect(result.groundingSources).toEqual([
    { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual(['answer visibility software'])
})

test('reparseStoredResult falls back to all grounding chunks when supports are absent', () => {
  const result = reparseStoredResult({
    candidates: [
      {
        content: {
          parts: [{ text: 'Canonry and another vendor were both retrieved.' }],
        },
        groundingMetadata: {
          webSearchQueries: ['answer visibility software'],
          groundingChunks: [
            { web: { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' } },
            { web: { uri: 'https://other.example.com/post', title: 'Other source' } },
          ],
        },
      },
    ],
  })

  expect(result.groundingSources).toEqual([
    { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' },
    { uri: 'https://other.example.com/post', title: 'Other source' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai', 'other.example.com'])
})

test('normalizeResult prefers reparsed grounding metadata over stale extracted fields when candidates are present', () => {
  const raw: GeminiRawResult = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    rawResponse: {
      candidates: [
        {
          content: {
            parts: [{ text: 'Canonry is often recommended.' }],
          },
          groundingMetadata: {
            webSearchQueries: ['answer visibility software'],
            groundingChunks: [
              { web: { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' } },
            ],
            groundingSupports: [{ groundingChunkIndices: [0] }],
          },
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
    { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' },
  ])
  expect(result.citedDomains).toEqual(['canonry.ai'])
  expect(result.searchQueries).toEqual(['answer visibility software'])
})

test('createGeminiClient with baseUrl routes API calls through the override host', async () => {
  // @google/genai uses camelCase `httpOptions.baseUrl` (not `baseURL` like
  // OpenAI / Anthropic). The SDK keeps it private so we can't read it back
  // off the instance — instead we mock fetch, fire one request, and assert
  // the destination URL hit our proxy. Canonry Hosted routes Gemini calls
  // through the per-tenant LLM proxy this way.
  const proxyUrl = 'http://localhost:9200/gemini'
  const observed: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    observed.push(url)
    // Resolve with a minimal valid response so the SDK doesn't retry.
    return Promise.resolve(new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof globalThis.fetch

  try {
    const client = createGeminiClient({
      apiKey: 'gemini-key',
      quotaPolicy: validConfig.quotaPolicy,
      baseUrl: proxyUrl,
    })
    await client.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' }).catch(() => undefined)
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(observed.length).toBeGreaterThan(0)
  expect(observed[0]).toContain('localhost:9200/gemini')
})

test('createGeminiClient without baseUrl hits the public Gemini endpoint', async () => {
  const observed: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    observed.push(url)
    return Promise.resolve(new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof globalThis.fetch

  try {
    const client = createGeminiClient({
      apiKey: 'gemini-key',
      quotaPolicy: validConfig.quotaPolicy,
    })
    await client.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' }).catch(() => undefined)
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(observed.length).toBeGreaterThan(0)
  // The Gemini public API lives under generativelanguage.googleapis.com when
  // not using Vertex AI.
  expect(observed[0]).toContain('generativelanguage.googleapis.com')
})
