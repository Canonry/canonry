import type {
  ProviderQuotaPolicy,
  ProviderUsage,
  GroundingSource,
  LocationContext,
  RetrievalContract,
  RetrievalStatus,
} from '@ainyc/canonry-contracts'

export type { GroundingSource, RetrievalContract, RetrievalStatus }

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
  /** Verbatim `model` from the response; undefined when Claude disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
  /** See {@link RetrievalContract}. */
  retrievalContract: RetrievalContract
  /** Billable usage from the response's `usage` block; undefined when it had none. */
  usage?: ProviderUsage
  /** `stop_reason` verbatim; undefined when the response had none. */
  stopReason?: string
}

export interface ClaudeNormalizedResult {
  provider: 'claude'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
}
