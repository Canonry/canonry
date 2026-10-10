import { test, expect, vi, afterEach } from 'vitest'

import type { RawQueryResult } from '@ainyc/canonry-contracts'
import { geminiAdapter } from '../src/adapter.js'

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

const EXPECTED_STORED_RESPONSE = {
  candidates: [{
    content: { parts: [{ text: 'Example CRM is popular with agencies.' }], role: 'model' }, finishReason: 'STOP',
    groundingMetadata: {
      webSearchQueries: ['best crm for agencies 2026', 'agency crm comparison'],
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123', title: 'example.com' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/XyZ789', title: 'other.example' } },
      ],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 11, text: 'Example CRM' }, groundingChunkIndices: [0], confidenceScores: [0.92] }],
    },
  }],
  usageMetadata: { promptTokenCount: 812, cachedContentTokenCount: 256, candidatesTokenCount: 402, thoughtsTokenCount: 128, toolUsePromptTokenCount: 95, totalTokenCount: 1437 },
  modelVersion: 'gemini-2.5-flash-preview-09-2025', responseId: 'mH7TaK2fOoyz1dkP',
}
const EXPECTED_TRACKED_RESULT = {
  provider: 'gemini', rawResponse: EXPECTED_STORED_RESPONSE, model: 'gemini-2.5-flash', servedModel: 'gemini-2.5-flash-preview-09-2025',
  groundingSources: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123', title: 'example.com' }],
  searchQueries: ['best crm for agencies 2026', 'agency crm comparison'], retrievalStatus: 'used', retrievalContract: 'native-auto-v1',
  usage: { inputTokens: 556, cachedInputTokens: 256, cacheWriteTokens: 0, outputTokens: 530, searchCount: 2 }, stopReason: 'STOP',
} satisfies RawQueryResult

// Captured 2026-07-20: only modelVersion/responseId. All answer, grounding and
// usage fields below are constructed; they are not evidence of a live answer.
const CAPTURED_ID_RESPONSE = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Harborline Hotel is a harbor-side boutique inn.' }] }, finishReason: 'STOP',
    groundingMetadata: { webSearchQueries: ['"Harborline Hotel" harbor-side'], groundingChunks: [{ web: { uri: 'https://harborline.example.com/', title: 'harborline.example.com' } }],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 46 }, groundingChunkIndices: [0] }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 }, modelVersion: 'gemini-3.5-flash', responseId: 'hY1dasuhNuSf-8YP0Jfm8QM',
}
const EXPECTED_CAPTURED_ID_RESULT = {
  provider: 'gemini', model: 'gemini-3.5-flash', servedModel: 'gemini-3.5-flash',
  rawResponse: { candidates: [{ content: { role: 'model', parts: [{ text: 'Harborline Hotel is a harbor-side boutique inn.' }] }, finishReason: 'STOP',
    groundingMetadata: { webSearchQueries: ['"Harborline Hotel" harbor-side'], groundingChunks: [{ web: { uri: 'https://harborline.example.com/', title: 'harborline.example.com' } }],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 46 }, groundingChunkIndices: [0] }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 }, modelVersion: 'gemini-3.5-flash', responseId: 'hY1dasuhNuSf-8YP0Jfm8QM' },
  groundingSources: [{ uri: 'https://harborline.example.com/', title: 'harborline.example.com' }], searchQueries: ['"Harborline Hotel" harbor-side'],
  retrievalStatus: 'used', retrievalContract: 'native-auto-v1', usage: { inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 34, searchCount: 1 }, stopReason: 'STOP',
} satisfies RawQueryResult

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubGenerateContent(response: Record<string, unknown>): CapturedRequest[] {
  const sent: CapturedRequest[] = []
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false')
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test.each([
  { name: 'executed search without citations', candidate: { finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['crm'] } }, expected: 'used' },
  { name: 'retrieved web source without query disclosure', candidate: { finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }] } }, expected: 'used' },
  { name: 'completed answer without search', candidate: { finishReason: 'STOP' }, expected: 'not-used' },
  { name: 'completed answer with empty search arrays', candidate: { finishReason: 'STOP', groundingMetadata: { webSearchQueries: [], groundingChunks: [] } }, expected: 'not-used' },
  { name: 'unfinished answer', candidate: { finishReason: 'MAX_TOKENS' }, expected: 'unknown' },
  { name: 'missing completion marker', candidate: {}, expected: 'unknown' },
])('retrieval distinguishes $name in sync, batch and stored responses', async ({ candidate, expected }) => {
  const response = { candidates: [{ content: { parts: [{ text: 'Example CRM.' }], role: 'model' }, ...candidate }] }
  stubGenerateContent(response)
  const raw = await geminiAdapter.executeTrackedQuery(QUERY, CONFIG)
  expect(raw.retrievalStatus).toBe(expected)
  expect(raw.retrievalContract).toBe('native-auto-v1')
  expect(geminiAdapter.parseTrackedQueryResponse!(response, CONFIG.model).retrievalStatus).toBe(expected)
  // Historical rows have no derived status. Reconstruct from provider evidence,
  // including when an older writer stored an incorrect status.
  expect(geminiAdapter.normalizeResult({ ...raw, retrievalStatus: 'unknown' }).retrievalStatus).toBe(expected)
})

test.each([
  {},
  { candidates: [] },
  { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] },
  { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '   ' }] } }] },
])('missing answer evidence stays unknown: %j', (response) => {
  const raw = geminiAdapter.parseTrackedQueryResponse!(response, CONFIG.model)
  expect(raw.retrievalStatus).toBe('unknown')
  expect(geminiAdapter.normalizeResult(raw).retrievalStatus).toBe('unknown')
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

test('a location reaches the wire through the built body', async () => {
  const sent = stubGenerateContent(RESPONSE)
  const input = { ...QUERY, location: LOCATION }
  await geminiAdapter.executeTrackedQuery(input, CONFIG)

  const built = geminiAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.contents).toEqual([
    { parts: [{ text: 'best crm for agencies (searching from San Francisco, CA, US)' }], role: 'user' },
  ])

  // The tracked path now supplies Content[], but real general-purpose callers
  // still send a string. Carry that separate SDK serialization contract here.
  const textSent = stubGenerateContent({
    candidates: [{ content: { role: 'model', parts: [{ text: 'General ' }, { text: 'text reply.' }] }, finishReason: 'STOP' }],
  })
  expect(await geminiAdapter.generateText('best crm for agencies (searching from San Francisco, CA, US)', CONFIG)).toBe('General text reply.')
  expect(textSent).toEqual([{
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    body: { contents: [{ role: 'user', parts: [{ text: 'best crm for agencies (searching from San Francisco, CA, US)' }] }] },
  }])
})

test('the endpoint names the Vertex AI resource path for a Vertex config', () => {
  const built = geminiAdapter.buildTrackedQueryRequest!(QUERY, { ...CONFIG, apiKey: '', vertexProject: 'proj-1', vertexRegion: 'europe-west4' })
  expect(built.endpoint).toBe('/v1beta1/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent')
  const defaultRegion = geminiAdapter.buildTrackedQueryRequest!(QUERY, { ...CONFIG, apiKey: '', vertexProject: 'proj-1' })
  expect(defaultRegion.endpoint).toBe('/v1beta1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent')
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  for (const row of [
    { label: 'grounded divergent served identity', response: RESPONSE, model: 'gemini-2.5-flash', expected: EXPECTED_TRACKED_RESULT },
    { label: 'captured identities with constructed answer', response: CAPTURED_ID_RESPONSE, model: 'gemini-3.5-flash', expected: EXPECTED_CAPTURED_ID_RESULT },
  ]) {
    const sent = stubGenerateContent(row.response)
    expect(await geminiAdapter.executeTrackedQuery(QUERY, { ...CONFIG, model: row.model }), row.label).toEqual(row.expected)
    expect(geminiAdapter.parseTrackedQueryResponse!(structuredClone(row.response), row.model), row.label).toEqual(row.expected)
    expect(geminiAdapter.normalizeResult(row.expected), row.label).toEqual(row.model === 'gemini-3.5-flash'
      ? { provider: 'gemini', answerText: 'Harborline Hotel is a harbor-side boutique inn.', citedDomains: ['harborline.example.com'], groundingSources: [{ uri: 'https://harborline.example.com/', title: 'harborline.example.com' }], searchQueries: ['"Harborline Hotel" harbor-side'], retrievalStatus: 'used' }
      : { provider: 'gemini', answerText: 'Example CRM is popular with agencies.', citedDomains: ['example.com'], groundingSources: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123', title: 'example.com' }], searchQueries: ['best crm for agencies 2026', 'agency crm comparison'], retrievalStatus: 'used' })
    expect(sent, row.label).toHaveLength(1)
  }
  // These identities are constructed, not captured. Missing, blank and null
  // disclosure must stay absent even though a requested model exists.
  const plain = { candidates: [{ content: { role: 'model', parts: [{ text: 'stub answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, responseId: 'resp_stub' }
  for (const row of [
    { label: 'synthetic divergent identity', response: { ...plain, modelVersion: 'gemini-2.5-flash-preview-05-20' }, stored: 'gemini-2.5-flash-preview-05-20', served: 'gemini-2.5-flash-preview-05-20' },
    { label: 'missing disclosure', response: plain, stored: null, served: undefined },
    { label: 'blank disclosure', response: { ...plain, modelVersion: '   ' }, stored: '   ', served: undefined },
    { label: 'null disclosure', response: { ...plain, modelVersion: null }, stored: null, served: undefined },
  ]) {
    const sent = stubGenerateContent(row.response)
    const expected = { provider: 'gemini', model: 'gemini-2.5-flash', servedModel: row.served,
      rawResponse: { candidates: [{ content: { role: 'model', parts: [{ text: 'stub answer' }] }, finishReason: 'STOP', groundingMetadata: undefined }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, responseId: 'resp_stub', modelVersion: row.stored },
      groundingSources: [], searchQueries: [], retrievalStatus: 'not-used', retrievalContract: 'native-auto-v1',
      usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, searchCount: 0 }, stopReason: 'STOP' }
    expect(await geminiAdapter.executeTrackedQuery(QUERY, CONFIG), row.label).toEqual(expected)
    expect(geminiAdapter.parseTrackedQueryResponse!(structuredClone(row.response), 'gemini-2.5-flash'), row.label).toEqual(expected)
    expect(sent, row.label).toHaveLength(1)
  }
})

test('parse stores the same trimmed record the sync path stores', () => {
  const stored = geminiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gemini-2.5-flash').rawResponse
  expect(stored).toEqual(EXPECTED_STORED_RESPONSE)
  expect(geminiAdapter.parseTrackedQueryResponse!(structuredClone(stored), 'gemini-2.5-flash').rawResponse).toEqual(EXPECTED_STORED_RESPONSE)
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
