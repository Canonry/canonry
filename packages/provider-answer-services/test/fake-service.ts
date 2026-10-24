/**
 * A test-only answer service built purely on the shared descriptor, used to
 * prove the generic layer end to end (registration, settings, research,
 * snapshots, eligibility, and that connecting a service never widens an
 * existing project). It is not a vendor and calls nothing: every response is
 * supplied by the test through an injected fetch.
 *
 * Its response shape is invented for these tests. It is not derived from, and
 * must not be mistaken for, any real vendor's documentation.
 */
import {
  asRecord,
  CompletionStatuses,
  unknownUsageObservation,
  usdToMicros,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
  type AnswerSource,
  type Completion,
  type SentLocation,
  type SseEvent,
  type UsageObservation,
} from '@canonry/canonry-contracts'
import { createAnswerServiceAdapter, type AnswerServiceAdapterOptions } from '../src/core/adapter.js'
import type { AnswerServiceDefinition, AnswerServiceParseContext, ParsedAnswer } from '../src/core/types.js'

export const FAKE_SERVICE_ID = 'fake-answers'

const baseProfile = {
  product: 'answer',
  execution: 'sync',
  transport: 'json',
  timeoutMs: 30_000,
  requestPolicyVersion: 'fake-answer-v1',
} as const

const citedProfile: AnswerServiceProfile = {
  ...baseProfile,
  id: 'cited',
  displayName: 'Cited',
  description: 'Answers with numbered citations.',
  requestedServiceModel: 'fake-tier',
  settings: { depth: 'standard', maxResults: 5 },
  capabilities: {
    groundedAnswer: true,
    textGeneration: false,
    structuredOutput: false,
    evidence: { relationships: ['explicit-citation', 'search-result'], spans: true, retrievalObservability: 'events', directUrls: true },
    location: { granularity: 'country', strength: 'hint' },
    filters: { includeDomains: 'none', excludeDomains: 'none' },
    maxQueryChars: 200,
    disclosedModelKind: 'service-tier',
    costBasis: 'estimated',
  },
  workflows: ['research', 'snapshot', 'visibility-sweep'],
}

const resultsProfile: AnswerServiceProfile = {
  ...baseProfile,
  id: 'results',
  displayName: 'Results only',
  description: 'Answers with search results that are not tied to the answer.',
  requestedServiceModel: null,
  settings: { depth: 'basic' },
  capabilities: {
    groundedAnswer: true,
    textGeneration: false,
    structuredOutput: false,
    evidence: { relationships: ['search-result'], spans: false, retrievalObservability: 'sources', directUrls: true },
    location: { granularity: 'none', strength: null },
    filters: { includeDomains: 'hard', excludeDomains: 'hard' },
    maxQueryChars: null,
    disclosedModelKind: 'foundation-model',
    costBasis: 'unknown',
  },
  workflows: ['research', 'snapshot'],
}

const streamProfile: AnswerServiceProfile = {
  ...baseProfile,
  id: 'stream',
  displayName: 'Streamed',
  description: 'Streams the answer and its citations.',
  transport: 'sse',
  requestedServiceModel: 'fake-stream',
  settings: { stream: true },
  capabilities: {
    groundedAnswer: true,
    textGeneration: false,
    structuredOutput: false,
    evidence: { relationships: ['explicit-citation'], spans: true, retrievalObservability: 'sources', directUrls: true },
    location: { granularity: 'full', strength: 'hint' },
    filters: { includeDomains: 'none', excludeDomains: 'none' },
    maxQueryChars: null,
    disclosedModelKind: 'unknown',
    costBasis: 'reported',
  },
  workflows: ['research'],
}

const jobProfile: AnswerServiceProfile = {
  ...baseProfile,
  id: 'job',
  displayName: 'Background job',
  description: 'Runs as an upstream job.',
  execution: 'job',
  timeoutMs: 120_000,
  requestedServiceModel: null,
  settings: { mode: 'deep' },
  capabilities: { ...citedProfile.capabilities, maxQueryChars: null },
  workflows: ['research'],
}

export const fakeServiceDescriptor: AnswerServiceDescriptor = {
  id: FAKE_SERVICE_ID,
  displayName: 'Fake Answers',
  keyUrl: 'https://fake-answers.example/keys',
  vendorDocsUrl: 'https://fake-answers.example/docs',
  docsPath: 'docs/providers/answer-services.md',
  auth: { scheme: 'header', header: 'x-fake-key' },
  baseUrl: 'https://api.fake-answers.example',
  settings: {
    fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'FAKE_ANSWERS_API_KEY', label: 'API key' }],
    allowBaseUrl: false,
    allowModel: false,
    keyCheck: null,
  },
  defaultQuota: { maxConcurrency: 1, maxRequestsPerMinute: 5, maxRequestsPerDay: 100 },
  retry: { statuses: [429, 503] },
  parserVersion: 'fake-parser-1',
  profiles: [citedProfile, resultsProfile, streamProfile, jobProfile],
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function completionOf(body: Record<string, unknown>, headerRequestId: string | null): Completion {
  const status = stringOrNull(body.status)
  const requestId = stringOrNull(body.id) ?? headerRequestId
  const error = stringOrNull(asRecord(body.error)?.message)
  const base = { finishReason: stringOrNull(body.finish_reason), upstreamStatus: status, upstreamRequestId: requestId, upstreamJobId: null, error }
  switch (status) {
    case 'completed':
      return { ...base, status: CompletionStatuses.complete }
    case 'incomplete':
      return { ...base, status: CompletionStatuses.partial }
    case 'queued':
      return { ...base, status: CompletionStatuses.pending, upstreamJobId: requestId }
    default:
      return { ...base, status: CompletionStatuses.failed, error: error ?? `unrecognised status ${status ?? 'missing'}` }
  }
}

function usageOf(body: Record<string, unknown>, searchCount: number): UsageObservation {
  const usage = unknownUsageObservation()
  const tokens = asRecord(body.usage)
  if (tokens && typeof tokens.input_tokens === 'number' && typeof tokens.output_tokens === 'number') {
    usage.tokens = { input: tokens.input_tokens, output: tokens.output_tokens, reasoning: null, basis: 'reported' }
  }
  if (Array.isArray(body.searches)) usage.searches = { count: searchCount, basis: 'derived-from-evidence' }
  const micros = usdToMicros(body.cost_usd)
  if (micros !== null) usage.cost = { micros, currency: 'USD', basis: 'estimated', estimatedBy: 'provider' }
  return usage
}

function parseJson(body: Record<string, unknown>, context: AnswerServiceParseContext): ParsedAnswer {
  const sources: AnswerSource[] = []
  const citationRelationship = context.profile.capabilities.evidence.relationships.includes('explicit-citation')
  if (citationRelationship && Array.isArray(body.citations)) {
    for (const value of body.citations) {
      const citation = asRecord(value)
      const url = stringOrNull(citation?.url)
      if (!citation || !url) continue
      sources.push({
        url,
        title: stringOrNull(citation.title),
        relationship: 'explicit-citation',
        rank: null,
        ...(typeof citation.marker === 'number' ? { citationNumbers: [citation.marker] } : {}),
        ...(typeof citation.start === 'number' && typeof citation.end === 'number' ? { spans: [{ start: citation.start, end: citation.end, basis: 'upstream' as const }] } : {}),
        publishedAt: null,
        upstreamId: null,
      })
    }
  }
  if (Array.isArray(body.results)) {
    body.results.forEach((value, index) => {
      const result = asRecord(value)
      const url = stringOrNull(result?.url)
      if (!result || !url) return
      sources.push({ url, title: stringOrNull(result.title), relationship: 'search-result', rank: index + 1, publishedAt: stringOrNull(result.published), upstreamId: null })
    })
  }
  const searchQueries = Array.isArray(body.searches)
    ? body.searches.flatMap(value => {
      const query = stringOrNull(asRecord(value)?.query)
      return query ? [query] : []
    })
    : []
  return {
    answerText: typeof body.answer === 'string' ? body.answer : null,
    sources,
    searchQueries,
    searchEventCount: searchQueries.length,
    completion: completionOf(body, context.headerRequestId),
    usage: usageOf(body, searchQueries.length),
    disclosedModel: stringOrNull(body.model),
  }
}

function parseEvents(events: readonly SseEvent[], context: AnswerServiceParseContext & { ended: 'terminal' | 'eof' | 'aborted' }): ParsedAnswer {
  let text = ''
  const sources: AnswerSource[] = []
  let finishReason: string | null = null
  let costUsd: unknown
  for (const event of events) {
    const data = asRecord(JSON.parse(event.data) as unknown)
    if (!data) continue
    if (event.event === 'delta' && typeof data.text === 'string') text += data.text
    if (event.event === 'citation' && typeof data.url === 'string') {
      sources.push({
        url: data.url,
        title: stringOrNull(data.title),
        relationship: 'explicit-citation',
        rank: null,
        ...(typeof data.number === 'number' ? { citationNumbers: [data.number] } : {}),
        publishedAt: null,
        upstreamId: null,
      })
    }
    if (event.event === 'done') {
      finishReason = stringOrNull(data.finish_reason)
      costUsd = data.cost_usd
    }
  }
  const usage = unknownUsageObservation()
  const micros = usdToMicros(costUsd)
  if (micros !== null) usage.cost = { micros, currency: 'USD', basis: 'reported', estimatedBy: null }
  return {
    answerText: text || null,
    sources,
    searchQueries: [],
    searchEventCount: 0,
    completion: {
      status: context.ended === 'terminal' && finishReason === 'stop' ? CompletionStatuses.complete : CompletionStatuses.partial,
      finishReason,
      upstreamStatus: null,
      upstreamRequestId: context.headerRequestId,
      upstreamJobId: null,
      error: null,
    },
    usage,
    disclosedModel: null,
  }
}

/**
 * The countries the fake service accepts, standing in for a vendor whose
 * country field is a closed list: any other offered country is left out of
 * the request and reported as not sent.
 */
export const FAKE_SUPPORTED_COUNTRIES: readonly string[] = ['US', 'GB', 'CA']

function fakeSentLocation(offered: SentLocation | null): SentLocation | null {
  if (!offered) return null
  const { country, ...rest } = offered
  const sent: SentLocation = { ...rest, ...(country && FAKE_SUPPORTED_COUNTRIES.includes(country) ? { country } : {}) }
  return Object.keys(sent).length > 0 ? sent : null
}

export const fakeServiceDefinition: AnswerServiceDefinition = {
  descriptor: fakeServiceDescriptor,
  buildRequest: ({ query, profile, location }) => {
    const sentLocation = fakeSentLocation(location.sent)
    return {
      request: {
        method: 'POST',
        path: profile.transport === 'sse' ? '/v1/answer/stream' : '/v1/answer',
        body: {
          query,
          tier: profile.requestedServiceModel,
          ...profile.settings,
          ...(sentLocation ? { location: sentLocation } : {}),
        },
      },
      sentLocation,
    }
  },
  parseResponse: parseJson,
  parseEvents,
  isTerminalEvent: event => event.event === 'done',
  errorMessage: body => stringOrNull(asRecord(asRecord(body)?.error)?.message),
}

export function createFakeAnswerServiceAdapter(options: AnswerServiceAdapterOptions = {}) {
  return createAnswerServiceAdapter(fakeServiceDefinition, options)
}

/** A complete JSON answer with one citation and one uncited search result. */
export function fakeCompleteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fake-req-1',
    status: 'completed',
    finish_reason: 'stop',
    model: 'fake-tier-2',
    answer: 'Acme Roofing is a strong choice [1].',
    citations: [{ url: 'https://www.acme-roofing.example/services', title: 'Acme services', marker: 1, start: 0, end: 12 }],
    results: [{ url: 'https://other-results.example/list', title: 'A list' }],
    searches: [{ query: 'best roofer' }],
    cost_usd: 0.0045,
    ...overrides,
  }
}

/** A fetch stub answering every call with the given JSON (or SSE text) and counting calls. */
export function fakeFetch(responses: ReadonlyArray<{ status?: number; json?: unknown; sse?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    const status = next.status ?? 200
    if (next.sse !== undefined) {
      return new Response(next.sse, { status, headers: { 'content-type': 'text/event-stream', ...next.headers } })
    }
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), { status, headers: { 'content-type': 'application/json', ...next.headers } })
  }) as typeof fetch
  return { impl, calls }
}
