import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/aeo-platform-contracts'
import {
  validateConfig as claudeValidateConfig,
  healthcheck as claudeHealthcheck,
  executeTrackedQuery as claudeExecuteTrackedQuery,
  normalizeResult as claudeNormalizeResult,
} from './normalize.js'
import type { ClaudeConfig } from './types.js'

function toClaudeConfig(config: ProviderConfig): ClaudeConfig {
  return {
    apiKey: config.apiKey,
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',

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

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await claudeExecuteTrackedQuery({
      keyword: input.keyword,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toClaudeConfig(config),
    })
    return {
      provider: 'claude',
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const claudeRaw = {
      provider: 'claude' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
    }
    const normalized = claudeNormalizeResult(claudeRaw)
    return {
      provider: 'claude',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
    }
  },
}
