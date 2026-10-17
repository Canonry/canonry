import type {
  LocationContext,
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@canonry/canonry-contracts'

/**
 * One provider call, recorded verbatim. Tests assert on these rather than on
 * counts so a wrong location or a duplicated query is visible, not averaged
 * away.
 */
export interface RecordedCall {
  provider: string
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  location: LocationContext | null
  /** The model the runner asked this call to use. */
  model: string | undefined
}

export interface FakeAdapterOptions {
  name: string
  calls: RecordedCall[]
  /** Declare the honest geo capability under test. Defaults to true. */
  supportsLocationContext?: boolean
  /** Throw on every call at or after this 1-based call number. */
  failFromCall?: number
  answerText?: string
}

export function fakeAdapter(options: FakeAdapterOptions): ProviderAdapter {
  const name = options.name
  let seen = 0
  return {
    name,
    displayName: name,
    mode: 'api',
    supportsLocationContext: options.supportsLocationContext ?? true,
    modelRegistry: {
      defaultModel: 'fake-model',
      validationPattern: /./,
      validationHint: 'any',
      knownModels: [],
    },
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: name, message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: name, message: 'ok' }
    },
    async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
      seen += 1
      options.calls.push({
        provider: name,
        query: input.query,
        canonicalDomains: [...input.canonicalDomains],
        competitorDomains: [...input.competitorDomains],
        location: input.location ? { ...input.location } : null,
        model: config.model,
      })
      if (options.failFromCall !== undefined && seen >= options.failFromCall) {
        throw new Error(`fake provider ${name} failed on call ${seen}`)
      }
      return {
        provider: name,
        rawResponse: {},
        // Echo what was requested, the way a real adapter reports the model it
        // built the request with.
        model: config.model ?? 'fake-model',
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: 'used',
        retrievalContract: 'search-required-v1',
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: name,
        answerText: options.answerText ?? 'fake answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: 'used',
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'fake'
    },
  }
}
