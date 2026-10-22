/**
 * Exa Answer fixtures. Documentation-derived, not captured: every body follows
 * the `AnswerResponse` and `ErrorResponse` schemas of `POST /answer` in Exa's
 * OpenAPI spec (https://exa.ai/docs/exa-spec.yaml), as presented at
 * https://exa.ai/docs/reference/answer, with error tags and retry guidance
 * from https://exa.ai/docs/reference/error-codes (all read October 17, 2026).
 * No request was sent to Exa. Domains, ids and amounts are invented examples.
 *
 * Documented 200 body: `requestId` (string), `answer` (string, or an object
 * when `outputSchema` was sent), `citations[]` (`title` and `url` required;
 * `publishedDate`, `author` (nullable), `id`, `image`, `favicon`, and `text`
 * only when text was requested) and `costDollars` (`total`, `search.neural`,
 * `search.keyword`, `summary`, `contents.text|highlights|summary`, all
 * optional). Documented headers: `x-request-id`, `x-exa-queued`,
 * `x-exa-queue-ms`. Error body: `{ requestId, error, tag }`.
 */
import { SAMPLE_LOCATION, type ConformanceFixtures, type ConformanceResponse } from '../../conformance.js'

const SOURCE = 'Documentation-derived from https://exa.ai/docs/reference/answer (AnswerResponse and ErrorResponse in https://exa.ai/docs/exa-spec.yaml) and https://exa.ai/docs/reference/error-codes; not captured from a live response.'

export const EXA_REQUEST_ID = '9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e'

export const EXA_ANSWER_TEXT = 'Acme Roofing is a well reviewed roofing contractor in Springfield, known for repairs and full replacements. Other options include Summit Roof Co.'

/** Every documented header on a 200 response; the parser reads only `x-request-id`. */
export const EXA_SUCCESS_HEADERS: Readonly<Record<string, string>> = {
  'x-request-id': EXA_REQUEST_ID,
  'x-exa-queued': 'false',
  'x-exa-queue-ms': '0',
}

/** Three citations carrying every documented field except `text`, which appears only when text was requested. */
export function exaCitations(): Array<Record<string, unknown>> {
  return [
    {
      title: 'Roof repair and replacement services',
      url: 'https://www.acme-roofing.example/services',
      publishedDate: '2026-08-21T00:00:00.000Z',
      author: 'Acme Roofing',
      id: 'https://www.acme-roofing.example/services',
      image: 'https://www.acme-roofing.example/images/crew.jpg',
      favicon: 'https://www.acme-roofing.example/favicon.ico',
    },
    {
      title: 'Best roofers in Springfield',
      url: 'https://roofing-reviews.example/springfield/best-roofers',
      publishedDate: '2026-07-02T00:00:00.000Z',
      author: null,
      id: 'https://roofing-reviews.example/springfield/best-roofers',
      image: 'https://roofing-reviews.example/og/best-roofers.png',
      favicon: 'https://roofing-reviews.example/favicon.ico',
    },
    {
      title: 'Summit Roof Co. projects',
      url: 'https://summit-roof.example/projects',
      publishedDate: '2026-05-14T00:00:00.000Z',
      author: 'Summit Roof Co.',
      id: 'https://summit-roof.example/projects',
      image: 'https://summit-roof.example/images/project.jpg',
      favicon: 'https://summit-roof.example/favicon.png',
    },
  ]
}

/** The full `costDollars` object. Exa says which fields appear depends on the endpoint. */
export function exaCostDollars(): Record<string, unknown> {
  return {
    total: 0.005,
    search: { neural: 0.005, keyword: 0 },
    summary: 0,
    contents: { text: 0, highlights: 0, summary: 0 },
  }
}

/** A complete text answer with citations and an estimated cost. */
export function exaAnswerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: EXA_REQUEST_ID,
    answer: EXA_ANSWER_TEXT,
    citations: exaCitations(),
    costDollars: exaCostDollars(),
    ...overrides,
  }
}

/** The documented error body. */
export function exaErrorBody(error: string, tag: string): Record<string, unknown> {
  return { requestId: EXA_REQUEST_ID, error, tag }
}

export function exaError(status: number, error: string, tag: string, headers: Record<string, string> = {}): ConformanceResponse {
  return { status, headers: { 'x-request-id': EXA_REQUEST_ID, ...headers }, json: exaErrorBody(error, tag) }
}

const COMPLETE: ConformanceResponse = { headers: { ...EXA_SUCCESS_HEADERS }, json: exaAnswerBody() }

/** A structured `answer` (the shape returned when `outputSchema` is sent). Canonry never sends one. */
export const EXA_STRUCTURED_ANSWER: ConformanceResponse = {
  headers: { ...EXA_SUCCESS_HEADERS },
  json: exaAnswerBody({ answer: { company: 'Acme Roofing', city: 'Springfield', services: ['repair', 'replacement'] } }),
}

const OVERLOADED = exaError(503, 'Service is over capacity. Please retry.', 'SERVICE_OVERLOADED')

export const EXA_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  service: 'exa',
  cases: {
    // Citations without markers or spans: answer support, counted as cited.
    'sources-not-cited': {
      source: SOURCE,
      profile: 'standard',
      responses: [COMPLETE],
      expect: {
        outcome: 'complete',
        answerText: EXA_ANSWER_TEXT,
        citedDomains: ['acme-roofing.example', 'roofing-reviews.example', 'summit-roof.example'],
        relationships: { 'answer-support': 3 },
        retrievalStatus: 'used',
        disclosedModel: null,
        costBasis: 'estimated',
        requests: 1,
      },
    },
    // No citations: still complete, and retrieval stays unknown rather than "not used".
    'empty-sources': {
      source: SOURCE,
      profile: 'fast',
      responses: [{ headers: { ...EXA_SUCCESS_HEADERS }, json: exaAnswerBody({ citations: [] }) }],
      expect: { outcome: 'complete', citedDomains: [], relationships: {}, retrievalStatus: 'unknown', costBasis: 'estimated' },
    },
    // A structured answer cannot be measured as text: failed, never stored.
    failed: {
      source: SOURCE,
      profile: 'standard',
      responses: [EXA_STRUCTURED_ANSWER],
      expect: { outcome: 'failed', requests: 1 },
    },
    // The response never names a model. Without `costDollars` and a body
    // `requestId` (both optional), cost is unknown, never zero.
    'unknown-model': {
      source: SOURCE,
      profile: 'pro',
      responses: [{ headers: { ...EXA_SUCCESS_HEADERS }, json: { answer: EXA_ANSWER_TEXT, citations: exaCitations() } }],
      expect: { outcome: 'complete', disclosedModel: null, costBasis: 'unknown' },
    },
    // A city context reaches Exa only as its country.
    'unsupported-location': {
      source: SOURCE,
      profile: 'standard',
      location: SAMPLE_LOCATION,
      responses: [COMPLETE],
      expect: { outcome: 'complete', locationStatus: 'partial' },
    },
    'http-401': {
      source: SOURCE,
      profile: 'standard',
      responses: [exaError(401, 'Invalid API key', 'INVALID_API_KEY'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 401, requests: 1 },
    },
    'http-403': {
      source: SOURCE,
      profile: 'research',
      responses: [exaError(403, 'This feature is not enabled for your plan', 'FEATURE_DISABLED'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 403, requests: 1 },
    },
    // Retry-After is honoured, then the answer is read.
    'http-429': {
      source: SOURCE,
      profile: 'standard',
      responses: [exaError(429, 'Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', { 'retry-after': '0' }), COMPLETE],
      expect: { outcome: 'complete', requests: 2 },
    },
    // 503 is documented as not processed: retried twice, then surfaced.
    'http-5xx': {
      source: SOURCE,
      profile: 'standard',
      responses: [OVERLOADED],
      expect: { outcome: 'http-error', httpStatus: 503, requests: 3 },
    },
  },
  notApplicable: {
    'explicit-citations': 'Exa documents citations as the search results used to generate the answer, with no markers or spans in the answer text, so they are answer support and never explicit citations.',
    partial: 'Exa documents no partial or incomplete state for a non-streamed /answer response: a 200 carries the whole answer and errors use HTTP statuses. These profiles never stream.',
    pending: 'Exa /answer is synchronous and returns no job handle.',
    'long-query': 'Exa documents no maximum query length for /answer (the schema only requires at least one character), so no query is refused before the request.',
  },
}
