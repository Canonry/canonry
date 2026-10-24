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
 * Exa Answer (`POST https://api.exa.ai/answer`), documented at
 * https://exa.ai/docs/reference/answer and https://exa.ai/docs/reference/error-codes.
 * One profile per documented `model` value; nothing else in the request varies.
 */

const CAPABILITIES: AnswerServiceProfileCapabilities = {
  groundedAnswer: true,
  textGeneration: false,
  // Exa documents `outputSchema`, but these profiles never send one and the
  // parser refuses a structured answer rather than inventing text from it.
  structuredOutput: false,
  evidence: {
    // `citations` are documented as "search results used to generate the
    // answer", with no markers or spans in the text.
    relationships: [SourceRelationships['answer-support']],
    spans: false,
    // No search events are reported; only the returned citations show retrieval.
    retrievalObservability: 'sources',
    directUrls: true,
  },
  // `userLocation` takes a two-letter country that "localizes results"; city
  // and region have no field, and coordinates are not sent.
  location: { granularity: 'country', strength: 'hint' },
  filters: { includeDomains: 'none', excludeDomains: 'none' },
  // The schema sets only a minimum length for `query`.
  maxQueryChars: null,
  // The response has no model field.
  disclosedModelKind: DisclosedModelKinds.unknown,
  // `costDollars` is documented as an estimate, not an invoice.
  costBasis: CostBases.estimated,
}

function profile(input: { id: string; displayName: string; model: string; timeoutMs: number; description: string }): AnswerServiceProfile {
  return {
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    product: 'answer',
    execution: 'sync',
    transport: 'json',
    timeoutMs: input.timeoutMs,
    requestedServiceModel: input.model,
    // Sent verbatim as the request body next to the query (see request.ts).
    settings: { model: input.model, stream: false, text: false },
    requestPolicyVersion: 'exa-answer-v1',
    capabilities: CAPABILITIES,
    workflows: [ProviderWorkflows.research, ProviderWorkflows.snapshot, ProviderWorkflows['visibility-sweep']],
  }
}

export const exaDescriptor: AnswerServiceDescriptor = {
  id: 'exa',
  displayName: 'Exa',
  keyUrl: 'https://dashboard.exa.ai/api-keys',
  vendorDocsUrl: 'https://exa.ai/docs/reference/answer',
  docsPath: 'docs/providers/answer-services/exa.md',
  auth: { scheme: 'header', header: 'x-api-key' },
  baseUrl: 'https://api.exa.ai',
  settings: {
    fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'EXA_API_KEY', label: 'API key' }],
    allowBaseUrl: false,
    allowModel: false,
    // Exa documents no free request that proves a key, so a saved key stays "not verified".
    keyCheck: null,
  },
  // The same limits Canonry applies to any provider without its own.
  defaultQuota: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
  // 429 is a rejection and 503 is documented as "not processed, not billed".
  // 500 and 504 are not retried: Exa does not say they were unbilled.
  retry: { statuses: [429, 503] },
  parserVersion: 'exa-answer-1',
  profiles: [
    profile({ id: 'fast', displayName: 'Fast', model: 'exa-fast', timeoutMs: 60_000, description: 'Exa Answer with the exa-fast model.' }),
    profile({ id: 'standard', displayName: 'Standard', model: 'exa', timeoutMs: 120_000, description: 'Exa Answer with the default exa model.' }),
    profile({ id: 'pro', displayName: 'Pro', model: 'exa-pro', timeoutMs: 180_000, description: 'Exa Answer with the exa-pro model.' }),
    profile({ id: 'research', displayName: 'Research', model: 'exa-research', timeoutMs: 300_000, description: 'Exa Answer with the exa-research model. Waits up to five minutes per query.' }),
  ],
}
