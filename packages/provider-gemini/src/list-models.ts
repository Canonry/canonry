import { withRetry, isRetryableHttpError, retryAfterDelayMs, type ModelDefinition } from '@canonry/canonry-contracts'
import { createClient } from './normalize.js'
import type { GeminiConfig } from './types.js'

// General-purpose text answers with Google Search grounding, checked against
// https://ai.google.dev/gemini-api/docs/google-search and /docs/models (2026-11-06).
// This is a recommendation list, not a claim that specialist models cannot search.
// Explicit custom model IDs remain supported by provider configuration.
export const GEMINI_ANSWER_MODELS: ModelDefinition[] = [
  { id: 'gemini-flash-latest', displayName: 'Gemini Flash (latest)', tier: 'standard' },
  { id: 'gemini-flash-lite-latest', displayName: 'Gemini Flash-Lite (latest)', tier: 'economy' },
  { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', tier: 'standard' },
  { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', tier: 'standard' },
  { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', tier: 'standard' },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', tier: 'standard' },
  { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', tier: 'economy' },
  { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (preview)', tier: 'flagship' },
  { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (preview)', tier: 'standard' },
  // Google restricts these older models to accounts that have already used them.
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' },
  { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', tier: 'economy' },
]
const answerModels = new Map(GEMINI_ANSWER_MODELS.map(model => [model.id, model]))

export function listModels(config: GeminiConfig, signal: AbortSignal): Promise<ModelDefinition[]> {
  return withRetry(async () => {
    signal.throwIfAborted()
    const client = createClient(config)
    const page = await client.models.list({ config: { pageSize: 100, queryBase: true, abortSignal: signal, httpOptions: { timeout: 2500 } } })
    const models: ModelDefinition[] = []
    let seen = 0
    for await (const model of page) {
      signal.throwIfAborted()
      if (++seen > 1000) throw new Error('Model catalog exceeded the discovery limit')
      const id = model.name?.replace(/^(?:publishers\/google\/)?models\//, '')
      const recommended = id ? answerModels.get(id) : undefined
      if (!recommended) continue
      if (model.supportedActions && !model.supportedActions.includes('generateContent')) continue
      models.push({ ...recommended, displayName: model.displayName || recommended.displayName })
    }
    return models
  }, {
    maxRetries: 1,
    baseDelayMs: 200,
    isRetryable: error => !signal.aborted && isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, delay) => {
      const retryDelay = retryAfterDelayMs(error) ?? delay
      // A long Retry-After belongs to the next catalog refresh, not this page load.
      if (retryDelay >= 2500) throw error
      return retryDelay
    },
  })
}
