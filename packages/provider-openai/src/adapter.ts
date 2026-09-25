import { listModels } from './list-models.js'
import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import { RetrievalStatuses } from '@ainyc/canonry-contracts'
import {
  validateConfig as openaiValidateConfig,
  healthcheck as openaiHealthcheck,
  executeTrackedQuery as openaiExecuteTrackedQuery,
  normalizeResult as openaiNormalizeResult,
  generateText as openaiGenerateText,
  OPENAI_RETRIEVAL_CONTRACT,
} from './normalize.js'
import type { OpenAIConfig } from './types.js'

export function toOpenAIConfig(config: ProviderConfig): OpenAIConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    baseUrl: config.baseUrl,
    quotaPolicy: config.quotaPolicy,
  }
}

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  displayName: 'OpenAI',
  mode: 'api',
  // normalize.ts sets `user_location` on the web_search tool.
  supportsLocationContext: true,
  keyUrl: 'https://platform.openai.com/api-keys',
  // Upstream model list: https://platform.openai.com/docs/models
  modelRegistry: {
    defaultModel: 'gpt-5.4',
    validationPattern: /./,
    validationHint: 'any valid OpenAI model name (e.g. gpt-5.4, o3, chatgpt-4o-latest)',
    knownModels: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' },
      { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', tier: 'flagship' },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' },
      { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', tier: 'economy' },
      { id: 'gpt-5', displayName: 'GPT-5', tier: 'standard' },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' },
    ],
  },

  listModels,

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
      query: input.query,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toOpenAIConfig(config),
      location: input.location,
    })
    return {
      provider: 'openai',
      rawResponse: raw.rawResponse,
      model: raw.model,
      servedModel: raw.servedModel,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      // Read from the response's `web_search_call` items. Under forced search
      // nearly every row reads `used`; that is the contract holding, and a
      // `not-used` row is the visible breach, so the observation still
      // discriminates. The contract declares how the request was built.
      retrievalStatus: raw.retrievalStatus,
      retrievalContract: raw.retrievalContract,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const openaiRaw = {
      provider: 'openai' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      // A reconstruction that predates the field falls back to `unknown`
      // rather than asserting an absence.
      retrievalStatus: raw.retrievalStatus ?? RetrievalStatuses.unknown,
      retrievalContract: raw.retrievalContract ?? OPENAI_RETRIEVAL_CONTRACT,
    }
    const normalized = openaiNormalizeResult(openaiRaw)
    return {
      provider: 'openai',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
      retrievalStatus: normalized.retrievalStatus,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return openaiGenerateText(prompt, toOpenAIConfig(config))
  },
}
