import { GoogleGenAI } from '@google/genai'

const DEFAULT_EMBED_MODEL = 'gemini-embedding-001'
const DEFAULT_OUTPUT_DIMENSIONALITY = 768
const CLUSTERING_TASK_TYPE = 'CLUSTERING'

export interface EmbedQueriesOptions {
  apiKey: string
  model?: string
  outputDimensionality?: number
  /** Optional proxy/gateway endpoint; its path prefix is preserved. */
  baseUrl?: string
}

export async function embedQueries(queries: string[], options: EmbedQueriesOptions): Promise<number[][]> {
  if (queries.length === 0) return []
  if (!options.apiKey) throw new Error('embedQueries: missing apiKey')
  const genai = new GoogleGenAI({ apiKey: options.apiKey, ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {}) })
  const response = await genai.models.embedContent({
    model: options.model ?? DEFAULT_EMBED_MODEL,
    contents: queries,
    config: { taskType: CLUSTERING_TASK_TYPE, outputDimensionality: options.outputDimensionality ?? DEFAULT_OUTPUT_DIMENSIONALITY },
  })
  return extractEmbeddingVectors(response, queries.length)
}

function extractEmbeddingVectors(
  response: { embeddings?: Array<{ values?: number[] }> } | null | undefined,
  expectedLength: number,
): number[][] {
  const embeddings = response?.embeddings ?? []
  if (embeddings.length !== expectedLength) {
    throw new Error(`embedQueries: expected ${expectedLength} embeddings, got ${embeddings.length}`)
  }
  return embeddings.map((e, i) => {
    if (!e.values || e.values.length === 0) throw new Error(`embedQueries: missing values for query at index ${i}`)
    return e.values
  })
}
