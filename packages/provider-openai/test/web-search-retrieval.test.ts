import { test, expect, vi } from 'vitest'

import { openaiAdapter } from '../src/adapter.js'
import {
  executeTrackedQuery,
  normalizeResult,
  reparseStoredResult,
} from '../src/normalize.js'

// Every tracked OpenAI query is sent with `tool_choice: "required"` and
// `web_search` as the only tool, so the model must search before it answers.
// These tests pin two things about that request:
//
// 1. The snapshot records the contract the request actually runs under
//    (`search-required-v1`), not `native-auto-v1`, which would claim the model
//    was left to decide whether to search.
// 2. Retrieval is read from the response (`web_search_call` output items), so
//    a response that never searched stays visibly distinct from one that
//    searched and cited nothing. Both store zero cited domains.
//
// Fixtures are hand-built from the Responses API shape in the official SDK
// (`Response`, `ResponseFunctionWebSearch`, `ResponseOutputMessage`,
// `ResponseReasoningItem`). They are constructed, not captured, and carry the
// output-item order a reasoning model produces under forced search.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'openai' as const, apiKey: 'k', model: 'gpt-5.4', quotaPolicy }
const QUERY = { query: 'commercial roof restoration', canonicalDomains: ['example.com'], competitorDomains: [] }
const OPENAI_INPUT = { ...QUERY, config: { apiKey: 'k', model: 'gpt-5.4', quotaPolicy } }

/** Return remote Responses JSON without implementing extraction or classification. */
function captureRequest(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}

/** A Responses API payload whose output items are supplied by the caller. */
function response(output: unknown[], status = 'completed'): Record<string, unknown> {
  return {
    id: 'resp_0e7d62cd783fd44a006a5d830171d48193b9d91617de68aa7a',
    object: 'response',
    created_at: 1_790_000_000,
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    model: 'gpt-5.4-2026-03-05',
    output,
    parallel_tool_calls: true,
    tool_choice: 'required',
    tools: [{ type: 'web_search', search_context_size: 'medium', user_location: null, filters: null }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
}

const reasoning = {
  id: 'rs_0e7d62cd783fd44a006a5d8302a1c88193a1b5c3d2e4f60718',
  type: 'reasoning',
  summary: [],
}

const searchCall = {
  id: 'ws_0e7d62cd783fd44a006a5d830677c881938d213e19bc529d27',
  type: 'web_search_call',
  status: 'completed',
  action: {
    type: 'search',
    query: 'commercial roof restoration',
    sources: [{ type: 'url', url: 'https://roofingcontractor.example/guide' }],
  },
}

function message(annotations: unknown[]): Record<string, unknown> {
  return {
    id: 'msg_0e7d62cd783fd44a006a5d830bb0c48193bf0a2f41f7b8d1c2',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: 'Restoration coats an existing roof.',
        annotations,
        logprobs: [],
      },
    ],
  }
}

const citation = {
  type: 'url_citation',
  start_index: 0,
  end_index: 35,
  url: 'https://roofingcontractor.example/guide?utm_source=openai',
  title: 'Guide',
}

/** Searched, and the answer cites a source. */
const SEARCHED_AND_CITED = [reasoning, searchCall, message([citation])]

/**
 * Searched, but the answer cites nothing. Must not collapse into the unsearched
 * case: both store zero cited domains and only `retrievalStatus` separates them.
 */
const SEARCHED_AND_UNCITED = [reasoning, searchCall, message([])]

/** Never searched. Under search-required-v1 this means the contract did not hold. */
const UNSEARCHED = [reasoning, message([])]

test('searched-but-uncited stays distinct from unsearched though both cite nothing', async () => {
  captureRequest(response(SEARCHED_AND_UNCITED))
  let searchedUncited
  try {
    searchedUncited = normalizeResult(await executeTrackedQuery(OPENAI_INPUT))
  } finally {
    vi.unstubAllGlobals()
  }

  captureRequest(response(UNSEARCHED))
  let unsearched
  try {
    unsearched = normalizeResult(await executeTrackedQuery(OPENAI_INPUT))
  } finally {
    vi.unstubAllGlobals()
  }

  // Indistinguishable on every other field the store keeps.
  expect(searchedUncited.citedDomains).toEqual([])
  expect(unsearched.citedDomains).toEqual([])
  expect(searchedUncited.answerText).toEqual(unsearched.answerText)

  expect(searchedUncited.retrievalStatus).toBe('used')
  expect(unsearched.retrievalStatus).toBe('not-used')
})

test('an empty output array is unknown, never not-used', async () => {
  // A response with no output items is not evidence that retrieval did not
  // run. `not-used` would assert an absence never observed and let the row
  // count as a genuine miss.
  captureRequest(response([]))
  try {
    const raw = await executeTrackedQuery(OPENAI_INPUT)
    expect(raw.retrievalStatus).toBe('unknown')
    expect(normalizeResult(raw).retrievalStatus).toBe('unknown')
    // The contract is a declaration about the request, so it is still known.
    expect(raw.retrievalContract).toBe('search-required-v1')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a missing or unusable output field is unknown, never not-used', () => {
  expect(reparseStoredResult({}).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ output: null }).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult({ output: 'not-an-array' }).retrievalStatus).toBe('unknown')
  // responseToRecord's own serialization-failure marker.
  expect(reparseStoredResult({ error: 'failed to serialize response' }).retrievalStatus).toBe('unknown')
})

test('an unfinished response with no search call is unknown, because it is not intact', () => {
  // `not-used` means the response is intact and carries no search call. A
  // response cut off before the model reached its tool call proves nothing
  // about whether it would have searched.
  const truncated = response([reasoning], 'incomplete')
  expect(reparseStoredResult(truncated).retrievalStatus).toBe('unknown')
  expect(reparseStoredResult(response([reasoning], 'failed')).retrievalStatus).toBe('unknown')
})

test('an unfinished response that already searched is still used', () => {
  // The search call is direct evidence, whatever happened after it.
  const truncatedAfterSearch = response([reasoning, searchCall], 'incomplete')
  expect(reparseStoredResult(truncatedAfterSearch).retrievalStatus).toBe('used')
})

test('retrieval is read from the search call, not from recovered query text', () => {
  // A call whose query is missing, or whose action opened a page rather than
  // searching, still counts: retrieval answers the denominator question, while
  // searchQueries is only telemetry.
  const noQuery = reparseStoredResult(response([
    { id: 'ws_1', type: 'web_search_call', status: 'completed' },
    message([]),
  ]))
  expect(noQuery.searchQueries).toEqual([])
  expect(noQuery.retrievalStatus).toBe('used')

  const openPage = reparseStoredResult(response([
    {
      id: 'ws_2',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', url: 'https://roofingcontractor.example/guide' },
    },
    message([]),
  ]))
  expect(openPage.searchQueries).toEqual([])
  expect(openPage.retrievalStatus).toBe('used')
})

test('retrieval survives the adapter boundary so the snapshot can record it', async () => {
  captureRequest(response(SEARCHED_AND_CITED))
  try {
    const viaAdapter = await openaiAdapter.executeTrackedQuery(QUERY, CONFIG)
    expect(viaAdapter.retrievalStatus).toBe('used')
    expect(viaAdapter.retrievalContract).toBe('search-required-v1')
    expect(openaiAdapter.normalizeResult(viaAdapter).retrievalStatus).toBe('used')
  } finally {
    vi.unstubAllGlobals()
  }

  captureRequest(response(UNSEARCHED))
  try {
    const viaAdapter = await openaiAdapter.executeTrackedQuery(QUERY, CONFIG)
    expect(viaAdapter.retrievalStatus).toBe('not-used')
    expect(openaiAdapter.normalizeResult(viaAdapter).retrievalStatus).toBe('not-used')
  } finally {
    vi.unstubAllGlobals()
  }
})

test("a stored apiResponse reparses to the same retrieval status the live call recorded", async () => {
  const rows = [
    { name: 'searched and cited', output: SEARCHED_AND_CITED,
      expected: { provider: 'openai', answerText: 'Restoration coats an existing roof.', citedDomains: ['roofingcontractor.example'],
        groundingSources: [{ uri: 'https://roofingcontractor.example/guide?utm_source=openai', title: 'Guide' }],
        searchQueries: ['commercial roof restoration'], retrievalStatus: 'used' } },
    { name: 'searched without citations', output: SEARCHED_AND_UNCITED,
      expected: { provider: 'openai', answerText: 'Restoration coats an existing roof.', citedDomains: [], groundingSources: [],
        searchQueries: ['commercial roof restoration'], retrievalStatus: 'used' } },
    { name: 'completed without retrieval', output: UNSEARCHED,
      expected: { provider: 'openai', answerText: 'Restoration coats an existing roof.', citedDomains: [], groundingSources: [],
        searchQueries: [], retrievalStatus: 'not-used' } },
    { name: 'empty output is unobserved', output: [],
      expected: { provider: 'openai', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown' } },
  ]
  for (const row of rows) {
    captureRequest(response(row.output))
    try {
      const raw = await openaiAdapter.executeTrackedQuery(QUERY, CONFIG)
      const stored: Record<string, unknown> = JSON.parse(JSON.stringify(raw.rawResponse))
      expect(raw.retrievalStatus, row.name).toBe(row.expected.retrievalStatus)
      expect(raw.retrievalContract, row.name).toBe('search-required-v1')
      expect(openaiAdapter.normalizeResult(raw), row.name).toEqual(row.expected)
      expect(reparseStoredResult(stored), row.name).toEqual(row.expected)
    } finally {
      vi.unstubAllGlobals()
    }
  }
})
