import { test, expect, vi } from 'vitest'

import { geminiAdapter } from '../src/adapter.js'

// Wiring guard for the served-model path — see the note in
// packages/provider-openai/test/served-model-wiring.test.ts. Extraction is pinned in
// index.test.ts; the `servedModel:` line in `executeTrackedQuery` and the adapter's
// `servedModel: raw.servedModel` pass-through had no test.
//
// Gemini is the provider where this regressed silently before: `modelVersion` is the
// only place it reports the served identity, and `responseToRecord` used to drop it,
// so every stored Gemini row is NULL for `served_model`.
//
// The stub body is a hand-written minimal generateContent payload (constructed, not a
// capture); only `modelVersion` is load-bearing here. For a real captured
// modelVersion / responseId see index.test.ts.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

const CONFIGURED_MODEL = 'gemini-2.5-flash'
const SERVED_MODEL = 'gemini-2.5-flash-preview-05-20'

function stubGenerateContent(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function generateContentResponse(modelVersion?: string): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'stub answer' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    ...(modelVersion === undefined ? {} : { modelVersion }),
    responseId: 'resp_stub',
  }
}

test('the gemini adapter carries the served modelVersion from the API response to RawQueryResult', async () => {
  stubGenerateContent(generateContentResponse(SERVED_MODEL))
  try {
    const result = await geminiAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'gemini', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.model).toBe(CONFIGURED_MODEL)
    expect(result.servedModel).toBe(SERVED_MODEL)
    expect(result.servedModel).not.toBe(result.model)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the gemini adapter leaves servedModel undefined when the response discloses no modelVersion', async () => {
  stubGenerateContent(generateContentResponse())
  try {
    const result = await geminiAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'gemini', apiKey: 'k', model: CONFIGURED_MODEL, quotaPolicy },
    )
    expect(result.servedModel).toBeUndefined()
    expect(result.servedModel).not.toBe(CONFIGURED_MODEL)
  } finally {
    vi.unstubAllGlobals()
  }
})
