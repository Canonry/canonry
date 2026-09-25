import { test, expect, vi, afterEach } from 'vitest'

import { openaiAdapter } from '../src/adapter.js'

// Pins the build/parse split of the sync path: the body `buildTrackedQueryRequest`
// returns is the JSON the SDK puts on the wire, and the sync result is exactly
// `parseTrackedQueryResponse` of the response it stored.

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

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubResponsesApi(response: Record<string, unknown>): CapturedRequest[] {
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
  const sent = stubResponsesApi(RESPONSE)
  await openaiAdapter.executeTrackedQuery(QUERY, CONFIG)

  const built = openaiAdapter.buildTrackedQueryRequest!(QUERY, CONFIG)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(new URL(sent[0]!.url).pathname).toBe(built.endpoint)
  expect(built).toEqual({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4',
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      input: 'best crm for agencies',
    },
  })
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

test('the built body falls back to the default model', () => {
  const { model: _model, ...noModel } = CONFIG
  expect(openaiAdapter.buildTrackedQueryRequest!(QUERY, noModel).body.model).toBe('gpt-5.4')
})

test('the sync result is exactly parseTrackedQueryResponse of the response it stored', async () => {
  stubResponsesApi(RESPONSE)
  const viaSync = await openaiAdapter.executeTrackedQuery(QUERY, CONFIG)

  // The SDK adds its `output_text` convenience field to the response it returns.
  expect(viaSync.rawResponse).toEqual({ ...RESPONSE, output_text: 'Example CRM is popular with agencies.' })
  expect(viaSync).toEqual(openaiAdapter.parseTrackedQueryResponse!(viaSync.rawResponse, 'gpt-5.4'))

  const viaParse = openaiAdapter.parseTrackedQueryResponse!(structuredClone(RESPONSE), 'gpt-5.4')
  expect(viaParse).toEqual({ ...viaSync, rawResponse: RESPONSE })
  expect(viaParse.servedModel).toBe('gpt-5.4-2026-03-05')
  expect(viaParse.retrievalStatus).toBe('unknown')
  expect(viaParse.retrievalContract).toBe('native-auto-v1')
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
