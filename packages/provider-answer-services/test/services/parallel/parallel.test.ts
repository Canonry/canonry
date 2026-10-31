/**
 * Parallel-specific request and response mapping that the shared conformance
 * matrix cannot express: the exact request body and deadline per effort, how
 * the output array splits into answer text, explicit citations with spans,
 * page reads and searches, how every documented status maps onto completion,
 * and which error bodies and statuses surface without a retry. Every response
 * body follows the documentation-derived fixtures beside this file; no
 * request reaches Parallel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncompleteAnswerError, resolveProviderRoute, routeFamiliesOf, type Completion, type ProviderAdapter } from '@canonry/canonry-contracts'
import { AnswerServiceHttpError, createAnswerServiceAdapter } from '../../../src/index.js'
import { parallelResponsesService } from '../../../src/services/parallel/index.js'
import type { ConformanceResponse } from '../../conformance.js'
import { fakeFetch } from '../../fake-service.js'
import {
  ACME_URL,
  answerMessage,
  outputText,
  openPageCall,
  PARALLEL_ANSWER_TEXT,
  PARALLEL_FAILURE_MESSAGE,
  PARALLEL_PARTIAL_TEXT,
  PARALLEL_RESPONSE_ID,
  PARALLEL_WRONG_MODEL,
  parallelError,
  parallelFailedBody,
  parallelInProgressBody,
  parallelIncompleteBody,
  parallelResponseBody,
  researchTrail,
  REVIEWS_URL,
  SUMMIT_URL,
  urlCitation,
} from './fixtures.js'

const QUERY = 'best roofing contractor in springfield'
const INPUT = { query: QUERY, canonicalDomains: ['acme-roofing.example'], competitorDomains: [] }
const LOCATION = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }

function setup(responses: ConformanceResponse[]) {
  const stub = fakeFetch(responses)
  const adapter = createAnswerServiceAdapter(parallelResponsesService, { fetchImpl: stub.impl, sleep: async () => undefined })
  const run = (profile: string, input: Parameters<ProviderAdapter['executeTrackedQuery']>[0] = INPUT) => {
    const route = resolveProviderRoute(`parallel:${profile}`, routeFamiliesOf([adapter]))!
    return adapter.forRoute!(route).executeTrackedQuery(input, {
      provider: `parallel:${profile}`,
      apiKey: 'parallel-test-key',
      model: profile,
      quotaPolicy: parallelResponsesService.descriptor.defaultQuota,
    })
  }
  return { stub, run }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Parallel Responses request', () => {
  it.each([
    ['low', 60_000],
    ['medium', 120_000],
    ['high', 180_000],
  ])('sends the unmodified query with %s effort, no location, and a %i ms deadline', async (effort, deadline) => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout')
    const { stub, run } = setup([{ json: parallelResponseBody() }])
    const raw = await run(effort, { ...INPUT, location: LOCATION })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe('https://api.parallel.ai/v1/responses')
    expect(stub.calls[0]!.init.method).toBe('POST')
    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer parallel-test-key')
    expect(headers['x-api-key']).toBeUndefined()
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ model: 'parallel', input: QUERY, reasoning: { effort }, stream: false })
    expect(deadlines.mock.calls).toEqual([[deadline]])
    expect(raw.evidence?.identity).toMatchObject({
      route: `parallel:${effort}`,
      product: 'responses',
      profile: effort,
      requestedServiceModel: 'parallel',
      settings: { model: 'parallel', 'reasoning.effort': effort, stream: false },
    })
    expect(raw.evidence?.location).toEqual({ requested: LOCATION, sent: null, strength: null, serviceDefault: null, status: 'ignored' })
  })

  it('sends a query of exactly 20,000 characters whole', async () => {
    const query = 'best roofing contractor in springfield '.repeat(600).slice(0, 20_000)
    const { stub, run } = setup([{ json: parallelResponseBody() }])
    await run('low', { ...INPUT, query })
    expect(JSON.parse(String(stub.calls[0]!.init.body)).input).toBe(query)
  })
})

describe('Parallel Responses output', () => {
  it('keeps citations, page reads and searches apart, with approximate tokens and no cost', async () => {
    const body = parallelResponseBody()
    const { run } = setup([{ json: body }])
    const raw = await run('medium')
    expect(raw.answerText).toBe(PARALLEL_ANSWER_TEXT)
    expect(raw.rawResponse).toEqual(body)
    expect(raw.evidence?.sources).toEqual([
      { url: ACME_URL, title: 'Roof repair and replacement services', relationship: 'explicit-citation', rank: null, spans: [{ start: 0, end: 107, basis: 'upstream' }], publishedAt: null, upstreamId: null },
      { url: REVIEWS_URL, title: 'Best roofers in Springfield', relationship: 'explicit-citation', rank: null, spans: [{ start: 0, end: 107, basis: 'upstream' }, { start: 108, end: 145, basis: 'upstream' }], publishedAt: null, upstreamId: null },
      { url: SUMMIT_URL, title: 'Summit Roof Co. projects', relationship: 'explicit-citation', rank: null, spans: [{ start: 108, end: 145, basis: 'upstream' }], publishedAt: null, upstreamId: null },
      { url: ACME_URL, title: null, relationship: 'page-read', rank: null, publishedAt: null, upstreamId: `ws_${PARALLEL_RESPONSE_ID}_1`, status: 'completed' },
      { url: REVIEWS_URL, title: null, relationship: 'page-read', rank: null, publishedAt: null, upstreamId: `ws_${PARALLEL_RESPONSE_ID}_2`, status: 'completed' },
      { url: SUMMIT_URL, title: null, relationship: 'page-read', rank: null, publishedAt: null, upstreamId: `ws_${PARALLEL_RESPONSE_ID}_4`, status: 'completed' },
      { url: ACME_URL, title: null, relationship: 'page-read', rank: null, publishedAt: null, upstreamId: `ws_${PARALLEL_RESPONSE_ID}_5`, status: 'completed' },
    ])
    expect(raw.searchQueries).toEqual(['best roofing contractor Springfield', 'Springfield roofer reviews', 'Summit Roof Co. Springfield'])
    expect(raw.groundingSources.map(source => source.uri)).toEqual([ACME_URL, REVIEWS_URL, SUMMIT_URL])
    expect(raw.evidence?.usage).toEqual({
      tokens: { input: 25, output: 180, reasoning: 64, basis: 'approximate' },
      searches: { count: 2, basis: 'derived-from-evidence' },
      pageReads: { count: 4, basis: 'derived-from-evidence' },
      billedUnits: [],
      cost: { micros: null, currency: 'USD', basis: 'unknown', estimatedBy: null },
    })
    expect(raw.evidence?.completion).toEqual({ status: 'complete', finishReason: null, upstreamStatus: 'completed', upstreamRequestId: PARALLEL_RESPONSE_ID, upstreamJobId: null, error: null })
    expect(raw.evidence?.identity).toMatchObject({ disclosedModel: 'parallel', disclosedModelKind: 'service-tier' })
    expect(raw.servedModel).toBeUndefined()
    // Approximate tokens never become billable usage.
    expect(raw.usage).toBeUndefined()
  })

  it('answers from the final message only, keeps a failed page read, and leaves MCP items in the raw response', async () => {
    const mcpCall = { id: `mcp_${PARALLEL_RESPONSE_ID}_0`, type: 'mcp_call', name: 'lookup', server_label: 'partner', arguments: '{"q":"roofers"}', status: 'completed', output: 'https://ignored.example/listing', error: null }
    const body = parallelResponseBody({
      output: [
        mcpCall,
        openPageCall(1, ACME_URL, 'failed'),
        answerMessage([outputText('Looking up roofers in Springfield.', [])], { phase: 'commentary', id: `msg_${PARALLEL_RESPONSE_ID}_0` }),
        answerMessage([outputText(PARALLEL_ANSWER_TEXT, [urlCitation(ACME_URL, 'Roof repair and replacement services', 0, 107)])], { phase: 'final_answer' }),
      ],
    })
    const { run } = setup([{ json: body }])
    const raw = await run('low')
    expect(raw.answerText).toBe(PARALLEL_ANSWER_TEXT)
    expect(raw.evidence?.sources.map(source => [source.relationship, source.url, source.status])).toEqual([
      ['explicit-citation', ACME_URL, undefined],
      ['page-read', ACME_URL, 'failed'],
    ])
    expect(raw.searchQueries).toEqual([])
    expect(raw.evidence?.usage.searches).toEqual({ count: 0, basis: 'derived-from-evidence' })
    expect(raw.evidence?.usage.pageReads).toEqual({ count: 1, basis: 'derived-from-evidence' })
    expect((raw.rawResponse as { output: unknown[] }).output).toContainEqual(mcpCall)
  })

  it('joins text parts in order and shifts later citation spans into the stored answer', async () => {
    const body = parallelResponseBody({
      output: [answerMessage([
        outputText(PARALLEL_ANSWER_TEXT.slice(0, 108), [urlCitation(ACME_URL, 'Roof repair and replacement services', 0, 107)]),
        outputText(PARALLEL_ANSWER_TEXT.slice(108), [urlCitation(SUMMIT_URL, 'Summit Roof Co. projects', 0, 37)]),
      ])],
    })
    const { run } = setup([{ json: body }])
    const raw = await run('low')
    expect(raw.answerText).toBe(PARALLEL_ANSWER_TEXT)
    expect(raw.evidence?.sources.map(source => [source.url, source.spans])).toEqual([
      [ACME_URL, [{ start: 0, end: 107, basis: 'upstream' }]],
      [SUMMIT_URL, [{ start: 108, end: 145, basis: 'upstream' }]],
    ])
  })

  it('accepts a response without a status when its answer message completed', async () => {
    const { run } = setup([{ json: parallelResponseBody({ status: null }) }])
    const raw = await run('low')
    expect(raw.evidence?.completion).toMatchObject({ status: 'complete', upstreamStatus: null })
  })
})

describe('Parallel Responses unfinished answers', () => {
  const base = { finishReason: null, upstreamRequestId: PARALLEL_RESPONSE_ID, upstreamJobId: null }
  const rows: Array<[string, Record<string, unknown>, Completion, string | null, number]> = [
    ['stopped at the output limit', parallelIncompleteBody(),
      { ...base, status: 'partial', finishReason: 'max_output_tokens', upstreamStatus: 'incomplete', error: 'Parallel stopped before the answer was finished (max_output_tokens).' },
      PARALLEL_PARTIAL_TEXT, 5],
    ['completed around an incomplete message', parallelResponseBody({ output: [answerMessage([outputText(PARALLEL_PARTIAL_TEXT, [])], { status: 'incomplete' })] }),
      { ...base, status: 'partial', upstreamStatus: 'completed', error: 'The answer message is incomplete, although the response is completed.' },
      PARALLEL_PARTIAL_TEXT, 0],
    ['without a status around an incomplete message', parallelResponseBody({ status: null, output: [answerMessage([outputText(PARALLEL_PARTIAL_TEXT, [])], { status: 'incomplete' })] }),
      { ...base, status: 'partial', upstreamStatus: null, error: 'The answer message is incomplete.' },
      PARALLEL_PARTIAL_TEXT, 0],
    ['completed with no answer message', parallelResponseBody({ output: researchTrail() }),
      { ...base, status: 'failed', upstreamStatus: 'completed', error: 'Parallel returned no answer message.' },
      null, 4],
    ['failed upstream', parallelFailedBody(),
      { ...base, status: 'failed', upstreamStatus: 'failed', error: `${PARALLEL_FAILURE_MESSAGE} (server_error)` },
      null, 0],
    ['cancelled upstream', parallelResponseBody({ status: 'cancelled', completed_at: null, output: [], usage: null }),
      { ...base, status: 'failed', upstreamStatus: 'cancelled', error: 'Parallel cancelled the response.' },
      null, 0],
    ['still in progress', parallelInProgressBody('in_progress'),
      { ...base, status: 'pending', upstreamStatus: 'in_progress', upstreamJobId: PARALLEL_RESPONSE_ID, error: 'Parallel had not finished (in_progress). The Responses API offers no way to fetch the answer later.' },
      null, 0],
    ['still queued', parallelInProgressBody('queued'),
      { ...base, status: 'pending', upstreamStatus: 'queued', upstreamJobId: PARALLEL_RESPONSE_ID, error: 'Parallel had not finished (queued). The Responses API offers no way to fetch the answer later.' },
      null, 0],
  ]

  it.each(rows)('never stores a response %s as an answer', async (_label, body, completion, answerText, sourceCount) => {
    const { stub, run } = setup([{ json: body }])
    const error = await run('medium').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IncompleteAnswerError)
    const incomplete = error as IncompleteAnswerError
    expect(incomplete.evidence.completion).toEqual(completion)
    expect(incomplete.answerText).toBe(answerText)
    expect(incomplete.evidence.sources).toHaveLength(sourceCount)
    expect(incomplete.rawResponse).toEqual(body)
    expect(stub.calls).toHaveLength(1)
  })
})

describe('Parallel Responses errors and retries', () => {
  it.each([
    ['the documented wrong-model 400', PARALLEL_WRONG_MODEL, 'Parallel request failed (HTTP 400): The Responses API only supports model \'parallel\'. (invalid_request_error)'],
    // HTTPValidationError shape from the OpenAPI spec; the loc and msg values are invented examples.
    ['a 422 validation error', { status: 422, json: { detail: [{ loc: ['body', 'input'], msg: 'Field required', type: 'missing' }] } }, 'Parallel request failed (HTTP 422): body.input: Field required'],
    // The general error format from the warnings-and-errors page; the message is an invented example.
    ['a 402 in the general error format', { status: 402, json: { error: { message: 'Insufficient credit in account.', detail: {} } } }, 'Parallel request failed (HTTP 402): Insufficient credit in account.'],
    ['a 502', parallelError(502, 'Bad gateway.', 'server_error'), 'Parallel request failed (HTTP 502): Bad gateway. (server_error)'],
    ['a 503', parallelError(503, 'Service unavailable.', 'server_error'), 'Parallel request failed (HTTP 503): Service unavailable. (server_error)'],
  ])('surfaces %s with the vendor message and sends it only once', async (_label, response, message) => {
    const { stub, run } = setup([response, { json: parallelResponseBody() }])
    const error = await run('low').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AnswerServiceHttpError)
    expect((error as Error).message).toBe(message)
    expect(stub.calls).toHaveLength(1)
  })
})
