import { listModels } from './list-models.js'
import { claudeBatch } from './batch.js'
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
  validateConfig as claudeValidateConfig,
  healthcheck as claudeHealthcheck,
  buildTrackedQueryRequest as claudeBuildTrackedQueryRequest,
  executeTrackedQuery as claudeExecuteTrackedQuery,
  parseTrackedQueryResponse as claudeParseTrackedQueryResponse,
  normalizeResult as claudeNormalizeResult,
  generateText as claudeGenerateText,
  CLAUDE_RETRIEVAL_CONTRACT,
} from './normalize.js'
import type { ClaudeConfig, ClaudeRawResult, ClaudeTrackedQueryInput } from './types.js'

function toClaudeConfig(config: ProviderConfig): ClaudeConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

function toClaudeInput(input: TrackedQueryInput, config: ProviderConfig): ClaudeTrackedQueryInput {
  return {
    query: input.query,
    canonicalDomains: input.canonicalDomains,
    competitorDomains: input.competitorDomains,
    config: toClaudeConfig(config),
    location: input.location,
  }
}

function toRawQueryResult(raw: ClaudeRawResult): RawQueryResult {
  return {
    provider: 'claude',
    rawResponse: raw.rawResponse,
    model: raw.model,
    servedModel: raw.servedModel,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
    retrievalStatus: raw.retrievalStatus,
    retrievalContract: raw.retrievalContract,
    usage: raw.usage,
    stopReason: raw.stopReason,
  }
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  displayName: 'Claude',
  mode: 'api',
  // normalize.ts sets `user_location` on the web_search tool.
  supportsLocationContext: true,
  keyUrl: 'https://platform.claude.com/settings/keys',
  // Upstream model list: https://platform.claude.com/docs/en/about-claude/models/overview
  modelRegistry: {
    defaultModel: 'claude-sonnet-4-6',
    validationPattern: /^claude-/,
    validationHint: 'model name must start with "claude-" (e.g. claude-sonnet-4-6)',
    knownModels: [
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'flagship' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'standard' },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'fast' },
    ],
  },

  listModels,

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = claudeValidateConfig(toClaudeConfig(config))
    return {
      ok: result.ok,
      provider: 'claude',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await claudeHealthcheck(toClaudeConfig(config))
    return {
      ok: result.ok,
      provider: 'claude',
      message: result.message,
      model: result.model,
    }
  },

  buildTrackedQueryRequest(input: TrackedQueryInput, config: ProviderConfig): TrackedQueryRequest {
    return claudeBuildTrackedQueryRequest(toClaudeInput(input, config))
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    return toRawQueryResult(await claudeExecuteTrackedQuery(toClaudeInput(input, config)))
  },

  parseTrackedQueryResponse(body: Record<string, unknown>, model: string): RawQueryResult {
    return toRawQueryResult(claudeParseTrackedQueryResponse(body, model))
  },

  // Message Batches: the same request bodies at half the token price. See batch.ts.
  batch: claudeBatch,

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const claudeRaw = {
      provider: 'claude' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      // The shared RawQueryResult now carries retrieval, so nothing is lost
      // across this boundary. A reconstruction that predates the field falls
      // back to `unknown` rather than asserting an absence.
      retrievalStatus: raw.retrievalStatus ?? 'unknown',
      retrievalContract: raw.retrievalContract ?? CLAUDE_RETRIEVAL_CONTRACT,
    }
    const normalized = claudeNormalizeResult(claudeRaw)
    return {
      provider: 'claude',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
      retrievalStatus: normalized.retrievalStatus,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return claudeGenerateText(prompt, toClaudeConfig(config))
  },
}
