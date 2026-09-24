import { listModels } from './list-models.js'
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
  validateConfig as geminiValidateConfig,
  healthcheck as geminiHealthcheck,
  buildTrackedQueryRequest as geminiBuildTrackedQueryRequest,
  executeTrackedQuery as geminiExecuteTrackedQuery,
  parseTrackedQueryResponse as geminiParseTrackedQueryResponse,
  normalizeResult as geminiNormalizeResult,
  generateText as geminiGenerateText,
} from './normalize.js'
import type { GeminiConfig, GeminiRawResult, GeminiTrackedQueryInput } from './types.js'

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

function toGeminiInput(input: TrackedQueryInput, config: ProviderConfig): GeminiTrackedQueryInput {
  return {
    query: input.query,
    canonicalDomains: input.canonicalDomains,
    competitorDomains: input.competitorDomains,
    config: toGeminiConfig(config),
    location: input.location,
  }
}

function toRawQueryResult(raw: GeminiRawResult): RawQueryResult {
  return {
    provider: 'gemini',
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

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  displayName: 'Gemini',
  mode: 'api',
  // normalize.ts folds the location into the prompt the model receives.
  supportsLocationContext: true,
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

  listModels: (config, signal) => listModels(toGeminiConfig(config), signal),

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

  buildTrackedQueryRequest(input: TrackedQueryInput, config: ProviderConfig): TrackedQueryRequest {
    return geminiBuildTrackedQueryRequest(toGeminiInput(input, config))
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    return toRawQueryResult(await geminiExecuteTrackedQuery(toGeminiInput(input, config)))
  },

  parseTrackedQueryResponse(body: Record<string, unknown>, model: string): RawQueryResult {
    return toRawQueryResult(geminiParseTrackedQueryResponse(body, model))
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
      retrievalStatus: 'unknown' as const,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return geminiGenerateText(prompt, toGeminiConfig(config))
  },
}
