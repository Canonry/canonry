import OpenAI from 'openai'
import { withRetry, isRetryableHttpError, retryAfterDelayMs, type ModelDefinition, type ProviderConfig } from '@ainyc/canonry-contracts'

export function listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]> {
  return withRetry(async () => {
    signal.throwIfAborted()
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0, timeout: 2500 })
    const models: ModelDefinition[] = []
    const page = client.models.list({ signal })
    let seen = 0
    for await (const model of page) {
      signal.throwIfAborted()
      if (++seen > 1000) throw new Error('Model catalog exceeded the discovery limit')
      if (!/^(?:gpt-|o\d|chat-)/.test(model.id) || /audio|realtime|transcrib|tts|image|codex|search|instruct/.test(model.id)) continue
      // These legacy families use Chat Completions, not this adapter's Responses web-search path.
      if (/^gpt-(?:3\.5|4)(?:-|$)/.test(model.id)) continue
      models.push({ id: model.id, displayName: model.id, tier: 'standard' })
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
