import type { ProviderQuotaPolicy } from '@ainyc/aeo-platform-contracts'

export interface GeminiConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
}

export interface GeminiHealthcheckResult {
  ok: boolean
  provider: 'gemini'
  message: string
}

export interface GeminiTrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
}

export interface GeminiRawResult {
  provider: 'gemini'
  rawResponse: Record<string, unknown>
}

export interface GeminiNormalizedResult {
  provider: 'gemini'
  answerText: string
  citedDomains: string[]
}
