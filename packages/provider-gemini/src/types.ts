import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface GeminiConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface GeminiHealthcheckResult {
  ok: boolean
  provider: 'gemini'
  message: string
  model?: string
}

export interface GeminiTrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: GeminiConfig
  location?: LocationContext
}

export interface GeminiRawResult {
  provider: 'gemini'
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface GeminiNormalizedResult {
  provider: 'gemini'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
