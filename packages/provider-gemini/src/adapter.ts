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

export function toGeminiConfig(config: ProviderConfig): GeminiConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    baseUrl: config.baseUrl,
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
  // Upstream model list: https://ai.google.dev/gemini-api/docs/models
  modelRegistry: {
    defaultModel: 'gemini-2.5-flash',
    validationPattern: /./,
    validationHint: 'any valid Google model name (e.g. gemini-2.5-flash, learnlm-1.5-pro-experimental)',
    knownModels: [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', tier: 'economy' },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', tier: 'standard' },
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
      query: input.query,
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
