import { test, expect, vi, beforeEach, afterEach } from 'vitest'

import { openaiAdapter } from '../src/adapter.js'
import type { ProviderConfig, RawQueryResult } from '@ainyc/canonry-contracts'
import { stubResponsesApi } from './support/responses-api.js'

// The sync SDK path and the batch builder/parser each meet independent literal
// contracts. Expected result projections are not produced by either owner.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'openai', apiKey: 'k', model: 'gpt-5.4', quotaPolicy }
const QUERY = { query: 'best crm for agencies', canonicalDomains: ['example.com'], competitorDomains: [] }
const LOCATION = { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US' }

/** A Responses API payload shaped like a real search-grounded answer: two searches, one cited message. */
const RESPONSE = {
  id: 'resp_68d3c1f2a4b88190',
  object: 'response',
  created_at: 1758700000,
  status: 'completed',
  error: null,
  incomplete_details: null,
  model: 'gpt-5.4-2026-03-05',
  output: [
    { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'best crm for agencies 2026' } },
    { id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['agency crm comparison'] } },
    {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'Example CRM is popular with agencies.',
        annotations: [{ type: 'url_citation', url: 'https://example.com/crm', title: 'Example CRM', start_index: 0, end_index: 11 }],
      }],
    },
  ],
  usage: {
    input_tokens: 5230,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 734,
    output_tokens_details: { reasoning_tokens: 256 },
    total_tokens: 5964,
  },
}

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test("buildTrackedQueryRequest returns the exact body the sync path sends", async () => {
  const rows: Array<{ name: string; query: string; config: ProviderConfig; model: string }> = [
    { name: 'original tracked query', query: 'best crm for agencies', config: CONFIG, model: 'gpt-5.4' },
    { name: 'omitted default model', query: 'best crm for agencies', config: { provider: 'openai', apiKey: 'k', quotaPolicy }, model: 'gpt-5.4' },
    { name: 'configured alias', query: 'best crm for agencies', config: { ...CONFIG, model: 'chat-latest' }, model: 'chat-latest' },
    { name: 'verbatim query', query: 'best crm software', config: CONFIG, model: 'gpt-5.4' },
    { name: 'empty query bytes', query: '', config: CONFIG, model: 'gpt-5.4' },
    { name: 'forced-search policy fixture', query: 'commercial roof restoration', config: CONFIG, model: 'gpt-5.4' },
  ]
  for (const row of rows) {
    const sent = stubResponsesApi(RESPONSE)
    const input = { ...QUERY, query: row.query }
    await openaiAdapter.executeTrackedQuery(input, row.config)
    const expectedBody = { model: row.model, tools: [{ type: 'web_search' }], tool_choice: 'required', input: row.query }
    expect(sent, row.name).toEqual([{
      url: 'https://api.openai.com/v1/responses', method: 'POST', authorization: 'Bearer k', body: expectedBody,
    }])
    expect(openaiAdapter.buildTrackedQueryRequest!(input, row.config), row.name).toEqual({
      endpoint: '/v1/responses', body: expectedBody,
    })
  }
})

test('a location reaches the wire through the built body', async () => {
  const sent = stubResponsesApi(RESPONSE)
  const input = { ...QUERY, location: LOCATION }
  await openaiAdapter.executeTrackedQuery(input, CONFIG)

  const built = openaiAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.tools).toEqual([{
    type: 'web_search',
    user_location: { type: 'approximate', city: 'San Francisco', region: 'CA', country: 'US' },
  }])
})

// --- servedModel capture ---
//
// Fixtures below are trimmed from real OpenAI Responses API captures taken 2026-07-20
// (scratchpad probe-gpt-5.6-*.json / probe-chat-latest-*.json).

// Configured model was `gpt-5.6`; OpenAI served the `gpt-5.6-sol` tier.
const gpt56SolResponse: Record<string, unknown> = {
  id: 'resp_0e7d62cd783fd44a006a5d830171d48193b9d91617de68aa7a',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.6-sol',
  output: [
    {
      id: 'ws_0e7d62cd783fd44a006a5d830677c881938d213e19bc529d27',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'best boutique hotels Example City 2026',
      },
    },
  ],
}

// Configured model was `chat-latest`; OpenAI echoed the same alias back, disclosing
// nothing more specific about the snapshot it actually ran.
const chatLatestResponse: Record<string, unknown> = {
  id: 'resp_04a2bee500c8f641006a5d835517cc81909d09da16d7bd3133',
  object: 'response',
  status: 'completed',
  model: 'chat-latest',
  output: [
    {
      id: 'ws_04a2bee500c8f641006a5d835661c48190b981dfb3452a9b02',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'best boutique hotels Example City recommendations',
      },
    },
  ],
}

test("the sync result is exactly parseTrackedQueryResponse of the response it stored", async () => {
  const { model: _disclosedModel, ...withoutModel } = gpt56SolResponse
  const rows: Array<{
    name: string
    response: Record<string, unknown>
    model: string
    outputText: string
    projection: Pick<RawQueryResult, 'servedModel' | 'groundingSources' | 'searchQueries' | 'retrievalStatus' | 'usage' | 'stopReason'>
  }> = [
    {
      name: 'grounded response and billable usage', response: RESPONSE, model: 'gpt-5.4', outputText: 'Example CRM is popular with agencies.',
      projection: { servedModel: 'gpt-5.4-2026-03-05', groundingSources: [{ uri: 'https://example.com/crm', title: 'Example CRM' }],
        searchQueries: ['best crm for agencies 2026', 'agency crm comparison'], retrievalStatus: 'used',
        usage: { inputTokens: 4206, cachedInputTokens: 1024, cacheWriteTokens: 0, outputTokens: 734, searchCount: 2 }, stopReason: 'completed' },
    },
    {
      name: 'captured tier disclosure', response: gpt56SolResponse, model: 'gpt-5.6', outputText: '',
      projection: { servedModel: 'gpt-5.6-sol', groundingSources: [], searchQueries: ['best boutique hotels Example City 2026'],
        retrievalStatus: 'used', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'captured alias echo', response: chatLatestResponse, model: 'chat-latest', outputText: '',
      projection: { servedModel: 'chat-latest', groundingSources: [], searchQueries: ['best boutique hotels Example City recommendations'],
        retrievalStatus: 'used', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'captured response without disclosure', response: withoutModel, model: 'gpt-5.6', outputText: '',
      projection: { servedModel: undefined, groundingSources: [], searchQueries: ['best boutique hotels Example City 2026'],
        retrievalStatus: 'used', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'captured response blank disclosure', response: { ...gpt56SolResponse, model: '   ' }, model: 'gpt-5.6', outputText: '',
      projection: { servedModel: undefined, groundingSources: [], searchQueries: ['best boutique hotels Example City 2026'],
        retrievalStatus: 'used', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'constructed dated disclosure', model: 'gpt-5.6', outputText: 'stub answer',
      response: { id: 'resp_stub', object: 'response', status: 'completed', model: 'gpt-5.6-2026-03-05',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stub answer', annotations: [] }] }] },
      projection: { servedModel: 'gpt-5.6-2026-03-05', groundingSources: [], searchQueries: [],
        retrievalStatus: 'not-used', usage: undefined, stopReason: 'completed' },
    },
    {
      name: 'constructed empty output without disclosure', model: 'gpt-5.6', outputText: '',
      response: { id: 'resp_stub', object: 'response', status: 'completed', output: [] },
      projection: { servedModel: undefined, groundingSources: [], searchQueries: [],
        retrievalStatus: 'unknown', usage: undefined, stopReason: 'completed' },
    },
  ]
  for (const row of rows) {
    stubResponsesApi(row.response)
    const expected = {
      provider: 'openai', model: row.model, rawResponse: { ...row.response, output_text: row.outputText },
      retrievalContract: 'search-required-v1', ...row.projection,
    } satisfies RawQueryResult
    expect(await openaiAdapter.executeTrackedQuery(QUERY, { ...CONFIG, model: row.model }), row.name).toEqual(expected)
    // Batch JSON lacks the SDK-only convenience field; every other expected
    // field remains the independent literal projection above.
    expect(openaiAdapter.parseTrackedQueryResponse!(structuredClone(row.response), row.model), row.name).toEqual({
      ...expected, rawResponse: row.response,
    })
  }
})

test('parse extracts usage and stop reason exactly', () => {
  const raw = openaiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gpt-5.4')
  expect(raw.usage).toEqual({
    inputTokens: 5230 - 1024,
    cachedInputTokens: 1024,
    cacheWriteTokens: 0,
    outputTokens: 734,
    searchCount: 2,
  })
  expect(raw.stopReason).toBe('completed')
})

test('an incomplete response reports why it stopped', () => {
  const truncated = { ...structuredClone(RESPONSE), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  expect(openaiAdapter.parseTrackedQueryResponse!(truncated, 'gpt-5.4').stopReason).toBe('max_output_tokens')
})

test('an answer with no searches and no cache details counts 0 of each', () => {
  const plain = {
    ...structuredClone(RESPONSE),
    output: [RESPONSE.output[2]],
    usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
  }
  expect(openaiAdapter.parseTrackedQueryResponse!(plain, 'gpt-5.4').usage).toEqual({
    inputTokens: 40,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 12,
    searchCount: 0,
  })
})

test('a response with no usage object has undefined usage', () => {
  const { usage: _usage, status: _status, ...bare } = structuredClone(RESPONSE)
  const raw = openaiAdapter.parseTrackedQueryResponse!(bare, 'gpt-5.4')
  expect(raw.usage).toBeUndefined()
  expect(raw.stopReason).toBeUndefined()
})
