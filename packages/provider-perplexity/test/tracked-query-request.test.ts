import { test, expect, vi, afterEach } from 'vitest'

import { perplexityAdapter } from '../src/adapter.js'

// Pins the build/parse split of the sync path: the body `buildTrackedQueryRequest`
// returns is the JSON the SDK puts on the wire, and the sync result is exactly
// `parseTrackedQueryResponse` of the response it received.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'perplexity', apiKey: 'k', model: 'sonar-pro', quotaPolicy }
const QUERY = { query: 'best crm for agencies', canonicalDomains: ['example.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US' }

/** A Sonar chat completion shaped like a real one: citations, search results, and Perplexity's usage extras. */
const COMPLETION = {
  id: 'b7c1e2d4-5f60-4a1b-9c2d-3e4f5a6b7c8d',
  model: 'sonar-pro',
  created: 1758700000,
  object: 'chat.completion',
  usage: {
    prompt_tokens: 14,
    completion_tokens: 380,
    total_tokens: 394,
    search_context_size: 'low',
    citation_tokens: 2150,
    num_search_queries: 2,
  },
  citations: ['https://example.com/crm', 'https://other.example/crm'],
  search_results: [
    { title: 'Example CRM', url: 'https://example.com/crm', date: '2026-08-01' },
    { title: 'Other CRM', url: 'https://other.example/crm', date: null },
  ],
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Example CRM is popular with agencies.' } }],
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubChatCompletions(response: Record<string, unknown>): CapturedRequest[] {
  const sent: CapturedRequest[] = []
  // Stubbed before the client is constructed: the SDK captures fetch then.
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('buildTrackedQueryRequest returns the exact body the sync path sends', async () => {
  const sent = stubChatCompletions(COMPLETION)
  await perplexityAdapter.executeTrackedQuery(QUERY, CONFIG)

  const built = perplexityAdapter.buildTrackedQueryRequest!(QUERY, CONFIG)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(new URL(sent[0]!.url).pathname).toBe(built.endpoint)
  expect(built).toEqual({
    endpoint: '/chat/completions',
    body: { model: 'sonar-pro', messages: [{ role: 'user', content: 'best crm for agencies' }] },
  })
})

test('a location reaches the wire through the built body', async () => {
  const sent = stubChatCompletions(COMPLETION)
  const input = { ...QUERY, location: LOCATION }
  await perplexityAdapter.executeTrackedQuery(input, CONFIG)

  const built = perplexityAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.messages).toEqual([
    { role: 'user', content: 'best crm for agencies (searching from San Francisco, CA, US)' },
  ])
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  stubChatCompletions(COMPLETION)
  const viaSync = await perplexityAdapter.executeTrackedQuery(QUERY, CONFIG)
  const viaParse = perplexityAdapter.parseTrackedQueryResponse!(structuredClone(COMPLETION), 'sonar-pro')

  expect(viaSync).toEqual(viaParse)
  expect(viaParse.rawResponse).toEqual(COMPLETION)
  expect(viaParse.servedModel).toBe('sonar-pro')
  expect(viaParse.groundingSources).toEqual([
    { uri: 'https://example.com/crm', title: 'Example CRM' },
    { uri: 'https://other.example/crm', title: 'Other CRM' },
  ])
  expect(viaParse.retrievalStatus).toBe('unknown')
  expect(viaParse.retrievalContract).toBe('native-auto-v1')
})

test('parse reads tokens from the usage object and leaves searches at 0', () => {
  // Perplexity folds its search fee into per-request pricing rather than
  // billing each search, so `num_search_queries` is not a billable count.
  const raw = perplexityAdapter.parseTrackedQueryResponse!(structuredClone(COMPLETION), 'sonar-pro')
  expect(raw.usage).toEqual({
    inputTokens: 14,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 380,
    searchCount: 0,
  })
  expect(raw.stopReason).toBe('stop')
})

test('cached prompt tokens are split out of the input when reported', () => {
  const cached = {
    ...structuredClone(COMPLETION),
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 64 } },
  }
  expect(perplexityAdapter.parseTrackedQueryResponse!(cached, 'sonar-pro').usage).toEqual({
    inputTokens: 36,
    cachedInputTokens: 64,
    cacheWriteTokens: 0,
    outputTokens: 5,
    searchCount: 0,
  })
})

test('a response with no usage object has undefined usage', () => {
  const { usage: _usage, choices: _choices, ...bare } = structuredClone(COMPLETION)
  const raw = perplexityAdapter.parseTrackedQueryResponse!(bare, 'sonar-pro')
  expect(raw.usage).toBeUndefined()
  expect(raw.stopReason).toBeUndefined()
})
