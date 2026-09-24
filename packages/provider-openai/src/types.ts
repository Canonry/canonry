import type {
  ProviderQuotaPolicy,
  GroundingSource,
  LocationContext,
  RetrievalContract,
  RetrievalStatus,
} from '@ainyc/canonry-contracts'

export type { GroundingSource, RetrievalContract, RetrievalStatus }

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
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
  /** See {@link RetrievalContract}. */
  retrievalContract: RetrievalContract
}

export interface OpenAINormalizedResult {
  provider: 'openai'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
}
