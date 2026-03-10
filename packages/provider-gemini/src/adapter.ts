import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  validateConfig as geminiValidateConfig,
  healthcheck as geminiHealthcheck,
  executeTrackedQuery as geminiExecuteTrackedQuery,
  normalizeResult as geminiNormalizeResult,
} from './normalize.js'
import type { GeminiConfig } from './types.js'

function toGeminiConfig(config: ProviderConfig): GeminiConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = geminiValidateConfig(toGeminiConfig(config))
    return {
      ok: result.ok,
      provider: 'gemini',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await geminiHealthcheck(toGeminiConfig(config))
    return {
      ok: result.ok,
      provider: 'gemini',
      message: result.message,
      model: result.model,
    }
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await geminiExecuteTrackedQuery({
      keyword: input.keyword,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toGeminiConfig(config),
    })
    return {
      provider: 'gemini',
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const geminiRaw = {
      provider: 'gemini' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
    const normalized = geminiNormalizeResult(geminiRaw)
    return {
      provider: 'gemini',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
    }
  },
}
