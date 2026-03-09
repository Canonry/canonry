import type { ProviderQuotaPolicy, GroundingSource } from '@ainyc/aeo-platform-contracts'

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
