import { readFileSync } from 'node:fs'
import { test, expect, vi, afterEach } from 'vitest'

import { perplexityAdapter } from '../src/adapter.js'

// Pins the build/parse split of the sync path: the body `buildTrackedQueryRequest`
// returns is the JSON the SDK puts on the wire to `POST /v1/agent`, and the sync
// result is exactly `parseTrackedQueryResponse` of the response it received.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'perplexity', apiKey: 'k', model: 'sonar-pro', quotaPolicy }
const QUERY = { query: 'best crm for startups', canonicalDomains: ['hubspot.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US', timezone: 'America/Los_Angeles' }

// Schema-derived Agent API responses (see test/fixtures/README.md).
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
}

/**
 * The cited `fast` answer with the usage block the Agent API documents in full:
 * a cache read and a cache write broken out of `input_tokens`, and the billed
 * `web_search` invocations under `tool_calls_details`.
 */
function answerWithFullUsage(): Record<string, unknown> {
  return {
    ...fixture('agent-fast-cited'),
    usage: {
      input_tokens: 1843,
      input_tokens_details: { cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
      output_tokens: 57,
      total_tokens: 1900,
      tool_calls_details: { web_search: { invocation: 2 } },
      cost: { currency: 'USD', input_cost: 0.0018, output_cost: 0.0001, tool_calls_cost: 0.01, total_cost: 0.0119 },
    },
  }
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubAgent(response: Record<string, unknown>): CapturedRequest[] {
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
  const sent = stubAgent(fixture('agent-fast-cited'))
  await perplexityAdapter.executeTrackedQuery(QUERY, CONFIG)

  const built = perplexityAdapter.buildTrackedQueryRequest!(QUERY, CONFIG)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(new URL(sent[0]!.url).pathname).toBe(built.endpoint)
  // A retired Sonar id is sent as the preset it resolves to.
  expect(built).toEqual({
    endpoint: '/v1/agent',
    body: {
      preset: 'low',
      input: 'best crm for startups',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
    },
  })
})

test.each([
  ['fast', { preset: 'fast' }],
  ['perplexity/sonar', { model: 'perplexity/sonar' }],
  ['anthropic/claude-sonnet-4-6', { model: 'anthropic/claude-sonnet-4-6', max_output_tokens: 4096 }],
])('the built body for %s selects the engine exactly as the wire does', async (model, selection) => {
  const sent = stubAgent(fixture('agent-fast-cited'))
  const config = { ...CONFIG, model }
  await perplexityAdapter.executeTrackedQuery(QUERY, config)

  const built = perplexityAdapter.buildTrackedQueryRequest!(QUERY, config)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body).toEqual({
    ...selection,
    input: 'best crm for startups',
    tools: [{ type: 'web_search' }],
    tool_choice: { type: 'web_search' },
  })
})

test('a location reaches the wire through the built body, on the search tool', async () => {
  const sent = stubAgent(fixture('agent-fast-cited'))
  const input = { ...QUERY, location: LOCATION }
  await perplexityAdapter.executeTrackedQuery(input, CONFIG)

  const built = perplexityAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.input).toBe('best crm for startups')
  expect(built.body.tools).toEqual([
    { type: 'web_search', user_location: { city: 'San Francisco', region: 'CA', country: 'US' } },
  ])
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  const response = answerWithFullUsage()
  stubAgent(response)
  const viaSync = await perplexityAdapter.executeTrackedQuery(QUERY, CONFIG)
  const viaParse = perplexityAdapter.parseTrackedQueryResponse!(structuredClone(response), 'low')

  expect(viaSync).toEqual(viaParse)
  expect(viaParse.rawResponse).toEqual(response)
  expect(viaParse.model).toBe('low')
  expect(viaParse.servedModel).toBe('perplexity/sonar')
  expect(viaParse.groundingSources).toEqual([
    { uri: 'https://www.hubspot.com/products/crm/startups', title: 'HubSpot for Startups' },
    { uri: 'https://blog.example.com/startup-crm-guide', title: 'The startup CRM guide' },
    { uri: 'https://pipedrive.com/en/blog/crm-for-startups', title: 'CRM for startups' },
  ])
  expect(viaParse.searchQueries).toEqual(['best crm for startups', 'startup crm comparison 2026'])
  expect(viaParse.retrievalStatus).toBe('used')
  expect(viaParse.retrievalContract).toBe('search-required-v1')
})

test('parse records the model a retired id resolves to, as the sync path does', () => {
  const raw = perplexityAdapter.parseTrackedQueryResponse!(fixture('agent-fast-cited'), 'sonar')
  expect(raw.model).toBe('fast')
})

test('parse splits cache reads and writes out of input tokens and counts billed web_search invocations', () => {
  const raw = perplexityAdapter.parseTrackedQueryResponse!(answerWithFullUsage(), 'fast')
  expect(raw.usage).toEqual({
    inputTokens: 1343,
    cachedInputTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 57,
    searchCount: 2,
  })
  expect(raw.stopReason).toBe('completed')
})

test('without tool_calls_details, each search_results item counts as one executed search', () => {
  expect(perplexityAdapter.parseTrackedQueryResponse!(fixture('agent-fast-cited'), 'fast').usage).toEqual({
    inputTokens: 1843,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 57,
    searchCount: 1,
  })
  expect(perplexityAdapter.parseTrackedQueryResponse!(fixture('agent-no-search'), 'fast').usage).toEqual({
    inputTokens: 9,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    searchCount: 0,
  })
})

test('a reported invocation count wins over the output items, including zero', () => {
  const response = fixture('agent-fast-cited')
  const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, tool_calls_details: { web_search: { invocation: 0 } } }
  expect(perplexityAdapter.parseTrackedQueryResponse!({ ...response, usage }, 'fast').usage?.searchCount).toBe(0)
})

test('cache counts larger than input_tokens clamp the uncached remainder at zero', () => {
  const response = fixture('agent-no-search')
  const usage = { input_tokens: 50, input_tokens_details: { cache_read_input_tokens: 60 }, output_tokens: 1, total_tokens: 51 }
  expect(perplexityAdapter.parseTrackedQueryResponse!({ ...response, usage }, 'fast').usage).toEqual({
    inputTokens: 0,
    cachedInputTokens: 60,
    cacheWriteTokens: 0,
    outputTokens: 1,
    searchCount: 0,
  })
})

test('a response with no usage object has undefined usage', () => {
  const { usage: _usage, ...bare } = fixture('agent-fast-cited')
  const raw = perplexityAdapter.parseTrackedQueryResponse!(bare, 'fast')
  expect(raw.usage).toBeUndefined()
  expect(raw.stopReason).toBe('completed')
})

test('the stop reason is incomplete_details.reason when given, else the status, else undefined', () => {
  const answered = fixture('agent-fast-cited')
  const truncated = { ...answered, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  expect(perplexityAdapter.parseTrackedQueryResponse!(truncated, 'fast').stopReason).toBe('max_output_tokens')
  const noReason = { ...answered, status: 'incomplete', incomplete_details: null }
  expect(perplexityAdapter.parseTrackedQueryResponse!(noReason, 'fast').stopReason).toBe('incomplete')
  const { status: _status, ...statusless } = answered
  expect(perplexityAdapter.parseTrackedQueryResponse!(statusless, 'fast').stopReason).toBeUndefined()
})

test('parse throws where the sync path throws: failed, cancelled, and incomplete with no answer', () => {
  expect(() => perplexityAdapter.parseTrackedQueryResponse!(fixture('agent-failed'), 'fast'))
    .toThrow('agent response failed: The model failed to produce a response. (internal_error)')
  expect(() => perplexityAdapter.parseTrackedQueryResponse!({ object: 'response', status: 'cancelled', output: [] }, 'fast'))
    .toThrow('agent response cancelled: no error detail')
  const searchOnly = (fixture('agent-fast-cited').output as Record<string, unknown>[]).slice(0, 1)
  const stopped = { object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: searchOnly }
  expect(() => perplexityAdapter.parseTrackedQueryResponse!(stopped, 'fast'))
    .toThrow('agent response incomplete with no answer: max_output_tokens')
})
