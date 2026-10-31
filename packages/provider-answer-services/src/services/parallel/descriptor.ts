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
 * Parallel Responses (`POST https://api.parallel.ai/v1/responses`), documented at
 * https://docs.parallel.ai/responses-api/responses-quickstart,
 * https://docs.parallel.ai/api-reference/responses-api/create-response,
 * https://docs.parallel.ai/responses-api/features/web-search-tool,
 * https://docs.parallel.ai/responses-api/features/citations and
 * https://docs.parallel.ai/responses-api/openai-compatibility.
 * There is one model, `parallel`; `reasoning.effort` selects how much research
 * runs, so each documented effort is one profile and nothing else varies.
 */

/** The frozen setting that carries the effort, named after the request field it fills. */
export const PARALLEL_EFFORT_SETTING = 'reasoning.effort'

const CAPABILITIES: AnswerServiceProfileCapabilities = {
  groundedAnswer: true,
  textGeneration: false,
  // Parallel documents structured output through `text.format`, but these
  // profiles never send one and measure the answer text only.
  structuredOutput: false,
  evidence: {
    // `url_citation` annotations mark the span of answer text each source
    // supports; `web_search_call` items with `open_page` are pages it read.
    // `action.sources` on searches is documented as always null, so no
    // search results are returned.
    relationships: [SourceRelationships['explicit-citation'], SourceRelationships['page-read']],
    spans: true,
    // "Every response reports the searches the model ran and the pages it
    // read as web_search_call output items", and a run that does neither
    // returns none.
    retrievalObservability: 'events',
    directUrls: true,
  },
  // The request has no location field; the web_search tool's `user_location`
  // is documented as accepted and ignored, so nothing is sent.
  location: { granularity: 'none', strength: null },
  // Domain filters exist on the web_search tool, but these profiles send no tools.
  filters: { includeDomains: 'none', excludeDomains: 'none' },
  // "`input` and `instructions` together may total at most 20,000 characters";
  // no instructions are sent, so the query may use all of it.
  maxQueryChars: 20_000,
  // The response `model` is always `parallel`: the service name, not a model.
  disclosedModelKind: DisclosedModelKinds['service-tier'],
  // The response carries no amount; Parallel bills per successful request.
  costBasis: CostBases.unknown,
}

function profile(input: { effort: 'low' | 'medium' | 'high'; displayName: string; timeoutMs: number; description: string }): AnswerServiceProfile {
  return {
    id: input.effort,
    displayName: input.displayName,
    description: input.description,
    product: 'responses',
    execution: 'sync',
    transport: 'json',
    timeoutMs: input.timeoutMs,
    requestedServiceModel: 'parallel',
    // Sent as `model`, `reasoning.effort` and `stream` (see request.ts).
    settings: { model: 'parallel', [PARALLEL_EFFORT_SETTING]: input.effort, stream: false },
    requestPolicyVersion: 'parallel-responses-v1',
    capabilities: CAPABILITIES,
    workflows: [ProviderWorkflows.research, ProviderWorkflows.snapshot, ProviderWorkflows['visibility-sweep']],
  }
}

export const parallelDescriptor: AnswerServiceDescriptor = {
  id: 'parallel',
  displayName: 'Parallel',
  keyUrl: 'https://platform.parallel.ai',
  vendorDocsUrl: 'https://docs.parallel.ai/responses-api/responses-quickstart',
  docsPath: 'docs/providers/answer-services/parallel.md',
  // Every Responses example sends `Authorization: Bearer`, the OpenAI-compatible
  // form. The OpenAPI spec also names an `x-api-key` header for the same key.
  auth: { scheme: 'bearer' },
  baseUrl: 'https://api.parallel.ai',
  settings: {
    fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'PARALLEL_API_KEY', label: 'API key' }],
    allowBaseUrl: false,
    allowModel: false,
    // Parallel documents no free request that proves a key, so a saved key stays "not verified".
    keyCheck: null,
  },
  // Parallel publishes no Responses rate limit; these are Canonry's defaults for any provider.
  defaultQuota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
  // The Responses pages say to back off and retry a 429 only. The general
  // error table that also lists 500, 502 and 503 describes the Task API.
  retry: { statuses: [429] },
  parserVersion: 'parallel-responses-1',
  // Deadlines leave headroom over the documented latency (about 5 to 10, 15
  // to 20 and 30 to 60 seconds), because a request Canonry abandons may still
  // finish upstream and be charged.
  profiles: [
    profile({ effort: 'low', displayName: 'Low effort', timeoutMs: 60_000, description: 'Parallel Responses with low reasoning effort, for simple fact questions.' }),
    profile({ effort: 'medium', displayName: 'Medium effort', timeoutMs: 120_000, description: 'Parallel Responses with medium reasoning effort (Parallel\'s default), for questions that need several searches.' }),
    profile({ effort: 'high', displayName: 'High effort', timeoutMs: 180_000, description: 'Parallel Responses with high reasoning effort, for deep research. Waits up to three minutes per query.' }),
  ],
}
