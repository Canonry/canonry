import type { GroundingSource, LocationContext, ProviderQuotaPolicy, RetrievalStatus } from '@ainyc/canonry-contracts'

export type { GroundingSource }

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
  retrievalStatus: RetrievalStatus
}

export interface MuseNormalizedResult {
  provider: 'muse'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  retrievalStatus: RetrievalStatus
}
