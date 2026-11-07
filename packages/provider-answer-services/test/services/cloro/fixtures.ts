/**
 * cloro monitor fixtures. Documentation-derived, not captured: every body
 * follows the `ChatGPTMonitorResponse`, `GeminiMonitorResponse`,
 * `AiModeMonitorResponse` and error schemas of cloro's OpenAPI spec (`api-reference/openapi.json`),
 * with the examples on the per-surface `sources` and `citation-pills` pages,
 * the 200 headers of the spec, and the error envelope and codes of the
 * `error-handling` guide (all read November 4, 2026). Domains, ids and texts
 * are invented examples. The shapes were then checked against ChatGPT, Gemini
 * and AI Mode responses and a 401 captured from cloro on November 5, 2026;
 * no captured content is copied here. Those responses showed two shapes the
 * docs do not: ChatGPT's `model` is `null` (not empty) and `citationPills` is
 * `[]` (not omitted) when its answer has no pills, with every source marked
 * `footnote: true`.
 *
 * Documented 200 body: `success` and `result`. `result.text` is the answer;
 * `result.sources[]` carry `position`, `url`, `label`, `description` (ChatGPT
 * adds `footnote` and an optional `datePublished`); `result.citationPills[]`
 * carry `label`, `citationPillId` (0-based on ChatGPT, 1-based elsewhere),
 * `url`, `domain`, `position` and an optional `description` (ChatGPT adds
 * `type` and an optional `datePublished`) and are omitted when the answer has
 * none. ChatGPT adds `model`, `entities` and `followUpForm`. Fields
 * that need an `include` flag are absent, because Canonry sends none.
 * Error body: `{ success: false, error: { code, message, details?, timestamp } }`.
 */
import { SAMPLE_LOCATION, type ConformanceFixtures, type ConformanceResponse } from '../../conformance.js'

const SOURCE = 'Documentation-derived from cloro\'s OpenAPI spec (api-reference/openapi.json, POST /v1/monitor/*) and the per-surface sources and citation-pills pages, with field presence checked against live responses of November 5, 2026; content invented, not captured.'
const ERROR_SOURCE = 'Documentation-derived from cloro\'s OpenAPI spec error schemas and the error-handling guide, checked against a live 401 of November 5, 2026; content invented, not captured.'

export const CLORO_REQUEST_ID = 'req_7f3c9a2e5b1d4c8a'
const TIMESTAMP = '2026-11-04T12:00:00.000Z'

export const ACME_URL = 'https://www.acme-roofing.example/services'
export const REVIEWS_URL = 'https://roofing-reviews.example/springfield/best-roofers'
export const SUMMIT_URL = 'https://summit-roof.example/projects'

export const CLORO_ANSWER_TEXT = 'Acme Roofing is a well reviewed roofing contractor in Springfield, known for repairs and full replacements. Other options include Summit Roof Co.'

/** Every documented header on a 200 response; the shared layer reads only `X-Request-ID`. */
export function cloroSuccessHeaders(creditsCharged = 7): Record<string, string> {
  return {
    'X-Request-ID': CLORO_REQUEST_ID,
    'X-Credits-Charged': String(creditsCharged),
    'X-Credits-Remaining': '493',
    'X-Concurrency-Limit': '1',
    'X-Concurrency-Current': '1',
    'X-Concurrency-Remaining': '0',
    'X-RateLimit-Limit': '10',
    'X-RateLimit-Remaining': '9',
    'X-Latency-Ms': '18450',
  }
}

/** The common sources structure: `position`, `url`, `label` and `description`. */
export function cloroSources(): Array<Record<string, unknown>> {
  return [
    { position: 1, url: ACME_URL, label: 'Roof repair and replacement services', description: 'Acme Roofing repairs and replaces roofs in Springfield.' },
    { position: 2, url: REVIEWS_URL, label: 'Best roofers in Springfield', description: 'Reviews of roofing contractors in Springfield.' },
  ]
}

/** ChatGPT sources: cited pages first (`footnote: false`), then a page used but not cited. */
export function chatgptSources(): Array<Record<string, unknown>> {
  return [
    { position: 1, url: ACME_URL, label: 'Roof repair and replacement services', description: 'Acme Roofing repairs and replaces roofs in Springfield.', footnote: false, datePublished: 'August 21, 2026' },
    { position: 2, url: REVIEWS_URL, label: 'Best roofers in Springfield', description: 'Reviews of roofing contractors in Springfield.', footnote: false },
    { position: 3, url: SUMMIT_URL, label: 'Summit Roof Co. projects', description: 'Recent projects by Summit Roof Co.', footnote: true },
  ]
}

/** ChatGPT pills: one entry per (pill, source) pair, ids from 0. Acme is cited by two pills. */
export function chatgptCitationPills(): Array<Record<string, unknown>> {
  return [
    { label: 'Roof repair and replacement services', citationPillId: 0, url: ACME_URL, domain: 'acme-roofing.example', description: 'Acme Roofing repairs and replaces roofs in Springfield.', position: 1, type: 'searchResult', datePublished: '2026-08-21' },
    { label: '', citationPillId: 1, url: REVIEWS_URL, domain: 'roofing-reviews.example', position: 2, type: 'groupedWebpage' },
    { label: 'Roof repair and replacement services', citationPillId: 2, url: ACME_URL, domain: 'acme-roofing.example', description: 'Acme Roofing repairs and replaces roofs in Springfield.', position: 1, type: 'searchResult', datePublished: '2026-08-21' },
  ]
}

/** Pills on Gemini and AI Mode: ids from 1, no `type`. One pill cites two sources. */
export function cloroCitationPills(): Array<Record<string, unknown>> {
  return [
    { label: 'Roof repair and replacement services', citationPillId: 1, url: ACME_URL, domain: 'acme-roofing.example', description: 'Acme Roofing repairs and replaces roofs in Springfield.', position: 1 },
    { label: 'Best roofers in Springfield', citationPillId: 1, url: REVIEWS_URL, domain: 'roofing-reviews.example', position: 2 },
  ]
}

export function chatgptBody(result: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    result: {
      text: CLORO_ANSWER_TEXT,
      sources: chatgptSources(),
      model: 'gpt-5-3',
      entities: [{ type: 'organization', name: 'Acme Roofing' }],
      citationPills: chatgptCitationPills(),
      followUpForm: null,
      ...result,
    },
  }
}

export function geminiBody(result: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: true, result: { text: CLORO_ANSWER_TEXT, sources: cloroSources(), citationPills: cloroCitationPills(), ...result } }
}

export function aimodeBody(result: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    result: {
      text: CLORO_ANSWER_TEXT,
      sources: [
        ...cloroSources(),
        { position: 3, url: SUMMIT_URL, label: 'Summit Roof Co. projects', description: 'Recent projects by Summit Roof Co.', redirectLink: 'https://www.google.com/goto?url=summit' },
      ],
      citationPills: cloroCitationPills(),
      ...result,
    },
  }
}

/** The documented error envelope. */
export function cloroError(status: number, code: string, message: string, extra: { details?: unknown; headers?: Record<string, string> } = {}): ConformanceResponse {
  return {
    status,
    headers: { 'X-Request-ID': CLORO_REQUEST_ID, ...extra.headers },
    json: { success: false, error: { code, message, ...(extra.details === undefined ? {} : { details: extra.details }), timestamp: TIMESTAMP } },
  }
}

const COMPLETE: ConformanceResponse = { headers: cloroSuccessHeaders(7), json: chatgptBody() }

export const CLORO_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  service: 'cloro',
  cases: {
    // Pills are explicit citations; the sources rail is answer support. Both feed cited domains.
    'explicit-citations': {
      source: SOURCE,
      profile: 'chatgpt',
      responses: [COMPLETE],
      expect: {
        outcome: 'complete',
        answerText: CLORO_ANSWER_TEXT,
        citedDomains: ['acme-roofing.example', 'roofing-reviews.example', 'summit-roof.example'],
        relationships: { 'explicit-citation': 2, 'answer-support': 3 },
        retrievalStatus: 'used',
        disclosedModel: 'gpt-5-3',
        costBasis: 'unknown',
        requests: 1,
      },
    },
    // The ChatGPT shape seen live: no pills (`[]`), every source `footnote: true`,
    // `model: null`. The sources are kept as answer support, and no model is recorded.
    'sources-not-cited': {
      source: SOURCE,
      profile: 'chatgpt',
      responses: [{
        headers: cloroSuccessHeaders(7),
        json: chatgptBody({ model: null, citationPills: [], map: [], sources: chatgptSources().map(source => ({ ...source, footnote: true })) }),
      }],
      expect: {
        outcome: 'complete',
        citedDomains: ['acme-roofing.example', 'roofing-reviews.example', 'summit-roof.example'],
        relationships: { 'answer-support': 3 },
        retrievalStatus: 'used',
        disclosedModel: null,
      },
    },
    // "Returns empty array when no sources are available": complete, retrieval unknown.
    'empty-sources': {
      source: SOURCE,
      profile: 'aimode',
      responses: [{ headers: cloroSuccessHeaders(6), json: aimodeBody({ sources: [], citationPills: undefined }) }],
      expect: { outcome: 'complete', citedDomains: [], relationships: {}, retrievalStatus: 'unknown' },
    },
    // `result.text` is not marked required; a result without it is a failed query, never an empty answer.
    failed: {
      source: SOURCE,
      profile: 'aimode',
      responses: [{ headers: cloroSuccessHeaders(6), json: { success: true, result: { sources: cloroSources() } } }],
      expect: { outcome: 'failed', requests: 1 },
    },
    // Only ChatGPT names a model; Gemini's response has no model field.
    'unknown-model': {
      source: SOURCE,
      profile: 'gemini',
      responses: [{ headers: cloroSuccessHeaders(6), json: geminiBody() }],
      expect: { outcome: 'complete', disclosedModel: null, costBasis: 'unknown' },
    },
    // "`prompt`: 1–10,000 characters"; one more is refused before any request.
    'long-query': {
      source: SOURCE,
      profile: 'chatgpt',
      query: 'best roofing contractor in springfield '.repeat(300).slice(0, 10_001),
      responses: [COMPLETE],
      expect: { outcome: 'refused-before-request', requests: 0 },
    },
    // A city context reaches cloro only as its country.
    'unsupported-location': {
      source: SOURCE,
      profile: 'chatgpt',
      location: SAMPLE_LOCATION,
      responses: [COMPLETE],
      expect: { outcome: 'complete', locationStatus: 'partial', sentLocation: { country: 'US' } },
    },
    'http-401': {
      source: ERROR_SOURCE,
      profile: 'chatgpt',
      responses: [cloroError(401, 'INVALID_OR_EXPIRED_API_KEY', 'Invalid or expired API key'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 401, requests: 1 },
    },
    // "`INSUFFICIENT_CREDITS` is the only `403` an API key gets."
    'http-403': {
      source: ERROR_SOURCE,
      profile: 'gemini',
      responses: [cloroError(403, 'INSUFFICIENT_CREDITS', 'Insufficient credits'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 403, requests: 1 },
    },
    // "No `429` sends `Retry-After`": the shared backoff applies, then the answer is read.
    'http-429': {
      source: ERROR_SOURCE,
      profile: 'chatgpt',
      responses: [cloroError(429, 'CONCURRENCY_LIMIT_EXCEEDED', 'Concurrency limit exceeded', { details: { limit: 1 } }), COMPLETE],
      expect: { outcome: 'complete', requests: 2 },
    },
    // 503 "sends `Retry-After`" and is not billed: retried twice, then surfaced.
    'http-5xx': {
      source: ERROR_SOURCE,
      profile: 'chatgpt',
      responses: [cloroError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable', { headers: { 'Retry-After': '0' } })],
      expect: { outcome: 'http-error', httpStatus: 503, requests: 3 },
    },
  },
  notApplicable: {
    partial: 'cloro documents no partial state for a sync monitor request: a 200 carries the whole result and every failure uses an HTTP error status.',
    pending: 'The sync /v1/monitor endpoints return the result in the response and no job handle. Canonry does not use the async task API.',
  },
}
