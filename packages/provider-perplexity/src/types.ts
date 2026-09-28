import type {
  ProviderQuotaPolicy,
  ProviderUsage,
  GroundingSource,
  LocationContext,
  RetrievalContract,
  RetrievalStatus,
} from '@ainyc/canonry-contracts'

export type { GroundingSource, RetrievalContract, RetrievalStatus }

export interface PerplexityConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface PerplexityHealthcheckResult {
  ok: boolean
  provider: 'perplexity'
  message: string
  model?: string
}

export interface PerplexityTrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: PerplexityConfig
  location?: LocationContext
}

/**
 * What a configured model id asks the Agent API for: a preset (`fast`, `low`,
 * …) or one `vendor/model` slug (`perplexity/sonar`). The two are separate
 * request fields. `anthropic/*` slugs also carry the `max_output_tokens` the
 * API requires for them.
 */
export type PerplexityAgentSelection =
  | { preset: string }
  | { model: string; max_output_tokens?: number }

/**
 * The `web_search` tool as Canonry sends it. The Agent API rejects unknown
 * fields with a 400, so this carries only the documented ones — note that
 * `user_location` has no `type` or `timezone`, unlike OpenAI's.
 */
export interface PerplexityWebSearchTool {
  type: 'web_search'
  user_location?: { city: string; region: string; country: string }
}

/** Request body for `POST /v1/agent`. */
export type PerplexityAgentRequest = PerplexityAgentSelection & {
  input: string
  tools?: PerplexityWebSearchTool[]
  tool_choice?: { type: 'web_search' }
}

export interface PerplexityRawResult {
  provider: 'perplexity'
  rawResponse: Record<string, unknown>
  /** The resolved preset or model slug that was requested (e.g. `fast`). */
  model: string
  /** Verbatim `model` from the response; undefined when Perplexity disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  retrievalStatus?: RetrievalStatus
  /** Billable tokens and searches from the response's `usage` object; undefined when it had none. */
  usage?: ProviderUsage
  /** `incomplete_details.reason`, else `status`, verbatim; undefined when the response had neither. */
  stopReason?: string
}

export interface PerplexityNormalizedResult {
  provider: 'perplexity'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  retrievalStatus: RetrievalStatus
}
