import type { GroundingSource, LocationContext, ProviderQuotaPolicy, ProviderUsage, RetrievalStatus, RetrievedSource } from '@canonry/canonry-contracts'

export type { GroundingSource, RetrievedSource }

export interface MuseConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
  baseUrl?: string
}

export interface MuseTrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  location?: LocationContext
  config: MuseConfig
}

export interface MuseRawResult {
  provider: 'muse'
  rawResponse: Record<string, unknown>
  model: string
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** Pages Muse's searches listed or opened; null when the stored response predates capture. */
  retrievedSources: RetrievedSource[] | null
  retrievalStatus: RetrievalStatus
  /** Billable usage from the response's `usage` object; undefined when it had none. */
  usage?: ProviderUsage
  /** `incomplete_details.reason`, else `status`; undefined when the response had neither. */
  stopReason?: string
}

export interface MuseNormalizedResult {
  provider: 'muse'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  retrievedSources: RetrievedSource[] | null
  retrievalStatus: RetrievalStatus
}
