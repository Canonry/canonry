import { test, expect, vi, afterEach } from 'vitest'
import { ApiError } from '@google/genai'
import { embedQueries } from '../src/embeddings.js'

interface SentEmbeddingRequest { url: string; method: string; body: unknown; apiKey: string | null }
function respondWith(body: unknown, status = 200): SentEmbeddingRequest[] {
  const sent: SentEmbeddingRequest[] = []
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false')
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    sent.push({ url: request.url, method: request.method, body: await request.json(), apiKey: request.headers.get('x-goog-api-key') })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return sent
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

test('embedQueries performs no HTTP work for an empty basket', async () => {
  const sent = respondWith({ embeddings: [] })
  expect(await embedQueries([], { apiKey: '' })).toEqual([])
  expect(sent).toEqual([])
})

test('embedQueries sends literal defaults, overrides and ordered queries through the SDK', async () => {
  const rows = [
    { label: 'literal defaults', queries: ['a', 'b'], options: { apiKey: 'fake' },
      response: { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }, expected: [[0.1, 0.2], [0.3, 0.4]],
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
      body: { requests: [
        { content: { role: 'user', parts: [{ text: 'a' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' },
        { content: { role: 'user', parts: [{ text: 'b' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' },
      ] } },
    { label: 'custom model and dimensions', queries: ['a'], options: { apiKey: 'fake', model: 'gemini-embedding-experimental', outputDimensionality: 256 },
      response: { embeddings: [{ values: [0] }] }, expected: [[0]],
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-experimental:batchEmbedContents',
      body: { requests: [{ content: { role: 'user', parts: [{ text: 'a' }] }, taskType: 'CLUSTERING', outputDimensionality: 256, model: 'models/gemini-embedding-experimental' }] } },
    { label: 'three distinct vectors keep order', queries: ['a', 'b', 'c'], options: { apiKey: 'fake' },
      response: { embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }, { values: [0.7, 0.8, 0.9] }] },
      expected: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]],
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
      body: { requests: [
        { content: { role: 'user', parts: [{ text: 'a' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' },
        { content: { role: 'user', parts: [{ text: 'b' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' },
        { content: { role: 'user', parts: [{ text: 'c' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' },
      ] } },
  ]
  for (const row of rows) {
    const sent = respondWith(row.response)
    expect(await embedQueries(row.queries, row.options), row.label).toEqual(row.expected)
    expect(sent, row.label).toEqual([{ url: row.url, method: 'POST', body: row.body, apiKey: 'fake' }])
  }
})

test('embedQueries throws when API key is missing', async () => {
  const sent = respondWith({ embeddings: [{ values: [1] }] })
  await expect(embedQueries(['a'], { apiKey: '' })).rejects.toThrow('embedQueries: missing apiKey')
  expect(sent).toEqual([])
})

test('embedQueries preserves the native API error status and message', async () => {
  const sent = respondWith({ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429)
  const result = await embedQueries(['a'], { apiKey: 'fake' }).then(() => undefined, (error: unknown) => error)
  expect(result).toBeInstanceOf(ApiError)
  if (!(result instanceof ApiError)) throw new Error('Expected the SDK HTTP error')
  expect(result.status).toBe(429)
  expect(result.message).toBe('{"error":{"code":429,"message":"quota exceeded","status":"RESOURCE_EXHAUSTED"}}')
  expect(sent).toEqual([{ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', method: 'POST', apiKey: 'fake',
    body: { requests: [{ content: { role: 'user', parts: [{ text: 'a' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' }] } }])
})

test('embedQueries rejects mismatched query and response vector counts', async () => {
  for (const row of [
    { label: 'too few', response: { embeddings: [{ values: [1] }] }, message: 'embedQueries: expected 2 embeddings, got 1' },
    { label: 'too many', response: { embeddings: [{ values: [1] }, { values: [2] }, { values: [3] }] }, message: 'embedQueries: expected 2 embeddings, got 3' },
  ]) {
    const sent = respondWith(row.response)
    await expect(embedQueries(['a', 'b'], { apiKey: 'fake' }), row.label).rejects.toThrow(row.message)
    expect(sent, row.label).toHaveLength(1)
  }
})

test('embedQueries rejects missing or empty vectors at the correct query index', async () => {
  for (const row of [
    { label: 'missing second vector', queries: ['a', 'b'], response: { embeddings: [{ values: [1] }, {}] }, message: 'embedQueries: missing values for query at index 1' },
    { label: 'empty first vector', queries: ['a'], response: { embeddings: [{ values: [] }] }, message: 'embedQueries: missing values for query at index 0' },
  ]) {
    const sent = respondWith(row.response)
    await expect(embedQueries(row.queries, { apiKey: 'fake' }), row.label).rejects.toThrow(row.message)
    expect(sent, row.label).toHaveLength(1)
  }
})

test('embedQueries rejects missing embeddings instead of returning no vectors', async () => {
  for (const response of [{}, { embeddings: null }]) {
    const sent = respondWith(response)
    await expect(embedQueries(['a'], { apiKey: 'fake' })).rejects.toThrow('embedQueries: expected 1 embeddings, got 0')
    expect(sent).toHaveLength(1)
  }
})
