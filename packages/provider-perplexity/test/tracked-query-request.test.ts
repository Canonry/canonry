import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, RawQueryResult, TrackedQueryInput } from '@ainyc/canonry-contracts'
import { fixture, stubAgentHttp } from './support/agent-api.js'

import { perplexityAdapter } from '../src/adapter.js'

// Native SDK delivery and the public batch builder/parser meet literal contracts.
// Response projections are independently authored, never calculated by either owner.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'perplexity', apiKey: 'k', model: 'sonar-pro', quotaPolicy }
const QUERY = { query: 'best crm for startups', canonicalDomains: ['hubspot.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US', timezone: 'America/Los_Angeles' }

// Schema-derived Agent API responses (see test/fixtures/README.md).

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

const stubAgent = (response: Record<string, unknown>) => stubAgentHttp(200, response)

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://wrong.example/v1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test("buildTrackedQueryRequest returns the exact body the sync path sends", async () => {
  const rows: Array<{ name: string; input: TrackedQueryInput; config: ProviderConfig; selection: Record<string, unknown>; model: string; authorization: string }> = [
    { name: 'original retired sonar-pro preset', input: QUERY, config: CONFIG, selection: { preset: 'low' }, model: 'low', authorization: 'Bearer k' },
    { name: 'original default fast request', input: QUERY, config: { provider: 'perplexity', apiKey: 'pplx-test', quotaPolicy }, selection: { preset: 'fast' }, model: 'fast', authorization: 'Bearer pplx-test' },
    { name: 'original model slug request', input: { query: 'q', canonicalDomains: [], competitorDomains: [] }, config: { ...CONFIG, model: 'perplexity/sonar' }, selection: { model: 'perplexity/sonar' }, model: 'perplexity/sonar', authorization: 'Bearer k' },
    { name: 'verbatim leading trailing and newline query bytes', input: { ...QUERY, query: '  best crm\nfor startups  ' }, config: CONFIG, selection: { preset: 'low' }, model: 'low', authorization: 'Bearer k' },
  ]
  for (const row of rows) {
    const expectedBody = { ...row.selection, input: row.input.query, tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } }
    const sent = stubAgent(fixture('agent-fast-cited'))
    const result = await perplexityAdapter.executeTrackedQuery(row.input, row.config)
    expect(sent, row.name).toEqual([{ url: 'https://api.perplexity.ai/v1/agent', method: 'POST', authorization: row.authorization, body: expectedBody }])
    expect(perplexityAdapter.buildTrackedQueryRequest!(row.input, row.config), row.name).toEqual({ endpoint: '/v1/agent', body: expectedBody })
    expect(result.model, row.name).toBe(row.model)
  }
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

test("a location reaches the wire through the built body, on the search tool", async () => {
  const rows: Array<{ name: string; input: TrackedQueryInput; config: ProviderConfig; body: Record<string, unknown>; authorization: string }> = [
    { name: 'original San Francisco location', input: { ...QUERY, location: LOCATION }, config: CONFIG, authorization: 'Bearer k', body: { preset: 'low', input: 'best crm for startups', tools: [{ type: 'web_search', user_location: { city: 'San Francisco', region: 'CA', country: 'US' } }], tool_choice: { type: 'web_search' } } },
    { name: 'original New York default location', input: { query: 'best crm for startups', canonicalDomains: [], competitorDomains: [], location: { label: 'NYC', city: 'New York', region: 'New York', country: 'US', timezone: 'America/New_York' } }, config: { provider: 'perplexity', apiKey: 'pplx-test', quotaPolicy }, authorization: 'Bearer pplx-test', body: { preset: 'fast', input: 'best crm for startups', tools: [{ type: 'web_search', user_location: { city: 'New York', region: 'New York', country: 'US' } }], tool_choice: { type: 'web_search' } } },
  ]
  for (const row of rows) {
    const sent = stubAgent(fixture('agent-fast-cited'))
    await perplexityAdapter.executeTrackedQuery(row.input, row.config)
    expect(sent, row.name).toEqual([{ url: 'https://api.perplexity.ai/v1/agent', method: 'POST', authorization: row.authorization, body: row.body }])
    expect(perplexityAdapter.buildTrackedQueryRequest!(row.input, row.config), row.name).toEqual({ endpoint: '/v1/agent', body: row.body })
  }
})

test("the sync result is exactly parseTrackedQueryResponse of the response received", async () => {
  const minimalAgent: Record<string, unknown> = {
    id: 'resp_stub', object: 'response', created_at: 0, status: 'completed',
    output: [{ id: 'msg_stub', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'stub answer', annotations: [] }] }],
  }
  const rows: Array<{ name: string; response: Record<string, unknown>; input: TrackedQueryInput; config: ProviderConfig; expected: Omit<RawQueryResult, 'rawResponse'> }> = [
    {
      name: 'original full billing and source result', response: answerWithFullUsage(), input: QUERY, config: CONFIG,
      expected: {
        provider: 'perplexity', model: 'low', servedModel: 'perplexity/sonar',
        groundingSources: [
          { uri: 'https://www.hubspot.com/products/crm/startups', title: 'HubSpot for Startups' },
          { uri: 'https://blog.example.com/startup-crm-guide', title: 'The startup CRM guide' },
          { uri: 'https://pipedrive.com/en/blog/crm-for-startups', title: 'CRM for startups' },
        ],
        searchQueries: ['best crm for startups', 'startup crm comparison 2026'], retrievalStatus: 'used', retrievalContract: 'search-required-v1',
        usage: { inputTokens: 1343, cachedInputTokens: 400, cacheWriteTokens: 100, outputTokens: 57, searchCount: 2 }, stopReason: 'completed',
      },
    },
    {
      name: 'original constructed Agent served identity', response: { ...minimalAgent, model: 'perplexity/sonar' }, input: { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] }, config: { ...CONFIG, model: 'fast' },
      expected: { provider: 'perplexity', model: 'fast', servedModel: 'perplexity/sonar', groundingSources: [], searchQueries: [], retrievalStatus: 'not-used', retrievalContract: 'search-required-v1', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'original constructed Agent absent disclosure', response: minimalAgent, input: { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] }, config: { ...CONFIG, model: 'fast' },
      expected: { provider: 'perplexity', model: 'fast', servedModel: undefined, groundingSources: [], searchQueries: [], retrievalStatus: 'not-used', retrievalContract: 'search-required-v1', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'constructed Agent blank disclosure', response: { ...minimalAgent, model: ' \t ' }, input: QUERY, config: CONFIG,
      expected: { provider: 'perplexity', model: 'low', servedModel: undefined, groundingSources: [], searchQueries: [], retrievalStatus: 'not-used', retrievalContract: 'search-required-v1', usage: undefined, stopReason: 'completed' },
    },
  ]
  for (const row of rows) {
    stubAgent(row.response)
    const expected = { ...row.expected, rawResponse: row.response }
    expect(await perplexityAdapter.executeTrackedQuery(row.input, row.config), row.name).toEqual(expected)
    // The parser is also a public batch boundary; it has no native HTTP exchange.
    expect(perplexityAdapter.parseTrackedQueryResponse!(structuredClone(row.response), row.expected.model), row.name).toEqual(expected)
  }

  // Original constructed Sonar bodies pin historical identity extraction only.
  // They are not passed off as current Agent API HTTP responses or live captures.
  const historical: Record<string, unknown> = {
    id: 'chatcmpl-perplexity-1', object: 'chat.completion', model: 'sonar-pro',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer.' } }],
  }
  const { model: _model, ...withoutModel } = historical
  for (const row of [
    { name: 'original historical disclosed model', response: historical, servedModel: 'sonar-pro' },
    { name: 'original historical absent model', response: withoutModel, servedModel: undefined },
    { name: 'original historical blank model', response: { ...historical, model: ' \t ' }, servedModel: undefined },
  ]) {
    expect(perplexityAdapter.parseTrackedQueryResponse!(row.response, 'sonar'), row.name).toEqual({
      provider: 'perplexity', rawResponse: row.response, model: 'fast', servedModel: row.servedModel,
      groundingSources: [], searchQueries: [], retrievalStatus: 'unknown', retrievalContract: 'search-required-v1', usage: undefined, stopReason: undefined,
    })
  }
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
