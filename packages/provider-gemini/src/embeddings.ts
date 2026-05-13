import { GoogleGenAI } from '@google/genai'

export const DEFAULT_EMBED_MODEL = 'gemini-embedding-001'
export const DEFAULT_OUTPUT_DIMENSIONALITY = 768
export const CLUSTERING_TASK_TYPE = 'CLUSTERING'

export interface EmbedRequestOpts {
  model: string
  taskType: string
  outputDimensionality?: number
}

export interface EmbedClient {
  embedBatch: (queries: string[], opts: EmbedRequestOpts) => Promise<number[][]>
}

export interface EmbedQueriesOptions {
  apiKey: string
  model?: string
  outputDimensionality?: number
  /** Override client — used for tests and Vertex-mode adapters that bypass the default GenAI SDK. */
  client?: EmbedClient
}

export async function embedQueries(
  queries: string[],
  options: EmbedQueriesOptions,
): Promise<number[][]> {
  if (queries.length === 0) return []
  if (!options.apiKey && !options.client) {
    throw new Error('embedQueries: missing apiKey')
  }
  const client = options.client ?? createGeminiEmbedClient(options.apiKey)
  return client.embedBatch(queries, {
    model: options.model ?? DEFAULT_EMBED_MODEL,
    taskType: CLUSTERING_TASK_TYPE,
    outputDimensionality: options.outputDimensionality ?? DEFAULT_OUTPUT_DIMENSIONALITY,
  })
}

/**
 * Pure helper that validates an `embedContent` response shape and projects
 * it down to ordered `number[][]`. Extracted from the default client so we
 * can test the validation paths without mocking `GoogleGenAI`.
 */
export function extractEmbeddingVectors(
  response: { embeddings?: Array<{ values?: number[] }> } | null | undefined,
  expectedLength: number,
): number[][] {
  const embeddings = response?.embeddings ?? []
  if (embeddings.length !== expectedLength) {
    throw new Error(
      `embedQueries: expected ${expectedLength} embeddings, got ${embeddings.length}`,
    )
  }
  return embeddings.map((e, i) => {
    if (!e.values || e.values.length === 0) {
      throw new Error(`embedQueries: missing values for query at index ${i}`)
    }
    return e.values
  })
}

function createGeminiEmbedClient(apiKey: string): EmbedClient {
  const genai = new GoogleGenAI({ apiKey })
  return {
    async embedBatch(queries, opts) {
      const response = await genai.models.embedContent({
        model: opts.model,
        contents: queries,
        config: {
          taskType: opts.taskType,
          outputDimensionality: opts.outputDimensionality,
        },
      })
      return extractEmbeddingVectors(response, queries.length)
    },
  }
}
