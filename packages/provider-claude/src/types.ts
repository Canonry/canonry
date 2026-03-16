import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface ClaudeConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface ClaudeHealthcheckResult {
  ok: boolean
  provider: 'claude'
  message: string
  model?: string
}

export interface ClaudeTrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: ClaudeConfig
  location?: LocationContext
}

export interface ClaudeRawResult {
  provider: 'claude'
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface ClaudeNormalizedResult {
  provider: 'claude'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
