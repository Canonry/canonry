import { withRetry, isRetryableHttpError, retryAfterDelayMs, type ModelDefinition } from '@ainyc/canonry-contracts'
import { createClient } from './normalize.js'
import type { GeminiConfig } from './types.js'

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
      if (!id?.startsWith('gemini-') || /image|tts|audio|live|embedding/.test(id)) continue
      if (model.supportedActions && !model.supportedActions.includes('generateContent')) continue
      models.push({ id, displayName: model.displayName || id, tier: 'standard' })
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
