import type { ProviderQuotaPolicy, GroundingSource } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface OpenAIConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface OpenAIHealthcheckResult {
  ok: boolean
  provider: 'openai'
  message: string
  model?: string
}

export interface OpenAITrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: OpenAIConfig
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
