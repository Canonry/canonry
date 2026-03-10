import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/aeo-platform-contracts'
import {
  validateConfig as openaiValidateConfig,
  healthcheck as openaiHealthcheck,
  executeTrackedQuery as openaiExecuteTrackedQuery,
  normalizeResult as openaiNormalizeResult,
} from './normalize.js'
import type { OpenAIConfig } from './types.js'

function toOpenAIConfig(config: ProviderConfig): OpenAIConfig {
  return {
    apiKey: config.apiKey,
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = openaiValidateConfig(toOpenAIConfig(config))
    return {
      ok: result.ok,
      provider: 'openai',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await openaiHealthcheck(toOpenAIConfig(config))
    return {
      ok: result.ok,
      provider: 'openai',
      message: result.message,
      model: result.model,
    }
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await openaiExecuteTrackedQuery({
      keyword: input.keyword,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toOpenAIConfig(config),
    })
    return {
      provider: 'openai',
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const openaiRaw = {
      provider: 'openai' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
    const normalized = openaiNormalizeResult(openaiRaw)
    return {
      provider: 'openai',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
    }
  },
}
