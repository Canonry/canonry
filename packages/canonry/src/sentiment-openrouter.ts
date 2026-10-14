import type { ClassifierContext } from '@earendil-works/pi-ai'
import { SENTIMENT_OPENROUTER_MODEL, SENTIMENT_OPENROUTER_SERVED_MODEL, asRecord, isRetryableHttpError, retryAfterDelayMs, type SentimentClassifier, type SentimentUsage } from '@ainyc/canonry-contracts'
import { sentimentInstallReadiness, type SentimentInstallConfig } from '@ainyc/canonry-config'
import { createJevSentimentClassifier, createTypeSafeClassifier, type JevResult } from '@ainyc/canonry-integration-typesafe'
import { aeroModels } from './agent/pi-models.js'
import { getSharedProviderExecutionGate } from './provider-execution-gate.js'
import type { ProviderRegistry } from './provider-registry.js'

const OPENROUTER_SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone'
const UNKNOWN_USAGE: SentimentUsage = { kind: 'unknown', inputTokens: null, outputTokens: null }

/** pi owns transport; Canonry retains literal response provenance that pi's normalized result omits. */
export function createConfiguredSentimentClassifier(configuration: SentimentInstallConfig, registry?: ProviderRegistry, reload?: () => SentimentInstallConfig): SentimentClassifier {
  if (configuration.provider !== 'openrouter') return createTypeSafeClassifier({ apiKey: configuration.apiKey! })
  return createJevSentimentClassifier(async (request, signal): Promise<JevResult> => {
    const failure = (code: string, retryable = false, usage = UNKNOWN_USAGE, returnedModel: string | null = null, retryAfterMs: number | null = null): JevResult => ({
      ok: false, returnedModel, usage, error: { code, message: 'The OpenRouter sentiment evaluator did not return a usable pinned result.', retryable, retryAfterMs },
    })
    if (request.model !== SENTIMENT_OPENROUTER_MODEL) return failure('model-mismatch')
    const model = aeroModels.getModelOfType('classifier', 'openrouter', SENTIMENT_OPENROUTER_MODEL)
    if (!model) return failure('unsupported-model')
    const quota = registry?.get('openrouter')?.config.quotaPolicy
    const gate = getSharedProviderExecutionGate('openrouter', quota?.maxConcurrency ?? configuration.maxConcurrency, quota?.maxRequestsPerMinute ?? configuration.maxRequestsPerMinute)
    return gate.run<JevResult>(async () => {
      const active = reload?.() ?? configuration
      const readiness = sentimentInstallReadiness(active)
      if (!readiness.ready) return failure(readiness.reason ?? 'invalid-config', true)
      if (active.provider !== configuration.provider || active.model !== request.model) return failure('evaluator-route-changed', true)
      const observed: { body: Record<string, unknown> | null; status?: number; retryAfter?: string } = { body: null }
      const observedFetch: NonNullable<Parameters<typeof aeroModels.classify>[2]>['fetch'] = async (url, init) => {
        const endpoint = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        if (endpoint !== OPENROUTER_SYSTEM_ONE_URL) throw new Error('Unsupported sentiment transport endpoint.')
        const response = await fetch(OPENROUTER_SYSTEM_ONE_URL, { ...init, redirect: 'error' })
        observed.status = response.status
        observed.retryAfter = response.headers.get('retry-after') ?? undefined
        try { observed.body = asRecord(await response.clone().json()) } catch { observed.body = null }
        return response
      }
      const result = await aeroModels.classify(model, { state: request.state as ClassifierContext['state'], questions: request.questions }, {
        apiKey: active.apiKey, signal, maxRetries: 0, timeoutMs: 30_000,
        headers: { 'User-Agent': 'canonry' }, fetch: observedFetch,
      })
      const responseBody = observed.body
      const returnedModel = typeof responseBody?.model === 'string' ? responseBody.model : null
      const counts = asRecord(responseBody?.usage)
      const input = counts?.input_tokens; const output = counts?.output_tokens
      const usage: SentimentUsage = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
        ? { kind: 'reported', inputTokens: input, outputTokens: output } : UNKNOWN_USAGE
      if (result.stopReason !== 'stop') {
        if (signal?.aborted) return failure('canceled', false, usage, returnedModel)
        const { status, retryAfter } = observed
        const httpError = { status, retryAfter }
        const code = status === 401 || status === 403 ? 'provider-authorization' : status === 413 ? 'provider-context-limit'
          : status === 429 ? 'provider-rate-limit' : status && status >= 400 ? (isRetryableHttpError(httpError) ? 'provider-unavailable' : 'provider-rejected') : status ? 'response-contract' : 'provider-network'
        return failure(code, isRetryableHttpError(httpError), usage, returnedModel, retryAfterDelayMs(httpError))
      }
      if (returnedModel !== SENTIMENT_OPENROUTER_SERVED_MODEL) return failure('model-mismatch', false, usage, returnedModel)
      if (usage.kind !== 'reported') return failure('response-contract', false, usage, returnedModel)
      return { ok: true, returnedModel, usage, answers: result.answers }
    }, signal).catch(() => signal?.aborted
      ? failure(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'provider-timeout' : 'canceled', signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
      : failure('provider-network', true))
  })
}
