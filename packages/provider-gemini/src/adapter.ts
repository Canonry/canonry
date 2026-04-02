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
  generateText as geminiGenerateText,
} from './normalize.js'
import type { GeminiConfig } from './types.js'

function toGeminiConfig(config: ProviderConfig): GeminiConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
    vertexProject: config.vertexProject,
    vertexRegion: config.vertexRegion,
    vertexCredentials: config.vertexCredentials,
  }
}

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  displayName: 'Gemini',
  mode: 'api',
  keyUrl: 'https://aistudio.google.com/apikey',
  modelRegistry: {
    defaultModel: 'gemini-3-flash',
    validationPattern: /^gemini-/,
    validationHint: 'model name must start with "gemini-" (e.g. gemini-3-flash)',
    knownModels: [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (Preview)', tier: 'flagship' },
      { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', tier: 'standard' },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (Preview)', tier: 'standard' },
      { id: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash-Lite (Preview)', tier: 'economy' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' },
    ],
  },

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
      location: input.location,
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

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return geminiGenerateText(prompt, toGeminiConfig(config))
  },
}
