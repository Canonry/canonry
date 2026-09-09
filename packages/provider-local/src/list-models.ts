import { withRetry, isRetryableHttpError, retryAfterDelayMs, type ModelDefinition, type ProviderConfig } from '@ainyc/canonry-contracts'

export function listModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]> {
  return withRetry(async () => {
    signal.throwIfAborted()
    if (!config.baseUrl) throw new Error('Local model discovery requires a configured endpoint')
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET', signal,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    })
    if (!response.ok) throw Object.assign(new Error('Local model discovery failed'), { status: response.status, headers: response.headers })
    const body = await response.json() as { data: Array<{ id: string }> }
    return body.data.filter(model => typeof model.id === 'string' && model.id.trim()).slice(0, 1000)
      .map(model => ({ id: model.id, displayName: model.id, tier: 'standard' as const }))
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
