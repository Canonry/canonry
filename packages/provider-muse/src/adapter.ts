import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { listModels } from './list-models.js'
import {
  executeTrackedQuery,
  generateText,
  healthcheck,
  normalizeResult,
  validateConfig,
} from './normalize.js'
import type { MuseConfig } from './types.js'

export function toMuseConfig(config: ProviderConfig): MuseConfig {
  return {
    apiKey: config.apiKey ?? '',
    model: config.model,
    baseUrl: config.baseUrl,
    quotaPolicy: config.quotaPolicy,
  }
}

export const museAdapter: ProviderAdapter = {
  name: 'muse',
  displayName: 'Muse',
  mode: 'api',
  supportsLocationContext: true,
  keyUrl: 'https://dev.meta.ai/',
  modelRegistry: {
    defaultModel: 'muse-spark-1.3',
    validationPattern: /^muse-spark-[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    validationHint: 'a Muse Spark text model (e.g. muse-spark-1.3)',
    knownModels: [
      { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', tier: 'standard' },
      { id: 'muse-spark-1.2', displayName: 'Muse Spark 1.2', tier: 'standard' },
      { id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1', tier: 'standard' },
    ],
  },
  listModels,
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    return validateConfig(toMuseConfig(config))
  },
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    return healthcheck(toMuseConfig(config))
  },
  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const raw = await executeTrackedQuery({ ...input, config: toMuseConfig(config) })
    return { ...raw, retrievalContract: 'native-auto-v1' }
  },
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    return normalizeResult({
      provider: 'muse',
      rawResponse: raw.rawResponse,
      model: raw.model,
      servedModel: raw.servedModel,
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      retrievalStatus: raw.retrievalStatus,
    })
  },
  generateText(prompt: string, config: ProviderConfig): Promise<string> {
    return generateText(prompt, toMuseConfig(config))
  },
}
