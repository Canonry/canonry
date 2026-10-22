/**
 * Exa-specific request and response mapping that the shared conformance
 * matrix cannot express: the exact request body, which documented fields land
 * where, the estimated cost amount, refusing a structured answer, the error
 * explanations and Exa's own retry statuses, and the research deadline. Every
 * response body follows the documentation-derived fixtures beside this file;
 * no request reaches Exa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncompleteAnswerError, resolveProviderRoute, routeFamiliesOf, type ProviderAdapter } from '@canonry/canonry-contracts'
import { AnswerServiceHttpError, createAnswerServiceAdapter } from '../../../src/index.js'
import { exaAnswerService } from '../../../src/services/exa/index.js'
import type { ConformanceResponse } from '../../conformance.js'
import { fakeFetch } from '../../fake-service.js'
import {
  EXA_ANSWER_TEXT,
  EXA_REQUEST_ID,
  EXA_STRUCTURED_ANSWER,
  EXA_SUCCESS_HEADERS,
  exaAnswerBody,
  exaError,
} from './fixtures.js'

const QUERY = 'best roofing contractor in springfield'
const INPUT = { query: QUERY, canonicalDomains: ['acme-roofing.example'], competitorDomains: [] }
const LOCATION = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }

function setup(responses: ConformanceResponse[], fetchImpl?: typeof fetch) {
  const stub = fakeFetch(responses)
  const adapter = createAnswerServiceAdapter(exaAnswerService, { fetchImpl: fetchImpl ?? stub.impl, sleep: async () => undefined })
  const run = (profile: string, input: Parameters<ProviderAdapter['executeTrackedQuery']>[0] = INPUT) => {
    const route = resolveProviderRoute(`exa:${profile}`, routeFamiliesOf([adapter]))!
    return adapter.forRoute!(route).executeTrackedQuery(input, {
      provider: `exa:${profile}`,
      apiKey: 'exa-test-key',
      model: profile,
      quotaPolicy: exaAnswerService.descriptor.defaultQuota,
    })
  }
  return { stub, adapter, run }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Exa Answer request', () => {
  it.each([
    ['fast', 'exa-fast'],
    ['standard', 'exa'],
    ['pro', 'exa-pro'],
    ['research', 'exa-research'],
  ])('sends the unmodified query to /answer with the %s profile model and nothing else', async (profile, model) => {
    const { stub, run } = setup([{ headers: { ...EXA_SUCCESS_HEADERS }, json: exaAnswerBody() }])
    const raw = await run(profile)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe('https://api.exa.ai/answer')
    expect(stub.calls[0]!.init.method).toBe('POST')
    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('exa-test-key')
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ query: QUERY, model, stream: false, text: false })
    expect(raw.evidence?.identity).toMatchObject({ route: `exa:${profile}`, product: 'answer', requestedServiceModel: model, settings: { model, stream: false, text: false } })
  })

  it('sends only the country of a city context and records the location as partial', async () => {
    const { stub, run } = setup([{ headers: { ...EXA_SUCCESS_HEADERS }, json: exaAnswerBody() }])
    const raw = await run('standard', { ...INPUT, location: LOCATION })
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ query: QUERY, model: 'exa', stream: false, text: false, userLocation: { country: 'US' } })
    expect(raw.evidence?.location).toMatchObject({ requested: LOCATION, sent: { country: 'US' }, strength: 'hint', status: 'partial' })
  })
})

describe('Exa Answer response', () => {
  it('maps documented citation fields, keeps the rest in the raw response, and labels the cost an Exa estimate', async () => {
    const body = exaAnswerBody()
    const { run } = setup([{ headers: { ...EXA_SUCCESS_HEADERS }, json: body }])
    const raw = await run('standard')
    expect(raw.answerText).toBe(EXA_ANSWER_TEXT)
    expect(raw.rawResponse).toEqual(body)
    expect(raw.evidence?.sources).toEqual([
      { url: 'https://www.acme-roofing.example/services', title: 'Roof repair and replacement services', relationship: 'answer-support', rank: null, publishedAt: '2026-08-21T00:00:00.000Z', upstreamId: 'https://www.acme-roofing.example/services' },
      { url: 'https://roofing-reviews.example/springfield/best-roofers', title: 'Best roofers in Springfield', relationship: 'answer-support', rank: null, publishedAt: '2026-07-02T00:00:00.000Z', upstreamId: 'https://roofing-reviews.example/springfield/best-roofers' },
      { url: 'https://summit-roof.example/projects', title: 'Summit Roof Co. projects', relationship: 'answer-support', rank: null, publishedAt: '2026-05-14T00:00:00.000Z', upstreamId: 'https://summit-roof.example/projects' },
    ])
    expect(raw.evidence?.usage).toEqual({
      tokens: { input: null, output: null, reasoning: null, basis: 'unknown' },
      searches: { count: null, basis: 'unknown' },
      pageReads: { count: null, basis: 'unknown' },
      billedUnits: [],
      cost: { micros: 5000, currency: 'USD', basis: 'estimated', estimatedBy: 'provider' },
    })
    expect(raw.evidence?.completion).toEqual({ status: 'complete', finishReason: null, upstreamStatus: null, upstreamRequestId: EXA_REQUEST_ID, upstreamJobId: null, error: null })
    expect(raw.evidence?.identity).toMatchObject({ disclosedModel: null, disclosedModelKind: null })
    expect(raw.servedModel).toBeUndefined()
    expect(raw.usage).toBeUndefined()
  })

  it('reads an answer without citations or a body request id as complete, with the header request id', async () => {
    const { run } = setup([{ headers: { 'x-request-id': 'header-request-7' }, json: { answer: EXA_ANSWER_TEXT } }])
    const raw = await run('fast')
    expect(raw.evidence?.sources).toEqual([])
    expect(raw.evidence?.retrievalStatus).toBe('unknown')
    expect(raw.evidence?.completion).toMatchObject({ status: 'complete', upstreamRequestId: 'header-request-7' })
    expect(raw.evidence?.usage.cost).toEqual({ micros: null, currency: 'USD', basis: 'unknown', estimatedBy: null })
  })

  it('fails a structured answer without turning it into text, and keeps its evidence', async () => {
    const { run } = setup([EXA_STRUCTURED_ANSWER])
    const error = await run('standard').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IncompleteAnswerError)
    const incomplete = error as IncompleteAnswerError
    expect(incomplete.answerText).toBeNull()
    expect(incomplete.evidence.completion).toMatchObject({
      status: 'failed',
      upstreamRequestId: EXA_REQUEST_ID,
      error: 'Exa returned a structured answer. Canonry sends no output schema and measures text answers only.',
    })
    expect(incomplete.evidence.sources).toHaveLength(3)
    expect(incomplete.evidence.usage.cost.basis).toBe('estimated')
  })
})

describe('Exa Answer errors and retries', () => {
  it.each([
    ['NO_MORE_CREDITS', 'Insufficient credits', 'The Exa account is out of credits. Exa said: Insufficient credits (NO_MORE_CREDITS)'],
    ['API_KEY_BUDGET_EXCEEDED', 'API key budget exceeded', 'This Exa key is over its spending budget. Exa said: API key budget exceeded (API_KEY_BUDGET_EXCEEDED)'],
    ['TEAM_BUDGET_EXCEEDED', 'Team budget exceeded', 'The Exa team is over its spending budget. Exa said: Team budget exceeded (TEAM_BUDGET_EXCEEDED)'],
  ])('explains a 402 %s as credits or budget and never retries it', async (tag, message, explained) => {
    const { stub, run } = setup([exaError(402, message, tag), { json: exaAnswerBody() }])
    const error = await run('standard').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AnswerServiceHttpError)
    expect((error as Error).message).toBe(`Exa request failed (HTTP 402): ${explained}`)
    expect((error as AnswerServiceHttpError).requestId).toBe(EXA_REQUEST_ID)
    expect(stub.calls).toHaveLength(1)
  })

  it('keeps an unrecognized tag as detail and does not retry a 500, which Exa does not say went unbilled', async () => {
    // Exa documents no tag for a plain 500 and says the tag set is open-ended;
    // this placeholder tag exercises the unrecognized-tag path.
    const { stub, run } = setup([exaError(500, 'Internal server error', 'UNRECOGNIZED_TAG'), { json: exaAnswerBody() }])
    const error = await run('standard').catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('Exa request failed (HTTP 500): Internal server error (UNRECOGNIZED_TAG)')
    expect(stub.calls).toHaveLength(1)
  })

  it('gives the research profile a five minute deadline and sends a query that hits it only once', async () => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout')
    let calls = 0
    const timedOut = (async () => {
      calls++
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as typeof fetch
    const { run } = setup([], timedOut)
    await expect(run('research')).rejects.toThrow('aborted due to timeout')
    expect(calls).toBe(1)
    expect(deadlines.mock.calls).toEqual([[300_000]])
  })
})
