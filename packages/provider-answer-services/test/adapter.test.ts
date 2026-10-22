import { describe, expect, it } from 'vitest'
import {
  ANSWER_SOURCE_EXCERPT_MAX_CHARS,
  ANSWER_SOURCE_MAX_EXCERPTS,
  answerEvidenceSchema,
  hasDirectCitedUrls,
  IncompleteAnswerError,
  resolveProviderRoute,
  routeFamiliesOf,
  type ProviderAdapter,
  type ProviderConfig,
} from '@canonry/canonry-contracts'
import { AnswerServiceHttpError, createAnswerServiceAdapter, MAX_STORED_RAW_BYTES, type AnswerServiceDefinition } from '../src/index.js'
import { createFakeAnswerServiceAdapter, fakeCompleteBody, fakeFetch, FAKE_SERVICE_ID, fakeServiceDefinition, fakeServiceDescriptor } from './fake-service.js'

const QUOTA = fakeServiceDescriptor.defaultQuota
const INPUT = { query: 'best roofing contractor near me', canonicalDomains: ['acme-roofing.example'], competitorDomains: [] }

function routeOf(adapter: ProviderAdapter, profile: string): ProviderAdapter {
  const route = resolveProviderRoute(`${FAKE_SERVICE_ID}:${profile}`, routeFamiliesOf([adapter]))!
  return adapter.forRoute!(route)
}

function config(profile: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { provider: `${FAKE_SERVICE_ID}:${profile}`, apiKey: 'test-key', model: profile, quotaPolicy: QUOTA, ...overrides }
}

function setup(responses: Parameters<typeof fakeFetch>[0]) {
  const stub = fakeFetch(responses)
  const adapter = createFakeAnswerServiceAdapter({ fetchImpl: stub.impl, sleep: async () => undefined })
  return { stub, adapter }
}

describe('answer service request', () => {
  it('sends the unmodified query to the fixed endpoint with the descriptor auth header and profile settings', async () => {
    const { stub, adapter } = setup([{ json: fakeCompleteBody() }])
    await routeOf(adapter, 'cited').executeTrackedQuery({ ...INPUT, location: { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' } }, config('cited'))
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe('https://api.fake-answers.example/v1/answer')
    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-fake-key']).toBe('test-key')
    expect(headers.Authorization).toBeUndefined()
    // A country-only profile sends the country and nothing it cannot honour.
    expect(JSON.parse(String(stub.calls[0]!.init.body))).toEqual({ query: INPUT.query, tier: 'fake-tier', depth: 'standard', maxResults: 5, location: { country: 'US' } })
  })

  it('refuses the bare connection, a base URL, an overridden profile and a job profile before any request', async () => {
    const { stub, adapter } = setup([{ json: fakeCompleteBody() }])
    await expect(adapter.executeTrackedQuery(INPUT, { provider: FAKE_SERVICE_ID, apiKey: 'test-key', quotaPolicy: QUOTA })).rejects.toThrow('the connection alone is not an engine')
    await expect(routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited', { baseUrl: 'https://elsewhere.example' }))).rejects.toThrow('fixed endpoint')
    await expect(routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited', { model: 'results' }))).rejects.toThrow('cannot be overridden')
    await expect(routeOf(adapter, 'job').executeTrackedQuery(INPUT, config('job'))).rejects.toThrow('cannot run yet')
    expect(stub.calls).toHaveLength(0)
  })
})

describe('answer service retries', () => {
  it('retries a documented throttle status, honouring Retry-After, and nothing else', async () => {
    const retried = setup([{ status: 503, headers: { 'retry-after': '0' }, json: { error: { message: 'busy' } } }, { json: fakeCompleteBody() }])
    await routeOf(retried.adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(retried.stub.calls).toHaveLength(2)

    // A 502 is not in the descriptor's list: a paid answer request is never retried on it.
    const notRetried = setup([{ status: 502, json: { error: { message: 'bad gateway' } } }, { json: fakeCompleteBody() }])
    const error = await routeOf(notRetried.adapter, 'cited').executeTrackedQuery(INPUT, config('cited')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AnswerServiceHttpError)
    expect((error as Error).message).toBe('Fake Answers request failed (HTTP 502): bad gateway')
    expect(notRetried.stub.calls).toHaveLength(1)
  })

  it('never retries a dropped connection, which may already have been billed', async () => {
    let calls = 0
    const adapter = createFakeAnswerServiceAdapter({
      fetchImpl: (async () => { calls++; throw new TypeError('fetch failed') }) as typeof fetch,
      sleep: async () => undefined,
    })
    await expect(routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))).rejects.toThrow('fetch failed')
    expect(calls).toBe(1)
  })
})

describe('answer service streams', () => {
  const sse = (events: Array<[string, unknown]>) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')

  it('reads a stream that reaches its final event as a complete answer', async () => {
    const { adapter } = setup([{ sse: sse([['delta', { text: 'Acme ' }], ['citation', { url: 'https://acme-roofing.example/', number: 1 }], ['delta', { text: 'is good [1].' }], ['done', { finish_reason: 'stop', cost_usd: 0.002 }]]) }])
    const route = routeOf(adapter, 'stream')
    const raw = await route.executeTrackedQuery(INPUT, config('stream'))
    expect(route.normalizeResult(raw)).toMatchObject({ answerText: 'Acme is good [1].', citedDomains: ['acme-roofing.example'] })
    expect(raw.evidence?.usage.cost).toEqual({ micros: 2000, currency: 'USD', basis: 'reported', estimatedBy: null })
    expect(raw.rawResponse).toMatchObject({ ended: 'terminal' })
  })

  it('treats a stream that ends before its final event as partial, never complete', async () => {
    const { adapter } = setup([{ sse: sse([['delta', { text: 'Acme is' }]]) }])
    const error = await routeOf(adapter, 'stream').executeTrackedQuery(INPUT, config('stream')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IncompleteAnswerError)
    const incomplete = error as IncompleteAnswerError
    expect(incomplete.evidence.completion.status).toBe('partial')
    expect(incomplete.answerText).toBe('Acme is')
  })
})

describe('answer service evidence', () => {
  it('fails a complete status that carries no answer text', async () => {
    const { adapter } = setup([{ json: fakeCompleteBody({ answer: '   ' }) }])
    const error = await routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited')).catch((caught: unknown) => caught)
    expect((error as IncompleteAnswerError).evidence.completion).toMatchObject({ status: 'failed', error: 'The response carried no answer text.' })
  })

  it('stores a marker instead of a raw payload over the size cap and says so', async () => {
    const { adapter } = setup([{ json: fakeCompleteBody({ padding: 'x'.repeat(MAX_STORED_RAW_BYTES) }) }])
    const raw = await routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(raw.rawResponse).toMatchObject({ truncated: true })
    expect(raw.evidence?.rawTruncated).toBe(true)
    expect(raw.answerText).toBe('Acme Roofing is a strong choice [1].')
  })

  it('records reported tokens as usage and leaves usage unset when tokens are unknown', async () => {
    const reported = setup([{ json: fakeCompleteBody({ usage: { input_tokens: 12, output_tokens: 30 } }) }])
    const withTokens = await routeOf(reported.adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(withTokens.usage).toEqual({ inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 30, searchCount: 1 })
    const unknown = setup([{ json: fakeCompleteBody() }])
    expect((await routeOf(unknown.adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))).usage).toBeUndefined()
  })

  it('leaves usage unset when tokens are reported but the search count is not, never a measured zero', async () => {
    const { adapter } = setup([{ json: fakeCompleteBody({ usage: { input_tokens: 10, output_tokens: 20 }, searches: undefined }) }])
    const raw = await routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(raw.evidence?.usage.tokens).toEqual({ input: 10, output: 20, reasoning: null, basis: 'reported' })
    expect(raw.evidence?.usage.searches).toEqual({ count: null, basis: 'unknown' })
    expect(raw.usage).toBeUndefined()
  })

  it('caps the number and length of excerpts once, in the shared layer, and says it did', async () => {
    const long = 'p'.repeat(ANSWER_SOURCE_EXCERPT_MAX_CHARS + 500)
    const definition: AnswerServiceDefinition = {
      ...fakeServiceDefinition,
      parseResponse: (body, context) => {
        const parsed = fakeServiceDefinition.parseResponse!(body, context)
        return {
          ...parsed,
          sources: parsed.sources.map((source, index) => index === 0
            ? { ...source, excerpts: Array.from({ length: ANSWER_SOURCE_MAX_EXCERPTS + 5 }, (_, item) => item === 0 ? long : `passage ${item}`) }
            : { ...source, excerpts: ['short passage', 'another passage'] }),
        }
      },
    }
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const adapter = createAnswerServiceAdapter(definition, { fetchImpl: stub.impl, sleep: async () => undefined })
    const raw = await routeOf(adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    const evidence = answerEvidenceSchema.parse(raw.evidence)
    const [capped, untouched] = evidence.sources
    expect(capped!.excerpts).toHaveLength(ANSWER_SOURCE_MAX_EXCERPTS)
    expect(capped!.excerpts![0]).toBe(long.slice(0, ANSWER_SOURCE_EXCERPT_MAX_CHARS))
    expect(capped!.excerpts![1]).toBe('passage 1')
    expect(capped!.excerptsTruncated).toBe(true)
    // Passages within the bounds keep their boundaries and are not marked.
    expect(untouched!.excerpts).toEqual(['short passage', 'another passage'])
    expect(untouched!.excerptsTruncated).toBeUndefined()
  })

  it('records whether source URLs are the pages themselves, so redirect links are never cited page URLs', async () => {
    const direct = await routeOf(setup([{ json: fakeCompleteBody() }]).adapter, 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(direct.evidence?.directSourceUrls).toBe(true)
    expect(hasDirectCitedUrls(direct.evidence!)).toBe(true)

    const cited = fakeServiceDescriptor.profiles.find(profile => profile.id === 'cited')!
    const redirecting: AnswerServiceDefinition = {
      ...fakeServiceDefinition,
      descriptor: {
        ...fakeServiceDescriptor,
        profiles: [{ ...cited, capabilities: { ...cited.capabilities, evidence: { ...cited.capabilities.evidence, directUrls: false } } }],
      },
    }
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const raw = await routeOf(createAnswerServiceAdapter(redirecting, { fetchImpl: stub.impl, sleep: async () => undefined }), 'cited').executeTrackedQuery(INPUT, config('cited'))
    expect(raw.evidence).toMatchObject({ citationMeasurable: true, directSourceUrls: false })
    expect(hasDirectCitedUrls(raw.evidence!)).toBe(false)
  })

  it('records a country the vendor cannot take as ignored and keeps it out of the request', async () => {
    const dublin = { label: 'Dublin', city: 'Dublin', region: 'Leinster', country: 'IE' }
    const { stub, adapter } = setup([{ json: fakeCompleteBody() }])
    const raw = await routeOf(adapter, 'cited').executeTrackedQuery({ ...INPUT, location: dublin }, config('cited'))
    expect(JSON.parse(String(stub.calls[0]!.init.body))).not.toHaveProperty('location')
    expect(raw.evidence?.location).toEqual({ requested: dublin, sent: null, strength: null, serviceDefault: null, status: 'ignored' })
  })

  it('records what the builder sent on a full-granularity profile, so a dropped field is partial', async () => {
    const dublin = { label: 'Dublin', city: 'Dublin', region: 'Leinster', country: 'IE' }
    const done = 'event: delta\ndata: {"text":"Acme is good."}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n'
    const { stub, adapter } = setup([{ sse: done }])
    const raw = await routeOf(adapter, 'stream').executeTrackedQuery({ ...INPUT, location: dublin }, config('stream'))
    expect(JSON.parse(String(stub.calls[0]!.init.body)).location).toEqual({ region: 'Leinster', city: 'Dublin' })
    expect(raw.evidence?.location).toMatchObject({ status: 'partial', sent: { region: 'Leinster', city: 'Dublin' } })
  })

  it('refuses a builder that reports a location field the profile does not offer, before any request', async () => {
    const definition: AnswerServiceDefinition = {
      ...fakeServiceDefinition,
      buildRequest: input => ({ ...fakeServiceDefinition.buildRequest(input), sentLocation: { country: 'US', city: 'Springfield' } }),
    }
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const adapter = createAnswerServiceAdapter(definition, { fetchImpl: stub.impl, sleep: async () => undefined })
    const location = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }
    await expect(routeOf(adapter, 'cited').executeTrackedQuery({ ...INPUT, location }, config('cited'))).rejects.toThrow('does not offer: city')
    expect(stub.calls).toHaveLength(0)
  })

  it('applies a full location only on a full-granularity profile', async () => {
    const location = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }
    const { adapter } = setup([{ json: fakeCompleteBody() }])
    const raw = await routeOf(adapter, 'cited').executeTrackedQuery({ ...INPUT, location }, config('cited'))
    expect(raw.evidence?.location).toMatchObject({ status: 'partial', sent: { country: 'US' }, strength: 'hint' })
    expect(routeOf(adapter, 'cited').supportsLocationContext).toBe(false)
    expect(routeOf(adapter, 'stream').supportsLocationContext).toBe(true)
  })
})

describe('answer service key check', () => {
  it('saves a key without spending when the service documents no free key check', async () => {
    const { stub, adapter } = setup([{ json: {} }])
    const result = await adapter.healthcheck({ provider: FAKE_SERVICE_ID, apiKey: 'test-key', quotaPolicy: QUOTA })
    expect(result).toEqual({ ok: true, provider: FAKE_SERVICE_ID, message: 'Fake Answers key saved, not verified: the service documents no free key check.' })
    expect(stub.calls).toHaveLength(0)
  })
})
