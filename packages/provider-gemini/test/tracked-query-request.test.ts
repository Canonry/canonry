import { test, expect, vi, afterEach } from 'vitest'

import { geminiAdapter } from '../src/adapter.js'
import { createClient } from '../src/normalize.js'

// Pins the build/parse split of the sync path. The SDK does not send what it is
// given: it wraps a `contents` string into a user turn and moves `config.tools`
// to the top level beside a `generationConfig` object. The built body is that
// normalized wire JSON, so these tests compare against what reached `fetch`.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash', quotaPolicy }
const QUERY = { query: 'best crm for agencies', canonicalDomains: ['example.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US' }

/** A generateContent payload shaped like a real grounded answer: two searches, one supported chunk. */
const RESPONSE = {
  candidates: [{
    content: { parts: [{ text: 'Example CRM is popular with agencies.' }], role: 'model' },
    finishReason: 'STOP',
    index: 0,
    groundingMetadata: {
      webSearchQueries: ['best crm for agencies 2026', 'agency crm comparison'],
      searchEntryPoint: { renderedContent: '<div></div>' },
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123', title: 'example.com' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/XyZ789', title: 'other.example' } },
      ],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 11, text: 'Example CRM' }, groundingChunkIndices: [0], confidenceScores: [0.92] }],
    },
  }],
  usageMetadata: {
    promptTokenCount: 812,
    cachedContentTokenCount: 256,
    candidatesTokenCount: 402,
    thoughtsTokenCount: 128,
    toolUsePromptTokenCount: 95,
    totalTokenCount: 1437,
  },
  modelVersion: 'gemini-2.5-flash-preview-09-2025',
  responseId: 'mH7TaK2fOoyz1dkP',
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubGenerateContent(response: Record<string, unknown>): CapturedRequest[] {
  const sent: CapturedRequest[] = []
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('buildTrackedQueryRequest returns the exact body the sync path sends', async () => {
  const sent = stubGenerateContent(RESPONSE)
  await geminiAdapter.executeTrackedQuery(QUERY, CONFIG)

  const built = geminiAdapter.buildTrackedQueryRequest!(QUERY, CONFIG)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(new URL(sent[0]!.url).pathname).toBe(built.endpoint)
  expect(built).toEqual({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{ parts: [{ text: 'best crm for agencies' }], role: 'user' }],
      tools: [{ googleSearch: {} }],
      generationConfig: {},
    },
  })
})

test('the built body is what the pre-split call (a `contents` string) put on the wire', async () => {
  const sent = stubGenerateContent(RESPONSE)
  const input = { ...QUERY, location: LOCATION }
  await createClient({ apiKey: 'k', quotaPolicy }).models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'best crm for agencies (searching from San Francisco, CA, US)',
    config: { tools: [{ googleSearch: {} }] },
  })

  expect(sent[0]!.body).toEqual(geminiAdapter.buildTrackedQueryRequest!(input, CONFIG).body)
})

test('a location reaches the wire through the built body', async () => {
  const sent = stubGenerateContent(RESPONSE)
  const input = { ...QUERY, location: LOCATION }
  await geminiAdapter.executeTrackedQuery(input, CONFIG)

  const built = geminiAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.contents).toEqual([
    { parts: [{ text: 'best crm for agencies (searching from San Francisco, CA, US)' }], role: 'user' },
  ])
})

test('the endpoint names the Vertex AI resource path for a Vertex config', () => {
  const built = geminiAdapter.buildTrackedQueryRequest!(QUERY, { ...CONFIG, apiKey: '', vertexProject: 'proj-1', vertexRegion: 'europe-west4' })
  expect(built.endpoint).toBe('/v1beta1/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent')
  const defaultRegion = geminiAdapter.buildTrackedQueryRequest!(QUERY, { ...CONFIG, apiKey: '', vertexProject: 'proj-1' })
  expect(defaultRegion.endpoint).toBe('/v1beta1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent')
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  stubGenerateContent(RESPONSE)
  const viaSync = await geminiAdapter.executeTrackedQuery(QUERY, CONFIG)
  const viaParse = geminiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gemini-2.5-flash')

  expect(viaSync).toEqual(viaParse)
  expect(viaParse.servedModel).toBe('gemini-2.5-flash-preview-09-2025')
  expect(viaParse.searchQueries).toEqual(['best crm for agencies 2026', 'agency crm comparison'])
  expect(viaParse.retrievalStatus).toBe('unknown')
  expect(viaParse.retrievalContract).toBe('native-auto-v1')
})

test('parse stores the same trimmed record the sync path stores', () => {
  const stored = geminiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gemini-2.5-flash').rawResponse
  // Re-reading a stored record yields it unchanged.
  expect(geminiAdapter.parseTrackedQueryResponse!(structuredClone(stored), 'gemini-2.5-flash').rawResponse).toEqual(stored)
  expect(stored).not.toHaveProperty('candidates.0.groundingMetadata.searchEntryPoint')
})

test('parse extracts usage and stop reason exactly', () => {
  const raw = geminiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gemini-2.5-flash')
  expect(raw.usage).toEqual({
    inputTokens: 812 - 256,
    cachedInputTokens: 256,
    cacheWriteTokens: 0,
    outputTokens: 402 + 128,
    searchCount: 2,
  })
  expect(raw.stopReason).toBe('STOP')
})

test('an ungrounded answer without thoughts or a cache counts 0 of each', () => {
  const plain = {
    ...structuredClone(RESPONSE),
    candidates: [{ content: RESPONSE.candidates[0]!.content, finishReason: 'MAX_TOKENS', index: 0 }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 30, totalTokenCount: 39 },
  }
  const raw = geminiAdapter.parseTrackedQueryResponse!(plain, 'gemini-2.5-flash')
  expect(raw.usage).toEqual({ inputTokens: 9, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 30, searchCount: 0 })
  expect(raw.stopReason).toBe('MAX_TOKENS')
})

test('a response with no usage metadata has undefined usage', () => {
  const { usageMetadata: _usage, ...bare } = structuredClone(RESPONSE)
  expect(geminiAdapter.parseTrackedQueryResponse!(bare, 'gemini-2.5-flash').usage).toBeUndefined()
  expect(geminiAdapter.parseTrackedQueryResponse!({ candidates: [] }, 'gemini-2.5-flash').stopReason).toBeUndefined()
})
