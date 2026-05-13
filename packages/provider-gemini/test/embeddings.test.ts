import { test, expect, vi } from 'vitest'
import {
  embedQueries,
  CLUSTERING_TASK_TYPE,
  DEFAULT_EMBED_MODEL,
  DEFAULT_OUTPUT_DIMENSIONALITY,
  extractEmbeddingVectors,
  type EmbedClient,
} from '../src/embeddings.js'

function stubClient(vectors: number[][]): EmbedClient {
  return { embedBatch: vi.fn(async () => vectors) }
}

test('embedQueries returns empty array without invoking client when queries is empty', async () => {
  const client = stubClient([])
  const result = await embedQueries([], { apiKey: 'fake', client })
  expect(result).toEqual([])
  expect(client.embedBatch).not.toHaveBeenCalled()
})

test('embedQueries calls client with default model, CLUSTERING taskType, and default 768-dim output', async () => {
  const client = stubClient([
    [0.1, 0.2],
    [0.3, 0.4],
  ])
  await embedQueries(['a', 'b'], { apiKey: 'fake', client })
  expect(client.embedBatch).toHaveBeenCalledOnce()
  expect(client.embedBatch).toHaveBeenCalledWith(['a', 'b'], {
    model: DEFAULT_EMBED_MODEL,
    taskType: CLUSTERING_TASK_TYPE,
    outputDimensionality: DEFAULT_OUTPUT_DIMENSIONALITY,
  })
})

test('embedQueries honors custom model and outputDimensionality', async () => {
  const client = stubClient([[0]])
  await embedQueries(['a'], {
    apiKey: 'fake',
    client,
    model: 'gemini-embedding-experimental',
    outputDimensionality: 256,
  })
  expect(client.embedBatch).toHaveBeenCalledWith(['a'], {
    model: 'gemini-embedding-experimental',
    taskType: CLUSTERING_TASK_TYPE,
    outputDimensionality: 256,
  })
})

test('embedQueries returns the client vectors verbatim, preserving order', async () => {
  const expected = [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
    [0.7, 0.8, 0.9],
  ]
  const client = stubClient(expected)
  const result = await embedQueries(['a', 'b', 'c'], { apiKey: 'fake', client })
  expect(result).toEqual(expected)
})

test('embedQueries throws when API key is missing', async () => {
  await expect(embedQueries(['a'], { apiKey: '' })).rejects.toThrow(/api ?key/i)
})

test('embedQueries propagates client errors with context', async () => {
  const client: EmbedClient = {
    embedBatch: async () => {
      throw new Error('quota exceeded')
    },
  }
  await expect(embedQueries(['a'], { apiKey: 'fake', client })).rejects.toThrow(/quota/i)
})

test('extractEmbeddingVectors returns ordered values arrays', () => {
  const response = {
    embeddings: [
      { values: [0.1, 0.2] },
      { values: [0.3, 0.4] },
    ],
  }
  expect(extractEmbeddingVectors(response, 2)).toEqual([
    [0.1, 0.2],
    [0.3, 0.4],
  ])
})

test('extractEmbeddingVectors throws when response length differs from expected', () => {
  expect(() =>
    extractEmbeddingVectors({ embeddings: [{ values: [1] }] }, 2),
  ).toThrow(/expected 2.*got 1/)
})

test('extractEmbeddingVectors throws on missing or empty values', () => {
  expect(() =>
    extractEmbeddingVectors({ embeddings: [{ values: [1] }, {}] }, 2),
  ).toThrow(/missing values.*index 1/)
  expect(() =>
    extractEmbeddingVectors({ embeddings: [{ values: [] }] }, 1),
  ).toThrow(/missing values.*index 0/)
})

test('extractEmbeddingVectors treats missing embeddings array as length-0 response', () => {
  expect(() => extractEmbeddingVectors({}, 1)).toThrow(/expected 1.*got 0/)
})
