import { z } from 'zod'
import type { GroundingSource } from './run.js'

export const providerQuotaPolicySchema = z.object({
  maxConcurrency: z.number().int().positive(),
  maxRequestsPerMinute: z.number().int().positive(),
  maxRequestsPerDay: z.number().int().positive(),
})

export type ProviderQuotaPolicy = z.infer<typeof providerQuotaPolicySchema>

export const PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'local'] as const
export const providerNameSchema = z.enum(PROVIDER_NAMES)
export type ProviderName = z.infer<typeof providerNameSchema>

/** Canonical display labels for each provider */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  claude: 'Claude',
  local: 'Local',
}

/**
 * Normalize a user-supplied string to a valid ProviderName.
 * Accepts any casing (e.g. "Gemini", "OPENAI", "Claude").
 * Returns undefined if the string doesn't match any known provider.
 */
export function parseProviderName(input: string): ProviderName | undefined {
  const lower = input.trim().toLowerCase()
  return PROVIDER_NAMES.includes(lower as ProviderName) ? (lower as ProviderName) : undefined
}

export interface ProviderConfig {
  provider: ProviderName
  apiKey?: string
  baseUrl?: string
  model?: string
  quotaPolicy: ProviderQuotaPolicy
}

export interface LocationContext {
  label: string
  city: string
  region: string
  country: string
  timezone?: string
}

export const locationContextSchema = z.object({
  label: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
  country: z.string().length(2),
  timezone: z.string().optional(),
})

export interface TrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  location?: LocationContext
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
  generateText(prompt: string, config: ProviderConfig): Promise<string>
}
