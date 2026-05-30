import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface PerplexityConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
  /**
   * Optional base URL override. Defaults to `https://api.perplexity.ai` (the
   * Perplexity Sonar OpenAI-compatible endpoint). Used by Canonry Hosted to
   * route Perplexity calls through the per-tenant LLM proxy (Track 1).
   * Same wire format — Perplexity uses the OpenAI SDK in compatibility mode.
   */
  baseUrl?: string
}

export interface PerplexityHealthcheckResult {
  ok: boolean
  provider: 'perplexity'
  message: string
  model?: string
}

export interface PerplexityTrackedQueryInput {
  query: string
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
