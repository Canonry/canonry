import { afterEach, expect, test, vi } from 'vitest'
import { extractServedModel, museAdapter, reparseStoredResult, toMuseConfig, validateConfig } from '../src/index.js'

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const config = { provider: 'muse', apiKey: 'test-key', quotaPolicy }

function fakeResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
  return new Request(input, init)
}

afterEach(() => vi.unstubAllGlobals())

test('tracked query uses Meta Responses search with unchanged query and approximate location', async () => {
  const calls: Array<{ url: string; request: Record<string, unknown>; authorization: string | null }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init)
    calls.push({
      url: request.url,
      request: await request.json() as Record<string, unknown>,
      authorization: request.headers.get('authorization'),
    })
    return fakeResponse({
      id: 'resp_1', status: 'completed', model: 'muse-spark-1.3',
      output: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['best Tirana cafes'] }, results: [{ url: 'https://retrieved.example.com' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Try Cafe A.', annotations: [{ type: 'url_citation', url: 'https://cafe.example.com/a', title: 'Cafe A' }] }] },
      ],
    })
  })
  const raw = await museAdapter.executeTrackedQuery({
    query: 'best Tirana cafes',
    canonicalDomains: ['example.com'],
    competitorDomains: [],
    location: { label: 'Tirana', city: 'Tirana', region: 'Tirana', country: 'AL', timezone: 'Europe/Tirane' },
  }, config)
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('https://api.meta.ai/v1/responses')
  expect(calls[0].authorization).toBe('Bearer test-key')
  expect(calls[0].request).toEqual({
    model: 'muse-spark-1.3',
    input: 'best Tirana cafes',
    tools: [{ type: 'web_search', user_location: { type: 'approximate', city: 'Tirana', region: 'Tirana', country: 'AL', timezone: 'Europe/Tirane' } }],
    include: ['web_search_call.results'],
  })
  expect(raw.retrievalContract).toBe('native-auto-v1')
  expect(raw.retrievalStatus).toBe('used')
  expect(raw.servedModel).toBe('muse-spark-1.3')
  expect(raw.groundingSources).toEqual([{ uri: 'https://cafe.example.com/a', title: 'Cafe A' }])
  expect(museAdapter.normalizeResult(raw)).toEqual({
    provider: 'muse', answerText: 'Try Cafe A.', citedDomains: ['cafe.example.com'],
    groundingSources: [{ uri: 'https://cafe.example.com/a', title: 'Cafe A' }],
    searchQueries: ['best Tirana cafes'], retrievalStatus: 'used',
  })
})

test('parses interleaved blocks, deduplicates citations, and ignores uncited retrieved hits', () => {
  const parsed = reparseStoredResult({
    status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { query: 'alpha', queries: ['alpha', 'beta'] }, results: [{ url: 'https://uncited.example.com' }] },
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [
        { type: 'output_text', text: 'First.', annotations: [
          { type: 'url_citation', url: 'https://www.example.com/a', title: 'First' },
          { type: 'url_citation', url: 'https://www.example.com/a', title: 'Repeated' },
          { type: 'url_citation', url: 'ftp://invalid.example.com' },
          { type: 'url_citation', url: 'not a URL' },
        ] },
        { type: 'output_text', text: ' Second.', annotations: [
          { type: 'url_citation', url: 'https://sub.example.com/b', title: 'Second' },
        ] },
      ] },
    ],
  })
  expect(parsed).toEqual({
    provider: 'muse', answerText: 'First. Second.',
    citedDomains: ['example.com', 'sub.example.com'],
    groundingSources: [
      { uri: 'https://www.example.com/a', title: 'First' },
      { uri: 'https://sub.example.com/b', title: 'Second' },
    ],
    searchQueries: ['alpha', 'beta'], retrievalStatus: 'used',
  })
})

test('search without citations stays a searched answer with zero cited domains', () => {
  const parsed = reparseStoredResult({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', results: [{ url: 'https://only-retrieved.example.com' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'An answer.', annotations: [] }] },
  ] })
  expect(parsed.retrievalStatus).toBe('used')
  expect(parsed.citedDomains).toEqual([])
  expect(parsed.groundingSources).toEqual([])
})

test('preserves cited source evidence but excludes Meta AI self-domain from cited domains', () => {
  const parsed = reparseStoredResult({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Meta says so.', annotations: [
      { type: 'url_citation', url: 'https://www.meta.ai/article', title: 'Meta AI' },
    ] }] },
  ] })
  expect(parsed.groundingSources).toEqual([{ uri: 'https://www.meta.ai/article', title: 'Meta AI' }])
  expect(parsed.citedDomains).toEqual([])
})

test('retrieval requires successful search evidence or an intact unsearched answer', () => {
  expect(reparseStoredResult({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Paris.' }] },
  ] }).retrievalStatus).toBe('not-used')
  expect(reparseStoredResult({ status: 'completed', output: [
    { type: 'web_search_call', status: 'failed' },
    { type: 'message', content: [{ type: 'output_text', text: 'Fallback.' }] },
  ] }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ status: 'failed', output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: 'Partial.' }] },
  ] }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ status: 'completed', output: [] }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: '' }] },
  ] }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Paris.' }] },
    null,
  ] }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ output: 'malformed' }).retrievalStatus).toBe('unknown')
})

test('partial, malformed, and refused stored responses do not become visibility evidence', () => {
  const citation = { type: 'url_citation', url: 'https://example.com/page' }
  const message = { type: 'message', content: [{ type: 'output_text', text: 'Example is cited.', annotations: [citation] }] }
  for (const response of [
    { status: 'incomplete', output: [message] },
    { status: 'failed', output: [message] },
    { status: 'completed', output: [{ ...message, status: 'incomplete' }] },
    { status: 'completed', output: [message, null] },
    { status: 'completed', output: [message, { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer.' }] }] },
  ]) {
    expect(reparseStoredResult(response)).toEqual({
      provider: 'muse', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown',
    })
  }
})

test('HTTP 200 incomplete and refusal responses fail the tracked query without a successful snapshot', async () => {
  let calls = 0
  const partial = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Partial citation.', annotations: [{ type: 'url_citation', url: 'https://example.com' }] }] },
  ] }
  vi.stubGlobal('fetch', async () => { calls++; return fakeResponse(partial) })
  await expect(museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config))
    .rejects.toThrow(/response status: incomplete/)
  expect(calls).toBe(1)

  vi.stubGlobal('fetch', async () => fakeResponse({ status: 'completed', output: [
    { type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot answer.' }] },
  ] }))
  await expect(museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config))
    .rejects.toThrow(/no complete answer/)
})

test('healthcheck and generateText omit web search', async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(await requestOf(input, init).json() as Record<string, unknown>)
    return fakeResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })
  })
  expect((await museAdapter.healthcheck(config)).ok).toBe(true)
  expect(await museAdapter.generateText('hello', config)).toBe('ok')
  expect(requests).toEqual([
    { model: 'muse-spark-1.3', input: 'Say "ok"' },
    { model: 'muse-spark-1.3', input: 'hello' },
  ])
})

test('preserves response model and allows explicit contributor variants', async () => {
  vi.stubGlobal('fetch', async () => fakeResponse({ status: 'completed', model: 'muse-spark-1.2', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ] }))
  const raw = await museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config)
  expect(raw.model).toBe('muse-spark-1.3')
  expect(raw.servedModel).toBe('muse-spark-1.2')
  expect(extractServedModel({ status: 'completed' })).toBeUndefined()
  expect(validateConfig({ ...toMuseConfig(config), model: 'muse-spark-1.3-contributor' }).ok).toBe(true)
})

test('model discovery makes only a metadata request and filters to Standard Spark text models', async () => {
  const requests: Array<{ method: string; url: string }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init)
    requests.push({ method: request.method, url: request.url })
    return fakeResponse({ object: 'list', data: [
      { id: 'muse-spark-1.3', object: 'model' },
      { id: 'muse-spark-1.3-contributor', object: 'model' },
      { id: 'muse-image-1.0', object: 'model' },
      { id: 'muse-spark-1.2', object: 'model' },
      { id: 'muse-spark-next', object: 'model' },
    ] })
  })
  const models = await museAdapter.listModels?.(config, new AbortController().signal)
  expect(requests).toEqual([{ method: 'GET', url: 'https://api.meta.ai/v1/models' }])
  expect(models).toEqual([
    { id: 'muse-spark-1.3', displayName: 'muse-spark-1.3', tier: 'standard' },
    { id: 'muse-spark-1.2', displayName: 'muse-spark-1.2', tier: 'standard' },
    { id: 'muse-spark-next', displayName: 'muse-spark-next', tier: 'standard' },
  ])
})

test('transport errors are surfaced with provider context without SDK retry stacking', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    return fakeResponse({ error: { message: 'invalid key', type: 'authentication_error' } }, 401)
  })
  await expect(museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config))
    .rejects.toThrow(/\[provider-muse\].*invalid key/)
  expect(calls).toBe(1)
})

test('rate limit response uses shared retry and honors Retry-After', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      })
    }
    return fakeResponse({ status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
    ] })
  })
  const raw = await museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config)
  expect(raw.retrievalStatus).toBe('not-used')
  expect(calls).toBe(2)
})
