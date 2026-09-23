import OpenAI from 'openai'
import {
  isRetryableHttpError,
  retryAfterDelayMs,
  withRetry,
  type ModelDefinition,
  type ProviderConfig,
} from '@ainyc/canonry-contracts'
import { MUSE_BASE_URL } from './normalize.js'

export function listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]> {
  return withRetry(async () => {
    signal.throwIfAborted()
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || MUSE_BASE_URL,
      maxRetries: 0,
      timeout: 2500,
    })
    const models: ModelDefinition[] = []
    let seen = 0
    for await (const model of client.models.list({ signal })) {
      signal.throwIfAborted()
      if (++seen > 1000) throw new Error('Model catalog exceeded the discovery limit')
      if (!/^muse-spark-/.test(model.id) || /-contributor(?:-|$)/.test(model.id)) continue
      models.push({ id: model.id, displayName: model.id, tier: 'standard' })
    }
    return models
  }, {
    maxRetries: 1,
    baseDelayMs: 200,
    isRetryable: error => !signal.aborted && isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, delay) => {
      const retryDelay = retryAfterDelayMs(error) ?? delay
      if (retryDelay >= 2500) throw error
      return retryDelay
    },
  })
}
