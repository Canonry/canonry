import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  DEFAULT_MODEL,
  PERPLEXITY_RETRIEVAL_CONTRACT,
  validateConfig as perplexityValidateConfig,
  healthcheck as perplexityHealthcheck,
  executeTrackedQuery as perplexityExecuteTrackedQuery,
  normalizeResult as perplexityNormalizeResult,
  generateText as perplexityGenerateText,
} from './normalize.js'
import type { PerplexityConfig } from './types.js'

function toPerplexityConfig(config: ProviderConfig): PerplexityConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    quotaPolicy: config.quotaPolicy,
  }
}

export const perplexityAdapter: ProviderAdapter = {
  name: 'perplexity',
  displayName: 'Perplexity',
  mode: 'api',
  // normalize.ts sends the location as `user_location` on the web_search tool.
  supportsLocationContext: true,
  keyUrl: 'https://www.perplexity.ai/settings/api',
  // Agent API presets: https://docs.perplexity.ai/docs/agent-api/presets
  // Model slugs (GET https://api.perplexity.ai/v1/models): provider-prefixed, e.g. perplexity/sonar.
  modelRegistry: {
    defaultModel: DEFAULT_MODEL,
    // Presets, `vendor/model` slugs, and the retired Sonar names and previous
    // preset names that PROVIDER_MODEL_ALIASES resolves (`sonar` → `fast`).
    validationPattern: /^(?:fast|low|medium|high|xhigh|fast-search|pro-search|deep-research|advanced-deep-research|sonar(?:-pro|-reasoning|-reasoning-pro|-deep-research)?|[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][\w.:-]*)$/,
    validationHint: 'expected an Agent API preset (fast, low, medium, high, xhigh) or a provider/model slug (e.g. perplexity/sonar)',
    knownModels: [
      { id: 'fast', displayName: 'Fast preset', tier: 'standard' },
      { id: 'low', displayName: 'Low preset (pro search)', tier: 'flagship' },
      { id: 'medium', displayName: 'Medium preset (deep research)', tier: 'flagship' },
      { id: 'perplexity/sonar', displayName: 'Sonar model + web search', tier: 'fast' },
    ],
  },

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    const result = perplexityValidateConfig(toPerplexityConfig(config))
    return {
      ok: result.ok,
      provider: 'perplexity',
      message: result.message,
      model: result.model,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const result = await perplexityHealthcheck(toPerplexityConfig(config))
    return {
      ok: result.ok,
      provider: 'perplexity',
      message: result.message,
      model: result.model,
    }
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await perplexityExecuteTrackedQuery({
      query: input.query,
      canonicalDomains: input.canonicalDomains,
      competitorDomains: input.competitorDomains,
      config: toPerplexityConfig(config),
      location: input.location,
    })
    return {
      provider: 'perplexity',
      rawResponse: raw.rawResponse,
      model: raw.model,
      servedModel: raw.servedModel,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      // Read off the Agent API output: a `search_results` item is the retrieval
      // call. The contract is how we built the request, so it is always known.
      retrievalStatus: raw.retrievalStatus ?? 'unknown',
      retrievalContract: PERPLEXITY_RETRIEVAL_CONTRACT,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    const perplexityRaw = {
      provider: 'perplexity' as const,
      rawResponse: raw.rawResponse,
      model: raw.model,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      retrievalStatus: raw.retrievalStatus,
    }
    const normalized = perplexityNormalizeResult(perplexityRaw)
    return {
      provider: 'perplexity',
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      groundingSources: normalized.groundingSources,
      searchQueries: normalized.searchQueries,
      retrievalStatus: normalized.retrievalStatus,
    }
  },

  async generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return perplexityGenerateText(prompt, toPerplexityConfig(config))
  },
}
