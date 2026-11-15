import {
  CostBases,
  DisclosedModelKinds,
  ProviderWorkflows,
  SourceRelationships,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
  type AnswerServiceProfileCapabilities,
} from '@canonry/canonry-contracts'

/**
 * GoAnyAPI Google AI Overview (`POST https://api.goanyapi.com/api/v1/google-ai-overview`),
 * documented at https://goanyapi.com/docs/google-ai-overview-api. One synchronous
 * request per query: Google's AI Overview as Google actually showed it for that
 * query, with the pages Google listed as its sources. Canonry never simulates
 * this surface with a text model, so it complements the LLM answer engines.
 */

const CAPABILITIES: AnswerServiceProfileCapabilities = {
  groundedAnswer: true,
  textGeneration: false,
  // The response carries a fixed JSON shape; there is no structured-output knob.
  structuredOutput: false,
  evidence: {
    // `results[].links[]` are the pages Google lists with the AI Overview it
    // wrote from them. They carry no markers or spans in the overview text.
    relationships: [SourceRelationships['answer-support']],
    spans: false,
    // No search events are reported; only the returned links show retrieval.
    retrievalObservability: 'sources',
    // Links point at the cited pages themselves, not redirects.
    directUrls: true,
  },
  // `country` takes a two-letter code that localizes the underlying Google
  // search; city and region have no field, and coordinates are not sent.
  location: { granularity: 'country', strength: 'hint' },
  filters: { includeDomains: 'none', excludeDomains: 'none' },
  // GoAnyAPI caps `query` at 8192 UTF-8 *bytes*. Canonry counts characters, so
  // a query heavy in multi-byte characters can still exceed the byte cap and
  // come back as an unbilled 400; the vendor page documents that rejection.
  maxQueryChars: 8192,
  // The response names no model; Google does not disclose which one wrote the overview.
  disclosedModelKind: DisclosedModelKinds.unknown,
  // Every successful response reports the credits it charged (`costCredits`),
  // including queries where Google showed no AI Overview.
  costBasis: CostBases.reported,
}

function profile(): AnswerServiceProfile {
  return {
    id: 'ai-overview',
    displayName: 'Google AI Overview',
    description: "Google AI Overviews as Google actually showed them, with Google's own cited pages.",
    product: 'google-ai-overview',
    execution: 'sync',
    transport: 'json',
    timeoutMs: 120_000,
    // The request names no model.
    requestedServiceModel: null,
    // Sent verbatim as the request body next to the query (see request.ts).
    settings: { output: 'json' },
    requestPolicyVersion: 'goanyapi-ai-overview-v1',
    capabilities: CAPABILITIES,
    workflows: [ProviderWorkflows.research, ProviderWorkflows.snapshot, ProviderWorkflows['visibility-sweep']],
  }
}

export const goanyapiDescriptor: AnswerServiceDescriptor = {
  id: 'goanyapi',
  displayName: 'GoAnyAPI',
  // Keys are issued after sign-up on goanyapi.com; the site has no dedicated keys page.
  keyUrl: 'https://goanyapi.com',
  vendorDocsUrl: 'https://goanyapi.com/docs/google-ai-overview-api',
  docsPath: 'docs/providers/answer-services/goanyapi.md',
  auth: { scheme: 'bearer' },
  baseUrl: 'https://api.goanyapi.com',
  settings: {
    fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'GOANYAPI_API_KEY', label: 'API key' }],
    allowBaseUrl: false,
    allowModel: false,
    // `GET /api/v1/credits/balance` is documented as free and proves the key.
    keyCheck: { method: 'GET', path: '/api/v1/credits/balance' },
  },
  // The same limits Canonry applies to any provider without its own.
  defaultQuota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
  // GoAnyAPI documents that validation, authentication and operational failures
  // are never billed, so all of these are safe to retry: 429 rate limited,
  // 502 request_failed, 503 service_not_configured, 504 request_timeout.
  // 400, 401 and 402 need a fix first.
  retry: { statuses: [429, 502, 503, 504] },
  parserVersion: 'goanyapi-ai-overview-1',
  profiles: [profile()],
}
