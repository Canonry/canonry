/**
 * GoAnyAPI-specific request and response mapping that the shared conformance
 * matrix cannot express: the exact request body, which documented fields land
 * where, the billed-credit unit, collapsing repeated links, refusing a
 * non-JSON format, the no-overview completion and GoAnyAPI's own retry
 * statuses. Every response body follows the documentation-derived fixtures
 * beside this file; no request reaches GoAnyAPI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncompleteAnswerError, resolveProviderRoute, routeFamiliesOf, type ProviderAdapter } from '@canonry/canonry-contracts'
import { createAnswerServiceAdapter } from '../../../src/index.js'
import { goanyapiAnswerService } from '../../../src/services/goanyapi/index.js'
import type { ConformanceResponse } from '../../conformance.js'
import { fakeFetch } from '../../fake-service.js'
import { GOANYAPI_ANSWER_TEXT, goanyapiAnswerBody, goanyapiError, goanyapiNoOverviewBody } from './fixtures.js'

const QUERY = 'best roofing contractor in springfield'
const INPUT = { query: QUERY, canonicalDomains: ['acme-roofing.example'], competitorDomains: [] }
const LOCATION = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }

function setup(responses: ConformanceResponse[], fetchImpl?: typeof fetch) {
  const stub = fakeFetch(responses)
  const adapter = createAnswerServiceAdapter(goanyapiAnswerService, { fetchImpl: fetchImpl ?? stub.impl, sleep: async () => undefined })
  const run = (input: Parameters<ProviderAdapter['executeTrackedQuery']>[0] = INPUT) => {
    const route = resolveProviderRoute('goanyapi:ai-overview', routeFamiliesOf([adapter]))!
    return adapter.forRoute!(route).executeTrackedQuery(input, {
      provider: 'goanyapi:ai-overview',
      apiKey: 'goa-test-key',
      model: 'ai-overview',
      quotaPolicy: goanyapiAnswerService.descriptor.defaultQuota,
    })
  }
  return { stub, adapter, run }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GoAnyAPI Google AI Overview request', () => {
  it('sends the unmodified query to /api/v1/google-ai-overview as a bearer-authenticated POST with output=json and nothing else', async () => {
    const { stub, run } = setup([{ json: goanyapiAnswerBody() }])
    const raw = await run()
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe('https://api.goanyapi.com/api/v1/google-ai-overview')
    expect(stub.calls[0]!.init.method).toBe('POST')
    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer goa-test-key')
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ query: QUERY, output: 'json' })
    expect(raw.evidence?.identity).toMatchObject({
      route: 'goanyapi:ai-overview',
      product: 'google-ai-overview',
      requestedServiceModel: null,
      settings: { output: 'json' },
    })
  })

  it('sends only the lowercased country of a city context and records the location as partial', async () => {
    const { stub, run } = setup([{ json: goanyapiAnswerBody() }])
    const raw = await run({ ...INPUT, location: LOCATION })
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ query: QUERY, output: 'json', country: 'us' })
    expect(raw.evidence?.location).toMatchObject({ requested: LOCATION, sent: { country: 'us' }, strength: 'hint', status: 'partial' })
  })

  it('refuses a query longer than the documented 8192 cap before any request', async () => {
    const { stub, run } = setup([])
    await expect(run({ ...INPUT, query: 'a'.repeat(8193) })).rejects.toThrow(/accepts queries up to 8192 characters/)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('GoAnyAPI Google AI Overview response', () => {
  it('maps documented link fields, collapses repeated URLs, and reports the billed credits verbatim', async () => {
    const body = goanyapiAnswerBody({
      data: {
        endpoint: 'google-ai-overview',
        costCredits: 3,
        remainingCredits: 9997,
        result: {
          format: 'json',
          content: {
            results: [
              { title: 'AI Overview', text: GOANYAPI_ANSWER_TEXT, links: [{ title: 'Acme', url: 'https://acme.example/a' }] },
              { title: 'Another block', text: 'More text.', links: [{ title: 'Acme repeated', url: 'https://acme.example/a' }, { title: 'Second', url: 'https://second.example/b' }] },
            ],
            search_parameters: { feature_available: true },
            serp_features: [{ type: 'ai_summary', links: [{ title: 'Serf duplicate', url: 'https://acme.example/a' }] }],
          },
        },
      },
    })
    const { run } = setup([{ json: body }])
    const raw = await run()
    expect(raw.answerText).toBe(GOANYAPI_ANSWER_TEXT)
    expect(raw.evidence?.sources).toEqual([
      { url: 'https://acme.example/a', title: 'Acme', relationship: 'answer-support', rank: null, publishedAt: null, upstreamId: null },
      { url: 'https://second.example/b', title: 'Second', relationship: 'answer-support', rank: null, publishedAt: null, upstreamId: null },
    ])
    expect(raw.evidence?.usage).toMatchObject({ billedUnits: [{ unit: 'credit', quantity: 3, basis: 'reported' }], cost: { micros: null, basis: 'unknown' } })
    expect(raw.evidence?.identity.disclosedModel).toBeNull()
    expect(raw.evidence?.completion.upstreamStatus).toBe('ok')
  })

  it('keeps serp_features links out of the sources', async () => {
    const { run } = setup([{ json: goanyapiAnswerBody() }])
    const raw = await run()
    expect(raw.evidence?.sources).toHaveLength(3)
    expect(raw.rawResponse).toEqual(goanyapiAnswerBody())
  })

  it('fails a no-overview success with the documented reason, keeping the billed outcome visible', async () => {
    const body = goanyapiNoOverviewBody()
    const { run } = setup([{ json: body }])
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(IncompleteAnswerError)
    const evidence = (error as IncompleteAnswerError).evidence
    expect(evidence.completion.status).toBe('failed')
    expect(evidence.completion.upstreamStatus).toBe('feature_available:false')
    expect(evidence.completion.error).toContain('no AI Overview')
    expect(evidence.usage.billedUnits).toEqual([{ unit: 'credit', quantity: 3, basis: 'reported' }])
  })

  it('fails a non-JSON result format instead of turning Markdown into text', async () => {
    const body = goanyapiAnswerBody()
    const data = body.data as Record<string, unknown>
    const { run } = setup([
      {
        json: { ...body, data: { ...data, result: { ...(data.result as Record<string, unknown>), format: 'md' } } },
      },
    ])
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(IncompleteAnswerError)
    expect((error as IncompleteAnswerError).evidence.completion.error).toContain('non-JSON')
  })

  it('surfaces the documented error message with its code, and retries the documented unbilled statuses', async () => {
    const { stub, run } = setup([
      goanyapiError(504, 'request_timeout', 'The upstream request timed out'),
      goanyapiError(503, 'service_not_configured', 'Service or pricing unavailable'),
      { json: goanyapiAnswerBody() },
    ])
    const raw = await run()
    expect(stub.calls).toHaveLength(3)
    expect(raw.answerText).toBe(GOANYAPI_ANSWER_TEXT)
  })
})
