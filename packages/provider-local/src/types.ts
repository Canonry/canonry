import type { ProviderQuotaPolicy, ProviderUsage, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

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
  /** Tokens from the response's `usage` object; undefined when the runtime reported none. */
  usage?: ProviderUsage
  /** `choices[0].finish_reason` verbatim; undefined when the response had none. */
  stopReason?: string
}

export interface LocalNormalizedResult {
  provider: 'local'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}
