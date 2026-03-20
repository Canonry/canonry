import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  validateConfig as localValidateConfig,
  healthcheck as localHealthcheck,
  executeTrackedQuery as localExecuteTrackedQuery,
  normalizeResult as localNormalizeResult,
  generateText as localGenerateText,
} from './normalize.js'
import type { LocalConfig } from './types.js'

function toLocalConfig(config: ProviderConfig): LocalConfig {
  return {
    baseUrl: config.baseUrl ?? '',
    apiKey: config.apiKey,
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const localAdapter: ProviderAdapter = {
  name: 'local',
  displayName: 'Local',
  mode: 'api',
  modelRegistry: {
    defaultModel: 'llama3',
    validationPattern: /./,
    validationHint: 'any model name accepted',
    knownModels: [
      { id: 'llama3', displayName: 'Llama 3', tier: 'standard' },
    ],
  },

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = localValidateConfig(toLocalConfig(config))
    return {
      ok: result.ok,
      provider: 'local',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await localHealthcheck(toLocalConfig(config))
    return {
      ok: result.ok,
      provider: 'local',
      message: result.message,
      model: result.model,
    }
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await localExecuteTrackedQuery({
      keyword: input.keyword,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toLocalConfig(config),
      location: input.location,
    })
    return {
      provider: 'local',
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const localRaw = {
      provider: 'local' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
    const normalized = localNormalizeResult(localRaw)
    return {
      provider: 'local',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return localGenerateText(prompt, toLocalConfig(config))
  },
}
