import { test, expect, vi } from 'vitest'

import { claudeAdapter } from '../src/adapter.js'

// Wiring guard for the served-model path — see the note in
// packages/provider-openai/test/served-model-wiring.test.ts. Extraction is pinned in
// index.test.ts; the `servedModel:` line in `executeTrackedQuery` and the adapter's
// `servedModel: raw.servedModel` pass-through had no test.
//
// The stub body is a hand-written minimal Messages payload (constructed, not a
// capture); only `model` is load-bearing here.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

const CONFIGURED_MODEL = 'claude-sonnet-4-6'
const SERVED_MODEL = 'claude-sonnet-4-6-20260214'

function stubMessagesApi(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function message(model?: string): Record<string, unknown> {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    ...(model === undefined ? {} : { model }),
    content: [{ type: 'text', text: 'stub answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

test('the claude adapter carries the served model from the API response to RawQueryResult', async () => {
  stubMessagesApi(message(SERVED_MODEL))
  try {
    const result = await claudeAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'claude', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.model).toBe(CONFIGURED_MODEL)
    expect(result.servedModel).toBe(SERVED_MODEL)
    expect(result.servedModel).not.toBe(result.model)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the claude adapter leaves servedModel undefined when the response discloses no model', async () => {
  stubMessagesApi(message())
  try {
    const result = await claudeAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'claude', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.servedModel).toBeUndefined()
    expect(result.servedModel).not.toBe(CONFIGURED_MODEL)
  } finally {
    vi.unstubAllGlobals()
  }
})
