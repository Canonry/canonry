import Anthropic from '@anthropic-ai/sdk'
import { withRetry, isRetryableHttpError, retryAfterDelayMs, type ModelDefinition, type ProviderConfig } from '@ainyc/canonry-contracts'

export function listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]> {
  return withRetry(async () => {
    signal.throwIfAborted()
    const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0, timeout: 2500 })
    const models: ModelDefinition[] = []
    const page = client.models.list({ limit: 100 }, { signal })
    let seen = 0
    for await (const model of page) {
      signal.throwIfAborted()
      if (++seen > 1000) throw new Error('Model catalog exceeded the discovery limit')
      models.push({ id: model.id, displayName: model.display_name, tier: 'standard' })
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
