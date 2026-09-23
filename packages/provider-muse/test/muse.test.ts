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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test('tracked query uses Meta Responses search with unchanged query and approximate location', async () => {
  vi.stubEnv('OPENAI_ORG_ID', 'org-openai-only')
  vi.stubEnv('OPENAI_PROJECT_ID', 'proj-openai-only')
  const calls: Array<{ url: string; request: Record<string, unknown>; authorization: string | null; openaiScope: Array<string | null> }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init)
    calls.push({
      url: request.url,
      request: await request.json() as Record<string, unknown>,
      authorization: request.headers.get('authorization'),
      openaiScope: [request.headers.get('openai-organization'), request.headers.get('openai-project')],
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
  expect(calls[0].openaiScope).toEqual([null, null])
  expect(calls[0].request).toEqual({
    model: 'muse-spark-1.3',
    input: 'best Tirana cafes',
    tools: [{ type: 'web_search', user_location: { type: 'approximate', city: 'Tirana', region: 'Tirana', country: 'AL', timezone: 'Europe/Tirane' } }],
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

test('commentary messages are not answer evidence and final messages stay separated', () => {
  const parsed = reparseStoredResult({ status: 'completed', output: [
    { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking reviews for Northstar', annotations: [
      { type: 'url_citation', url: 'https://northstar.example/reviews' },
    ] }] },
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'Acme leads.' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'Beta follows.', annotations: [
      { type: 'url_citation', url: 'https://beta.example/a' },
    ] }] },
  ] })
  expect(parsed).toEqual({
    provider: 'muse', answerText: 'Acme leads.\n\nBeta follows.', citedDomains: ['beta.example'],
    groundingSources: [{ uri: 'https://beta.example/a', title: '' }], searchQueries: [], retrievalStatus: 'used',
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

const citedMessage = { type: 'message', content: [{ type: 'output_text', text: 'Example is cited.', annotations: [
  { type: 'url_citation', url: 'https://example.com/page' },
] }] }
const refusalMessage = { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer.' }] }
const emptyEvidence = {
  provider: 'muse', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown',
}

test('failed and malformed stored responses do not become visibility evidence', () => {
  for (const response of [
    { status: 'failed', output: [citedMessage] },
    { status: 'in_progress', output: [citedMessage] },
    { status: 'completed', output: [{ ...citedMessage, status: 'in_progress' }] },
    { status: 'completed', output: [citedMessage, null] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] },
  ]) {
    expect(reparseStoredResult(response)).toEqual(emptyEvidence)
  }
})

test('refused and truncated responses keep the answer evidence they carry', () => {
  const cited = {
    provider: 'muse', answerText: 'Example is cited.', citedDomains: ['example.com'],
    groundingSources: [{ uri: 'https://example.com/page', title: '' }], searchQueries: [], retrievalStatus: 'not-used',
  }
  for (const response of [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [citedMessage] },
    { status: 'completed', output: [{ ...citedMessage, status: 'incomplete' }] },
    { status: 'completed', output: [citedMessage, refusalMessage] },
  ]) {
    expect(reparseStoredResult(response)).toEqual(cited)
  }
  expect(reparseStoredResult({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, refusalMessage] }))
    .toEqual(emptyEvidence)
})

const helloQuery = { query: 'hello', canonicalDomains: [], competitorDomains: [] }

test('HTTP 200 incomplete and refusal responses are stored as observations', async () => {
  let calls = 0
  const partial = { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Partial citation.', annotations: [{ type: 'url_citation', url: 'https://example.com' }] }] },
  ] }
  vi.stubGlobal('fetch', async () => { calls++; return fakeResponse(partial) })
  const truncated = museAdapter.normalizeResult(await museAdapter.executeTrackedQuery(helloQuery, config))
  expect(truncated).toMatchObject({ answerText: 'Partial citation.', citedDomains: ['example.com'] })
  expect(calls).toBe(1)
  await expect(museAdapter.generateText('hello', config)).rejects.toThrow(/response status: incomplete \(content_filter\)/)

  vi.stubGlobal('fetch', async () => fakeResponse({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot answer.' }] },
  ] }))
  const refused = await museAdapter.executeTrackedQuery(helloQuery, config)
  expect(museAdapter.normalizeResult(refused)).toEqual(emptyEvidence)
})

test('HTTP 200 failed responses surface the error code and retry only a throttle', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    return fakeResponse({ status: 'failed', error: { code: 'invalid_prompt', message: 'Prompt rejected' }, output: [] })
  })
  await expect(museAdapter.executeTrackedQuery(helloQuery, config))
    .rejects.toThrow('[provider-muse] Meta Model API response status: failed (invalid_prompt: Prompt rejected)')
  expect(calls).toBe(1)

  calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    if (calls === 1) return fakeResponse({ status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Slow down' }, output: [] })
    return fakeResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })
  })
  const raw = await museAdapter.executeTrackedQuery(helloQuery, config)
  expect(museAdapter.normalizeResult(raw).answerText).toBe('ok')
  expect(calls).toBe(2)
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

test('config validation rejects a blank key and non-Spark models before any request', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; return fakeResponse({}) })
  expect(validateConfig({ ...toMuseConfig(config), apiKey: '  ' })).toEqual({ ok: false, provider: 'muse', message: 'missing api key' })
  expect(validateConfig({ ...toMuseConfig(config), model: 'muse-image-1.0' }))
    .toEqual({ ok: false, provider: 'muse', message: 'model must be a Muse Spark text model' })
  await expect(museAdapter.executeTrackedQuery(helloQuery, { ...config, apiKey: '' })).rejects.toThrow('[provider-muse] missing api key')
  await expect(museAdapter.generateText('hello', { ...config, model: 'muse-image-1.0' }))
    .rejects.toThrow('[provider-muse] model must be a Muse Spark text model')
  expect((await museAdapter.healthcheck({ ...config, apiKey: '' })).ok).toBe(false)
  expect(calls).toBe(0)
})

test('model discovery makes only a metadata request and filters to Standard Spark text models', async () => {
  vi.stubEnv('OPENAI_ORG_ID', 'org-openai-only')
  const requests: Array<{ method: string; url: string; organization: string | null }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init)
    requests.push({ method: request.method, url: request.url, organization: request.headers.get('openai-organization') })
    return fakeResponse({ object: 'list', data: [
      { id: 'muse-spark-1.3', object: 'model' },
      { id: 'muse-spark-1.3-contributor', object: 'model' },
      { id: 'muse-image-1.0', object: 'model' },
      { id: 'muse-spark-1.2', object: 'model' },
      { id: 'muse-spark-1.4-Preview', object: 'model' },
      { id: 'muse-spark-next', object: 'model' },
    ] })
  })
  const models = await museAdapter.listModels?.(config, new AbortController().signal)
  expect(requests).toEqual([{ method: 'GET', url: 'https://api.meta.ai/v1/models', organization: null }])
  expect(models).toEqual([
    { id: 'muse-spark-1.3', displayName: 'muse-spark-1.3', tier: 'standard' },
    { id: 'muse-spark-1.2', displayName: 'muse-spark-1.2', tier: 'standard' },
    { id: 'muse-spark-next', displayName: 'muse-spark-next', tier: 'standard' },
  ])
})

test('authentication errors are surfaced with provider context and not retried', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    return fakeResponse({ error: { message: 'invalid key', type: 'authentication_error' } }, 401)
  })
  await expect(museAdapter.executeTrackedQuery({ query: 'hello', canonicalDomains: [], competitorDomains: [] }, config))
    .rejects.toThrow(/\[provider-muse\].*invalid key/)
  expect(calls).toBe(1)
})

test('persistent rate limits stop at the shared retry budget without SDK retry stacking', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' },
    })
  })
  await expect(museAdapter.executeTrackedQuery(helloQuery, config)).rejects.toThrow(/\[provider-muse\]/)
  expect(calls).toBe(4)
})

test('a Retry-After beyond the ceiling fails the query instead of waiting it out', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'daily quota' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' },
    })
  })
  await expect(museAdapter.executeTrackedQuery(helloQuery, config)).rejects.toThrow(/\[provider-muse\]/)
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
