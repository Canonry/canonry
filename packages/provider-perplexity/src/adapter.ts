import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  TrackedQueryRequest,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  validateConfig as perplexityValidateConfig,
  healthcheck as perplexityHealthcheck,
  buildTrackedQueryRequest as perplexityBuildTrackedQueryRequest,
  executeTrackedQuery as perplexityExecuteTrackedQuery,
  parseTrackedQueryResponse as perplexityParseTrackedQueryResponse,
  normalizeResult as perplexityNormalizeResult,
  generateText as perplexityGenerateText,
} from './normalize.js'
import type { PerplexityConfig, PerplexityRawResult, PerplexityTrackedQueryInput } from './types.js'

function toPerplexityConfig(config: ProviderConfig): PerplexityConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

function toPerplexityInput(input: TrackedQueryInput, config: ProviderConfig): PerplexityTrackedQueryInput {
  return {
    query: input.query,
    canonicalDomains: input.canonicalDomains,
    competitorDomains: input.competitorDomains,
    config: toPerplexityConfig(config),
    location: input.location,
  }
}

function toRawQueryResult(raw: PerplexityRawResult): RawQueryResult {
  return {
    provider: 'perplexity',
    rawResponse: raw.rawResponse,
    model: raw.model,
    servedModel: raw.servedModel,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
    // Retrieval detection is not implemented for this provider. Its candidate
    // marker is present on 100% of stored rows, so it has never been shown to
    // discriminate a non-retrieving answer and wiring it up would hardcode
    // `used`. `unknown` states what we actually know. The contract is a
    // declaration about how we build the request, so it is always knowable.
    retrievalStatus: 'unknown' as const,
    retrievalContract: 'native-auto-v1' as const,
    usage: raw.usage,
    stopReason: raw.stopReason,
  }
}

export const perplexityAdapter: ProviderAdapter = {
  name: 'perplexity',
  displayName: 'Perplexity',
  mode: 'api',
  // normalize.ts folds the location into the prompt the model receives.
  supportsLocationContext: true,
  keyUrl: 'https://www.perplexity.ai/settings/api',
  // Upstream model list: https://docs.perplexity.ai/guides/model-cards
  modelRegistry: {
    defaultModel: 'sonar',
    validationPattern: /^sonar/,
    validationHint: 'expected a sonar model (e.g. sonar, sonar-pro, sonar-reasoning)',
    knownModels: [
      { id: 'sonar', displayName: 'Sonar', tier: 'standard' },
      { id: 'sonar-pro', displayName: 'Sonar Pro', tier: 'flagship' },
      { id: 'sonar-reasoning', displayName: 'Sonar Reasoning', tier: 'flagship' },
      { id: 'sonar-reasoning-pro', displayName: 'Sonar Reasoning Pro', tier: 'flagship' },
    ],
  },

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = perplexityValidateConfig(toPerplexityConfig(config))
    return {
      ok: result.ok,
      provider: 'perplexity',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await perplexityHealthcheck(toPerplexityConfig(config))
    return {
      ok: result.ok,
      provider: 'perplexity',
      message: result.message,
      model: result.model,
    }
  },

  buildTrackedQueryRequest(input: TrackedQueryInput, config: ProviderConfig): TrackedQueryRequest {
    return perplexityBuildTrackedQueryRequest(toPerplexityInput(input, config))
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    return toRawQueryResult(await perplexityExecuteTrackedQuery(toPerplexityInput(input, config)))
  },

  parseTrackedQueryResponse(body: Record<string, unknown>, model: string): RawQueryResult {
    return toRawQueryResult(perplexityParseTrackedQueryResponse(body, model))
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const perplexityRaw = {
      provider: 'perplexity' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
    const normalized = perplexityNormalizeResult(perplexityRaw)
    return {
      provider: 'perplexity',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
      retrievalStatus: 'unknown' as const,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return perplexityGenerateText(prompt, toPerplexityConfig(config))
  },
}
