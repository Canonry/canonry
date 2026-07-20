import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface LocalConfig {
  baseUrl: string
  apiKey?: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface LocalHealthcheckResult {
  ok: boolean
  provider: 'local'
  message: string
  model?: string
}

export interface LocalTrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: LocalConfig
  location?: LocationContext
}

export interface LocalRawResult {
  provider: 'local'
  rawResponse: Record<string, unknown>
  model: string
  /** Verbatim `model` from the response; undefined when the server disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface LocalNormalizedResult {
  provider: 'local'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
