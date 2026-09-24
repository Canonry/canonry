import { test, expect, vi } from 'vitest'

import { perplexityAdapter } from '../src/adapter.js'

// Wiring guard for the served-model path — see the note in
// packages/provider-openai/test/served-model-wiring.test.ts. Extraction itself is
// pinned in normalize.test.ts; what this covers is the `servedModel:` line in
// `executeTrackedQuery` and the adapter's `servedModel: raw.servedModel`
// pass-through, neither of which had a test.
//
// The stub body is a hand-written minimal Agent API response (constructed, not
// a capture); only `model` is load-bearing here. For a preset, `model` is the
// model the preset resolved to, which is exactly why it is recorded apart from
// the configured preset.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

const CONFIGURED_MODEL = 'fast'
const SERVED_MODEL = 'perplexity/sonar'

function stubAgent(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function agentResponse(model?: string): Record<string, unknown> {
  return {
    id: 'resp_stub',
    object: 'response',
    created_at: 0,
    status: 'completed',
    ...(model === undefined ? {} : { model }),
    output: [
      {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'stub answer', annotations: [] }],
      },
    ],
  }
}

test('the perplexity adapter carries the served model from the API response to RawQueryResult', async () => {
  stubAgent(agentResponse(SERVED_MODEL))
  try {
    const result = await perplexityAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'perplexity', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.model).toBe(CONFIGURED_MODEL)
    expect(result.servedModel).toBe(SERVED_MODEL)
    expect(result.servedModel).not.toBe(result.model)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the perplexity adapter leaves servedModel undefined when the response discloses no model', async () => {
  stubAgent(agentResponse())
  try {
    const result = await perplexityAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'perplexity', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.servedModel).toBeUndefined()
    expect(result.servedModel).not.toBe(CONFIGURED_MODEL)
  } finally {
    vi.unstubAllGlobals()
  }
})
