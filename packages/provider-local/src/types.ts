import type { ProviderQuotaPolicy, GroundingSource } from '@ainyc/canonry-contracts'

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
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: LocalConfig
}

export interface LocalRawResult {
  provider: 'local'
  rawResponse: Record<string, unknown>
  model: string
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
