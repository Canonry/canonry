import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface ClaudeConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
  /**
   * Optional base URL override. When set, every `new Anthropic(...)` call in
   * this adapter passes it as `baseURL`. Defaults to Anthropic's public API
   * endpoint when omitted. Used by Canonry Hosted to route Anthropic calls
   * through the per-tenant LLM proxy (Track 1).
   */
  baseUrl?: string
}

export interface ClaudeHealthcheckResult {
  ok: boolean
  provider: 'claude'
  message: string
  model?: string
}

export interface ClaudeTrackedQueryInput {
  query: string
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
