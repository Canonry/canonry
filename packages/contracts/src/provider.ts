import { z } from 'zod'
import type { GroundingSource } from './run.js'

export const providerQuotaPolicySchema = z.object({
  maxConcurrency: z.number().int().positive(),
  maxRequestsPerMinute: z.number().int().positive(),
  maxRequestsPerDay: z.number().int().positive(),
})

export type ProviderQuotaPolicy = z.infer<typeof providerQuotaPolicySchema>

export const providerNameSchema = z.enum(['gemini', 'openai', 'claude', 'local'])
export type ProviderName = z.infer<typeof providerNameSchema>

export interface ProviderConfig {
  provider: ProviderName
  apiKey?: string
  baseUrl?: string
  model?: string
  quotaPolicy: ProviderQuotaPolicy
}

export interface TrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
}

export interface RawQueryResult {
  provider: ProviderName
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface NormalizedQueryResult {
  provider: ProviderName
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface ProviderHealthcheckResult {
  ok: boolean
  provider: ProviderName
  message: string
  model?: string
}

export interface ProviderAdapter {
  name: ProviderName
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult>
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
}
