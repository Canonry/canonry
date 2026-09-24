import type { ProviderQuotaPolicy, ProviderUsage, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

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
  /** Verbatim `model` from the response; undefined when OpenAI disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** Billable usage from the response's `usage` object; undefined when it had none. */
  usage?: ProviderUsage
  /** `incomplete_details.reason`, else `status`; undefined when the response had neither. */
  stopReason?: string
}

export interface OpenAINormalizedResult {
  provider: 'openai'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
