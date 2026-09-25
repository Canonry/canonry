import { test, expect, vi, afterEach } from 'vitest'

import { claudeAdapter } from '../src/adapter.js'
import { parseTrackedQueryResponse } from '../src/normalize.js'

// A batch line must ask Claude the identical question the sync path asks and be
// read back the identical way. These tests pin both halves of that split: the
// body `buildTrackedQueryRequest` returns is byte-for-byte what the sync path
// puts on the wire, and the sync result is exactly `parseTrackedQueryResponse`
// of the response it received.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5', quotaPolicy }
const QUERY = { query: 'best commercial roofing contractor', canonicalDomains: ['example.com'], competitorDomains: [] }
const LOCATION = { label: 'nyc', city: 'New York', region: 'NY', country: 'US', timezone: 'America/New_York' }

/**
 * A Messages API response shaped like a real search-grounded answer: a search
 * call, its results, a cited text block, and the usage block Anthropic returns
 * for it (two searches, a cache read and a cache write).
 */
const SEARCHED_MESSAGE = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-20260801',
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'commercial roofing contractor reviews' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://roofing.example/guide', title: 'Guide', encrypted_content: 'x', page_age: null }],
    },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'best roofing contractor 2026' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: [] },
    {
      type: 'text',
      text: 'Example Roofing is a well-reviewed contractor.',
      citations: [
        { type: 'web_search_result_location', url: 'https://roofing.example/guide', title: 'Guide', cited_text: 'well reviewed', encrypted_index: 'y' },
      ],
    },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 2143,
    cache_creation_input_tokens: 312,
    cache_read_input_tokens: 1024,
    output_tokens: 587,
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
    service_tier: 'standard',
  },
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

/** Stub the Messages API, answering every call with `response` and capturing what was sent. */
function stubMessagesApi(response: Record<string, unknown>): CapturedRequest[] {
  const sent: CapturedRequest[] = []
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
  const sent = stubMessagesApi(SEARCHED_MESSAGE)
  await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)

  const built = claudeAdapter.buildTrackedQueryRequest!(QUERY, CONFIG)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual(built.body)
  expect(new URL(sent[0]!.url).pathname).toBe(built.endpoint)
  expect(built).toEqual({
    endpoint: '/v1/messages',
    body: {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      tool_choice: { type: 'tool', name: 'web_search' },
      messages: [{ role: 'user', content: 'best commercial roofing contractor' }],
    },
  })
})

test('a location reaches the wire through the built body', async () => {
  const sent = stubMessagesApi(SEARCHED_MESSAGE)
  const input = { ...QUERY, location: LOCATION }
  await claudeAdapter.executeTrackedQuery(input, CONFIG)

  const built = claudeAdapter.buildTrackedQueryRequest!(input, CONFIG)
  expect(sent[0]!.body).toEqual(built.body)
  expect(built.body.tools).toEqual([{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
    user_location: { type: 'approximate', city: 'New York', region: 'NY', country: 'US', timezone: 'America/New_York' },
  }])
})

test('the built body carries the resolved model, not an invalid configured one', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const built = claudeAdapter.buildTrackedQueryRequest!(QUERY, { ...CONFIG, model: 'gpt-5.4' })
    expect(built.body.model).toBe('claude-sonnet-4-6')
  } finally {
    warn.mockRestore()
  }
})

test('the sync result is exactly parseTrackedQueryResponse of the response received', async () => {
  stubMessagesApi(SEARCHED_MESSAGE)
  const viaSync = await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)
  const viaParse = claudeAdapter.parseTrackedQueryResponse!(structuredClone(SEARCHED_MESSAGE), 'claude-sonnet-5')

  expect(viaSync).toEqual(viaParse)
  expect(viaParse.model).toBe('claude-sonnet-5')
  expect(viaParse.servedModel).toBe('claude-sonnet-5-20260801')
  expect(viaParse.retrievalStatus).toBe('used')
  expect(viaParse.retrievalContract).toBe('search-required-v1')
  expect(viaParse.groundingSources).toEqual([{ uri: 'https://roofing.example/guide', title: 'Guide' }])
  expect(viaParse.searchQueries).toEqual(['commercial roofing contractor reviews', 'best roofing contractor 2026'])
  expect(viaParse.rawResponse).toEqual(SEARCHED_MESSAGE)
})

test('parse extracts usage and stop reason exactly', () => {
  const raw = claudeAdapter.parseTrackedQueryResponse!(structuredClone(SEARCHED_MESSAGE), 'claude-sonnet-5')
  expect(raw.usage).toEqual({
    inputTokens: 2143,
    cachedInputTokens: 1024,
    cacheWriteTokens: 312,
    outputTokens: 587,
    searchCount: 2,
  })
  expect(raw.stopReason).toBe('end_turn')
})

test('a pause_turn answer is returned with its stop reason, not dropped', () => {
  const paused = { ...structuredClone(SEARCHED_MESSAGE), stop_reason: 'pause_turn' }
  const raw = claudeAdapter.parseTrackedQueryResponse!(paused, 'claude-sonnet-5')
  expect(raw.stopReason).toBe('pause_turn')
  expect(raw.groundingSources).toHaveLength(1)
})

test('usage fields the response omits read as 0', () => {
  const minimal = { ...structuredClone(SEARCHED_MESSAGE), usage: { input_tokens: 12, output_tokens: 3 } }
  expect(claudeAdapter.parseTrackedQueryResponse!(minimal, 'claude-sonnet-5').usage).toEqual({
    inputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 3,
    searchCount: 0,
  })
})

test('a response with no usage object has undefined usage and no invented stop reason', () => {
  const { usage: _usage, stop_reason: _stop, ...bare } = structuredClone(SEARCHED_MESSAGE)
  const raw = claudeAdapter.parseTrackedQueryResponse!(bare, 'claude-sonnet-5')
  expect(raw.usage).toBeUndefined()
  expect(raw.stopReason).toBeUndefined()
})

test('a web_search_tool_result_error makes parse throw the same error the sync path throws', async () => {
  const failed = {
    ...structuredClone(SEARCHED_MESSAGE),
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: 'partial answer' },
    ],
  }
  stubMessagesApi(failed)
  const expected = '[provider-claude] web_search tool error: max_uses_exceeded'

  await expect(claudeAdapter.executeTrackedQuery(QUERY, CONFIG)).rejects.toThrow(expected)
  expect(() => claudeAdapter.parseTrackedQueryResponse!(structuredClone(failed), 'claude-sonnet-5')).toThrow(expected)
  expect(() => parseTrackedQueryResponse(structuredClone(failed), 'claude-sonnet-5')).toThrow(expected)
})

test('an API error on the sync path keeps its provider prefix', async () => {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad tool' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  )
  await expect(claudeAdapter.executeTrackedQuery(QUERY, CONFIG)).rejects.toThrow(/^\[provider-claude\] 400 .*bad tool/)
})
