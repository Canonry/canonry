import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  validateConfig as openaiValidateConfig,
  healthcheck as openaiHealthcheck,
  executeTrackedQuery as openaiExecuteTrackedQuery,
  normalizeResult as openaiNormalizeResult,
  generateText as openaiGenerateText,
} from './normalize.js'
import type { OpenAIConfig } from './types.js'

function toOpenAIConfig(config: ProviderConfig): OpenAIConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  displayName: 'OpenAI',
  mode: 'api',
  keyUrl: 'https://platform.openai.com/api-keys',
  modelRegistry: {
    defaultModel: 'gpt-5.4',
    validationPattern: /^(gpt-|o\d)/,
    validationHint: 'expected a GPT or o-series model name (e.g. gpt-5.4, o3)',
    knownModels: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' },
      { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', tier: 'flagship' },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' },
      { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', tier: 'economy' },
      { id: 'gpt-5', displayName: 'GPT-5', tier: 'standard' },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' },
    ],
  },

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
      location: input.location,
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

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return openaiGenerateText(prompt, toOpenAIConfig(config))
  },
}
