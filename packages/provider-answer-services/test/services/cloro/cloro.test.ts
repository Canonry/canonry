/**
 * cloro-specific request and response mapping that the shared conformance
 * matrix cannot express: the endpoint per surface, the required country and
 * its default, how pills and sources become citations and answer support,
 * the error explanations, and cloro's retry statuses. Every response body follows the documentation-derived fixtures
 * beside this file; no request reaches cloro.
 */
import { describe, expect, it } from 'vitest'
import { resolveProviderRoute, routeFamiliesOf, type ProviderAdapter } from '@canonry/canonry-contracts'
import { AnswerServiceHttpError, createAnswerServiceAdapter } from '../../../src/index.js'
import { cloroMonitorService } from '../../../src/services/cloro/index.js'
import type { ConformanceResponse } from '../../conformance.js'
import { fakeFetch } from '../../fake-service.js'
import {
  ACME_URL,
  aimodeBody,
  chatgptBody,
  CLORO_ANSWER_TEXT,
  CLORO_REQUEST_ID,
  cloroError,
  cloroSuccessHeaders,
  geminiBody,
  REVIEWS_URL,
  SUMMIT_URL,
} from './fixtures.js'

const QUERY = 'best roofing contractor in springfield'
const INPUT = { query: QUERY, canonicalDomains: ['acme-roofing.example'], competitorDomains: [] }
const LOCATION = { label: 'London', city: 'London', region: 'England', country: 'gb' }

function setup(responses: ConformanceResponse[]) {
  const stub = fakeFetch(responses)
  const adapter = createAnswerServiceAdapter(cloroMonitorService, { fetchImpl: stub.impl, sleep: async () => undefined })
  const run = (profile: string, input: Parameters<ProviderAdapter['executeTrackedQuery']>[0] = INPUT) => {
    const route = resolveProviderRoute(`cloro:${profile}`, routeFamiliesOf([adapter]))!
    return adapter.forRoute!(route).executeTrackedQuery(input, {
      provider: `cloro:${profile}`,
      apiKey: 'cloro-test-key',
      model: profile,
      quotaPolicy: cloroMonitorService.descriptor.defaultQuota,
    })
  }
  return { stub, adapter, run }
}

describe('cloro monitor request', () => {
  it.each([
    ['chatgpt', chatgptBody()],
    ['gemini', geminiBody()],
    ['aimode', aimodeBody()],
  ])('sends the unmodified query to /v1/monitor/%s with the default country and nothing else', async (profile, body) => {
    const { stub, run } = setup([{ headers: cloroSuccessHeaders(), json: body }])
    const raw = await run(profile)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe(`https://api.cloro.dev/v1/monitor/${profile}`)
    expect(stub.calls[0]!.init.method).toBe('POST')
    expect((stub.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer cloro-test-key')
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ prompt: QUERY, country: 'US' })
    expect(raw.answerText).toBe(CLORO_ANSWER_TEXT)
    expect(raw.evidence?.identity).toMatchObject({ route: `cloro:${profile}`, product: `monitor/${profile}`, requestedServiceModel: null, settings: {} })
    expect(raw.evidence?.location).toEqual({ requested: null, sent: null, strength: null, serviceDefault: { country: 'US' }, status: 'not-requested' })
  })

  it('sends the country of a city context in upper case and records the location as partial', async () => {
    const { stub, run } = setup([{ headers: cloroSuccessHeaders(), json: chatgptBody() }])
    const raw = await run('chatgpt', { ...INPUT, location: LOCATION })
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ prompt: QUERY, country: 'GB' })
    expect(raw.evidence?.location).toMatchObject({ requested: LOCATION, sent: { country: 'GB' }, strength: 'hint', status: 'partial' })
  })
})

describe('cloro monitor response', () => {
  it('keeps one explicit citation per pill URL, the sources rail as answer support, and the ChatGPT model', async () => {
    const body = chatgptBody()
    const { run } = setup([{ headers: cloroSuccessHeaders(), json: body }])
    const raw = await run('chatgpt')
    expect(raw.rawResponse).toEqual(body)
    expect(raw.evidence?.sources).toEqual([
      { url: ACME_URL, title: 'Roof repair and replacement services', relationship: 'explicit-citation', rank: null, publishedAt: '2026-08-21', upstreamId: null },
      { url: REVIEWS_URL, title: null, relationship: 'explicit-citation', rank: null, publishedAt: null, upstreamId: null },
      { url: ACME_URL, title: 'Roof repair and replacement services', relationship: 'answer-support', rank: null, publishedAt: 'August 21, 2026', upstreamId: null },
      { url: REVIEWS_URL, title: 'Best roofers in Springfield', relationship: 'answer-support', rank: null, publishedAt: null, upstreamId: null },
      { url: SUMMIT_URL, title: 'Summit Roof Co. projects', relationship: 'answer-support', rank: null, publishedAt: null, upstreamId: null },
    ])
    expect(raw.groundingSources.map(source => source.uri)).toEqual([ACME_URL, REVIEWS_URL, SUMMIT_URL])
    expect(raw.evidence?.completion).toEqual({ status: 'complete', finishReason: null, upstreamStatus: null, upstreamRequestId: CLORO_REQUEST_ID, upstreamJobId: null, error: null })
    expect(raw.evidence?.identity).toMatchObject({ disclosedModel: 'gpt-5-3', disclosedModelKind: 'foundation-model' })
    expect(raw.servedModel).toBe('gpt-5-3')
    expect(raw.evidence?.usage).toEqual({
      tokens: { input: null, output: null, reasoning: null, basis: 'unknown' },
      searches: { count: null, basis: 'unknown' },
      pageReads: { count: null, basis: 'unknown' },
      billedUnits: [],
      cost: { micros: null, currency: 'USD', basis: 'unknown', estimatedBy: null },
    })
  })

  // The docs say empty on the mobile-web format; a live response sent `null`.
  it.each([[''], [null]])('records no model when ChatGPT sends %j', async (model) => {
    const { run } = setup([{ headers: cloroSuccessHeaders(), json: chatgptBody({ model }) }])
    const raw = await run('chatgpt')
    expect(raw.evidence?.identity.disclosedModel).toBeNull()
    expect(raw.servedModel).toBeUndefined()
  })
})

describe('cloro monitor errors and retries', () => {
  it('explains INSUFFICIENT_CREDITS as an empty balance and never retries it', async () => {
    const { stub, run } = setup([cloroError(403, 'INSUFFICIENT_CREDITS', 'Insufficient credits'), { json: chatgptBody() }])
    const error = await run('chatgpt').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AnswerServiceHttpError)
    expect((error as Error).message).toBe('cloro request failed (HTTP 403): The cloro account is out of credits. cloro said: Insufficient credits (INSUFFICIENT_CREDITS)')
    expect((error as AnswerServiceHttpError).requestId).toBe(CLORO_REQUEST_ID)
    expect(stub.calls).toHaveLength(1)
  })

  it('names each failing field of a validation error', async () => {
    const { run } = setup([cloroError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      details: [{ field: 'country', message: 'This model is not available in this country.' }],
    })])
    const error = await run('gemini', { ...INPUT, location: LOCATION }).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('cloro request failed (HTTP 400): Request validation failed: country: This model is not available in this country. (VALIDATION_ERROR)')
  })

  it('does not retry a 500, which comes after cloro has already retried', async () => {
    const { stub, run } = setup([cloroError(500, 'INTERNAL_ERROR', 'Maximum retries exceeded'), { json: geminiBody() }])
    const error = await run('gemini').catch((caught: unknown) => caught)
    expect((error as AnswerServiceHttpError).status).toBe(500)
    expect(stub.calls).toHaveLength(1)
  })
})
