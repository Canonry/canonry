import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface PerplexityConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface PerplexityHealthcheckResult {
  ok: boolean
  provider: 'perplexity'
  message: string
  model?: string
}

export interface PerplexityTrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: PerplexityConfig
  location?: LocationContext
}

export interface PerplexityRawResult {
  provider: 'perplexity'
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface PerplexityNormalizedResult {
  provider: 'perplexity'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
