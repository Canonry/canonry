import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface OpenAIConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
  /**
   * Custom API endpoint (e.g. a proxy in front of the OpenAI API). Maps to the
   * SDK's `baseURL`. When unset, the SDK uses its default endpoint.
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
