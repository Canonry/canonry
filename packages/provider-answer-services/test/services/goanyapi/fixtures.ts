/**
 * GoAnyAPI Google AI Overview fixtures. Documentation-derived, not captured:
 * every body follows the response documented at
 * https://goanyapi.com/docs/google-ai-overview-api (the `{ code, message, data }`
 * envelope, `data.result.format: 'json'`, `data.result.content.results[].links[]`,
 * `search_parameters.feature_available`, `data.costCredits`, and the documented
 * error codes), as read November 15, 2026. No request was sent to GoAnyAPI.
 * Domains, tokens and amounts are invented examples.
 */
import { SAMPLE_LOCATION, type ConformanceFixtures, type ConformanceResponse } from '../../conformance.js'

const SOURCE = 'Documentation-derived from https://goanyapi.com/docs/google-ai-overview-api; not captured from a live response.'

export const GOANYAPI_ANSWER_TEXT =
  'Solar panel costs depend on system size and location. Most residential installations in the US fall between $2.50 and $3.50 per watt before incentives.'

/** Three links as Google lists them next to the overview. */
export function goanyapiLinks(): Array<Record<string, unknown>> {
  return [
    { title: 'How Much Do Solar Panels Cost?', url: 'https://energysage.example/solar/cost' },
    { title: 'Reddit · r/solar', url: 'https://www.reddit.example/r/solar/comments/cost' },
    { title: 'Solar panel installation guide', url: 'https://energy.example/guides/installation' },
  ]
}

/** A successful JSON response with an overview, links and the billed credits. */
export function goanyapiAnswerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'ok',
    message: 'success',
    data: {
      endpoint: 'google-ai-overview',
      query: { query: 'how much do solar panels cost', output: 'json' },
      costCredits: 3,
      remainingCredits: 9997,
      result: {
        format: 'json',
        content: {
          results: [
            {
              title: 'AI Overview',
              text: GOANYAPI_ANSWER_TEXT,
              links: goanyapiLinks(),
              type: 'ai_summary',
              url: '',
              position: 1,
              rank: 1,
            },
          ],
          search_parameters: {
            query: 'how much do solar panels cost',
            country: '',
            language: '',
            device: '',
            engine: 'google',
            operation: 'google-ai-overview',
            type: 'search',
            feature_available: true,
            pagination_limited: false,
          },
          serp_features: [],
        },
      },
    },
    ...overrides,
  }
}

/** A complete overview whose results carry no links at all. */
export function goanyapiAnswerWithoutLinksBody(): Record<string, unknown> {
  const body = goanyapiAnswerBody()
  const data = body.data as Record<string, unknown>
  const result = data.result as Record<string, unknown>
  const content = result.content as Record<string, unknown>
  return {
    ...body,
    data: {
      ...data,
      result: {
        ...result,
        content: {
          ...content,
          results: [{ title: 'AI Overview', text: GOANYAPI_ANSWER_TEXT, links: [], type: 'ai_summary' }],
        },
      },
    },
  }
}

/** The documented "no overview" success: billed, but nothing to measure. */
export function goanyapiNoOverviewBody(): Record<string, unknown> {
  const body = goanyapiAnswerBody()
  const data = body.data as Record<string, unknown>
  const result = data.result as Record<string, unknown>
  const content = result.content as Record<string, unknown>
  return {
    ...body,
    data: {
      ...data,
      result: {
        ...result,
        content: {
          ...content,
          results: [],
          serp_features: [],
          search_parameters: { ...(content.search_parameters as Record<string, unknown>), feature_available: false },
        },
      },
    },
  }
}

/** The documented error envelope. */
export function goanyapiError(status: number, code: string, message: string): ConformanceResponse {
  return { status, json: { code, message } }
}

const COMPLETE: ConformanceResponse = { json: goanyapiAnswerBody() }

export const GOANYAPI_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  service: 'goanyapi',
  cases: {
    // Google's links answer the overview: answer support, counted as cited.
    'sources-not-cited': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [COMPLETE],
      expect: {
        outcome: 'complete',
        answerText: GOANYAPI_ANSWER_TEXT,
        citedDomains: ['energysage.example', 'reddit.example', 'energy.example'],
        relationships: { 'answer-support': 3 },
        retrievalStatus: 'used',
        disclosedModel: null,
        costBasis: 'unknown',
        requests: 1,
      },
    },
    // No links: still complete, and retrieval stays unknown rather than "not used".
    'empty-sources': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [{ json: goanyapiAnswerWithoutLinksBody() }],
      expect: { outcome: 'complete', citedDomains: [], relationships: {}, retrievalStatus: 'unknown', costBasis: 'unknown' },
    },
    // Google showed no overview: a legitimate billed 200 with nothing to measure.
    failed: {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [{ json: goanyapiNoOverviewBody() }],
      expect: { outcome: 'failed', requests: 1 },
    },
    // The response never names a model. Without `costCredits` (optional),
    // cost stays unknown, never zero.
    'unknown-model': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [{ json: goanyapiAnswerBody() }],
      expect: { outcome: 'complete', disclosedModel: null, costBasis: 'unknown' },
    },
    // A city context reaches GoAnyAPI only as its country, lowercased.
    'unsupported-location': {
      source: SOURCE,
      profile: 'ai-overview',
      location: SAMPLE_LOCATION,
      responses: [COMPLETE],
      expect: { outcome: 'complete', locationStatus: 'partial', sentLocation: { country: 'us' } },
    },
    'http-401': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [goanyapiError(401, 'unauthorized', 'Missing or invalid API key'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 401, requests: 1 },
    },
    'http-403': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [goanyapiError(403, 'forbidden', 'This key cannot call google-ai-overview'), COMPLETE],
      expect: { outcome: 'http-error', httpStatus: 403, requests: 1 },
    },
    // Retry-After is honoured, then the overview is read.
    'http-429': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [goanyapiError(429, 'rate_limited', 'Too many requests'), COMPLETE],
      expect: { outcome: 'complete', requests: 2 },
    },
    // 502 is documented as a failure that is never billed: retried twice, then surfaced.
    'http-5xx': {
      source: SOURCE,
      profile: 'ai-overview',
      responses: [goanyapiError(502, 'request_failed', 'The upstream request failed')],
      expect: { outcome: 'http-error', httpStatus: 502, requests: 3 },
    },
    // The profile caps queries at GoAnyAPI's documented 8192 limit; nothing is sent.
    'long-query': {
      source: SOURCE,
      profile: 'ai-overview',
      query: 'a'.repeat(8193),
      responses: [],
      expect: { outcome: 'refused-before-request' },
    },
  },
  notApplicable: {
    'explicit-citations': "GoAnyAPI returns Google's AI Overview text and the pages Google lists beside it; the text carries no citation markers or spans, so the links are answer support and never explicit citations.",
    partial: 'GoAnyAPI documents no partial or incomplete state for the synchronous google-ai-overview response: a 200 carries the whole result and errors use HTTP statuses.',
    pending: 'google-ai-overview is synchronous and returns no job handle.',
  },
}
