import { test, expect, vi } from 'vitest'

import { openaiAdapter } from '../src/adapter.js'

// Wiring guard, not an extraction test — `extractServedModel` is pinned in
// index.test.ts. What was untested is the path from the HTTP response to the
// `RawQueryResult` the JobRunner persists: the `servedModel:` line inside
// `executeTrackedQuery` and the `servedModel: raw.servedModel` pass-through in the
// adapter. Both were free to be deleted without a failing test.
//
// The stub body is a hand-written minimal Responses payload (constructed, not a
// capture); only `model` is load-bearing here.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

const CONFIGURED_MODEL = 'gpt-5.6'
const SERVED_MODEL = 'gpt-5.6-2026-03-05'

function stubResponsesApi(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

test('the openai adapter carries the served model from the API response to RawQueryResult', async () => {
  stubResponsesApi({
    id: 'resp_stub',
    object: 'response',
    status: 'completed',
    model: SERVED_MODEL,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stub answer', annotations: [] }],
      },
    ],
  })
  try {
    const result = await openaiAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'openai', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.model).toBe(CONFIGURED_MODEL)
    expect(result.servedModel).toBe(SERVED_MODEL)
    expect(result.servedModel).not.toBe(result.model)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the openai adapter leaves servedModel undefined when the response discloses no model', async () => {
  stubResponsesApi({ id: 'resp_stub', object: 'response', status: 'completed', output: [] })
  try {
    const result = await openaiAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'openai', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.servedModel).toBeUndefined()
    // The configured model must never stand in for an absent disclosure.
    expect(result.servedModel).not.toBe(CONFIGURED_MODEL)
  } finally {
    vi.unstubAllGlobals()
  }
})
