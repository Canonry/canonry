import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface OpenAIConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
  /**
   * Optional base URL override. When set, every `new OpenAI(...)` call in
   * this adapter passes it as `baseURL`. Defaults to OpenAI's public API
   * endpoint when omitted. Used by Canonry Hosted to route OpenAI calls
   * through the per-tenant LLM proxy (Track 1).
   */
  baseUrl?: string
}

export interface OpenAIHealthcheckResult {
  ok: boolean
  provider: 'openai'
  message: string
  model?: string
}

export interface OpenAITrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: OpenAIConfig
  location?: LocationContext
}

export interface OpenAIRawResult {
  provider: 'openai'
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface OpenAINormalizedResult {
  provider: 'openai'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
