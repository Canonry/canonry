import {
  CostBases,
  DisclosedModelKinds,
  ProviderWorkflows,
  SourceRelationships,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
  type AnswerServiceProfileCapabilities,
  type DisclosedModelKind,
} from '@canonry/canonry-contracts'

/**
 * cloro sync monitor endpoints (`POST https://api.cloro.dev/v1/monitor/<surface>`),
 * documented in cloro's API reference (`vendorDocsUrl`): the OpenAPI spec,
 * the monitor and per-surface endpoint pages, and the guides `providers`,
 * `error-handling`, `billing` and `authentication`.
 * cloro returns the answer that a logged-out visitor sees on one AI surface.
 * Each profile is one surface and one endpoint; the request is the same for all.
 */

/** cloro requires `country`. It is sent when no usable location is offered and recorded as the service default. */
export const CLORO_DEFAULT_COUNTRY = 'US'

function capabilities(disclosedModelKind: DisclosedModelKind): AnswerServiceProfileCapabilities {
  return {
    groundedAnswer: true,
    textGeneration: false,
    structuredOutput: false,
    evidence: {
      // `citationPills` are the citations shown inline in the answer.
      // `sources` are the pages the surface shows for the answer ("the pages
      // ChatGPT used for the answer", "the citations behind the answer").
      // Neither carries character offsets into `text`.
      relationships: [SourceRelationships['explicit-citation'], SourceRelationships['answer-support']],
      spans: false,
      // No search events are reported; only the returned sources show retrieval.
      retrievalObservability: 'sources',
      // Pill URLs are documented as direct. AI Mode keeps Google's redirect in a separate `redirectLink`.
      directUrls: true,
    },
    // `country` routes the request through a proxy in that country. The
    // surface decides how much the location changes the answer. `state`
    // costs +2 credits and is not sent.
    location: { granularity: 'country', strength: 'hint', serviceDefault: { country: CLORO_DEFAULT_COUNTRY } },
    filters: { includeDomains: 'none', excludeDomains: 'none' },
    // "`prompt`: 1–10,000 characters".
    maxQueryChars: 10_000,
    disclosedModelKind,
    // The response body carries no amount. cloro bills in credits and reports
    // the charge only in the `X-Credits-Charged` header.
    costBasis: CostBases.unknown,
  }
}

function profile(input: { id: string; displayName: string; description: string; disclosedModelKind?: DisclosedModelKind }): AnswerServiceProfile {
  return {
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    product: `monitor/${input.id}`,
    execution: 'sync',
    transport: 'json',
    // cloro asks for a client timeout of at least 5 minutes: it starts no new
    // attempt after 5 minutes, but an attempt that is running can still
    // finish and be charged. One more minute is kept as headroom.
    timeoutMs: 360_000,
    // The request names no model; the surface chooses it.
    requestedServiceModel: null,
    settings: {},
    requestPolicyVersion: 'cloro-monitor-v1',
    capabilities: capabilities(input.disclosedModelKind ?? DisclosedModelKinds.unknown),
    workflows: [ProviderWorkflows.research, ProviderWorkflows.snapshot, ProviderWorkflows['visibility-sweep']],
  }
}

export const cloroDescriptor: AnswerServiceDescriptor = {
  id: 'cloro',
  displayName: 'cloro',
  keyUrl: 'https://dashboard.cloro.dev/api-keys?utm_source=canonry&utm_medium=byok',
  vendorDocsUrl: 'https://cloro.dev/docs/api-reference/introduction?utm_source=canonry&utm_medium=byok',
  docsPath: 'docs/providers/answer-services/cloro.md',
  auth: { scheme: 'bearer' },
  baseUrl: 'https://api.cloro.dev',
  settings: {
    fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'CLORO_API_KEY', label: 'API key' }],
    allowBaseUrl: false,
    allowModel: false,
    // cloro documents a free `GET /v1/credits`, but Canonry does not run key
    // checks when a key is saved, so a saved key stays "not verified".
    keyCheck: null,
  },
  // The Free plan allows 1 concurrent request; a second one gets a 429.
  defaultQuota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
  // cloro charges only for a 200, so an error is never billed. 429 and 503
  // are rejections to retry after a wait. A 500 comes after cloro has
  // already retried up to 5 attempts, so it is not retried again.
  retry: { statuses: [429, 503] },
  parserVersion: 'cloro-monitor-1',
  profiles: [
    profile({ id: 'chatgpt', displayName: 'ChatGPT', description: 'The ChatGPT answer a logged-out visitor sees, with web search.', disclosedModelKind: DisclosedModelKinds['foundation-model'] }),
    profile({ id: 'gemini', displayName: 'Gemini', description: 'The Gemini answer a logged-out visitor sees.' }),
    profile({ id: 'aimode', displayName: 'Google AI Mode', description: 'The Google AI Mode answer a logged-out visitor sees.' }),
  ],
}
