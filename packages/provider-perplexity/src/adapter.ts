import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  validateConfig as perplexityValidateConfig,
  healthcheck as perplexityHealthcheck,
  executeTrackedQuery as perplexityExecuteTrackedQuery,
  normalizeResult as perplexityNormalizeResult,
  generateText as perplexityGenerateText,
} from './normalize.js'
import type { PerplexityConfig } from './types.js'

function toPerplexityConfig(config: ProviderConfig): PerplexityConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const perplexityAdapter: ProviderAdapter = {
  name: 'perplexity',
  displayName: 'Perplexity',
  mode: 'api',
  keyUrl: 'https://www.perplexity.ai/settings/api',
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

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await perplexityExecuteTrackedQuery({
      keyword: input.keyword,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toPerplexityConfig(config),
      location: input.location,
    })
    return {
      provider: 'perplexity',
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
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
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return perplexityGenerateText(prompt, toPerplexityConfig(config))
  },
}
