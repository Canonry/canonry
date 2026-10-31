/**
 * Parallel Responses fixtures. Documentation-derived, not captured: every
 * body follows the `Response` schema of `POST /v1/responses` in Parallel's
 * OpenAPI spec (https://docs.parallel.ai/public-openapi.json), as presented at
 * https://docs.parallel.ai/api-reference/responses-api/create-response, with
 * the `web_search_call` items from
 * https://docs.parallel.ai/responses-api/features/web-search-tool, the
 * `url_citation` annotations from
 * https://docs.parallel.ai/responses-api/features/citations, and the error
 * envelope, rejected requests and 429 guidance from
 * https://docs.parallel.ai/responses-api/openai-compatibility and
 * https://docs.parallel.ai/resources/warnings-and-errors (all read October 17,
 * 2026). No request was sent to Parallel.
 *
 * Every documented `Response` field is present, including the ones the parser
 * ignores. Ignored request fields come back at their defaults (`tool_choice:
 * "auto"`, `temperature: null`), `tools` is `[]` because none is sent, and
 * `reasoning` and `text` are echoed as `null` even though `reasoning` was
 * sent, as the compatibility page documents. Item ids follow the
 * `ws_<response id>_<n>` pattern shown on the web-search-tool page. Response
 * and message ids, timestamps, token counts, answer text, domains, and the
 * error `message` and `type` values other than the documented 400 are
 * invented examples.
 */
import { SAMPLE_LOCATION, type ConformanceFixtures, type ConformanceResponse } from '../../conformance.js'

const SOURCE = 'Documentation-derived from https://docs.parallel.ai/api-reference/responses-api/create-response (the Response schema in https://docs.parallel.ai/public-openapi.json), https://docs.parallel.ai/responses-api/features/web-search-tool and https://docs.parallel.ai/responses-api/features/citations; not captured from a live response.'
const ERROR_SOURCE = 'Documentation-derived from https://docs.parallel.ai/responses-api/openai-compatibility (error envelope, 429 guidance) and https://docs.parallel.ai/resources/warnings-and-errors (status codes); message and type values are invented examples; not captured from a live response.'

export const PARALLEL_RESPONSE_ID = 'resp_5d1b7c3e-2f4a-4c8e-9b6d-0a1e3f5c7b92'

const FIRST_SENTENCE = 'Acme Roofing is a well reviewed roofing contractor in Springfield, known for repairs and full replacements.'
const SECOND_SENTENCE = 'Other options include Summit Roof Co.'
/** 145 characters: the first sentence spans 0 to 107, the second 108 to 145. */
export const PARALLEL_ANSWER_TEXT = `${FIRST_SENTENCE} ${SECOND_SENTENCE}`

export const ACME_URL = 'https://www.acme-roofing.example/services'
export const REVIEWS_URL = 'https://roofing-reviews.example/springfield/best-roofers'
export const SUMMIT_URL = 'https://summit-roof.example/projects'

export function searchCall(index: number, queries: string[], status = 'completed'): Record<string, unknown> {
  // `action.query` repeats the first query and `action.sources` is always null.
  return { id: `ws_${PARALLEL_RESPONSE_ID}_${index}`, type: 'web_search_call', status, action: { type: 'search', query: queries[0] ?? null, queries, sources: null } }
}

export function openPageCall(index: number, url: string, status = 'completed'): Record<string, unknown> {
  return { id: `ws_${PARALLEL_RESPONSE_ID}_${index}`, type: 'web_search_call', status, action: { type: 'open_page', url } }
}

export function urlCitation(url: string, title: string, start: number, end: number): Record<string, unknown> {
  return { type: 'url_citation', url, title, start_index: start, end_index: end }
}

export function outputText(text: string, annotations: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: 'output_text', text, annotations, logprobs: null }
}

export function answerMessage(
  content: Array<Record<string, unknown>>,
  options: { status?: string; phase?: string | null; id?: string } = {},
): Record<string, unknown> {
  return {
    id: options.id ?? `msg_${PARALLEL_RESPONSE_ID}`,
    type: 'message',
    role: 'assistant',
    status: options.status ?? 'completed',
    phase: options.phase ?? null,
    content,
  }
}

/**
 * The answer's citations: two sources on the first sentence (several sources
 * may support one span), and the review page cited again on the second.
 */
export function answerCitations(): Array<Record<string, unknown>> {
  return [
    urlCitation(ACME_URL, 'Roof repair and replacement services', 0, 107),
    urlCitation(REVIEWS_URL, 'Best roofers in Springfield', 0, 107),
    urlCitation(SUMMIT_URL, 'Summit Roof Co. projects', 108, 145),
    urlCitation(REVIEWS_URL, 'Best roofers in Springfield', 108, 145),
  ]
}

/**
 * The research trail in the order the model started it, ahead of the
 * message: two searches and four page reads, one of them a second read of
 * the same page (which the docs say produces a second item).
 */
export function researchTrail(): Array<Record<string, unknown>> {
  return [
    searchCall(0, ['best roofing contractor Springfield', 'Springfield roofer reviews']),
    openPageCall(1, ACME_URL),
    openPageCall(2, REVIEWS_URL),
    searchCall(3, ['Summit Roof Co. Springfield']),
    openPageCall(4, SUMMIT_URL),
    openPageCall(5, ACME_URL),
  ]
}

export function parallelUsage(): Record<string, unknown> {
  return {
    input_tokens: 25,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 180,
    output_tokens_details: { reasoning_tokens: 64 },
    total_tokens: 205,
  }
}

/** A completed response carrying every documented field. */
export function parallelResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PARALLEL_RESPONSE_ID,
    created_at: 1792161000,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'parallel',
    object: 'response',
    output: [...researchTrail(), answerMessage([outputText(PARALLEL_ANSWER_TEXT, answerCitations())])],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    background: null,
    completed_at: 1792161014,
    conversation: null,
    max_output_tokens: null,
    max_tool_calls: null,
    moderation: null,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: null,
    status: 'completed',
    text: null,
    top_logprobs: null,
    truncation: null,
    usage: parallelUsage(),
    user: null,
    ...overrides,
  }
}

/** `model` is not a required field (its default is `parallel`), so a documented body may omit it. */
export function parallelResponseBodyWithoutModel(): Record<string, unknown> {
  const body = parallelResponseBody()
  delete body.model
  return body
}

/** Stopped at the output limit: the message is incomplete and carries the text written so far. */
export const PARALLEL_PARTIAL_TEXT = 'Acme Roofing is a well reviewed roofing contractor in Springfield'
export function parallelIncompleteBody(): Record<string, unknown> {
  return parallelResponseBody({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    completed_at: null,
    output: [
      ...researchTrail(),
      answerMessage([outputText(PARALLEL_PARTIAL_TEXT, [urlCitation(ACME_URL, 'Roof repair and replacement services', 0, 65)])], { status: 'incomplete' }),
    ],
  })
}

export const PARALLEL_FAILURE_MESSAGE = 'The research run failed. Please retry the request.'
/** A failed response: `error.code` is documented as always `server_error`. */
export function parallelFailedBody(): Record<string, unknown> {
  return parallelResponseBody({
    status: 'failed',
    error: { code: 'server_error', message: PARALLEL_FAILURE_MESSAGE },
    completed_at: null,
    output: [searchCall(0, ['best roofing contractor Springfield'])],
    usage: null,
  })
}

/** An unfinished response: research had started and no message exists yet. */
export function parallelInProgressBody(status: 'in_progress' | 'queued' = 'in_progress'): Record<string, unknown> {
  return parallelResponseBody({
    status,
    completed_at: null,
    output: status === 'queued' ? [] : [searchCall(0, ['best roofing contractor Springfield'], 'searching')],
    usage: null,
  })
}

/** The standard OpenAI error envelope the compatibility page documents. */
export function parallelError(status: number, message: string, type: string, headers: Record<string, string> = {}): ConformanceResponse {
  return { status, headers, json: { error: { message, type, param: null, code: null } } }
}

/** The documented 400 for any model other than `parallel`, with its documented message. */
export const PARALLEL_WRONG_MODEL = parallelError(400, 'The Responses API only supports model \'parallel\'.', 'invalid_request_error')

const COMPLETE: ConformanceResponse = { json: parallelResponseBody() }

export const PARALLEL_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  service: 'parallel',
  cases: {
    // Annotations are explicit citations; page reads are kept as page reads and never cited.
    'explicit-citations': {
      source: SOURCE,
      profile: 'low',
      responses: [COMPLETE],
      expect: {
        outcome: 'complete',
        answerText: PARALLEL_ANSWER_TEXT,
        citedDomains: ['acme-roofing.example', 'roofing-reviews.example', 'summit-roof.example'],
        relationships: { 'explicit-citation': 3, 'page-read': 4 },
        retrievalStatus: 'used',
        disclosedModel: 'parallel',
        costBasis: 'unknown',
        requests: 1,
      },
    },
    // Pages read without a citation in the answer: kept, and nothing is counted as cited.
    'sources-not-cited': {
      source: SOURCE,
      profile: 'medium',
      responses: [{
        json: parallelResponseBody({
          output: [
            searchCall(0, ['best roofing contractor Springfield']),
            openPageCall(1, ACME_URL),
            openPageCall(2, REVIEWS_URL),
            answerMessage([outputText(PARALLEL_ANSWER_TEXT, [])]),
          ],
        }),
      }],
      expect: { outcome: 'complete', citedDomains: [], relationships: { 'page-read': 2 }, retrievalStatus: 'used' },
    },
    // "A run that answers without searching or reading a page returns no web_search_call items."
    'empty-sources': {
      source: SOURCE,
      profile: 'low',
      responses: [{ json: parallelResponseBody({ output: [answerMessage([outputText(PARALLEL_ANSWER_TEXT, [])])] }) }],
      expect: { outcome: 'complete', citedDomains: [], relationships: {}, retrievalStatus: 'not-used' },
    },
    partial: {
      source: SOURCE,
      profile: 'medium',
      responses: [{ json: parallelIncompleteBody() }],
      expect: { outcome: 'partial', requests: 1 },
    },
    pending: {
      source: SOURCE,
      profile: 'high',
      responses: [{ json: parallelInProgressBody() }],
      expect: { outcome: 'pending', requests: 1 },
    },
    failed: {
      source: SOURCE,
      profile: 'medium',
      responses: [{ json: parallelFailedBody() }],
      expect: { outcome: 'failed', requests: 1 },
    },
    // `model` is optional (default `parallel`); without it no model is recorded at all.
    'unknown-model': {
      source: SOURCE,
      profile: 'low',
      responses: [{ json: parallelResponseBodyWithoutModel() }],
      expect: { outcome: 'complete', disclosedModel: null, costBasis: 'unknown' },
    },
    // `input` may be at most 20,000 characters; one more is refused before any request.
    'long-query': {
      source: SOURCE,
      profile: 'low',
      query: 'best roofing contractor in springfield '.repeat(600).slice(0, 20_001),
      responses: [COMPLETE],
      expect: { outcome: 'refused-before-request', requests: 0 },
    },
    // Parallel takes no location (the web_search tool's user_location is accepted and ignored).
    'unsupported-location': {
      source: SOURCE,
      profile: 'medium',
      location: SAMPLE_LOCATION,
      responses: [COMPLETE],
      expect: { outcome: 'complete', locationStatus: 'ignored' },
    },
    'http-401': {
      source: ERROR_SOURCE,
      profile: 'low',
      responses: [parallelError(401, 'Invalid or missing API key.', 'authentication_error'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 401, requests: 1 },
    },
    'http-403': {
      source: ERROR_SOURCE,
      profile: 'high',
      responses: [parallelError(403, 'This API key cannot use this endpoint.', 'permission_error'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 403, requests: 1 },
    },
    // "Requests over your quota return 429; back off and retry." Retry-After is honoured.
    'http-429': {
      source: ERROR_SOURCE,
      profile: 'low',
      responses: [parallelError(429, 'Rate limit exceeded.', 'rate_limit_error', { 'retry-after': '0' }), COMPLETE],
      expect: { outcome: 'complete', requests: 2 },
    },
    // Only 429 is retried: a 500 surfaces at once.
    'http-5xx': {
      source: ERROR_SOURCE,
      profile: 'medium',
      responses: [parallelError(500, 'Internal server error.', 'server_error'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 500, requests: 1 },
    },
  },
  notApplicable: {},
}
